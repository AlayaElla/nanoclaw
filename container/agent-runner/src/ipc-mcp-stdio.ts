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
const TASK_RESULTS_DIR = path.join(IPC_DIR, 'task_results');

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

async function waitForTaskResult(requestId: string, maxWaitMs = 10000): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(TASK_RESULTS_DIR, `${requestId}.json`);
  const pollInterval = 200;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return { success: false, message: 'Failed to parse task result JSON.' };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  return { success: false, message: 'Request timed out waiting for the host process.' };
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
  'send_media',
  `向用户或群组发送图片、视频、音频或文件。支持三种来源：
• 本地文件路径（file_path）：发送容器内任意文件，如 AI 生成的图片、脚本输出等
• 网络 URL（url）：发送网络上的图片、视频、音频链接，会自动下载并发送
• 缓存媒体 ID（media_id）：发送之前缓存的历史媒体文件

三个来源参数选填一个即可。media_type 可以省略，会根据文件扩展名自动检测。`,
  {
    file_path: z.string().optional().describe('容器内文件的绝对路径（例如 /tmp/chart.png）'),
    url: z.string().optional().describe('网络媒体 URL（例如 https://example.com/photo.jpg）'),
    media_id: z.string().optional().describe('缓存的历史媒体 MediaID（例如 photo_171000_abc123.jpg）'),
    media_type: z.enum(['photo', 'video', 'audio', 'document']).optional().describe('媒体类型。省略时根据扩展名自动检测'),
    caption: z.string().optional().describe('媒体附带的文字说明'),
  },
  async (args) => {
    const MEDIA_CACHE = path.join('/workspace/group/.claude/media_cache');
    fs.mkdirSync(MEDIA_CACHE, { recursive: true });

    // Determine media type from extension
    const detectType = (filename: string): 'photo' | 'video' | 'audio' | 'document' => {
      const ext = path.extname(filename).toLowerCase();
      const photoExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
      const audioExts = ['.mp3', '.ogg', '.wav', '.flac', '.aac', '.m4a', '.opus'];
      if (photoExts.includes(ext)) return 'photo';
      if (videoExts.includes(ext)) return 'video';
      if (audioExts.includes(ext)) return 'audio';
      return 'document';
    };

    // Detect from Content-Type header
    const detectTypeFromMime = (contentType: string): 'photo' | 'video' | 'audio' | 'document' => {
      if (contentType.startsWith('image/')) return 'photo';
      if (contentType.startsWith('video/')) return 'video';
      if (contentType.startsWith('audio/')) return 'audio';
      return 'document';
    };

    let buffer: Buffer;
    let detectedType: 'photo' | 'video' | 'audio' | 'document' = 'document';
    let ext = '';

    if (args.file_path) {
      // Source: local file
      try {
        buffer = fs.readFileSync(args.file_path);
        detectedType = detectType(args.file_path);
        ext = path.extname(args.file_path).toLowerCase() || '.bin';
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed to read file: ${err.message}` }], isError: true };
      }
    } else if (args.url) {
      // Source: URL
      try {
        const resp = await fetch(args.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        buffer = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get('content-type') || '';
        detectedType = detectTypeFromMime(contentType);
        // Try to get extension from URL path
        try {
          const urlPath = new URL(args.url).pathname;
          ext = path.extname(urlPath).toLowerCase();
        } catch { ext = ''; }
        if (!ext) {
          // Fallback extension from mime
          const mimeExts: Record<string, string> = {
            'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
            'video/mp4': '.mp4', 'video/webm': '.webm',
            'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
          };
          ext = mimeExts[contentType.split(';')[0]] || '.bin';
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed to download URL: ${err.message}` }], isError: true };
      }
    } else if (args.media_id) {
      // Source: cached media — reuse directly, no copy needed
      const safeId = path.basename(args.media_id);
      const cachedPath = path.join(MEDIA_CACHE, safeId);
      if (!fs.existsSync(cachedPath)) {
        return { content: [{ type: 'text' as const, text: `MediaID ${args.media_id} not found in cache.` }], isError: true };
      }
      detectedType = detectType(safeId);
      const mediaType = args.media_type || detectedType;

      // Write IPC message directly with original mediaId
      const data = {
        type: 'media_message',
        chatJid,
        mediaId: safeId,
        mediaType,
        caption: args.caption || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, data);

      const fileSize = fs.statSync(cachedPath).size;
      return { content: [{ type: 'text' as const, text: `Media sent (${mediaType}, ${fileSize} bytes).\n\n【重要提醒】：该媒体已发送给用户。如果不再需要补充说明，请直接结束输出，或者将后续的思考包裹在 <internal> 标签中，避免向用户重复发送废话。` }] };
    } else {
      return { content: [{ type: 'text' as const, text: 'Must provide one of: file_path, url, or media_id.' }], isError: true };
    }

    const mediaType = args.media_type || detectedType;

    // Save to media_cache with a unique name so the host can read it
    const mediaId = `send_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const cachePath = path.join(MEDIA_CACHE, mediaId);
    fs.writeFileSync(cachePath, buffer);

    // Write IPC message for host to pick up
    const data = {
      type: 'media_message',
      chatJid,
      mediaId,
      mediaType,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Media sent (${mediaType}, ${buffer.length} bytes).\n\n【重要提醒】：该媒体已发送给用户。如果不再需要补充说明，请直接结束输出，或者将后续的思考包裹在 <internal> 标签中，避免向用户重复发送废话。` }] };
  },
);

server.tool(
  'generate_image',
  `使用 AI 生成图片。支持两种模式：
• 文生图（text-to-image）：根据文字描述生成图片。只需提供 prompt。
• 图生图（image-to-image）：基于已有图片进行修改/编辑。需同时提供 prompt 和 source_image（本地路径或 media_id）。
【重要提醒】：生成的图片会自动发送到聊天中。为了避免连续发送两条重复消息，调用此工具后，请**必须**将你的所有后续回复文本（如"图片已生成"）包裹在 <internal>...</internal> 标签中，或者直接结束输出。`,
  {
    prompt: z.string().describe('图片描述或编辑指令（例如"一只在月光下散步的猫"）'),
    source_image: z.string().optional().describe('图生图的源图片路径（容器内绝对路径，例如 /tmp/input.png）或缓存的 MediaID'),
    model: z.enum(['gpt-image-1', 'seedream-3.0', 'imagen4', 'flux-kontext-max', 'flux-kontext-pro']).optional().default('gpt-image-1').describe('模型选择（默认 gpt-image-1）'),
    size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional().default('1024x1024').describe('图片尺寸'),
    caption: z.string().optional().describe('发送时附带的文字说明'),
  },
  async (args) => {
    const apiKey = process.env.WHATAI_API_KEY;
    if (!apiKey) {
      return { content: [{ type: 'text' as const, text: 'WHATAI_API_KEY not configured. Cannot generate images.' }], isError: true };
    }

    const MEDIA_CACHE = path.join('/workspace/group/.claude/media_cache');
    fs.mkdirSync(MEDIA_CACHE, { recursive: true });

    try {
      let b64Data: string;

      if (args.source_image) {
        // Image-to-image: use /v1/images/edits with multipart form-data
        let imageBuffer: Buffer;
        let imageName: string;

        // Check if it's a media_id (cached) or a file path
        const safeId = path.basename(args.source_image);
        const cachedPath = path.join(MEDIA_CACHE, safeId);
        if (fs.existsSync(cachedPath)) {
          imageBuffer = fs.readFileSync(cachedPath);
          imageName = safeId;
        } else if (fs.existsSync(args.source_image)) {
          imageBuffer = fs.readFileSync(args.source_image);
          imageName = path.basename(args.source_image);
        } else {
          return { content: [{ type: 'text' as const, text: `Source image not found: ${args.source_image}` }], isError: true };
        }

        // Build multipart form-data manually
        const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
        const parts: Buffer[] = [];

        // prompt field
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${args.prompt}\r\n`));

        // model field
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${args.model || 'gpt-image-1'}\r\n`));

        // size field (optional)
        if (args.size) {
          parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${args.size}\r\n`));
        }

        // image file
        const mimeType = imageName.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${imageName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
        parts.push(imageBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const resp = await fetch('https://api.whatai.cc/v1/images/edits', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return { content: [{ type: 'text' as const, text: `Image edit API error (${resp.status}): ${errText.slice(0, 500)}` }], isError: true };
        }

        const result = await resp.json() as { data?: { b64_json?: string; url?: string }[] };
        b64Data = result.data?.[0]?.b64_json || '';
        if (!b64Data) {
          // Try URL fallback
          const imageUrl = result.data?.[0]?.url;
          if (imageUrl) {
            const dlResp = await fetch(imageUrl);
            const dlBuf = Buffer.from(await dlResp.arrayBuffer());
            b64Data = dlBuf.toString('base64');
          } else {
            return { content: [{ type: 'text' as const, text: 'API returned no image data.' }], isError: true };
          }
        }
      } else {
        // Text-to-image: use /v1/images/generations with JSON body
        const payload = {
          prompt: args.prompt,
          model: args.model || 'gpt-image-1',
          size: args.size || '1024x1024',
          n: 1,
        };

        const resp = await fetch('https://api.whatai.cc/v1/images/generations', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          return { content: [{ type: 'text' as const, text: `Image generation API error (${resp.status}): ${errText.slice(0, 500)}` }], isError: true };
        }

        const result = await resp.json() as { data?: { b64_json?: string; url?: string }[] };
        b64Data = result.data?.[0]?.b64_json || '';
        if (!b64Data) {
          const imageUrl = result.data?.[0]?.url;
          if (imageUrl) {
            const dlResp = await fetch(imageUrl);
            const dlBuf = Buffer.from(await dlResp.arrayBuffer());
            b64Data = dlBuf.toString('base64');
          } else {
            return { content: [{ type: 'text' as const, text: 'API returned no image data.' }], isError: true };
          }
        }
      }

      // Save to media_cache by streaming base64 decode directly to file
      const mediaId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
      const cachePath = path.join(MEDIA_CACHE, mediaId);
      // Write in chunks to avoid holding entire decoded buffer in memory
      const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks strikes a balance between memory and loop overhead
      const fd = fs.openSync(cachePath, 'w');
      let totalBytes = 0;
      try {
        for (let i = 0; i < b64Data.length; i += CHUNK_SIZE) {
          const chunk = Buffer.from(b64Data.slice(i, i + CHUNK_SIZE), 'base64');
          fs.writeSync(fd, chunk);
          totalBytes += chunk.length;
        }
      } finally {
        fs.closeSync(fd);
      }
      b64Data = ''; // Release the large base64 string

      // Auto-send to chat via IPC
      const ipcData = {
        type: 'media_message',
        chatJid,
        mediaId,
        mediaType: 'photo',
        caption: args.caption || undefined,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      writeIpcFile(MESSAGES_DIR, ipcData);

      return { content: [{ type: 'text' as const, text: `Image generated and sent (${args.model || 'gpt-image-1'}, ${args.size || '1024x1024'}, ${totalBytes} bytes). MediaID: ${mediaId}\n\n【重要提醒】：图片已自动发送给用户。如果不需要补充其他文字，请直接完成任务，或者将你的任何后续回复或思考包裹在 <internal>...</internal> 标签中，避免向用户发送重复无用的确认消息。` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Image generation failed: ${err.message}` }], isError: true };
    }
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
    const requestId = `pause-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      requestId,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const result = await waitForTaskResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'resume_task',
  '恢复一个已暂停的任务。',
  { task_id: z.string().describe('要恢复的任务 ID') },
  async (args) => {
    const requestId = `resume-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      requestId,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const result = await waitForTaskResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
  },
);

server.tool(
  'cancel_task',
  '取消并删除一个定时任务。',
  { task_id: z.string().describe('要取消的任务 ID') },
  async (args) => {
    const requestId = `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      requestId,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const result = await waitForTaskResult(requestId);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      isError: !result.success,
    };
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
            .map((r: { text: string; role: string; sender_name: string; timestamp: string; chat_source: string; score: number }, i: number) => {
              const role = r.role === 'user' ? `👤 ${r.sender_name || 'User'}` : '🤖 Assistant';
              const time = r.timestamp ? new Date(r.timestamp).toLocaleString() : '';
              const source = r.chat_source ? ` | 来源: ${r.chat_source}` : '';
              return `[${i + 1}] ${role} (${time}, 相关度: ${(r.score * 100).toFixed(0)}%${source})\n${r.text}`;
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

// --- Media Analytics Tools ---

const MEDIA_CACHE_DIR = path.join('/workspace/group/.claude/media_cache');

function getCachedMediaPath(mediaId: string): string | null {
  const safeId = path.basename(mediaId); // Prevent directory traversal
  const filePath = path.join(MEDIA_CACHE_DIR, safeId);
  return fs.existsSync(filePath) ? filePath : null;
}

server.tool(
  'mcp__media__get_cached_media',
  '获取本地持久化缓存的历史图片、视频或语音的绝对物理路径。你可以使用任何本机 CLI 或 Python 脚本、图像处理工具对获得的绝对路径文件进行处理。',
  { mediaId: z.string().describe('历史消息中带有的 MediaID (例如 img_171000.._.jpg)') },
  async (args) => {
    const filePath = getCachedMediaPath(args.mediaId);
    if (!filePath) {
      return { content: [{ type: 'text' as const, text: `Error: MediaID ${args.mediaId} not found in cache. It may have expired.` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: `Media file absolute path:\n${filePath}` }] };
  }
);

server.tool(
  'mcp__media__describe_cached_image',
  '重新使用云端大视觉模型分析缓存的历史图片。如果原图描述不满足你的需求，可以用这个工具指定特定的 prompt 重新问图片细节。',
  {
    mediaId: z.string().describe('图片的 MediaID (例如 xxx.jpg)'),
    prompt: z.string().describe('特定的分析指令，例如"仔细看看右下角有什么字"')
  },
  async (args) => {
    const filePath = getCachedMediaPath(args.mediaId);
    if (!filePath) {
      return { content: [{ type: 'text' as const, text: `Error: MediaID ${args.mediaId} not found in cache.` }], isError: true };
    }
    const apiKey = process.env.VISION_API_KEY;
    if (!apiKey) return { content: [{ type: 'text' as const, text: 'VISION_API_KEY not configured.' }], isError: true };

    try {
      const buffer = fs.readFileSync(filePath);
      const dataUri = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      const url = `${process.env.VISION_BASE_URL?.replace(/\/$/, '') || 'https://coding.dashscope.aliyuncs.com/v1'}/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.VISION_MODEL || 'qwen3.5-plus',
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }, { type: 'text', text: args.prompt }] }],
          stream: false,
        }),
      });

      if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
      const result = await response.json() as any;
      const content = result.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((i: any) => i.text || '').join('') : 'No description returned');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Vision API error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'mcp__media__describe_cached_video',
  '重新分析缓存的历史视频。',
  {
    mediaId: z.string().describe('视频的 MediaID (例如 xxx.mp4)'),
    prompt: z.string().describe('让模型重点关注的视频分析提示词')
  },
  async (args) => {
    const filePath = getCachedMediaPath(args.mediaId);
    if (!filePath) {
      return { content: [{ type: 'text' as const, text: `Error: MediaID ${args.mediaId} not found in cache.` }], isError: true };
    }
    const apiKey = process.env.VISION_API_KEY;
    if (!apiKey) return { content: [{ type: 'text' as const, text: 'VISION_API_KEY not configured.' }], isError: true };

    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.mov' ? 'video/quicktime' : (ext === '.webm' ? 'video/webm' : 'video/mp4');
      const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;
      const url = `${process.env.VISION_BASE_URL?.replace(/\/$/, '') || 'https://coding.dashscope.aliyuncs.com/v1'}/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.VISION_MODEL || 'qwen3.5-plus',
          messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: dataUri }, fps: 2 }, { type: 'text', text: args.prompt }] }],
          stream: false,
        }),
      });

      if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
      const result = await response.json() as any;
      const content = result.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((i: any) => i.text || '').join('') : 'No description returned');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Video Vision API error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'mcp__media__transcribe_cached_audio',
  '重新提取缓存历史语音的文本。可以用于语音遗漏或者听不清的场景。',
  { mediaId: z.string().describe('语音的 MediaID (例如 xxx.ogg)') },
  async (args) => {
    const filePath = getCachedMediaPath(args.mediaId);
    if (!filePath) {
      return { content: [{ type: 'text' as const, text: `Error: MediaID ${args.mediaId} not found in cache.` }], isError: true };
    }
    const apiKey = process.env.EMBEDDING_API_KEY;
    if (!apiKey) return { content: [{ type: 'text' as const, text: 'EMBEDDING_API_KEY not configured.' }], isError: true };

    try {
      const buffer = fs.readFileSync(filePath);
      const dataUri = `data:audio/ogg;base64,${buffer.toString('base64')}`;

      const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'qwen3-asr-flash',
          messages: [
            { role: 'system', content: [{ text: '' }] },
            { role: 'user', content: [{ audio: dataUri }] }
          ],
          stream: false,
          asr_options: { enable_lid: true, enable_itn: false },
        }),
      });

      if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`);
      const result = await response.json() as any;
      const content = result.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((i: any) => i.text || '').join('') : 'No transcription returned');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Whisper API error: ${err.message}` }], isError: true };
    }
  }
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
