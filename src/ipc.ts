import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  WORKSPACE_DIR,
} from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { handleXIpc } from './x-integration-host.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  storeMessage,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';

import { resolveAgentName } from './agents-config.js';
import { RegisteredGroup } from './types.js';
import { GatewayBus } from './gateway-bus/index.js';

export interface PendingBatchResult {
  success: boolean;
  pending: boolean;
  prompt?: string;
  systemContext?: string;
  consumedThroughTimestamp?: string;
  messageCount?: number;
  error?: string;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMedia: (
    jid: string,
    buffer: Buffer,
    mediaType: 'photo' | 'video' | 'audio' | 'document',
    caption?: string,
    fileName?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  getPendingBatch: (
    sourceGroup: string,
    consumedThroughTimestamp?: string,
  ) => Promise<PendingBatchResult>;
  recordVisibleOutput?: (sourceGroup: string) => void;
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    requestId?: string;
    prompt?: string | any[];
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    botToken?: string;
    assistantName?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<any> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          return {
            success: false,
            message: `Target group not registered: ${targetJid}`,
          };
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          return {
            success: false,
            message: 'Unauthorized: cannot schedule tasks for other groups',
          };
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            return {
              success: false,
              message: `Invalid cron expression: ${data.schedule_value}`,
            };
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            return {
              success: false,
              message: `Invalid interval: ${data.schedule_value}`,
            };
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            return {
              success: false,
              message: `Invalid timestamp: ${data.schedule_value}`,
            };
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'group';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt:
            typeof data.prompt === 'string'
              ? data.prompt
              : JSON.stringify(data.prompt),
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        GatewayBus.emitAsync('task:change', { taskId, status: 'created' });
        return { success: true, taskId };
      }
      return { success: false, message: 'Invalid schedule_task parameters' };

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          GatewayBus.emitAsync('task:change', {
            taskId: data.taskId,
            status: 'paused',
          });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via Gateway',
          );
          return {
            success: true,
            message: `Task ${data.taskId} paused successfully.`,
          };
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
          return {
            success: false,
            message: `Failed to pause task ${data.taskId}: unauthorized or not found.`,
          };
        }
      }
      return {
        success: false,
        message: 'Failed to pause task: missing task_id.',
      };

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          GatewayBus.emitAsync('task:change', {
            taskId: data.taskId,
            status: 'active',
          });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via Gateway',
          );
          return {
            success: true,
            message: `Task ${data.taskId} resumed successfully.`,
          };
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
          return {
            success: false,
            message: `Failed to resume task ${data.taskId}: unauthorized or not found.`,
          };
        }
      }
      return {
        success: false,
        message: 'Failed to resume task: missing task_id.',
      };

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          GatewayBus.emitAsync('task:change', {
            taskId: data.taskId,
            status: 'deleted',
          });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via Gateway',
          );
          return {
            success: true,
            message: `Task ${data.taskId} cancelled successfully.`,
          };
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
          return {
            success: false,
            message: `Failed to cancel task ${data.taskId}: unauthorized or not found.`,
          };
        }
      }
      return {
        success: false,
        message: 'Failed to cancel task: missing task_id.',
      };

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
        return { success: true };
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
        return {
          success: false,
          message: 'Unauthorized refresh_groups attempt',
        };
      }

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        return {
          success: false,
          message: 'Unauthorized: only main group can register groups',
        };
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          return {
            success: false,
            message: `Invalid folder name: ${data.folder}`,
          };
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          botToken: data.botToken,
          assistantName: data.assistantName,
        });
        return { success: true };
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
        return { success: false, message: 'Missing required fields' };
      }

    default: {
      const xResult = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
      if (xResult !== null) {
        return xResult;
      } else {
        logger.warn({ type: data.type }, 'Unknown IPC task type');
        return { success: false, message: 'Unknown IPC task type' };
      }
    }
  }
}
