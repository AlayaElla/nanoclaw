import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import { getHeartbeat } from './services/heartbeat.js';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getChatIsGroup,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
import { GatewayBus } from './gateway-bus/index.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    GatewayBus.emitAsync('task:change', {
      taskId: task.id,
      status: 'paused',
    }).catch(() => {});
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );
  GatewayBus.emitAsync('task:execute', {
    taskId: task.id,
    group: task.group_folder,
    scheduleType: task.schedule_type,
  }).catch(() => {});

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by agent)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  const allGroups = deps.registeredGroups();
  const agentFolders = Object.values(allGroups)
    .filter((g) => (g.botToken || '') === (group.botToken || ''))
    .map((g) => g.folder);
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt:
        typeof t.prompt === 'string' && t.prompt.trim().startsWith('[')
          ? (() => {
              try {
                return JSON.parse(t.prompt);
              } catch {
                return t.prompt;
              }
            })()
          : t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    agentFolders,
  );

  let parsedPrompt: string | any[] = task.prompt;
  if (typeof task.prompt === 'string' && task.prompt.trim().startsWith('[')) {
    try {
      parsedPrompt = JSON.parse(task.prompt);
    } catch {
      // Keep as string if parsing fails
    }
  }

  // ============================================
  // GROUP CONTEXT MODE: INJECT AS SYSTEM MESSAGE
  // ============================================
  if (task.context_mode === 'group') {
    logger.info(
      { taskId: task.id },
      'Injecting scheduled task prompt as message into normal flow',
    );

    // Parse the prompt so we can format it nicely
    const textualPrompt =
      typeof parsedPrompt === 'string'
        ? parsedPrompt
        : JSON.stringify(parsedPrompt);

    storeMessageDirect({
      id: `task_${task.id}_${Date.now()}`,
      chat_jid: task.chat_jid,
      sender: 'system',
      sender_name: 'Scheduled Task',
      content: `<scheduled-task>\n${textualPrompt}\n</scheduled-task>\n*(Please handle this background task using tools if necessary and proactively report back when done. If no tools are needed, reply directly.)*`,
      timestamp: new Date().toISOString(),
      is_from_me: true,
    });

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'success',
      result: 'Dispatched to main container context loop.',
      error: null,
    });

    const nextRun = computeNextRun(task);
    updateTaskAfterRun(task.id, nextRun, 'Dispatched to main container');
    return;
  }

  // ============================================
  // ISOLATED CONTEXT MODE: BACKGROUND WORKER
  // ============================================
  let result: string | null = null;
  let error: string | null = null;

  // After the task produces a result, close the container promptly.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const workerJid = `isolated_${task.id.replace(/-/g, '_')}`;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(workerJid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const isGroup =
      getChatIsGroup(task.chat_jid) ?? group.requiresTrigger !== false;

    // Use an isolated pseudo-folder so it doesn't clash with the main IPC input/status directories
    const workerFolder = `worker_${task.id.replace(/-/g, '_')}`;
    const workerGroup = { ...group, folder: workerFolder };

    const output = await runContainerAgent(
      workerGroup,
      {
        prompt: parsedPrompt,
        sessionId: undefined,
        groupFolder: workerFolder,
        chatJid: task.chat_jid,
        isMain,
        isGroup,
        isScheduledTask: true,
        taskId: task.id,
        assistantName: group.assistantName,
      },
      (proc, containerName) =>
        deps.onProcess(workerJid, proc, containerName, workerFolder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(workerJid);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const heartbeat = getHeartbeat();
  heartbeat.start();

  // Periodically dump tasks to current_tasks.json for containers to read via MCP get_scheduled_tasks
  setInterval(() => {
    try {
      const tasks = getAllTasks();
      const groups = deps.registeredGroups();
      const allTasksMapped = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt:
          typeof t.prompt === 'string' && t.prompt.trim().startsWith('[')
            ? (() => {
                try {
                  return JSON.parse(t.prompt);
                } catch {
                  return t.prompt;
                }
              })()
            : t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));

      for (const group of Object.values(groups)) {
        const isMain = group.isMain === true;
        const agentFolders = Object.values(groups)
          .filter((g) => (g.botToken || '') === (group.botToken || ''))
          .map((g) => g.folder);

        writeTasksSnapshot(group.folder, isMain, allTasksMapped, agentFolders);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to write scheduled tasks snapshots');
    }
  }, 5000);

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Pre-advance next_run (or mark once-tasks completed) in the DB
        // BEFORE dispatching. If the process crashes mid-execution,
        // updateTaskAfterRun() never runs — without this, the stale
        // next_run causes the task to fire again on restart.
        if (currentTask.schedule_type === 'once') {
          updateTask(currentTask.id, { status: 'completed' });
          GatewayBus.emitAsync('task:change', {
            taskId: currentTask.id,
            status: 'completed',
          }).catch(() => {});
        } else {
          const nextRun = computeNextRun(currentTask);
          if (nextRun) {
            updateTask(currentTask.id, { next_run: nextRun });
          }
        }

        if (currentTask.context_mode === 'group') {
          // Send group task prompt directly matching context, no preemptive close needed
          runTask(currentTask, deps).catch((err) =>
            logger.error(
              { taskId: currentTask.id, err },
              'Failed to run group task',
            ),
          );
        } else {
          // Isolated tasks use a synthetic JID to avoid stopping the main container
          const workerJid = `isolated_${currentTask.id.replace(/-/g, '_')}`;
          deps.queue.enqueueTask(workerJid, currentTask.id, () =>
            runTask(currentTask, deps),
          );
        }
      }

      await heartbeat.tick(deps.queue);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
