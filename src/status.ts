/**
 * Event-driven status manager.
 *
 * Each agent (bot from agents.yaml) gets its own status file under
 * `data/status/<agentName>.json`. Status is updated on every state-
 * changing event: container start/stop, tool use, task execution, etc.
 *
 * Also exposes `getFullStatus()` for the Gateway `GET /status` endpoint.
 */

import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  TIMEZONE,
} from './config.js';
import {
  getAllBotConfigs,
  resolveAgentName,
  type BotConfig,
} from './agents-config.js';
import { getAllTasks, getTasksForGroup } from './db.js';
import { type GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import type { Channel, RegisteredGroup } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────

export type StatusEventType =
  | 'startup'
  | 'shutdown'
  | 'container_start'
  | 'container_stop'
  | 'agent_idle'
  | 'tool_use'
  | 'task_execute'
  | 'task_change'
  | 'channel_connect'
  | 'channel_disconnect';

export interface StatusEvent {
  type: StatusEventType;
  agent?: string;
  group?: string;
  tool?: string;
  detail?: string;
  timestamp: string;
}

export interface AgentStatus {
  name: string;
  channel?: string;
  model?: string;
  groups: {
    jid: string;
    name: string;
    folder: string;
    isMain: boolean;
    container: {
      active: boolean;
      runningTaskId: string | null;
      containerName: string | null;
      startedAt: string | null;
    } | null;
    /** Current tool being used (from last tool_use event) */
    activeTool: string | null;
    /** Last status event for this group */
    lastEvent: StatusEvent | null;
    /** Scheduled tasks for this group */
    scheduledTasks: { id: string; prompt: string; status: string }[];
  }[];
}

export interface FullStatus {
  version: string;
  uptime: number;
  startedAt: string;
  updatedAt: string;
  channels: { name: string; connected: boolean }[];
  agents: AgentStatus[];
  tasks: { total: number; active: number; paused: number; completed: number };
  system: {
    maxConcurrentContainers: number;
    timezone: string;
    dataDir: string;
    containerImage: string;
    nodeVersion: string;
    platform: string;
    arch: string;
  };
}

// ─── Deps ───────────────────────────────────────────────────────────

export interface StatusDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  channels: Channel[];
  queue: GroupQueue;
}

// ─── StatusManager ──────────────────────────────────────────────────

const STATUS_DIR = path.join(DATA_DIR, 'status');
const startedAt = new Date().toISOString();

/** Track the active tool per group (jid → toolName) */
const activeTools = new Map<string, string>();

/** Last event per group (jid → event) */
const lastEvents = new Map<string, StatusEvent>();

let deps: StatusDeps | null = null;
let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion!;
}

/**
 * Resolve which agent (bot name) owns a given group.
 * Uses resolveAgentName which handles both TELEGRAM_BOT_TOKEN_N refs
 * and direct bot name refs (e.g. Feishu bots).
 */
function resolveAgentForGroup(group: RegisteredGroup): string {
  return resolveAgentName(group.botToken);
}

/**
 * Build status for a single agent.
 */
function buildAgentStatus(
  bot: BotConfig,
  groups: Record<string, RegisteredGroup>,
  queue: GroupQueue,
): AgentStatus {
  const agentGroups = Object.entries(groups)
    .filter(([_, g]) => resolveAgentForGroup(g) === bot.name)
    .map(([jid, g]) => {
      const containerStatus = queue.getGroupStatus(jid);
      const groupTasks = getTasksForGroup(g.folder);
      const tasks = groupTasks.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        status: t.status,
      }));
      return {
        jid,
        name: g.name,
        folder: g.folder,
        isMain: g.isMain === true,
        container: containerStatus
          ? {
              active: containerStatus.active,
              runningTaskId: containerStatus.runningTaskId,
              containerName: containerStatus.containerName,
              startedAt: containerStatus.startedAt,
            }
          : null,
        activeTool: activeTools.get(jid) || null,
        lastEvent: lastEvents.get(jid) || null,
        scheduledTasks: tasks,
      };
    });

  return {
    name: bot.name,
    channel: bot.channel,
    model: bot.model,
    groups: agentGroups,
  };
}

/**
 * Generate a full status snapshot (all agents).
 */
export function getFullStatus(): FullStatus | null {
  if (!deps) return null;

  const groups = deps.registeredGroups();
  const bots = getAllBotConfigs();
  const allTasks = getAllTasks();

  return {
    version: getVersion(),
    uptime: Math.round(process.uptime()),
    startedAt,
    updatedAt: new Date().toISOString(),
    channels: deps.channels.map((ch) => ({
      name: ch.name,
      connected: ch.isConnected(),
    })),
    agents: bots.map((bot) => buildAgentStatus(bot, groups, deps!.queue)),
    tasks: {
      total: allTasks.length,
      active: allTasks.filter((t) => t.status === 'active').length,
      paused: allTasks.filter((t) => t.status === 'paused').length,
      completed: allTasks.filter((t) => t.status === 'completed').length,
    },
    system: {
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
      timezone: TIMEZONE,
      dataDir: DATA_DIR,
      containerImage: CONTAINER_IMAGE,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

/**
 * Write a single agent's status file atomically.
 */
function writeAgentStatusFile(agentName: string, status: AgentStatus): void {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filePath = path.join(STATUS_DIR, `${agentName}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    logger.debug(
      { err, agent: agentName },
      'Failed to write agent status file',
    );
  }
}

/**
 * Write the host-level status file.
 */
function writeHostStatusFile(): void {
  if (!deps) return;
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const allTasks = getAllTasks();
    const host = {
      version: getVersion(),
      uptime: Math.round(process.uptime()),
      startedAt,
      updatedAt: new Date().toISOString(),
      channels: deps.channels.map((ch) => ({
        name: ch.name,
        connected: ch.isConnected(),
      })),
      tasks: {
        total: allTasks.length,
        active: allTasks.filter((t) => t.status === 'active').length,
        paused: allTasks.filter((t) => t.status === 'paused').length,
        completed: allTasks.filter((t) => t.status === 'completed').length,
      },
      system: {
        maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
        timezone: TIMEZONE,
        dataDir: DATA_DIR,
        containerImage: CONTAINER_IMAGE,
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    };
    const filePath = path.join(STATUS_DIR, 'host.json');
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(host, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    logger.debug({ err }, 'Failed to write host status file');
  }
}

/**
 * Write status files for all agents affected by an event.
 */
function writeStatusFiles(agentName?: string): void {
  if (!deps) return;

  const groups = deps.registeredGroups();
  const bots = getAllBotConfigs();

  // Always write host status
  writeHostStatusFile();

  if (agentName) {
    // Write only the affected agent
    const bot = bots.find((b) => b.name === agentName);
    if (bot) {
      const status = buildAgentStatus(bot, groups, deps.queue);
      writeAgentStatusFile(bot.name, status);
    }
  } else {
    // Write all agents (startup/shutdown)
    for (const bot of bots) {
      const status = buildAgentStatus(bot, groups, deps.queue);
      writeAgentStatusFile(bot.name, status);
    }
  }
}

// ─── Debounce ──────────────────────────────────────────────────────

const DEBOUNCE_MS = 100;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Agents that need a file write (null = all agents) */
let pendingAgents: Set<string> | null = null;

function scheduleDiskWrite(agentName?: string): void {
  if (agentName) {
    pendingAgents ??= new Set();
    pendingAgents.add(agentName);
  } else {
    // null means "write all agents"
    pendingAgents = null;
  }

  if (debounceTimer) return; // already scheduled

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (pendingAgents === null) {
      writeStatusFiles(); // all agents
    } else {
      for (const name of pendingAgents) {
        writeStatusFiles(name);
      }
    }
    pendingAgents = new Set();
  }, DEBOUNCE_MS);
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Initialize the status manager with dependencies.
 */
export function statusInit(d: StatusDeps): void {
  deps = d;
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  logger.info({ dir: STATUS_DIR }, 'Status manager initialized');
}

/**
 * Emit a status event and write updated status files.
 * Writes are debounced (100ms) so burst events (e.g. rapid tool calls)
 * coalesce into a single disk write. In-memory state updates immediately
 * so the HTTP `/status` endpoint always reflects the latest state.
 *
 * @param type - The event type
 * @param detail - Optional event context (agent name, group jid, tool name, etc.)
 */
export function statusEmit(
  type: StatusEventType,
  detail?: { agent?: string; group?: string; tool?: string; detail?: string },
): void {
  const event: StatusEvent = {
    type,
    ...detail,
    timestamp: new Date().toISOString(),
  };

  // Track active tools per group
  if (type === 'tool_use' && detail?.group && detail?.tool) {
    activeTools.set(detail.group, detail.tool);
  }
  if ((type === 'container_stop' || type === 'agent_idle') && detail?.group) {
    activeTools.delete(detail.group);
  }

  // Resolve agent name
  let agentName = detail?.agent;
  if (!agentName && detail?.group && deps) {
    const groups = deps.registeredGroups();
    const group = groups[detail.group];
    if (group) {
      agentName = resolveAgentForGroup(group);
    }
  }

  // Track last event per group
  if (detail?.group) {
    lastEvents.set(detail.group, event);
  }

  // Schedule debounced disk write
  scheduleDiskWrite(agentName);

  logger.debug({ event }, 'Status event emitted');
}

/**
 * Clean up: remove all status files.
 */
export function statusDestroy(): void {
  // Flush any pending debounced writes
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingAgents === null) {
    writeStatusFiles();
  } else if (pendingAgents.size > 0) {
    for (const name of pendingAgents) {
      writeStatusFiles(name);
    }
  }
  pendingAgents = new Set();

  deps = null;
  activeTools.clear();
  lastEvents.clear();

  try {
    if (fs.existsSync(STATUS_DIR)) {
      const files = fs
        .readdirSync(STATUS_DIR)
        .filter((f) => f.endsWith('.json'));
      for (const file of files) {
        fs.unlinkSync(path.join(STATUS_DIR, file));
      }
    }
  } catch {
    // ignore
  }
}
