import { mkdirSync } from 'node:fs';
import { test, type Page } from '@playwright/test';
import { ADMIN_ROUTES, ASSOCIATE, DRIVER, PUBLIC_ROUTES, WALK_PERSONAS, settleWalk, setWalkTheme, walkLogin, type WalkPersona } from './walkPersonas';

/**
 * The design-review walk (UX upgrade investigation, 2026-10-15): every
 * persona the seed creates, every surface they reach, desktop and phone,
 * dark and light. It asserts nothing beyond "the page renders": the PNGs
 * under e2e-results/design-walk/ are the deliverable, read by a designer
 * or an agent. Run in GitHub Actions by .github/workflows/design-walk.yml.
 *
 * A route that fails still leaves a screenshot of whatever rendered, so one
 * broken page never hides the rest of the walk.
 *
 * The personas and routes live in walkPersonas.ts, shared with the
 * accessibility sweep so it audits exactly the screens this walk shows.
 */

// Its own switch, not E2E_FULLSTACK: the CI E2E job sets that for the
// guards, and this walk (200 screenshots) is not a guard. design-walk.yml
// sets DESIGN_WALK=1.
test.skip(!process.env.E2E_FULLSTACK || !process.env.DESIGN_WALK, 'needs the API dev server and DESIGN_WALK=1');

const ROOT = 'e2e-results/design-walk';
mkdirSync(ROOT, { recursive: true });

const PERSONAS = WALK_PERSONAS;
const PUBLIC = PUBLIC_ROUTES;
const login = walkLogin;
const setTheme = setWalkTheme;
const settle = settleWalk;

async function shoot(page: Page, file: string, fullPage: boolean) {
  try {
    await page.screenshot({ path: `${ROOT}/${file}.png`, fullPage });
  } catch (err) {
    console.log(`screenshot failed ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

async function walk(page: Page, persona: WalkPersona, form: 'desktop' | 'phone', theme: 'dark' | 'light') {
  // The app defaults to the system theme, which a CI browser reports as
  // light: every walk names its theme outright.
  await setTheme(page, theme);
  for (const [route, name] of persona.routes) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await settle(page);
    } catch (err) {
      console.log(`${persona.key} ${route}: ${err instanceof Error ? err.message : err}`);
    }
    await shoot(page, `${persona.key}/${form}-${theme}-${name}`, form === 'phone');
  }
}

/** The admin's tabs that hide a whole surface behind a click. */
async function adminTabs(page: Page, form: 'desktop' | 'phone', theme: 'dark' | 'light') {
  await setTheme(page, theme);
  const clickShoot = async (route: string, label: RegExp, name: string) => {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await settle(page);
      await page.getByText(label).first().click({ timeout: 5000 });
      await page.waitForTimeout(2500);
    } catch (err) {
      console.log(`tab ${name}: ${err instanceof Error ? err.message : err}`);
    }
    await shoot(page, `admin/${form}-${theme}-${name}`, form === 'phone');
  };
  await clickShoot('/admin/users', /roles & permissions/i, 'users-roles');
  await clickShoot('/admin/users', /access report/i, 'users-access-report');
  // An agent's record and its compliance (decision) record: open the first built-in agent.
  try {
    await page.goto('/agents', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    // The agents are cards; the Workforce agent's card opens its record page.
    await page.getByRole('link', { name: /^Open Workforce agent/i }).first().click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    await shoot(page, `admin/${form}-${theme}-agents-record`, form === 'phone');
    await page.getByRole('tab', { name: /compliance record/i }).click({ timeout: 5000 });
    await page.waitForTimeout(2000);
  } catch (err) {
    console.log(`agent record: ${err instanceof Error ? err.message : err}`);
  }
  await shoot(page, `admin/${form}-${theme}-agents-decision-record`, form === 'phone');
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('public pages', async ({ page }) => {
    test.setTimeout(120_000);
    for (const [route, name] of PUBLIC) {
      await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(1500);
      await shoot(page, `public/desktop-dark-${name}`, false);
    }
    await setTheme(page, 'light');
    await page.goto('/login', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(1500);
    await shoot(page, 'public/desktop-light-login', false);
  });

  for (const persona of PERSONAS) {
    test(`${persona.key} desktop dark`, async ({ page }) => {
      test.setTimeout(persona.routes.length * 12_000 + 60_000);
      await login(page, persona.email, persona.pass);
      await walk(page, persona, 'desktop', 'dark');
      if (persona.key === 'admin') await adminTabs(page, 'desktop', 'dark');
    });
  }

  test('admin desktop light', async ({ page }) => {
    test.setTimeout(ADMIN_ROUTES.length * 12_000 + 60_000);
    await login(page, 'admin@altohr.com', 'alto-admin-dev');
    await setTheme(page, 'light');
    await walk(page, PERSONAS[0]!, 'desktop', 'light');
    await adminTabs(page, 'desktop', 'light');
  });

  test('associate desktop dark', async ({ page }) => {
    test.setTimeout(ASSOCIATE.routes.length * 12_000 + 60_000);
    await login(page, ASSOCIATE.email, ASSOCIATE.pass);
    await walk(page, ASSOCIATE, 'desktop', 'dark');
  });
});

test.describe('phone', () => {
  test('associate phone dark, light and Spanish', async ({ page }) => {
    test.setTimeout(ASSOCIATE.routes.length * 30_000 + 60_000);
    await login(page, ASSOCIATE.email, ASSOCIATE.pass);
    await walk(page, ASSOCIATE, 'phone', 'dark');
    await setTheme(page, 'light');
    await walk(page, { ...ASSOCIATE, routes: ASSOCIATE.routes.slice(0, 5) }, 'phone', 'light');
    await setTheme(page, 'dark');
    await page.evaluate(() => localStorage.setItem('alto.lang', 'es'));
    await walk(page, { ...ASSOCIATE, key: 'associate-es', routes: ASSOCIATE.routes.slice(0, 6) }, 'phone', 'dark');
    await page.evaluate(() => localStorage.setItem('alto.lang', 'tr'));
    await walk(page, { ...ASSOCIATE, key: 'associate-tr', routes: ASSOCIATE.routes.slice(0, 2) }, 'phone', 'dark');
  });

  test('driver phone', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, DRIVER.email, DRIVER.pass);
    await walk(page, DRIVER, 'phone', 'dark');
  });

  test('supervisor phone', async ({ page }) => {
    test.setTimeout(120_000);
    const p = PERSONAS.find((x) => x.key === 'supervisor')!;
    await login(page, p.email, p.pass);
    await walk(page, p, 'phone', 'dark');
  });

  test('portal phone', async ({ page }) => {
    test.setTimeout(120_000);
    const p = PERSONAS.find((x) => x.key === 'portal-store')!;
    await login(page, p.email, p.pass);
    await walk(page, p, 'phone', 'dark');
  });

  test('admin phone (the surfaces an admin opens on the go)', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, 'admin@altohr.com', 'alto-admin-dev');
    const onTheGo: WalkPersona = { ...PERSONAS[0]!, routes: [['/', 'home'], ['/approvals', 'approvals'], ['/people', 'people'], ['/scheduling', 'scheduling'], ['/time-attendance', 'time'], ['/agents', 'agents'], ['/audit', 'audit'], ['/admin/users', 'users'], ['/settings', 'settings']] };
    await walk(page, onTheGo, 'phone', 'dark');
  });

  test('public phone', async ({ page }) => {
    test.setTimeout(60_000);
    for (const [route, name] of PUBLIC.slice(0, 3)) {
      await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForTimeout(1500);
      await shoot(page, `public/phone-dark-${name}`, true);
    }
  });
});
