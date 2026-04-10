import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export const loopEvents = new EventEmitter();

import { getHeartbeat } from './services/heartbeat.js';
import {
  classifyError,
  getRecoveryAction,
  clearRecoveryState,
} from './services/recovery-recipes.js';

import {
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  CONTAINER_IMAGE,
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
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
  getRecentMessages,
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
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startGatewayServer } from './gateway.js';
import { PendingBatchResult } from './ipc.js';
import { GatewayBus, GatewayHooks } from './gateway-bus/index.js';
import { loadPlugins } from './gateway-bus/plugin-loader.js';
import { findChannel, formatMessages } from './router.js';
import {
  initMemorySystem,
  indexMessage,
  isMemoryEnabled,
} from './services/memory/index.js';
import {
  resolveAgentName,
  getBotConfigByChannel,
  getAllBotConfigs,
} from './agents-config.js';
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
const visibleOutputSeqByGroupFolder: Record<string, number> = {};

const activeQuestions: Record<string, Set<string>> = {};
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
      if (jid.startsWith('app:')) {
        const appBots = getAllBotConfigs().filter((b) => b.channel === 'app');
        const targetBot =
          appBots.find((b) => b.name === 'xingmeng-app') || appBots[0];
        if (targetBot) {
          group.botToken = targetBot.name;
          setRegisteredGroup(jid, group);
          logger.info(
            { jid, botToken: group.botToken },
            'Patched missing botToken for existing app group',
          );
        }
      } else {
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

function recordVisibleOutput(groupFolder: string): void {
  visibleOutputSeqByGroupFolder[groupFolder] =
    (visibleOutputSeqByGroupFolder[groupFolder] || 0) + 1;
}

function getVisibleOutputSeq(groupFolder: string): number {
  return visibleOutputSeqByGroupFolder[groupFolder] || 0;
}

async function getPendingBatch(
  sourceGroup: string,
  overrideSinceTimestamp?: string,
): Promise<PendingBatchResult> {
  const entry = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === sourceGroup,
  );
  if (!entry) {
    return {
      success: false,
      pending: false,
      error: `Unknown source group: ${sourceGroup}`,
    };
  }

  const [chatJid, group] = entry;
  const sinceTimestamp =
    overrideSinceTimestamp || lastAgentTimestamp[chatJid] || '';
  const pendingMessages = getMessagesSince(chatJid, sinceTimestamp);

  if (pendingMessages.length === 0) {
    return {
      success: true,
      pending: false,
      messageCount: 0,
    };
  }

  const consumedThroughTimestamp =
    pendingMessages[pendingMessages.length - 1].timestamp;

  logger.debug(
    {
      sourceGroup,
      chatJid,
      messageCount: pendingMessages.length,
      consumedThroughTimestamp,
    },
    'Prepared pending batch for container pull',
  );

  let basePrompt = formatMessages(pendingMessages, TIMEZONE);

  const results = await GatewayHooks.execute('agent:new_message', {
    sourceGroup,
    chatJid,
    messages: pendingMessages,
    prompt: basePrompt,
  });

  let additionalContexts = [];
  for (const res of results) {
    if (res && res.additionalContext) {
      additionalContexts.push(res.additionalContext);
    }
  }

  const systemContext =
    additionalContexts.length > 0 ? additionalContexts.join('\n') : undefined;

  return {
    success: true,
    pending: true,
    prompt: basePrompt,
    systemContext,
    consumedThroughTimestamp,
    messageCount: pendingMessages.length,
  };
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
    if (jid.startsWith('app:')) {
      const appBots = getAllBotConfigs().filter((b) => b.channel === 'app');
      const targetBot =
        appBots.find((b) => b.name === 'xingmeng-app') || appBots[0];
      if (targetBot) {
        group.botToken = targetBot.name;
        logger.info(
          { jid, channel: 'app', botToken: group.botToken },
          'Auto-injected botToken from app channel config',
        );
      }
    } else {
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
 * Clear the current active session for a group from memory and DB.
 * Used when starting a new session or clearing a workspace.
 */
export function clearSessionForGroup(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
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
  let committedCursor = false;
  let currentQueryCursor: string | undefined;
  let currentQueryHadDirectOutput = false;
  let currentQueryVisibleBaseline = getVisibleOutputSeq(group.folder);

  // Track tool status message for send → edit → delete pattern
  // Typing stays active until the first tool event arrives
  let statusMessageId: number | null = null;
  let lastToolName: string | null = null;
  let lastStatusText: string | null = null;
  let activeHeartbeatSkipQuery = false;
  let heartbeatHandled = false; // Set when a heartbeat query completes (skip or work done)

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
    mcp__nanoclaw__recall_memory: '召回记忆',
    recall_memory: '召回记忆',
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
    // Handle specific AskUserQuestion event natively
    if (event.type === 'ask_user_question') {
      if (!activeQuestions[chatJid]) activeQuestions[chatJid] = new Set();
      activeQuestions[chatJid].add(event.question_id);
      if (channel.sendAskUserQuestion) {
        await channel.sendAskUserQuestion(
          chatJid,
          event.question_id,
          event.payload.questions,
        );
      } else {
        logger.warn({ chatJid }, 'Channel does not support AskUserQuestion');
      }
      return;
    }
    // Dispatch task_status events to status manager
    if (event.type === 'task_status') {
      GatewayBus.emitAsync('agent:sdk_task_status', {
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

    // Emit UI status event
    // (agent:tool_use hook execution moved to synchronous /ipc/hook/sync endpoint)

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
    '',
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (
        result.consumedThroughTimestamp &&
        result.consumedThroughTimestamp !== currentQueryCursor
      ) {
        currentQueryCursor = result.consumedThroughTimestamp;
        currentQueryHadDirectOutput = false;
      }

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
        if (text.trim() === 'HEARTBEAT_SKIP') {
          activeHeartbeatSkipQuery = true;
          heartbeatHandled = true;
          logger.debug(
            { group: group.name },
            'Silently discarding background heartbeat response',
          );
          text = '';
        }
        logger.debug(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          const writeEvent = {
            text,
            channelId: chatJid,
          };
          await GatewayHooks.execute('agent:end_message', writeEvent);
          text = writeEvent.text; // allow hook to modify the text directly before it gets sent

          // Stop typing indicator before sending — user should see the reply, not "typing..."
          await channel.setTyping?.(chatJid, false);
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
          currentQueryHadDirectOutput = true;

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

          // NOTE: We no longer index Agent's raw transcript messages into the LanceDB Vector Memory.
          // Intermediate thoughts/status (sent to Telegram above) are preserved in SQLite via storeMessage,
          // but we leave long-term structured memory extraction entirely to the background SmartExtractor at the Stop hook.
        }
        // Only reset idle timer on actual results, not session-update markers (result: null).
        // Heartbeat queries (skip or normal reply) never reset idle timer.
        if (
          !activeHeartbeatSkipQuery &&
          !getHeartbeat().isHeartbeatInFlight(group.folder)
        ) {
          resetIdleTimer();
        }
      }

      if (result.queryCompleted && result.status === 'success') {
        queue.notifyIdle(chatJid);
        // Check before clearing — markHeartbeatProcessed clears the in-flight flag
        const wasHeartbeat = getHeartbeat().isHeartbeatInFlight(group.folder);
        // Release heartbeat processing lock on any query completion
        // (heartbeat IPC messages don't have consumedThroughTimestamp)
        getHeartbeat().markHeartbeatProcessed(group.folder);
        if (!activeHeartbeatSkipQuery && !wasHeartbeat) {
          resetIdleTimer();
        }

        // Emit unified agent idle event after completion
        if (result.status === 'success' || result.status === 'error') {
          const recentMessages = getRecentMessages(chatJid, 50)
            .reverse() // oldest-first for natural conversation order
            .map((m) => ({
              role: m.is_bot_message ? 'assistant' : 'user',
              timestamp: m.timestamp,
              content:
                typeof m.content === 'string'
                  ? m.content
                  : JSON.stringify(m.content),
            }));

          GatewayBus.emitAsync('agent:idle', {
            sessionKey: group.folder,
            sessionId: sessions[group.folder],
            status: result.status,
            group: chatJid,
            success: result.status === 'success',
            messages: recentMessages,
          });
        }
      }

      if (result.status === 'error') {
        hadError = true;
      }

      if (result.queryCompleted && result.consumedThroughTimestamp) {
        const gatewayVisibleOutput =
          getVisibleOutputSeq(group.folder) > currentQueryVisibleBaseline;
        const queryHadVisibleOutput =
          currentQueryHadDirectOutput || gatewayVisibleOutput;

        if (queryHadVisibleOutput) {
          lastAgentTimestamp[chatJid] = result.consumedThroughTimestamp;
          saveState();
          committedCursor = true;
          logger.info(
            {
              group: group.name,
              chatJid,
              consumedThroughTimestamp: result.consumedThroughTimestamp,
            },
            'Advanced message cursor after visible query output',
          );
        } else {
          logger.info(
            {
              group: group.name,
              chatJid,
              consumedThroughTimestamp: result.consumedThroughTimestamp,
            },
            'Query completed without visible output; cursor not advanced',
          );
        }

        currentQueryVisibleBaseline = getVisibleOutputSeq(group.folder);
        currentQueryCursor = undefined;
        currentQueryHadDirectOutput = false;
        activeHeartbeatSkipQuery = false;
      }
    },
    onIpcStatus,
    { pullPendingOnStart: true },
  );

  await channel.setTyping?.(chatJid, false);
  // Clean up status message if still present
  if (statusMessageId && channel.deleteMessage) {
    await channel.deleteMessage(chatJid, statusMessageId);
    statusMessageId = null;
  }
  if (idleTimer) clearTimeout(idleTimer);

  const interruptedQueryHadVisibleOutput =
    !!currentQueryCursor &&
    (currentQueryHadDirectOutput ||
      getVisibleOutputSeq(group.folder) > currentQueryVisibleBaseline);

  if (currentQueryCursor && interruptedQueryHadVisibleOutput) {
    lastAgentTimestamp[chatJid] = currentQueryCursor;
    saveState();
    committedCursor = true;
    logger.warn(
      {
        group: group.name,
        chatJid,
        consumedThroughTimestamp: currentQueryCursor,
      },
      'Advanced message cursor after interrupted query produced visible output',
    );
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (committedCursor || outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after visible output, keeping committed cursor',
      );
      return true;
    }
    logger.warn(
      { group: group.name },
      'Agent error before any visible output; leaving cursor unchanged for retry',
    );
    return false;
  }

  if (!committedCursor) {
    // Heartbeat queries (IPC-injected) don't have consumedThroughTimestamp,
    // so committedCursor is never set. This is expected — not a failure.
    // Likewise, if it replied to the user we shouldn't retry.
    if (heartbeatHandled || outputSentToUser) {
      return true;
    }
    logger.warn(
      { group: group.name },
      'Agent produced no visible output, cursor not advanced',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string | any[],
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onIpcStatus?: (event: IpcStatusEvent) => void,
  options?: {
    pullPendingOnStart?: boolean;
  },
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  let currentPrompt = prompt;
  let maxLoopAttempts = 3;

  while (maxLoopAttempts > 0) {
    maxLoopAttempts--;
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
      const isGroup =
        getChatIsGroup(chatJid) ?? group.requiresTrigger !== false;

      // Fire session:start hook — plugins can inject persistent system context
      let pluginSystemContext: string | undefined;
      try {
        const sessionStartResults = await GatewayHooks.execute(
          'session:start',
          {
            sessionKey: group.folder,
            chatJid,
            isMain,
            hasExistingSession: !!sessionId,
          },
        );
        const contexts: string[] = [];
        for (const res of sessionStartResults) {
          if (res && res.additionalContext) {
            contexts.push(res.additionalContext);
          }
        }
        if (contexts.length > 0) {
          pluginSystemContext = contexts.join('\n');
        }
      } catch (err) {
        logger.warn({ err }, 'session:start hook error');
      }

      const output = await runContainerAgent(
        group,
        {
          prompt: currentPrompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          isGroup,
          assistantName: group.assistantName,
          pluginSystemContext,
          pullPendingOnStart: options?.pullPendingOnStart,
        },
        (proc, containerName) => {
          queue.registerProcess(chatJid, proc, containerName, group.folder);
          GatewayBus.emitAsync('agent:container_start', {
            group: chatJid,
            containerName,
          });
        },
        wrappedOnOutput,
        onIpcStatus,
      );

      GatewayBus.emitAsync('agent:container_stop', { group: chatJid });

      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        const errObj = output.error || 'Container crash';
        logger.error(
          { group: group.name, error: errObj },
          'Container agent error',
        );

        const scenario = classifyError(errObj);
        const actionRecipe = getRecoveryAction(group.folder, scenario);

        if (actionRecipe) {
          logger.warn(
            { group: group.name, delayMs: actionRecipe.delayMs },
            'Attempting automated recovery',
          );
          if (actionRecipe.delayMs > 0) {
            await new Promise((r) => setTimeout(r, actionRecipe.delayMs));
          }
          currentPrompt = actionRecipe.action.systemPrompt;
          delete sessions[group.folder];
          deleteSession(group.folder);
          continue; // Retry loop
        }

        // Clear corrupted session so next user retry starts fresh
        delete sessions[group.folder];
        deleteSession(group.folder);
        logger.info({ group: group.name }, 'Cleared session for fresh retry');
        return 'error';
      }

      clearRecoveryState(group.folder);
      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');

      const scenario = classifyError(err);
      const actionRecipe = getRecoveryAction(group.folder, scenario);

      if (actionRecipe) {
        logger.warn(
          { group: group.name, delayMs: actionRecipe.delayMs },
          'Attempting automated recovery on catch',
        );
        if (actionRecipe.delayMs > 0) {
          await new Promise((r) => setTimeout(r, actionRecipe.delayMs));
        }
        currentPrompt = actionRecipe.action.systemPrompt;
        delete sessions[group.folder];
        deleteSession(group.folder);
        continue;
      }

      // Clear corrupted session so next user retry starts fresh
      delete sessions[group.folder];
      deleteSession(group.folder);
      logger.info({ group: group.name }, 'Cleared session for fresh retry');
      return 'error';
    }
  }

  return 'error';
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

          if (queue.notifyPendingMessages(chatJid)) {
            logger.debug(
              { chatJid, count: groupMessages.length },
              'Notified active container about pending messages',
            );
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
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        loopEvents.off('wakeup', onWakeup);
        resolve();
      }, POLL_INTERVAL);
      const onWakeup = () => {
        clearTimeout(timer);
        resolve();
      };
      loopEvents.once('wakeup', onWakeup);
    });
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
  await loadPlugins();

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  initMemorySystem();
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    GatewayBus.emitAsync('system:shutdown', {}).catch(() => {});
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      // Ignore background heartbeat prompts
      if (
        msg.sender === 'system' &&
        typeof msg.content === 'string' &&
        msg.content.includes('background heartbeat prompt')
      ) {
        return;
      }
      if (
        activeQuestions[msg.chat_jid] &&
        activeQuestions[msg.chat_jid].size > 0
      ) {
        for (const questionId of activeQuestions[msg.chat_jid]) {
          channelOpts.onQuestionAnswer(msg.chat_jid, questionId, {
            其他: msg.content,
          });
        }
        activeQuestions[msg.chat_jid].clear();
        logger.info(
          { chatJid: msg.chat_jid },
          'Message intercepted as AskUserQuestion answer natively',
        );
        return;
      }
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
      loopEvents.emit('wakeup');
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
    groupQueue: queue,
    onQuestionAnswer: (
      chatJid: string,
      questionId: string,
      answers: Record<string, any>,
    ) => {
      if (activeQuestions[chatJid]) {
        activeQuestions[chatJid].delete(questionId);
      }
      const group = registeredGroups[chatJid];
      if (!group) return;
      const ipcDir = path.join(resolveGroupIpcPath(group.folder), 'input');
      fs.mkdirSync(ipcDir, { recursive: true });
      const answerPayload = {
        type: 'question_answer',
        question_id: questionId,
        answers,
      };
      fs.writeFileSync(
        path.join(ipcDir, `${Date.now()}-ans.json`),
        JSON.stringify(answerPayload),
      );
    },
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
      const text = rawText;
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
    getPendingBatch,
    recordVisibleOutput,
  };

  startGatewayServer(ipcDeps);

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // EMIT RICH STARTUP PAYLOAD FOR PLUGINS
  GatewayBus.emitAsync('system:startup', {
    action: 'startup',
    config: {
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
      timezone: TIMEZONE,
      dataDir: DATA_DIR,
      containerImage: CONTAINER_IMAGE,
    },
    system: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    bots: getAllBotConfigs(),
    groups: registeredGroups,
    tasks: getAllTasks(),
    channels: channels.map((ch) => ({
      name: ch.name,
      connected: ch.isConnected(),
    })),
  }).catch((err) => logger.error({ err }, 'GatewayBus startup error'));

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
