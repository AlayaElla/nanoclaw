import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../utils/index.js';

import { createRequire } from 'node:module';

let cmRootCache: string | null = null;
let req: NodeRequire | null = null;

function getContextModeRoot(): string {
  if (cmRootCache) return cmRootCache;
  if (!req) req = createRequire(import.meta.url);
  
  const cmEntry = req.resolve('context-mode');
  let cmRoot = path.dirname(cmEntry);
  
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
  
  cmRootCache = cmRoot;
  return cmRoot;
}

/**
 * Hook adapter for context-mode.
 * Executes the hook scripts in an isolated child process to safely capture stdout
 * without risking AsyncLocalStorage leakages across module boundaries.
 */
export function createContextModeHook(hookName: 'pretooluse' | 'posttooluse' | 'posttoolusefailure' | 'precompact' | 'sessionstart' | 'userpromptsubmit'): HookCallback {
  return async (input, _toolUseId, _context) => {
    try {
      const cmRoot = getContextModeRoot();

      const scriptName = hookName === 'posttoolusefailure' ? 'posttooluse' : hookName;
      const scriptPath = path.resolve(cmRoot, 'hooks', `${scriptName}.mjs`);

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

      const capturedOutput = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
          env: process.env,
          stdio: ['pipe', 'pipe', 'inherit'] // inherit stderr to allow debugging
        });

        let stdoutData = '';
        child.stdout.on('data', (chunk) => {
          stdoutData += chunk;
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) {
            resolve(stdoutData);
          } else {
            reject(new Error(`Context-mode script ${scriptName}.mjs exited with code ${code}`));
          }
        });

        child.stdin.write(inputBuffer);
        child.stdin.end();
      });

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
