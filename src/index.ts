import fs from 'fs';
import path from 'path';

import {
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  escapeRegex,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  IpcStatusEvent,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatIsGroup,
  getMaxRowid,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startGatewayServer } from './gateway.js';
import { statusInit, statusEmit, statusDestroy } from './status.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { initRag, indexMessage, isRagEnabled } from './rag.js';
import { resolveAgentName, getBotConfigByChannel } from './agents-config.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  NewMessage,
  RegisteredGroup,
  getTextContent,
  isTriggerPresent,
} from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastRowid = 0;
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  const rawRowid = getRouterState('last_rowid');
  if (rawRowid) {
    lastRowid = parseInt(rawRowid, 10);
    // Guard against stale cursor: after message deletion (e.g. /clear),
    // SQLite reuses rowids. If saved cursor exceeds max rowid, new
    // messages would never be seen by the polling loop.
    const actualMax = getMaxRowid();
    if (lastRowid > actualMax) {
      logger.warn(
        { savedRowid: lastRowid, actualMax },
        'Stale lastRowid detected (likely after /clear), resetting to current max',
      );
      lastRowid = actualMax;
      setRouterState('last_rowid', lastRowid.toString());
    }
  } else {
    // First boot after migration: pick up from current end of DB
    // to avoid re-replying to thousands of old messages.
    lastRowid = getMaxRowid();
  }
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Patch existing groups that lack botToken (e.g. Feishu groups registered
  // before auto-injection was added). This ensures they resolve to the correct
  // agent config instead of falling back to the first bot.
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!group.botToken) {
      const channelMatch = jid.match(/@(\w+)$/);
      if (channelMatch && channelMatch[1] !== 'telegram') {
        const channelBot = getBotConfigByChannel(channelMatch[1]);
        if (channelBot) {
          group.botToken = channelBot.name;
          setRegisteredGroup(jid, group);
          logger.info(
            { jid, botToken: group.botToken },
            'Patched missing botToken for existing group',
          );
        }
      }
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_rowid', lastRowid.toString());
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  // Auto-inject botToken for channel-based bots (e.g. Feishu) that don't use
  // per-bot tokens. Without this, they fall back to the first bot in agents.yaml.
  if (!group.botToken) {
    const channelMatch = jid.match(/@(\w+)$/);
    if (channelMatch && channelMatch[1] !== 'telegram') {
      const channelName = channelMatch[1];
      const channelBot = getBotConfigByChannel(channelName);
      if (channelBot) {
        group.botToken = channelBot.name;
        logger.info(
          { jid, channel: channelName, botToken: group.botToken },
          'Auto-injected botToken from channel config',
        );
      }
    }
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Cross-post a bot message to sibling agents in the same Telegram chat.
 * Telegram doesn't deliver bot messages to other bots, so we manually
 * store the message in each sibling's DB record.
 */
function crossPostToSiblingAgents(
  senderJid: string,
  text: string,
  senderName: string,
): void {
  if (!senderJid.startsWith('tg:')) return;

  // Extract Telegram chat ID: tg:-1003751636421@8624060050 → -1003751636421
  const chatId = senderJid.replace(/^tg:/, '').replace(/@.*$/, '');

  // Skip private chats — only groups (negative IDs) need cross-posting
  if (!chatId.startsWith('-')) return;

  for (const [jid] of Object.entries(registeredGroups)) {
    if (jid === senderJid) continue;
    if (!jid.startsWith('tg:')) continue;

    const otherChatId = jid.replace(/^tg:/, '').replace(/@.*$/, '');
    if (otherChatId !== chatId) continue;

    const now = new Date().toISOString();
    // Ensure the sibling chat exists in the chats table (FK parent row)
    storeChatMetadata(jid, now, undefined, 'telegram', true);

    storeMessage({
      id: `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: 'bot',
      sender_name: senderName,
      content: text,
      timestamp: now,
      is_from_me: false,
    });

    logger.debug(
      { from: senderJid, to: jid, senderName },
      'Cross-posted bot message to sibling agent',
    );
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some((m) => {
      const text = getTextContent(m.content);
      const triggerPresent = isTriggerPresent(
        text,
        group.trigger,
        group.assistantName,
      );
      return (
        (triggerPresent || m.is_reply_to_bot) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg))
      );
    });
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Track tool status message for send → edit → delete pattern
  // Typing stays active until the first tool event arrives
  let statusMessageId: number | null = null;
  let lastToolName: string | null = null;
  let lastStatusText: string | null = null;

  const TOOL_DISPLAY_NAMES: Record<string, string> = {
    Bash: '执行命令行',
    Read: '读取文件',
    Write: '写入文件',
    Edit: '编辑文件',
    Grep: '搜索代码',
    Glob: '查找文件',
    // WebSearch: '搜索网页',  // Disabled
    // WebFetch: '获取网页',   // Disabled
    Task: '执行子任务',
    TaskOutput: '读取任务结果',
    TaskStop: '停止任务',
    TeamCreate: '创建团队',
    TeamDelete: '删除团队',
    SendMessage: '发送消息',
    TodoWrite: '更新待办',
    ToolSearch: '搜索工具',
    Skill: '使用技能',
    NotebookEdit: '编辑笔记本',
    LS: '列出文件',
    ReadLink: '读取链接',
    FileTree: '列出文件树',
    // MCP: nanoclaw tools
    mcp__nanoclaw__send_message: '发送消息',
    send_message: '发送消息',
    mcp__nanoclaw__send_media: '发送媒体',
    send_media: '发送媒体',
    mcp__nanoclaw__generate_image: '生成图片',
    generate_image: '生成图片',
    mcp__nanoclaw__schedule_task: '安排任务',
    schedule_task: '安排任务',
    mcp__nanoclaw__list_tasks: '查询任务列表',
    list_tasks: '查询任务列表',
    mcp__nanoclaw__pause_task: '暂停任务',
    pause_task: '暂停任务',
    mcp__nanoclaw__resume_task: '恢复任务',
    resume_task: '恢复任务',
    mcp__nanoclaw__cancel_task: '取消任务',
    cancel_task: '取消任务',
    mcp__nanoclaw__register_group: '注册群组',
    register_group: '注册群组',
    mcp__nanoclaw__rag_search: '搜索记忆',
    rag_search: '搜索记忆',
    mcp__nanoclaw__x_post: '发推文',
    x_post: '发推文',
    mcp__nanoclaw__x_like: '点赞推文',
    x_like: '点赞推文',
    mcp__nanoclaw__x_reply: '回复推文',
    x_reply: '回复推文',
    mcp__nanoclaw__x_retweet: '转推',
    x_retweet: '转推',
    mcp__nanoclaw__x_quote: '引用推文',
    x_quote: '引用推文',
    mcp__nanoclaw__x_trends: '查询热搜',
    x_trends: '查询热搜',
    // MCP: media tools
    mcp__nanoclaw__mcp__media__get_cached_media: '获取媒体',
    describe_cached_image: '分析图片',
    describe_cached_video: '分析视频',
    transcribe_cached_audio: '转录语音',
    // MCP: context-mode tools
    'mcp__context-mode__ctx_read': '读取上下文',
    'mcp__context-mode__ctx_search': '搜索上下文',
    'mcp__context-mode__ctx_fetch_and_index': '网页解析',
    ctx_read: '读取上下文',
    ctx_search: '搜索上下文',
    ctx_fetch_and_index: '网页解析',
    ctx_execute: '代码沙盒执行',
    ctx_batch_execute: '批量脚本执行',
    // MCP: parallel tools
    'mcp__parallel-search__search': '网络搜索',
    'mcp__parallel-search__web_fetch': '抓取网页',
    'mcp__parallel-task__run_task': '并行任务',
    search: '网络搜索',
    web_fetch: '抓取网页',
    run_task: '并行任务',
  };

  // Build a lookup map with lowercase keys
  const TOOL_LOOKUP: Record<string, string> = {};
  for (const [key, value] of Object.entries(TOOL_DISPLAY_NAMES)) {
    TOOL_LOOKUP[key.toLowerCase()] = value;
  }

  /** Resolve tool display name, with fallback for unknown MCP tools */
  const getToolDisplayName = (tool: string): string => {
    const lower = tool.toLowerCase();
    if (TOOL_LOOKUP[lower]) return TOOL_LOOKUP[lower];

    // For unknown MCP tools: mcp__server__tool_name → "tool_name"
    if (tool.startsWith('mcp__')) {
      const parts = tool.split('__');
      return parts[parts.length - 1];
    }
    return tool;
  };

  const onIpcStatus = async (event: IpcStatusEvent) => {
    // Dispatch task_status events to status manager
    if (event.type === 'task_status') {
      statusEmit('sdk_task', {
        group: chatJid,
        detail: JSON.stringify({
          task_id: event.task_id,
          status: event.status,
          summary: event.summary,
        }),
      });
      return;
    }

    if (!channel.sendStatusMessage) return;

    // Emit status event for status.json
    statusEmit(event.status === 'running' ? 'tool_use' : 'agent_idle', {
      group: chatJid,
      tool: event.tool,
    });

    if (event.status === 'running' && event.tool) {
      let displayName = event.description;
      if (!displayName) {
        if (event.tool === lastToolName) {
          return; // Skip tool_progress events without a new description for the same tool
        }
        displayName = getToolDisplayName(event.tool);
      }
      const statusText = `⏳ 正在${displayName}...`;

      if (statusMessageId) {
        // Edit existing status message (tool changed or description changed)
        if (lastToolName !== event.tool || lastStatusText !== statusText) {
          await channel.editStatusMessage?.(
            chatJid,
            statusMessageId,
            statusText,
          );
          lastStatusText = statusText;
        }
      } else {
        // First tool — send status message and ensure typing stays active
        statusMessageId = await channel.sendStatusMessage(chatJid, statusText);
        lastStatusText = statusText;
      }
      await channel.setTyping?.(chatJid, true);
      lastToolName = event.tool;
    } else if (event.status === 'idle') {
      // Agent finished — delete status message and stop typing indicator
      await channel.setTyping?.(chatJid, false);
      if (statusMessageId) {
        await channel.deleteMessage?.(chatJid, statusMessageId);
        statusMessageId = null;
        lastToolName = null;
      }
    }
  };

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        let text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        // Also ignore messages that are just "..." after stripping internal reasoning
        if (text === '...') {
          text = '';
        }
        logger.debug(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          // Stop typing indicator before sending — user should see the reply, not "typing..."
          await channel.setTyping?.(chatJid, false);
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;

          // Note: We deliberately do NOT re-enable typing here just because statusMessageId exists.
          // If a tool actually starts running again, onIpcStatus will re-enable it.
          // This prevents Telegram's typing indicator from getting "stuck" for 5 seconds after
          // agent completes its text output and tool processing finishes simultaneously.

          // Store bot message in DB so it's included in future context
          storeMessage({
            id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: chatJid,
            sender: 'assistant',
            sender_name: group.assistantName!,
            content: text,
            timestamp: new Date().toISOString(),
            is_bot_message: true,
            is_from_me: true,
          });

          // Cross-post to sibling agents in same Telegram group
          crossPostToSiblingAgents(chatJid, text, group.assistantName!);
          // Auto-index agent output for RAG (fire-and-forget)
          if (isRagEnabled()) {
            indexMessage(resolveAgentName(group.botToken), text, {
              role: 'assistant',
              chat_source:
                (getChatIsGroup(chatJid) ?? false)
                  ? `群聊:${group.name}`
                  : '私聊',
              timestamp: new Date().toISOString(),
            }).catch(() => {});
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    onIpcStatus,
  );

  await channel.setTyping?.(chatJid, false);
  // Clean up status message if still present
  if (statusMessageId && channel.deleteMessage) {
    await channel.deleteMessage(chatJid, statusMessageId);
    statusMessageId = null;
  }
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // If the agent completed successfully but produced no visible output,
  // roll back the cursor so these messages will be re-processed on next check.
  // This handles the SDK v2.1.72 resume bug where piped messages on fresh
  // sessions produce empty results. The next check will spawn a fresh container.
  if (!outputSentToUser) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent produced no output, rolled back message cursor for re-processing',
    );
    return false; // Trigger retry via GroupQueue.scheduleRetry()
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onIpcStatus?: (event: IpcStatusEvent) => void,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by agent)
  const tasks = getAllTasks();
  const agentFolders = Object.values(registeredGroups)
    .filter((g) => (g.botToken || '') === (group.botToken || ''))
    .map((g) => g.folder);
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    agentFolders,
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const isGroup = getChatIsGroup(chatJid) ?? group.requiresTrigger !== false;

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        isGroup,
        assistantName: group.assistantName,
      },
      (proc, containerName) => {
        queue.registerProcess(chatJid, proc, containerName, group.folder);
        statusEmit('container_start', { group: chatJid });
      },
      wrappedOnOutput,
      onIpcStatus,
    );

    statusEmit('container_stop', { group: chatJid });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      // Clear corrupted session so next retry starts fresh
      delete sessions[group.folder];
      deleteSession(group.folder);
      logger.info({ group: group.name }, 'Cleared session for fresh retry');
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    // Clear corrupted session so next retry starts fresh
    delete sessions[group.folder];
    deleteSession(group.folder);
    logger.info({ group: group.name }, 'Cleared session for fresh retry');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('NanoClaw running');

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newRowid } = getNewMessages(jids, lastRowid);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastRowid = newRowid;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some((m) => {
              const text = getTextContent(m.content);
              const triggerPresent = isTriggerPresent(
                text,
                group.trigger,
                group.assistantName,
              );
              return (
                (triggerPresent || m.is_reply_to_bot) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg))
              );
            });
            if (!hasTrigger) {
              logger.info(
                { chatJid, count: groupMessages.length },
                'Messages ignored: missing trigger',
              );
              continue;
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // DO NOT advance the cursor here. The actual cursor advancement
            // is governed by processGroupMessages once the agent emits its result.
            // If we advance here, an empty response from the agent means the
            // messages are lost because the active query loop won't roll back.
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            logger.debug(
              { chatJid },
              'No active container found or busy, enqueuing for new check',
            );
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastRowid and processing messages.
 */
function recoverPendingMessages(): void {
  // Only recover messages that arrived recently (within last 5 minutes).
  // This prevents replaying stale history when lastAgentTimestamp was
  // rolled back due to agent producing no output (crash, empty reply, etc.).
  const recoveryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp);
    if (pending.length > 0) {
      // Only recover if the most recent pending message is recent enough
      const newestTimestamp = pending[pending.length - 1].timestamp;
      if (newestTimestamp < recoveryCutoff) {
        // Messages are too old — advance cursor past them to prevent
        // replaying on every restart
        logger.info(
          { group: group.name, pendingCount: pending.length, newestTimestamp },
          'Recovery: skipping stale messages and advancing cursor',
        );
        lastAgentTimestamp[chatJid] = newestTimestamp;
        saveState();
        continue;
      }

      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  initRag();
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    statusEmit('shutdown');
    statusDestroy();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        registeredGroups[msg.chat_jid]
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(msg.chat_jid, cfg) &&
          !isSenderAllowed(msg.chat_jid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid: msg.chat_jid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
      // Auto-index user messages for RAG (fire-and-forget)
      if (isRagEnabled()) {
        const group = registeredGroups[msg.chat_jid];
        if (group) {
          indexMessage(resolveAgentName(group.botToken), msg.content, {
            role: 'user',
            sender_name: msg.sender_name,
            message_id: msg.id,
            chat_source:
              (getChatIsGroup(msg.chat_jid) ?? false)
                ? `群聊:${group.name}`
                : '私聊',
            timestamp: msg.timestamp,
          }).catch(() => {});
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    groupQueue: queue,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const result = factory(channelOpts);
    if (!result) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    // Support factories that return multiple channel instances (e.g., multi-bot Telegram)
    const instances = Array.isArray(result) ? result : [result];
    for (const channel of instances) {
      try {
        await channel.connect();
        channels.push(channel);
      } catch (err) {
        // Silently skip if a bot fails to connect
      }
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Initialize Telegram bot pool for agent swarm
  const { TELEGRAM_BOT_POOL } = await import('./config.js');
  if (TELEGRAM_BOT_POOL.length > 0) {
    const { initBotPool } = await import('./channels/telegram.js');
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  const ipcDeps = {
    sendMessage: (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendMedia: async (
      jid: string,
      buffer: Buffer,
      mediaType: 'photo' | 'video' | 'audio' | 'document',
      caption?: string,
      fileName?: string,
    ) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendMedia) {
        logger.warn({ jid }, 'Channel does not support sendMedia');
        return;
      }
      await channel.sendMedia(jid, buffer, mediaType, caption, fileName);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf: any, im: any, ag: any, rj: any) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  };

  startGatewayServer(ipcDeps);

  // Initialize status manager and emit startup
  statusInit({
    registeredGroups: () => registeredGroups,
    channels,
    queue,
  });
  statusEmit('startup');

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
