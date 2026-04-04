/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

let cachedSessionStartHooksOutput: string | null = null;

interface ContainerInput {
  prompt: string | any[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isGroup?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  teamRuleContent?: string;
  contextModeContent?: string;
  toolsContent?: string;
  adminToolsContent?: string;
  secrets?: Record<string, string>;
  gatewayToken?: string;
  gatewayUrl?: string;
  pullPendingOnStart?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  consumedThroughTimestamp?: string;
  queryCompleted?: boolean;
}

interface PendingBatchResponse {
  success: boolean;
  pending: boolean;
  prompt?: string;
  consumedThroughTimestamp?: string;
  messageCount?: number;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_STATUS_DIR = '/workspace/ipc/status';
const IPC_POLL_MS = 500;

type IpcStatusEvent =
  | { type: 'tool_status'; tool?: string; description?: string; status: 'running' | 'idle'; elapsed?: number }
  | { type: 'task_status'; task_id: string; status: string; summary: string };

/**
 * Write a status event to IPC so the host can relay it.
 * Supports both tool_status and task_status event types.
 */
function writeIpcStatus(status: IpcStatusEvent): void {
  try {
    fs.mkdirSync(IPC_STATUS_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(IPC_STATUS_DIR, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(status));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    log(`Failed to write IPC status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(content: string | any[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: content as any },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ─── External External Script Hooks Loader ─────────────────────────────────

interface ExternalHookDef {
  name: string;
  hookEvent: string;
  matcher: string;
  entry: string;
  baseDir: string;
  requirements: string[];
}

let externalHooks: ExternalHookDef[] = [];
let bootLogLines: string[] = ['[NanoClaw External Script Hooks Loader]'];
let bootHookFired = false;

function scanExternalHooks(dir: string) {
  try {
    log(`Scanning external hooks in ${dir}`);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const d of entries) {
      if (d.isDirectory()) {
        const fullDir = path.join(dir, d.name);
        scanExternalHooks(fullDir);
      } else if (d.isSymbolicLink()) {
        const fullDir = path.join(dir, d.name);
        try {
          if (fs.statSync(fullDir).isDirectory()) scanExternalHooks(fullDir);
        } catch (e) { /* ignore broken symlinks */ }
      } else if (d.name === 'HOOK.md') {
        const hookFilePath = path.join(dir, d.name);
        const fileContent = fs.readFileSync(hookFilePath, 'utf-8');
        let name = '', hookEvent = '', matcher = '', entry = '';
        let requiresBins: string[] = [];
        const lines = fileContent.split('\n');
        let inYaml = false, inRequiresBins = false;

        for (const line of lines) {
          if (line.trim() === '---') {
            if (inYaml) break;
            inYaml = true; continue;
          }
          if (inYaml) {
            if (line.startsWith('name:')) name = line.substring(5).trim();
            else if (line.startsWith('hookEvent:')) hookEvent = line.substring(10).trim();
            else if (line.startsWith('matcher:')) matcher = line.substring(8).trim().replace(/^"|"$/g, '');
            else if (line.startsWith('entry:')) entry = line.substring(6).trim();
            else if (line.startsWith('requires:')) { /* ok */ }
            else if (line.startsWith('  bins:')) { inRequiresBins = true; }
            else if (inRequiresBins && line.trim().startsWith('- ')) {
              requiresBins.push(line.trim().substring(2).trim());
            } else if (!line.startsWith(' ') && line.trim() !== '') {
              inRequiresBins = false;
            }
          }
        }
        if (name && hookEvent && entry) {
          log(`Discovered external hook ${name} (${hookEvent}) from ${hookFilePath}`);
          externalHooks.push({ name, hookEvent, matcher, entry, baseDir: dir, requirements: requiresBins });
        } else {
          log(`Skipping malformed HOOK.md at ${hookFilePath}`);
        }
      }
    }
  } catch (e) {
    log(`Hook scan skipped for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function loadExternalHooks(): { hooks: Array<{ event: string; matcher: string; caller: HookCallback }>; bootLog: string } {
  return loadExternalHooksWithLogging();
}

/*
Legacy loader implementation retained only in git history.
  const loadedHooks: Array<{ event: string; matcher: string; caller: HookCallback }> = [];
  let loadedCount = 0;
  
  for (const def of externalHooks) {
    let checkPassed = true;
    for (const bin of def.requirements) {
      try {
        const { execSync } = require('child_process');
        execSync(`which ${bin}`, { stdio: 'ignore' });
      } catch (e) {
        checkPassed = false;
        bootLogLines.push(`⚠️ WARNING: 跳过加载外部 Hook '${def.name}'，由于系统缺少二进制依赖项: [${bin}]`);
        break;
      }
    }

    if (checkPassed) {
      loadedCount++;
      loadedHooks.push({
        event: def.hookEvent,
        matcher: def.matcher,
        caller: async (input: unknown) => {
          try {
            const entryPath = path.resolve(def.baseDir, def.entry);
            if (!fs.existsSync(entryPath)) return {};
            
            let toolOutput = '';
            if (input && typeof input === 'object' && 'tool_response' in input) {
              toolOutput = (input as any).tool_response || '';
            }

            const { stdout } = await execFileAsync(entryPath, [], {
              cwd: def.baseDir,
              env: {
                ...process.env,
                CLAUDE_TOOL_OUTPUT: toolOutput,
                CLAUDE_TOOL_NAME: (input as any)?.tool_name || '',
                CLAUDE_HOOK_EVENT: def.hookEvent,
              }
            });

            if (stdout.trim()) {
              return { hookSpecificOutput: { hookEventName: def.hookEvent as any, additionalContext: stdout.trim() } };
            }
          } catch (err) {
            console.error(`Error running external hook ${def.name}:`, err);
          }
          return {};
        }
      });
    }
  }

  bootLogLines.splice(1, 0, `✅ 成功扫描并挂载了 ${loadedCount} 个原生外部 Script Hooks。`);
  return { hooks: loadedHooks, bootLog: bootLogLines.join('\n') };
}
*/

function isBinaryAvailable(bin: string): boolean {
  const pathValue = process.env.PATH || '';
  const pathDirs = pathValue
    .split(path.delimiter)
    .map(dir => dir.trim())
    .filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) {
      return true;
    }
  }

  return false;
}

function formatHookExecutionError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const parts: string[] = [err.message];
  const withDetails = err as Error & { code?: string; stderr?: string | Buffer };
  if (withDetails.code) {
    parts.push(`code=${withDetails.code}`);
  }
  if (withDetails.stderr) {
    const stderr = String(withDetails.stderr).trim();
    if (stderr) {
      parts.push(`stderr=${stderr}`);
    }
  }

  return parts.join(' | ');
}

function loadExternalHooksWithLogging(): { hooks: Array<{ event: string; matcher: string; caller: HookCallback }>; bootLog: string } {
  externalHooks = [];
  let warnings: string[] = [];
  scanExternalHooks('/workspace/group/.claude/skills');

  const loadedHooks: Array<{ event: string; matcher: string; caller: HookCallback }> = [];

  for (const def of externalHooks) {
    const entryPath = path.resolve(def.baseDir, def.entry);
    if (!fs.existsSync(entryPath)) {
      const reason = `⚠️ WARNING: Skipping external hook ${def.name}: entry not found at ${entryPath}`;
      log(reason);
      warnings.push(reason);
      continue;
    }

    let checkPassed = true;
    for (const bin of def.requirements) {
      if (!isBinaryAvailable(bin)) {
        checkPassed = false;
        const reason = `⚠️ WARNING: Skipping external hook ${def.name}: missing required binary [${bin}]`;
        log(reason);
        warnings.push(reason);
        break;
      }
    }

    if (!checkPassed) continue;

    const matchers = def.matcher ? def.matcher.split(',').map(m => m.trim()).filter(Boolean) : [''];
    if (matchers.length === 0) matchers.push('');

    const events = def.hookEvent ? def.hookEvent.split(',').map(e => e.trim()).filter(Boolean) : [''];

    for (const hookEvt of events) {
      for (const m of matchers) {
        log(`Loaded external hook ${def.name} (${hookEvt}) from ${entryPath} [matcher: ${m || '*'}]`);
        loadedHooks.push({
          event: hookEvt,
          matcher: m === '*' ? '' : m,
          caller: async (input: unknown) => {
            try {
              let toolOutput = '';
              if (input && typeof input === 'object') {
                if ('tool_response' in input) {
                  const resp = (input as any).tool_response;
                  toolOutput = typeof resp === 'string' ? resp : JSON.stringify(resp || '');
                }
                if ('tool_output' in input) {
                  const gout = (input as any).tool_output;
                  if (gout) {
                    toolOutput += '\n' + JSON.stringify(gout);
                  }
                }
                if ('error' in input) {
                  const errOut = (input as any).error;
                  if (errOut) {
                    toolOutput += '\n' + (typeof errOut === 'string' ? errOut : JSON.stringify(errOut));
                  }
                }
              }

              log(`Running external hook ${def.name}`);

              const { stdout } = await execFileAsync(entryPath, [], {
                cwd: def.baseDir,
                env: {
                  ...process.env,
                  CLAUDE_TOOL_OUTPUT: toolOutput,
                  CLAUDE_TOOL_NAME: (input as any)?.tool_name || '',
                  CLAUDE_HOOK_EVENT: hookEvt,
                }
              });

              if (stdout.trim()) {
                log(`External hook ${def.name} returned additional context`);
                return {
                  hookSpecificOutput: {
                    hookEventName: hookEvt as any,
                    additionalContext: stdout.trim()
                  }
                };
              }

              log(`External hook ${def.name} completed with no additional context`);
            } catch (err) {
              log(`Error running external hook ${def.name}: ${formatHookExecutionError(err)}`);
            }
            return {};
          }
        });
      }
    }
  }

  const bootLog = warnings.length > 0 ? `[External Hooks Loader Warnings]\n${warnings.join('\n')}` : '';
  return { hooks: loadedHooks, bootLog };
}

const { hooks: extHooks, bootLog: extBootLog } = loadExternalHooksWithLogging();

function createExternalBootHook(): HookCallback {
  return async () => {
    if (bootHookFired) return {};
    bootHookFired = true;

    if (!extBootLog) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `<system-boot-log>\n${extBootLog}\n</system-boot-log>`
      }
    };
  };
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function createPreToolUseHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name) {
      const toolInput = preInput.tool_input as Record<string, unknown> | undefined;
      let description = typeof toolInput?.description === 'string' ? toolInput.description : undefined;

      if (!description) {
        if (preInput.tool_name === 'Bash') {
          description = `执行: ${String(toolInput?.command || '').slice(0, 40)}`;
        } else if (preInput.tool_name === 'Glob') {
          description = `搜索文件: ${toolInput?.pattern}`;
        } else if (preInput.tool_name === 'Grep') {
          description = `内容搜索: ${toolInput?.pattern}`;
        } else if (preInput.tool_name === 'Read' || preInput.tool_name === 'View') {
          const file = String(toolInput?.file_path || '').split('/').pop();
          description = `读取文件: ${file}`;
        } else if (preInput.tool_name === 'Write' || preInput.tool_name === 'Edit') {
          const file = String(toolInput?.file_path || toolInput?.target_file || '').split('/').pop();
          description = `修改文件: ${file}`;
        }
      }

      writeIpcStatus({ type: 'tool_status', tool: preInput.tool_name, description, status: 'running' });
    }
    return {};
  };
}

function createPostToolUseHook(): HookCallback {
  return async () => {
    // Keep the previous status visible until the final result
    // writeToolStatus({ type: 'tool_status', status: 'idle' });
    return {};
  };
}


/**
 * PostToolUse hook: when a tool call fails validation, return the correct
 * usage/signature so the model knows exactly how to fix its call.
 */
function createToolUsageHintHook(): HookCallback {
  // Registry of tool parameter signatures for error guidance
  const TOOL_USAGE: Record<string, string> = {
    'mcp__nanoclaw__send_message': 'send_message({ text: string, sender?: string })\n  例: send_message({ text: "你好" })',
    'mcp__nanoclaw__send_card': 'send_card({ title: string, content: string, color?: string, buttons?: [{text, url}] })\n  例: send_card({ title: "标题", content: "正文内容" })',
    'mcp__nanoclaw__send_media': 'send_media({ file_path?: string, url?: string, media_id?: string, media_type?: "photo"|"video"|"audio"|"document", caption?: string })\n  三选一: file_path / url / media_id',
    'mcp__nanoclaw__generate_image': 'generate_image({ prompt: string, source_image?: string, model?: string, size?: string, caption?: string })\n  例: generate_image({ prompt: "一只猫" })',
    'mcp__nanoclaw__schedule_task': 'schedule_task({ prompt: string, schedule_type: "cron"|"interval"|"once", schedule_value: string, context_mode?: "group"|"isolated" })',
    'mcp__nanoclaw__register_group': 'register_group({ jid: string, name: string, folder: string, trigger: string })',
    'mcp__nanoclaw__rag_search': 'rag_search({ query: string, top_k?: number })',
    'mcp__nanoclaw__list_tasks': 'list_tasks({})',
    'mcp__nanoclaw__pause_task': 'pause_task({ task_id: string })',
    'mcp__nanoclaw__resume_task': 'resume_task({ task_id: string })',
    'mcp__nanoclaw__cancel_task': 'cancel_task({ task_id: string })',
    'mcp__nanoclaw__x_post': 'x_post({ content: string })',
    'mcp__nanoclaw__x_like': 'x_like({ tweet_url: string })',
    'mcp__nanoclaw__x_reply': 'x_reply({ tweet_url: string, content: string })',
    'mcp__nanoclaw__x_retweet': 'x_retweet({ tweet_url: string })',
    'mcp__nanoclaw__x_quote': 'x_quote({ tweet_url: string, comment: string })',
    'mcp__nanoclaw__x_trends': 'x_trends({ count?: number })',
    'mcp__nanoclaw__get_cached_media': 'get_cached_media({ mediaId: string })',
    'mcp__nanoclaw__describe_cached_image': 'describe_cached_image({ mediaId: string, prompt: string })',
    'mcp__nanoclaw__describe_cached_video': 'describe_cached_video({ mediaId: string, prompt: string })',
    'mcp__nanoclaw__transcribe_cached_audio': 'transcribe_cached_audio({ mediaId: string })',
    'TeamCreate': 'TeamCreate({ team_name: string, description?: string, agent_type?: string })',
    'SendMessage': 'SendMessage({ to: string, content: string })',
  };

  return async (input) => {
    const postInput = input as any;
    const toolName: string = postInput.tool_name || '';
    const toolOutput = postInput.tool_response || postInput.error;

    if (!toolOutput) return {};

    const outputStr = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);

    // Only trigger on validation errors
    const isValidationError = [
      'Invalid arguments for tool',
      'InputValidationError',
      'invalid_type',
      'is missing',
      'MCP error -32602',
      'tool_use_error',
    ].some(p => outputStr.includes(p));

    if (!isValidationError) return {};

    const usage = TOOL_USAGE[toolName];
    const hint = usage
      ? `工具调用失败。正确用法:\n${usage}\n如果连续失败，请直接用文本回复用户。`
      : `工具 ${toolName} 调用参数错误。请检查必需参数后重试，或直接用文本回复用户。`;

    log(`[ToolUsageHint] ${toolName}: returning usage hint`);

    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: hint,
      },
    };
  };
}


/**
 * Native, single-process hook adapter for context-mode.
 * Instead of spawning CLI processes, this intercepts stdout and dynamically
 * imports the context-mode hook scripts directly into the agent-runner process.
 */
function createContextModeHook(hookName: 'pretooluse' | 'posttooluse' | 'posttoolusefailure' | 'precompact' | 'sessionstart' | 'userpromptsubmit'): HookCallback {
  return async (input, _toolUseId, _context) => {
    try {
      const { resolve } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { createRequire } = await import('node:module');
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const req = createRequire(import.meta.url);

      // Resolve the actual installation path of context-mode
      // (symlinked from global via `npm link context-mode` in Dockerfile)
      // Note: we resolve the main entry point instead of package.json because
      // the package's exports map doesn't include ./package.json
      const cmEntry = req.resolve('context-mode');
      let cmRoot = path.dirname(cmEntry);
      // Walk up until we find the directory containing package.json with name "context-mode"
      while (cmRoot !== path.dirname(cmRoot)) {
        const pkgPath = path.join(cmRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.name === 'context-mode') break;
          } catch { }
        }
        cmRoot = path.dirname(cmRoot);
      }
      const scriptName = hookName === 'posttoolusefailure' ? 'posttooluse' : hookName;
      const scriptPath = resolve(cmRoot, 'hooks', `${scriptName}.mjs`);

      // Context-mode hook scripts read from stdin and write to stdout.
      // We must mock these for the duration of the dynamic import.
      const originalStdinRead = process.stdin.read;
      const originalStdinOn = process.stdin.on;
      const originalStdinSetEncoding = process.stdin.setEncoding;
      const originalStdinResume = process.stdin.resume;

      let mappedInput: any = input;
      if (hookName === 'posttoolusefailure') {
        mappedInput = {
          ...input,
          hook_event_name: 'PostToolUse',
          tool_response: (input as any).error || "Execution failed",
          tool_output: { isError: true }
        };
      }


      const inputBuffer = Buffer.from(JSON.stringify(mappedInput) + '\n', 'utf-8');

      // Mock stdin to immediately yield our Input JSON
      process.stdin.setEncoding = () => process.stdin;
      process.stdin.resume = () => process.stdin;
      process.stdin.on = ((event: string, listener: (...args: any[]) => void) => {
        if (event === 'data') listener(inputBuffer);
        if (event === 'end') listener();
        return process.stdin;
      }) as any;

      // Use AsyncLocalStorage to scope the stdout capture to just this execution thread
      // Global patch is needed since `process.stdout.write` is used globally, but the patch
      // delegates back to `originalStdoutWrite` if not in the hook context to avoid breaking SDK stream.
      const originalStdoutWrite = process.stdout.write;
      const als = new AsyncLocalStorage<string[]>();

      process.stdout.write = (function (this: any, chunk: any, ...args: any[]) {
        const store = als.getStore();
        if (store) {
          store.push(chunk.toString());
          return true;
        }
        return originalStdoutWrite.apply(this, [chunk, ...args] as any) as boolean;
      }) as any;

      let capturedOutput = '';
      try {
        const buf: string[] = [];
        await als.run(buf, async () => {
          // Execute the hook script natively
          // Cache busting allows the script to run multiple times
          await import(pathToFileURL(scriptPath).href + `?t=${Date.now()}`);
        });
        capturedOutput = buf.join('');
      } finally {
        // Restore IO
        process.stdin.read = originalStdinRead;
        process.stdin.on = originalStdinOn;
        process.stdin.setEncoding = originalStdinSetEncoding;
        process.stdin.resume = originalStdinResume;
        process.stdout.write = originalStdoutWrite;
      }

      if (!capturedOutput.trim()) return {};
      const result = JSON.parse(capturedOutput);

      // Map old property name to new one for SDK compatibility
      if (result && result.hookSpecificOutput) {
        if (result.hookSpecificOutput.additionalSystemContext && !result.hookSpecificOutput.additionalContext) {
          result.hookSpecificOutput.additionalContext = result.hookSpecificOutput.additionalSystemContext;
        }
      }

      return result;
    } catch (err) {
      log(`Context-mode hook [${hookName}] failed: ${err}`);
      return {}; // Non-blocking: fail open
    }
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcDrainResult {
  pendingAvailable: boolean;
  legacyMessages: string[];
}

function appendPromptText(prompt: string | any[], text: string): string | any[] {
  if (!text) return prompt;
  if (typeof prompt === 'string') {
    return prompt ? `${prompt}\n${text}` : text;
  }

  return [...prompt, { type: 'text', text: `\n${text}` }];
}

/**
 * Drain all pending IPC control messages.
 * Legacy {type:"message"} payloads are still supported for compatibility.
 */
function drainIpcInput(): IpcDrainResult {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const result: IpcDrainResult = {
      pendingAvailable: false,
      legacyMessages: [],
    };

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);

        if (data.type === 'pending_available') {
          result.pendingAvailable = true;
          continue;
        }

        if (data.type === 'message' && data.text) {
          result.legacyMessages.push(data.text);
          continue;
        }

        log(`Ignoring unknown IPC payload type from ${file}: ${String(data.type || 'unknown')}`);
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }

    return result;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return {
      pendingAvailable: false,
      legacyMessages: [],
    };
  }
}

/**
 * Wait for a new IPC control signal or _close sentinel.
 */
function waitForIpcSignal(): Promise<IpcDrainResult | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const drain = drainIpcInput();
      if (drain.pendingAvailable || drain.legacyMessages.length > 0) {
        resolve(drain);
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };

    poll();
  });
}

async function fetchPendingBatch(
  containerInput: ContainerInput,
  consumedThroughTimestamp?: string,
): Promise<PendingBatchResponse> {
  if (!containerInput.gatewayUrl || !containerInput.gatewayToken) {
    return {
      success: false,
      pending: false,
      error: 'Missing gateway URL or token for pending batch pull',
    };
  }

  try {
    const response = await fetch(`${containerInput.gatewayUrl}/ipc/pending`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${containerInput.gatewayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ consumedThroughTimestamp: consumedThroughTimestamp || null }),
    });

    const body = await response.json() as PendingBatchResponse;
    if (!response.ok) {
      return {
        success: false,
        pending: false,
        error: body.error || `Pending batch request failed with status ${response.status}`,
      };
    }

    return body;
  } catch (err) {
    return {
      success: false,
      pending: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * While the query is active, it only records pending_available signals and
 * defers fetching the full batch until the current turn finishes.
 */
async function runQuery(
  prompt: string | any[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  consumedThroughTimestamp?: string,
  isHeartbeat?: boolean,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  hadError: boolean;
  pendingAvailableDuringQuery: boolean;
  updatedConsumedThroughTimestamp?: string;
  legacyMessagesBuffer?: string[];
}> {
  const stream = new MessageStream();

  let updatedConsumedThroughTimestamp = consumedThroughTimestamp;
  let legacyMessagesBuffer: string[] = [];

  // Poll IPC for control signals and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let pendingAvailableDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const drain = drainIpcInput();
    if (drain.pendingAvailable) {
      pendingAvailableDuringQuery = true;
      log('Received pending_available signal during active query');
    }
    if (drain.legacyMessages.length > 0) {
      pendingAvailableDuringQuery = true;
      legacyMessagesBuffer.push(...drain.legacyMessages);
      log(`Received ${drain.legacyMessages.length} legacy IPC message payload(s) during query; queued for hook injection`);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let hadError = false;
  let emittedTexts = new Set<string>();

  // Inject global rules and group-specific rules
  let additionalContext = '';
  if (containerInput.toolsContent) {
    additionalContext += '\n' + containerInput.toolsContent + '\n';
    log('Injecting Tools.md into system prompt');
  }
  if (containerInput.adminToolsContent) {
    additionalContext += '\n' + containerInput.adminToolsContent + '\n';
    log('Injecting AdminTools.md into system prompt');
  }
  if (containerInput.contextModeContent) {
    additionalContext += '\n' + containerInput.contextModeContent + '\n';
    log('Injecting ContextMode.md into system prompt');
  }
  if (!containerInput.isMain && containerInput.isGroup && containerInput.teamRuleContent) {
    additionalContext += '\n' + containerInput.teamRuleContent + '\n';
    log('Injecting GroupRule.md into system prompt for group chat');
  }

  if ((containerInput as any).userProfileContent) {
    additionalContext += '\n[用户信息/USER (文件路径: /workspace/group/USER.md)]\n' + (containerInput as any).userProfileContent + '\n';
    log('Injecting Agent USER.md into system prompt');
  }

  if ((containerInput as any).agentExperienceContent) {
    additionalContext += '\n[专属历史经验与准则/EXPERIENCE (文件路径: /workspace/group/EXPERIENCE.md)]\n' + (containerInput as any).agentExperienceContent + '\n';
    log('Injecting Agent EXPERIENCE.md into system prompt');
  }

  // --- Manually dispatch SessionStart hooks (Executed ONCE per container lifecycle) ---
  if (cachedSessionStartHooksOutput === null) {
    cachedSessionStartHooksOutput = '';
    const sessionStartHooks = [
      createExternalBootHook(),
      createContextModeHook('sessionstart'),
      ...extHooks.filter(h => h.event === 'SessionStart').map(h => h.caller)
    ];

    log(`Resolved ${sessionStartHooks.length} SessionStart hooks for execution`);

    for (const hook of sessionStartHooks) {
      try {
        let sessionSource = (containerInput as any).sessionId ? 'resume' : 'startup';
        const stringifiedPrompt = typeof containerInput.prompt === 'string' 
          ? containerInput.prompt 
          : JSON.stringify(containerInput.prompt || '');
        if (sessionSource === 'startup' && stringifiedPrompt.includes('Session has been compacted')) {
          sessionSource = 'compact';
        }

        const result = await hook({
          hook_event_name: 'SessionStart',
          source: sessionSource,
          sessionId: (containerInput as any).sessionId || 'pending'
        } as any, undefined, { signal: new AbortController().signal } as any);
        const output = result as any;
        if (output && output.hookSpecificOutput) {
          const injectedContext = output.hookSpecificOutput.additionalContext || output.hookSpecificOutput.additionalSystemContext;
          if (injectedContext) {
            cachedSessionStartHooksOutput += '\n' + injectedContext + '\n';
            log('Injected context from SessionStart hook');
          }
        }
      } catch (err) {
        log(`SessionStart hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  additionalContext += cachedSessionStartHooksOutput;

  const finalAdditionalContext = additionalContext.trim() || undefined;

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';

  if (finalAdditionalContext) {
    // Inject system context natively via CLAUDE.md autoloader bypassing SDK limitations
    const systemContextDir = '/tmp/nanoclaw-system-ctx';
    if (!fs.existsSync(systemContextDir)) fs.mkdirSync(systemContextDir, { recursive: true });
    fs.writeFileSync(path.join(systemContextDir, 'CLAUDE.md'), `<system-reminder>\n${finalAdditionalContext}\n</system-reminder>\n\n`);
    extraDirs.push(systemContextDir);
    log('Propagated system context via dynamic SDK CLAUDE.md autoloader');
  }

  const invokeUserPromptSubmit = async (text: string | any[]) => {
    let rawText = '';
    if (typeof text === 'string') {
      rawText = text;
    } else if (Array.isArray(text)) {
      rawText = text.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\\n');
    }
    if (!rawText || rawText.trim() === '') return;
    try {
      log('Triggering UserPromptSubmit manually for incoming messages');
      const hook = createContextModeHook('userpromptsubmit');
      await hook(
        { hook_event_name: 'UserPromptSubmit', prompt: rawText, message: rawText, session_id: sessionId } as any,
        undefined,
        { signal: new AbortController().signal } as any
      );
    } catch (err) {
      log(`UserPromptSubmit manual hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Trigger UserPromptSubmit manually to persist user intents
  await invokeUserPromptSubmit(prompt);

  // Push the original pristine prompt tightly coupled to the message flow
  stream.push(prompt);

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  let alreadyInjectedDuringQuery = false;

  // ─── Mid-query user message injection ─────────────────────────────────
  //
  // KNOWN LIMITATION (SDK constraint):
  // The SDK's PostToolUse hook `additionalContext` is injected into the
  // current API request at runtime, but is NOT written to the session
  // transcript JSONL.  This means mid-query user messages injected here
  // are visible to the model in the current turn but will be LOST when
  // the session is resumed (container restart / new conversation).
  //
  // In contrast, tool_result blocks are first-class conversation messages
  // that the SDK both sends to the API and persists to the transcript.
  //
  // The dual-guarantee approach (inject via additionalContext for immediate
  // visibility + re-fetch as next query prompt for persistence) was tested
  // but causes double responses — the model processes the same message
  // twice.  Until the SDK supports persistent hook injection or we can
  // inject messages as proper user turns via MessageStream.push() without
  // losing mid-turn visibility, this limitation is accepted.
  //
  // TODO: Revisit when the SDK exposes a way to persist hook-injected
  // content, or when we can intercept the raw messages array at the
  // gateway proxy level to insert proper {type:"text"} content blocks
  // alongside tool_result in the user message.
  // ──────────────────────────────────────────────────────────────────────
  const injectionHook: HookCallback = async () => {
    let injectedMessages: string[] = [];

    // Check IPC for new pending signals (even if we already injected once)
    const drain = drainIpcInput();
    if (drain.pendingAvailable) {
      pendingAvailableDuringQuery = true;
      alreadyInjectedDuringQuery = false; // new messages arrived, allow re-injection
    }
    if (drain.legacyMessages.length > 0) {
      pendingAvailableDuringQuery = true;
      alreadyInjectedDuringQuery = false;
      legacyMessagesBuffer.push(...drain.legacyMessages);
    }

    // Skip if we already injected for this batch (avoid re-injecting same messages on every tool use)
    if (alreadyInjectedDuringQuery) return {};

    if (pendingAvailableDuringQuery) {
      const batch = await fetchPendingBatch(containerInput, updatedConsumedThroughTimestamp || consumedThroughTimestamp);
      // Don't reset pendingAvailableDuringQuery — leave it true so the
      // query loop re-fetches these messages as a proper persistent prompt
      // after the current query ends.  The additionalContext injection below
      // gives the model immediate visibility, but hook-injected context is
      // NOT persisted in the SDK transcript.  Re-fetching ensures persistence.

      if (batch.success && batch.pending && batch.prompt) {
        let msg = typeof batch.prompt === 'string' ? batch.prompt : JSON.stringify(batch.prompt);
        injectedMessages.push(msg);
        // NOTE: intentionally NOT advancing updatedConsumedThroughTimestamp
        // so the same messages are re-fetched as the next query's formal prompt
      }
      if (legacyMessagesBuffer.length > 0) {
        // Inject a copy but keep originals in buffer for the query loop
        injectedMessages.push(...legacyMessagesBuffer);
      }
    }

    if (injectedMessages.length > 0) {
      const combined = injectedMessages.join('\\n');
      log(`Injected ${injectedMessages.length} new user message(s) into context.`);
      alreadyInjectedDuringQuery = true; // prevent re-injection until new messages arrive

      // Also apply UserPromptSubmit to dynamically injected messages inside queries
      await invokeUserPromptSubmit(combined);

      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: combined
        }
      };
    }
    return {};
  };

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        model: sdkEnv.ANTHROPIC_MODEL,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        // Heartbeat queries use persistSession:false so they don't pollute
        // the session transcript. The AI still sees full context via resume,
        // but the heartbeat prompt and response are never written to disk.
        ...(isHeartbeat ? { persistSession: false } : {}),
        resumeSessionAt: resumeAt,
        systemPrompt: undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          // 'WebSearch', 'WebFetch', // Disabled: requires native Anthropic API; use mcp__parallel-search__search instead
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
          'mcp__context-mode__*',
          'mcp__parallel-search__*'
          //'mcp__parallel-task__*'
        ],
        disallowedTools: ['CronCreate', 'CronDelete', 'CronList', 'WebSearch', 'WebFetch'],
        env: sdkEnv,
        effort: 'high',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              NANOCLAW_GATEWAY_TOKEN: containerInput.gatewayToken || '',
              NANOCLAW_GATEWAY_URL: containerInput.gatewayUrl || '',
              ...(sdkEnv.WHATAI_API_KEY ? { WHATAI_API_KEY: sdkEnv.WHATAI_API_KEY } : {}),
              ...(sdkEnv.IMAGE_BASE_URL ? { IMAGE_BASE_URL: sdkEnv.IMAGE_BASE_URL } : {}),
              ...(sdkEnv.IMAGE_MODEL ? { IMAGE_MODEL: sdkEnv.IMAGE_MODEL } : {}),
              ...(sdkEnv.VISION_API_KEY ? { VISION_API_KEY: sdkEnv.VISION_API_KEY } : {}),
              ...(sdkEnv.VISION_BASE_URL ? { VISION_BASE_URL: sdkEnv.VISION_BASE_URL } : {}),
              ...(sdkEnv.VISION_MODEL ? { VISION_MODEL: sdkEnv.VISION_MODEL } : {}),
              ...(sdkEnv.EMBEDDING_API_KEY ? { EMBEDDING_API_KEY: sdkEnv.EMBEDDING_API_KEY } : {}),
            },
          },
          'context-mode': {
            command: '/app/node_modules/.bin/context-mode',
            args: ['--transport', 'stdio'],
            env: {
              ...process.env,
              TMPDIR: process.env.TMPDIR || '/tmp',
              HOME: process.env.CONTEXT_MODE_HOME || '/workspace/group',
            },
          },
          ...(sdkEnv.PARALLEL_API_KEY ? {
            'parallel-search': {
              type: 'http' as const,
              url: 'https://search-mcp.parallel.ai/mcp',
              headers: { 'Authorization': `Bearer ${sdkEnv.PARALLEL_API_KEY}` },
            },
          } : {}),
        },
        // Use the native SDK format for hooks and dynamically inject our extHooks
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(containerInput.assistantName)] },
            { hooks: [createContextModeHook('precompact')] },
            ...extHooks.filter(h => h.event === 'PreCompact').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { matcher: '', hooks: [createPreToolUseHook(), createContextModeHook('pretooluse')] },
            ...extHooks.filter(h => h.event === 'PreToolUse').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PostToolUse: [
            { matcher: '', hooks: [createPostToolUseHook(), createToolUsageHintHook(), createContextModeHook('posttooluse'), injectionHook] },
            ...extHooks.filter(h => h.event === 'PostToolUse').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          PostToolUseFailure: [
            { matcher: '', hooks: [createPostToolUseHook(), createToolUsageHintHook(), createContextModeHook('posttoolusefailure'), injectionHook] },
            ...extHooks.filter(h => h.event === 'PostToolUseFailure').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
          SessionStart: [
            { matcher: '', hooks: [createExternalBootHook(), createContextModeHook('sessionstart')] },
            ...extHooks.filter(h => h.event === 'SessionStart').map(h => ({ matcher: h.matcher, hooks: [h.caller] }))
          ],
        },
        includePartialMessages: true,
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant') {
        if ('uuid' in message) {
          lastAssistantUuid = (message as { uuid: string }).uuid;
        }

        let assistantMsg: any = null;
        if ('message' in message && typeof (message as any).message === 'object') {
          assistantMsg = (message as any).message;
        } else if ('content' in message) {
          assistantMsg = message;
        }

        if (assistantMsg && assistantMsg.content && Array.isArray(assistantMsg.content)) {
          // Protection: if this turn also calls send_message, skip forwarding the
          // text block here — the Gateway will deliver the actual message content,
          // and emitting here too would cause a duplicate in the chat window.
          const hasSendMessageTool = assistantMsg.content.some(
            (c: any) => c.type === 'tool_use' && (
              c.name === 'mcp__nanoclaw__send_message' ||
              c.name === 'SendMessage'
            )
          );

          if (hasSendMessageTool) {
            log('Skipping intermediate text: same turn has send_message tool call (Gateway handles it)');
          } else {
            const textParts = assistantMsg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text);
            const thisTurnText = textParts.join('');

            if (thisTurnText) {
              emittedTexts.add(thisTurnText);
              log(`Emitting intermediate assistant text length: ${thisTurnText.length}`);
              writeOutput({
                status: 'success',
                result: thisTurnText,
                newSessionId,
                consumedThroughTimestamp,
              });
            }
          }
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
        writeIpcStatus({ type: 'task_status', task_id: tn.task_id, status: tn.status, summary: tn.summary });
      }

      // Emit tool status events for host-side Telegram updates
      // SDK Hook PreToolUse handles standard tools, but tool_progress adds elapsed times for bash
      if (message.type === 'tool_progress') {
        const tp = message as { tool_name: string; elapsed_time_seconds: number };
        writeIpcStatus({ type: 'tool_status', tool: tp.tool_name, status: 'running', elapsed: tp.elapsed_time_seconds });
      }

      if (message.type === 'result') {
        // Signal tool status idle when a result arrives
        writeIpcStatus({ type: 'tool_status', status: 'idle' });
        resultCount++;
        let textResult = 'result' in message ? (message as { result?: string }).result : null;
        const subtype = (message as { subtype?: string }).subtype || '';
        if (subtype === 'error_during_execution' || subtype === 'error_max_turns') {
          hadError = true;
          log(`Result #${resultCount} had error subtype: ${subtype}`);
        }

        if (textResult && emittedTexts.has(textResult)) {
          log('Skipping duplicate final result text as it was already emitted');
          textResult = null;
        }

        log(`Result #${resultCount}: subtype=${subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        writeOutput({
          status: hadError ? 'error' : 'success',
          result: textResult || null,
          newSessionId,
          consumedThroughTimestamp,
          queryCompleted: true,
          ...(hadError ? { error: `Agent result: ${subtype}` } : {}),
        });
        // Break out of the for-await loop after receiving a result.
        // With isSingleUserTurn=false (MessageStream prompt), the SDK
        // will block waiting for the next user message from the stream
        // instead of terminating. Breaking here lets the query loop
        // fetch pending messages and start a new query turn.
        break;
      }
    }
  } finally {
    ipcPolling = false;
    stream.end();
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, hadError: ${hadError}`);
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    hadError,
    pendingAvailableDuringQuery,
    updatedConsumedThroughTimestamp,
    legacyMessagesBuffer,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build the initial prompt.
  let prompt: string | any[] = containerInput.prompt;
  let consumedThroughTimestamp: string | undefined;
  if (containerInput.isScheduledTask) {
    if (typeof prompt === 'string') {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    } else if (Array.isArray(prompt)) {
      prompt = [
        { type: 'text', text: `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n` },
        ...prompt
      ];
    }
  }
  const initialDrain = drainIpcInput();
  let pendingRequested = initialDrain.pendingAvailable;
  if (initialDrain.legacyMessages.length > 0) {
    log(`Draining ${initialDrain.legacyMessages.length} legacy IPC message payload(s) into initial prompt`);
    prompt = appendPromptText(prompt, initialDrain.legacyMessages.join('\n'));
  }

  if (containerInput.pullPendingOnStart) {
    const batch = await fetchPendingBatch(containerInput, consumedThroughTimestamp);
    if (!batch.success) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: batch.error || 'Failed to fetch initial pending batch'
      });
      process.exit(1);
    }

    if (batch.pending && batch.prompt) {
      prompt = batch.prompt;
      consumedThroughTimestamp = batch.consumedThroughTimestamp;
      pendingRequested = false;
      log(`Fetched initial pending batch (${batch.messageCount || 0} messages) through ${consumedThroughTimestamp || 'unknown'}`);
    } else {
      log('No pending batch available on startup pull');
    }
  }

  if (
    containerInput.pullPendingOnStart &&
    !consumedThroughTimestamp &&
    typeof prompt === 'string' &&
    prompt.trim() === ''
  ) {
    log('No pending work available after startup pull, exiting without starting a query');
    return;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    queryLoop: while (true) {
      // Detect if this prompt is a heartbeat query
      const promptStr = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
      const isHeartbeatQuery = promptStr.includes('【系统后台节拍】');
      if (isHeartbeatQuery) {
        log('Heartbeat query detected, will use persistSession:false');
      }

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult: {
        newSessionId?: string;
        lastAssistantUuid?: string;
        closedDuringQuery: boolean;
        hadError: boolean;
        pendingAvailableDuringQuery: boolean;
        updatedConsumedThroughTimestamp?: string;
        legacyMessagesBuffer?: string[];
      };
      try {
        queryResult = await runQuery(
          prompt,
          sessionId,
          mcpServerPath,
          containerInput,
          sdkEnv,
          resumeAt,
          consumedThroughTimestamp,
          isHeartbeatQuery,
        );
      } catch (queryErr) {
        const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        log(`Query threw error, exiting for host-side retry: ${msg}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: msg,
          consumedThroughTimestamp,
          queryCompleted: true,
        });
        process.exit(1);
      }

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // When query ended with an error result, don't try to resume from the
      // error point — the SDK will crash. Restart the container cleanly.
      if (queryResult.hadError) {
        log('Query ended with error result, exiting for clean container restart');
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: 'Query ended with error, container will restart',
          consumedThroughTimestamp,
        });
        process.exit(1);
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Heartbeat queries used persistSession:false, so the session
      // transcript is untouched. Skip the session-update marker to avoid
      // resetting the host's idle timer.
      if (isHeartbeatQuery) {
        log('Heartbeat query completed, session transcript unchanged (persistSession:false)');
        // Don't update resumeAt or emit session update — the heartbeat
        // never touched the transcript, so the session is at the same point.
        continue queryLoop;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      if (queryResult.updatedConsumedThroughTimestamp) {
        consumedThroughTimestamp = queryResult.updatedConsumedThroughTimestamp;
      }

      pendingRequested = pendingRequested || queryResult.pendingAvailableDuringQuery;

      if (queryResult.legacyMessagesBuffer && queryResult.legacyMessagesBuffer.length > 0) {
        log(`Appending ${queryResult.legacyMessagesBuffer.length} remaining legacy IPC message(s) to prompt for next query loop`);
        prompt = appendPromptText('', queryResult.legacyMessagesBuffer.join('\\n'));
        consumedThroughTimestamp = undefined;
        continue queryLoop;
      }

      while (true) {
        if (pendingRequested) {
          const batch = await fetchPendingBatch(containerInput, consumedThroughTimestamp);
          if (!batch.success) {
            log(`Pending batch fetch failed after query: ${batch.error || 'unknown error'}`);
            writeOutput({
              status: 'error',
              result: null,
              newSessionId: sessionId,
              error: batch.error || 'Failed to fetch pending batch',
            });
            process.exit(1);
          }

          pendingRequested = false;
          if (batch.pending && batch.prompt) {
            prompt = batch.prompt;
            consumedThroughTimestamp = batch.consumedThroughTimestamp;
            log(`Fetched pending batch for next query (${batch.messageCount || 0} messages) through ${consumedThroughTimestamp || 'unknown'}`);
            break;
          }

          log('pending_available signal received but no pending batch was available');
        }

        log('Query ended, waiting for next IPC signal...');
        const nextSignal = await waitForIpcSignal();
        if (nextSignal === null) {
          log('Close sentinel received, exiting');
          break queryLoop;
        }

        if (nextSignal.pendingAvailable) {
          pendingRequested = true;
        }

        if (nextSignal.legacyMessages.length > 0 && !pendingRequested) {
          log(`Received ${nextSignal.legacyMessages.length} legacy IPC message payload(s) while idle`);
          prompt = appendPromptText('', nextSignal.legacyMessages.join('\n'));
          consumedThroughTimestamp = undefined;
          break;
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      consumedThroughTimestamp,
    });
    process.exit(1);
  }
}

main();
