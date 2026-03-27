/**
 * NanoClaw Control Center – Integrated UI Server
 * Dark glassmorphism dashboard running on GATEWAY_PORT+1 (default 18790).
 */

import { createServer, type Server } from 'node:http';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { GATEWAY_PORT } from './config.js';
import { logger } from './logger.js';
import { Section, SECTIONS, Lang } from './web/types.js';
import { Layout } from './web/components/Layout.js';
import {
  OverviewPage,
  UsagePage,
  StaffPage,
  MemoryPage,
  DocsPage,
  TasksPage,
  AlertsPage,
  ReplayPage,
  SettingsPage,
} from './web/pages/index.js';

const LITELLM_DIR = join(process.cwd(), 'litellm');
const CC_PORT = GATEWAY_PORT + 1;

export function startControlCenter(): Server {
  const defaultLang: Lang = 'zh';
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const lang: Lang =
        (url.searchParams.get('lang') || defaultLang) === 'en' ? 'en' : 'zh';

      if (req.method === 'POST') {
        const action = url.searchParams.get('action');
        const startScript = join(LITELLM_DIR, 'start_litellm.sh');
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

      let body: string;
      switch (section) {
        case 'overview':
          body = new OverviewPage().render({}, lang);
          break;
        case 'usage':
          body = new UsagePage().render({ query: url.searchParams }, lang);
          break;
        case 'staff':
          body = new StaffPage().render({}, lang);
          break;
        case 'memory':
          body = new MemoryPage().render({ query: url.searchParams }, lang);
          break;
        case 'docs':
          body = new DocsPage().render({ query: url.searchParams }, lang);
          break;
        case 'tasks':
          body = new TasksPage().render({ query: url.searchParams }, lang);
          break;
        case 'alerts':
          body = new AlertsPage().render({}, lang);
          break;
        case 'replay':
          body = new ReplayPage().render({}, lang);
          break;
        case 'settings':
          body = new SettingsPage().render({}, lang);
          break;
        default:
          body = new OverviewPage().render({}, lang);
      }

      const fullHtml = Layout.render(section, lang, body);
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
