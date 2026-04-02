import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { DATA_DIR, STORE_DIR, AGENTS_DIR } from '../config.js';

const LITELLM_DIR = join(process.cwd(), 'litellm');

/**
 * Read the latest TodoWrite todos from a group's Claude SDK session JSONL.
 * The SDK stores todos in the session history as toolUseResult.newTodos entries.
 */
export function getGroupTodos(
  groupFolder: string,
): { content: string; status: string; activeForm?: string }[] {
  const sessionsDir = join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  if (!existsSync(sessionsDir)) return [];
  try {
    // Find most recent JSONL session file
    const files = readdirSync(sessionsDir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => ({
        name: f,
        mtime: statSync(join(sessionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return [];

    const content = readFileSync(join(sessionsDir, files[0].name), 'utf-8');
    const lines = content.trim().split('\n');

    // Scan from end to find last TodoWrite result
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.toolUseResult?.newTodos) {
          return entry.toolUseResult.newTodos;
        }
      } catch {
        /* skip unparseable lines */
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function openUsageDb(): Database.Database | null {
  const p = join(STORE_DIR, 'usage.db');
  if (!existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true });
  } catch {
    return null;
  }
}

export function getUsageSummary(
  days: number,
  groupId?: string,
): {
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
    const sql =
      `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens, COUNT(*) as request_count FROM token_usage WHERE timestamp >= datetime('now', '-${days} days')` +
      (groupId ? ` AND group_id = ?` : ``);
    const row = (
      groupId ? db.prepare(sql).get(groupId) : db.prepare(sql).get()
    ) as any;
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
  groupId?: string,
): {
  name: string;
  total_tokens: number;
  request_count: number;
  original_task_name?: string;
}[] {
  const db = openUsageDb();
  if (!db) return [];
  try {
    const allowed = ['model', 'group_id', 'tool_name', 'task_id'];
    if (!allowed.includes(dimension)) return [];

    const sql = `SELECT ${dimension} as name, MAX(task_name) as original_task_name, SUM(total_tokens) as total_tokens, COUNT(*) as request_count 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') AND ${dimension} IS NOT NULL ${groupId ? 'AND group_id = ?' : ''}
         GROUP BY ${dimension} 
         ORDER BY total_tokens DESC LIMIT ?`;
    return (
      groupId ? db.prepare(sql).all(groupId, limit) : db.prepare(sql).all(limit)
    ) as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function fillTimelineGaps(
  data: any[],
  days: number,
  groupBy: 'hour' | 'day',
): any[] {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const expectedKeys: string[] = [];
  const now = new Date();

  if (groupBy === 'day') {
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() - i);
      expectedKeys.push(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      );
    }
  } else {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime());
      d.setHours(d.getHours() - i);
      expectedKeys.push(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`,
      );
    }
  }

  const dataMap = new Map();
  const allKeys = new Set<string>();
  for (const row of data) {
    dataMap.set(row.date, row);
    for (const k of Object.keys(row)) {
      allKeys.add(k);
    }
  }

  const filled = [];
  for (const key of expectedKeys) {
    if (dataMap.has(key)) {
      filled.push(dataMap.get(key));
    } else {
      const emptyRow: any = { date: key, total_tokens: 0 };
      for (const k of allKeys) {
        if (k !== 'date' && k !== 'total_tokens') {
          emptyRow[k] = 0;
        }
      }
      filled.push(emptyRow);
    }
  }
  return filled;
}

export function getUsageTimeline(
  days: number,
  groupBy: 'hour' | 'day' = 'day',
  groupId?: string,
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
    const sql = `SELECT strftime('${timeFormat}', timestamp, 'localtime') as date, 
                SUM(input_tokens) as input_tokens, 
                SUM(output_tokens) as output_tokens,
                SUM(total_tokens) as total_tokens 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') ${groupId ? 'AND group_id = ?' : ''}
         GROUP BY date 
         ORDER BY date ASC`;
    const rawData = (
      groupId ? db.prepare(sql).all(groupId) : db.prepare(sql).all()
    ) as any[];
    return fillTimelineGaps(rawData, days, groupBy);
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
  groupId?: string,
): { date: string; [key: string]: string | number }[] {
  const db = openUsageDb();
  if (!db) return [];
  const timeFormat = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

  if (dimension === 'total') {
    return getUsageTimeline(days, groupBy, groupId);
  }

  try {
    const allowed = ['model', 'group_id', 'tool_name', 'task_id'];
    if (!allowed.includes(dimension)) return [];

    const sql = `SELECT strftime('${timeFormat}', timestamp, 'localtime') as date, 
                ${dimension} as dimension_value,
                MAX(task_name) as original_task_name,
                SUM(total_tokens) as total_tokens 
         FROM token_usage 
         WHERE timestamp >= datetime('now', '-${days} days') AND ${dimension} IS NOT NULL ${groupId ? 'AND group_id = ?' : ''}
         GROUP BY date, dimension_value 
         ORDER BY date ASC`;
    const rows = (
      groupId ? db.prepare(sql).all(groupId) : db.prepare(sql).all()
    ) as any[];

    // Pivot rows into shape: [{ date: '...', 'val1': 100, 'val2': 50 }]
    const grouped: Record<string, any> = {};
    for (const row of rows) {
      if (!grouped[row.date]) {
        grouped[row.date] = { date: row.date };
      }
      const key =
        dimension === 'task_id' && row.original_task_name
          ? row.original_task_name
          : row.dimension_value || 'unknown';
      grouped[row.date][key] = row.total_tokens;
    }

    const rawData = Object.values(grouped).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    return fillTimelineGaps(rawData, days, groupBy);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function getUsageLogsCount(days: number, groupId?: string): number {
  const db = openUsageDb();
  if (!db) return 0;
  try {
    const sql =
      `SELECT COUNT(*) as count FROM token_usage WHERE timestamp >= datetime('now', '-${days} days') ` +
      (groupId ? 'AND group_id = ? ' : '');
    const row = (
      groupId ? db.prepare(sql).get(groupId) : db.prepare(sql).get()
    ) as any;
    return row?.count || 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

export function getUsageLogs(
  days: number,
  limit: number = 20,
  offset: number = 0,
  groupId?: string,
  sortCol: string = 'time',
  sortOrder: string = 'desc',
): any[] {
  const db = openUsageDb();
  if (!db) return [];
  try {
    const allowedSortCols: Record<string, string> = {
      time: 'timestamp',
      source: 'task_id',
      model: 'model',
      input: 'input_tokens',
      output: 'output_tokens',
      total: 'total_tokens',
    };
    const mappedSortCol = allowedSortCols[sortCol] || 'timestamp';
    const mappedOrder = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const sql =
      `SELECT * FROM token_usage WHERE timestamp >= datetime('now', '-${days} days') ` +
      (groupId ? 'AND group_id = ? ' : '') +
      `ORDER BY ${mappedSortCol} ${mappedOrder} LIMIT ? OFFSET ?`;
    return (
      groupId
        ? db.prepare(sql).all(groupId, limit, offset)
        : db.prepare(sql).all(limit, offset)
    ) as any[];
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

export function getTaskRunLogsForGroup(
  groupFolder: string,
  limit: number = 50,
): any[] {
  const dbPath = join(STORE_DIR, 'messages.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT l.* FROM task_run_logs l
         INNER JOIN scheduled_tasks t ON l.task_id = t.id
         WHERE t.group_folder = ?
         ORDER BY l.run_at DESC LIMIT ?`,
      )
      .all(groupFolder, limit) as any[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Read agent step-by-step execution trace from the Claude SDK session JSONL.
 * Extracts tool use entries to show what the agent did.
 */
export function getAgentSteps(
  groupFolder: string,
  limit: number = 30,
): {
  timestamp: string;
  tool: string;
  summary: string;
}[] {
  const sessionsDir = join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  if (!existsSync(sessionsDir)) return [];
  try {
    // Find most recent JSONL session file
    const files = readdirSync(sessionsDir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => ({
        name: f,
        mtime: statSync(join(sessionsDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return [];

    const content = readFileSync(join(sessionsDir, files[0].name), 'utf-8');
    const lines = content.trim().split('\n');

    const steps: { timestamp: string; tool: string; summary: string }[] = [];

    // Scan all lines for all relevant entries
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const ts = (entry.timestamp || '').slice(0, 19);
        const contentArr = entry.message?.content;

        if (entry.type === 'user') {
          // Plain text user message
          if (typeof contentArr === 'string') {
            steps.push({
              timestamp: ts,
              tool: '👤 User',
              summary: contentArr.replace(/\n/g, ' '),
            });
            continue;
          }
          if (Array.isArray(contentArr)) {
            for (const item of contentArr) {
              if (item.type === 'tool_result') {
                const resultText =
                  typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                      ? item.content
                          .map((c: any) =>
                            typeof c === 'string' ? c : c.text || '',
                          )
                          .join(' ')
                      : '';
                steps.push({
                  timestamp: ts,
                  tool: '📥 Result',
                  summary: resultText.replace(/\n/g, ' '),
                });
              } else if (typeof item === 'object' && item.type === 'text') {
                steps.push({
                  timestamp: ts,
                  tool: '👤 User',
                  summary: (item.text || '').replace(/\n/g, ' '),
                });
              }
            }
          }
          continue;
        }

        if (entry.type !== 'assistant') continue;
        if (!Array.isArray(contentArr)) continue;

        for (const item of contentArr) {
          if (item.type === 'thinking' && item.thinking) {
            steps.push({
              timestamp: ts,
              tool: '💭 Think',
              summary: (item.thinking as string).replace(/\n/g, ' '),
            });
            continue;
          }
          if (item.type === 'text' && item.text) {
            steps.push({
              timestamp: ts,
              tool: '💬 Text',
              summary: (item.text as string).replace(/\n/g, ' '),
            });
            continue;
          }
          if (item.type !== 'tool_use') continue;
          const inp = item.input || {};
          let summary = '';
          switch (item.name) {
            case 'Bash':
              summary = (inp.command || '').slice(0, 60);
              break;
            case 'Read':
              summary = inp.file_path || '';
              break;
            case 'Write':
              summary = inp.file_path || '';
              break;
            case 'Edit':
              summary = inp.file_path || '';
              break;
            case 'Grep':
            case 'Glob':
              summary = inp.pattern || inp.glob || '';
              break;
            case 'TodoWrite':
              summary = `${(inp.todos || []).length} items`;
              break;
            case 'Task':
              summary = (inp.prompt || '').slice(0, 60);
              break;
            default:
              const vals = Object.values(inp).filter(
                (v): v is string => typeof v === 'string',
              );
              summary = (vals[0] || '').slice(0, 60);
          }
          steps.push({ timestamp: ts, tool: item.name, summary });
        }
      } catch {
        /* skip */
      }
    }

    // Return last N steps (most recent)
    return steps.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function getAgentStatusFiles(): any[] {
  const statusDir = join(DATA_DIR, 'status');
  const botsConfig = getAgentsConfig();

  // Build a map of existing status files
  const statusMap = new Map<string, any>();
  if (existsSync(statusDir)) {
    for (const f of readdirSync(statusDir)) {
      if (!f.endsWith('.json') || f === 'host.json') continue;
      try {
        const data = JSON.parse(readFileSync(join(statusDir, f), 'utf-8'));
        if (data.name) statusMap.set(data.name, data);
      } catch {
        /* skip */
      }
    }
  }

  // Merge: use agents.yaml as primary list, overlay status data
  const result: any[] = [];
  for (const bot of botsConfig) {
    if (statusMap.has(bot.name)) {
      result.push(statusMap.get(bot.name));
      statusMap.delete(bot.name);
    } else {
      // Agent exists in config but has no status file yet
      result.push({
        name: bot.name,
        channel: bot.channel || 'telegram',
        model: bot.model || 'unknown',
        groups: [],
      });
    }
  }

  // Append any status files not in agents.yaml (edge case)
  for (const entry of statusMap.values()) {
    result.push(entry);
  }

  return result;
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

import { stringify as stringifyYaml } from 'yaml';

export function saveAgentsConfig(bots: any[]): boolean {
  const p = join(AGENTS_DIR, 'agents.yaml');
  try {
    if (!existsSync(AGENTS_DIR)) {
      mkdirSync(AGENTS_DIR, { recursive: true });
    }
    const yamlString = stringifyYaml({ bots });
    writeFileSync(p, yamlString, 'utf-8');
    return true;
  } catch (err) {
    return false;
  }
}

export function addAgentConfig(bot: any): boolean {
  const config = getAgentsConfig();
  // Check if agent with same name exists
  if (config.some((b) => b.name === bot.name)) return false;
  config.push(bot);
  return saveAgentsConfig(config);
}

export function updateAgentConfig(bot: any): boolean {
  const config = getAgentsConfig();
  const idx = config.findIndex((b) => b.name === bot.name);
  if (idx === -1) return false;
  config[idx] = { ...config[idx], ...bot };
  return saveAgentsConfig(config);
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
    if (depth >= maxDepth || entries.length >= 2000) return; // Increased limit for larger trees
    try {
      for (const item of readdirSync(dir)) {
        if (
          item === 'node_modules' ||
          item === '__pycache__' ||
          item === '.git'
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

/**
 * Read a file from the agent's config directory (agents/<name>/main/<file>).
 */
export function readAgentFile(
  agentName: string,
  filePath: string,
  context: 'main' | 'group' = 'main',
): string | null {
  if (filePath.includes('..')) return null;
  const full = join(AGENTS_DIR, agentName, context, filePath);
  if (!existsSync(full)) return null;
  try {
    const st = statSync(full);
    if (st.isDirectory() || st.size > 1024 * 1024) return null;
    return readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

export function getWorkspaceFilePath(
  agentName: string,
  filePath: string,
): string | null {
  if (filePath.includes('..')) return null;
  const wsDir = join(DATA_DIR, 'workspace', agentName);
  if (!existsSync(wsDir)) return null;
  const full = join(wsDir, filePath);
  // Security check: ensure the resolved path indeed starts with wsDir
  if (!full.startsWith(wsDir)) return null;
  return full;
}

export function readWorkspaceFile(
  agentName: string,
  filePath: string,
): string | null {
  const full = getWorkspaceFilePath(agentName, filePath);
  if (!full || !existsSync(full)) return null;
  try {
    const st = statSync(full);
    if (st.isDirectory() || st.size > 1024 * 1024 * 5) return null; // Increased limit to 5MB for viewing
    return readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

import { mkdirSync, writeFileSync, rmSync, renameSync, cpSync } from 'node:fs';
import { dirname, basename } from 'node:path';

export function writeWorkspaceTextFile(
  agentName: string,
  filePath: string,
  content: string,
): boolean {
  const full = getWorkspaceFilePath(agentName, filePath);
  if (!full) return false;
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function writeWorkspaceBase64File(
  agentName: string,
  filePath: string,
  base64Content: string,
): boolean {
  const full = getWorkspaceFilePath(agentName, filePath);
  if (!full) return false;
  try {
    mkdirSync(dirname(full), { recursive: true });
    // Remove data URL prefix if present (e.g., "data:image/png;base64,...")
    const base64Data = base64Content.replace(/^data:.*?;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    writeFileSync(full, buffer);
    return true;
  } catch {
    return false;
  }
}

export function deleteWorkspaceFile(
  agentName: string,
  filePath: string,
): boolean {
  const full = getWorkspaceFilePath(agentName, filePath);
  if (!full || !existsSync(full)) return false;
  try {
    rmSync(full, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function renameWorkspaceFile(
  agentName: string,
  oldPath: string,
  newPath: string,
): boolean {
  const fullOld = getWorkspaceFilePath(agentName, oldPath);
  const fullNew = getWorkspaceFilePath(agentName, newPath);
  if (!fullOld || !fullNew || !existsSync(fullOld)) return false;
  try {
    mkdirSync(dirname(fullNew), { recursive: true });
    renameSync(fullOld, fullNew);
    return true;
  } catch {
    return false;
  }
}

export function copyWorkspacePath(
  sourceAgent: string,
  sourcePath: string,
  targetAgent: string,
  targetPath: string,
): boolean {
  const fullSrc = getWorkspaceFilePath(sourceAgent, sourcePath);
  const fullTgt = getWorkspaceFilePath(targetAgent, targetPath);
  if (!fullSrc || !fullTgt || !existsSync(fullSrc)) return false;
  try {
    const ext = extname(fullTgt);
    const base = basename(fullTgt, ext);
    const dir = dirname(fullTgt);

    let counter = 1;
    let currentTgt: string = fullTgt;
    // Auto-rename if target exists or if we are copying to the exact same path
    while (
      existsSync(currentTgt) ||
      (counter === 1 && fullSrc === currentTgt)
    ) {
      currentTgt = join(dir, `${base} (${counter})${ext}`);
      counter++;
    }
    mkdirSync(dirname(currentTgt), { recursive: true });
    cpSync(fullSrc, currentTgt, { recursive: true, force: false });
    return true;
  } catch (e) {
    return false;
  }
}

export function moveWorkspacePath(
  sourceAgent: string,
  sourcePath: string,
  targetAgent: string,
  targetPath: string,
): boolean {
  const fullSrc = getWorkspaceFilePath(sourceAgent, sourcePath);
  const fullTgt = getWorkspaceFilePath(targetAgent, targetPath);
  if (!fullSrc || !fullTgt || !existsSync(fullSrc)) return false;

  if (fullSrc === fullTgt) return true; // No-op if moved to same place
  if (existsSync(fullTgt)) return false; // Don't overwrite existing implicitly

  // Custom move routine since rename WorkspaceFile only handles same agent
  try {
    mkdirSync(dirname(fullTgt), { recursive: true });
    renameSync(fullSrc, fullTgt);
    return true;
  } catch (e) {
    return false;
  }
}

export function createWorkspaceDir(
  agentName: string,
  dirPath: string,
): boolean {
  const full = getWorkspaceFilePath(agentName, dirPath);
  if (!full) return false;
  try {
    mkdirSync(full, { recursive: true });
    return true;
  } catch {
    return false;
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
