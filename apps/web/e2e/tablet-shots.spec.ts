import { test, expect } from '@playwright/test';

/**
 * iPad-viewport evidence capture (chromium with touch, 820x1180 ≈ iPad
 * 10th gen portrait). Full stack required — gated like the associate walk.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server (set E2E_FULLSTACK=1)');

test.use({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  isMobile: false,
});

test('associate on iPad: dashboard + schedule', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('maria.lopez@example.com');
  await page.getByLabel(/password/i).fill('maria-dev-2026!');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText(/hey maria/i)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'e2e-results/ipad-associate-dashboard.png' });
  await page.goto('/scheduling');
  await expect(page.getByText(/my schedule/i).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'e2e-results/ipad-associate-schedule.png' });
});

test('admin on iPad: scheduling grid', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('admin@altohr.com');
  await page.getByLabel(/password/i).fill('alto-admin-dev');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard)?$/, { timeout: 20_000 }).catch(() => {});
  await page.goto('/scheduling');
  await page.waitForTimeout(4_000); // let the grid settle
  await page.screenshot({ path: 'e2e-results/ipad-admin-scheduling.png', fullPage: false });
});
