import fs from 'fs';
import path from 'path';

// Define the API interface for the plugin context (matching NanoClawGatewayApi)
interface StatusManagerApi {
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    debug(msg: string): void;
    error(msg: string, err?: any): void;
  };
  on(event: string, cb: (payload: any) => void): void;
  registerHook(hook: string, cb: any): void;
  getSystemStatus(): any;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const STATUS_DIR = path.join(DATA_DIR, 'status');

function writeAgentStatusFile(agentName: string, status: any, api: StatusManagerApi): void {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filePath = path.join(STATUS_DIR, `${agentName}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    api.logger.error(`Failed to write agent status file for ${agentName}`, err);
  }
}

function writeHostStatusFile(hostStatus: any, api: StatusManagerApi): void {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const filePath = path.join(STATUS_DIR, 'host.json');
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(hostStatus, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    api.logger.error('Failed to write host status file', err);
  }
}

function writeStatusFiles(api: StatusManagerApi, agentName?: string): void {
  const fullStatus = api.getSystemStatus();
  if (!fullStatus) return;

  // Extract host status fields
  const hostStatus = {
    version: fullStatus.version,
    uptime: fullStatus.uptime,
    startedAt: fullStatus.startedAt,
    updatedAt: fullStatus.updatedAt,
    channels: fullStatus.channels,
    tasks: fullStatus.tasks,
    system: fullStatus.system,
  };
  writeHostStatusFile(hostStatus, api);

  // Write agent statuses
  if (agentName) {
    const agentData = (fullStatus.agents || []).find((a: any) => a.name === agentName);
    if (agentData) {
      writeAgentStatusFile(agentData.name, agentData, api);
    }
  } else {
    for (const agent of (fullStatus.agents || [])) {
      writeAgentStatusFile(agent.name, agent, api);
    }
  }
}

const DEBOUNCE_MS = 100;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAgents: Set<string> | null = null;

function scheduleDiskWrite(api: StatusManagerApi, agentName?: string): void {
  if (agentName) {
    pendingAgents ??= new Set();
    pendingAgents.add(agentName);
  } else {
    pendingAgents = null;
  }

  if (debounceTimer) return;

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (pendingAgents === null) {
      writeStatusFiles(api);
    } else {
      for (const name of pendingAgents) {
        writeStatusFiles(api, name);
      }
    }
    pendingAgents = new Set();
  }, DEBOUNCE_MS);
}

export default function initStatusManager(api: StatusManagerApi, config: any) {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  api.logger.info(`Status manager initialized at ${STATUS_DIR}`);

  // Schedule disk writes on state changes
  const triggerUpdate = () => scheduleDiskWrite(api);
  const triggerAgentUpdate = (payload: any) => {
    // If the event provides enough info to figure out the agent, we can scope the write.
    // However, since we don't import core, we rely on the host adding agentId to events
    // or just trigger a global write.
    scheduleDiskWrite(api, payload?.agentId);
  };

  // System Events mapping
  api.on('system:startup', triggerUpdate);
  api.on('task:execute', triggerUpdate);
  api.on('task:change', triggerUpdate);
  
  // Agent Events
  api.on('agent:container_start', triggerAgentUpdate);
  api.on('agent:container_stop', triggerAgentUpdate);
  api.on('agent:tool_use', triggerAgentUpdate);
  api.on('agent:idle', triggerAgentUpdate);
  api.on('agent:sdk_task_status', triggerAgentUpdate);

  api.on('system:shutdown', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pendingAgents === null) {
      writeStatusFiles(api);
    } else {
      for (const name of pendingAgents) {
        writeStatusFiles(api, name);
      }
    }
  });
}
