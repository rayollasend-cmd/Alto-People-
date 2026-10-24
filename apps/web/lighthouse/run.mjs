#!/usr/bin/env node
/**
 * `npm -w apps/web run lhci` — Lighthouse CI over the production build.
 *
 *   1. Serve apps/web/dist with `vite preview` (port 4173, /api proxied to the
 *      API on :3001 — vite.config.ts) unless LHCI_BASE_URL points at a server
 *      that is already up. Build first: `npm -w apps/web run build`.
 *   2. Collect: the public pages signed out, the admin's pages signed in
 *      (desktop), the associate's home signed in (phone). LHCI_ONLY=public
 *      (or a comma list) runs a subset — public needs no API.
 *   3. Assert (lighthouse/lighthouserc.cjs): accessibility < 0.95 fails;
 *      performance, best practices and the LCP/CLS/TBT budgets warn.
 *   4. Upload to the filesystem only (e2e-results/lighthouse), and print a
 *      table of the scores (also to the GitHub job summary in CI).
 *
 * Exit code: the assertion result. Reports are written either way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'lighthouse/lighthouserc.cjs';
const BASE = (process.env.LHCI_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const RUNS = (process.env.LHCI_ONLY || 'public,admin,associate').split(',').map((s) => s.trim()).filter(Boolean);

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    if (await up(url)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function lhci(args, env = {}) {
  const res = spawnSync('npx', ['--no-install', 'lhci', ...args, `--config=${CONFIG}`], {
    cwd: WEB,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  return res.status ?? 1;
}

let preview = null;
if (!(await up(`${BASE}/`))) {
  if (process.env.LHCI_BASE_URL) {
    console.error(`[lhci] nothing answers at ${BASE}`);
    process.exit(1);
  }
  if (!existsSync(path.join(WEB, 'dist', 'index.html'))) {
    console.error('[lhci] no production build: run `npm -w apps/web run build` first');
    process.exit(1);
  }
  console.log('[lhci] serving dist with vite preview on :4173');
  preview = spawn('npx', ['--no-install', 'vite', 'preview', '--port', '4173', '--strictPort'], { cwd: WEB, stdio: 'ignore', detached: true });
  if (!(await waitFor(`${BASE}/`, 60))) {
    console.error('[lhci] vite preview did not come up');
    process.kill(-preview.pid);
    process.exit(1);
  }
}
const stopPreview = () => {
  if (preview) {
    try {
      process.kill(-preview.pid);
    } catch {
      /* already gone */
    }
  }
};

if (RUNS.some((r) => r !== 'public') && !(await up(`${BASE}/api/health`))) {
  console.error(`[lhci] the API does not answer at ${BASE}/api/health — signed-in pages need it (LHCI_ONLY=public skips them)`);
  stopPreview();
  process.exit(1);
}

let status = 0;
rmSync(path.join(WEB, '.lighthouseci'), { recursive: true, force: true });
RUNS.forEach((run, i) => {
  if (status) return;
  console.log(`\n[lhci] collect: ${run}`);
  status = lhci(['collect', ...(i > 0 ? ['--additive'] : [])], { LHCI_RUN: run });
});
stopPreview();
if (status) process.exit(status);

console.log('\n[lhci] assert');
const asserted = lhci(['assert']);
console.log('\n[lhci] upload (filesystem)');
// This run's reports only, not the last run's alongside them.
rmSync(path.resolve(WEB, process.env.LHCI_OUTPUT_DIR || path.join('e2e-results', 'lighthouse')), { recursive: true, force: true });
lhci(['upload']);

// The scores, one line per page: with several runs, the run whose
// performance score is the median.
const dir = path.join(WEB, '.lighthouseci');
const byUrl = new Map();
for (const f of readdirSync(dir).filter((x) => x.startsWith('lhr-') && x.endsWith('.json'))) {
  const lhr = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  byUrl.set(lhr.requestedUrl, [...(byUrl.get(lhr.requestedUrl) ?? []), lhr]);
}
const order = (u) => ['/login', '/careers', '/status', '/trust-center', '/', '/clients', '/scheduling', '/payroll'].indexOf(new URL(u).pathname + new URL(u).search) >>> 0;
const rows = [...byUrl.entries()]
  .sort(([a], [b]) => order(a) - order(b))
  .map(([, runs]) => {
    const sorted = [...runs].sort((x, y) => (x.categories.performance?.score ?? 0) - (y.categories.performance?.score ?? 0));
    return sorted[Math.floor(sorted.length / 2)];
  })
  .map((lhr) => {
    const c = lhr.categories;
    const a = lhr.audits;
    const pct = (x) => (x?.score == null ? '—' : String(Math.round(x.score * 100)));
    const ms = (x) => (x?.numericValue == null ? '—' : `${(x.numericValue / 1000).toFixed(1)} s`);
    return {
      page: new URL(lhr.requestedUrl).pathname + new URL(lhr.requestedUrl).search,
      form: lhr.configSettings.formFactor === 'desktop' ? 'desktop' : 'phone',
      perf: pct(c.performance),
      a11y: pct(c.accessibility),
      bp: pct(c['best-practices']),
      lcp: ms(a['largest-contentful-paint']),
      cls: a['cumulative-layout-shift']?.numericValue?.toFixed(3) ?? '—',
      tbt: a['total-blocking-time']?.numericValue == null ? '—' : `${Math.round(a['total-blocking-time'].numericValue)} ms`,
    };
  });
const table = [
  '| Page | Form | Perf | A11y | Best practices | LCP | CLS | TBT |',
  '| --- | --- | --: | --: | --: | --: | --: | --: |',
  ...rows.map((r) => `| ${r.page} | ${r.form} | ${r.perf} | ${r.a11y} | ${r.bp} | ${r.lcp} | ${r.cls} | ${r.tbt} |`),
].join('\n');
console.log(`\n${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Lighthouse (production build)\n\n${table}\n\nFull reports: the lighthouse-reports artifact.\n`);

process.exit(asserted);
