import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export const IPC_STATUS_DIR = '/workspace/ipc/status';
export const IPC_INPUT_DIR = '/workspace/ipc/input';
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;

export type IpcStatusEvent =
  | { type: 'tool_status'; tool?: string; description?: string; status: 'running' | 'idle'; elapsed?: number }
  | { type: 'task_status'; task_id: string; status: string; summary: string }
  | { type: 'ask_user_question'; question_id: string; payload: any };

export interface IpcDrainResult {
  pendingAvailable: boolean;
  legacyMessages: string[];
}

export interface PendingBatchResponse {
  success: boolean;
  pending: boolean;
  prompt?: string;
  systemContext?: string;
  consumedThroughTimestamp?: string;
  messageCount?: number;
  error?: string;
}

// Stateful locks and questions dictionary for interactive interruption.
export const globalQuestionAnswers: Record<string, Record<string, any>> = {};
export const globalQuestionLocks = new Set<string>();

/**
 * Write a status event to IPC so the host can relay it.
 * Supports both tool_status and task_status event types.
 */
export function writeIpcStatus(status: IpcStatusEvent): void {
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
 * Check for _close sentinel.
 */
export function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC control messages.
 * Legacy {type:"message"} payloads are still supported for compatibility.
 */
export function drainIpcInput(): IpcDrainResult {
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
          if (globalQuestionLocks.size > 0) {
            // Resolve all pending waits to free all suspended tool calls synchronously
            for (const lockId of globalQuestionLocks) {
              globalQuestionAnswers[lockId] = { "其他": "请查阅下文的最新回复。" };
            }
            globalQuestionLocks.clear();
          }
          result.pendingAvailable = true;
          continue;
        }

        if (data.type === 'message' && data.text) {
          if (globalQuestionLocks.size > 0) {
            // User replied with text during a question wait instead of pressing buttons
            // Resolve all pending waits to free all suspended tool calls synchronously
            for (const lockId of globalQuestionLocks) {
              globalQuestionAnswers[lockId] = { "其他": data.text };
            }
            globalQuestionLocks.clear();
            continue;
          }
          result.legacyMessages.push(data.text);
          continue;
        }

        if (data.type === 'question_answer' && data.question_id) {
          globalQuestionAnswers[data.question_id] = data.answers;
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
export function waitForIpcSignal(): Promise<IpcDrainResult | null> {
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

export async function fetchPendingBatch(
  gatewayUrl: string | undefined,
  gatewayToken: string | undefined,
  consumedThroughTimestamp?: string,
): Promise<PendingBatchResponse> {
  if (!gatewayUrl || !gatewayToken) {
    return {
      success: false,
      pending: false,
      error: 'Missing gateway URL or token for pending batch pull',
    };
  }

  try {
    const response = await fetch(`${gatewayUrl}/ipc/pending`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gatewayToken}`,
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

export interface SyncHookResponse {
  success: boolean;
  additionalContext?: string;
  error?: string;
}

export async function fetchSyncHook(
  gatewayUrl: string | undefined,
  gatewayToken: string | undefined,
  hookName: string,
  payload: any
): Promise<SyncHookResponse> {
  if (!gatewayUrl || !gatewayToken) {
    return { success: false, error: 'Missing gateway URL or token' };
  }
  try {
    const response = await fetch(`${gatewayUrl}/ipc/hook/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${gatewayToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hookName, payload }),
    });
    const body = await response.json() as SyncHookResponse;
    if (!response.ok) {
      return { success: false, error: body.error || `Sync hook failed with status ${response.status}` };
    }
    return body;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
