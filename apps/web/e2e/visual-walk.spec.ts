import { test, expect } from '@playwright/test';

/**
 * Visual QA walk — phone viewport, every core associate screen, with the
 * demo schedule seeded (scripts/seed-demo-shifts.ts). Produces the
 * screenshot set a designer would review. Gated like the other
 * authenticated specs.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server (set E2E_FULLSTACK=1)');

const shot = (name: string) => `e2e-results/walk-${name}.png`;

test('associate visual walk', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('maria.lopez@example.com');
  await page.getByLabel(/password/i).fill('maria-dev-2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText(/hey maria/i)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500); // let cards land
  await page.screenshot({ path: shot('01-dashboard'), fullPage: true });

  // Schedule list + expanded shift detail (teammates, ack, swap).
  await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: /schedule/i }).click();
  await expect(page.getByText(/my schedule/i).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: shot('02-schedule-list'), fullPage: true });
  const firstCard = page.getByRole('button', { name: /Demo:/ }).first();
  if (await firstCard.isVisible().catch(() => false)) {
    await firstCard.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: shot('03-shift-detail') });
  }

  // Week + month calendar views.
  await page.getByRole('radio', { name: 'Week' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('04-week-view'), fullPage: true });
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('05-month-view') });
  await page.getByRole('radio', { name: 'List' }).click();

  // Clock screen.
  await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: /clock/i }).click();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: shot('06-clock') });

  // Time off + the request bottom sheet.
  await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: /time off/i }).click();
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: shot('07-timeoff') });
  const requestBtn = page.getByRole('button', { name: /request time off/i }).first();
  if (await requestBtn.isVisible().catch(() => false)) {
    await requestBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('08-timeoff-sheet') });
    await page.keyboard.press('Escape');
  }

  // The More drawer.
  await page.getByRole('button', { name: /more/i }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('09-drawer') });
});
