import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import * as url from 'url';

import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { gatewayServer } from '../gateway.js';
import { logger } from '../logger.js';
import { GATEWAY_AUTH_TOKEN } from '../config.js';

export interface AppChannelOpts extends ChannelOpts {
  path?: string;
}

export class AppChannel implements Channel {
  name = 'app';
  private opts: AppChannelOpts;

  // Maps JID (e.g. app:pixel_123) to active WebSocket connection
  private connections = new Map<string, WebSocket>();
  // Inverse map to lookup JID by WS
  private socketJids = new WeakMap<WebSocket, string>();

  constructor(opts: AppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Wait until gatewayServer is initialized by index.ts
    const checkInterval = setInterval(() => {
      if (gatewayServer) {
        clearInterval(checkInterval);
        gatewayServer.registerWsHandler(
          '/ws/app',
          this.handleUpgrade.bind(this),
        );
        logger.info('AppChannel connected and registered handler on /ws/app');
      }
    }, 100);
  }

  isConnected(): boolean {
    return true; // The gateway server dictates actual liveness
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('app:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const ws = this.connections.get(jid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'message',
          content: text,
          isFromBot: true,
          sender: 'NanoClaw', // Standard fallback, though app might use system names
        }),
      );
    } else {
      logger.warn(
        { jid },
        'Attempted to send message to offline or non-existent App device',
      );
    }
  }

  async setTyping(jid: string, typing: boolean): Promise<void> {
    const ws = this.connections.get(jid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'typing',
          isTyping: typing,
        }),
      );
    }
  }

  async sendStatusMessage(jid: string, text: string): Promise<number | null> {
    // For AppChannel, we map status messages to regular messages
    // or we could use the typing indicator. We'll send it as a status type.
    const ws = this.connections.get(jid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'status',
          content: text,
        }),
      );
    }
    return Date.now();
  }

  async editStatusMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    // App doesn't currently support editing inline, but we can emit a status update
    this.sendStatusMessage(jid, text);
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    // Delete status message mapping when done
    const ws = this.connections.get(jid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'status_clear',
        }),
      );
    }
  }

  async disconnect(): Promise<void> {
    for (const ws of this.connections.values()) {
      ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
  }

  // --- WebSocket Handling ---

  private handleUpgrade(req: IncomingMessage, ws: WebSocket) {
    logger.info('New WebSocket connection on AppChannel');

    // Add heartbeat and timeout mechanisms if necessary

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleClientMessage(ws, msg);
      } catch (err) {
        logger.error({ err }, 'Failed to parse AppChannel message');
        ws.send(
          JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }),
        );
      }
    });

    ws.on('close', () => {
      const jid = this.socketJids.get(ws);
      if (jid) {
        this.connections.delete(jid);
        logger.info({ jid }, 'App device disconnected');
      }
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'AppChannel WebSocket error');
    });
  }

  private async handleClientMessage(ws: WebSocket, msg: any) {
    const type = msg.type;

    if (type === 'auth') {
      const { deviceId, token } = msg;

      // Also support query param auth optionally, but payload is cleaner
      const urlToken = url.parse(ws.url || '', true)?.query?.token;

      const providedToken = token || urlToken;

      if (!providedToken || providedToken !== GATEWAY_AUTH_TOKEN) {
        ws.send(
          JSON.stringify({
            type: 'auth_result',
            success: false,
            reason: 'Invalid token',
          }),
        );
        ws.close(4001, 'Unauthorized');
        logger.warn({ deviceId }, 'AppChannel auth failed');
        return;
      }

      if (!deviceId) {
        ws.send(
          JSON.stringify({
            type: 'auth_result',
            success: false,
            reason: 'Missing deviceId',
          }),
        );
        return;
      }

      const jid = `app:${deviceId}`;

      // Handle replace connection
      const existing = this.connections.get(jid);
      if (existing && existing !== ws) {
        existing.close(4002, 'Replaced by new connection');
      }

      this.connections.set(jid, ws);
      this.socketJids.set(ws, jid);

      ws.send(JSON.stringify({ type: 'auth_result', success: true, jid }));
      logger.info({ jid }, 'App device authenticated successfully');

      // Emit chat metadata to establish the group
      this.opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        `Device ${deviceId}`,
        'app',
        false,
      );
      return;
    }

    // Require auth for other messages
    const jid = this.socketJids.get(ws);
    if (!jid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
      return;
    }

    if (type === 'message') {
      const { content } = msg;

      if (!content) return;

      const messageId = `app_msg_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      // Deliver to agent runner
      this.opts.onMessage(jid, {
        id: messageId,
        chat_jid: jid,
        sender: jid.split(':')[1],
        sender_name: 'App User',
        content: content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      // Send ACK back to app
      ws.send(JSON.stringify({ type: 'ack', messageId }));
    }
  }
}

// Auto-register
registerChannel('app', (opts: ChannelOpts) => new AppChannel(opts));
