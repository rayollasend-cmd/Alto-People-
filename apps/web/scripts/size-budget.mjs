// The bundle-size budget. Runs after `vite build` and fails the build
// when a chunk, or the set of assets index.html loads before first
// paint, grows past what size-budget.json allows.
//
// Sizes are gzip bytes — what the wire carries — grouped by chunk name
// with the content hash stripped, so "main" is "main" from one build to
// the next. Chunks not named in the budget fall under defaultChunkKb;
// a new page that lands heavier than that has to be budgeted on purpose.
//
// Why this exists: a 640 KB main chunk got there one import at a time,
// and nothing ever said no. This says no.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const dist = path.join(webRoot, 'dist');
const budgetPath = path.join(webRoot, 'size-budget.json');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('size-budget: no dist/index.html — run `vite build` first.');
  process.exit(2);
}
const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));

const gzipKb = (file) => zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length / 1024;
const chunkName = (file) => path.basename(file).replace(/-[A-Za-z0-9_-]{8}\.(js|css)$/, '');

const assetsDir = path.join(dist, 'assets');
const files = fs.readdirSync(assetsDir).filter((f) => /\.(js|css)$/.test(f));
const sizes = new Map();
for (const f of files) {
  const name = chunkName(f) + (f.endsWith('.css') ? ' (css)' : '');
  sizes.set(name, (sizes.get(name) ?? 0) + gzipKb(path.join(assetsDir, f)));
}

// Everything index.html references is on the critical path.
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const entryFiles = [...html.matchAll(/assets\/([A-Za-z0-9_.-]+\.(?:js|css))/g)].map((m) => m[1]);
const entryKb = [...new Set(entryFiles)].reduce((s, f) => s + gzipKb(path.join(assetsDir, f)), 0);

const rows = [];
let failed = false;
const check = (label, kb, maxKb) => {
  const over = kb > maxKb;
  const near = !over && kb > maxKb * 0.9;
  if (over) failed = true;
  rows.push({ label, kb: kb.toFixed(1), max: maxKb, state: over ? 'OVER' : near ? 'near' : 'ok' });
};

check('entry (index.html assets)', entryKb, budget.entryKb);
for (const [name, kb] of [...sizes.entries()].sort((a, b) => b[1] - a[1])) {
  const key = name.replace(' (css)', '');
  const max = budget.chunksKb[key] ?? (name.endsWith('(css)') ? budget.cssKb : budget.defaultChunkKb);
  check(name, kb, max);
}

// Print what a reader needs: the entry, every chunk with its own line in
// the budget, and anything over or near its limit. The long tail of
// small page chunks is a count.
const named = new Set(Object.keys(budget.chunksKb));
const shown = rows.filter((r) => r.state !== 'ok' || named.has(r.label.replace(' (css)', '')) || r.label.startsWith('entry'));
const quiet = rows.length - shown.length;
const width = Math.max(...shown.map((r) => r.label.length));
console.log(`size-budget (gzip KB)${failed ? ' — OVER BUDGET' : ''}`);
for (const r of shown) {
  const flag = r.state === 'OVER' ? '✖' : r.state === 'near' ? '!' : ' ';
  console.log(`  ${flag} ${r.label.padEnd(width)}  ${String(r.kb).padStart(8)} / ${String(r.max).padStart(5)}`);
}
if (quiet > 0) console.log(`    … ${quiet} more chunks under the default ${budget.defaultChunkKb} KB`);
if (failed) {
  console.error('\nA chunk is over its budget. Either shrink it (lazy-load, drop a dependency) or raise its line in size-budget.json on purpose, in the same commit, with a reason.');
  process.exit(1);
}
