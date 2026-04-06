/**
 * NanoClaw Control Center – Integrated UI Server
 * Dark glassmorphism dashboard running on GATEWAY_PORT+1 (default 18790).
 */

import { createServer, type Server } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createReadStream, statSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { GATEWAY_PORT } from './config.js';
import { logger } from './logger.js';
import { Section, SECTIONS, Lang } from './web/types.js';
import { Layout } from './web/components/Layout.js';
import {
  OverviewPage,
  UsagePage,
  AgentPage,
  DocsPage,
  TasksPage,
  AlertsPage,
  SettingsPage,
  LoginPage,
  LoggerPage,
} from './web/pages/index.js';
import {
  getWorkspaceFilePath,
  deleteWorkspaceFile,
  renameWorkspaceFile,
  copyWorkspacePath,
  moveWorkspacePath,
  writeWorkspaceTextFile,
  writeWorkspaceBase64File,
  createWorkspaceDir,
} from './web/data.js';
import { GATEWAY_AUTH_TOKEN } from './config.js';

const LITELLM_DIR = join(process.cwd(), 'litellm');
const CC_PORT = GATEWAY_PORT + 1;

export function getControlCenterHandler() {
  const defaultLang: Lang = 'zh';
  return async (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    try {
      let rawUrl = req.url ?? '/';
      if (rawUrl.startsWith('/cc')) {
        rawUrl = rawUrl.substring(3);
        if (rawUrl === '') rawUrl = '/';
      }
      const url = new URL(rawUrl, 'http://127.0.0.1');

      const lang: Lang =
        (url.searchParams.get('lang') || defaultLang) === 'en' ? 'en' : 'zh';

      // ======== AUTHENTICATION MIDDLEWARE ========
      const remoteIp = req.socket.remoteAddress || '';
      const isLocal =
        remoteIp === '127.0.0.1' ||
        remoteIp === '::1' ||
        remoteIp === '::ffff:127.0.0.1';

      let isAuthenticated = isLocal;
      if (!isAuthenticated) {
        // Check Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          isAuthenticated = authHeader.substring(7) === GATEWAY_AUTH_TOKEN;
        }
        // Check Cookies
        if (!isAuthenticated && req.headers.cookie) {
          const cookies = Object.fromEntries(
            req.headers.cookie.split(';').map((c) => {
              const [k, v] = c.split('=');
              return [k?.trim(), v?.trim()];
            }),
          );
          isAuthenticated = cookies['nc_auth'] === GATEWAY_AUTH_TOKEN;
        }
      }

      // Handle Authentication Routes (Skipping middleware loop if matched)
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            if (data.token === GATEWAY_AUTH_TOKEN) {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': `nc_auth=${GATEWAY_AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Strict`,
              });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ success: false, error: 'Invalid token' }),
              );
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ success: false, error: 'Invalid request' }),
            );
          }
        });
        return;
      }

      if (url.pathname === '/login') {
        const html = new LoginPage().render(lang);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // Enforce Authentication
      if (!isAuthenticated) {
        if (req.headers.accept?.includes('text/html') || url.pathname === '/') {
          res.writeHead(302, { Location: `/cc/login?lang=${lang}` });
          return res.end();
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(
            JSON.stringify({ success: false, error: 'Unauthorized' }),
          );
        }
      }
      // ======== END AUTHENTICATION ========

      // ======== FILE MANAGEMENT APIS ========
      if (url.pathname.startsWith('/api/fs/')) {
        const action = url.pathname.replace('/api/fs/', '');

        // GET Download
        if (action === 'download' && req.method === 'GET') {
          const agent = url.searchParams.get('agent') || '';
          const file = url.searchParams.get('file') || '';
          const fullPath = getWorkspaceFilePath(agent, file);
          if (!fullPath) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File not found or invalid path');
          }
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              return res.end('Cannot download a directory');
            }
            const filename = file.split('/').pop() || 'downloaded_file';
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
              'Content-Length': stat.size,
            });
            return createReadStream(fullPath).pipe(res);
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('Error reading file');
          }
        }

        // POST JSON APIs for FS operations
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk.toString()));
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}');
              const {
                agent,
                sourceAgent,
                targetAgent,
                path,
                oldPath,
                newPath,
                sourcePath,
                targetPath,
                content,
                contentBase64,
              } = data;
              let success = false;
              let error = '';

              try {
                switch (action) {
                  case 'delete':
                    success = deleteWorkspaceFile(agent, path);
                    if (!success) error = 'Failed to delete path';
                    break;
                  case 'rename':
                    success = renameWorkspaceFile(agent, oldPath, newPath);
                    if (!success) error = 'Failed to rename path';
                    break;
                  case 'copy':
                    success = copyWorkspacePath(
                      sourceAgent || agent,
                      sourcePath,
                      targetAgent || agent,
                      targetPath,
                    );
                    if (!success) error = 'Failed to copy path';
                    break;
                  case 'move':
                    success = moveWorkspacePath(
                      sourceAgent || agent,
                      sourcePath,
                      targetAgent || agent,
                      targetPath,
                    );
                    if (!success) error = 'Failed to move path';
                    break;
                  case 'write':
                    success = writeWorkspaceTextFile(
                      agent,
                      path,
                      content || '',
                    );
                    if (!success) error = 'Failed to write file';
                    break;
                  case 'upload':
                    success = writeWorkspaceBase64File(
                      agent,
                      path,
                      contentBase64 || '',
                    );
                    if (!success) error = 'Failed to upload file';
                    break;
                  case 'mkdir':
                    success = createWorkspaceDir(agent, path);
                    if (!success) error = 'Failed to create directory';
                    break;
                  default:
                    error = 'Unknown action';
                    break;
                }
              } catch (e: any) {
                success = false;
                error = e.message || 'Internal FS error';
              }

              res.writeHead(success ? 200 : 400, {
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ success, error }));
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ success: false, error: 'Invalid JSON' }),
              );
            }
          });
          return;
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }
      // ======== CONFIGURATION APIS ========
      if (url.pathname.startsWith('/api/config/')) {
        const action = url.pathname.replace('/api/config/', '');

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk.toString()));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');

              if (action === 'agent') {
                const { name, channel, model, token, isUpdate } = data;
                if (!name) throw new Error('Agent name is required');
                const { addAgentConfig, updateAgentConfig } =
                  await import('./web/data.js');
                const botPayload: any = { name, model };
                if (channel) botPayload.channel = channel;
                if (token) botPayload.token = token;

                let success = false;
                if (isUpdate) {
                  success = updateAgentConfig(botPayload);
                } else {
                  success = addAgentConfig(botPayload);
                }
                res.writeHead(success ? 200 : 400, {
                  'Content-Type': 'application/json',
                });
                return res.end(
                  JSON.stringify({
                    success,
                    error: success ? undefined : 'Failed to save agent config',
                  }),
                );
              }

              if (action === 'group') {
                const {
                  jid,
                  name,
                  folder,
                  trigger_pattern,
                  is_main,
                  assistant_name,
                  bot_token,
                  model,
                } = data;
                if (!jid || !name || !folder)
                  throw new Error('JID, name and folder are required');

                const { setRegisteredGroup } = await import('./db.js');
                setRegisteredGroup(jid, {
                  name,
                  folder,
                  trigger: trigger_pattern || '',
                  added_at: new Date().toISOString(),
                  isMain: is_main,
                  requiresTrigger: is_main ? false : true,
                  assistantName: assistant_name,
                  botToken: bot_token,
                  model,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true }));
              }

              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({ success: false, error: 'Unknown action' }),
              );
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: false,
                  error: e.message || 'Error processing request',
                }),
              );
            }
          });
          return;
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }

      // ======== SYSTEM MANAGEMENT APIS ========
      if (url.pathname.startsWith('/api/system/')) {
        const action = url.pathname.replace('/api/system/', '');

        if (action === 'litellm-status' && req.method === 'GET') {
          try {
            const resp = await fetch('http://127.0.0.1:4000/health/readiness', {
              signal: AbortSignal.timeout(2000),
            }).catch(() => null);
            if (resp && resp.ok) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ status: 'ok' }));
            }
          } catch (e) {
            // ignore
          }
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'error' }));
        }

        if (req.method === 'POST') {
          if (action === 'restart-nanoclaw') {
            const scriptPath = join(process.cwd(), 'restart_nanoclaw.sh');
            const child = spawn(
              'bash',
              ['-c', `sleep 1 && bash "${scriptPath}"`],
              {
                detached: true,
                stdio: 'ignore',
              },
            );
            child.unref();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          }

          if (action === 'stop-nanoclaw') {
            const scriptPath = join(process.cwd(), 'stop_nanoclaw.sh');
            const child = spawn(
              'bash',
              ['-c', `sleep 1 && bash "${scriptPath}"`],
              {
                detached: true,
                stdio: 'ignore',
              },
            );
            child.unref();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          }

          if (action === 'restart-litellm') {
            const scriptPath = join(LITELLM_DIR, 'restart_litellm.sh');
            const child = spawn('bash', [scriptPath], {
              detached: true,
              stdio: 'ignore',
            });
            child.unref();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          }
        }

        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }
      // ======== ALERTS APIS ========
      if (url.pathname.startsWith('/api/alerts/')) {
        const action = url.pathname.replace('/api/alerts/', '');
        if (action === 'clear' && req.method === 'POST') {
          try {
            writeFileSync(
              join(process.cwd(), 'data', 'system-alerts.jsonl'),
              '',
              'utf-8',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(
              JSON.stringify({ success: false, error: e.message }),
            );
          }
        }
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }
      // ======== END ALERTS APIS ========

      // ======== LOGGER APIS ========
      if (url.pathname === '/api/logs/litellm/clear' && req.method === 'POST') {
        const dbPath = join(
          process.cwd(),
          'litellm',
          'logs',
          'litellm_logs.db',
        );
        try {
          if (existsSync(dbPath)) {
            try {
              const db = new Database(dbPath);
              db.exec('DELETE FROM logs');
              db.close();
            } catch (err: any) {
              if (err.message && err.message.includes('readonly')) {
                // If the LiteLLM container created the DB as root, we fallback to deleting it via docker exec
                execSync(
                  `docker exec nanoclaw-litellm-proxy python3 -c 'import sqlite3; conn=sqlite3.connect("/app/logs/litellm_logs.db"); conn.execute("DELETE FROM logs"); conn.commit(); conn.close()'`,
                );
              } else {
                throw err;
              }
            }
          }
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'HX-Trigger': 'refreshLogTable',
          });
          return res.end(
            '<tr><td colspan="4" class="empty-state" style="padding: 40px; text-align: center; color: var(--text-muted);">Loading logs...</td></tr>' +
              '\n<span id="log-count-badge" hx-swap-oob="true" style="font-size: 13px; color: var(--text-muted); background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.05); padding: 2px 10px; border-radius: 12px; font-weight: 500; letter-spacing: 0;">-</span>\n',
          );
        } catch (e: any) {
          logger.error({ err: e }, 'Failed to clear litellm logs');
          res.writeHead(500, { 'Content-Type': 'text/html' });
          return res.end(
            '<tr><td colspan="4" class="empty-state" style="padding: 24px; text-align: center; color: #ef4444;">Failed to clear logs</td></tr>',
          );
        }
      }

      if (url.pathname === '/api/logs/litellm' && req.method === 'GET') {
        const lines = parseInt(url.searchParams.get('lines') || '20', 10);
        const eventFilter = url.searchParams.get('event');
        const modelFilter = url.searchParams.get('model');
        const searchFilter = url.searchParams.get('search');

        const dbPath = join(
          process.cwd(),
          'litellm',
          'logs',
          'litellm_logs.db',
        );
        try {
          if (!existsSync(dbPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(
              '<tr><td colspan="4" class="empty-state">No logs found</td></tr>' +
                '\n<template><span id="log-count-badge" hx-swap-oob="true" style="font-size: 13px; color: var(--text-muted); background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.05); padding: 2px 10px; border-radius: 12px; font-weight: 500; letter-spacing: 0;">0</span></template>\n',
            );
          }

          const db = new Database(dbPath, { readonly: true });

          // Build SQL query with optional filters
          const conditions: string[] = [];
          const params: any[] = [];
          if (eventFilter) {
            conditions.push('event_type = ?');
            params.push(eventFilter);
          }
          if (modelFilter) {
            conditions.push('model LIKE ?');
            params.push(`%${modelFilter}%`);
          }
          if (searchFilter) {
            conditions.push('data LIKE ?');
            params.push(`%${searchFilter}%`);
          }

          const whereClause =
            conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
          const sql = `SELECT data FROM logs ${whereClause} ORDER BY id DESC LIMIT ?`;
          params.push(lines);

          const rows = db.prepare(sql).all(...params) as { data: string }[];
          db.close();

          // Parse JSON data from each row
          const filtered = rows
            .map((row) => {
              try {
                return JSON.parse(row.data);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          if (filtered.length === 0) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(
              '<tr><td colspan="4" class="empty-state">No matching logs</td></tr>' +
                '\n<template><span id="log-count-badge" hx-swap-oob="true" style="font-size: 13px; color: var(--text-muted); background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.05); padding: 2px 10px; border-radius: 12px; font-weight: 500; letter-spacing: 0;">0</span></template>\n',
            );
          }

          const escapeHtml = (u: string) =>
            String(u)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
          const renderJsonToFoldableHtml = (
            obj: any,
            keyName: string = '',
            isRoot = false,
          ): string => {
            const keyPrefix = keyName
              ? `<span style="color: #3b82f6; font-weight: 500; margin-right: 8px; flex-shrink: 0;">"${escapeHtml(keyName)}":</span>`
              : '';

            if (keyName === 'messages' && Array.isArray(obj)) {
              return renderLiteLLMMessages(obj, keyName);
            }
            if (keyName === 'tools' && Array.isArray(obj)) {
              const toolNames = obj
                .map((t: any) => t?.function?.name || t?.name || 'unknown')
                .filter(Boolean);
              return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<details style="display: inline-block; vertical-align: top;"><summary style="cursor: pointer; color: #10b981; user-select: none;">[ ${toolNames.length} tools ]</summary><div style="color: #10b981; word-break: break-all; white-space: pre-wrap; padding: 8px 12px; background: rgba(128,128,128,0.06); border: 1px solid rgba(128,128,128,0.1); border-radius: 6px; margin-top: 6px; width: fit-content;">${escapeHtml(toolNames.join(', '))}</div></details></div>`;
            }
            if (obj === null) {
              return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<span style="color: var(--text-muted, #9ca3af);">null</span></div>`;
            }
            if (typeof obj !== 'object') {
              let valStr = escapeHtml(String(obj));
              if (typeof obj === 'string') {
                if (obj.length > 40) {
                  const trunc = escapeHtml(obj.substring(0, 40)) + '...';
                  const isHuge = obj.length > 5000;
                  const displayStr = isHuge
                    ? escapeHtml(obj.substring(0, 5000)) +
                      `\n\n... [Truncated for UI performance, full length: ${obj.length}]`
                    : valStr;
                  return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<details style="display: inline-block; vertical-align: top;"><summary style="cursor: pointer; color: #10b981; user-select: none;">"${trunc}" <span style="opacity:0.6; font-size:0.9em;">(${obj.length} chars)</span></summary><div style="color: #10b981; word-break: break-all; white-space: pre-wrap; padding: 8px 12px; background: rgba(128,128,128,0.06); border: 1px solid rgba(128,128,128,0.1); border-radius: 6px; margin-top: 6px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.02); width: fit-content; min-width: 200px; max-width: 100%; overflow-x: auto;">"${displayStr}"</div></details></div>`;
                }
                return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<span style="color: #10b981; word-break: break-all; white-space: pre-wrap;">"${valStr}"</span></div>`;
              }
              if (typeof obj === 'number')
                return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<span style="color: #f59e0b; font-weight: 500;">${valStr}</span></div>`;
              if (typeof obj === 'boolean')
                return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<span style="color: #0ea5e9; font-weight: 500;">${valStr}</span></div>`;
              return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}${valStr}</div>`;
            }

            const getShortPreview = (v: any) => {
              if (v === null) return 'null';
              if (typeof v !== 'object') {
                const s = escapeHtml(String(v));
                const trunc = s.length > 20 ? s.substring(0, 20) + '...' : s;
                return typeof v === 'string' ? `"${trunc}"` : trunc;
              }
              return Array.isArray(v) ? '[...]' : '{...}';
            };

            const isArray = Array.isArray(obj);
            const keys = isArray ? obj : Object.keys(obj);
            const length = isArray ? obj.length : keys.length;

            if (length === 0) {
              return `<div style="display: flex; align-items: flex-start; margin-top: 4px;">${keyPrefix}<span style="color: var(--text-muted, #9ca3af);">${isArray ? '[]' : '{}'}</span></div>`;
            }

            const isOpen = isRoot ? 'open' : '';
            const summaryKey = keyName
              ? `<span style="color: #3b82f6; font-weight: 500;">"${escapeHtml(keyName)}":</span>`
              : isArray
                ? 'Array'
                : 'Object';

            let preview = '';
            if (isArray) {
              preview =
                obj.slice(0, 3).map(getShortPreview).join(', ') +
                (length > 3 ? ', ...' : '');
              preview = `[ ${preview} ]`;
            } else {
              preview =
                keys
                  .slice(0, 3)
                  .map(
                    (k) =>
                      `${escapeHtml(k as string)}: ${getShortPreview(obj[k as string])}`,
                  )
                  .join(', ') + (length > 3 ? ', ...' : '');
              preview = `{ ${preview} }`;
            }

            let html = `<details ${isOpen} style="margin-top: 4px;"><summary style="position: sticky; top: 0; z-index: 10; padding-top: 2px; padding-bottom: 2px; cursor: pointer; color: var(--text-muted, #9ca3af); user-select: none;">${summaryKey} <span style="opacity: 0.7; font-size: 0.9em; margin-left: 4px;">${preview}</span></summary><div style="padding-left: 16px; border-left: 1px dashed rgba(128,128,128,0.2); margin: 4px 0 4px 8px; display: flex; flex-direction: column; gap: 4px;">`;

            if (isArray) {
              for (let i = 0; i < length; i++) {
                html += renderJsonToFoldableHtml(obj[i], String(i));
              }
            } else {
              for (const k of keys) {
                html += renderJsonToFoldableHtml(obj[k as string], k as string);
              }
            }
            html += `</div></details>`;
            return html;
          };

          const renderLiteLLMMessages = (
            msgs: any[],
            keyName: string,
          ): string => {
            if (msgs.length === 0)
              return `<div style="display: flex; align-items: flex-start; margin-top: 4px;"><span style="color: #3b82f6; font-weight: 500; margin-right: 8px; flex-shrink: 0;">"${escapeHtml(keyName)}":</span><span style="color: var(--text-muted, #9ca3af);">[]</span></div>`;
            let html = `<details style="margin-top: 4px;"><summary style="position: sticky; top: 0; z-index: 10; padding-top: 2px; padding-bottom: 2px; cursor: pointer; color: var(--text-muted, #9ca3af); user-select: none;"><span style="color: #3b82f6; font-weight: 500;">"${escapeHtml(keyName)}":</span> <span style="opacity: 0.7; font-size: 0.9em; margin-left: 4px;">(${msgs.length} messages)</span></summary><div style="padding-left: 16px; border-left: 1px dashed rgba(128,128,128,0.2); margin: 4px 0 4px 8px; display: flex; flex-direction: column; gap: 8px;">`;

            const msgsToRender =
              msgs.length > 8
                ? [
                    msgs[0],
                    {
                      role: 'system',
                      content: `... ${msgs.length - 6} messages omitted for UI performance ...`,
                    },
                    ...msgs.slice(-5),
                  ]
                : msgs;

            for (const msg of msgsToRender) {
              if (!msg || typeof msg !== 'object') {
                html += `<div>${renderJsonToFoldableHtml(msg)}</div>`;
                continue;
              }
              const roleStr = msg.role
                ? escapeHtml(String(msg.role))
                : 'unknown';

              html += `<div style="background: rgba(128,128,128,0.04); border: 1px solid rgba(128,128,128,0.1); border-radius: 6px; padding: 10px;">`;
              html += `<div style="margin-bottom: 6px; border-bottom: 1px solid rgba(128,128,128,0.1); padding-bottom: 4px;"><span style="color: #3b82f6; font-weight: 500; margin-right: 8px;">"role":</span><span style="color: #f59e0b;">"${roleStr}"</span></div>`;

              const content = msg.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block && typeof block === 'object') {
                    if (block.text) {
                      html += renderJsonToFoldableHtml(block.text, 'text');
                    } else if (block.image_url) {
                      html += renderJsonToFoldableHtml(
                        block.image_url,
                        'image_url',
                      );
                    } else {
                      for (const k of Object.keys(block)) {
                        if (k === 'type') continue;
                        html += renderJsonToFoldableHtml(block[k], k);
                      }
                    }
                  } else {
                    html += `<div>${renderJsonToFoldableHtml(block)}</div>`;
                  }
                }
              } else if (content !== undefined) {
                html += renderJsonToFoldableHtml(content, 'text');
              }

              for (const k of Object.keys(msg)) {
                if (k === 'role' || k === 'content') continue;
                html += renderJsonToFoldableHtml(msg[k], k);
              }
              html += `</div>`;
            }
            html += `</div></details>`;
            return html;
          };

          // rows are already in DESC order from SQL, no need to reverse
          const htmlResp = filtered
            .map((e) => {
              const d = e.timestamp ? new Date(e.timestamp) : new Date();
              const time = isNaN(d.getTime())
                ? '--'
                : d
                    .toLocaleString('zh-CN', {
                      timeZone: 'Asia/Shanghai',
                      hour12: false,
                    })
                    .replace(/\//g, '-');
              const callIdSnippet = e.call_id ? e.call_id.split('-')[0] : '--';

              const detailsObj: any = {
                messages: e.request?.messages || [],
                parameters: e.request?.parameters || {},
              };

              const optParams =
                e.request?.optional_params ||
                e.kwargs?.optional_params ||
                e.optional_params ||
                e.kwargs;
              if (optParams && Object.keys(optParams).length > 0) {
                detailsObj.optional_params = optParams;
              }

              let parsedResp = e.response || {};
              if (typeof parsedResp === 'string') {
                try {
                  parsedResp = JSON.parse(parsedResp);
                } catch (err) {
                  // If it's a Python dict string format, do a fuzzy attempt to parse it (best effort for legacy logs)
                  if (parsedResp.startsWith('{') && parsedResp.includes("'")) {
                    try {
                      // Very crude replacement for python dict string -> JSON. Only works on simple structures.
                      const fuzzyJson = parsedResp
                        .replace(/'/g, '"')
                        .replace(/True/g, 'true')
                        .replace(/False/g, 'false')
                        .replace(/None/g, 'null');
                      parsedResp = JSON.parse(fuzzyJson);
                    } catch (e2) {
                      // fallback to raw string
                    }
                  }
                }
              }
              detailsObj.response = parsedResp;

              const detailsHtml = renderJsonToFoldableHtml(
                detailsObj,
                '',
                true,
              );

              return `
            <tr style="border-bottom: 1px solid rgba(128,128,128,0.1); cursor: pointer; transition: background-color 0.2s ease;" onclick="this.nextElementSibling.classList.toggle('hidden')" onmouseover="this.style.backgroundColor='rgba(128,128,128,0.05)'" onmouseout="this.style.backgroundColor='transparent'">
              <td style="font-family: 'SF Mono', monospace; font-size: 11px; padding: 12px 16px;">${time}</td>
              <td style="padding: 12px 16px;"><span class="badge badge-gray" style="background: rgba(128,128,128,0.1); border: 1px solid rgba(128,128,128,0.2); padding: 2px 8px; border-radius: 12px; font-size: 11px;">${e.event_type || 'unknown'}</span></td>
              <td style="font-weight: 500; font-size: 13px; padding: 12px 16px;">${e.model || '--'}</td>
              <td style="font-family: 'SF Mono', monospace; font-size: 11px; opacity: 0.6; padding: 12px 16px;">${callIdSnippet}...</td>
            </tr>
            <tr class="hidden">
              <td colspan="4" style="padding: 12px 24px 24px 24px;">
                <div style="font-family: 'SF Mono', monospace; font-size: 12px; font-weight: normal; background: transparent; border-left: 3px solid rgba(59, 130, 246, 0.4); padding-left: 16px; margin-top: 4px; overflow-wrap: anywhere;">
                  ${detailsHtml}
                </div>
              </td>
            </tr>
            `;
            })
            .join('');

          const countBadge = `\n<template><span id="log-count-badge" hx-swap-oob="true" style="font-size: 13px; color: var(--text-muted); background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.05); padding: 2px 10px; border-radius: 12px; font-weight: 500; letter-spacing: 0;">${filtered.length}</span></template>\n`;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(htmlResp + countBadge);
        } catch (err) {
          logger.error({ err }, 'Error reading litellm_logs.db');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(
            '<tr><td colspan="4" class="empty-state" style="color:var(--red);">Failed to load logs</td></tr>' +
              '\n<template><span id="log-count-badge" hx-swap-oob="true" style="font-size: 13px; color: var(--text-muted); background: rgba(0,0,0,0.03); border: 1px solid rgba(0,0,0,0.05); padding: 2px 10px; border-radius: 12px; font-weight: 500; letter-spacing: 0;">0</span></template>\n',
          );
        }
      }

      // ======== END SYSTEM MANAGEMENT APIS ========

      // Legacy form actions (fallback)
      if (req.method === 'POST') {
        const action = url.searchParams.get('action');
        const startScript = join(LITELLM_DIR, 'restart_litellm.sh');
        const stopScript = join(LITELLM_DIR, 'stop_litellm.sh');
        if (action === 'litellm-restart') {
          try {
            execSync(`bash "${startScript}"`, { timeout: 30000 });
          } catch {
            /* ok */
          }
        } else if (action === 'litellm-stop') {
          try {
            execSync(`bash "${stopScript}"`, { timeout: 10000 });
          } catch {
            /* ok */
          }
        }
        res.writeHead(302, { Location: `/cc/?section=settings&lang=${lang}` });
        res.end();
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }

      const rawSection = url.searchParams.get('section') || 'overview';
      const section = SECTIONS.includes(rawSection as Section)
        ? (rawSection as Section)
        : 'overview';

      let htmlBody: string;
      switch (section) {
        case 'overview':
          htmlBody = new OverviewPage().render({}, lang);
          break;
        case 'usage':
          htmlBody = new UsagePage().render({ query: url.searchParams }, lang);
          break;
        case 'agent':
          htmlBody = new AgentPage().render({ query: url.searchParams }, lang);
          break;
        case 'docs':
          htmlBody = new DocsPage().render({ query: url.searchParams }, lang);
          break;
        case 'tasks':
          htmlBody = new TasksPage().render({ query: url.searchParams }, lang);
          break;
        case 'alerts':
          htmlBody = new AlertsPage().render({}, lang);
          break;
        case 'logger':
          htmlBody = new LoggerPage().render({ query: url.searchParams }, lang);
          break;
        case 'settings':
          htmlBody = new SettingsPage().render({}, lang);
          break;
        default:
          htmlBody = new OverviewPage().render({}, lang);
      }

      const fullHtml = Layout.render(section, lang, htmlBody);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fullHtml);
    } catch (err) {
      logger.error({ err }, '[control-center] request error');
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  };
}
