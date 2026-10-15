import type { Page } from '@playwright/test';

/**
 * The people the design walk and the accessibility sweep sign in as, and
 * the surfaces each one reaches. One list, so the sweep audits exactly the
 * screens the walk photographs. Every account is created by the dev seed.
 */
export interface WalkPersona {
  key: string;
  email: string;
  pass: string;
  /** [route, screenshot name] */
  routes: Array<[string, string]>;
}

export const ADMIN_ROUTES: Array<[string, string]> = [
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
  ['/trust', 'trust'],
];

export const WALK_PERSONAS: WalkPersona[] = [
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

export const ASSOCIATE: WalkPersona = {
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

export const DRIVER: WalkPersona = { key: 'driver', email: 'driver@altohr.com', pass: 'driver-dev-2026!', routes: [['/', 'home'], ['/transport', 'runs']] };

export const PUBLIC_ROUTES: Array<[string, string]> = [
  ['/login', 'login'],
  ['/login/alto-hr', 'login-slug'],
  ['/forgot-password', 'forgot-password'],
  ['/careers', 'careers'],
  ['/hotline', 'hotline'],
  ['/install', 'install'],
  ['/trust-center', 'trust-center'],
  ['/status', 'status'],
  ['/accessibility', 'accessibility'],
];

export async function walkLogin(page: Page, email: string, pass: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/^password/i).fill(pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3500);
}

export async function setWalkTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => localStorage.setItem('alto.theme', t), theme);
}

/**
 * The first-run coachmark tour and the "New this week" card sit over every
 * screen of a fresh account; a review needs the screen. Dismiss whichever
 * is showing (both remember the dismissal per account).
 */
export async function settleWalk(page: Page) {
  for (const name of [/^skip$/i, /^got it$/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }
}
