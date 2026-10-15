import { mkdirSync } from 'node:fs';
import { test, type Page } from '@playwright/test';

/**
 * The design-review walk (UX upgrade investigation, 2026-10-15): every
 * persona the seed creates, every surface they reach, desktop and phone,
 * dark and light. It asserts nothing beyond "the page renders": the PNGs
 * under e2e-results/design-walk/ are the deliverable, read by a designer
 * or an agent. Run in GitHub Actions by .github/workflows/design-walk.yml.
 *
 * A route that fails still leaves a screenshot of whatever rendered, so one
 * broken page never hides the rest of the walk.
 */

// Its own switch, not E2E_FULLSTACK: the CI E2E job sets that for the
// guards, and this walk (200 screenshots) is not a guard. design-walk.yml
// sets DESIGN_WALK=1.
test.skip(!process.env.E2E_FULLSTACK || !process.env.DESIGN_WALK, 'needs the API dev server and DESIGN_WALK=1');

const ROOT = 'e2e-results/design-walk';
mkdirSync(ROOT, { recursive: true });

interface Persona {
  key: string;
  email: string;
  pass: string;
  routes: Array<[string, string]>;
}

const ADMIN_ROUTES: Array<[string, string]> = [
  ['/', 'home'],
  ['/approvals', 'approvals'],
  ['/people', 'people'],
  ['/scheduling', 'scheduling'],
  ['/time-attendance', 'time'],
  ['/onboarding', 'onboarding'],
  ['/recruiting', 'recruiting'],
  ['/payroll', 'payroll'],
  ['/payroll/labor-rules', 'labor-rules'],
  ['/headcount', 'headcount'],
  ['/analytics', 'analytics'],
  ['/compliance', 'compliance'],
  ['/documents', 'documents'],
  ['/audit', 'audit'],
  ['/agents', 'agents'],
  ['/workers', 'workers'],
  ['/relay', 'relay'],
  ['/ops', 'store-ops'],
  ['/clients', 'clients'],
  ['/messages', 'messages'],
  ['/communications', 'communications'],
  ['/programs', 'programs'],
  ['/season-planner', 'season-planner'],
  ['/emergency', 'emergency'],
  ['/transport', 'transport'],
  ['/admin/users', 'users'],
  ['/admin/sign-in', 'sign-in'],
  ['/admin/organization', 'organization'],
  ['/admin/org-units', 'org-units'],
  ['/admin/sites', 'sites'],
  ['/admin/billing', 'billing'],
  ['/admin/compliance-evidence', 'compliance-evidence'],
  ['/admin/branding', 'branding'],
  ['/developers', 'developers'],
  ['/integrations', 'integrations'],
  ['/reliability', 'reliability'],
  ['/product-analytics', 'product-analytics'],
  ['/support', 'support'],
  ['/platform/support', 'platform-support'],
  ['/whats-new', 'whats-new'],
  ['/help-center', 'help-center'],
  ['/settings', 'settings'],
  ['/me', 'me'],
];

const PERSONAS: Persona[] = [
  { key: 'admin', email: 'admin@altohr.com', pass: 'alto-admin-dev', routes: ADMIN_ROUTES },
  { key: 'ops-manager', email: 'ops@altohr.com', pass: 'ops-dev-2026!', routes: [['/', 'home'], ['/approvals', 'approvals'], ['/people', 'people']] },
  { key: 'manager', email: 'manager@altohr.com', pass: 'manager-dev-2026!', routes: [['/', 'home'], ['/team', 'team'], ['/approvals', 'approvals']] },
  { key: 'workforce-manager', email: 'workforce@altohr.com', pass: 'workforce-dev-2026!', routes: [['/', 'home'], ['/relay', 'relay'], ['/ops', 'store-ops'], ['/scheduling', 'scheduling']] },
  { key: 'finance', email: 'finance@altohr.com', pass: 'finance-dev-2026!', routes: [['/', 'home'], ['/payroll', 'payroll'], ['/labor-costs', 'labor-costs'], ['/reimbursements', 'reimbursements'], ['/clients', 'clients']] },
  { key: 'recruiter', email: 'recruiter@altohr.com', pass: 'recruiter-dev-2026!', routes: [['/', 'home'], ['/recruiting', 'recruiting'], ['/onboarding', 'onboarding']] },
  { key: 'transport-director', email: 'transport@altohr.com', pass: 'transport-dev-2026!', routes: [['/', 'home'], ['/transport', 'transport']] },
  { key: 'supervisor', email: 'dana.reyes@altohr.com', pass: 'supervisor-dev-2026!', routes: [['/', 'home'], ['/scheduling', 'scheduling'], ['/time-attendance', 'time'], ['/ops', 'store-ops'], ['/approvals', 'approvals']] },
  { key: 'portal-store', email: 'portal@coastalresort.example', pass: 'portal-dev-2026!', routes: [['/portal', 'home'], ['/portal/today', 'today'], ['/portal/schedule', 'schedule'], ['/portal/requests', 'requests'], ['/portal/ops', 'ops'], ['/portal/history', 'history']] },
  { key: 'portal-region', email: 'region@coastalresort.example', pass: 'portal-dev-2026!', routes: [['/region', 'command-center']] },
];

const ASSOCIATE: Persona = {
  key: 'associate',
  email: 'maria.lopez@example.com',
  pass: 'maria-dev-2026!',
  routes: [
    ['/', 'home'],
    ['/scheduling', 'schedule'],
    ['/time-attendance', 'time'],
    ['/payroll', 'pay'],
    ['/time-off', 'time-off'],
    ['/rides', 'rides'],
    ['/messages', 'messages'],
    ['/documents', 'documents'],
    ['/learning', 'learning'],
    ['/me', 'me'],
    ['/settings', 'settings'],
    ['/help-center', 'help-center'],
    ['/whats-new', 'whats-new'],
  ],
};

const DRIVER: Persona = { key: 'driver', email: 'driver@altohr.com', pass: 'driver-dev-2026!', routes: [['/', 'home'], ['/transport', 'runs']] };

const PUBLIC: Array<[string, string]> = [
  ['/login', 'login'],
  ['/login/alto-hr', 'login-slug'],
  ['/forgot-password', 'forgot-password'],
  ['/careers', 'careers'],
  ['/hotline', 'hotline'],
  ['/install', 'install'],
];

async function login(page: Page, email: string, pass: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3500);
}

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => localStorage.setItem('alto.theme', t), theme);
}

async function shoot(page: Page, file: string, fullPage: boolean) {
  try {
    await page.screenshot({ path: `${ROOT}/${file}.png`, fullPage });
  } catch (err) {
    console.log(`screenshot failed ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The first-run coachmark tour and the "New this week" card sit over every
 * screen of a fresh account; a design review needs the screen. Dismiss
 * whichever is showing (both remember the dismissal per account).
 */
async function settle(page: Page) {
  for (const name of [/^skip$/i, /^got it$/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}

async function walk(page: Page, persona: Persona, form: 'desktop' | 'phone', theme: 'dark' | 'light') {
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
    await page.getByText(/^Workforce( agent)?$/i).first().click({ timeout: 5000 });
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
    const onTheGo: Persona = { ...PERSONAS[0]!, routes: [['/', 'home'], ['/approvals', 'approvals'], ['/people', 'people'], ['/scheduling', 'scheduling'], ['/time-attendance', 'time'], ['/agents', 'agents'], ['/audit', 'audit'], ['/admin/users', 'users'], ['/settings', 'settings']] };
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
