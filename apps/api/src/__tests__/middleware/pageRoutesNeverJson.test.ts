import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

/**
 * No page route, under any browser, ever renders raw JSON.
 *
 * This origin serves the SPA page AND a JSON API resource on dozens of
 * the same paths — /clients is the page and the client list, and so are
 * /jobs, /separations, /reports and a hundred more. Nothing about the URL
 * distinguishes them; the ONLY thing standing between a store manager
 * refreshing /clients and `{"clients":[…]}` in their address bar is that
 * the server correctly recognises a browser navigation.
 *
 * So this test does not check one page, or the handful someone
 * remembered. It reads the router table out of the web app and hard-loads
 * EVERY route in it, under the header sets real browsers and real
 * intermediaries actually send — including the partial Sec-Fetch that put
 * this bug back twice. A new page route is covered the moment it is
 * added, with nobody needing to remember this file exists.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(__dirname, '../../../../web/src/App.tsx');

/** Every path in the SPA's route table, as a concrete URL. */
function pageRoutes(): string[] {
  const src = readFileSync(APP_TSX, 'utf8');
  const raw = [...src.matchAll(/\bpath:\s*'([^']*)'/g)].map((m) => m[1]);
  const sample: Record<string, string> = {
    id: '11111111-1111-4111-8111-111111111111',
    applicationId: '11111111-1111-4111-8111-111111111111',
    associateId: '11111111-1111-4111-8111-111111111111',
    taskKind: 'w4',
  };
  const urls = raw
    // '*' is the SPA's own not-found; ':param' segments get a plausible value.
    .filter((r) => r !== '*' && !r.includes('*'))
    .map((r) =>
      '/' +
      r
        .split('/')
        .map((seg) =>
          seg.startsWith(':') ? (sample[seg.slice(1)] ?? 'sample-value') : seg,
        )
        .join('/'),
    )
    .map((u) => (u === '/' ? '/' : u.replace(/\/+$/, '')));
  return [...new Set(['/', ...urls])];
}

/**
 * The header sets that matter. Each one is a real thing a server sees;
 * the last two are the reason this file exists.
 */
const BROWSERS: Array<{ name: string; headers: Record<string, string> }> = [
  {
    name: 'Chrome / Edge / Firefox — full Sec-Fetch',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Site': 'none',
    },
  },
  {
    name: 'Safari 15 / iOS webview — no Sec-Fetch at all',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  },
  {
    name: 'proxy dropped Sec-Fetch-Dest, kept Mode',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
    },
  },
  {
    name: 'proxy dropped Sec-Fetch-Mode, kept Dest',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
    },
  },
  {
    name: 'hard refresh — cache bypassed',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  },
];

describe('every page route, hard-loaded by a browser', () => {
  const routes = pageRoutes();

  it('finds the web app’s route table', () => {
    // If this ever drops to a handful, the regex stopped matching and
    // every assertion below became vacuous.
    expect(routes.length).toBeGreaterThan(80);
    // Two pages that share their path with an API router — the shape of
    // the bug. (/jobs is API-only; its page lives at /internal-jobs.)
    expect(routes).toContain('/clients');
    expect(routes).toContain('/scheduling');
  });

  for (const browser of BROWSERS) {
    it(`never answers with JSON — ${browser.name}`, async () => {
      const app = createApp();
      const offenders: string[] = [];
      for (const url of routes) {
        const res = await request(app).get(url).set(browser.headers);
        const type = String(res.headers['content-type'] ?? '');
        if (type.includes('application/json')) {
          offenders.push(`${url} → ${res.status} ${type}`);
        }
      }
      // Named, so a failure says which page and not just "something".
      expect(offenders, `page routes answered with JSON:\n${offenders.join('\n')}`).toEqual(
        [],
      );
    });
  }

  it('still gives API clients JSON on those same paths', async () => {
    // The other half of the contract: fixing the page must not break the
    // fetch() call that shares its URL.
    const app = createApp();
    const res = await request(app).get('/clients').set({
      Accept: '*/*',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('keeps serving file downloads to the navigations that open them', async () => {
    // PDFs, CSVs and calendar feeds are opened by <a href> — a navigation
    // on purpose. They must not be swallowed by the SPA shell.
    const app = createApp();
    const res = await request(app)
      .get('/clients/11111111-1111-4111-8111-111111111111/service-report.pdf')
      .set(BROWSERS[0]!.headers);
    // It reached the auth layer rather than being swallowed by the shell.
    // Signed out, a download link sends you to sign in; either way the one
    // thing it is never answered with is JSON.
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login/);
    expect(res.headers['content-type']).not.toMatch(/application\/json/);
  });
});
