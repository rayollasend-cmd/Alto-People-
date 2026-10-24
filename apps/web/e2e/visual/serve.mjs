#!/usr/bin/env node
/* global process, console, URL */
/**
 * A tiny static server for the visual regression suite. No dependencies, so
 * it runs the same on a laptop and inside the Playwright container.
 *
 *   node e2e/visual/serve.mjs --dir e2e-results/visual-dist --port 4799
 *   node e2e/visual/serve.mjs --dir e2e-results/visual-dist --port 4799 --api http://localhost:3001
 *
 * - Serves the built app (vite build output) with the SPA fallback: a path
 *   that is not a file gets index.html, as in production.
 * - /api/* answers 404 unless --api is given. In a replay the browser never
 *   reaches it (each page's HAR answers /api); a 404 here would mean a
 *   request slipped past the HAR, and the spec reports it.
 * - --api proxies /api/* to the API with the /api prefix stripped (what the
 *   Vite dev proxy does). Only the recorder uses it, so a recording is made
 *   from exactly the bundle the replay serves.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const ROOT = path.resolve(opt('dir', 'dist'));
const PORT = Number(opt('port', '4799'));
const HOST = opt('host', '127.0.0.1');
const API = opt('api', '');

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`serve.mjs: no index.html in ${ROOT} — build the app first (vite build --outDir ${ROOT}).`);
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function sendFile(res, file, status = 200) {
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(status, {
    'Content-Type': type,
    // Hashed assets never change; index.html must never be cached.
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
}

function proxy(req, res) {
  const target = new URL(req.url.replace(/^\/api/, '') || '/', API);
  const headers = { ...req.headers, host: target.host };
  const upstream = http.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`proxy error: ${err.message}`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (API) return proxy(req, res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_in_har', message: 'This request is not in the recording.' } }));
    return;
  }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // Not a file: a client-side route. An asset that is missing stays a 404
    // so a broken chunk shows up as one instead of as HTML.
    if (path.extname(url.pathname) && !url.pathname.endsWith('.html')) {
      res.writeHead(404);
      res.end();
      return;
    }
    file = path.join(ROOT, 'index.html');
  }
  if (!fs.existsSync(file)) file = path.join(ROOT, 'index.html');
  sendFile(res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`serve.mjs: ${ROOT} on http://${HOST}:${PORT}${API ? ` (api → ${API})` : ''}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
