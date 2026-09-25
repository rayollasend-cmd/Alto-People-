import { test, expect, devices } from '@playwright/test';
import { PERSONAS, signIn } from './personas';

/**
 * A DataGrid past its virtualization threshold must still be a table.
 *
 * The first virtualized layout made the <tbody> `display:block` with
 * absolutely positioned rows; Chromium wraps a block tbody in an anonymous
 * cell in column 1, so Users & access rendered its whole body 32px wide with
 * every row overlapping the next. jsdom has no layout, so this is measured in
 * a real browser: the body is as wide as the table, rows do not overlap, the
 * header keeps its labels, and scrolling the box brings later rows in.
 *
 * Needs the full stack for sign-in; the list itself is mocked at 200 rows so
 * the assertion does not depend on how many users the seed creates.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server (set E2E_FULLSTACK=1)');
test.use({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } });

const ROWS = 200;
const admin = PERSONAS.find((p) => p.name === 'admin')!;

function users() {
  return Array.from({ length: ROWS }, (_, i) => ({
    id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    email: `grid.probe.${i}@example.com`,
    role: i % 4 === 0 ? 'SHIFT_SUPERVISOR' : 'ASSOCIATE',
    status: 'ACTIVE',
    createdAt: new Date(Date.UTC(2026, 8, 1 + (i % 20))).toISOString(),
    associateId: null,
    associateName: `Grid Probe ${i}`,
    clientId: null,
    clientName: null,
    locationId: null,
    locationName: null,
    regionId: null,
    regionName: null,
    lockedUntil: null,
  }));
}

test('a grid past the virtualization threshold keeps ordinary table layout', async ({ page }) => {
  await page.route('**/api/admin/users/counts', (route) =>
    route.fulfill({ json: { counts: { ACTIVE: ROWS, INVITED: 0, DISABLED: 0 }, total: ROWS } }),
  );
  await page.route(/\/api\/admin\/users(\?.*)?$/, (route) =>
    route.fulfill({ json: { users: users(), total: ROWS } }),
  );
  await signIn(page, admin);
  await page.goto('/admin/users');

  const rows = page.locator('table tbody tr[data-index]');
  await expect(rows.first()).toBeVisible();

  const layout = await page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const table = document.querySelector('table')!;
    const tbody = table.querySelector('tbody')!;
    const trs = [...tbody.querySelectorAll('tr[data-index]')];
    let overlaps = 0;
    for (let i = 1; i < trs.length; i++) {
      if (rect(trs[i]!).top < rect(trs[i - 1]!).bottom - 1) overlaps++;
    }
    return {
      rendered: trs.length,
      overlaps,
      tableWidth: Math.round(rect(table).width),
      bodyWidth: Math.round(rect(tbody).width),
      headers: [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? ''),
    };
  });

  // Virtualized: a window of rows, not all 200 — and every one a real table row.
  expect(layout.rendered).toBeGreaterThan(0);
  expect(layout.rendered).toBeLessThan(ROWS);
  expect(layout.overlaps).toBe(0);
  expect(Math.abs(layout.bodyWidth - layout.tableWidth)).toBeLessThanOrEqual(2);
  expect(layout.headers).toEqual(expect.arrayContaining(['User', 'Role', 'Status']));

  // Scrolling the grid's own box brings rows from deep in the list.
  await page.locator('table').evaluate((table) => {
    const box = table.closest('.overflow-auto') as HTMLElement | null;
    if (box) box.scrollTop = 6000;
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('table tbody tr[data-index]')].some(
      (tr) => Number((tr as HTMLElement).dataset.index) >= 100,
    ),
  );
});
