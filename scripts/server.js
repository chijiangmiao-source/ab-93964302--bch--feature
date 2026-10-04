// scripts/server.js — 零依赖静态文件服务器，并暴露 /health 健康响应。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const pathname = url.pathname;

  if (pathname === '/health' || pathname === '/healthz') {
    const payload = JSON.stringify({
      status: 'ok',
      service: 'narrow-sense-bch-review',
      time: new Date().toISOString(),
    });
    return send(res, 200, payload, { 'Content-Type': 'application/json; charset=utf-8' });
  }

  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  // 防路径穿越：规范化后必须仍在 ROOT 内
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT + '/') && filePath !== ROOT) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  try {
    const data = await readFile(filePath);
    return send(res, 200, data, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    });
  } catch {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[server] static root: ${ROOT}`);
  console.log(`[server] listening on http://${HOST}:${PORT} (health: /health)`);
});
