import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudioMessage } from '../transcription.js';
import { describeImage, describeVideo } from '../vision.js';

export interface FeishuChannelOpts extends ChannelOpts {
  appId: string;
  appSecret: string;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client!: lark.Client;
  private connected = false;
  private botOpenId: string | undefined;

  private opts: FeishuChannelOpts;

  /** Map numeric hash → Feishu string message_id for status messages */
  private statusIdMap = new Map<number, string>();

  /** Buffered media waiting for a possible follow-up text (key: chatJid) */
  private pendingMedia = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    chatJid: string;
    buffer: Buffer;
    timestamp: string;
    senderName: string;
    sender: string;
    msgId: string;
    mediaType: 'photo' | 'video';
    mimeType?: string;
  }>();
  /** How long to wait for a follow-up text after receiving media (ms) */
  private static readonly MEDIA_MERGE_WINDOW = 1000;
  /** Max message length for Feishu (generous limit) */
  private static readonly MAX_MESSAGE_LENGTH = 10000;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const { appId, appSecret } = this.opts;

    this.client = new lark.Client({ appId, appSecret });

    // Fetch bot's own open_id so we can detect our own messages
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = (resp as any)?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Feishu bot info, bot message detection may not work');
    }

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    });

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Connected to Feishu via WebSocket');
  }

  // ─── Inbound Message Handling ──────────────────────────────────────

  private async handleMessage(data: any): Promise<void> {
    // SDK may pass data as {event: {message, sender}} or directly as {message, sender}
    const msg = data?.message || data?.event?.message;
    const sender = data?.sender || data?.event?.sender;
    if (!msg) return;

    // Skip bot's own messages
    if (sender?.sender_id?.open_id && sender.sender_id.open_id === this.botOpenId) return;

    const chatId = msg.chat_id;
    if (!chatId) return;

    const chatJid = `${chatId}@feishu`;
    const timestamp = new Date(Number(msg.create_time)).toISOString();
    const senderOpenId = sender?.sender_id?.open_id || 'unknown';
    const senderName = await this.resolveSenderName(senderOpenId);

    // Notify chat metadata
    const isGroup = msg.chat_type === 'group';
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    const messageType = msg.message_type;
    const messageId = msg.message_id || '';

    // Check for @mention in groups — extract from mentions array
    const isMentioned = this.isBotMentioned(msg);

    // Route by message type
    switch (messageType) {
      case 'text':
        await this.handleTextMessage(msg, chatJid, timestamp, senderName, senderOpenId, messageId, isGroup, isMentioned);
        break;
      case 'image':
        await this.handleImageMessage(msg, chatJid, timestamp, senderName, senderOpenId, messageId, isGroup);
        break;
      case 'video':
      case 'media':
        await this.handleVideoMessage(msg, chatJid, timestamp, senderName, senderOpenId, messageId, isGroup);
        break;
      case 'audio':
        await this.handleAudioMessage(msg, chatJid, timestamp, senderName, senderOpenId, messageId, isGroup);
        break;
      case 'file':
        await this.handleFileMessage(msg, chatJid, timestamp, senderName, senderOpenId, messageId, isGroup);
        break;
      case 'sticker':
        await this.handleStickerMessage(chatJid, timestamp, senderName, senderOpenId, messageId, isGroup);
        break;
      default:
        // Unsupported message types — store placeholder
        this.deliverIfRegistered(chatJid, {
          id: messageId,
          chat_jid: chatJid,
          sender: senderOpenId,
          sender_name: senderName,
          content: `[${messageType || 'Unknown'} Message]`,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });
        break;
    }
  }

  private async handleTextMessage(
    msg: any, chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string,
    isGroup: boolean, isMentioned: boolean,
  ): Promise<void> {
    let content = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      content = parsed.text || '';
    } catch {
      return;
    }
    if (!content) return;

    // Strip @mention tags from content (飞书 format: @_user_1 etc.)
    content = content.replace(/@_user_\d+/g, '').trim();

    // Command handling — check before delivering to agent
    if (content.startsWith('/')) {
      const handled = await this.handleCommand(content, chatJid, isGroup, timestamp);
      if (handled) return;
    }

    // Check if there's pending media waiting for a follow-up text
    const pending = this.pendingMedia.get(chatJid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMedia.delete(chatJid);
      logger.info(
        { chatJid, mediaType: pending.mediaType },
        'Merging follow-up text with pending media',
      );
      await this.processAndStoreMedia(pending, content);
      // Also store the text message itself
    }

    this.deliverIfRegistered(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private async handleImageMessage(
    msg: any, chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string, _isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let imageKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      imageKey = parsed.image_key || '';
    } catch { /* ignore */ }

    if (!imageKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
        content: '[Photo - no image key]', timestamp, is_from_me: false, is_bot_message: false,
      });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadMessageResource(msg.message_id, imageKey, 'image');
    } catch (err) {
      logger.error({ chatJid, err }, 'Feishu image download failed');
      this.deliverIfRegistered(chatJid, {
        id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
        content: '[Photo - download failed]', timestamp, is_from_me: false, is_bot_message: false,
      });
      return;
    }

    // No caption for image messages in Feishu — buffer and wait for follow-up text
    const existing = this.pendingMedia.get(chatJid);
    if (existing) {
      clearTimeout(existing.timer);
      await this.processAndStoreMedia(existing, undefined);
    }

    const timer = setTimeout(() => {
      const entry = this.pendingMedia.get(chatJid);
      if (entry && entry.msgId === msgId) {
        this.pendingMedia.delete(chatJid);
        logger.info({ chatJid }, 'No follow-up text, processing photo with generic prompt');
        this.processAndStoreMedia(entry, undefined).catch((err) => {
          logger.error({ chatJid, err }, 'Deferred photo processing failed');
        });
      }
    }, FeishuChannel.MEDIA_MERGE_WINDOW);

    this.pendingMedia.set(chatJid, {
      timer, chatJid, buffer, timestamp,
      senderName, sender, msgId, mediaType: 'photo',
    });
    logger.info({ chatJid, bytes: buffer.length }, 'Photo buffered, waiting for follow-up text');
  }

  private async handleVideoMessage(
    msg: any, chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string, _isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let fileKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileKey = parsed.file_key || '';
    } catch { /* ignore */ }

    if (!fileKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
        content: '[Video - no file key]', timestamp, is_from_me: false, is_bot_message: false,
      });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadMessageResource(msg.message_id, fileKey, 'file');
    } catch (err) {
      logger.error({ chatJid, err }, 'Feishu video download failed');
      this.deliverIfRegistered(chatJid, {
        id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
        content: '[Video - download failed]', timestamp, is_from_me: false, is_bot_message: false,
      });
      return;
    }

    // Buffer video, wait for follow-up text
    const existing = this.pendingMedia.get(chatJid);
    if (existing) {
      clearTimeout(existing.timer);
      await this.processAndStoreMedia(existing, undefined);
    }

    const timer = setTimeout(() => {
      const entry = this.pendingMedia.get(chatJid);
      if (entry && entry.msgId === msgId) {
        this.pendingMedia.delete(chatJid);
        logger.info({ chatJid }, 'No follow-up text, processing video with generic prompt');
        this.processAndStoreMedia(entry, undefined).catch((err) => {
          logger.error({ chatJid, err }, 'Deferred video processing failed');
        });
      }
    }, FeishuChannel.MEDIA_MERGE_WINDOW);

    this.pendingMedia.set(chatJid, {
      timer, chatJid, buffer, timestamp,
      senderName, sender, msgId, mediaType: 'video', mimeType: 'video/mp4',
    });
    logger.info({ chatJid, bytes: buffer.length }, 'Video buffered, waiting for follow-up text');
  }

  private async handleAudioMessage(
    msg: any, chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string, isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let fileKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileKey = parsed.file_key || '';
    } catch { /* ignore */ }

    if (!fileKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
        content: '[Voice Message - no file key]', timestamp, is_from_me: false, is_bot_message: false,
      });
      return;
    }

    let finalContent: string;
    try {
      const buffer = await this.downloadMessageResource(msg.message_id, fileKey, 'file');

      // Cache media
      const mediaId = `voice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.ogg`;
      const cacheDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude', 'media_cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, mediaId), buffer);

      const transcript = await transcribeAudioMessage(buffer);
      finalContent = transcript
        ? `[Voice: ${transcript} | MediaID: ${mediaId}]`
        : `[Voice Message - transcription unavailable | MediaID: ${mediaId}]`;
      logger.info({ chatJid, bytes: buffer.length }, 'Voice message transcribed and cached');
    } catch (err) {
      logger.error({ chatJid, err }, 'Voice transcription/caching failed');
      finalContent = '[Voice Message - transcription failed]';
    }

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
    this.deliverIfRegistered(chatJid, {
      id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
      content: finalContent, timestamp, is_from_me: false, is_bot_message: false,
    });
  }

  private async handleFileMessage(
    msg: any, chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string, isGroup: boolean,
  ): Promise<void> {
    let fileName = 'file';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileName = parsed.file_name || 'file';
    } catch { /* ignore */ }

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
    this.deliverIfRegistered(chatJid, {
      id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
      content: `[Document: ${fileName}]`, timestamp, is_from_me: false, is_bot_message: false,
    });
  }

  private async handleStickerMessage(
    chatJid: string, timestamp: string,
    senderName: string, sender: string, msgId: string, isGroup: boolean,
  ): Promise<void> {
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
    this.deliverIfRegistered(chatJid, {
      id: msgId, chat_jid: chatJid, sender, sender_name: senderName,
      content: '[Sticker]', timestamp, is_from_me: false, is_bot_message: false,
    });
  }

  // ─── Commands ──────────────────────────────────────────────────────

  private async handleCommand(content: string, chatJid: string, isGroup: boolean, timestamp: string): Promise<boolean> {
    const cmd = content.split(/\s+/)[0].toLowerCase();

    if (cmd === '/chatid') {
      const chatTypeStr = isGroup ? 'Group' : 'Private';
      await this.sendMessage(chatJid, `Chat ID: ${chatJid}\nType: ${chatTypeStr}`);
      return true;
    }

    if (cmd === '/ping') {
      await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online. (feishu)`);
      return true;
    }

    if (cmd === '/clear') {
      await this.handleClearCommand(chatJid);
      return true;
    }

    if (cmd === '/compact') {
      await this.handleCompactCommand(chatJid, timestamp);
      return true;
    }

    return false;
  }

  private async handleClearCommand(chatJid: string): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await this.sendMessage(chatJid, 'This chat is not registered. Cannot clear session.');
      return;
    }

    try {
      const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder);

      let clearedOptions = false;
      if (fs.existsSync(groupSessionsDir)) {
        fs.rmSync(groupSessionsDir, { recursive: true, force: true });
        clearedOptions = true;
      }

      if (clearedOptions) {
        logger.info({ chatJid }, 'Workspace data cleared');
      } else {
        logger.info({ chatJid }, 'No workspace data found to clear');
      }

      // Clear Database Data (Tasks, Messages) for this JID
      const { clearChatData } = await import('../db.js');
      clearChatData(chatJid);

      await this.sendMessage(chatJid, '✅ 清理成功！您的工作区和所有历史对话已完全清空，可以直接开始全新的会话。');
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to clear session data');
      await this.sendMessage(chatJid, '❌ 清理失败，请检查服务器日志。');
    }
  }

  private async handleCompactCommand(chatJid: string, timestamp: string): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await this.sendMessage(chatJid, 'This chat is not registered. Cannot compact session.');
      return;
    }

    try {
      await this.sendMessage(chatJid, 'Compacting session... 正在读取数据库并生成对话总结，随后将重置短期记忆。');

      // 1. Fetch recent history from DB
      const { getRecentMessages } = await import('../db.js');
      const recentMessages = getRecentMessages(chatJid, 20);
      let historyBlock = '';
      if (recentMessages && recentMessages.length > 0) {
        for (const msg of recentMessages.reverse()) {
          historyBlock += `[${msg.timestamp}] ${msg.sender_name}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}\n`;
        }
      }

      // 2. Generate summary using LLM API
      let summary = '目前没有先前的上下文可以总结。';
      if (historyBlock) {
        try {
          const envVars = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']);
          const apiKey = envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
          let apiUrl = envVars.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'http://localhost:4000';
          const modelName = envVars.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

          if (!apiUrl.endsWith('/v1/chat/completions')) {
            apiUrl = apiUrl.replace(/\/v1\/messages$/, '').replace(/\/$/, '');
            apiUrl = apiUrl + '/v1/chat/completions';
          }

          if (apiKey) {
            const fetchResponse = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: modelName,
                max_tokens: 1024,
                messages: [
                  {
                    role: 'user',
                    content: `请帮我总结以下这段近期对话的内容上下文。提取出所有的Active Tasks（当前正在进行的任务、未完成的），以及目前最新的定论、意图和关键信息。请保持简短扼要，使用列表的形式。回复请直接输出总结，不要包含任何寒暄废话。\n\n对话记录：\n${historyBlock}`
                  }
                ]
              })
            });

            if (fetchResponse.ok) {
              const data = await fetchResponse.json() as any;
              summary = data?.choices?.[0]?.message?.content
                || data?.content?.[0]?.text
                || '概括生成的文本为空';
            } else {
              const errText = await fetchResponse.text();
              logger.error({ chatJid, status: fetchResponse.status, errText, apiUrl, modelName }, 'Failed to fetch summary from LLM API');
              summary = `由于摘要生成失败，这是您的原始对话记录：\n${historyBlock}`;
            }
          } else {
            summary = `由于未配置API密钥，这是您的原始对话记录：\n${historyBlock}`;
          }
        } catch (e) {
          logger.error({ chatJid, err: e }, 'Error during summary generation');
          summary = `由于执行报错，这是您的原始对话记录：\n${historyBlock}`;
        }
      }

      // 3. Clear Session directories
      // Gracefully shut down active container
      if (this.opts.groupQueue) {
        try {
          this.opts.groupQueue.closeStdin(chatJid);
          await new Promise(r => setTimeout(r, 1000));
          await this.opts.groupQueue.killContainer(chatJid);
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          logger.warn({ chatJid, err: e }, 'Failed to gracefully close container before compact');
        }
      }

      const baseClaudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
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

      // Clear IPC state
      const ipcDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
      try {
        if (fs.existsSync(ipcDir)) {
          fs.rmSync(ipcDir, { recursive: true, force: true });
        }
      } catch (e) {
        logger.warn({ ipcDir, e }, 'Failed to clear IPC directory');
      }

      await new Promise(r => setTimeout(r, 1000));

      // 4. Inject system message with summary
      await this.sendMessage(chatJid, '✅ 总结与清理完成！最新提示词与上下文摘要已就绪，正在唤醒新会话...');
      const content = `[System Status: Session has been compacted to load new system prompts. Your short-term memory was cleared, but your tasks and RAG memory remain intact. The following is a summary of the recent conversational context precisely crafted for you to continue working smoothly:\n\n${summary}\n\nPlease acknowledge this reset and review your active tasks. Respond with "会话已软重置，最新提示词与上下文摘要已自动继承。"]`;

      this.opts.onMessage(chatJid, {
        id: `compact-${Date.now()}`,
        chat_jid: chatJid,
        sender: 'system',
        sender_name: 'SystemAdmin',
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info({ chatJid }, 'Session compacted and summary injected');
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to compact session');
      await this.sendMessage(chatJid, '❌ 软重置失败，请检查服务器日志。');
    }
  }

  // ─── Helper: Deliver message if group is registered ────────────────

  private deliverIfRegistered(chatJid: string, message: {
    id: string; chat_jid: string; sender: string; sender_name: string;
    content: string; timestamp: string; is_from_me: boolean; is_bot_message: boolean;
  }): void {
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, message);
    }
  }

  // ─── Helper: Download message resource ─────────────────────────────

  private async downloadMessageResource(
    messageId: string, fileKey: string, type: 'image' | 'file',
  ): Promise<Buffer> {
    // Use the SDK's token manager to get a tenant access token, then fetch directly
    // because the SDK's request() method doesn't support binary responses well.
    const tokenResp = await (this.client.tokenManager as any).getTenantAccessToken();
    const token = typeof tokenResp === 'string' ? tokenResp : (tokenResp?.tenant_access_token || tokenResp?.token || '');

    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  // ─── Helper: Process and store media via Vision API ────────────────

  private async processAndStoreMedia(
    media: {
      chatJid: string; buffer: Buffer; timestamp: string; senderName: string;
      sender: string; msgId: string; mediaType: 'photo' | 'video'; mimeType?: string;
    },
    userText: string | undefined,
  ): Promise<void> {
    const { chatJid, buffer, timestamp, senderName, sender, msgId, mediaType } = media;
    const label = mediaType === 'photo' ? 'Photo' : 'Video';
    const group = this.opts.registeredGroups()[chatJid];

    // Cache media
    let mediaId = '';
    if (group) {
      const ext = mediaType === 'photo' ? 'jpg' : 'mp4';
      mediaId = `${mediaType}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const cacheDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude', 'media_cache');
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(path.join(cacheDir, mediaId), buffer);
      } catch (e) {
        logger.error({ err: e }, 'Failed to cache media buffer');
      }
    }

    let finalContent: string;
    try {
      let description: string | null;
      if (mediaType === 'photo') {
        description = await describeImage(buffer, userText);
      } else {
        description = await describeVideo(buffer, media.mimeType, userText);
      }

      if (description) {
        finalContent = userText
          ? `[${label}: ${description} | User: ${userText} | MediaID: ${mediaId}]`
          : `[${label}: ${description} | MediaID: ${mediaId}]`;
      } else {
        finalContent = userText
          ? `[${label} - description unavailable | User: ${userText} | MediaID: ${mediaId}]`
          : `[${label} - description unavailable | MediaID: ${mediaId}]`;
      }
      logger.info({ chatJid, bytes: buffer.length, mediaType }, `${label} message processed`);
    } catch (err) {
      logger.error({ chatJid, err, mediaType }, `${label} description failed`);
      finalContent = userText
        ? `[${label} - description failed | User: ${userText}]`
        : `[${label} - description failed]`;
    }

    this.deliverIfRegistered(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: finalContent,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  // ─── Helper: Resolve sender name ──────────────────────────────────

  private senderNameCache = new Map<string, string>();

  private async resolveSenderName(openId: string): Promise<string> {
    if (openId === 'unknown') return 'unknown';

    const cached = this.senderNameCache.get(openId);
    if (cached) return cached;

    try {
      const resp = await this.client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp as any)?.data?.user?.name;
      if (name) {
        this.senderNameCache.set(openId, name);
        return name;
      }
    } catch {
      // Permission may not be available — fall back silently
    }

    // Fall back to short form of open_id
    const shortId = openId.length > 8 ? openId.slice(0, 8) + '…' : openId;
    this.senderNameCache.set(openId, shortId);
    return shortId;
  }

  // ─── Helper: Check if bot is mentioned ─────────────────────────────

  private isBotMentioned(msg: any): boolean {
    if (!this.botOpenId) return false;
    const mentions = msg.mentions;
    if (!Array.isArray(mentions)) return false;
    return mentions.some((m: any) => m.id?.open_id === this.botOpenId);
  }

  // ─── Outbound: Send Message ────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    try {
      // Split long messages
      const MAX = FeishuChannel.MAX_MESSAGE_LENGTH;
      if (prefixed.length <= MAX) {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: prefixed }),
          },
        });
      } else {
        for (let i = 0; i < prefixed.length; i += MAX) {
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: prefixed.slice(i, i + MAX) }),
            },
          });
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  // ─── Outbound: Send Media ──────────────────────────────────────────

  async sendMedia(jid: string, buffer: Buffer, mediaType: 'photo' | 'video' | 'audio' | 'document', caption?: string): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');

    try {
      if (mediaType === 'photo') {
        // Upload image first to get image_key
        const uploadResp = await this.client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: buffer,
          },
        });
        const imageKey = (uploadResp as any)?.data?.image_key || (uploadResp as any)?.image_key;
        if (!imageKey) {
          logger.error({ jid }, 'Failed to upload image: no image_key returned');
          // Fall back to sending caption as text
          if (caption) await this.sendMessage(jid, `[Image] ${caption}`);
          return;
        }

        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });

        // Send caption separately if present
        if (caption) {
          await this.sendMessage(jid, caption);
        }
      } else if (mediaType === 'audio') {
        // Upload as file and send as audio
        const uploadResp = await this.client.im.v1.file.create({
          data: {
            file_type: 'opus',
            file_name: `audio_${Date.now()}.opus`,
            file: buffer,
          },
        });
        const fileKey = (uploadResp as any)?.data?.file_key || (uploadResp as any)?.file_key;
        if (!fileKey) {
          logger.error({ jid }, 'Failed to upload audio file');
          if (caption) await this.sendMessage(jid, `[Audio] ${caption}`);
          return;
        }

        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'audio',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
        if (caption) await this.sendMessage(jid, caption);
      } else {
        // Video and document — upload as file
        const fileType = mediaType === 'video' ? 'mp4' : 'stream';
        const ext = mediaType === 'video' ? 'mp4' : 'bin';
        const uploadResp = await this.client.im.v1.file.create({
          data: {
            file_type: fileType,
            file_name: `${mediaType}_${Date.now()}.${ext}`,
            file: buffer,
          },
        });
        const fileKey = (uploadResp as any)?.data?.file_key || (uploadResp as any)?.file_key;
        if (!fileKey) {
          logger.error({ jid, mediaType }, 'Failed to upload file');
          if (caption) await this.sendMessage(jid, `[${mediaType}] ${caption}`);
          return;
        }

        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: mediaType === 'video' ? 'video' : 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
        if (caption) await this.sendMessage(jid, caption);
      }

      logger.info({ jid, mediaType, bytes: buffer.length }, 'Feishu media sent');
    } catch (err) {
      logger.error({ jid, mediaType, err }, 'Failed to send Feishu media');
    }
  }

  // ─── Outbound: Status Messages (send → edit → delete) ─────────────

  async sendStatusMessage(jid: string, text: string): Promise<number | null> {
    const chatId = jid.replace(/@feishu$/, '');
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      const messageId = (resp as any)?.data?.message_id || (resp as any)?.message_id;
      if (!messageId) return null;

      // Map a numeric hash to the string message_id
      const numericId = this.hashStringToNumber(messageId);
      this.statusIdMap.set(numericId, messageId);
      return numericId;
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Feishu status message');
      return null;
    }
  }

  async editStatusMessage(jid: string, messageId: number, text: string): Promise<void> {
    const feishuMsgId = this.statusIdMap.get(messageId);
    if (!feishuMsgId) return;

    try {
      await this.client.im.v1.message.update({
        path: { message_id: feishuMsgId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Feishu status message');
    }
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    const feishuMsgId = this.statusIdMap.get(messageId);
    if (!feishuMsgId) return;

    try {
      await this.client.im.v1.message.delete({
        path: { message_id: feishuMsgId },
      });
      this.statusIdMap.delete(messageId);
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to delete Feishu status message');
    }
  }

  // ─── Typing indicator (no-op for Feishu) ──────────────────────────

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not have a typing indicator API — no-op
  }

  // ─── Connection lifecycle ──────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@feishu');
  }

  async disconnect(): Promise<void> {
    // Clear all pending media timers
    for (const entry of this.pendingMedia.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingMedia.clear();
    this.statusIdMap.clear();
    this.connected = false;
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private hashStringToNumber(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function _feishuFactory(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    return null;
  }

  return new FeishuChannel({ ...opts, appId, appSecret });
}

registerChannel('feishu', _feishuFactory);
