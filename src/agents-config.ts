/**
 * Agent (Bot) configuration loader.
 * Reads agents.yaml for per-bot config (token, name, model).
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { logger } from './logger.js';

export interface BotConfig {
  name: string;
  token?: string; // Optional for channels like Feishu that use global tokens
  channel?: string; // Optional, defaults to 'telegram' if has token
  folder?: string; // Optional, custom workspace folder instead of name
  model?: string;
  api_root?: string; // Optional custom telegram api root
  // Internal property injected during load for backward compatibility
  id?: string;
}

interface AgentsFile {
  bots: BotConfig[];
}

let cachedConfig: BotConfig[] | null = null;

function loadConfig(): BotConfig[] {
  if (cachedConfig) return cachedConfig;

  const configPath = path.join(process.cwd(), 'agents', 'agents.yaml');
  if (!fs.existsSync(configPath)) {
    logger.debug('agents.yaml not found, using empty config');
    cachedConfig = [];
    return cachedConfig;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw) as AgentsFile;
    const bots = parsed.bots || [];

    // Inject synthetic IDs for backward compatibility and explicit referencing
    cachedConfig = bots.map((bot, index) => {
      const channel = bot.channel || (bot.token ? 'telegram' : 'unknown');
      return {
        ...bot,
        channel,
        // Assign TELEGRAM_BOT_TOKEN_N to telegram bots for backward compat
        id:
          channel === 'telegram' ? `TELEGRAM_BOT_TOKEN_${index + 1}` : bot.name,
      };
    });

    logger.info({ botCount: cachedConfig.length }, 'Loaded agents.yaml');
    return cachedConfig;
  } catch (err) {
    logger.error({ err }, 'Failed to parse agents.yaml');
    cachedConfig = [];
    return cachedConfig;
  }
}

/**
 * Get all bot configs from agents.yaml.
 */
export function getAllBotConfigs(): BotConfig[] {
  return loadConfig();
}

/**
 * Look up bot config by its ID (either a TELEGRAM_BOT_TOKEN_N backward compatible ID
 * or explicitly by name for other channels).
 */
export function getBotConfig(botRef: string): BotConfig | undefined {
  const config = loadConfig();

  // First try semantic match by injected ID or explicit name
  const exactMatch = config.find((b) => b.id === botRef || b.name === botRef);
  if (exactMatch) return exactMatch;

  // Fallback: If it looks like a telegram token ref but wasn't found (e.g. index bound mismatch),
  // parse the digit and return by index for strict backward compatibility.
  const match = botRef.match(/TELEGRAM_BOT_TOKEN_(\d+)$/);
  if (match) {
    const index = parseInt(match[1], 10) - 1; // 1-based → 0-based
    const telegramBots = config.filter((b) => b.channel === 'telegram');
    // Return from ALL bots by index (original behavior) to be safe
    return config[index];
  }

  return undefined;
}

/**
 * Get bot config by index (0-based).
 */
export function getBotConfigByIndex(index: number): BotConfig | undefined {
  return loadConfig()[index];
}

/**
 * Get the first bot config matching a given channel name.
 * Useful for channels like Feishu that don't have per-bot tokens.
 */
export function getBotConfigByChannel(channel: string): BotConfig | undefined {
  return loadConfig().find((b) => b.channel === channel);
}

/**
 * Resolve the agent name from a bot reference (e.g. 'TELEGRAM_BOT_TOKEN_2' or 'feishu_xingmeng').
 * Falls back to the first bot's name or 'default'.
 */
export function resolveAgentName(botRef?: string): string {
  const config = botRef ? getBotConfig(botRef) : getBotConfigByIndex(0);
  return config?.name || 'default';
}

/**
 * Resolve the agent workspace folder from a bot reference.
 * Uses the config's 'folder' property if present, otherwise falls back to 'name'.
 */
export function resolveAgentFolder(botRef?: string): string {
  const config = botRef ? getBotConfig(botRef) : getBotConfigByIndex(0);
  return config?.folder || config?.name || 'default';
}
