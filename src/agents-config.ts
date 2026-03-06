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
    token: string;
    model?: string;
}

interface AgentsFile {
    bots: BotConfig[];
}

let cachedConfig: BotConfig[] | null = null;

function loadConfig(): BotConfig[] {
    if (cachedConfig) return cachedConfig;

    const configPath = path.join(process.cwd(), 'agents.yaml');
    if (!fs.existsSync(configPath)) {
        logger.debug('agents.yaml not found, using empty config');
        cachedConfig = [];
        return cachedConfig;
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = parseYaml(raw) as AgentsFile;
        cachedConfig = parsed.bots || [];
        logger.info(
            { botCount: cachedConfig.length },
            'Loaded agents.yaml',
        );
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
 * Look up bot config by token env var name stored in the DB.
 * Maps env var (e.g., 'TELEGRAM_BOT_TOKEN_2') to the bot at index N-1.
 */
export function getBotConfig(tokenEnvVar: string): BotConfig | undefined {
    const match = tokenEnvVar.match(/(\d+)$/);
    if (!match) return undefined;
    const index = parseInt(match[1], 10) - 1; // 1-based → 0-based
    return loadConfig()[index];
}

/**
 * Get bot config by index (0-based).
 */
export function getBotConfigByIndex(index: number): BotConfig | undefined {
    return loadConfig()[index];
}
