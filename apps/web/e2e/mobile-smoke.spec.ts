import { test, expect } from '@playwright/test';

/**
 * Phone-viewport smoke: the app shell renders like an app, not a
 * squeezed desktop page. Runs against the dev server with no API —
 * the login screen is fully client-rendered.
 */

test('login renders on a phone with no horizontal overflow', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel(/email/i)).toBeVisible();

  // A single horizontal-overflow pixel is the classic "website on a
  // phone" tell — the shell must fit the viewport exactly.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.screenshot({
    path: 'e2e-results/login-mobile.png',
    fullPage: true,
  });
});

test('form fields are 16px+ so iOS will not zoom on focus', async ({ page }) => {
  await page.goto('/login');
  const emailField = page.getByLabel(/email/i);
  await expect(emailField).toBeVisible();
  const fontSize = await emailField.evaluate(
    (el) => parseFloat(getComputedStyle(el).fontSize),
  );
  expect(fontSize).toBeGreaterThanOrEqual(16);
});
