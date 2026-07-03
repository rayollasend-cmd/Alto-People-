import { test, type Page } from '@playwright/test';

/**
 * Screenshot walk for design review — both personas, both themes, both
 * form factors. Produces e2e-results/polish/*.png for a human (or agent)
 * to eyeball; it asserts nothing beyond "the pages render".
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server');

const shot = (name: string) => `e2e-results/polish/${name}.png`;

async function login(page: Page, email: string, pass: string) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3500);
}

test('admin desktop walk (dark + light)', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'admin@altohr.com', 'alto-admin-dev');

  const routes: Array<[string, string]> = [
    ['/', 'admin-dashboard'],
    ['/approvals', 'admin-approvals'],
    ['/scheduling', 'admin-scheduling'],
    ['/time-attendance', 'admin-time'],
    ['/people', 'admin-people'],
    ['/onboarding', 'admin-onboarding'],
  ];
  for (const [route, name] of routes) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`${name}-dark`) });
  }

  // Light theme spot-checks.
  await page.evaluate(() => localStorage.setItem('alto.theme', 'light'));
  for (const [route, name] of [
    ['/', 'admin-dashboard'],
    ['/approvals', 'admin-approvals'],
    ['/onboarding', 'admin-onboarding'],
  ] as Array<[string, string]>) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`${name}-light`) });
  }
});

test('associate phone walk (incl. Spanish)', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, 'maria.lopez@example.com', 'maria-dev-2026!');

  for (const [route, name] of [
    ['/', 'assoc-dashboard'],
    ['/scheduling', 'assoc-schedule'],
    ['/time-off', 'assoc-timeoff'],
    ['/payroll', 'assoc-pay'],
  ] as Array<[string, string]>) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`${name}-en`), fullPage: true });
  }

  await page.evaluate(() => localStorage.setItem('alto.lang', 'es'));
  for (const [route, name] of [
    ['/', 'assoc-dashboard'],
    ['/time-off', 'assoc-timeoff'],
  ] as Array<[string, string]>) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: shot(`${name}-es`), fullPage: true });
  }
});
