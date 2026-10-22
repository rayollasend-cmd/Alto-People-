import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import axe from 'axe-core';
import { ADMIN_ROUTES, ASSOCIATE, DRIVER, PUBLIC_ROUTES, WALK_PERSONAS, settleWalk, setWalkTheme, walkLogin, type WalkPersona } from './walkPersonas';

/**
 * Accessibility sweep on the real, running app — the CI gate behind the
 * accessibility statement (/accessibility). It signs in as every persona
 * the design walk photographs, opens every surface the walk opens, in the
 * dark theme (and the light theme for the two most-used roles), runs
 * axe-core against WCAG 2.2 AA, and fails on anything rated serious or
 * critical. Lesser findings ride along in the report so the bar can rise
 * without a flag day.
 *
 * Its own CI job (.github/workflows/ci.yml, "Accessibility"), its own
 * switch (A11Y_SWEEP=1): one sign-in per persona per run, so the login
 * limiter is never the thing that fails.
 *
 * Known third-party findings go in axe-allowlist.json with a reason; the
 * list is read here and is empty until something earns a place on it.
 */

test.skip(!process.env.E2E_FULLSTACK || !process.env.A11Y_SWEEP, 'needs the API dev server and A11Y_SWEEP=1');

interface Finding {
  persona: string;
  theme: string;
  route: string;
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
  /** What axe measured, where it measures anything — the colour pair and
   *  ratio behind a contrast finding, so the fix needs no second run. */
  detail: string;
}

interface Allowed {
  id: string;
  /** Route prefix; omitted = every route. */
  route?: string;
  reason: string;
}

const ALLOWLIST = JSON.parse(readFileSync('e2e/axe-allowlist.json', 'utf8')) as Allowed[];

/**
 * Phone: no page scrolls sideways. Every page the phone sweep opens is
 * measured at 390px — the page (and the shell's <main>, which clips its own
 * x-overflow, so its scrollWidth is what a reader would have had to pan)
 * must be no wider than the screen. The pages the F500 audit (2026-10-22)
 * found overflowing are listed here with the finding; the list only
 * shrinks: a listed page that fits again fails the run until its line is
 * deleted, and an unlisted page that overflows fails it outright.
 */
const PHONE_OVERFLOW_ALLOWLIST: Record<string, string> = {
  '/agents': 'F500 G2: AgentCards.tsx grid has no base column count; cards widen the page (~81px)',
  '/ops': 'F500 G2: OpsBoard.tsx:946 `grid xl:grid-cols-[1fr_360px]` lets a min-content child widen the page (~69px)',
  '/fieldglass': 'F500 G2: FieldglassSetup.tsx start/end date row overflows by ~15px',
};

/** Pages the audit found overflowing that no persona's sweep opens — measured on the admin's phone pass. */
const PHONE_OVERFLOW_EXTRA = ['/ops', '/fieldglass', '/admin/branding', '/marketing'];

/** How far (px) a page is wider than a phone screen: the document, or the shell's <main>. */
async function phoneOverflowPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const over = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0);
    return Math.max(over(document.documentElement), over(document.getElementById('main-content')));
  });
}

async function phoneOverflowSweep(page: Page, routes: string[]): Promise<string[]> {
  // The narrowest phone the product is held to (an iPhone 12–15), not the
  // Pixel 7's 412px the rest of the phone sweep runs at.
  await page.setViewportSize({ width: 390, height: 844 });
  const problems: string[] = [];
  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await settleWalk(page);
    const px = await phoneOverflowPx(page);
    const listed = PHONE_OVERFLOW_ALLOWLIST[route];
    if (px > 1 && !listed) problems.push(`${route} is ${px}px wider than the phone screen`);
    if (px <= 1 && listed) problems.push(`${route} fits the phone now — delete its line from PHONE_OVERFLOW_ALLOWLIST`);
  }
  return problems;
}
const allowed = (f: Finding) => ALLOWLIST.some((a) => a.id === f.id && (!a.route || f.route.startsWith(a.route)));

async function auditRoute(page: Page, persona: string, theme: string, route: string): Promise<Finding[]> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await settleWalk(page);
  await page.addScriptTag({ content: axe.source });
  const raw = await page.evaluate(async () => {
    const w = window as unknown as { axe: typeof import('axe-core') };
    const r = await w.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      detail: v.nodes
        .slice(0, 3)
        .map((n) => {
          const d = (n.any[0] ?? n.all[0])?.data as
            | { fgColor?: string; bgColor?: string; contrastRatio?: number; fontSize?: string }
            | undefined;
          return d?.contrastRatio ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio} (${d.fontSize})` : '';
        })
        .filter(Boolean)
        .join(' | '),
    }));
  });
  return raw.map((f) => ({ persona, theme, route, ...f }));
}

function report(findings: Finding[], name: string, testInfo: Parameters<Parameters<typeof test>[1]>[1]) {
  const body = JSON.stringify(findings, null, 2);
  writeFileSync(testInfo.outputPath(`axe-${name}.json`), body);
  void testInfo.attach(`axe-${name}.json`, { body, contentType: 'application/json' });
  const blocking = findings
    .filter((f) => (f.impact === 'serious' || f.impact === 'critical') && !allowed(f))
    .map((f) => `[${f.persona} ${f.theme} ${f.route}] ${f.id} (${f.impact}) — ${f.help} @ ${f.targets.join(' | ')}${f.detail ? ` :: ${f.detail}` : ''}`);
  expect(blocking, `axe as ${name}`).toEqual([]);
}

async function sweep(page: Page, persona: WalkPersona, themes: Array<'dark' | 'light'>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const theme of themes) {
    await setWalkTheme(page, theme);
    for (const [route] of persona.routes) {
      try {
        findings.push(...(await auditRoute(page, persona.key, theme, route)));
      } catch (err) {
        // A route that fails to load is the E2E job's finding, not this one's; say so and move on.
        console.log(`${persona.key} ${theme} ${route}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return findings;
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('public pages', async ({ page }, testInfo) => {
    test.setTimeout(PUBLIC_ROUTES.length * 2 * 10_000 + 30_000);
    const findings: Finding[] = [];
    for (const theme of ['dark', 'light'] as const) {
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      await setWalkTheme(page, theme);
      for (const [route] of PUBLIC_ROUTES) {
        findings.push(...(await auditRoute(page, 'public', theme, route)));
      }
    }
    report(findings, 'public', testInfo);
  });

  for (const persona of WALK_PERSONAS) {
    const themes: Array<'dark' | 'light'> = persona.key === 'admin' ? ['dark', 'light'] : ['dark'];
    test(`${persona.key} (${themes.join(', ')})`, async ({ page }, testInfo) => {
      test.setTimeout(persona.routes.length * themes.length * 10_000 + 60_000);
      await walkLogin(page, persona.email, persona.pass);
      report(await sweep(page, persona, themes), persona.key, testInfo);
    });
  }
});

test.describe('phone', () => {
  test('associate (dark, light)', async ({ page }, testInfo) => {
    test.setTimeout(ASSOCIATE.routes.length * 3 * 10_000 + 60_000);
    await walkLogin(page, ASSOCIATE.email, ASSOCIATE.pass);
    report(await sweep(page, ASSOCIATE, ['dark', 'light']), 'associate', testInfo);
    expect(await phoneOverflowSweep(page, ASSOCIATE.routes.map(([r]) => r)), 'phone overflow as associate').toEqual([]);
  });

  test('driver (dark)', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await walkLogin(page, DRIVER.email, DRIVER.pass);
    report(await sweep(page, DRIVER, ['dark']), 'driver', testInfo);
    expect(await phoneOverflowSweep(page, DRIVER.routes.map(([r]) => r)), 'phone overflow as driver').toEqual([]);
  });

  test('admin on the go (dark)', async ({ page }, testInfo) => {
    test.setTimeout(ADMIN_ROUTES.length * 10_000 + 180_000);
    await walkLogin(page, 'admin@altohr.com', 'alto-admin-dev');
    const onTheGo: WalkPersona = { key: 'admin-phone', email: '', pass: '', routes: [['/', 'home'], ['/approvals', 'approvals'], ['/people', 'people'], ['/scheduling', 'scheduling'], ['/time-attendance', 'time'], ['/agents', 'agents'], ['/audit', 'audit'], ['/admin/users', 'users'], ['/settings', 'settings']] };
    report(await sweep(page, onTheGo, ['dark']), 'admin-phone', testInfo);
    const routes = [...new Set([...onTheGo.routes.map(([r]) => r), ...PHONE_OVERFLOW_EXTRA])];
    expect(await phoneOverflowSweep(page, routes), 'phone overflow as admin').toEqual([]);
  });

  test('every phone-overflow allowlist line names a page the sweep opens', () => {
    const swept = new Set([...ASSOCIATE.routes.map(([r]) => r), ...DRIVER.routes.map(([r]) => r), '/', '/approvals', '/people', '/scheduling', '/time-attendance', '/agents', '/audit', '/admin/users', '/settings', ...PHONE_OVERFLOW_EXTRA]);
    expect(Object.keys(PHONE_OVERFLOW_ALLOWLIST).filter((r) => !swept.has(r))).toEqual([]);
  });
});
