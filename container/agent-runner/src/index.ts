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
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

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
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
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

/**
 * Write a tool status event to IPC so the host can relay it to Telegram.
 */
function writeToolStatus(status: { type: 'tool_status'; tool?: string; status: 'running' | 'idle'; elapsed?: number }): void {
  try {
    fs.mkdirSync(IPC_STATUS_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(IPC_STATUS_DIR, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(status));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    log(`Failed to write tool status: ${err instanceof Error ? err.message : String(err)}`);
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
      writeToolStatus({ type: 'tool_status', tool: preInput.tool_name, status: 'running' });
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
 * Native, single-process hook adapter for context-mode.
 * Instead of spawning CLI processes, this intercepts stdout and dynamically
 * imports the context-mode hook scripts directly into the agent-runner process.
 */
function createContextModeHook(hookName: 'pretooluse' | 'posttooluse' | 'precompact' | 'sessionstart'): HookCallback {
  return async (input, _toolUseId, _context) => {
    try {
      const { resolve } = await import('node:path');
      const { pathToFileURL } = await import('node:url');
      const { createRequire } = await import('node:module');
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const req = createRequire(import.meta.url);

      // Resolve the actual installation path of context-mode
      const cmRoot = resolve(req.resolve('context-mode/package.json'), '..');
      const scriptPath = resolve(cmRoot, 'hooks', `${hookName}.mjs`);

      // Context-mode hook scripts read from stdin and write to stdout.
      // We must mock these for the duration of the dynamic import.
      const originalStdinRead = process.stdin.read;
      const originalStdinOn = process.stdin.on;
      const originalStdinSetEncoding = process.stdin.setEncoding;
      const originalStdinResume = process.stdin.resume;

      const inputBuffer = Buffer.from(JSON.stringify(input) + '\n', 'utf-8');

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
      return JSON.parse(capturedOutput);
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

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string | any[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; hadError: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let hadError = false;

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
  const finalAdditionalContext = additionalContext.trim() || undefined;

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
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

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        model: sdkEnv.ANTHROPIC_MODEL,
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: finalAdditionalContext
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: finalAdditionalContext }
          : undefined,
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
          'mcp__parallel-search__*',
          'mcp__parallel-task__*'
        ],
        env: sdkEnv,
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
              ...(sdkEnv.WHATAI_API_KEY ? { WHATAI_API_KEY: sdkEnv.WHATAI_API_KEY } : {}),
            },
          },
          'context-mode': {
            command: 'context-mode',
            args: ['--transport', 'stdio'],
          },
          ...(sdkEnv.PARALLEL_API_KEY ? {
            'parallel-search': {
              type: 'http' as const,
              url: 'https://search-mcp.parallel.ai/mcp',
              headers: { 'Authorization': `Bearer ${sdkEnv.PARALLEL_API_KEY}` },
            },
            'parallel-task': {
              type: 'http' as const,
              url: 'https://task-mcp.parallel.ai/mcp',
              headers: { 'Authorization': `Bearer ${sdkEnv.PARALLEL_API_KEY}` },
            },
          } : {}),
        },
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(containerInput.assistantName)] },
            { hooks: [createContextModeHook('precompact')] }
          ],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { matcher: '', hooks: [createPreToolUseHook(), createContextModeHook('pretooluse')] }
          ],
          PostToolUse: [
            { matcher: '', hooks: [createPostToolUseHook(), createContextModeHook('posttooluse')] }
          ],
          SessionStart: [
            { matcher: '', hooks: [createContextModeHook('sessionstart')] }
          ],
        },
        includePartialMessages: true,
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
      }

      // Emit tool status events for host-side Telegram updates
      // SDK Hook PreToolUse handles standard tools, but tool_progress adds elapsed times for bash
      if (message.type === 'tool_progress') {
        const tp = message as { tool_name: string; elapsed_time_seconds: number };
        writeToolStatus({ type: 'tool_status', tool: tp.tool_name, status: 'running', elapsed: tp.elapsed_time_seconds });
      }

      if (message.type === 'result') {
        // Signal tool status idle when a result arrives
        writeToolStatus({ type: 'tool_status', status: 'idle' });
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        const subtype = (message as { subtype?: string }).subtype || '';
        if (subtype === 'error_during_execution' || subtype === 'error_max_turns') {
          hadError = true;
          log(`Result #${resultCount} had error subtype: ${subtype}`);
        }
        log(`Result #${resultCount}: subtype=${subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        writeOutput({
          status: hadError ? 'error' : 'success',
          result: textResult || null,
          newSessionId,
          ...(hadError ? { error: `Agent result: ${subtype}` } : {}),
        });
      }
    }
  } finally {
    ipcPolling = false;
    stream.end();
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, hadError: ${hadError}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, hadError };
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

  // Build initial prompt (drain any pending IPC messages too)
  let prompt: string | any[] = containerInput.prompt;
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
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    if (typeof prompt === 'string') {
      prompt += '\n' + pending.join('\n');
    } else {
      prompt.push({ type: 'text', text: '\n' + pending.join('\n') });
    }
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult: { newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; hadError: boolean };
      try {
        queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      } catch (queryErr) {
        // SDK threw during query (e.g. resuming from an error state).
        // Recover by clearing resume state and starting fresh on next message.
        const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        log(`Query threw error, recovering: ${msg}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: msg
        });
        resumeAt = undefined;
        sessionId = undefined;

        // Wait for next IPC message instead of crashing
        log('Waiting for next IPC message after error recovery...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received during error recovery, exiting');
          break;
        }
        prompt = nextMessage;
        continue;
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

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message, starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
