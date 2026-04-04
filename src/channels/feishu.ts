import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { DATA_DIR } from '../config.js';
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
  mentions: { id: string; name: string; key?: string }[];
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
    mentions: { id: string; name: string; key?: string }[],
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
    mentions: { id: string; name: string; key?: string }[],
  ): string {
    let result = text;
    for (const mention of mentions) {
      // Feishu text messages use @_user_N placeholders (e.g. "@_user_1").
      // Replace placeholder key with @name.
      if (mention.key) {
        result = result.replace(
          new RegExp(mention.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          `@${mention.name}`,
        );
      }
      // Also handle <at user_id="ou_xxx">@Name</at> format (rich text fallback)
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

  /**
   * Dedup set to prevent processing the same message_id twice.
   * Feishu's WebSocket SDK can re-deliver events when async handlers
   * (e.g. /new with graceful shutdown) take too long to return.
   * Entries are auto-pruned after 60 seconds.
   */
  private processedMessageIds = new Map<string, number>();
  private static readonly DEDUP_TTL_MS = 60_000;

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
      'card.action.trigger': async (data: any) => {
        return await this.handleCardAction(data);
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

  private async handleCardAction(data: any): Promise<any> {
    try {
      const value = data.action?.value;
      if (!value || value.type !== 'aq_callback') return null;

      const { questionId, optionLabel } = value;
      const chatJid = `${data.context?.open_chat_id || data.open_chat_id}@feishu`;

      logger.info(
        { chatJid, questionId, optionLabel },
        'Feishu Card Action triggered',
      );

      this.opts.onQuestionAnswer?.(chatJid, questionId, { 其他: optionLabel });

      return {
        toast: {
          type: 'success',
          content: `你选择了: ${optionLabel}`,
        },
      };
    } catch (err) {
      logger.error({ err }, 'Feishu Card Action failed');
      return null;
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

    // ── Dedup: skip re-delivered events from Feishu WebSocket SDK ──
    const dedupId = msg.message_id;
    if (dedupId) {
      if (this.processedMessageIds.has(dedupId)) {
        logger.debug(
          { messageId: dedupId },
          'Skipping duplicate Feishu message (already processed)',
        );
        return;
      }
      this.processedMessageIds.set(dedupId, Date.now());

      // Prune stale entries periodically (every 100 messages)
      if (this.processedMessageIds.size % 100 === 0) {
        const cutoff = Date.now() - FeishuChannel.DEDUP_TTL_MS;
        for (const [id, ts] of this.processedMessageIds) {
          if (ts < cutoff) this.processedMessageIds.delete(id);
        }
      }
    }

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
    const mentions: { id: string; name: string; key?: string }[] = [];
    if (Array.isArray(msg.mentions)) {
      for (const m of msg.mentions) {
        const openId = m.id?.open_id;
        mentions.push({ id: openId, name: m.name, key: m.key });
        // Seed reverse cache from inbound mentions for outbound @mention resolution
        if (openId && m.name) {
          this.nameToOpenIdCache.set(m.name, openId);
          if (!this.senderNameCache.has(openId)) {
            this.senderNameCache.set(openId, m.name);
          }
        }
      }
    }

    // 2. Convert content
    const context = await this.converter.convert(msg, mentions);
    let content = context.content;

    // 3. Normalize mentions for core logic
    if (isMentioned) {
      // Use group's assistantName if available, otherwise fall back to global
      const group = this.opts.registeredGroups()[chatJid];
      const triggerName = group?.assistantName;
      // If mentioned, ensure text contains @assistantName for trigger logic
      if (triggerName && !content.includes(`@${triggerName}`)) {
        content = `@${triggerName} ${content}`;
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

      const transcript = await transcribeAudioMessage(buffer, group.folder);
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
    const group = this.opts.registeredGroups()[chatJid];

    const { handleCommand } = await import('../commands.js');
    return handleCommand(
      {
        chatJid,
        isGroup,
        timestamp,
        channelName: 'feishu',
        group,
        groupQueue: this.opts.groupQueue,
        reply: async (text: string) => {
          await this.sendMessage(chatJid, text);
        },
        onMessage: this.opts.onMessage,
      },
      content,
    );
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
        description = await describeImage(buffer, userText, group?.folder);
      } else {
        description = await describeVideo(
          buffer,
          media.mimeType,
          userText,
          group?.folder,
        );
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
  /** Reverse map: display name → openId for outbound @mention resolution. */
  private nameToOpenIdCache = new Map<string, string>();

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
        this.nameToOpenIdCache.set(name, openId);
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

  // ─── Helper: Build post elements with @mention resolution ──────────

  /**
   * Parse text containing mention patterns and produce a Feishu post
   * element array with proper `at` tags.
   *
   * Handles three formats the agent might produce:
   *   1. `@username`                              — resolved via nameToOpenIdCache
   *   2. `<at id="ou_xxx"></at>`                   — card-style mention (direct openId)
   *   3. `<at user_id="ou_xxx">name</at>`          — text-style mention (direct openId)
   *
   * Unknown `@username` are kept as plain text.
   */
  private buildPostElements(
    text: string,
  ): Array<{ tag: string; text?: string; user_id?: string }> {
    const elements: Array<{ tag: string; text?: string; user_id?: string }> =
      [];

    // Phase 1: Normalize <at> HTML tags into @-mention format and collect openIds.
    // This handles agent-generated <at id="ou_xxx"></at> and <at user_id="ou_xxx">name</at>.
    const atTagOpenIds = new Map<string, string>(); // placeholder → openId
    let normalized = text;

    // Match <at id="ou_xxx"></at> or <at id=ou_xxx></at> (card format, with optional trailing text)
    normalized = normalized.replace(
      /<at\s+id=["']?([^"'\s>]+)["']?\s*>[^<]*<\/at>\s*/g,
      (_match, openId: string) => {
        const name = this.senderNameCache.get(openId);
        if (name) {
          atTagOpenIds.set(name, openId);
          return `@${name} `;
        }
        // No name in cache — inject directly as at element later
        const placeholder = `__AT_${openId}__`;
        atTagOpenIds.set(placeholder, openId);
        return `@${placeholder} `;
      },
    );

    // Match <at user_id="ou_xxx">name</at> (text/post format)
    normalized = normalized.replace(
      /<at\s+user_id=["']?([^"'\s>]+)["']?\s*>[^<]*<\/at>\s*/g,
      (_match, openId: string) => {
        const name = this.senderNameCache.get(openId);
        if (name) {
          atTagOpenIds.set(name, openId);
          return `@${name} `;
        }
        const placeholder = `__AT_${openId}__`;
        atTagOpenIds.set(placeholder, openId);
        return `@${placeholder} `;
      },
    );

    // Phase 2: Split by @mentions (both from normalized <at> tags and original @name)
    const mentionRegex = /@(\S+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(normalized)) !== null) {
      const name = match[1];
      // Try: (1) direct openId from atTag normalization, (2) name cache lookup
      const openId = atTagOpenIds.get(name) || this.nameToOpenIdCache.get(name);

      // Push text before this match
      if (match.index > lastIndex) {
        elements.push({
          tag: 'text',
          text: normalized.slice(lastIndex, match.index),
        });
      }

      if (openId) {
        elements.push({ tag: 'at', user_id: openId });
      } else {
        // Unknown user → keep as plain text
        elements.push({ tag: 'text', text: match[0] });
      }

      lastIndex = match.index + match[0].length;
    }

    // Push remaining text after last match
    if (lastIndex < normalized.length) {
      elements.push({ tag: 'text', text: normalized.slice(lastIndex) });
    }

    // If no elements were produced (empty text), return a single empty text element
    if (elements.length === 0) {
      elements.push({ tag: 'text', text: '' });
    }

    return elements;
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
          const elements = this.buildPostElements(chunk);
          content = JSON.stringify({
            zh_cn: {
              title: '',
              content: [elements],
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

  // ─── Outbound: Send Ask User Question ──────────────────────────────
  async sendAskUserQuestion(
    jid: string,
    questionId: string,
    questions: any[],
  ): Promise<void> {
    for (let qIndex = 0; qIndex < questions.length; qIndex++) {
      const q = questions[qIndex];

      // Use interactive card for Feishu
      const card: any = {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: `❓ ${q.question}` },
        },
        elements: [],
      };

      if (q.description) {
        card.elements.push({
          tag: 'markdown',
          content: `_${q.description}_\n\n*(提示: 您也可以直接打字输入您的意图)*`,
        });
      } else {
        card.elements.push({
          tag: 'markdown',
          content: '*(提示: 您也可以直接打字输入您的意图)*',
        });
      }

      if (q.options && q.options.length > 0) {
        const actionButtons = q.options.map((opt: any) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: opt.label },
          type: 'default',
          value: { type: 'aq_callback', questionId, optionLabel: opt.label },
        }));

        card.elements.push({ tag: 'action', actions: actionButtons });
      }

      try {
        await this.sendMessage(jid, JSON.stringify(card));
      } catch (err: any) {
        logger.error(
          { err: err.message },
          'Feishu AskUserQuestion card send failed',
        );
      }
    }
  }

  // ─── Outbound: Send Media ──────────────────────────────────────────

  async sendMedia(
    jid: string,
    buffer: Buffer,
    mediaType: 'photo' | 'video' | 'audio' | 'document',
    caption?: string,
    fileName?: string,
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
            file_name: fileName || `audio_${Date.now()}.opus`,
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
            file_name: fileName || `${mediaType}_${Date.now()}.${ext}`,
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
        { jid, mediaType, bytes: buffer.length, fileName },
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
            .catch((err: any) => {
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
        // Idempotent: if reaction already exists on this message, don't add another
        const existing = this.typingReactions.get(jid);
        if (existing && existing.targetMessageId === currentMessageId) return;

        // If reaction exists on a different (old) message, remove it first
        if (existing) {
          await this.client.im.v1.messageReaction
            .delete({
              path: {
                message_id: existing.targetMessageId,
                reaction_id: existing.reactionId,
              },
            })
            .catch(() => {});
          this.typingReactions.delete(jid);
        }

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
