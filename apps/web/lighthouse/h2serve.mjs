#!/usr/bin/env node
/**
 * Serve apps/web/dist over HTTP/2 + TLS with /api proxied to the API on :3001
 * — the transport production's edge gives the app — for Lighthouse numbers
 * that read like production's. `vite preview` speaks HTTP/1.1, so the ~70
 * chunks a signed-in page loads queue on six connections and a phone's LCP
 * reads seconds worse than it is (measured on the associate's home: 6.6 s
 * over HTTP/1.1, 3.9 s over HTTP/2).
 *
 *   node lighthouse/h2serve.mjs            https://127.0.0.1:4443
 *   H2_PORT=4444 node lighthouse/h2serve.mjs
 *
 * Like production: hashed assets are immutable for a year, everything else
 * revalidates; text is gzipped (Express's compression()); a navigation that
 * isn't a file gets the SPA shell (kiosk.html under /kiosk). The certificate
 * is self-signed (made with openssl on first run, kept in
 * e2e-results/lighthouse-sweep/tls), so Chrome needs --ignore-certificate-errors.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(WEB, 'dist');
const TLS = path.join(WEB, 'e2e-results/lighthouse-sweep/tls');
const PORT = Number(process.env.H2_PORT || 4443);
const API = { host: '127.0.0.1', port: Number(process.env.H2_API_PORT || 3001) };

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('h2serve: no build in apps/web/dist — run `npm -w apps/web run build` first');
  process.exit(1);
}

function certificate() {
  const key = path.join(TLS, 'key.pem');
  const cert = path.join(TLS, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(TLS, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg)/;

/**
 * Files are read and gzipped once: the numbers should measure the app, not
 * this server. A rebuild changes a file's mtime, so a new build is served
 * without a restart.
 */
const cache = new Map();
function load(file) {
  const mtime = statSync(file).mtimeMs;
  let hit = cache.get(file);
  if (!hit || hit.mtime !== mtime) {
    const body = readFileSync(file);
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    hit = { body, type, mtime, gz: COMPRESSIBLE.test(type) && body.length > 1024 ? gzipSync(body, { level: 6 }) : null };
    cache.set(file, hit);
  }
  return hit;
}

function fileFor(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'http2-settings', 'te']);

function proxy(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP.has(k)) headers[k] = v;
  headers.host = `${API.host}:${API.port}`;
  const up = http.request({ ...API, method: req.method, path: req.url, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('API unreachable');
  });
  req.pipe(up);
}

const server = http2.createSecureServer({ ...certificate(), allowHTTP1: true }, (req, res) => {
  const url = new URL(req.url, 'https://x');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return proxy(req, res);
  const asFile = fileFor(url.pathname);
  const file = asFile ?? path.join(DIST, url.pathname === '/kiosk' || url.pathname.startsWith('/kiosk/') ? 'kiosk.html' : 'index.html');
  const { body, type, gz } = load(file);
  const useGz = gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  res.writeHead(200, {
    'content-type': type,
    'cache-control': asFile && url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(useGz ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } : {}),
  });
  res.end(useGz ? gz : body);
});

server.listen(PORT, '127.0.0.1', () => console.log(`h2serve: https://127.0.0.1:${PORT} (dist over HTTP/2, /api → :${API.port})`));
