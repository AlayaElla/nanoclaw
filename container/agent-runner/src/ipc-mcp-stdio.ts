/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "在你仍在工作时立即向用户或群组发送消息。用于进度更新或发送多条消息。可以多次调用。注意：当作为定时任务运行时，你的最终输出不会发送给用户 — 如果需要与用户或群组通信，请使用此工具。",
  {
    text: z.string().describe('要发送的消息文本'),
    sender: z.string().optional().describe('你的角色/身份名称（例如 "研究员"）。设置后，消息将以专用 bot 身份在 Telegram 中显示。'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `安排定时或一次性任务。任务将作为完整的代理运行，可以使用所有工具。

上下文模式 - 根据任务类型选择：
\u2022 "group"：任务在群组的对话上下文中运行，可以访问聊天历史。用于需要了解正在进行的讨论、用户偏好或最近交互的任务。
\u2022 "isolated"：任务在全新会话中运行，没有对话历史。用于不需要先前上下文的独立任务。使用隔离模式时，请在提示中包含所有必要的上下文。

如果不确定使用哪种模式，可以询问用户。例如：
- "提醒我关于我们讨论的内容" \u2192 group（需要对话上下文）
- "每天早上查看天气" \u2192 isolated（自包含任务）
- "跟进我的请求" \u2192 group（需要知道请求了什么）
- "生成每日报告" \u2192 isolated（只需要提示中的指令）

消息行为 - 任务代理的输出会发送给用户或群组。它也可以使用 send_message 进行即时发送，或用 <internal> 标签包裹输出以抑制发送。在提示中说明代理是否应该：
\u2022 始终发送消息（例如，提醒、每日简报）
\u2022 仅在有内容可报告时发送消息（例如，"如果...则通知我"）
\u2022 永不发送消息（后台维护任务）

时间格式（所有时间均为本地时区）：
\u2022 cron：标准 cron 表达式（例如，"*/5 * * * *" 每5分钟，"0 9 * * *" 每天本地时间上午9点）
\u2022 interval：运行间隔毫秒数（例如，"300000" 5分钟，"3600000" 1小时）
\u2022 once：本地时间，不带 "Z" 后缀（例如，"2026-02-01T15:30:00"）。不要使用 UTC/Z 后缀。`,
  {
    prompt: z.string().describe('任务运行时代理应该做什么。对于隔离模式，在此处包含所有必要上下文。'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=在特定时间定时运行，interval=每隔 N 毫秒运行，once=在特定时间运行一次'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: 毫秒数如 "300000" | once: 本地时间戳如 "2026-02-01T15:30:00"（无Z后缀！）'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=在聊天历史和记忆中运行，isolated=全新会话（在提示中包含上下文）'),
    target_group_jid: z.string().optional().describe('（仅主群组）要为其安排任务的群组 JID。默认为当前群组。'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "列出所有定时任务。主群组：显示所有任务。其他群组：仅显示该群组的任务。",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  '暂停一个定时任务。在恢复之前不会运行。',
  { task_id: z.string().describe('要暂停的任务 ID') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  '恢复一个已暂停的任务。',
  { task_id: z.string().describe('要恢复的任务 ID') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  '取消并删除一个定时任务。',
  { task_id: z.string().describe('要取消的任务 ID') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `注册一个新的聊天/群组，使代理可以在那里响应消息。仅限主群组使用。

使用 available_groups.json 找到群组的 JID。文件夹名必须带通道前缀："{channel}_{group-name}"（例如 "whatsapp_family-chat"、"telegram_dev-team"、"discord_general"）。群组名部分使用小写和连字符。`,
  {
    jid: z.string().describe('聊天 JID（例如 "120363336345536173@g.us"、"tg:-1001234567890"、"dc:1234567890123456"）'),
    name: z.string().describe('群组显示名称'),
    folder: z.string().describe('带通道前缀的文件夹名（例如 "whatsapp_family-chat"、"telegram_dev-team"）'),
    trigger: z.string().describe('触发词（例如 "@Andy"）'),
    bot_token: z.string().optional().describe('Bot token 的环境变量名（例如 "TELEGRAM_BOT_TOKEN_2"）。用于多 bot 隔离。'),
    assistant_name: z.string().optional().describe('该群组的助手名称（例如 "星月"、"星梦"）'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, any> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };
    if (args.bot_token) data.botToken = args.bot_token;
    if (args.assistant_name) data.assistantName = args.assistant_name;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'rag_search',
  `使用语义搜索来搜索对话记忆。使用场景：
• 用户询问之前讨论过的内容（"上次说的..."、"之前提到的..."）
• 你需要过去对话的上下文
• 寻找聊天历史中的特定信息

返回按相似度排序的最相关历史消息。`,
  {
    query: z.string().describe('自然语言搜索查询（例如 "上次讨论的项目方案"、"用户的偏好设置"）'),
    top_k: z.number().optional().default(5).describe('返回结果数量（默认：5）'),
  },
  async (args) => {
    const requestId = `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write search request via IPC
    const data = {
      type: 'rag_search',
      query: args.query,
      topK: args.top_k || 5,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(TASKS_DIR, data);

    // Poll for result file (host writes it after processing)
    const resultDir = path.join(IPC_DIR, 'rag_results');
    const resultPath = path.join(resultDir, `${requestId}.json`);
    const timeout = 10_000; // 10 second timeout
    const pollInterval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(resultPath)) {
        try {
          const resultData = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath); // Clean up

          if (!resultData.results || resultData.results.length === 0) {
            return {
              content: [{ type: 'text' as const, text: '没有找到相关的历史记忆。' }],
            };
          }

          const formatted = resultData.results
            .map((r: { text: string; role: string; sender_name: string; timestamp: string; score: number }, i: number) => {
              const role = r.role === 'user' ? `👤 ${r.sender_name || 'User'}` : '🤖 Assistant';
              const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
              return `[${i + 1}] ${role} (${time}, 相关度: ${(r.score * 100).toFixed(0)}%)\n${r.text}`;
            })
            .join('\n\n---\n\n');

          return {
            content: [{ type: 'text' as const, text: `搜索 "${args.query}" 的结果:\n\n${formatted}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `读取搜索结果失败: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: '搜索超时，请稍后重试。' }],
      isError: true,
    };
  },
);

// --- X Integration Tools (main group only) ---
if (isMain) {
  const X_RESULTS_DIR = path.join(IPC_DIR, 'x_results');

  async function waitForXResult(requestId: string, maxWait = 120000): Promise<{ success: boolean; message: string }> {
    const resultFile = path.join(X_RESULTS_DIR, `${requestId}.json`);
    let elapsed = 0;
    while (elapsed < maxWait) {
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);
          return result;
        } catch { return { success: false, message: 'Failed to read result' }; }
      }
      await new Promise(r => setTimeout(r, 1000));
      elapsed += 1000;
    }
    return { success: false, message: 'Request timed out' };
  }

  server.tool('x_post', '发推文到 X (Twitter)。仅主群组可用。', { content: z.string().max(280).describe('推文内容（最多280字符）') }, async (args) => {
    const requestId = `xpost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_post', requestId, content: args.content, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });

  server.tool('x_like', '点赞 X (Twitter) 推文。', { tweet_url: z.string().describe('推文URL') }, async (args) => {
    const requestId = `xlike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_like', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });

  server.tool('x_reply', '回复 X (Twitter) 推文。', { tweet_url: z.string().describe('推文URL'), content: z.string().max(280).describe('回复内容') }, async (args) => {
    const requestId = `xreply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_reply', requestId, tweetUrl: args.tweet_url, content: args.content, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });

  server.tool('x_retweet', '转推 X (Twitter) 推文。', { tweet_url: z.string().describe('推文URL') }, async (args) => {
    const requestId = `xretweet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_retweet', requestId, tweetUrl: args.tweet_url, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });

  server.tool('x_quote', '引用 X (Twitter) 推文。', { tweet_url: z.string().describe('推文URL'), comment: z.string().max(280).describe('引用评论') }, async (args) => {
    const requestId = `xquote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_quote', requestId, tweetUrl: args.tweet_url, comment: args.comment, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });

  server.tool('x_trends', '获取 X (Twitter) 全球热门推文。返回当前最热门的推文列表，包含作者、内容和发布时间。', { count: z.number().optional().default(10).describe('要获取的热门推文数量（默认10，最多20）') }, async (args) => {
    const requestId = `xtrends-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { type: 'x_trends', requestId, count: args.count || 10, groupFolder, timestamp: new Date().toISOString() });
    const result = await waitForXResult(requestId);
    return { content: [{ type: 'text' as const, text: result.message }], isError: !result.success };
  });
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
