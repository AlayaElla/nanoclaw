import pino from 'pino';
import { appendFileSync } from 'fs';

const ALERTS_PATH = 'data/system-alerts.jsonl';

/** Append an error-level log entry to the system alerts file for the Control Center. */
function persistAlert(obj: Record<string, unknown>, msg: string): void {
  try {
    // Derive a human-readable message from the error object if present
    const err = obj.err as any;
    const errMsg = (
      typeof err === 'object' && err !== null
        ? (err.message ?? String(err))
        : obj.error instanceof Error
          ? obj.error.message
          : ''
    ) as string;

    // Build a rich detail string from all available structured fields
    const detailParts: string[] = [];
    if (msg && msg !== errMsg) detailParts.push(msg);
    if (obj.code !== undefined) detailParts.push(`exit_code=${obj.code}`);
    if (typeof obj.stderr === 'string' && obj.stderr.trim()) {
      // Include last 500 chars of stderr for actionable diagnostics
      const tail = obj.stderr.trim().slice(-500);
      detailParts.push(`stderr: ${tail}`);
    }
    if (typeof obj.error === 'string') detailParts.push(`error: ${obj.error}`);
    if (typeof obj.logFile === 'string')
      detailParts.push(`log: ${obj.logFile}`);
    if (typeof err === 'object' && err !== null && err.stack) {
      detailParts.push(`stack: ${String(err.stack).slice(0, 300)}`);
    }

    const detail = detailParts.join(' | ') || undefined;

    const entry = JSON.stringify({
      level: 'error',
      source: obj.group ?? obj.groupFolder ?? obj.component ?? 'system',
      message: (errMsg || msg).slice(0, 300),
      detail: detail ? detail.slice(0, 1500) : undefined,
      timestamp: new Date().toISOString(),
      // Dedup key: same error class + source per hour
      hourKey: new Date().toISOString().slice(0, 13),
    });
    appendFileSync(ALERTS_PATH, entry + '\n', 'utf-8');
  } catch {
    // Never throw from error handler
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Wrap error/fatal to also persist to system-alerts.jsonl
const _error = logger.error.bind(logger);
const _fatal = logger.fatal.bind(logger);
logger.error = function (obj: any, msg?: any, ...args: any[]) {
  if (typeof obj === 'object' && obj !== null && typeof msg === 'string') {
    persistAlert(obj as Record<string, unknown>, msg);
  } else if (typeof obj === 'string') {
    persistAlert({}, obj);
  }
  return (_error as any)(obj, msg, ...args);
} as typeof logger.error;
logger.fatal = function (obj: any, msg?: any, ...args: any[]) {
  if (typeof obj === 'object' && obj !== null && typeof msg === 'string') {
    persistAlert(obj as Record<string, unknown>, msg);
  } else if (typeof obj === 'string') {
    persistAlert({}, obj);
  }
  return (_fatal as any)(obj, msg, ...args);
} as typeof logger.fatal;

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
