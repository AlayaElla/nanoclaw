import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { DATA_DIR, STORE_DIR, AGENTS_DIR } from '../config.js';

const LITELLM_DIR = join(process.cwd(), 'litellm');

export function openUsageDb(): Database.Database | null {
  const p = join(STORE_DIR, 'usage.db');
  if (!existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true });
  } catch {
    return null;
  }
}

export function getUsageSummary(days: number): {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
} {
  const db = openUsageDb();
  if (!db)
    return {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      request_count: 0,
    };
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COUNT(*) as request_count FROM token_usage WHERE timestamp >= datetime('now', '-${days} days')`,
      )
      .get() as any;
    return (
      row || {
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
      }
    );
  } catch {
    return {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      request_count: 0,
    };
  } finally {
    db.close();
  }
}

export function getUsageByDimension(
  dimension: 'model' | 'group_id' | 'tool_name' | 'task_id',
  days: number,
  limit: number = 20,
): { name: string; total_tokens: number; request_count: number }[] {
  const db = openUsageDb();
  if (!db) return [];
  try {
    const allowed = ['model', 'group_id', 'tool_name', 'task_id'];
    if (!allowed.includes(dimension)) return [];

    return db
      .prepare(
        `SELECT ${dimension} as name, SUM(total_tokens) as total_tokens, COUNT(*) as request_count 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') AND ${dimension} IS NOT NULL 
         GROUP BY ${dimension} 
         ORDER BY total_tokens DESC LIMIT ?`,
      )
      .all(limit) as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getUsageTimeline(
  days: number,
  groupBy: 'hour' | 'day' = 'day',
): {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}[] {
  const db = openUsageDb();
  if (!db) return [];
  const timeFormat = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
  try {
    return db
      .prepare(
        `SELECT strftime('${timeFormat}', timestamp) as date, 
                SUM(input_tokens) as input_tokens, 
                SUM(output_tokens) as output_tokens,
                SUM(total_tokens) as total_tokens 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') 
         GROUP BY date 
         ORDER BY date ASC`,
      )
      .all() as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getUsageTimelineByDimension(
  dimension: 'total' | 'model' | 'group_id' | 'tool_name' | 'task_id',
  days: number,
  groupBy: 'hour' | 'day' = 'day',
): { date: string; [key: string]: string | number }[] {
  const db = openUsageDb();
  if (!db) return [];
  const timeFormat = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

  if (dimension === 'total') {
    return getUsageTimeline(days, groupBy);
  }

  try {
    const allowed = ['model', 'group_id', 'tool_name', 'task_id'];
    if (!allowed.includes(dimension)) return [];

    const rows = db
      .prepare(
        `SELECT strftime('${timeFormat}', timestamp) as date, 
                ${dimension} as dimension_value,
                SUM(total_tokens) as total_tokens 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') AND ${dimension} IS NOT NULL
         GROUP BY date, dimension_value 
         ORDER BY date ASC`,
      )
      .all() as any[];

    // Pivot rows into shape: [{ date: '...', 'val1': 100, 'val2': 50 }]
    const grouped: Record<string, any> = {};
    for (const row of rows) {
      if (!grouped[row.date]) {
        grouped[row.date] = { date: row.date };
      }
      grouped[row.date][row.dimension_value || 'unknown'] = row.total_tokens;
    }

    return Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getRecentUsageLogs(limit: number = 15): any[] {
  const db = openUsageDb();
  if (!db) return [];
  try {
    return db
      .prepare('SELECT * FROM token_usage ORDER BY timestamp DESC LIMIT ?')
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
