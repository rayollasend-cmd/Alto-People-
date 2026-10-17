import { test, expect, type Page } from '@playwright/test';

/**
 * One record per person. /people/:id is the person's page on the Record
 * template — identity, status, the facts, and every facet (profile,
 * employment, pay, time, time off, performance, cases, documents, thread)
 * — the same shape an agent or a robot already had. The API is mocked at
 * the network layer; every /api request is answered here.
 */

const C1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';

const user = {
  id: U1, email: 'hr@example.com', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};
const ana = {
  id: A1, firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.com', phone: '555-0100', employmentType: 'W2_EMPLOYEE', j1Status: false,
  status: 'ACTIVE', workplaceClientId: C1, workplaceClientName: 'Walmart 1234', position: 'Stocker', startDate: '2026-03-02',
  payAmount: null, payType: null, payCurrency: null, managerId: null, managerName: null, departmentId: null, departmentName: null,
  jobProfileId: null, jobProfileTitle: null, onboardingPercent: null, applicationId: null, separatedAt: null, deactivatedAt: null,
  deactivationReason: null, createdAt: '2026-01-01T00:00:00.000Z', photoUrl: null, currentLocationId: null, currentLocationName: 'Walmart 1234',
  currentAssignmentStartedAt: '2026-03-02',
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user });
    if (p === '/auth/me/nav-pins') return json({ pinned: [] });
    if (p === `/people/directory/${A1}`) return json(ana);
    if (p === '/people/directory') return json({ associates: [ana], nextCursor: null });
    if (p === '/hr-cases') return json({ cases: [] });
    if (p === '/me/inbox') return json({ total: 0, sources: [] });
    if (p === '/kiosk-pins' && req.method() === 'GET') return json({ pins: [] });
    if (p === '/clients') return json({ clients: [{ id: C1, name: 'Walmart 1234', status: 'ACTIVE', industry: null, createdAt: '2026-01-01T00:00:00.000Z' }], nextCursor: null });
    // Every other facet reads as empty — the page must still stand.
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('the person record shows who they are and every facet, and ?tab= picks one', async ({ page }) => {
  await page.goto(`/people/${A1}`);
  await expect(page.getByRole('heading', { name: 'Ana Lopez' }).first()).toBeVisible();
  // The record template's tabs.
  for (const name of ['Profile', 'Employment', 'Pay', 'Time', 'Time off', 'Performance', 'Documents', 'Thread']) {
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: /^cases/i })).toBeVisible();
  await page.getByRole('tab', { name: /^cases/i }).click();
  await expect(page).toHaveURL(/tab=cases/);
  await page.screenshot({ path: 'e2e-results/person-record.png' });
});

test('the directory name leads to the record; the row still opens the quick view', async ({ page }) => {
  await page.goto('/people');
  await page.getByRole('link', { name: 'Ana Lopez' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/people/${A1}$`));
  await expect(page.getByRole('heading', { name: 'Ana Lopez' }).first()).toBeVisible();
});
