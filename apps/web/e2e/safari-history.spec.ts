import { test, expect, devices } from '@playwright/test';

/**
 * Safari's history budget, under WebKit on an iPhone profile.
 *
 * WebKit throws `SecurityError: Attempt to use history.replaceState() more
 * than 100 times per 10 seconds`. The guard installed at boot
 * (lib/historyGuard) coalesces a burst so the page never reaches that
 * number, and the newest URL still lands. The first test proves the engine
 * enforces the limit at all (through pushState, which the guard leaves
 * alone); the second proves a replaceState storm survives it.
 *
 * Needs WebKit: `npx playwright install webkit`, then
 * `E2E_WEBKIT=1 npx playwright test safari-history`. The login page is
 * enough — no API, no sign-in.
 */

test.skip(!process.env.E2E_WEBKIT, 'needs WebKit (npx playwright install webkit; E2E_WEBKIT=1)');
test.use({ ...devices['iPhone 14'] });

test('WebKit enforces the budget: an unguarded pushState storm throws', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'only WebKit throttles history writes');
  await page.goto('/login');
  const result = await page.evaluate(() => {
    try {
      for (let i = 0; i < 150; i += 1) window.history.pushState(null, '', `/login?burst=${i}`);
      return 'no error';
    } catch (err) {
      return (err as Error).name;
    }
  });
  expect(result).toBe('SecurityError');
});

test('a replaceState storm never throws, and the last URL wins', async ({ page }) => {
  // The guard's trailing write lands once the ten-second window turns.
  test.setTimeout(60_000);
  await page.goto('/login');
  await expect(page.getByLabel(/email/i)).toBeVisible();
  const result = await page.evaluate(() => {
    try {
      for (let i = 0; i < 400; i += 1) window.history.replaceState(null, '', `/login?burst=${i}`);
      return 'no error';
    } catch (err) {
      return (err as Error).name;
    }
  });
  expect(result).toBe('no error');
  // The guard holds the newest write until the window has room.
  await expect.poll(() => page.evaluate(() => window.location.search), { timeout: 25_000, intervals: [500] }).toBe('?burst=399');
});
