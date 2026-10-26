// Render Hugo's app assets: stills, animation strips (sprite sheets), the face, and WhatsApp's photo — WebP/JPEG via the browser's encoder.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const dir = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(dir, '../../apps/web/src/assets/hugo');
const EXPORTS = path.join(dir, 'exports');
mkdirSync(OUT, { recursive: true });
mkdirSync(EXPORTS, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function frame(pose, size, q = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const qs = new URLSearchParams({ pose, size: String(size), ...q });
  await page.goto(`${BASE}/index.html?${qs}`);
  await page.waitForFunction(() => window.__done === true, undefined, { timeout: 120000 });
  const png = await page.locator('canvas').screenshot({ omitBackground: !q.bg });
  await page.close();
  return png;
}
// Draw PNG frames side by side and encode the strip.
async function encode(frames, size, file, type = 'image/webp', quality = 0.82, outDir = OUT) {
  const page = await browser.newPage();
  const urls = frames.map((b) => `data:image/png;base64,${b.toString('base64')}`);
  const dataUrl = await page.evaluate(async ({ urls, size, type, quality }) => {
    const c = document.createElement('canvas'); c.width = size * urls.length; c.height = size;
    const ctx = c.getContext('2d');
    for (let i = 0; i < urls.length; i++) { const img = new Image(); img.src = urls[i]; await img.decode(); ctx.drawImage(img, i * size, 0, size, size); }
    return c.toDataURL(type, quality);
  }, { urls, size, type, quality });
  await page.close();
  writeFileSync(path.join(outDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  return statSync(path.join(outDir, file)).size;
}

const report = [];
const STILL = 256, SPRITE = 240;
// Stills: every pose, frame 0.
for (const pose of ['hello', 'working', 'listening', 'thinking', 'handoff', 'celebrate', 'offline', 'coffee', 'reading', 'pointing', 'talking']) {
  report.push([`hugo-${pose}.webp`, await encode([await frame(pose, STILL)], STILL, `hugo-${pose}.webp`)]);
}
report.push(['hugo-face.webp', await encode([await frame('face', 128)], 128, 'hugo-face.webp')]);
// Loops: one strip per motion.
// Every state is a loop now — big enough to read at 56 px — with its blink baked in where it has one.
const LOOPS = { hello: 12, working: 8, listening: 12, talking: 8, reading: 12, thinking: 10, celebrate: 10, handoff: 8, offline: 8, coffee: 12, pointing: 8 };
for (const [pose, n] of Object.entries(LOOPS)) {
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(await frame(pose, SPRITE, { frame: String(i), frames: String(n) }));
  report.push([`hugo-${pose}-loop.webp`, await encode(frames, SPRITE, `hugo-${pose}-loop.webp`)]);
}
// Blinks: eyes open, eyes closed.
// The face for buttons and avatars: open and blinking.
report.push(['hugo-face-blink.webp', await encode([await frame('face', 128), await frame('face', 128, { blink: '1' })], 128, 'hugo-face-blink.webp')]);
// WhatsApp's profile photo: a square on navy, cropped to a circle by WhatsApp.
report.push(['exports/hugo-whatsapp.jpg', await encode([await frame('hello', 640, { bg: '#0B1832' })], 640, 'hugo-whatsapp.jpg', 'image/jpeg', 0.92, EXPORTS)]);
await browser.close(); server.close();
for (const [f, b] of report) console.log(String(Math.round(b / 102.4) / 10).padStart(7), 'KB', f);
