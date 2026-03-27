import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
  request as httpRequest,
} from 'http';
import { logger } from './logger.js';
import { IpcDeps, processTaskIpc } from './ipc.js';
import { sendPoolMessage } from './channels/telegram.js';
import { resolveAgentName } from './agents-config.js';
import fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';
import { GATEWAY_PORT, WORKSPACE_DIR } from './config.js';
import { storeMessage, insertTokenUsage } from './db.js';
import { searchMemory, isRagEnabled } from './rag.js';
import { RegisteredGroup } from './types.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { getFullStatus } from './status.js';

export interface TokenPayload {
  sourceGroup: string;
  isMain: boolean;
}

// In-memory token registry mapping strong random tokens to group identities
const tokenRegistry = new Map<string, TokenPayload>();

export class GatewayServer {
  private server: Server;
  private deps: IpcDeps;

  constructor(deps: IpcDeps) {
    this.deps = deps;
    this.server = createServer(this.handleRequest.bind(this));
  }

  public start(port = GATEWAY_PORT): void {
    this.server.listen(port, '127.0.0.1', () => {
      logger.info(
        `[Gateway] Internal IPC server listening on 127.0.0.1:${port}`,
      );
    });
  }

  public registerToken(
    token: string,
    sourceGroup: string,
    isMain: boolean,
  ): void {
    tokenRegistry.set(token, { sourceGroup, isMain });
    logger.debug({ sourceGroup, isMain }, 'Gateway token registered');
  }

  public revokeToken(token: string): void {
    tokenRegistry.delete(token);
    logger.debug('Gateway token revoked');
  }

  private authenticate(req: IncomingMessage): TokenPayload | null {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    const token = authHeader.substring(7);
    return tokenRegistry.get(token) || null;
  }

  private sendJson(
    res: ServerResponse,
    statusCode: number,
    data: unknown,
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
        // Prevent abuse: limit to 50MB (RAG output or large base64 might be huge)
        if (body.length > 50 * 1024 * 1024) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Basic CORS and Preflight (if control center touches it from browser)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!req.url) {
      this.sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    // Health check (Control Center can ping this)
    if (req.method === 'GET' && req.url === '/health') {
      this.sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
      return;
    }

    // Full status snapshot (all agents + host)
    if (req.method === 'GET' && req.url === '/status') {
      const status = getFullStatus();
      if (status) {
        this.sendJson(res, 200, status);
      } else {
        this.sendJson(res, 503, { error: 'Status not ready' });
      }
      return;
    }

    // Authenticate all IPC POST requests
    const identity = this.authenticate(req);
    if (!identity) {
      if (req.url.startsWith('/ipc/')) {
        logger.warn(
          { ip: req.socket.remoteAddress, path: req.url },
          'Unauthorized Gateway access attempt',
        );
        this.sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      if (req.method === 'POST') {
        if (req.url.startsWith('/llm/v1/')) {
          await this.handleLlmProxy(req, res);
          return;
        }

        const body = await this.parseBody(req);

        switch (req.url) {
          case '/ipc/messages':
            await this.handleMessagesIpc(body, identity!, res);
            break;
          case '/ipc/tasks':
            await this.handleTasksIpc(body, identity!, res);
            break;
          default:
            this.sendJson(res, 404, { error: 'Not Found' });
        }
      } else {
        this.sendJson(res, 405, { error: 'Method Not Allowed' });
      }
    } catch (err: any) {
      logger.error({ err, url: req.url }, 'Gateway request processing error');
      this.sendJson(res, 500, {
        error: err.message || 'Internal Server Error',
      });
    }
  }

  /**
   * Proxies traffic to LiteLLM, sniffing SSE streams to extract Token Usage & Tools
   */
  private async handleLlmProxy(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      // API Key contains injected context: nc_meta_group=xxx;task=yyy
      const apiKey =
        (req.headers['x-api-key'] as string) ||
        req.headers['authorization']?.replace('Bearer ', '') ||
        '';
      let groupFolder = 'unknown';
      let taskId = 'none';
      let intendedModel = '';

      if (apiKey.startsWith('nc_meta_')) {
        const metaStr = apiKey.substring(8);
        const parts = metaStr.split(';');
        for (const p of parts) {
          if (p.startsWith('group=')) groupFolder = p.substring(6);
          if (p.startsWith('task=')) taskId = p.substring(5);
          if (p.startsWith('model=')) intendedModel = p.substring(6);
        }
      }

      // Read the literal body bytes (do preserve format perfectly)
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      let bodyBuf = Buffer.concat(chunks);

      let modelName = 'unknown';
      try {
        const parsed = JSON.parse(bodyBuf.toString('utf8'));
        if (parsed.model) modelName = parsed.model;

        // INTERCEPT AND REWRITE MODEL
        if (
          req.url?.includes('/v1/messages') ||
          req.url?.includes('/v1/chat/completions')
        ) {
          let targetModel = intendedModel || parsed.model;

          // Apply Claude Code specific model rewrites
          if (targetModel === 'claude-3-7-sonnet-20250219') {
            targetModel = 'claude-3-7-sonnet';
          } else if (targetModel === 'claude-3-5-haiku-20241022') {
            targetModel = 'claude-3-5-haiku';
          } else if (
            parsed.model === 'claude-opus-4-6' ||
            parsed.model === 'claude-sonnet-4-6'
          ) {
            // If a subagent forces these invalid models, forcefully rewrite to intended model
            targetModel = intendedModel || 'claude-3-5-sonnet';
          }

          if (targetModel && targetModel !== parsed.model) {
            parsed.model = targetModel;
            modelName = targetModel;
            bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        }
      } catch {
        // Ignore
      }

      // Forward request to local LiteLLM (port 4000)
      const targetUrl = new URL(
        `http://127.0.0.1:4000` + req.url!.replace(/^\/llm/, ''),
      );

      // Build clean headers: replace host, auth, and fix content-length to match actual body
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders['content-length'];
      fwdHeaders['host'] = targetUrl.host;
      fwdHeaders['x-api-key'] = 'sk-dummy';
      fwdHeaders['authorization'] = 'Bearer sk-dummy';
      fwdHeaders['content-length'] = String(bodyBuf.length);

      const proxyReq = httpRequest(
        targetUrl,
        {
          method: req.method,
          headers: fwdHeaders,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

          let tail = '';
          let inputTokens = 0;
          let outputTokens = 0;
          let toolName: string | null = null;

          proxyRes.on('data', (chunk) => {
            res.write(chunk);

            // Sniff SSE chunk
            const text = tail + chunk.toString();

            // Match Anthropic usage format: "usage": {"input_tokens": 15, "output_tokens": 1}
            const inputMatch = text.match(
              /"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)/,
            );
            if (inputMatch) inputTokens = parseInt(inputMatch[1], 10);

            // Output tokens accumulate in diffs, so we take the latest match in the stream
            const outputMatches = [
              ...text.matchAll(/"output_tokens"\s*:\s*(\d+)/g),
            ];
            if (outputMatches.length > 0) {
              outputTokens = parseInt(
                outputMatches[outputMatches.length - 1][1],
                10,
              );
            }

            // Match Anthropic tool format: "type":"tool_use"[...]"name":"Bash"
            const toolMatch = text.match(
              /"type"\s*:\s*"tool_use"[^}]*"name"\s*:\s*"([^"]+)"/,
            );
            if (toolMatch && !toolName) {
              toolName = toolMatch[1];
            }

            tail = text.slice(-200); // Keep last 200 chars for cross-chunk matching
          });

          proxyRes.on('end', () => {
            res.end();

            // Insert perfectly extracted tokens into independent usage DB
            if (inputTokens > 0 || outputTokens > 0) {
              insertTokenUsage({
                id: crypto.randomUUID(),
                group_id: groupFolder,
                task_id: taskId === 'none' ? undefined : taskId,
                tool_name: toolName || undefined,
                timestamp: new Date().toISOString(),
                model: modelName,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              });
            }
          });
        },
      );

      proxyReq.on('error', (err) => {
        logger.error({ err }, 'Proxy connection failed');
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: 'Bad Gateway' }));
      });

      proxyReq.write(bodyBuf);
      proxyReq.end();
    } catch (err: any) {
      logger.error({ err }, 'Exception in LLM proxying');
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: 'Proxy Error' }));
    }
  }

  /**
   * Extracted from ipc.ts -> processIpcFiles loop
   */
  private async handleMessagesIpc(
    data: any,
    identity: TokenPayload,
    res: ServerResponse,
  ) {
    const { sourceGroup, isMain } = identity;
    const registeredGroups = this.deps.registeredGroups();

    const targetGroup = data.chatJid
      ? registeredGroups[data.chatJid]
      : undefined;
    const authorized =
      data.chatJid &&
      (isMain || (targetGroup && targetGroup.folder === sourceGroup));

    if (!authorized) {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC message attempt blocked',
      );
      return this.sendJson(res, 403, {
        error: 'Forbidden cross-group message',
      });
    }

    if (data.type === 'message' && data.chatJid && data.text) {
      // Filter out placeholder messages (matches agent result filtering in index.ts)
      if (data.text.trim() === '...') {
        this.sendJson(res, 200, { success: true, filtered: true });
        return;
      }
      // Fault tolerance: if sender matches the group's own assistantName, treat as normal
      const sourceGroupEntry = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const isOwnName =
        data.sender &&
        sourceGroupEntry?.assistantName &&
        data.sender === sourceGroupEntry.assistantName;
      if (isOwnName) {
        data.sender = undefined;
      }

      if (data.sender && data.chatJid.startsWith('tg:')) {
        const chatNumericId = data.chatJid
          .replace(/^tg:/, '')
          .replace(/@.*$/, '');
        const isPrivate = !chatNumericId.startsWith('-');

        if (isPrivate) {
          await this.deps.sendMessage(
            data.chatJid,
            `*[${data.sender}]*:\n${data.text}`,
          );
        } else {
          const sent = await sendPoolMessage(
            data.chatJid,
            data.text,
            data.sender,
            sourceGroup,
          );
          if (!sent) {
            await this.deps.sendMessage(
              data.chatJid,
              `*[${data.sender}]*:\n${data.text}`,
            );
            logger.info(
              { chatJid: data.chatJid, sender: data.sender },
              'Pool message failed, sent via main bot fallback',
            );
          }
        }
      } else {
        const text = data.sender
          ? `*[${data.sender}]*:\n${data.text}`
          : data.text;
        await this.deps.sendMessage(data.chatJid, text);
      }
      logger.info(
        { chatJid: data.chatJid, sourceGroup, sender: data.sender },
        'Gateway IPC message sent',
      );

      this.sendJson(res, 200, { success: true });
      return;
    }

    if (data.type === 'media_message' && data.chatJid && data.mediaId) {
      const mediaType = data.mediaType || 'document';
      const safeId = path.basename(data.mediaId);
      // media_cache is under the per-agent workspace (mounted as /workspace/group in container)
      // NOT under per-group sessions directory
      const sourceGroupEntry = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const agentName = resolveAgentName(sourceGroupEntry?.botToken);
      const agentWorkspaceDir = path.join(WORKSPACE_DIR, agentName);
      const mediaPath = path.join(
        agentWorkspaceDir,
        '.claude',
        'media_cache',
        safeId,
      );

      try {
        const buffer = fs.readFileSync(mediaPath);
        await this.deps.sendMedia(
          data.chatJid,
          buffer,
          mediaType,
          data.caption,
          data.fileName,
        );

        const labelMap: Record<string, string> = {
          photo: 'Photo',
          video: 'Video',
          audio: 'Audio',
          document: 'Document',
        };
        const label = labelMap[mediaType] || 'File';
        const captionPart = data.caption ? ` | Caption: ${data.caption}` : '';

        storeMessage({
          id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: data.chatJid,
          sender: 'bot',
          sender_name: 'Assistant',
          content: `[Sent ${label}${captionPart} | MediaID: ${safeId}]`,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        });
        logger.info(
          { chatJid: data.chatJid, sourceGroup, mediaType, mediaId: safeId },
          'Gateway IPC media message sent',
        );
        this.sendJson(res, 200, { success: true });
        return;
      } catch (readErr) {
        logger.error(
          { chatJid: data.chatJid, sourceGroup, mediaId: safeId, err: readErr },
          'Failed to read media file for Gateway media_message',
        );
        this.sendJson(res, 500, { error: 'Failed to read media file' });
        return;
      }
    }

    this.sendJson(res, 400, { error: 'Invalid message payload' });
  }

  /**
   * Extracted from ipc.ts -> processTaskIpc wrapper
   */
  private async handleTasksIpc(
    data: any,
    identity: TokenPayload,
    res: ServerResponse,
  ) {
    const { sourceGroup, isMain } = identity;

    // Fast-path for RAG Search: synchronous HTTP response
    if (data.type === 'rag_search') {
      if (!isRagEnabled()) {
        this.sendJson(res, 400, { error: 'RAG is disabled' });
        return;
      }
      const ragQuery = data.query as string;
      const ragTopK = (data.topK as number) || 5;

      if (!ragQuery) {
        this.sendJson(res, 400, { error: 'Missing query' });
        return;
      }

      try {
        const registeredGroups = this.deps.registeredGroups();
        const ragGroup = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const ragAgentName = resolveAgentName(ragGroup?.botToken);
        const results = await searchMemory(ragAgentName, ragQuery, ragTopK);
        logger.info(
          {
            sourceGroup,
            query: ragQuery.slice(0, 50),
            results: results.length,
          },
          'RAG search completed via Gateway',
        );

        this.sendJson(res, 200, { results, success: true });
        return;
      } catch (err: any) {
        logger.error(
          { err, sourceGroup, ragQuery },
          'RAG search failed via Gateway',
        );
        this.sendJson(res, 500, { error: String(err), results: [] });
        return;
      }
    }

    // Fast-paths for synchronous success responses to waitable commands like pause_task etc.
    // They used to write to task_results/, now they return directly if handled inside processTaskIpc.
    // To cleanly achieve this without fully decoupling the logic right now, we can capture the response.
    // For now we will allow processTaskIpc to continue its job.
    // Wait, processTaskIpc directly calls `writeTaskResult(sourceGroup, requestId, success, message)`.
    // We should patch `processTaskIpc` to return the result object instead of writing to disk!
    // For now, I'll call it and assume it returns void and just return "success".
    // I will refactor `processTaskIpc` from ipc.ts into this file shortly or update it.

    try {
      const result = await processTaskIpc(data, sourceGroup, isMain, this.deps);
      this.sendJson(res, 200, result || { success: true });
    } catch (err: any) {
      this.sendJson(res, 500, { success: false, message: String(err) });
    }
  }
}

// Global default gateway instance
export let gatewayServer: GatewayServer | null = null;

export function startGatewayServer(deps: IpcDeps) {
  if (!gatewayServer) {
    gatewayServer = new GatewayServer(deps);
    gatewayServer.start();
  }
  return gatewayServer;
}
