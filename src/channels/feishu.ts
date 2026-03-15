import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudioMessage } from '../transcription.js';
import { describeImage, describeVideo } from '../vision.js';
import { saveToMediaCache } from '../tools/mediaTools.js';
import { resolveAgentName } from '../agents-config.js';

// --- Types for Feishu Advanced Support ---

export interface MediaResource {
  fileKey: string;
  type: 'image' | 'file';
  fileName?: string;
}

export interface FeishuMessageContext {
  content: string;
  resources: MediaResource[];
  mentions: { id: string; name: string }[];
  quoted?: {
    messageId: string;
    content: string;
    senderName: string;
  };
}

/**
 * Handles conversion of various Feishu message types into internal Markdown-like format.
 * Inspired by openclaw-lark.
 */
export class FeishuContentConverter {
  constructor(
    private client: Lark.Client,
    private resolveSenderName: (openId: string) => Promise<string>,
  ) {}

  async convert(
    msg: any,
    mentions: { id: string; name: string }[],
  ): Promise<FeishuMessageContext> {
    const type = msg.message_type;
    const rawContent = JSON.parse(msg.content);

    let context: FeishuMessageContext = {
      content: '',
      resources: [],
      mentions,
    };

    switch (type) {
      case 'text':
        context.content = this.convertText(rawContent.text, mentions);
        break;
      case 'post':
        context = this.convertPost(rawContent, mentions);
        break;
      case 'interactive':
        context.content = this.convertInteractive(rawContent);
        break;
      case 'merge_forward':
        context = await this.convertMergeForward(msg.message_id, mentions);
        break;
      default:
        context.content = `[Unsupported message type: ${type}]`;
    }

    return context;
  }

  private convertText(
    text: string,
    mentions: { id: string; name: string }[],
  ): string {
    let result = text;
    for (const mention of mentions) {
      // Feishu text mentions are often in the form of <at user_id="ou_xxx">@Name</at>
      const regex = new RegExp(`<at user_id="${mention.id}">[^<]*</at>`, 'g');
      result = result.replace(regex, `@${mention.name}`);
    }
    return result;
  }

  private convertPost(
    post: any,
    mentions: { id: string; name: string }[],
  ): FeishuMessageContext {
    const resources: MediaResource[] = [];
    let content = '';

    // Feishu posts can be locale-wrapped or flat
    const title = post.title || '';
    if (title) content += `**${title}**\n\n`;

    const contentArray = post.content || [];
    for (const section of contentArray) {
      for (const element of section) {
        switch (element.tag) {
          case 'text':
            content += element.un_escape
              ? element.text
              : this.unescapeFeishu(element.text);
            break;
          case 'a':
            content += `[${element.text}](${element.href})`;
            break;
          case 'at':
            const mention = mentions.find((m) => m.id === element.user_id);
            content += `@${mention ? mention.name : element.user_id}`;
            break;
          case 'img':
            content += `\n![Image](feishu://${element.image_key})\n`;
            resources.push({ fileKey: element.image_key, type: 'image' });
            break;
          case 'hr':
            content += '\n---\n';
            break;
        }
      }
      content += '\n';
    }

    return { content: content.trim(), resources, mentions };
  }

  private convertInteractive(card: any): string {
    // Extract textual content from interactive cards (v1/v2)
    // For simplicity, we look for 'text' fields in common card structures
    let text = '';
    const traverse = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      if (
        obj.tag === 'plain_text' ||
        obj.tag === 'lark_md' ||
        obj.tag === 'markdown'
      ) {
        if (obj.content) text += obj.content + '\n';
      }
      for (const key in obj) {
        traverse(obj[key]);
      }
    };

    if (card.header?.title?.content) {
      text += `**${card.header.title.content}**\n\n`;
    }
    traverse(card);
    return text.trim() || '[Interactive Card]';
  }

  private async convertMergeForward(
    messageId: string,
    mentions: { id: string; name: string }[],
  ): Promise<FeishuMessageContext> {
    try {
      // Fetch sub-messages. Feishu returns ALL nested messages in a single flat list.
      const resp = await this.client.im.v1.message.get({
        path: { message_id: messageId },
      });
      const items = (resp as any).data.items || [];
      if (items.length === 0) {
        return { content: '<forwarded_messages/>', resources: [], mentions };
      }

      // Build a map of parent -> children
      const childrenMap = new Map<string, any[]>();
      for (const item of items) {
        const parentId = item.upper_message_id || messageId;
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId)!.push(item);
      }

      const formatted = await this.formatSubTree(messageId, childrenMap);
      return {
        content: `<forwarded_messages>\n${formatted}\n</forwarded_messages>`,
        resources: [],
        mentions,
      };
    } catch (err) {
      logger.error({ messageId, err }, 'Failed to parse merged messages');
      return {
        content: '[Error parsing merged messages]',
        resources: [],
        mentions,
      };
    }
  }

  private async formatSubTree(
    parentId: string,
    childrenMap: Map<string, any[]>,
  ): Promise<string> {
    const children = childrenMap.get(parentId) || [];
    let result = '';

    for (const child of children) {
      const senderOpenId = child.sender?.id || 'unknown';
      const senderName = await this.resolveSenderName(senderOpenId);
      const timestamp = new Date(Number(child.create_time)).toISOString();

      const context = await this.convert(child, []); // We don't resolve mentions for sub-messages for now
      const content = context.content;

      result += `[${timestamp}] ${senderName}:\n`;
      // Indent content
      result += content
        .split('\n')
        .map((line) => '    ' + line)
        .join('\n');
      result += '\n';

      // If it's another merge_forward, it will be expanded by the recursive convert call above
      // if we had structured it that way, but since ALL items are in childrenMap,
      // we only need to recurse if there ARE children for this child.
      if (childrenMap.has(child.message_id)) {
        result += await this.formatSubTree(child.message_id, childrenMap);
      }
    }

    return result.trim();
  }

  private unescapeFeishu(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}

export interface FeishuChannelOpts extends ChannelOpts {
  appId: string;
  appSecret: string;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client!: Lark.Client;
  private connected = false;
  private botOpenId: string | undefined;
  private converter!: FeishuContentConverter;

  /**
   * Track the last user message ID for each chat.
   * Feishu doesn't have a typing indicator API, so we add a "Typing" reaction
   * to the last user message to simulate one.
   */
  private lastUserMessageId = new Map<string, string>();

  /**
   * Track the reaction ID and target message ID for the "Typing" reaction
   * to delete it correctly even if lastUserMessageId has changed.
   */
  private typingReactions = new Map<
    string,
    { reactionId: string; targetMessageId: string }
  >();

  private opts: FeishuChannelOpts;

  /** Map numeric hash → Feishu string message_id for status messages */
  private statusIdMap = new Map<number, string>();

  /** Map numeric hash → number of times it has been edited */
  private statusEditCounts = new Map<number, number>();

  /** Feishu edit limit is 50, we recycle at 45 to be safe */
  private static readonly STATUS_EDIT_LIMIT = 45;

  /** Buffered media waiting for a possible follow-up text (key: chatJid) */
  private pendingMedia = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      chatJid: string;
      buffer: Buffer;
      timestamp: string;
      senderName: string;
      sender: string;
      msgId: string;
      mediaType: 'photo' | 'video';
      mimeType?: string;
    }
  >();
  /** How long to wait for a follow-up text after receiving media (ms) */
  private static readonly MEDIA_MERGE_WINDOW = 1000;
  /** Max message length for Feishu (generous limit) */
  private static readonly MAX_MESSAGE_LENGTH = 10000;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const { appId, appSecret } = this.opts;

    this.client = new Lark.Client({ appId, appSecret });
    this.converter = new FeishuContentConverter(
      this.client,
      this.resolveSenderName.bind(this),
    );

    // Fetch bot's own open_id so we can detect our own messages
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = (resp as any)?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to fetch Feishu bot info, bot message detection may not work',
      );
    }

    const wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    // --- PATCH: Suppress confusing SDK crash log when Feishu is busy (1.59.0 bug) ---
    const originalLoggerError = (wsClient as any).logger.error;
    (wsClient as any).logger.error = function (tag: string, msg: string) {
      if (
        tag === '[ws]' &&
        (msg?.includes('PingInterval') || msg?.includes('1000040345'))
      ) {
        // Suppress the crash message and provide a cleaner one for the "busy" error
        if (msg.includes('1000040345')) {
          logger.warn(
            'Feishu system busy (rate limited), retrying in background...',
          );
        }
        return;
      }
      return originalLoggerError.call(this, tag, msg);
    };

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
      'im.message.reaction.created_v1': async (data: any) => {
        await this.handleReaction(data);
      },
      'im.message.reaction.deleted_v1': async (_data: any) => {
        // Intentionally ignored — we don't need to act on reaction removals,
        // but registering prevents SDK "no handle" warnings and dispatch errors.
      },
    });

    wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Connected to Feishu via WebSocket');
  }

  // ─── Reactions ────────────────────────────────────────────────────

  private async handleReaction(data: any): Promise<void> {
    try {
      // SDK may pass data as {event: {...}} or directly as {...}
      const event = data?.event || data;
      const messageId = event?.message_id;
      const emojiType = event?.reaction_type?.emoji_type;
      const userId = event?.user_id?.open_id;
      const actionTime = event?.action_time;

      if (!messageId || !emojiType || !userId) {
        logger.debug({ data }, 'Ignoring reaction with missing fields');
        return;
      }

      // Ignore bot's own reactions
      if (this.botOpenId && userId === this.botOpenId) return;
      // Ignore Typing indicator reactions
      if (emojiType === 'Typing') return;
      // Fetch the original message to get chat_id and snippet
      const msgResp = await this.client.im.v1.message.get({
        path: { message_id: messageId },
      });
      const msg = (msgResp as any).data.items?.[0];
      if (!msg) return;

      const chatJid = `${msg.chat_id}@feishu`;
      const senderName = await this.resolveSenderName(userId);
      const timestamp = new Date(parseInt(actionTime)).toISOString();

      // Create a synthetic notification message for the AI
      let snippet = '[Media]';
      try {
        if (msg.content) {
          const rawContent = JSON.parse(msg.content);
          const textSnippet = rawContent.text || '[Media]';
          snippet =
            textSnippet.length > 50
              ? textSnippet.slice(0, 50) + '...'
              : textSnippet;
        }
      } catch {
        // Content may not be parseable JSON
      }

      const content = `[用户对消息 "${snippet}" 做出了 ${emojiType} 反应]`;

      this.deliverIfRegistered(chatJid, {
        id: `reaction-${messageId}-${emojiType}-${Date.now()}`,
        chat_jid: chatJid,
        sender: userId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });

      logger.info(
        { chatJid, emojiType, messageId },
        'Feishu reaction processed',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to process Feishu reaction');
    }
  }

  // ─── Inbound Message Handling ──────────────────────────────────────

  private async handleMessage(data: any): Promise<void> {
    // SDK may pass data as {event: {message, sender}} or directly as {message, sender}
    const msg = data?.message || data?.event?.message;
    const sender = data?.sender || data?.event?.sender;
    if (!msg) return;

    // Skip bot's own messages
    if (
      sender?.sender_id?.open_id &&
      sender.sender_id.open_id === this.botOpenId
    )
      return;

    const chatId = msg.chat_id;
    if (!chatId) return;

    const chatJid = `${chatId}@feishu`;
    const timestamp = new Date(Number(msg.create_time)).toISOString();
    const senderOpenId = sender?.sender_id?.open_id || 'unknown';
    const senderName = await this.resolveSenderName(senderOpenId);

    // Track last user message for typing indicator
    this.lastUserMessageId.set(chatJid, msg.message_id);

    // Notify chat metadata
    const isGroup = msg.chat_type === 'group';
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    const messageType = msg.message_type;
    const messageId = msg.message_id || '';

    // Check for @mention in groups — extract from mentions array
    const isMentioned = this.isBotMentioned(msg);

    // Handle advanced/standard types via converter
    if (
      ['text', 'post', 'interactive', 'merge_forward'].includes(messageType)
    ) {
      await this.handleAdvancedMessage(
        msg,
        chatJid,
        timestamp,
        senderName,
        senderOpenId,
        messageId,
        isMentioned,
      );
      return;
    }

    // Route by message type for legacy media
    switch (messageType) {
      case 'image':
        await this.handleImageMessage(
          msg,
          chatJid,
          timestamp,
          senderName,
          senderOpenId,
          messageId,
          isGroup,
        );
        break;
      case 'video':
      case 'media':
        await this.handleVideoMessage(
          msg,
          chatJid,
          timestamp,
          senderName,
          senderOpenId,
          messageId,
          isGroup,
        );
        break;
      case 'audio':
        await this.handleAudioMessage(
          msg,
          chatJid,
          timestamp,
          senderName,
          senderOpenId,
          messageId,
          isGroup,
        );
        break;
      case 'file':
        await this.handleFileMessage(
          msg,
          chatJid,
          timestamp,
          senderName,
          senderOpenId,
          messageId,
          isGroup,
        );
        break;
      case 'sticker':
        await this.handleStickerMessage(
          chatJid,
          timestamp,
          senderName,
          senderOpenId,
          messageId,
          isGroup,
        );
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

  private async handleAdvancedMessage(
    msg: any,
    chatJid: string,
    timestamp: string,
    senderName: string,
    senderOpenId: string,
    messageId: string,
    isMentioned: boolean,
  ): Promise<void> {
    // 1. Resolve mentions
    const mentions: { id: string; name: string }[] = [];
    if (Array.isArray(msg.mentions)) {
      for (const m of msg.mentions) {
        mentions.push({ id: m.id?.open_id, name: m.name });
      }
    }

    // 2. Convert content
    const context = await this.converter.convert(msg, mentions);
    let content = context.content;

    // 3. Normalize mentions for core logic
    if (isMentioned) {
      // If mentioned, ensure text contains @ASSISTANT_NAME for trigger logic
      if (!content.includes(`@${ASSISTANT_NAME}`)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // 4. Check for commands
    if (content.startsWith('/')) {
      const isGroup = msg.chat_type === 'group';
      const handled = await this.handleCommand(
        content,
        chatJid,
        isGroup,
        timestamp,
      );
      if (handled) return;
    }

    // 5. Handle quoted message
    if (msg.parent_id) {
      const quoted = await this.resolveQuotedContent(msg.parent_id);
      if (quoted) {
        content = `[引用: "${quoted.content}" | 发送者: ${quoted.senderName}]\n${content}`;
      }
    }

    // 6. Check for pending media waiting for follow-up text
    const pending = this.pendingMedia.get(chatJid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingMedia.delete(chatJid);
      logger.info(
        { chatJid, mediaType: pending.mediaType },
        'Merging follow-up text with pending media',
      );
      await this.processAndStoreMedia(pending, content);
      // We don't return here because we want the text message to be delivered too?
      // Actually, the original code DID keep going to deliverIfRegistered.
    }

    const group = this.opts.registeredGroups()[chatJid];
    if (group && context.resources.length > 0) {
      for (const res of context.resources) {
        try {
          const buffer = await this.downloadMessageResource(
            messageId,
            res.fileKey,
            res.type,
          );
          const mediaId = saveToMediaCache(
            resolveAgentName(group.botToken),
            buffer,
            res.type,
          );
          content += `\n[${res.type === 'image' ? 'Photo' : 'File'} MediaID: ${mediaId}]`;
        } catch (err) {
          logger.error(
            { chatJid, fileKey: res.fileKey, err },
            'Failed to download advanced message resource',
          );
        }
      }
    }

    // 7. Deliver
    this.deliverIfRegistered(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderOpenId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private async resolveQuotedContent(
    parentId: string,
  ): Promise<{ content: string; senderName: string } | null> {
    try {
      const resp = await this.client.im.v1.message.get({
        path: { message_id: parentId },
      });
      const parent = (resp as any).data.items?.[0];
      if (!parent) return null;

      const senderOpenId = parent.sender?.id || 'unknown';
      const senderName = await this.resolveSenderName(senderOpenId);

      // Simple text-only summary of the parent message
      const mentions: any[] = [];
      const context = await this.converter.convert(parent, mentions);
      return {
        content:
          context.content.length > 100
            ? context.content.slice(0, 100) + '...'
            : context.content,
        senderName,
      };
    } catch (err) {
      return null;
    }
  }

  private async handleImageMessage(
    msg: any,
    chatJid: string,
    timestamp: string,
    senderName: string,
    sender: string,
    msgId: string,
    _isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let imageKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      imageKey = parsed.image_key || '';
    } catch {
      /* ignore */
    }

    if (!imageKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: '[Photo - no image key]',
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadMessageResource(
        msg.message_id,
        imageKey,
        'image',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Feishu image download failed');
      this.deliverIfRegistered(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: '[Photo - download failed]',
        timestamp,
        is_from_me: false,
        is_bot_message: false,
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
        logger.info(
          { chatJid },
          'No follow-up text, processing photo with generic prompt',
        );
        this.processAndStoreMedia(entry, undefined).catch((err) => {
          logger.error({ chatJid, err }, 'Deferred photo processing failed');
        });
      }
    }, FeishuChannel.MEDIA_MERGE_WINDOW);

    this.pendingMedia.set(chatJid, {
      timer,
      chatJid,
      buffer,
      timestamp,
      senderName,
      sender,
      msgId,
      mediaType: 'photo',
    });
    logger.info(
      { chatJid, bytes: buffer.length },
      'Photo buffered, waiting for follow-up text',
    );
  }

  private async handleVideoMessage(
    msg: any,
    chatJid: string,
    timestamp: string,
    senderName: string,
    sender: string,
    msgId: string,
    _isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let fileKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileKey = parsed.file_key || '';
    } catch {
      /* ignore */
    }

    if (!fileKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: '[Video - no file key]',
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await this.downloadMessageResource(
        msg.message_id,
        fileKey,
        'file',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Feishu video download failed');
      this.deliverIfRegistered(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: '[Video - download failed]',
        timestamp,
        is_from_me: false,
        is_bot_message: false,
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
        logger.info(
          { chatJid },
          'No follow-up text, processing video with generic prompt',
        );
        this.processAndStoreMedia(entry, undefined).catch((err) => {
          logger.error({ chatJid, err }, 'Deferred video processing failed');
        });
      }
    }, FeishuChannel.MEDIA_MERGE_WINDOW);

    this.pendingMedia.set(chatJid, {
      timer,
      chatJid,
      buffer,
      timestamp,
      senderName,
      sender,
      msgId,
      mediaType: 'video',
      mimeType: 'video/mp4',
    });
    logger.info(
      { chatJid, bytes: buffer.length },
      'Video buffered, waiting for follow-up text',
    );
  }

  private async handleAudioMessage(
    msg: any,
    chatJid: string,
    timestamp: string,
    senderName: string,
    sender: string,
    msgId: string,
    isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let fileKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileKey = parsed.file_key || '';
    } catch {
      /* ignore */
    }

    if (!fileKey) {
      this.deliverIfRegistered(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: '[Voice Message - no file key]',
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      return;
    }

    let finalContent: string;
    try {
      const buffer = await this.downloadMessageResource(
        msg.message_id,
        fileKey,
        'file',
      );

      // Cache media
      const mediaId = saveToMediaCache(
        resolveAgentName(group.botToken),
        buffer,
        'audio',
      );

      const transcript = await transcribeAudioMessage(buffer);
      finalContent = transcript
        ? `[Voice: ${transcript} | MediaID: ${mediaId}]`
        : `[Voice Message - transcription unavailable | MediaID: ${mediaId}]`;
      logger.info(
        { chatJid, bytes: buffer.length },
        'Voice message transcribed and cached',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Voice transcription/caching failed');
      finalContent = '[Voice Message - transcription failed]';
    }

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
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

  private async handleFileMessage(
    msg: any,
    chatJid: string,
    timestamp: string,
    senderName: string,
    sender: string,
    msgId: string,
    isGroup: boolean,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) return;

    let fileName = 'file';
    let fileKey = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      fileName = parsed.file_name || 'file';
      fileKey = parsed.file_key || '';
    } catch {
      /* ignore */
    }

    let finalContent = `[Document: ${fileName}]`;
    if (fileKey) {
      try {
        const buffer = await this.downloadMessageResource(
          msgId,
          fileKey,
          'file',
        );
        const mediaId = saveToMediaCache(
          resolveAgentName(group.botToken),
          buffer,
          'file',
        );
        finalContent = `[Document: ${fileName} | MediaID: ${mediaId}]`;
      } catch (err) {
        logger.error({ chatJid, err }, 'Feishu file download failed');
      }
    }

    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
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

  private async handleStickerMessage(
    chatJid: string,
    timestamp: string,
    senderName: string,
    sender: string,
    msgId: string,
    isGroup: boolean,
  ): Promise<void> {
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);
    this.deliverIfRegistered(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: '[Sticker]',
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  // ─── Commands ──────────────────────────────────────────────────────

  private async handleCommand(
    content: string,
    chatJid: string,
    isGroup: boolean,
    timestamp: string,
  ): Promise<boolean> {
    const cmd = content.split(/\s+/)[0].toLowerCase();

    if (cmd === '/chatid') {
      const chatTypeStr = isGroup ? 'Group' : 'Private';
      await this.sendMessage(
        chatJid,
        `Chat ID: ${chatJid}\nType: ${chatTypeStr}`,
      );
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
      await this.sendMessage(
        chatJid,
        'This chat is not registered. Cannot clear session.',
      );
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

      await this.sendMessage(
        chatJid,
        '✅ 清理成功！您的工作区和所有历史对话已完全清空，可以直接开始全新的会话。',
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to clear session data');
      await this.sendMessage(chatJid, '❌ 清理失败，请检查服务器日志。');
    }
  }

  private async handleCompactCommand(
    chatJid: string,
    timestamp: string,
  ): Promise<void> {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await this.sendMessage(
        chatJid,
        'This chat is not registered. Cannot compact session.',
      );
      return;
    }

    try {
      await this.sendMessage(
        chatJid,
        'Compacting session... 正在读取数据库并生成对话总结，随后将重置短期记忆。',
      );

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
          const envVars = readEnvFile([
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_MODEL',
          ]);
          const apiKey =
            envVars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
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

          if (apiKey) {
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
              summary =
                data?.choices?.[0]?.message?.content ||
                data?.content?.[0]?.text ||
                '概括生成的文本为空';
            } else {
              const errText = await fetchResponse.text();
              logger.error(
                {
                  chatJid,
                  status: fetchResponse.status,
                  errText,
                  apiUrl,
                  modelName,
                },
                'Failed to fetch summary from LLM API',
              );
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
          await new Promise((r) => setTimeout(r, 1000));
          await this.opts.groupQueue.killContainer(chatJid);
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e) {
          logger.warn(
            { chatJid, err: e },
            'Failed to gracefully close container before compact',
          );
        }
      }

      const baseClaudeDir = path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        '.claude',
      );
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

      await new Promise((r) => setTimeout(r, 1000));

      // 4. Inject system message with summary
      await this.sendMessage(
        chatJid,
        '✅ 总结与清理完成！最新提示词与上下文摘要已就绪，正在唤醒新会话...',
      );
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

  private deliverIfRegistered(
    chatJid: string,
    message: {
      id: string;
      chat_jid: string;
      sender: string;
      sender_name: string;
      content: string;
      timestamp: string;
      is_from_me: boolean;
      is_bot_message: boolean;
    },
  ): void {
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      // If this message is part of a media merge window, we process it with the media.
      // If it was already processed as the caption/description for pending media,
      // we should NOT process it again as a standalone text message.
      const pending = this.pendingMedia.get(chatJid);
      if (pending) {
        logger.info(
          { jid: chatJid, msgId: message.id },
          'Feishu message received while media is pending, likely caption/description. Skipping standalone delivery.',
        );
        return;
      }

      this.opts.onMessage(chatJid, message);
    }
  }

  // ─── Helper: Download message resource ─────────────────────────────

  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<Buffer> {
    // Use the SDK's token manager to get a tenant access token, then fetch directly
    // because the SDK's request() method doesn't support binary responses well.
    const tokenResp = await (
      this.client.tokenManager as any
    ).getTenantAccessToken();
    const token =
      typeof tokenResp === 'string'
        ? tokenResp
        : tokenResp?.tenant_access_token || tokenResp?.token || '';

    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
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
      chatJid: string;
      buffer: Buffer;
      timestamp: string;
      senderName: string;
      sender: string;
      msgId: string;
      mediaType: 'photo' | 'video';
      mimeType?: string;
    },
    userText: string | undefined,
  ): Promise<void> {
    const { chatJid, buffer, timestamp, senderName, sender, msgId, mediaType } =
      media;
    const label = mediaType === 'photo' ? 'Photo' : 'Video';
    const group = this.opts.registeredGroups()[chatJid];

    // Cache media
    let mediaId = '';
    if (group) {
      mediaId = saveToMediaCache(
        resolveAgentName(group.botToken),
        buffer,
        mediaType,
      );
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
      logger.info(
        { chatJid, bytes: buffer.length, mediaType },
        `${label} message processed`,
      );
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

    try {
      // Split long messages
      const MAX = FeishuChannel.MAX_MESSAGE_LENGTH;
      const chunks = text.length <= MAX ? [text] : [];
      if (text.length > MAX) {
        for (let i = 0; i < text.length; i += MAX) {
          chunks.push(text.slice(i, i + MAX));
        }
      }

      for (const chunk of chunks) {
        // Simple card detection: if it starts with { and ends with }, try parsing as JSON
        let msgType = 'text';
        let content = JSON.stringify({ text: chunk });

        // Strip markdown code fences: agents often wrap JSON in ```json ... ```
        let stripped = chunk.trim();
        const codeFenceMatch = stripped.match(
          /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/,
        );
        if (codeFenceMatch) {
          stripped = codeFenceMatch[1].trim();
        }

        if (stripped.startsWith('{') && stripped.endsWith('}')) {
          try {
            JSON.parse(stripped); // Validate JSON
            msgType = 'interactive';
            content = stripped;
          } catch {
            // Not JSON, stick with text
          }
        }

        // If not a card, use 'post' to allow better Markdown rendering if we wanted,
        // but for now we'll stick with 'text' or 'post' based on content.
        // openclaw-lark often uses 'post' for outbound messages.
        if (msgType === 'text') {
          msgType = 'post';
          content = JSON.stringify({
            zh_cn: {
              title: '',
              content: [
                [
                  {
                    tag: 'text',
                    text: chunk,
                  },
                ],
              ],
            },
          });
        }

        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: msgType as any,
            content,
          },
        });

        const msgId =
          (resp as any)?.data?.message_id || (resp as any)?.message_id;
        if (!msgId) {
          logger.error(
            { jid, resp },
            'Feishu message sent but no message_id returned',
          );
        } else {
          logger.info(
            { jid, msgId, length: chunk.length },
            'Feishu message sent',
          );
        }
      }
    } catch (err) {
      logger.error(
        { jid, err, text: text.slice(0, 100) },
        'Failed to send Feishu message',
      );
    }
  }

  // ─── Outbound: Send Media ──────────────────────────────────────────

  async sendMedia(
    jid: string,
    buffer: Buffer,
    mediaType: 'photo' | 'video' | 'audio' | 'document',
    caption?: string,
  ): Promise<void> {
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
        const imageKey =
          (uploadResp as any)?.data?.image_key ||
          (uploadResp as any)?.image_key;
        if (!imageKey) {
          logger.error(
            { jid },
            'Failed to upload image: no image_key returned',
          );
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
        const fileKey =
          (uploadResp as any)?.data?.file_key || (uploadResp as any)?.file_key;
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
        const fileKey =
          (uploadResp as any)?.data?.file_key || (uploadResp as any)?.file_key;
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

      logger.info(
        { jid, mediaType, bytes: buffer.length },
        'Feishu media sent',
      );
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
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [[{ tag: 'text', text }]],
            },
          }),
        },
      });
      const messageId =
        (resp as any)?.data?.message_id || (resp as any)?.message_id;
      if (!messageId) return null;

      const numericId = this.hashStringToNumber(messageId);
      this.statusIdMap.set(numericId, messageId);
      this.statusEditCounts.set(numericId, 0);
      return numericId;
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Feishu status message');
      return null;
    }
  }

  async editStatusMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    const feishuMsgId = this.statusIdMap.get(messageId);
    if (!feishuMsgId) return;

    const editCount = this.statusEditCounts.get(messageId) || 0;

    // If we're approaching the Feishu edit limit (50), recycle the message
    if (editCount >= FeishuChannel.STATUS_EDIT_LIMIT) {
      logger.info(
        { jid, messageId, feishuMsgId, editCount },
        'Feishu status message reaching edit limit, recycling...',
      );
      await this.recycleStatusMessage(jid, messageId, text);
      return;
    }

    try {
      const resp = await this.client.im.v1.message.update({
        path: { message_id: feishuMsgId },
        data: {
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [[{ tag: 'text', text }]],
            },
          }),
        },
      });

      // Check for the edit limit error code in the response if the SDK doesn't throw
      const code = (resp as any)?.code;
      if (code === 230072) {
        logger.warn(
          { jid, messageId, feishuMsgId, code },
          'Feishu edit limit hit (async), recycling...',
        );
        await this.recycleStatusMessage(jid, messageId, text);
        return;
      }

      this.statusEditCounts.set(messageId, editCount + 1);
    } catch (err: any) {
      // Handle the edit limit error (230072) specifically
      if (err?.response?.data?.code === 230072 || err?.code === 230072) {
        logger.warn(
          { jid, messageId, feishuMsgId, err },
          'Feishu edit limit hit, recycling...',
        );
        await this.recycleStatusMessage(jid, messageId, text);
        return;
      }

      logger.debug(
        { jid, messageId, err },
        'Failed to edit Feishu status message',
      );
    }
  }

  /**
   * Internal helper to recycle a status message by sending a new one
   * and updating the maps so subsequent edits use the new message.
   */
  private async recycleStatusMessage(
    jid: string,
    numericId: number,
    text: string,
  ): Promise<void> {
    const oldFeishuMsgId = this.statusIdMap.get(numericId);

    // 1. Send new message
    const chatId = jid.replace(/@feishu$/, '');
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '',
              content: [[{ tag: 'text', text }]],
            },
          }),
        },
      });

      const NewMessageId =
        (resp as any)?.data?.message_id || (resp as any)?.message_id;

      if (NewMessageId) {
        // 2. Update maps
        this.statusIdMap.set(numericId, NewMessageId);
        this.statusEditCounts.set(numericId, 0);

        // 3. Try to delete the old message (best effort)
        if (oldFeishuMsgId) {
          this.client.im.v1.message
            .delete({
              path: { message_id: oldFeishuMsgId },
            })
            .catch((err) => {
              logger.debug(
                { jid, oldFeishuMsgId, err },
                'Failed to delete old status message during recycling',
              );
            });
        }
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to recycle Feishu status message');
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
      this.statusEditCounts.delete(messageId);
    } catch (err) {
      logger.debug(
        { jid, messageId, err },
        'Failed to delete Feishu status message',
      );
    }
  }

  // ─── Typing indicator (no-op for Feishu) ──────────────────────────

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const currentMessageId = this.lastUserMessageId.get(jid);
    if (!currentMessageId && isTyping) return;

    try {
      if (isTyping && currentMessageId) {
        const resp = await this.client.im.v1.messageReaction.create({
          path: { message_id: currentMessageId },
          data: { reaction_type: { emoji_type: 'Typing' } },
        });
        const reactionId = (resp as any).data?.reaction_id;
        if (reactionId) {
          this.typingReactions.set(jid, {
            reactionId,
            targetMessageId: currentMessageId,
          });
        }
      } else {
        const reaction = this.typingReactions.get(jid);
        if (reaction) {
          await this.client.im.v1.messageReaction.delete({
            path: {
              message_id: reaction.targetMessageId,
              reaction_id: reaction.reactionId,
            },
          });
          this.typingReactions.delete(jid);
        }
      }
    } catch (err) {
      // Silently ignore errors - typing indicator is non-critical
      logger.debug(
        { jid, isTyping, err },
        'Failed to set Feishu typing indicator',
      );
    }
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
    this.statusEditCounts.clear();
    this.connected = false;
  }

  // ─── Utility ───────────────────────────────────────────────────────

  private hashStringToNumber(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
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
