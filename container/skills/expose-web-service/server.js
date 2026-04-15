/**
 * 通用静态文件服务器 — expose-web-service skill 附带
 *
 * 用法：
 *   node /workspace/group/.claude/skills/expose-web-service/server.js [目录] [端口]
 *
 * 参数（均可省略）：
 *   目录  要服务的目录路径，默认为当前工作目录（cwd）
 *   端口  监听端口，默认 49152（必须在 40000-60000 范围内）
 *
 * 示例：
 *   node server.js                        # 服务 cwd，端口 49152
 *   node server.js ./dist                 # 服务 ./dist 目录
 *   node server.js ./build 50080          # 服务 ./build，端口 50080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = parseInt(process.argv[3] || '49152', 10);

if (PORT < 40000 || PORT > 60000) {
  console.error(`错误：端口 ${PORT} 不在允许范围 40000-60000 内`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'text/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url || '/', true);
  let pathname = decodeURIComponent(parsed.pathname || '/');

  // 安全：阻止路径穿越
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(ROOT, safePath);

  // 如果是目录，尝试 index.html
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {}

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`静态文件服务已启动：http://0.0.0.0:${PORT}`);
  console.log(`服务目录：${ROOT}`);
});
