// Serve this folder, open each pose, and save the canvas as a transparent PNG.
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const dir = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(dir) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
}).listen(0);
const port = server.address().port;
const poses = (process.argv[2] || 'hello,working,listening,thinking,handoff,celebrate,offline').split(',');
const size = Number(process.argv[3] || 768);
mkdirSync(path.join(dir, 'renders'), { recursive: true }); // renders/ is git-ignored: regenerate, don't commit
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const pose of poses) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/index.html?pose=${pose}&size=${size}`);
  await page.waitForFunction(() => window.__done === true, undefined, { timeout: 120000 }).catch(() => errors.push('timeout'));
  await page.locator('canvas').screenshot({ path: path.join(dir, 'renders', `${pose}.png`), omitBackground: true });
  if (process.argv[4] === 'glb') writeFileSync(path.join(dir, 'renders', `hugo-${pose}.glb`), Buffer.from(await page.evaluate(() => window.exportGLB())));
  console.log(pose, errors.length ? 'ERR ' + errors.join(' | ') : 'ok');
  await page.close();
}
await browser.close();
server.close();
