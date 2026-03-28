/**
 * NanoClaw Control Center – Integrated UI Server
 * Dark glassmorphism dashboard running on GATEWAY_PORT+1 (default 18790).
 */

import { createServer, type Server } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createReadStream, statSync } from 'node:fs';
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

const LITELLM_DIR = join(process.cwd(), 'litellm');
const CC_PORT = GATEWAY_PORT + 1;

export function startControlCenter(): Server {
  const defaultLang: Lang = 'zh';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const lang: Lang =
        (url.searchParams.get('lang') || defaultLang) === 'en' ? 'en' : 'zh';

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
            // Spawn bash start_nanoclaw.sh detached
            const scriptPath = join(process.cwd(), 'start_nanoclaw.sh');
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
            res.end(JSON.stringify({ success: true }));

            // gracefully exit the current process so the new one can take over
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
            return;
          }

          if (action === 'stop-nanoclaw') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
            return;
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
        res.writeHead(302, { Location: `/?section=settings&lang=${lang}` });
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
  });

  server.listen(CC_PORT, '127.0.0.1', () => {
    logger.info(`[control-center] UI listening on http://127.0.0.1:${CC_PORT}`);
  });
  return server;
}
