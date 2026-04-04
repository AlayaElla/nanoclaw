import { getAllRegisteredGroups } from '../db.js';
import { logger } from '../logger.js';
import { GroupQueue } from '../group-queue.js';
import { HEARTBEAT_INTERVAL } from '../config.js';
import { getGroupTodos } from '../web/data.js';

interface GroupState {
  lastHeartbeatTime: number;
}

export class HeartbeatService {
  private intervalId: NodeJS.Timeout | null = null;
  private groupStates = new Map<string, GroupState>();
  /** Groups currently processing a heartbeat — prevents re-firing before agent responds */
  private processingGroups = new Set<string>();

  start(): void {
    if (this.intervalId) return;
    logger.info(
      {
        intervalMs: HEARTBEAT_INTERVAL,
        intervalMin: (HEARTBEAT_INTERVAL / 60000).toFixed(1),
      },
      'Starting heartbeat service',
    );
    // We set intervalId just to mark as running for getStatus
    this.intervalId = setInterval(() => {}, HEARTBEAT_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Heartbeat stopped');
    }
  }

  /**
   * Called by the scheduler loop every SCHEDULER_POLL_INTERVAL (60s).
   * Guards:
   * 1. Per-group interval gate (HEARTBEAT_INTERVAL from .env)
   * 2. processingGroups prevents re-firing while agent handles previous heartbeat
   * 3. Container must be active
   * 4. Agent must be idle — if busy, skip but reset interval
   * 5. Must have unfinished todos
   */
  async tick(queue: GroupQueue): Promise<void> {
    const allGroups = getAllRegisteredGroups();
    const now = Date.now();

    for (const [jid, group] of Object.entries(allGroups)) {
      const state = this.getOrCreateState(group.folder);

      // Gate 1: Enforce configured interval per group
      if (now - state.lastHeartbeatTime < HEARTBEAT_INTERVAL) {
        continue;
      }

      // Gate 2: Skip groups still processing a previous heartbeat
      if (this.processingGroups.has(group.folder)) {
        logger.debug(
          { groupFolder: group.folder },
          'Heartbeat skipped: agent still processing previous heartbeat',
        );
        continue;
      }

      const status = queue.getGroupStatus(jid);

      // Gate 3: Container must be alive
      if (!status || !status.active) {
        continue; // No container running
      }

      // Gate 4: Agent must be idle — if busy, skip and reset interval
      if (!status.idleWaiting) {
        state.lastHeartbeatTime = now; // Reset! Wait for next full interval
        logger.debug(
          { groupFolder: group.folder },
          'Heartbeat skipped: agent is busy, interval reset',
        );
        continue;
      }

      // Gate 5: Only fire if there are unfinished todos
      const todos = getGroupTodos(group.folder);
      const hasUnfinishedTodos = todos.some((t) => t.status !== 'completed');

      if (hasUnfinishedTodos) {
        state.lastHeartbeatTime = now;
        logger.debug(
          { groupFolder: group.folder, unfinishedTodos: todos.length },
          'Injecting background heartbeat prompt',
        );
        this.processingGroups.add(group.folder);
        queue.sendMessage(
          jid,
          '<system-reminder>\n[HEARTBEAT]请检查当前状态与最近对话，思考是否有未完成的任务。如果有，请立刻使用工具处理或者提醒用户。如果没有，请取消todolist，然后仅回复唯一关键词 HEARTBEAT_SKIP ，绝不要带有任何其他字符或者前言后语。\n</system-reminder>',
        );
      }
    }
  }

  /**
   * Called when agent finishes processing a heartbeat response.
   * Clears the processing lock so the next heartbeat can fire after the interval.
   */
  markHeartbeatProcessed(folder: string): void {
    this.processingGroups.delete(folder);
  }

  /**
   * Check if a heartbeat is currently in-flight for a group.
   * Used by the host to determine if output came from a heartbeat query.
   */
  isHeartbeatInFlight(folder: string): boolean {
    return this.processingGroups.has(folder);
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
    this.processingGroups.delete(folder);
  }

  getStatus(): {
    running: boolean;
    trackedGroups: number;
    processingCount: number;
  } {
    return {
      running: this.intervalId !== null,
      trackedGroups: this.groupStates.size,
      processingCount: this.processingGroups.size,
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
