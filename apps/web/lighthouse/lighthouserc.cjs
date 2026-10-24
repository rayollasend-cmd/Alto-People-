/**
 * Lighthouse CI — the PRODUCTION build (vite build → dist, served by
 * `vite preview`, /api proxied to the API), never the dev server.
 * apps/web/lighthouse/README.md has the how and why; `npm -w apps/web run
 * lhci` (lighthouse/run.mjs) drives it.
 *
 * Three collect runs share this file; LHCI_RUN picks one:
 *   public     /login /careers /status /trust-center — signed out, phone
 *   admin      / /clients /scheduling /payroll, and the three ECharts pages
 *              /recruiting/analytics /labor-costs /call-outs — signed in as the admin, desktop
 *   associate  the associate's home (/?lhci=associate) — signed in, phone
 * Each signed-in run logs in once (lighthouse/login.cjs) and reuses the
 * session. The associate's home is `/?lhci=associate` only so it is a
 * different URL from the admin's `/` — LHCI groups results by URL.
 *
 * Results go to the filesystem ONLY (e2e-results/lighthouse). Never
 * temporary-public-storage: signed-in reports hold company data.
 */
const path = require('node:path');

const RUN = process.env.LHCI_RUN || 'public';
const BASE = (process.env.LHCI_BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');

/** Playwright's Chromium unless told otherwise: CI installs it for the E2E suite already. */
function chromePath() {
  if (process.env.LHCI_CHROME_PATH) return process.env.LHCI_CHROME_PATH;
  try {
    return require('playwright').chromium.executablePath();
  } catch {
    return undefined;
  }
}

const RUNS = {
  public: { paths: ['/login', '/careers', '/status', '/trust-center'], desktop: false },
  admin: { paths: ['/', '/clients', '/scheduling', '/payroll', '/recruiting/analytics', '/labor-costs', '/call-outs'], desktop: true },
  associate: { paths: ['/?lhci=associate'], desktop: false },
};
const run = RUNS[RUN];
if (!run) throw new Error(`LHCI_RUN must be one of ${Object.keys(RUNS).join(', ')} (got "${RUN}")`);

/** URL patterns for the assertion matrix (LHCI matches the full URL). */
const DESKTOP_URL = '^[^?]*/(clients|scheduling|payroll|recruiting/analytics|labor-costs|call-outs)?$';
const PUBLIC_URL = '/(login|careers|status|trust-center)$';
const ASSOCIATE_URL = '\\?lhci=associate$';

/**
 * Budgets. Accessibility is an ERROR below 0.95 everywhere. Everything else
 * is a WARNING for now, set just past today's numbers, so a warning means
 * "worse than on 2026-10-23" — tighten them (and make them errors) as the
 * pages get faster.
 *
 * Today's numbers — 2026-10-23 (evening), local (Apple silicon), Lighthouse
 * 12.6.1, median of 3 runs, dev seed data. Phone = Lighthouse's mobile
 * emulation (Moto G Power, simulated slow 4G, 4x CPU); desktop = the
 * desktop preset.
 *
 *   page                 form     perf   a11y  bp    LCP     CLS    TBT
 *   /login               phone    86     100   100   3.5 s   0.000  0 ms
 *   /careers             phone    81     100   100   4.2 s   0.000  0 ms
 *   /status              phone    79     100   100   4.3 s   0.079  11 ms
 *   /trust-center        phone    79     100   100   4.3 s   0.079  0 ms
 *   / (admin home)       desktop  95     100   100   1.4 s   0.002  0 ms
 *   /clients             desktop  95     100   100   1.5 s   0.000  0 ms
 *   /scheduling          desktop  95     100   100   1.4 s   0.008  0 ms
 *   /payroll             desktop  93     100   100   1.7 s   0.002  0 ms
 *   associate home       phone    72–76  100   100   6.6 s   0.001  14 ms
 *
 * The three ECharts pages — 2026-10-24 (morning), same machine and method,
 * on the year of history `npm -w apps/api run db:seed:analytics` writes;
 * they share the desktop budgets below:
 *
 *   /recruiting/analytics desktop 95    100   100   1.5 s   0.002  0 ms
 *   /labor-costs          desktop 94    100   100   1.6 s   0.010  0 ms
 *     (that morning was a pay period's first day, so its default range held
 *      almost nothing; on "Last period", 14 days of rows: 94, 100, 100,
 *      1.6 s, 0.005, 0 ms — one run in three read CLS 0.072, the sidebar
 *      settling, not the report)
 *   /call-outs            desktop 95    100   100   1.5 s   0.002  0 ms
 *
 * The phone pages' perf moves 4–5 points run to run on FCP alone: the
 * preview server answers in a few ms, so in the trace Lighthouse records
 * main.js sometimes runs before the boot splash's first paint and sometimes
 * after, and only in the first case does the simulated FCP (2.9 s instead
 * of 1.8 s) wait for main.js to download.
 * The associate's home LCP is mostly the preview server's HTTP/1.1: about
 * 70 chunks and 22 API calls queue on six connections. Served over HTTP/2,
 * as production is, the same build measures LCP 3.9 s, perf 84.
 * CI runners are slower than this machine; expect lower perf there.
 */
const always = {
  'categories:accessibility': ['error', { minScore: 0.95 }],
  'categories:best-practices': ['warn', { minScore: 0.95 }],
  'total-blocking-time': ['warn', { maxNumericValue: 200 }],
};
const assertMatrix = [
  {
    matchingUrlPattern: DESKTOP_URL,
    assertions: {
      ...always,
      'categories:performance': ['warn', { minScore: 0.8 }],
      'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
      'cumulative-layout-shift': ['warn', { maxNumericValue: 0.05 }],
    },
  },
  {
    matchingUrlPattern: PUBLIC_URL,
    assertions: {
      ...always,
      'categories:performance': ['warn', { minScore: 0.75 }],
      'largest-contentful-paint': ['warn', { maxNumericValue: 4500 }],
      'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
    },
  },
  {
    matchingUrlPattern: ASSOCIATE_URL,
    assertions: {
      ...always,
      'categories:performance': ['warn', { minScore: 0.65 }],
      'largest-contentful-paint': ['warn', { maxNumericValue: 7500 }],
      'cumulative-layout-shift': ['warn', { maxNumericValue: 0.05 }],
    },
  },
];

module.exports = {
  ci: {
    collect: {
      url: run.paths.map((p) => BASE + p),
      // One run per page by default (the CI job is long already); raise it
      // (LHCI_RUNS=3 → the median of three) before tightening a perf budget.
      numberOfRuns: Number(process.env.LHCI_RUNS || 1),
      chromePath: chromePath(),
      // Every run goes through puppeteer (puppeteer-core, which Lighthouse
      // already ships): one Chrome per run, signed in once by the script.
      puppeteerScript: path.join('lighthouse', 'login.cjs'),
      puppeteerLaunchOptions: {
        // Hosted Ubuntu runners have no user namespaces for Chrome's sandbox
        // (Playwright launches its Chromium the same way).
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      },
      settings: {
        ...(run.desktop ? { preset: 'desktop' } : {}),
        // The preview server speaks HTTP/1.1 (it does gzip, like production);
        // production sits behind Railway's HTTP/2 edge. This audit would
        // only measure the preview server.
        skipAudits: ['uses-http2'],
        // Lighthouse's default reset (caches, service workers) plus
        // IndexedDB, where the app persists its query cache: every page is
        // the same cold load, not warmed by the page measured before it.
        // Cookies and localStorage stay, so the session does too.
        clearStorageTypes: ['file_systems', 'shader_cache', 'service_workers', 'cache_storage', 'indexeddb'],
      },
    },
    assert: { assertMatrix },
    upload: {
      target: 'filesystem',
      outputDir: process.env.LHCI_OUTPUT_DIR || path.join('e2e-results', 'lighthouse'),
    },
  },
};
