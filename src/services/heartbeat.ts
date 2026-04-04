import { getAllRegisteredGroups } from '../db.js';
import { logger } from '../logger.js';
import { GroupQueue } from '../group-queue.js';
import { HEARTBEAT_INTERVAL_MS } from '../config.js';

interface GroupState {
  lastHeartbeatTime: number;
}

export class HeartbeatService {
  private intervalId: NodeJS.Timeout | null = null;
  private groupStates = new Map<string, GroupState>();

  start(): void {
    if (this.intervalId) return;
    logger.info('Starting heartbeat service tied to scheduler loop');
    // We set intervalId just to mark as running for getStatus
    this.intervalId = setInterval(() => {}, 30000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Heartbeat stopped');
    }
  }

  async tick(queue: GroupQueue): Promise<void> {
    const allGroups = getAllRegisteredGroups();
    const now = Date.now();

    for (const [jid, group] of Object.entries(allGroups)) {
      const state = this.getOrCreateState(group.folder);

      // Enforce the configured interval per group
      if (now - state.lastHeartbeatTime < HEARTBEAT_INTERVAL_MS) {
        continue;
      }

      const status = queue.getGroupStatus(jid);

      // Inject heartbeat ONLY if container is alive and currently idling
      if (status && status.active && status.idleWaiting) {
        logger.debug(
          { groupFolder: group.folder },
          'Injecting background heartbeat prompt',
        );
        queue.sendMessage(
          jid,
          '【系统后台节拍】请检查当前状态与最近对话，思考是否有未完成的任务。如果有，请立刻使用工具处理或者提醒用户。如果没有，请仅回复唯一关键词 HEARTBEAT_SKIP ，绝不要带有任何其他字符或者前言后语。',
        );
        state.lastHeartbeatTime = now;
      }
    }
  }

  private getOrCreateState(folder: string): GroupState {
    let state = this.groupStates.get(folder);
    if (!state) {
      state = { lastHeartbeatTime: 0 };
      this.groupStates.set(folder, state);
    }
    return state;
  }

  resetGroup(folder: string): void {
    this.groupStates.delete(folder);
  }

  getStatus(): { running: boolean; trackedGroups: number } {
    return {
      running: this.intervalId !== null,
      trackedGroups: this.groupStates.size,
    };
  }
}

let heartbeatInstance: HeartbeatService | null = null;
export function getHeartbeat(): HeartbeatService {
  if (!heartbeatInstance) {
    heartbeatInstance = new HeartbeatService();
  }
  return heartbeatInstance;
}
