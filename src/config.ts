import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_HAS_OWN_NUMBER',
  'HEARTBEAT_INTERVAL',
]);

export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
export const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '18789', 10);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

export const GATEWAY_AUTH_TOKEN = (() => {
  let token = process.env.GATEWAY_AUTH_TOKEN || envConfig.GATEWAY_AUTH_TOKEN;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    console.log(
      `\n\x1b[33m=================================================================\x1b[0m`,
    );
    console.log(
      `\x1b[33m[SECURITY] No GATEWAY_AUTH_TOKEN found in .env\x1b[0m`,
    );
    console.log(
      `\x1b[33m[SECURITY] A dynamic token was generated for this session:\x1b[0m`,
    );
    console.log(`\x1b[32m           ${token}\x1b[0m`);
    console.log(
      `\x1b[33m           You will need this to log into the Control Center from external IPs.\x1b[0m`,
    );
    console.log(
      `\x1b[33m=================================================================\x1b[0m\n`,
    );
  }
  return token;
})();

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const AGENTS_DIR = path.resolve(PROJECT_ROOT, 'agents');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const WORKSPACE_DIR = path.resolve(DATA_DIR, 'workspace');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '0', // disabled timeout since containers are persistent now
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '86400000',
  10,
); // default 24h as containers are now persistent
export const HEARTBEAT_INTERVAL = parseInt(
  process.env.HEARTBEAT_INTERVAL || envConfig.HEARTBEAT_INTERVAL || '300000',
  10,
); // default 5 min, override via .env
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Telegram bot pool for agent swarm (comma-separated tokens)
export const TELEGRAM_BOT_POOL = (
  process.env.TELEGRAM_BOT_POOL ||
  readEnvFile(['TELEGRAM_BOT_POOL']).TELEGRAM_BOT_POOL ||
  ''
)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
