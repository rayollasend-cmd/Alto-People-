import { test, expect } from '@playwright/test';

/**
 * Authenticated phone-viewport walk of the associate app. Needs the full
 * stack (API dev server + seeded dev DB), so it only runs when
 * E2E_FULLSTACK=1 — the default `test:e2e` stays API-independent.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server (set E2E_FULLSTACK=1)');

test('associate shell is app-shaped: tab bar, dashboard, schedule', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('maria.lopez@example.com');
  await page.getByLabel(/password/i).fill('maria-dev-2026!');
  await page.getByRole('button', { name: /sign in/i }).click();

  // Dashboard greets by name once auth + data land. The greeting renders
  // twice — the large-title hero (h1) and the sticky app-shell header (h2);
  // target the hero so the match is unambiguous.
  await expect(
    page.getByRole('heading', { level: 1, name: /hey maria/i }),
  ).toBeVisible({ timeout: 20_000 });

  // The native-idiom bottom tab bar is the phone nav.
  const tabBar = page.getByRole('navigation', { name: /primary/i });
  await expect(tabBar).toBeVisible();
  await expect(tabBar.getByRole('link', { name: /schedule/i })).toBeVisible();
  await page.screenshot({ path: 'e2e-results/dashboard-mobile.png' });

  // One-tap section change from the thumb zone.
  await tabBar.getByRole('link', { name: /schedule/i }).click();
  await expect(page.getByText(/my schedule/i).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'e2e-results/schedule-mobile.png' });

  // Still zero horizontal overflow after real content rendered.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
