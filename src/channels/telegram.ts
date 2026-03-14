import { Bot, InputFile } from 'grammy';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudioMessage } from '../transcription.js';
import { describeImage, describeVideo } from '../vision.js';
import { saveToMediaCache } from '../tools/mediaTools.js';
import { getAllBotConfigs, resolveAgentName } from '../agents-config.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

import { GroupQueue } from '../group-queue.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  groupQueue: GroupQueue;
}

export class TelegramChannel implements Channel {
  name: string;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  /** Env var name for this bot token (e.g., 'TELEGRAM_BOT_TOKEN_1') */
  private tokenEnvName: string;
  /** Numeric bot ID extracted from token */
  private botId: string;
  /** Per-JID intervals that refresh the Telegram typing indicator every 4s */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Buffered media waiting for a possible follow-up text (key: chatJid) */
  private pendingMedia = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      chatJid: string;
      fileUrl: string;
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

  constructor(
    botToken: string,
    tokenEnvName: string,
    opts: TelegramChannelOpts,
  ) {
    this.botToken = botToken;
    this.tokenEnvName = tokenEnvName;
    this.botId = botToken.split(':')[0];
    this.name = `telegram:${tokenEnvName}`;
    this.opts = opts;
  }

  /** Generate a JID that includes the bot ID for multi-bot isolation */
  private makeJid(chatId: number | string): string {
    return `tg:${chatId}@${this.botId}`;
  }

  /** Extract numeric chat ID from JID (strips tg: prefix and @botId suffix) */
  private static extractChatId(jid: string): string {
    return jid.replace(/^tg:/, '').replace(/@.*$/, '');
  }

  /**
   * Check if this channel instance owns the given JID.
   * A JID is owned if it's a tg: JID AND the registered group's botToken
   * matches this instance's tokenEnvName. Groups without a botToken are
   * owned by the first bot (backwards compatibility).
   */
  ownsJid(jid: string): boolean {
    if (!jid.startsWith('tg:')) return false;
    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      // Unregistered JID — let the first bot handle it for /chatid etc.
      return this.tokenEnvName === this._getFirstTokenEnvName();
    }
    // If group has a botToken, only match if it equals ours
    if (group.botToken) {
      return group.botToken === this.tokenEnvName;
    }
    // Legacy groups without botToken: first bot owns them
    return this.tokenEnvName === this._getFirstTokenEnvName();
  }

  /** Get the env name of the first bot token (for backwards compatibility) */
  private _getFirstTokenEnvName(): string {
    // Scan env vars in order to find the first TELEGRAM_BOT_TOKEN*
    const envKeys = Object.keys(process.env)
      .filter((k) => k.startsWith('TELEGRAM_BOT_TOKEN'))
      .sort();
    return envKeys[0] || this.tokenEnvName;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: tg:${chatId}@${this.botId}\nBot: ${this.tokenEnvName}\nName: ${chatName}\nType: ${chatType}`,
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online. (${this.tokenEnvName})`);
    });

    // Command to clear session data
    this.bot.command('clear', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered. Cannot clear session.');
        return;
      }

      // In group chats, only react when the command explicitly targets this bot
      // e.g. /clear@BotName — avoids reacting to bare /clear from other bots
      const isGroupChat =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroupChat) {
        const cmdText = ctx.message?.text || '';
        const botUsername = ctx.me.username;
        if (!cmdText.includes(`@${botUsername}`)) return;
      }

      // Message isolation: skip if JID belongs to a different bot
      if (!this.ownsJid(chatJid)) return;

      try {
        const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder);

        let clearedOptions = false;
        if (fs.existsSync(groupSessionsDir)) {
          fs.rmSync(groupSessionsDir, { recursive: true, force: true });
          clearedOptions = true;
        }

        if (clearedOptions) {
          logger.info(
            { chatJid, bot: this.tokenEnvName },
            'Workspace data cleared',
          );
        } else {
          logger.info(
            { chatJid, bot: this.tokenEnvName },
            'No workspace data found to clear',
          );
        }

        // Clear Database Data (Tasks, Messages) for this JID
        const { clearChatData } = await import('../db.js');
        clearChatData(chatJid);

        ctx.reply(
          '✅ 清理成功！您的工作区和所有历史对话已完全清空，可以直接开始全新的会话。',
        );
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Failed to clear session data',
        );
        ctx.reply('❌ 清理失败，请检查服务器日志。');
      }
    });

    // Command to compact session (Soft Reset)
    this.bot.command('compact', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered. Cannot compact session.');
        return;
      }

      // In group chats, only react when the command explicitly targets this bot
      const isGroupChat =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroupChat) {
        const cmdText = ctx.message?.text || '';
        const botUsername = ctx.me.username;
        if (!cmdText.includes(`@${botUsername}`)) return;
      }

      if (!this.ownsJid(chatJid)) return;

      try {
        ctx.reply(
          'Compacting session... 正在读取数据库并生成对话总结，随后将重置短期记忆。',
        );

        // 1. Fetch recent history from DB
        const { getRecentMessages } = await import('../db.js');
        const recentMessages = getRecentMessages(chatJid, 20);
        let historyBlock = '';
        if (recentMessages && recentMessages.length > 0) {
          for (const msg of recentMessages.reverse()) {
            // Chronological order
            historyBlock += `[${msg.timestamp}] ${msg.sender_name}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}\n`;
          }
        }

        // 2. Generate summary using LLM API
        let summary = '目前没有先前的上下文可以总结。';
        if (historyBlock) {
          try {
            const { readEnvFile } = await import('../env.js');
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

            // Format URL to LiteLLM/OpenAI Messages API standard
            // LiteLLM router uses /v1/chat/completions, not /v1/messages (Anthropic native)
            if (!apiUrl.endsWith('/v1/chat/completions')) {
              // Strip trailing /v1/messages if present (we replace with openai format)
              apiUrl = apiUrl.replace(/\/v1\/messages$/, '').replace(/\/$/, '');
              apiUrl = apiUrl + '/v1/chat/completions';
            }

            if (apiKey) {
              const fetchResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`, // LiteLLM uses Bearer token
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
                // LiteLLM returns OpenAI-compatible format: choices[0].message.content
                // Anthropic native format: content[0].text
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
                summary = `由于摘要生成失败，这是您的原始对话记录：\n${historyBlock}`; // Fallback
              }
            } else {
              summary = `由于未配置API密钥，这是您的原始对话记录：\n${historyBlock}`; // Fallback if no API key
            }
          } catch (e) {
            logger.error(
              { chatJid, err: e },
              'Error during summary generation',
            );
            summary = `由于执行报错，这是您的原始对话记录：\n${historyBlock}`; // Fallback
          }
        }

        // 3. Clear Session directories
        // Before clearing, gracefully shut down any active container for this group
        // to prevent the Claude SDK from crashing with ENOENT or ProcessTransport errors
        if (this.opts.groupQueue) {
          try {
            this.opts.groupQueue.closeStdin(chatJid);
            // Wait briefly to allow the _close sentinel to be processed by the container
            await new Promise((r) => setTimeout(r, 1000));

            // Forcibly terminate the container before ripping out the file system
            await this.opts.groupQueue.killContainer(chatJid);
            // Give the OS time to release file handles
            await new Promise((r) => setTimeout(r, 2000));
          } catch (e) {
            logger.warn(
              { chatJid, err: e },
              'Failed to gracefully close container before compact, continuing anyway',
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
            logger.warn(
              { dirPath, e },
              'Failed to clear claude state directory',
            );
          }
        }

        // 3.5 Clear IPC state so the newly spawned container doesn't slurp up stale messages intended for the old session
        const ipcDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
        try {
          if (fs.existsSync(ipcDir)) {
            fs.rmSync(ipcDir, { recursive: true, force: true });
          }
        } catch (e) {
          logger.warn({ ipcDir, e }, 'Failed to clear IPC directory');
        }

        // Give extra time for the file system to settle before the new request triggers the container boot
        await new Promise((r) => setTimeout(r, 1000));

        // 4. Inject system message with history
        ctx.reply(
          '✅ 总结与清理完成！最新提示词与上下文摘要已就绪，正在唤醒新会话...',
        );
        const timestamp = ctx.message
          ? new Date(ctx.message.date * 1000).toISOString()
          : new Date().toISOString();
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

        logger.info(
          { chatJid, bot: this.tokenEnvName },
          'Session compacted and summary injected',
        );
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Failed to compact session',
        );
        ctx.reply('❌ 软重置失败，请检查服务器日志。');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = this.makeJid(ctx.chat.id);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups owned by this bot
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName, bot: this.tokenEnvName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Message isolation: skip if this group belongs to a different bot
      if (!this.ownsJid(chatJid)) return;

      // Check if there's pending media waiting for a follow-up text
      const pending = this.pendingMedia.get(chatJid);
      if (pending) {
        // Consume the pending media — merge text as the Vision API prompt
        clearTimeout(pending.timer);
        this.pendingMedia.delete(chatJid);
        logger.info(
          { chatJid, mediaType: pending.mediaType, bot: this.tokenEnvName },
          'Merging follow-up text with pending media',
        );
        // Process media with user's text as context (blocks Grammy, typing already on)
        await this.processAndStoreMedia(pending, content);
        // Also store the text message itself so the agent sees both
        // (the described media + the user's original text)
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: this.tokenEnvName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Message isolation: skip if this group belongs to a different bot
      if (!this.ownsJid(chatJid)) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group || !this.ownsJid(chatJid)) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption || undefined;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Show typing indicator while downloading the image
      await this.setTyping(chatJid, true);

      // Download the image first (fast, needed in all paths)
      let buffer: Buffer;
      try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        buffer = Buffer.from(await resp.arrayBuffer());
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Photo download failed',
        );
        const errorContent = caption
          ? `[Photo - download failed | Caption: ${caption}]`
          : '[Photo - download failed]';
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: errorContent,
          timestamp,
          is_from_me: false,
        });
        return;
      }

      if (caption) {
        // Has caption — process immediately, no need to wait for follow-up text
        const pending = {
          chatJid,
          fileUrl: '',
          buffer,
          timestamp,
          senderName,
          sender,
          msgId,
          mediaType: 'photo' as const,
          timer: setTimeout(() => {}, 0),
        };
        await this.processAndStoreMedia(pending, caption);
        await this.setTyping(chatJid, false);
      } else {
        // No caption — buffer and wait for possible follow-up text
        // Cancel any existing pending media for this chat
        const existing = this.pendingMedia.get(chatJid);
        if (existing) {
          clearTimeout(existing.timer);
          // Process the old pending media with generic prompt before replacing
          await this.processAndStoreMedia(existing, undefined);
        }

        const timer = setTimeout(() => {
          const entry = this.pendingMedia.get(chatJid);
          if (entry && entry.msgId === msgId) {
            this.pendingMedia.delete(chatJid);
            logger.info(
              { chatJid, bot: this.tokenEnvName },
              'No follow-up text, processing photo with generic prompt',
            );
            this.processAndStoreMedia(entry, undefined)
              .then(() => this.setTyping(chatJid, false))
              .catch((err) => {
                logger.error(
                  { chatJid, err, bot: this.tokenEnvName },
                  'Deferred photo processing failed',
                );
                this.setTyping(chatJid, false).catch(() => {});
              });
          }
        }, TelegramChannel.MEDIA_MERGE_WINDOW);

        this.pendingMedia.set(chatJid, {
          timer,
          chatJid,
          fileUrl: '',
          buffer,
          timestamp,
          senderName,
          sender,
          msgId,
          mediaType: 'photo',
        });
        logger.info(
          { chatJid, bytes: buffer.length, bot: this.tokenEnvName },
          'Photo buffered, waiting for follow-up text',
        );
      }
    });
    this.bot.on('message:video', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group || !this.ownsJid(chatJid)) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = ctx.from?.id?.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption || undefined;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      await this.setTyping(chatJid, true);

      const video = ctx.message.video;
      const mimeType = video.mime_type || 'video/mp4';
      let buffer: Buffer;
      try {
        const file = await ctx.api.getFile(video.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        buffer = Buffer.from(await resp.arrayBuffer());
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Video download failed',
        );
        const errorContent = caption
          ? `[Video - download failed | Caption: ${caption}]`
          : '[Video - download failed]';
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content: errorContent,
          timestamp,
          is_from_me: false,
        });
        return;
      }

      if (caption) {
        const pending = {
          chatJid,
          fileUrl: '',
          buffer,
          timestamp,
          senderName,
          sender,
          msgId,
          mediaType: 'video' as const,
          mimeType,
          timer: setTimeout(() => {}, 0),
        };
        await this.processAndStoreMedia(pending, caption);
        await this.setTyping(chatJid, false);
      } else {
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
              { chatJid, bot: this.tokenEnvName },
              'No follow-up text, processing video with generic prompt',
            );
            this.processAndStoreMedia(entry, undefined)
              .then(() => this.setTyping(chatJid, false))
              .catch((err) => {
                logger.error(
                  { chatJid, err, bot: this.tokenEnvName },
                  'Deferred video processing failed',
                );
                this.setTyping(chatJid, false).catch(() => {});
              });
          }
        }, TelegramChannel.MEDIA_MERGE_WINDOW);

        this.pendingMedia.set(chatJid, {
          timer,
          chatJid,
          fileUrl: '',
          buffer,
          timestamp,
          senderName,
          sender,
          msgId,
          mediaType: 'video',
          mimeType,
        });
        logger.info(
          { chatJid, bytes: buffer.length, bot: this.tokenEnvName },
          'Video buffered, waiting for follow-up text',
        );
      }
    });
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      if (!this.ownsJid(chatJid)) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Show typing indicator while downloading & transcribing the voice message
      await this.setTyping(chatJid, true);

      let finalContent: string;
      try {
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());

        // Cache media
        const mediaId = saveToMediaCache(resolveAgentName(group.botToken), buffer, 'audio');

        const transcript = await transcribeAudioMessage(buffer);
        finalContent = transcript
          ? `[Voice: ${transcript} | MediaID: ${mediaId}]`
          : `[Voice Message - transcription unavailable | MediaID: ${mediaId}]`;
        logger.info(
          { chatJid, bytes: buffer.length, bot: this.tokenEnvName },
          'Voice message transcribed and cached',
        );
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Voice transcription/caching failed',
        );
        finalContent = '[Voice Message - transcription failed]';
      }

      // Don't stop typing here — let it flow seamlessly into processGroupMessages
      // Actually, we must stop it here because if the agent doesn't respond (no trigger),
      // the typing indicator will stay on indefinitely. The message loop will re-enable it
      // if it does decide to process the message.
      await this.setTyping(chatJid, false);

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: finalContent,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group || !this.ownsJid(chatJid)) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        const file = await ctx.api.getFile(ctx.message.audio.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const mediaId = saveToMediaCache(resolveAgentName(group.botToken), buffer, 'audio');

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Audio | MediaID: ${mediaId}]`,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Telegram audio download failed',
        );
        storeNonText(ctx, '[Audio - download failed]');
      }
    });

    this.bot.on('message:document', async (ctx) => {
      const chatJid = this.makeJid(ctx.chat.id);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group || !this.ownsJid(chatJid)) return;

      const name = ctx.message.document?.file_name || 'file';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        const file = await ctx.api.getFile(ctx.message.document.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        const mediaId = saveToMediaCache(resolveAgentName(group.botToken), buffer, 'document');

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Document: ${name} | MediaID: ${mediaId}]`,
          timestamp,
          is_from_me: false,
        });
      } catch (err) {
        logger.error(
          { chatJid, err, bot: this.tokenEnvName },
          'Telegram document download failed',
        );
        storeNonText(ctx, `[Document: ${name} - download failed]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error(
        { err: err.message, bot: this.tokenEnvName },
        'Telegram bot error',
      );
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            {
              username: botInfo.username,
              id: botInfo.id,
              tokenEnvName: this.tokenEnvName,
            },
            'Telegram bot connected',
          );
          console.log(
            `\n  Telegram bot: @${botInfo.username} (${this.tokenEnvName})`,
          );
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn({ bot: this.tokenEnvName }, 'Telegram bot not initialized');
      return;
    }

    try {
      const numericId = TelegramChannel.extractChatId(jid);

      // Clear typing indicator before sending
      await this.setTyping(jid, false);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, bot: this.tokenEnvName },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, bot: this.tokenEnvName },
        'Failed to send Telegram message',
      );
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  async disconnect(): Promise<void> {
    // Clear all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    // Clear all pending media timers
    for (const entry of this.pendingMedia.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingMedia.clear();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info({ bot: this.tokenEnvName }, 'Telegram bot stopped');
    }
  }

  /**
   * Process buffered media with the Vision API and store the result.
   * @param media - The buffered media entry from pendingMedia
   * @param userText - Follow-up text from user (used as Vision prompt), or undefined for generic
   */
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
      mediaId = saveToMediaCache(resolveAgentName(group.botToken), buffer, mediaType);
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
        { chatJid, bytes: buffer.length, mediaType, bot: this.tokenEnvName },
        `${label} message processed`,
      );
    } catch (err) {
      logger.error(
        { chatJid, err, mediaType, bot: this.tokenEnvName },
        `${label} description failed`,
      );
      finalContent = userText
        ? `[${label} - description failed | User: ${userText}]`
        : `[${label} - description failed]`;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: finalContent,
      timestamp,
      is_from_me: false,
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Clear any existing interval for this JID first
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!this.bot || !isTyping) return;

    const numericId = TelegramChannel.extractChatId(jid);
    // Send immediately, then refresh every 4s (Telegram expires after ~5s)
    const send = () => {
      this.bot?.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      });
    };
    send();
    this.typingIntervals.set(jid, setInterval(send, 4000));
  }

  async sendStatusMessage(jid: string, text: string): Promise<number | null> {
    if (!this.bot) return null;
    try {
      const numericId = TelegramChannel.extractChatId(jid);
      const msg = await this.bot.api.sendMessage(numericId, text);
      return msg.message_id;
    } catch (err) {
      logger.debug(
        { jid, err, bot: this.tokenEnvName },
        'Failed to send status message',
      );
      return null;
    }
  }

  async editStatusMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = TelegramChannel.extractChatId(jid);
      await this.bot.api.editMessageText(numericId, messageId, text);
    } catch (err) {
      logger.debug(
        { jid, messageId, err, bot: this.tokenEnvName },
        'Failed to edit status message',
      );
    }
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = TelegramChannel.extractChatId(jid);
      await this.bot.api.deleteMessage(numericId, messageId);
    } catch (err) {
      logger.debug(
        { jid, messageId, err, bot: this.tokenEnvName },
        'Failed to delete status message',
      );
    }
  }

  async sendMedia(
    jid: string,
    buffer: Buffer,
    mediaType: 'photo' | 'video' | 'audio' | 'document',
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn({ bot: this.tokenEnvName }, 'Telegram bot not initialized');
      return;
    }

    try {
      const numericId = TelegramChannel.extractChatId(jid);

      // Clear typing indicator before sending
      await this.setTyping(jid, false);

      const file = new InputFile(buffer);
      const opts = caption ? { caption } : {};

      switch (mediaType) {
        case 'photo':
          await this.bot.api.sendPhoto(numericId, file, opts);
          break;
        case 'video':
          await this.bot.api.sendVideo(numericId, file, opts);
          break;
        case 'audio':
          await this.bot.api.sendVoice(numericId, file, opts);
          break;
        case 'document':
          await this.bot.api.sendDocument(numericId, file, opts);
          break;
      }
      logger.info(
        { jid, mediaType, bytes: buffer.length, bot: this.tokenEnvName },
        'Telegram media sent',
      );
    } catch (err) {
      logger.error(
        { jid, mediaType, err, bot: this.tokenEnvName },
        'Failed to send Telegram media',
      );
    }
  }
}

// --- Bot Pool for Agent Swarm ---
import { Api } from 'grammy';

const poolApis: Api[] = [];

/**
 * Initialize send-only Api instances for the bot pool.
 * Only the first bot is used as the "spokesperson" for all sub-agents.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via the pool bot with the sender name prefixed.
 * Uses the first pool bot as a shared "spokesperson" — no renaming.
 * Returns true on success, false on failure (caller should fallback).
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  _groupFolder: string,
): Promise<boolean> {
  if (poolApis.length === 0) return false;

  const api = poolApis[0];
  const prefixedText = `*${sender}*:\n${text}`;

  try {
    const numericId = chatId.replace(/^tg:/, '').replace(/@.*$/, '');
    const MAX_LENGTH = 4096;
    if (prefixedText.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, prefixedText);
    } else {
      for (let i = 0; i < prefixedText.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, prefixedText.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, length: text.length }, 'Pool message sent');
    return true;
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
    return false;
  }
}

/**
 * Multi-bot factory: reads bot tokens from agents.yaml first,
 * falls back to TELEGRAM_BOT_TOKEN_* env vars for backwards compatibility.
 */
registerChannel('telegram', (opts: ChannelOpts) => {
  // Try agents.yaml first
  const botConfigs = getAllBotConfigs();

  if (botConfigs.length > 0) {
    const channels: TelegramChannel[] = [];
    for (let i = 0; i < botConfigs.length; i++) {
      const cfg = botConfigs[i];
      if (!cfg.token) continue;
      // Stable env name for ownsJid matching (1-based index)
      const envName = `TELEGRAM_BOT_TOKEN_${i + 1}`;
      // Also write to process.env so _getFirstTokenEnvName() works
      process.env[envName] = cfg.token;
      channels.push(new TelegramChannel(cfg.token, envName, opts));
    }
    if (channels.length > 0) {
      logger.info(
        { count: channels.length, bots: channels.map((c) => c.name) },
        'Created Telegram bots from agents.yaml',
      );
      return channels;
    }
  }

  // Fallback: env vars
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    ...Array.from({ length: 10 }, (_, i) => `TELEGRAM_BOT_TOKEN_${i + 1}`),
  ]);
  const allEnv: Record<string, string> = { ...envVars };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TELEGRAM_BOT_TOKEN') && process.env[key]) {
      allEnv[key] = process.env[key]!;
    }
  }

  const tokenEntries: Array<{ envName: string; token: string }> = [];
  for (const [key, value] of Object.entries(allEnv)) {
    if (key.startsWith('TELEGRAM_BOT_TOKEN_') && value) {
      tokenEntries.push({ envName: key, token: value });
    }
  }

  if (tokenEntries.length === 0) {
    const legacyToken = allEnv.TELEGRAM_BOT_TOKEN || '';
    if (!legacyToken) {
      logger.warn(
        'Telegram: no bot tokens configured (check agents.yaml or .env)',
      );
      return null;
    }
    return new TelegramChannel(legacyToken, 'TELEGRAM_BOT_TOKEN', opts);
  }

  tokenEntries.sort((a, b) => a.envName.localeCompare(b.envName));
  return tokenEntries.map(
    ({ envName, token }) => new TelegramChannel(token, envName, opts),
  );
});
