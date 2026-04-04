---
name: add-heartbeat
description: Add heartbeat mechanism to monitor Agent TodoWrite todos and send reminders only when agent is idle.
---

# Add Heartbeat Mechanism (TodoWrite Monitor with Busy Detection)

监测 Agent TodoWrite 待办列表的心跳服务，**仅在 Agent 空闲时发送提醒**。

## 核心逻辑

```
检测到有待办 → 检查 Agent 状态 → 空闲？→ 发送提醒
                              → 忙碌？→ 跳过，不打扰
```

## Files to Create/Modify

### 1. src/services/heartbeat.ts

创建心跳服务文件：

```typescript
import { getAllRegisteredGroups } from '../db.js';
import { getGroupTodos } from '../web/data.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { GroupQueue } from '../group-queue.js';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface GroupState {
  reminderCount: number;
  pendingMessage?: { group: RegisteredGroup; message: string };
}

export class HeartbeatService {
  private intervalId: NodeJS.Timeout | null = null;
  private groupStates = new Map<string, GroupState>();

  start(): void {
    if (this.intervalId) return;
    logger.info('Starting heartbeat (interval: 30000ms)');
    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error({ err }, 'Error in heartbeat tick'),
      );
    }, 30000);
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

    for (const [, group] of Object.entries(allGroups)) {
      const todos = getGroupTodos(group.folder);
      const pendingTodos = todos.filter(
        (t) => t.status === 'pending' || t.status === 'in_progress',
      );

      if (pendingTodos.length === 0) continue;

      const status = queue.getGroupStatus(group.chat_jid);
      if (status?.active) {
        logger.debug({ groupFolder: group.folder }, 'Agent busy, skipping reminder');
        continue;
      }

      const state = this.getOrCreateState(group.folder);
      const count = state.reminderCount + 1;
      const todoList = pendingTodos.map((t) => `• ${t.content}`).join('\n');

      state.pendingMessage = {
        group,
        message: `💓 心跳提醒 #${count}：${group.name} 有待完成任务：\n\n${todoList}`,
      };
      state.reminderCount = count;
    }
  }

  private getOrCreateState(folder: string): GroupState {
    let state = this.groupStates.get(folder);
    if (!state) {
      state = { reminderCount: 0 };
      this.groupStates.set(folder, state);
    }
    return state;
  }

  async sendPendingReminders(
    sendMessage: (jid: string, text: string) => Promise<void>,
  ): Promise<void> {
    for (const state of this.groupStates.values()) {
      if (state.pendingMessage) {
        const { group, message } = state.pendingMessage;
        await sendMessage(group.folder, message);
        delete state.pendingMessage;
      }
    }
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
```

### 2. src/task-scheduler.ts 修改

```typescript
import { getHeartbeat } from './services/heartbeat.js';

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const heartbeat = getHeartbeat();
  heartbeat.start();

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      for (const task of dueTasks) {
        // ... existing task execution
      }

      await heartbeat.tick(deps.queue);
      await heartbeat.sendPendingReminders(deps.sendMessage);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }
    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };
  loop();
}
```

### 3. .nanoclaw/state.yaml

```yaml
applied_skills:
  - heartbeat
```

## 忙闲状态判断

| GroupQueue.active | 含义 | 发送提醒？ |
|-------------------|------|------------|
| `false` | Agent 空闲 | ✅ 发送 |
| `true` | Agent 正在处理任务 | ❌ 跳过 |

## 验证

```bash
npm run build
tail -f logs/nanoclaw.log | grep heartbeat
```

## 提醒示例

```
💓 心跳提醒 #1：家庭聊天 有待完成任务：

• 完成周报撰写
• 预订周末餐厅
```
