import { test, expect, type Page } from '@playwright/test';

/**
 * Issuing a clock-in number ends where it started.
 *
 * The "issue a number" form hands over to the "number issued" reveal in
 * one commit: the form's Back sentinel pops and the reveal's pushes in the
 * same tick. Browsers resolve history.back() asynchronously, so the new
 * sentinel landed as a FORWARD entry — and when HR tapped Done, the
 * reveal's own cleanup pop took them off the kiosk page entirely, to
 * whatever page they had been on before ("the page jumps to an unrelated
 * page"). The overlay hook now waits for the pop to land before parking.
 *
 * The API is mocked at the network layer, so this runs with or without
 * the full stack; every /api request is answered here (a real API would
 * answer 401 for the unmocked ones and bounce the page to sign-in).
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
  id: A1, firstName: 'Ana', lastName: 'Lopez', email: 'ana@example.com', phone: null, employmentType: 'W2_EMPLOYEE', j1Status: null,
  status: 'ACTIVE', workplaceClientId: C1, workplaceClientName: 'Walmart 1234', position: 'Associate', startDate: null,
  payAmount: null, payType: null, payCurrency: null, managerId: null, managerName: null, departmentId: null, departmentName: null,
  jobProfileId: null, jobProfileTitle: null, onboardingPercent: null, applicationId: null, separatedAt: null, deactivatedAt: null,
  deactivationReason: null, createdAt: '2026-01-01T00:00:00.000Z', photoUrl: null, currentLocationId: null, currentLocationName: null,
  currentAssignmentStartedAt: null,
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const m = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user });
    if (p === '/clients') return json({ clients: [{ id: C1, name: 'Walmart 1234', status: 'ACTIVE', industry: null, createdAt: '2026-01-01T00:00:00.000Z' }], nextCursor: null });
    if (p === '/people/directory') return json({ associates: [ana], nextCursor: null });
    if (p === `/people/directory/${A1}`) return json(ana);
    if (p === '/kiosk-pins' && m === 'GET') return json({ pins: [] });
    if (p === '/kiosk-pins' && m === 'POST') return json({ id: 'p1', employeeNumber: '4821' }, 201);
    if (p === '/kiosk-pins/health') return json({ total: 0, healthy: 0, unreadable: 0, wontClockIn: 0, legacy: 0, truncated: false });
    if (p === '/kiosk-devices') return json({ devices: [] });
    if (p === '/kiosk-punches') return json({ punches: [] });
    if (p === `/clients/${C1}/locations`) return json({ locations: [] });
    if (p === '/messages/unread') return json({ unread: 0 });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

const here = (page: Page) => page.evaluate(() => `${location.pathname}${location.search}`);

async function issueAndReveal(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^issue$/i }).click();
  await expect(page.getByText('Employee number issued')).toBeVisible();
  await expect(page.getByText('4821')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test('issuing from the Pins tab: Done keeps you on the kiosk page, and Back leaves it once', async ({ page }) => {
  // The page HR was on before — a real history entry under the kiosk page.
  await page.goto('/me');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.goto('/time-attendance/kiosk?tab=pins');
  // The tab opens on every client; issuing wants one picked.
  await page.getByRole('combobox', { name: /filter by client/i }).selectOption(C1);
  await page.getByRole('button', { name: /issue employee number/i }).first().click();
  await issueAndReveal(page);
  await page.getByRole('button', { name: /^done$/i }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Give any stray history pop time to land before judging.
  await page.waitForTimeout(800);
  expect(await here(page)).toBe('/time-attendance/kiosk?tab=pins');

  await page.goBack();
  await expect.poll(() => here(page)).toBe('/me');
});

test('issuing from a People profile: "Back to People" lands on that profile, and Back from there is the kiosk again', async ({ page }) => {
  await page.goto('/me');
  await expect(page.locator('h1').first()).toBeVisible();
  const returnTo = `/people?associateId=${A1}`;
  await page.goto(`/time-attendance/kiosk?tab=pins&issue=${A1}&client=${C1}&return=${encodeURIComponent(returnTo)}`);
  // The deep link is consumed: the drawer is open and the URL is clean.
  await expect(page.getByRole('dialog').getByRole('button', { name: /^issue$/i })).toBeVisible();
  await expect.poll(() => here(page)).toBe('/time-attendance/kiosk?tab=pins');
  await issueAndReveal(page);

  await page.getByRole('button', { name: /back to people/i }).click();
  // The profile opens (the People page resolves the id and drops the param).
  await expect(page.getByRole('dialog').getByText('Ana Lopez').first()).toBeVisible();
  await expect.poll(() => here(page)).toBe('/people');

  // Back closes the profile; Back again is the kiosk page, not the void.
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => here(page)).toBe('/time-attendance/kiosk?tab=pins');
});

test('a profile deep link finds someone the loaded list does not have', async ({ page }) => {
  // The list answers with nobody; only the lookup knows her.
  await page.route('**/api/people/directory', (route) => route.fulfill({ json: { associates: [], nextCursor: null } }));
  await page.goto(`/people?associateId=${A1}`);
  await expect(page.getByRole('dialog').getByText('Ana Lopez').first()).toBeVisible();
  await expect.poll(() => here(page)).toBe('/people');
});
