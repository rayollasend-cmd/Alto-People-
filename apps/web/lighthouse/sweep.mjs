#!/usr/bin/env node
/**
 * Lighthouse performance sweep — every role's main pages on a phone, a
 * tablet and a desktop, over HTTP/2 (lighthouse/h2serve.mjs), as one table.
 * The CI run (lhci, lighthouserc.cjs) guards a handful of pages; this answers
 * "how fast is the app for everyone" when you ask it.
 *
 *   npm -w apps/web run build
 *   npm -w apps/web run lighthouse:serve &  # https://127.0.0.1:4443
 *   npm -w apps/web run lighthouse:sweep    # all personas × pages × devices
 *   SWEEP_ONLY=associate,driver SWEEP_FORMS=phone npm -w apps/web run lighthouse:sweep
 *
 * Needs the API on :3001 with the dev seed and LOGIN_IP_LIMIT=500. Each
 * persona signs in once (logins are rate limited per account) in a Chrome of
 * its own; Lighthouse clears caches, service workers and storage between
 * pages but keeps the session cookie, so every page is a cold load.
 *
 * Devices:
 *   phone    Lighthouse's mobile default — Moto G Power, slow 4G (150 ms,
 *            1.6 Mbps), 4× CPU slowdown.
 *   tablet   820×1180 at 2×, a mid-range tablet on store Wi-Fi: 40 ms,
 *            10 Mbps, 2× CPU slowdown.
 *   desktop  Lighthouse's desktop preset — 40 ms, 10 Mbps, no CPU slowdown.
 *
 * Writes e2e-results/lighthouse-sweep/results.json (one row per run, the
 * metrics plus the evidence: LCP element and its phases, the layout shifts,
 * the heaviest scripts) and prints a table.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import puppeteer from 'puppeteer-core';
import { chromium } from 'playwright';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(WEB, 'e2e-results/lighthouse-sweep');
const BASE = (process.env.SWEEP_BASE_URL || 'https://127.0.0.1:4443').replace(/\/$/, '');

/** Who, and the pages they live on (e2e/walkPersonas.ts has the accounts). */
const PERSONAS = [
  { key: 'public', pages: ['/login', '/careers'] },
  { key: 'associate', email: 'maria.lopez@example.com', pass: 'maria-dev-2026!', pages: ['/', '/scheduling', '/payroll'] },
  { key: 'driver', email: 'driver@altohr.com', pass: 'driver-dev-2026!', pages: ['/', '/transport'] },
  { key: 'supervisor', email: 'dana.reyes@altohr.com', pass: 'supervisor-dev-2026!', pages: ['/', '/time-attendance'] },
  { key: 'admin', email: 'admin@altohr.com', pass: 'alto-admin-dev', pages: ['/', '/people', '/scheduling', '/payroll'] },
  { key: 'ops-manager', email: 'ops@altohr.com', pass: 'ops-dev-2026!', pages: ['/', '/approvals'] },
  { key: 'manager', email: 'manager@altohr.com', pass: 'manager-dev-2026!', pages: ['/', '/team'] },
  { key: 'workforce-manager', email: 'workforce@altohr.com', pass: 'workforce-dev-2026!', pages: ['/', '/scheduling'] },
  { key: 'finance', email: 'finance@altohr.com', pass: 'finance-dev-2026!', pages: ['/', '/payroll'] },
  { key: 'recruiter', email: 'recruiter@altohr.com', pass: 'recruiter-dev-2026!', pages: ['/', '/recruiting', '/onboarding'] },
  { key: 'transport-director', email: 'transport@altohr.com', pass: 'transport-dev-2026!', pages: ['/', '/transport'] },
  { key: 'portal-store', email: 'portal@coastalresort.example', pass: 'portal-dev-2026!', pages: ['/portal', '/portal/schedule'] },
  { key: 'portal-region', email: 'region@coastalresort.example', pass: 'portal-dev-2026!', pages: ['/region'] },
];

const TABLET = {
  extends: 'lighthouse:default',
  settings: {
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 820, height: 1180, deviceScaleFactor: 2, disabled: false },
    throttling: { rttMs: 40, throughputKbps: 10 * 1024, cpuSlowdownMultiplier: 2, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
    emulatedUserAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
};
const FORMS = { phone: undefined, tablet: TABLET, desktop: desktopConfig };

const only = (env, all) => (process.env[env] ? process.env[env].split(',').map((s) => s.trim()) : all);
const personas = PERSONAS.filter((p) => only('SWEEP_ONLY', PERSONAS.map((x) => x.key)).includes(p.key));
const forms = only('SWEEP_FORMS', Object.keys(FORMS));

async function signIn(browser, p) {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 30_000 });
    await page.type('input[type="email"]', p.email);
    await page.type('#login-password', p.pass);
    await Promise.all([page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 30_000 }), page.keyboard.press('Enter')]);
    const me = await page.evaluate(async () => {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      const b = r.ok ? await r.json() : null;
      return b?.user?.email ?? `nobody (HTTP ${r.status})`;
    });
    if (me !== p.email) throw new Error(`sign-in did not stick for ${p.key}: ${me}`);
  } finally {
    await page.close();
  }
}

const ms = (a) => (a?.numericValue == null ? null : Math.round(a.numericValue));
const items = (a) => a?.details?.items ?? [];

function summarize(lhr, persona, url, form) {
  const A = lhr.audits;
  const lcpEl = items(A['largest-contentful-paint-element']);
  const phases = (lcpEl[1]?.items ?? []).map((i) => [i.phase, Math.round(i.timing)]);
  const resources = items(A['resource-summary']);
  const res = (t) => resources.find((r) => r.resourceType === t) ?? {};
  return {
    persona,
    page: url,
    form,
    finalUrl: new URL(lhr.finalDisplayedUrl).pathname,
    perf: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    fcp: ms(A['first-contentful-paint']),
    lcp: ms(A['largest-contentful-paint']),
    tbt: ms(A['total-blocking-time']),
    cls: A['cumulative-layout-shift']?.numericValue == null ? null : Number(A['cumulative-layout-shift'].numericValue.toFixed(3)),
    si: ms(A['speed-index']),
    requests: res('total').requestCount ?? null,
    kb: Math.round((res('total').transferSize ?? 0) / 1024),
    jsKb: Math.round((res('script').transferSize ?? 0) / 1024),
    jsRequests: res('script').requestCount ?? null,
    lcpElement: lcpEl[0]?.items?.[0]?.node?.snippet?.slice(0, 160) ?? null,
    lcpPhases: Object.fromEntries(phases),
    shifts: items(A['layout-shifts']).slice(0, 3).map((s) => ({ score: Number((s.score ?? 0).toFixed(3)), node: s.node?.snippet?.slice(0, 120) ?? null })),
    unusedJs: items(A['unused-javascript']).slice(0, 4).map((i) => ({ url: String(i.url).replace(BASE, ''), wastedKb: Math.round((i.wastedBytes ?? 0) / 1024) })),
    bootup: items(A['bootup-time']).slice(0, 3).map((i) => ({ url: String(i.url).replace(BASE, ''), ms: Math.round(i.total ?? 0) })),
    mainThreadMs: ms(A['mainthread-work-breakdown']),
    // Every script the page fetched, heaviest first — the chunk names say what it carried.
    scripts: items(A['network-requests'])
      .filter((r) => r.resourceType === 'Script')
      .map((r) => ({ chunk: String(r.url).replace(/^.*\/assets\//, '').replace(/-[A-Za-z0-9_-]{8}\.js$/, ''), kb: Math.round((r.transferSize ?? 0) / 1024) }))
      .sort((x, y) => y.kb - x.kb),
  };
}

const rows = [];
mkdirSync(OUT, { recursive: true });
for (const p of personas) {
  const browser = await puppeteer.launch({
    executablePath: process.env.SWEEP_CHROME_PATH || chromium.executablePath(),
    headless: true,
    args: ['--ignore-certificate-errors', '--no-first-run', '--disable-extensions'],
  });
  try {
    if (p.email) await signIn(browser, p);
    for (const url of p.pages) {
      for (const form of forms) {
        const page = await browser.newPage();
        try {
          const result = await lighthouse(`${BASE}${url}`, { output: 'json', logLevel: 'error', onlyCategories: ['performance'] }, FORMS[form], page);
          const row = summarize(result.lhr, p.key, url, form);
          rows.push(row);
          console.log(`${p.key.padEnd(19)} ${url.padEnd(18)} ${form.padEnd(8)} perf ${String(row.perf).padStart(3)}  LCP ${String(row.lcp).padStart(6)}  CLS ${String(row.cls).padStart(5)}  TBT ${String(row.tbt).padStart(5)}  ${row.finalUrl !== url ? `(landed on ${row.finalUrl})` : ''}`);
        } catch (err) {
          rows.push({ persona: p.key, page: url, form, error: String(err?.message ?? err) });
          console.log(`${p.key} ${url} ${form}: FAILED ${err?.message ?? err}`);
        } finally {
          await page.close();
        }
        writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
      }
    }
  } finally {
    await browser.close();
  }
}
console.log(`\nsweep: ${rows.length} runs → ${path.relative(WEB, path.join(OUT, 'results.json'))}`);
