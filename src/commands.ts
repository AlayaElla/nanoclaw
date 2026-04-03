/**
 * Shared command system for all channels.
 *
 * Commands are channel-agnostic: each channel builds a CommandContext
 * and calls handleCommand(). The shared handlers do the work and reply
 * via the context's `reply()` callback.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { RegisteredGroup, OnInboundMessage } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface CommandContext {
  chatJid: string;
  isGroup: boolean;
  timestamp: string;
  channelName: string;
  /** The registered group for this chat, or undefined if unregistered */
  group: RegisteredGroup | undefined;
  groupQueue: GroupQueue;
  /** Send a reply back to the chat */
  reply: (text: string) => Promise<void>;
  /** Inject a synthetic message into the processing pipeline */
  onMessage: OnInboundMessage;
}

type CommandHandler = (ctx: CommandContext, args: string) => Promise<boolean>;

interface CommandDef {
  handler: CommandHandler;
  description: string;
  /** If true, command works even in unregistered chats */
  allowUnregistered?: boolean;
}

// ─── Registry ───────────────────────────────────────────────────────

const commands = new Map<string, CommandDef>();

function registerCommand(
  name: string,
  description: string,
  handler: CommandHandler,
  opts?: { allowUnregistered?: boolean },
): void {
  commands.set(name, {
    handler,
    description,
    allowUnregistered: opts?.allowUnregistered,
  });
}

/**
 * Dispatch a slash command. Returns true if handled.
 */
export async function handleCommand(
  ctx: CommandContext,
  rawContent: string,
): Promise<boolean> {
  const parts = rawContent.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  const def = commands.get(cmd);
  if (!def) return false;

  if (!def.allowUnregistered && !ctx.group) {
    await ctx.reply('This chat is not registered.');
    return true;
  }

  try {
    return await def.handler(ctx, args);
  } catch (err) {
    logger.error({ cmd, chatJid: ctx.chatJid, err }, 'Command handler error');
    await ctx.reply(`❌ 指令执行失败: ${cmd}`);
    return true;
  }
}
// ─── /help ──────────────────────────────────────────────────────────

registerCommand(
  '/help',
  '显示所有可用指令',
  async (ctx) => {
    const lines = ['📖 可用指令', ''];
    for (const [name, def] of commands) {
      lines.push(`${name} — ${def.description}`);
    }
    await ctx.reply(lines.join('\n'));
    return true;
  },
  { allowUnregistered: true },
);

// ─── /ping ──────────────────────────────────────────────────────────

registerCommand(
  '/ping',
  '检测机器人是否在线',
  async (ctx) => {
    const name = ctx.group?.assistantName || 'NanoClaw';
    await ctx.reply(`${name} is online. (${ctx.channelName})`);
    return true;
  },
  { allowUnregistered: true },
);

// ─── /chatid ────────────────────────────────────────────────────────

registerCommand(
  '/chatid',
  '返回当前对话的 Chat ID',
  async (ctx) => {
    const chatTypeStr = ctx.isGroup ? 'Group' : 'Private';
    await ctx.reply(`Chat ID: ${ctx.chatJid}\nType: ${chatTypeStr}`);
    return true;
  },
  { allowUnregistered: true },
);

// ─── /new ───────────────────────────────────────────────────────────

registerCommand('/new', '新建会话（保留工作区和记忆）', async (ctx) => {
  // 1. Gracefully shut down active container
  await gracefulShutdown(ctx);

  // 2. Clear Claude session state only (keep workspace/DB/tasks/RAG)
  clearClaudeSessionState(ctx.group!.folder);

  // 3. Clear IPC input state
  clearIpcInput(ctx.group!.folder);

  const { clearSessionForGroup } = await import('./index.js');
  clearSessionForGroup(ctx.group!.folder);

  await new Promise((r) => setTimeout(r, 1000));

  await ctx.reply(
    '✅ 新会话已就绪！会话记忆已清除，工作区、任务和长期记忆保持不变。',
  );
  logger.info({ chatJid: ctx.chatJid }, 'New session started via /new');
  return true;
});

// ─── /clear ─────────────────────────────────────────────────────────

registerCommand('/clear', '硬重置 — 清空工作区和所有历史数据', async (ctx) => {
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', ctx.group!.folder);

  let clearedOptions = false;
  if (fs.existsSync(groupSessionsDir)) {
    fs.rmSync(groupSessionsDir, { recursive: true, force: true });
    clearedOptions = true;
  }

  if (clearedOptions) {
    logger.info({ chatJid: ctx.chatJid }, 'Workspace data cleared');
  } else {
    logger.info({ chatJid: ctx.chatJid }, 'No workspace data found to clear');
  }

  // Clear Database Data (Tasks, Messages) for this JID
  const { clearChatData } = await import('./db.js');
  clearChatData(ctx.chatJid);

  const { clearSessionForGroup } = await import('./index.js');
  clearSessionForGroup(ctx.group!.folder);

  await ctx.reply(
    '✅ 清理成功！您的工作区和所有历史对话已完全清空，可以直接开始全新的会话。',
  );
  return true;
});

// ─── /compact ───────────────────────────────────────────────────────

registerCommand('/compact', '软重置 — 生成对话总结后重置会话', async (ctx) => {
  await ctx.reply(
    'Compacting session... 正在读取数据库并生成对话总结，随后将重置短期记忆。',
  );

  // 1. Fetch recent history from DB
  const { getRecentMessages } = await import('./db.js');
  const recentMessages = getRecentMessages(ctx.chatJid, 20);
  let historyBlock = '';
  if (recentMessages && recentMessages.length > 0) {
    for (const msg of recentMessages.reverse()) {
      historyBlock += `[${msg.timestamp}] ${msg.sender_name}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}\n`;
    }
  }

  // 2. Generate summary using LLM API
  let summary = '目前没有先前的上下文可以总结。';
  if (historyBlock) {
    summary = await generateSummary(ctx.chatJid, historyBlock);
  }

  // 3. Gracefully shut down active container
  await gracefulShutdown(ctx);

  // 4. Clear session state
  clearClaudeSessionState(ctx.group!.folder);
  clearIpcInput(ctx.group!.folder);

  const { clearSessionForGroup } = await import('./index.js');
  clearSessionForGroup(ctx.group!.folder);

  await new Promise((r) => setTimeout(r, 1000));

  // 5. Inject system message with summary
  await ctx.reply(
    '✅ 总结与清理完成！最新提示词与上下文摘要已就绪，正在唤醒新会话...',
  );
  const content = `[System Status: Session has been compacted to load new system prompts. Your short-term memory was cleared, but your tasks and RAG memory remain intact. The following is a summary of the recent conversational context precisely crafted for you to continue working smoothly:\n\n${summary}\n\nPlease acknowledge this reset and review your active tasks. Respond with "会话已软重置，最新提示词与上下文摘要已自动继承。"]`;

  ctx.onMessage(ctx.chatJid, {
    id: `compact-${Date.now()}`,
    chat_jid: ctx.chatJid,
    sender: 'system',
    sender_name: 'SystemAdmin',
    content,
    timestamp: ctx.timestamp,
    is_from_me: true,
  });

  logger.info(
    { chatJid: ctx.chatJid },
    'Session compacted and summary injected',
  );
  return true;
});

// ─── /restart ─────────────────────────────────────────────────────────

registerCommand(
  '/restart',
  '重启智能体容器（应用新加入的 Skill 和 Hooks 等体验）',
  async (ctx) => {
    await ctx.reply('🔄 正在重启执行器容器...');

    // 1. Gracefully shut down active container
    await gracefulShutdown(ctx);
    await new Promise((r) => setTimeout(r, 1000));

    // 2. Inject system message to poke the container to start back up immediately and process any boot warnings
    const content = `[System Command: The user has restarted your container to reload External Skills, Configuration, and Hooks. Please acknowledge the restart and review any system boot warnings sent to you. Respond briefly with "重启成功" directly to the user.]`;

    ctx.onMessage(ctx.chatJid, {
      id: `restart-${Date.now()}`,
      chat_jid: ctx.chatJid,
      sender: 'system',
      sender_name: 'SystemAdmin',
      content,
      timestamp: ctx.timestamp,
      is_from_me: true,
    });

    logger.info({ chatJid: ctx.chatJid }, 'Container restarted via /restart');
    return true;
  },
);

// ─── /stop ──────────────────────────────────────────────────────────

registerCommand('/stop', '中断当前正在执行的任务', async (ctx) => {
  const status = ctx.groupQueue.getGroupStatus(ctx.chatJid);

  if (!status || !status.active) {
    await ctx.reply('当前没有正在执行的任务。');
    return true;
  }

  try {
    ctx.groupQueue.closeStdin(ctx.chatJid);
    await new Promise((r) => setTimeout(r, 1000));
    await ctx.groupQueue.killContainer(ctx.chatJid);

    const detail = status.runningTaskId
      ? `定时任务 (${status.runningTaskId})`
      : '对话处理';
    await ctx.reply(`⏹️ 已中断当前${detail}。`);
    logger.info({ chatJid: ctx.chatJid }, 'Task stopped via /stop');
  } catch (err) {
    logger.error({ chatJid: ctx.chatJid, err }, 'Failed to stop task');
    await ctx.reply('❌ 停止任务失败，请检查服务器日志。');
  }
  return true;
});

// ─── /status ────────────────────────────────────────────────────────

registerCommand('/status', '查看当前群组状态', async (ctx) => {
  const group = ctx.group!;
  const status = ctx.groupQueue.getGroupStatus(ctx.chatJid);

  // Container state
  let containerLine: string;
  if (!status || !status.active) {
    containerLine = '🔴 空闲';
  } else if (status.runningTaskId) {
    containerLine = `🟢 执行定时任务 (${status.runningTaskId})`;
  } else {
    containerLine = '🟢 处理对话中';
  }

  // Running time
  let uptimeLine = '';
  if (status?.active && status.startedAt) {
    const elapsed = Math.round(
      (Date.now() - new Date(status.startedAt).getTime()) / 1000,
    );
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    uptimeLine = `\n⏱️ 运行时间: ${mins}m${secs}s`;
  }

  // Tasks
  const { getTasksForGroup } = await import('./db.js');
  const tasks = getTasksForGroup(group.folder);
  const activeTasks = tasks.filter((t) => t.status === 'active');

  const lines = [
    `📊 **${group.name}** 状态`,
    ``,
    `🤖 容器: ${containerLine}${uptimeLine}`,
    `📂 文件夹: \`${group.folder}\``,
    `📋 定时任务: ${activeTasks.length} 个活跃 / ${tasks.length} 个总计`,
  ];

  await ctx.reply(lines.join('\n'));
  return true;
});

// ─── /tasks ─────────────────────────────────────────────────────────

registerCommand('/tasks', '列出当前群组的定时任务', async (ctx) => {
  const { getTasksForGroup } = await import('./db.js');
  const tasks = getTasksForGroup(ctx.group!.folder);

  if (tasks.length === 0) {
    await ctx.reply('当前群组没有定时任务。');
    return true;
  }

  const lines = [`📋 定时任务 (${tasks.length})`, ''];
  for (const t of tasks) {
    const statusIcon =
      t.status === 'active' ? '🟢' : t.status === 'paused' ? '⏸️' : '✅';
    const promptPreview =
      t.prompt.length > 40 ? t.prompt.slice(0, 40) + '...' : t.prompt;
    const scheduleInfo =
      t.schedule_type === 'cron'
        ? `cron: ${t.schedule_value}`
        : `${t.schedule_type}: ${t.schedule_value}`;
    const nextRun = t.next_run
      ? new Date(t.next_run).toLocaleString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        })
      : '—';

    lines.push(`${statusIcon} \`${t.id.slice(0, 8)}\` ${promptPreview}`);
    lines.push(`   📅 ${scheduleInfo} | 下次: ${nextRun}`);
  }

  await ctx.reply(lines.join('\n'));
  return true;
});

// ─── /context ───────────────────────────────────────────────────────

registerCommand('/context', '查看当前会话上下文状态', async (ctx) => {
  const group = ctx.group!;
  const sessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
    'sessions',
  );
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
    'projects',
  );

  // Check session existence
  let sessionCount = 0;
  try {
    if (fs.existsSync(sessionDir)) {
      sessionCount = fs.readdirSync(sessionDir).length;
    }
  } catch {
    /* ignore */
  }

  // Check project config
  let hasProjectConfig = false;
  try {
    if (fs.existsSync(projectsDir)) {
      hasProjectConfig = true;
    }
  } catch {
    /* ignore */
  }

  // Try to read the latest session file for token usage
  let tokenInfo = '';
  try {
    if (sessionCount > 0) {
      const files = fs.readdirSync(sessionDir).sort();
      const latestFile = files[files.length - 1];
      const filePath = path.join(sessionDir, latestFile);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      // Parse last JSONL entry for usage info
      let totalInput = 0;
      let totalOutput = 0;
      let turnCount = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'summary' && entry.summary) {
            // Claude SDK session summary has usage info
            if (entry.costUSD) {
              tokenInfo += `\n💰 费用: $${entry.costUSD.toFixed(4)}`;
            }
          }
          if (entry.message?.usage) {
            totalInput += entry.message.usage.input_tokens || 0;
            totalOutput += entry.message.usage.output_tokens || 0;
          }
          if (entry.type === 'assistant') {
            turnCount++;
          }
        } catch {
          /* skip unparseable lines */
        }
      }
      if (totalInput > 0 || totalOutput > 0) {
        tokenInfo += `\n📊 Token: ${(totalInput / 1000).toFixed(1)}k input / ${(totalOutput / 1000).toFixed(1)}k output`;
      }
      if (turnCount > 0) {
        tokenInfo += `\n💬 回合数: ${turnCount}`;
      }
      tokenInfo += `\n📄 会话文件: ${(stat.size / 1024).toFixed(1)} KB`;
    }
  } catch {
    /* ignore errors reading session */
  }

  const lines = [
    `🧠 上下文状态`,
    '',
    `📂 工作区: \`${group.folder}\``,
    `📝 会话文件: ${sessionCount > 0 ? `${sessionCount} 个` : '无（新会话）'}`,
    `⚙️ 项目配置: ${hasProjectConfig ? '已加载' : '未找到'}`,
  ];

  if (tokenInfo) {
    lines.push(tokenInfo);
  }

  if (sessionCount === 0) {
    lines.push('', '💡 当前是全新会话，发送消息后将创建会话上下文。');
  }

  await ctx.reply(lines.join('\n'));
  return true;
});

// ─── Shared Helpers ─────────────────────────────────────────────────

async function gracefulShutdown(ctx: CommandContext): Promise<void> {
  try {
    ctx.groupQueue.closeStdin(ctx.chatJid);
    await new Promise((r) => setTimeout(r, 1000));
    await ctx.groupQueue.killContainer(ctx.chatJid);
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    logger.warn(
      { chatJid: ctx.chatJid, err: e },
      'Failed to gracefully close container',
    );
  }
}

function clearClaudeSessionState(groupFolder: string): void {
  const baseClaudeDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  const dirsToClear = ['sessions', 'session-env', 'projects'];
  for (const dirName of dirsToClear) {
    const dirPath = path.join(baseClaudeDir, dirName);
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch (e) {
      logger.warn({ dirPath, e }, 'Failed to clear claude state directory');
    }
  }
}

function clearIpcInput(groupFolder: string): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    if (fs.existsSync(ipcDir)) {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  } catch (e) {
    logger.warn({ ipcDir, e }, 'Failed to clear IPC directory');
  }
}

async function generateSummary(
  chatJid: string,
  historyBlock: string,
): Promise<string> {
  try {
    const { readEnvFile } = await import('./env.js');
    const envVars = readEnvFile([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
    ]);
    // Always route internal summary calls through the gateway for token tracking
    const apiKey = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    let apiUrl =
      envVars.ANTHROPIC_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      'http://localhost:4000';
    const modelName =
      envVars.ANTHROPIC_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      'claude-3-5-sonnet-20241022';

    if (!apiUrl.endsWith('/v1/chat/completions')) {
      apiUrl = apiUrl.replace(/\/v1\/messages$/, '').replace(/\/$/, '');
      apiUrl = apiUrl + '/v1/chat/completions';
    }

    if (!apiKey) {
      return `由于未配置API密钥，这是您的原始对话记录：\n${historyBlock}`;
    }

    const fetchResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `请帮我总结以下这段近期对话的内容上下文。提取出所有的Active Tasks（当前正在进行的任务、未完成的），以及目前最新的定论、意图和关键信息。请保持简短扼要，使用列表的形式。回复请直接输出总结，不要包含任何寒暄废话。\n\n对话记录：\n${historyBlock}`,
          },
        ],
      }),
    });

    if (fetchResponse.ok) {
      const data = (await fetchResponse.json()) as any;
      const { insertTokenUsage } = await import('./db.js');
      const crypto = await import('crypto');

      const inputTokens =
        data?.usage?.input_tokens || data?.usage?.prompt_tokens || 0;
      const outputTokens =
        data?.usage?.output_tokens || data?.usage?.completion_tokens || 0;

      insertTokenUsage({
        id: crypto.randomUUID(),
        group_id: 'system',
        task_id: 'summary',
        timestamp: new Date().toISOString(),
        model: modelName,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      });

      return (
        data?.choices?.[0]?.message?.content ||
        data?.content?.[0]?.text ||
        '概括生成的文本为空'
      );
    } else {
      const errText = await fetchResponse.text();
      logger.error(
        { chatJid, status: fetchResponse.status, errText, apiUrl, modelName },
        'Failed to fetch summary from LLM API',
      );
      return `由于摘要生成失败，这是您的原始对话记录：\n${historyBlock}`;
    }
  } catch (e) {
    logger.error({ chatJid, err: e }, 'Error during summary generation');
    return `由于执行报错，这是您的原始对话记录：\n${historyBlock}`;
  }
}
