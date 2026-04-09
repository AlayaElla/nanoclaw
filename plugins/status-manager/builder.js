import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const STATUS_DIR = path.join(DATA_DIR, 'status');

export class StatusBuilder {
  constructor(api) {
    this.api = api;
    this.state = {
      version: '1.2.1',
      uptime: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      channels: [],
      tasks: { total: 0, active: 0, paused: 0, completed: 0 },
      system: {},
      bots: [],
      groups: {},
      activeTools: new Map(),
      lastEvents: new Map(),
      sdkTasksMap: new Map(),
      containers: new Map()
    };
  }

  handleStartup(payload) {
    this.state.system = payload.system || {};
    this.state.system.maxConcurrentContainers = payload.config?.maxConcurrentContainers || 5;
    this.state.system.timezone = payload.config?.timezone || 'Asia/Shanghai';
    this.state.system.dataDir = payload.config?.dataDir || DATA_DIR;
    this.state.system.containerImage = payload.config?.containerImage || 'nanoclaw-agent:latest';

    this.state.bots = payload.bots || [];
    this.state.groups = payload.groups || {};
    
    // Convert array to object mapping
    this.state.channels = payload.channels || [];
    
    // Tasks processing
    const allTasks = payload.tasks || [];
    this.state.tasks = {
      total: allTasks.length,
      active: allTasks.filter(t => t.status === 'active').length,
      paused: allTasks.filter(t => t.status === 'paused').length,
      completed: allTasks.filter(t => t.status === 'completed').length,
    };
  }

  handleToolUse(payload) {
    if (payload.group && payload.tool) {
      this.state.activeTools.set(payload.group, payload.tool);
    }
    if (payload.group) {
      this.state.lastEvents.set(payload.group, {
        type: 'tool_use',
        tool: payload.tool,
        timestamp: new Date().toISOString(),
      });
    }
  }

  handleIdle(payload) {
    if (payload.group) {
      this.state.activeTools.delete(payload.group);
      this.state.lastEvents.set(payload.group, {
        type: 'agent_idle',
        status: payload.status,
        timestamp: new Date().toISOString(),
      });
    }
  }

  handleContainerStart(payload) {
    if (payload.group) {
      this.state.containers.set(payload.group, {
        active: true,
        containerName: payload.containerName,
        startedAt: new Date().toISOString()
      });
      this.state.lastEvents.set(payload.group, {
        type: 'container_start',
        timestamp: new Date().toISOString(),
      });
    }
  }

  handleContainerStop(payload) {
    if (payload.group) {
      this.state.containers.delete(payload.group);
      this.state.activeTools.delete(payload.group);
      this.state.sdkTasksMap.delete(payload.group);
      this.state.lastEvents.set(payload.group, {
        type: 'container_stop',
        timestamp: new Date().toISOString(),
      });
    }
  }

  handleSdkTaskStatus(payload) {
    if (payload.group && payload.detail) {
      try {
        const taskInfo = JSON.parse(payload.detail);
        let groupTasks = this.state.sdkTasksMap.get(payload.group);
        if (!groupTasks) {
          groupTasks = new Map();
          this.state.sdkTasksMap.set(payload.group, groupTasks);
        }
        groupTasks.set(taskInfo.task_id, taskInfo);
        if (taskInfo.status === 'completed' || taskInfo.status === 'stopped') {
          setTimeout(() => {
            if (groupTasks && groupTasks.has(taskInfo.task_id)) {
              groupTasks.delete(taskInfo.task_id);
              if (groupTasks.size === 0) this.state.sdkTasksMap.delete(payload.group);
            }
          }, 30000);
        }
      } catch (err) {
        // ignore
      }
    }
  }

  getFullStatus() {
    this.state.uptime = Math.round(process.uptime());
    this.state.updatedAt = new Date().toISOString();

    const assignedGroupJids = new Set();

    const resolveAgentForGroup = (group) => {
      const botRef = group.botToken;
      if (botRef) {
        let matchingBot = this.state.bots.find(b => b.id === botRef || b.name === botRef);
        if (!matchingBot) {
          const match = botRef.match(/TELEGRAM_BOT_TOKEN_(\d+)$/);
          if (match) {
            const index = parseInt(match[1], 10) - 1;
            matchingBot = this.state.bots[index];
          }
        }
        if (matchingBot) return matchingBot.name;
      }
      return null; // Don't fallback to bots[0]!
    };

    const agents = this.state.bots.map(bot => {
      const agentGroups = Object.entries(this.state.groups)
        .filter(([_, g]) => resolveAgentForGroup(g) === bot.name)
        .map(([jid, g]) => {
          assignedGroupJids.add(jid);
          return {
            jid,
            name: g.name,
            folder: g.folder,
            status: this.state.containers.has(jid) ? 'running' : 'idle',
            isMain: g.isMain === true,
            container: this.state.containers.get(jid) || null,
            activeTool: this.state.activeTools.get(jid) || null,
            lastEvent: this.state.lastEvents.get(jid) || null,
            scheduledTasks: [],
            sdkTasks: Array.from((this.state.sdkTasksMap.get(jid) || new Map()).values()),
          };
        });

      return {
        name: bot.name,
        channel: bot.channel,
        model: bot.model,
        groups: agentGroups,
      };
    });

    // Handle orphaned groups (e.g. from commented-out configs or dynamic channels)
    const orphanedGroups = Object.entries(this.state.groups).filter(([jid]) => !assignedGroupJids.has(jid));
    const channelOrphans = new Map();

    for (const [jid, g] of orphanedGroups) {
      // Determine channel from JID (e.g. oc_xxxx@feishu -> feishu)
      const parts = jid.split('@');
      const channelLabel = parts.length > 1 ? parts.pop() : 'unknown';
      if (!channelOrphans.has(channelLabel)) channelOrphans.set(channelLabel, []);

      channelOrphans.get(channelLabel).push({
        jid,
        name: g.name,
        folder: g.folder,
        status: this.state.containers.has(jid) ? 'running' : 'idle',
        isMain: g.isMain === true,
        container: this.state.containers.get(jid) || null,
        activeTool: this.state.activeTools.get(jid) || null,
        lastEvent: this.state.lastEvents.get(jid) || null,
        scheduledTasks: [],
        sdkTasks: Array.from((this.state.sdkTasksMap.get(jid) || new Map()).values()),
      });
    }

    for (const [channel, groups] of channelOrphans.entries()) {
      agents.push({
        name: `orphaned_${channel}`,
        channel: channel,
        model: 'unknown',
        groups: groups
      });
    }

    return {
      version: this.state.version,
      uptime: this.state.uptime,
      startedAt: this.state.startedAt,
      updatedAt: this.state.updatedAt,
      channels: this.state.channels,
      tasks: this.state.tasks,
      system: this.state.system,
      agents,
    };
  }

  writeAgentStatusFile(agentName, status) {
    try {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      const filePath = path.join(STATUS_DIR, `${agentName}.json`);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      this.api.logger.error(`Failed to write agent status file for ${agentName}`, err);
    }
  }

  writeHostStatusFile(hostStatus) {
    try {
      fs.mkdirSync(STATUS_DIR, { recursive: true });
      const filePath = path.join(STATUS_DIR, 'host.json');
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(hostStatus, null, 2));
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      this.api.logger.error('Failed to write host status file', err);
    }
  }

  writeStatusFiles(agentName) {
    const fullStatus = this.getFullStatus();
    if (!fullStatus) return;

    this.writeHostStatusFile({
      version: fullStatus.version,
      uptime: fullStatus.uptime,
      startedAt: fullStatus.startedAt,
      updatedAt: fullStatus.updatedAt,
      channels: fullStatus.channels,
      tasks: fullStatus.tasks,
      system: fullStatus.system,
    });

    if (agentName) {
      const agentData = (fullStatus.agents || []).find(a => a.name === agentName);
      if (agentData) this.writeAgentStatusFile(agentData.name, agentData);
    } else {
      for (const agent of (fullStatus.agents || [])) {
        this.writeAgentStatusFile(agent.name, agent);
      }
    }
  }
}
