import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { DATA_DIR, STORE_DIR, AGENTS_DIR } from '../config.js';

const LITELLM_DIR = join(process.cwd(), 'litellm');

export function openSpendDb(): Database.Database | null {
  const p = join(LITELLM_DIR, 'spend.db');
  if (!existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true });
  } catch {
    return null;
  }
}

export function getSpendSummary(days: number): {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  request_count: number;
} {
  const db = openSpendDb();
  if (!db)
    return {
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      request_count: 0,
    };
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(prompt_tokens),0) as prompt_tokens, COALESCE(SUM(completion_tokens),0) as completion_tokens, COUNT(*) as request_count FROM spend_logs WHERE timestamp >= datetime('now', '-${days} days')`,
      )
      .get() as any;
    return (
      row || {
        total_tokens: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        request_count: 0,
      }
    );
  } catch {
    return {
      total_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      request_count: 0,
    };
  } finally {
    db.close();
  }
}

export function getSpendByModel(
  days: number,
): { model: string; total_tokens: number; request_count: number }[] {
  const db = openSpendDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT model, SUM(total_tokens) as total_tokens, COUNT(*) as request_count FROM spend_logs WHERE timestamp >= datetime('now', '-${days} days') GROUP BY model ORDER BY total_tokens DESC`,
      )
      .all() as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getSpendTimeline(
  days: number,
): { date: string; total_tokens: number; request_count: number }[] {
  const db = openSpendDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT date(timestamp) as date, SUM(total_tokens) as total_tokens, COUNT(*) as request_count FROM spend_logs WHERE timestamp >= datetime('now', '-${days} days') GROUP BY date(timestamp) ORDER BY date DESC`,
      )
      .all() as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getRecentSpendLogs(limit: number = 15): any[] {
  const db = openSpendDb();
  if (!db) return [];
  try {
    return db
      .prepare('SELECT * FROM spend_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getTaskRunLogs(taskId?: string, limit: number = 50): any[] {
  const dbPath = join(STORE_DIR, 'messages.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    if (taskId)
      return db
        .prepare(
          'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?',
        )
        .all(taskId, limit) as any[];
    return db
      .prepare('SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT ?')
      .all(limit) as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getAgentStatusFiles(): any[] {
  const statusDir = join(DATA_DIR, 'status');
  if (!existsSync(statusDir)) return [];
  return readdirSync(statusDir)
    .filter((f) => f.endsWith('.json') && f !== 'host.json')
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(statusDir, f), 'utf-8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function getAgentsConfig(): any[] {
  const p = join(AGENTS_DIR, 'agents.yaml');
  if (!existsSync(p)) return [];
  try {
    const parsed = parseYaml(readFileSync(p, 'utf-8')) as any;
    return parsed.bots || [];
  } catch {
    return [];
  }
}

export function getLiteLLMModels(): {
  model_name: string;
  model?: string;
  api_base?: string;
}[] {
  const p = join(LITELLM_DIR, 'config.yaml');
  if (!existsSync(p)) return [];
  try {
    const parsed = parseYaml(readFileSync(p, 'utf-8')) as any;
    return (parsed.model_list || []).map((m: any) => ({
      model_name: m.model_name,
      api_base: m.litellm_params?.api_base,
      model: m.litellm_params?.model,
    }));
  } catch {
    return [];
  }
}

export interface FileEntry {
  name: string;
  relativePath: string;
  size: number;
  isDirectory: boolean;
  extension: string;
}

export function listWorkspaceFiles(
  agentName: string,
  maxDepth = 4,
): FileEntry[] {
  const wsDir = join(DATA_DIR, 'workspace', agentName);
  if (!existsSync(wsDir)) return [];
  const entries: FileEntry[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth >= maxDepth || entries.length >= 500) return;
    try {
      for (const item of readdirSync(dir)) {
        if (
          item.startsWith('.') ||
          item === 'node_modules' ||
          item === '__pycache__'
        )
          continue;
        const full = join(dir, item);
        try {
          const st = statSync(full);
          entries.push({
            name: item,
            relativePath: relative(wsDir, full),
            size: st.size,
            isDirectory: st.isDirectory(),
            extension: extname(item),
          });
          if (st.isDirectory()) scan(full, depth + 1);
        } catch {
          /* skip */
        }
      }
    } catch {
      /* skip */
    }
  };
  scan(wsDir, 0);
  return entries;
}

export function readWorkspaceFile(
  agentName: string,
  filePath: string,
): string | null {
  if (filePath.includes('..')) return null;
  const full = join(DATA_DIR, 'workspace', agentName, filePath);
  if (!existsSync(full)) return null;
  try {
    const st = statSync(full);
    if (st.isDirectory() || st.size > 1024 * 1024) return null;
    return readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

export function getNanoClawEnv(): { key: string; value: string }[] {
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return [];
  try {
    return readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => {
        const [key, ...rest] = l.split('=');
        const value = rest.join('=');
        const sensitive = /key|token|secret|password/i.test(key);
        return { key: key.trim(), value: sensitive ? '***' : value.trim() };
      });
  } catch {
    return [];
  }
}
