import { StatusBuilder } from './builder.js';

const DEBOUNCE_MS = 100;
let debounceTimer = null;
let pendingAgents = null;
let builder = null;

function scheduleDiskWrite(agentName) {
  if (agentName) {
    if (!pendingAgents) pendingAgents = new Set();
    pendingAgents.add(agentName);
  } else {
    pendingAgents = null;
  }

  if (debounceTimer) return;

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (pendingAgents === null) {
      builder.writeStatusFiles();
    } else {
      for (const name of pendingAgents) {
        builder.writeStatusFiles(name);
      }
    }
    pendingAgents = new Set();
  }, DEBOUNCE_MS);
}

export default function initStatusManager(api, config) {
  builder = new StatusBuilder(api);

  const triggerUpdate = () => scheduleDiskWrite();
  const triggerAgentUpdate = (payload) => scheduleDiskWrite(payload?.agentId);

  // System Events mapping
  api.on('system:startup', (payload) => {
    builder.handleStartup(payload);
    triggerUpdate();
  });
  api.on('task:execute', () => triggerUpdate());
  api.on('task:change', () => triggerUpdate());

  // Agent Events
  api.on('agent:container_start', (payload) => {
    builder.handleContainerStart(payload);
    triggerAgentUpdate(payload);
  });
  api.on('agent:container_stop', (payload) => {
    builder.handleContainerStop(payload);
    triggerAgentUpdate(payload);
  });
  api.on('agent:tool_use', (payload) => {
    builder.handleToolUse(payload);
    triggerAgentUpdate(payload);
  });
  api.on('agent:idle', (payload) => {
    builder.handleIdle(payload);
    triggerAgentUpdate(payload);
  });
  api.on('agent:sdk_task_status', (payload) => {
    builder.handleSdkTaskStatus(payload);
    triggerAgentUpdate(payload);
  });

  api.on('system:shutdown', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pendingAgents === null) {
      builder.writeStatusFiles();
    } else {
      for (const name of pendingAgents) {
        builder.writeStatusFiles(name);
      }
    }
  });

  api.logger.info(`Status manager initialized natively via events.`);
}
