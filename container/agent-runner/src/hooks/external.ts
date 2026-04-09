import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/index.js';

const execFileAsync = promisify(execFile);

export interface ExternalHookDef {
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
    if (!fs.existsSync(dir)) return;

    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'hooks' && d.isDirectory()) {
        const fullDir = path.join(dir, d.name);
        scanExternalHooks(fullDir);
      } else if (d.name.startsWith('@') && d.isDirectory()) {
        const fullDir = path.join(dir, d.name);
        for (const sub of fs.readdirSync(fullDir, { withFileTypes: true })) {
          if (sub.isDirectory()) scanExternalHooks(path.join(fullDir, sub.name));
        }
      } else if (d.isDirectory()) {
        const fullDir = path.join(dir, d.name);
        scanExternalHooks(fullDir);
      } else if (/^hook\.md$/i.test(d.name)) {
        const hookFilePath = path.join(dir, d.name);
        const fileContent = fs.readFileSync(hookFilePath, 'utf-8');
        let name = '', hookEvent = '', matcher = '', entry = '';
        let requiresBins: string[] = [];

        for (const line of fileContent.split('\n')) {
          if (line.startsWith('---')) continue;
          if (line.startsWith('name:')) name = line.substring(5).trim();
          else if (line.startsWith('hookEvent:')) hookEvent = line.substring(10).trim();
          else if (line.startsWith('matcher:')) matcher = line.substring(8).trim();
          else if (line.startsWith('entry:')) entry = line.substring(6).trim();
          else if (line.startsWith('requires:')) {
            const reqStr = line.substring(9).trim();
            if (reqStr) requiresBins = reqStr.split(',').map(r => r.trim()).filter(Boolean);
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

function formatHookExecutionError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && 'cmd' in err) {
    const e = err as { code: number; cmd: string; stdout?: string; stderr?: string };
    let msg = `Execution failed with code ${e.code} for command: ${e.cmd}`;
    if (e.stderr) msg += `\nStderr:\n${e.stderr}`;
    if (e.stdout) msg += `\nStdout:\n${e.stdout}`;
    return msg;
  }
  return err instanceof Error ? err.stack || err.message : String(err);
}

export function loadExternalHooks(): { hooks: Array<{ event: string; matcher: string; caller: HookCallback }>; bootLog: string } {
  externalHooks = [];
  bootLogLines = ['[NanoClaw External Script Hooks Loader]'];
  scanExternalHooks('/workspace/group/.claude/skills');

  const loadedHooks: Array<{ event: string; matcher: string; caller: HookCallback }> = [];
  let warnings: string[] = [];

  for (const def of externalHooks) {
    const entryPath = path.join(def.baseDir, def.entry);
    if (!fs.existsSync(entryPath)) {
      const reason = `⚠️ WARNING: Skipping external hook ${def.name}: entry not found at ${entryPath}`;
      log(reason);
      warnings.push(reason);
      continue;
    }

    let skip = false;
    for (const bin of def.requirements) {
      if (!fs.existsSync(`/usr/bin/${bin}`) && !fs.existsSync(`/bin/${bin}`) && !fs.existsSync(`/usr/local/bin/${bin}`)) {
        const reason = `⚠️ WARNING: Skipping external hook ${def.name}: missing required binary [${bin}]`;
        log(reason);
        warnings.push(reason);
        skip = true;
        break;
      }
    }
    if (skip) continue;

    const matchers = def.matcher ? def.matcher.split(',').map(m => m.trim()) : [''];
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

              const inputJson = input ? JSON.stringify(input) : '{}';
              const inputBuffer = Buffer.from(inputJson + '\n', 'utf-8');

              const { stdout, stderr } = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
                const child = spawn(entryPath, [], {
                  cwd: def.baseDir,
                  env: {
                    ...process.env,
                    CLAUDE_TOOL_OUTPUT: toolOutput,
                    CLAUDE_TOOL_NAME: (input as any)?.tool_name || '',
                    CLAUDE_HOOK_EVENT: hookEvt,
                    CLAUDE_HOOK_INPUT: inputJson
                  }
                });

                let outData = '';
                let errData = '';
                if (child.stdout) child.stdout.on('data', (chunk: Buffer) => outData += chunk.toString());
                if (child.stderr) child.stderr.on('data', (chunk: Buffer) => errData += chunk.toString());

                child.on('error', reject);
                child.on('close', () => resolve({ stdout: outData, stderr: errData }));

                if (child.stdin) {
                  child.stdin.write(inputBuffer);
                  child.stdin.end();
                }
              });

              if (stderr && stderr.trim()) {
                log(`[${def.name} STDERR]:\n${stderr.trim()}`);
              }

              if (stdout.trim()) {
                log(`External hook ${def.name} returned output`);
                try {
                  return JSON.parse(stdout.trim());
                } catch (e) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: hookEvt as any,
                      additionalContext: stdout.trim()
                    }
                  };
                }
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

export function createExternalBootHook(extBootLog: string): HookCallback {
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
