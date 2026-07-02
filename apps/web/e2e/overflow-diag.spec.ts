import { test, expect, type Page } from '@playwright/test';

/**
 * Horizontal-overflow guard. The shell clips page-level x-overflow (so
 * nothing can pan the page sideways), which also means scrollWidth can't
 * detect regressions — so this measures element RECTS instead: nothing
 * inside <main> may extend past the viewport unless it lives inside an
 * intentional overflow-x-auto scroller (admin grids, paystub tables).
 *
 * Runs per persona: personas see entirely different pages (the original
 * "swing" bug was admin-only while every associate page was clean), so
 * a Maria-only guard would let an admin regression ship. DIAG_USER /
 * DIAG_PASS still override for ad-hoc local runs against other accounts.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server');

const PERSONAS = [
  {
    name: 'associate',
    email: process.env.DIAG_USER ?? 'maria.lopez@example.com',
    pass: process.env.DIAG_PASS ?? 'maria-dev-2026!',
    routes: ['/', '/scheduling', '/time-attendance', '/time-off', '/payroll'],
  },
  {
    name: 'admin',
    email: 'admin@altohr.com',
    pass: 'alto-admin-dev',
    routes: [
      '/',
      '/scheduling',
      '/time-attendance',
      '/time-off',
      '/people',
      '/payroll',
      '/approvals',
    ],
  },
];

async function collectOffenders(page: Page, routes: string[]): Promise<string[]> {
  const all: string[] = [];
  for (const route of routes) {
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
    all.push(...offenders.map((o) => `[${route}] ${o}`));
  }
  return all;
}

for (const persona of PERSONAS) {
  test(`no element escapes the viewport horizontally (${persona.name})`, async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(persona.email);
    await page.getByLabel(/password/i).fill(persona.pass);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(3000);

    const offenders = await collectOffenders(page, persona.routes);
    expect(offenders, `overflow as ${persona.name}`).toEqual([]);
  });
}
