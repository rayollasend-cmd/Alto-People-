import { test, expect } from '@playwright/test';

/**
 * Horizontal-overflow guard. The shell clips page-level x-overflow (so
 * nothing can pan the page sideways), which also means scrollWidth can't
 * detect regressions — so this measures element RECTS instead: nothing
 * inside <main> may extend past the viewport unless it lives inside an
 * intentional overflow-x-auto scroller (admin grids, paystub tables).
 *
 * Run per persona: DIAG_USER/DIAG_PASS override the default associate.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server');

const ROUTES = ['/', '/scheduling', '/time-attendance', '/time-off', '/payroll'];

test('no element escapes the viewport horizontally', async ({ page }) => {
  await page.goto('/login');
  const email = process.env.DIAG_USER ?? 'maria.lopez@example.com';
  const pass = process.env.DIAG_PASS ?? 'maria-dev-2026!';
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3000);

  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(2000);
    const offenders = await page.evaluate(() => {
      const main = document.getElementById('main-content');
      if (!main) return ['no #main-content'];
      const limit = main.clientWidth;
      const out: string[] = [];
      main.querySelectorAll('*').forEach((el) => {
        // Skip content inside intentional horizontal scrollers (the
        // Table primitive wraps in overflow-auto; grids use
        // overflow-x-auto).
        if (el.closest('.overflow-x-auto, .overflow-auto')) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > limit + 1 || r.left < -1)) {
          const e = el as HTMLElement;
          out.push(
            `${location.pathname} ${e.tagName.toLowerCase()}.${String(e.className).slice(0, 80)} [${Math.round(r.left)}..${Math.round(r.right)}]`,
          );
        }
      });
      return out.slice(0, 8);
    });
    expect(offenders, `overflow on ${route}`).toEqual([]);
  }
});
