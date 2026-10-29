import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page, type Request } from '@playwright/test';
import { ASSOCIATE, DRIVER, WALK_PERSONAS, type WalkPersona } from './walkPersonas';

/**
 * Route smoke, per persona — the deep audit's crawler (2026-10-29) as a
 * test. Nothing stopped a page that 403s for the role whose nav links to it,
 * a raw "Missing capability: view:recruiting" on screen, a notification
 * landing on the 404 page, a chart storm of console warnings or a card cut
 * off on a phone; the crawl found all of them by hand. This sweep signs in
 * as each seeded persona, opens every page that persona's navigation links
 * to (every door opened), plus the pages the design walk photographs, and
 * fails on:
 *
 *   - a page error (an uncaught exception) or the crash screen ("Something broke");
 *   - any 5xx — an API call or the document;
 *   - a 403 from the API on a page the persona's own nav links to (the page
 *     is offered, so its reads must be allowed — or skipped, useReadable);
 *   - raw "Missing capability" text on screen;
 *   - the 404 page on a nav-linked route;
 *   - an in-app link (`<a href>`) that matches no route in App.tsx;
 *   - horizontal overflow at 390 px (the phone pass: associate, driver,
 *     supervisor, the store and region portals, the executive);
 *   - a broken image (an <img> that failed to load, or an image answer ≥ 400).
 *
 * Read-only: it navigates and reads; it never clicks anything but the nav's
 * own "Show … pages" door toggles. Opt-in (its own switch, like the axe
 * sweep): `E2E_FULLSTACK=1 ROUTE_SWEEP=1`. ROUTE_SWEEP_PERSONAS=admin,associate
 * narrows it. The full report lands in e2e-results/route-sweep/<persona>.json
 * (and on the test as an attachment). Known, accepted findings go in
 * e2e/route-sweep-allowlist.json with a reason — empty until one earns it.
 *
 * Runbook: .claude/skills/alto-e2e-local/SKILL.md ("Route sweep").
 */

test.skip(!process.env.E2E_FULLSTACK || !process.env.ROUTE_SWEEP, 'needs the full stack and ROUTE_SWEEP=1');

const PHONE_PERSONAS = new Set(['associate', 'driver', 'supervisor', 'portal-store', 'portal-region', 'executive']);
const ONLY = (process.env.ROUTE_SWEEP_PERSONAS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PERSONAS: WalkPersona[] = [...WALK_PERSONAS, ASSOCIATE, DRIVER].filter((p) => ONLY.length === 0 || ONLY.includes(p.key));
const REPORT_DIR = 'e2e-results/route-sweep';
const STATE_DIR = 'e2e-results/state';

type Kind = 'page-error' | 'crash' | '5xx' | '403-on-nav-page' | 'missing-capability' | 'not-found' | 'dead-link' | 'overflow-390' | 'broken-image';

interface Finding {
  persona: string;
  width: number;
  route: string;
  kind: Kind;
  detail: string;
}

interface Allowed {
  kind: Kind;
  /** Persona key; omitted = every persona. */
  persona?: string;
  /** Route prefix; omitted = every route. */
  route?: string;
  /** Substring of the finding's detail; omitted = any. */
  match?: string;
  reason: string;
}

const ALLOWLIST: Allowed[] = existsSync('e2e/route-sweep-allowlist.json')
  ? (JSON.parse(readFileSync('e2e/route-sweep-allowlist.json', 'utf8')) as Allowed[])
  : [];

const allowed = (f: Finding) =>
  ALLOWLIST.some(
    (a) => a.kind === f.kind && (!a.persona || a.persona === f.persona) && (!a.route || f.route.startsWith(a.route)) && (!a.match || f.detail.includes(a.match)),
  );

/* ----- The route table, from App.tsx (the same parse the crawl used) ------ */

function appRoutePatterns(): string[] {
  const src = readFileSync('src/App.tsx', 'utf8');
  const out = new Set<string>(['/']);
  for (const m of src.matchAll(/path: '([^']+)'/g)) {
    const p = m[1]!;
    out.add(p.startsWith('/') ? p : `/${p}`);
  }
  return [...out];
}

const PATTERNS = appRoutePatterns();

/** Does an in-app path land on a route (not the catch-all)? */
function matchesRoute(path: string, patterns: readonly string[] = PATTERNS): boolean {
  const segs = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === '/*') return false;
    const a = pattern.split('/').filter(Boolean);
    const splat = a[a.length - 1] === '*';
    const fixed = splat ? a.slice(0, -1) : a;
    if (splat ? segs.length < fixed.length : segs.length !== fixed.length) return false;
    return fixed.every((s, i) => s.startsWith(':') || s === segs[i]);
  });
}

/* ----- Signing in (cached per persona: the login limiter is 5 / 15 min) --- */

async function signIn(context: BrowserContext, page: Page, p: WalkPersona): Promise<void> {
  const path = `${STATE_DIR}/${p.key}.json`;
  if (existsSync(path)) {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { cookies?: Parameters<BrowserContext['addCookies']>[0] };
    if (state.cookies?.length) {
      await context.addCookies(state.cookies);
      const me = await page.request.get('/api/auth/me');
      if (me.ok() && ((await me.json()) as { user: unknown }).user != null) return;
      await context.clearCookies();
    }
  }
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(p.email);
  await page.getByLabel(/^password/i).fill(p.pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60_000 });
  mkdirSync(STATE_DIR, { recursive: true });
  await context.storageState({ path });
}

/* ----- One page visit ------------------------------------------------------ */

const IGNORE_REQ = (u: string) => /\/api\/events\/stream|\/@vite\/|__vite_ping|hot-update|\/api\/ux\b/.test(u);

interface Probe {
  url: string;
  crash: boolean;
  notFound: boolean;
  missingCapability: string[];
  brokenImages: string[];
  links: string[];
  overflow: { doc: number; main: number } | null;
}

class Recorder {
  current: { route: string; pageErrors: string[]; bad: Array<{ status: number; url: string; type: string }> } | null = null;
  private inflight = new Map<Request, number>();

  constructor(private page: Page) {
    page.on('request', (r) => {
      if (!IGNORE_REQ(r.url()) && r.resourceType() !== 'eventsource') this.inflight.set(r, Date.now());
    });
    page.on('requestfinished', (r) => this.inflight.delete(r));
    page.on('requestfailed', (r) => this.inflight.delete(r));
    // Deduped and capped: an error thrown every frame must not grow one visit's record without bound.
    page.on('pageerror', (err) => {
      const c = this.current;
      const text = String(err.stack ?? err).slice(0, 600);
      if (c && c.pageErrors.length < 10 && !c.pageErrors.includes(text)) c.pageErrors.push(text);
    });
    page.on('response', (res) => {
      if (!this.current) return;
      const s = res.status();
      const type = res.request().resourceType();
      const u = new URL(res.url());
      if ((s >= 500 || (u.pathname.startsWith('/api/') && s === 403) || (type === 'image' && s >= 400)) && this.current.bad.length < 50) {
        this.current.bad.push({ status: s, url: u.pathname + u.search, type });
      }
    });
  }

  /** Until the network has been quiet for 700 ms (long polls dropped after the cap). */
  async settle(capMs = 8_000): Promise<void> {
    const t0 = Date.now();
    let quietSince = Date.now();
    while (Date.now() - t0 < capMs) {
      for (const [r, ts] of this.inflight) if (Date.now() - ts > capMs) this.inflight.delete(r);
      if (this.inflight.size === 0) {
        if (Date.now() - quietSince > 700) return;
      } else quietSince = Date.now();
      await this.page.waitForTimeout(100);
    }
  }
}

async function probe(page: Page, narrow: boolean): Promise<Probe> {
  return page.evaluate((isNarrow) => {
    const main = document.querySelector('main');
    const body = document.body.innerText || '';
    const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /Missing capability/.test(e.textContent || ''));
    const overflow = isNarrow
      ? { doc: (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 }
      : null;
    return {
      url: location.pathname + location.search,
      crash: /Something broke/.test(body),
      notFound: /We couldn.t find that page/.test(body),
      missingCapability: leaves.map((e) => (e.textContent || '').trim().slice(0, 160)).slice(0, 5),
      brokenImages: [...document.images].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => (i.getAttribute('src') || '').slice(0, 160)),
      links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || '').filter(Boolean),
      overflow,
    };
  }, narrow);
}

/** Client-side navigation, the way the in-app router moves (and fast); a full load after a crash. */
async function go(page: Page, rec: Recorder, route: string, hard: boolean): Promise<void> {
  if (hard || page.url().includes('/login')) {
    await page.goto(route, { waitUntil: 'commit', timeout: 60_000 });
  } else {
    await page.evaluate((u) => {
      history.pushState(null, '', u);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    }, route);
  }
  await page.waitForSelector('main', { timeout: 15_000 }).catch(() => undefined);
  await rec.settle();
  await page.waitForTimeout(250);
}

/** Every link the persona's navigation offers, with every door opened. */
async function navLinks(page: Page, rec: Recorder): Promise<string[]> {
  await page.goto('/', { waitUntil: 'load', timeout: 60_000 });
  await page.waitForSelector('nav[data-tour="nav"]', { timeout: 30_000 }).catch(() => undefined);
  await rec.settle();
  const nav = page.locator('nav[data-tour="nav"]');
  const doors = nav.getByRole('button', { name: /^show .* pages$/i });
  for (let i = 0, n = await doors.count(); i < n && i < 40; i++) {
    // Each click re-renders the rail; always take the first still-closed door.
    const d = nav.getByRole('button', { name: /^show .* pages$/i }).first();
    if (!(await d.isVisible().catch(() => false))) break;
    await d.click().catch(() => undefined);
    await page.waitForTimeout(120);
  }
  const hrefs = await nav.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''));
  return [...new Set(hrefs.filter((h) => h.startsWith('/') && !h.startsWith('//')))];
}

/* ----- The sweep ----------------------------------------------------------- */

for (const persona of PERSONAS) {
  test(`route sweep — ${persona.key}: every page its nav links to loads clean`, async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('alto.tour.seen', '1');
        localStorage.setItem('alto.tours.done', '1');
      } catch {
        /* storage off: the tour shows, the sweep still reads */
      }
    });
    const page = await context.newPage();
    const rec = new Recorder(page);
    await signIn(context, page, persona);

    const linked = await navLinks(page, rec);
    const navPaths = new Set(linked.map((h) => h.split(/[?#]/)[0]!));
    const routes = [...new Set([...linked, ...persona.routes.map(([r]) => r)])];
    const findings: Finding[] = [];
    const visits: Array<{ width: number; route: string; landed: string; bad: number; pageErrors: number }> = [];
    const seenLinks = new Map<string, string>();
    // Written after every visit, so a run that times out still leaves its evidence.
    mkdirSync(REPORT_DIR, { recursive: true });
    const flush = (done: boolean) =>
      writeFileSync(`${REPORT_DIR}/${persona.key}.json`, JSON.stringify({ persona: persona.key, done, routes: routes.length, navLinks: linked.length, visits, findings, at: new Date().toISOString() }, null, 1));

    const passes: number[] = PHONE_PERSONAS.has(persona.key) ? [1440, 390] : [1440];
    for (const width of passes) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      let hard = true;
      for (const route of routes) {
        rec.current = { route, pageErrors: [], bad: [] };
        try {
          await go(page, rec, route, hard);
        } catch (e) {
          findings.push({ persona: persona.key, width, route, kind: 'page-error', detail: `navigation failed: ${String(e).slice(0, 200)}` });
        }
        const pr = await probe(page, width < 600).catch(() => null);
        const cur = rec.current!;
        rec.current = null;
        hard = false;
        const add = (kind: Kind, detail: string) => {
          if (!findings.some((f) => f.kind === kind && f.width === width && f.route === route && f.detail === detail)) findings.push({ persona: persona.key, width, route, kind, detail });
        };
        for (const err of cur.pageErrors) add('page-error', err);
        for (const b of cur.bad) {
          if (b.status >= 500) add('5xx', `${b.status} ${b.url}`);
          else if (b.status === 403 && navPaths.has(route.split(/[?#]/)[0]!)) add('403-on-nav-page', `403 ${b.url}`);
          else if (b.type === 'image' && b.status >= 400) add('broken-image', `${b.status} ${b.url}`);
        }
        if (pr) {
          if (pr.crash) {
            add('crash', `the crash screen on ${pr.url}`);
            hard = true;
          }
          if (pr.notFound && navPaths.has(route.split(/[?#]/)[0]!)) add('not-found', `the 404 page on ${pr.url}`);
          for (const t of pr.missingCapability) add('missing-capability', t);
          for (const src of pr.brokenImages) add('broken-image', src);
          if (pr.overflow && (pr.overflow.doc > 1 || pr.overflow.main > 1)) add('overflow-390', `page ${pr.overflow.doc}px, main ${pr.overflow.main}px wider than the screen`);
          for (const h of pr.links) if (!seenLinks.has(h)) seenLinks.set(h, route);
        }
        visits.push({ width, route, landed: pr?.url ?? '?', bad: cur.bad.length, pageErrors: cur.pageErrors.length });
        flush(false);
      }
    }

    // Dead in-app links: an href that starts with "/" and matches no route.
    for (const [href, from] of seenLinks) {
      if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/')) continue;
      if (!matchesRoute(href)) findings.push({ persona: persona.key, width: 1440, route: from, kind: 'dead-link', detail: href });
    }

    const failing = findings.filter((f) => !allowed(f));
    const report = { persona: persona.key, routes: routes.length, navLinks: linked.length, visits, findings, failing: failing.length, at: new Date().toISOString() };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(`${REPORT_DIR}/${persona.key}.json`, JSON.stringify(report, null, 1));
    await test.info().attach(`route-sweep-${persona.key}.json`, { body: JSON.stringify(report, null, 1), contentType: 'application/json' });
    await context.close();

    expect(
      failing.map((f) => `${f.kind} @ ${f.width} ${f.route}: ${f.detail}`),
      `${persona.key}: ${failing.length} finding(s) — the full report is in ${REPORT_DIR}/${persona.key}.json`,
    ).toEqual([]);
  });
}
