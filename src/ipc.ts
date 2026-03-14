import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE, WORKSPACE_DIR } from './config.js';
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
import { searchMemory, isRagEnabled } from './rag.js';
import { resolveAgentName } from './agents-config.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendMedia: (
    jid: string,
    buffer: Buffer,
    mediaType: 'photo' | 'video' | 'audio' | 'document',
    caption?: string,
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
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Authorization: verify this group can send to this chatJid
              const targetGroup = data.chatJid
                ? registeredGroups[data.chatJid]
                : undefined;
              const authorized =
                data.chatJid &&
                (isMain || (targetGroup && targetGroup.folder === sourceGroup));

              if (data.type === 'message' && data.chatJid && data.text) {
                if (authorized) {
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    const chatNumericId = data.chatJid
                      .replace(/^tg:/, '')
                      .replace(/@.*$/, '');
                    const isPrivate = !chatNumericId.startsWith('-');

                    if (isPrivate) {
                      // Private chat: use main bot with sender prefix
                      await deps.sendMessage(
                        data.chatJid,
                        `*${data.sender}*:\n${data.text}`,
                      );
                    } else {
                      // Group chat: try pool bot, fallback to main bot
                      const sent = await sendPoolMessage(
                        data.chatJid,
                        data.text,
                        data.sender,
                        sourceGroup,
                      );
                      if (!sent) {
                        await deps.sendMessage(
                          data.chatJid,
                          `*${data.sender}*:\n${data.text}`,
                        );
                        logger.info(
                          { chatJid: data.chatJid, sender: data.sender },
                          'Pool message failed, sent via main bot fallback',
                        );
                      }
                    }
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'media_message' &&
                data.chatJid &&
                data.mediaId
              ) {
                if (authorized) {
                  const mediaType = data.mediaType || 'document';
                  // Resolve media file from the agent's shared media_cache on the host
                  const safeId = path.basename(data.mediaId);
                  const sourceGroupEntry = Object.values(registeredGroups).find(g => g.folder === sourceGroup);
                  const mediaAgentName = resolveAgentName(sourceGroupEntry?.botToken);
                  const mediaPath = path.join(
                    WORKSPACE_DIR,
                    mediaAgentName,
                    '.claude',
                    'media_cache',
                    safeId,
                  );
                  try {
                    const buffer = fs.readFileSync(mediaPath);
                    await deps.sendMedia(
                      data.chatJid,
                      buffer,
                      mediaType,
                      data.caption,
                    );
                    // Store outbound media message in DB (mirrors inbound format)
                    const labelMap: Record<string, string> = {
                      photo: 'Photo',
                      video: 'Video',
                      audio: 'Audio',
                      document: 'Document',
                    };
                    const label = labelMap[mediaType] || 'File';
                    const captionPart = data.caption
                      ? ` | Caption: ${data.caption}`
                      : '';
                    storeMessage({
                      id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      chat_jid: data.chatJid,
                      sender: 'bot',
                      sender_name: 'Assistant',
                      content: `[Sent ${label}${captionPart} | MediaID: ${safeId}]`,
                      timestamp: new Date().toISOString(),
                      is_from_me: true,
                    });
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        mediaType,
                        mediaId: safeId,
                      },
                      'IPC media message sent',
                    );
                  } catch (readErr) {
                    logger.error(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        mediaId: safeId,
                        err: readErr,
                      },
                      'Failed to read media file for IPC media_message',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC media_message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

function writeTaskResult(
  sourceGroup: string,
  requestId: string,
  success: boolean,
  message: string,
) {
  if (!requestId) return;
  const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'task_results');
  fs.mkdirSync(resultDir, { recursive: true });
  const resultPath = path.join(resultDir, `${requestId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ success, message, requestId }));
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
): Promise<void> {
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
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
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
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
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
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              true,
              `Task ${data.taskId} paused successfully.`,
            );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              false,
              `Failed to pause task ${data.taskId}: unauthorized or not found.`,
            );
        }
      } else if (data.requestId) {
        writeTaskResult(
          sourceGroup,
          data.requestId,
          false,
          `Failed to pause task: missing task_id.`,
        );
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              true,
              `Task ${data.taskId} resumed successfully.`,
            );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              false,
              `Failed to resume task ${data.taskId}: unauthorized or not found.`,
            );
        }
      } else if (data.requestId) {
        writeTaskResult(
          sourceGroup,
          data.requestId,
          false,
          `Failed to resume task: missing task_id.`,
        );
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              true,
              `Task ${data.taskId} cancelled successfully.`,
            );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
          if (data.requestId)
            writeTaskResult(
              sourceGroup,
              data.requestId,
              false,
              `Failed to cancel task ${data.taskId}: unauthorized or not found.`,
            );
        }
      } else if (data.requestId) {
        writeTaskResult(
          sourceGroup,
          data.requestId,
          false,
          `Failed to cancel task: missing task_id.`,
        );
      }
      break;

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
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
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
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'rag_search': {
      // RAG search: agent writes request, host writes result file back
      if (!isRagEnabled()) {
        logger.debug('RAG search requested but RAG is disabled');
        break;
      }
      const ragQuery = (data as any).query as string;
      const ragRequestId = (data as any).requestId as string;
      const ragTopK = ((data as any).topK as number) || 5;
      if (!ragQuery || !ragRequestId) {
        logger.warn({ data }, 'Invalid rag_search request');
        break;
      }
      try {
        // Resolve agent name for per-agent RAG table
        const ragGroup = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const ragAgentName = resolveAgentName(ragGroup?.botToken);
        const results = await searchMemory(ragAgentName, ragQuery, ragTopK);
        // Write result file for the agent to read
        const resultDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'rag_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        const resultPath = path.join(resultDir, `${ragRequestId}.json`);
        fs.writeFileSync(
          resultPath,
          JSON.stringify({ results, requestId: ragRequestId }),
        );
        logger.info(
          {
            sourceGroup,
            query: ragQuery.slice(0, 50),
            results: results.length,
          },
          'RAG search completed via IPC',
        );
      } catch (err) {
        logger.error(
          { err, sourceGroup, ragQuery },
          'RAG search failed via IPC',
        );
        // Write empty result so agent doesn't hang
        const resultDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'rag_results',
        );
        fs.mkdirSync(resultDir, { recursive: true });
        const resultPath = path.join(resultDir, `${ragRequestId}.json`);
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            results: [],
            requestId: ragRequestId,
            error: String(err),
          }),
        );
      }
      break;
    }

    default: {
      const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
      if (!handled) {
        logger.warn({ type: data.type }, 'Unknown IPC task type');
      }
    }
  }
}
