import { test, expect, type Page } from '@playwright/test';

/**
 * The sidebar is a dozen rows, not a hundred.
 *
 * An HR administrator holds every capability. Before the doors, that was an
 * 88-row sidebar with 37 rows under one heading; the design walk found it
 * open on every admin screenshot. Now it is the always-on rows, then one
 * row per door, which opens to the pages behind it. This holds the shape
 * in the real shell, with the API mocked at the network layer (every /api
 * request is answered here; a real API would 401 and bounce to sign-in).
 */

const U1 = '33333333-3333-4333-8333-333333333333';
const user = {
  id: U1, email: 'hr@example.com', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user });
    if (p === '/auth/me/nav-pins') return json({ pinned: [] });
    if (p === '/me/inbox') {
      return json({
        total: 7,
        sources: [
          { key: 'approvals', label: 'Approvals', description: '', count: 4, path: '/approvals' },
          { key: 'kiosk-review', label: 'Clock-in review', description: '', count: 3, path: '/time-attendance/kiosk?tab=review' },
        ],
      });
    }
    if (p === '/hugo') return json({ name: 'Hugo', audience: 'admin', intro: '', can: [] });
    if (p === '/messages/unread') return json({ unread: 0 });
    if (p === '/clients') return json({ clients: [], nextCursor: null });
    if (p === '/people/directory') return json({ associates: [], nextCursor: null });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A fresh person: no door opened or closed yet.
  await page.addInitScript(() => {
    window.localStorage.removeItem('alto.sidebar.openDoors');
    window.localStorage.setItem('alto.sidebar.collapsed', '0');
  });
});

test('an HR administrator sees a short rail of doors, and a door opens to its pages', async ({ page }) => {
  await page.goto('/people');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav).toBeVisible();

  // The always-on rows, with the inbox count.
  await expect(nav.getByRole('link', { name: /^home$/i })).toBeVisible();
  const inbox = nav.getByRole('link', { name: /^inbox/i });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByLabel('7 pending')).toBeVisible();

  // Top-level rows: links not inside an open door, plus the door rows.
  const topRows = nav.locator('> a, > div > a, > div > div > div > a');
  const count = await topRows.count();
  expect(count, 'top-level rows').toBeLessThanOrEqual(20);

  // The door holding the current page (People) is open; its pages show.
  await expect(nav.getByRole('button', { name: /hide people pages/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^reporting chart$/i })).toBeVisible();

  // Another door is closed, carries its waiting count, and opens on the chevron.
  const timeToggle = nav.getByRole('button', { name: /show time & scheduling pages/i });
  await expect(timeToggle).toBeVisible();
  await expect(nav.getByRole('link', { name: /^time & scheduling/i }).getByLabel('7 pending')).toBeVisible();
  await timeToggle.click();
  await expect(nav.getByRole('link', { name: /^kiosk/i })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^approvals/i }).getByLabel('4 pending')).toBeVisible();

  // Settings & trust is one door, whose row opens the overview.
  await nav.getByRole('link', { name: /^settings & trust$/i }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: /settings & trust/i }).first()).toBeVisible();

  await page.screenshot({ path: 'e2e-results/nav-shape-hr.png', fullPage: false });
});

test('the icon rail keeps every door reachable as a menu', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('alto.sidebar.collapsed', '1'));
  await page.goto('/people');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const door = nav.getByRole('button', { name: /^time & scheduling$/i });
  await expect(door).toBeVisible();
  await door.click();
  await expect(page.getByRole('menuitem', { name: /^kiosk/i })).toBeVisible();
});
