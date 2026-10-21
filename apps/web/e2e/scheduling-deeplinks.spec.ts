import { test, expect, type Page } from '@playwright/test';

/**
 * The schedule's link contract, in a real browser (the API mocked at the
 * network layer, as in hotel-schedule.spec.ts):
 *
 *   /scheduling?shift=<id>                    → that shift opens (read by id,
 *                                               even far outside the week on
 *                                               screen) and the week moves to it
 *   /scheduling?open=1&view=day&date=<ymd>    → that day, open shifts only,
 *                                               with a chip that says so
 */

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const SITE = '11111111-1111-4111-8111-111111111111';
const U1 = '33333333-3333-4333-8333-333333333333';
const FAR = '44444444-4444-4444-8444-444444444444';
const OPEN = '55555555-5555-4555-8555-555555555555';
const TAKEN = '66666666-6666-4666-8666-666666666666';

const MODULES = { scheduling: true, time: true, hrCases: true, compliance: true, payrollSync: true, housingLink: false, transportation: false, programs: false, billRates: false, clientPortal: false, robotics: false, agentBuilder: false };
const user = {
  id: U1, email: 'hr@grandhotel.example', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};

const shift = (id: string, startsAt: string, status: string, position: string, assigned: string | null = null) => ({
  id, clientId: null, clientName: null, position, startsAt, endsAt: new Date(new Date(startsAt).getTime() + 8 * 3_600_000).toISOString(),
  location: null, locationId: SITE, locationName: 'The Grand Hotel', timezone: 'America/Chicago', hourlyRate: null, payRate: null, effectivePayRate: null,
  status, notes: null, assignedAssociateId: assigned ? U1 : null, assignedAssociateName: assigned, assignedAt: null, cancellationReason: null,
  scheduledMinutes: 480, publishedAt: new Date().toISOString(), lateNoticeReason: null, acknowledgedAt: null, confirmationAsk: null,
});

async function mockApi(page: Page, shiftsFor: (url: URL) => unknown[]) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user, tenant: { id: 't-hotel', businessModel: 'DIRECT_EMPLOYER', modules: MODULES, terminology: {} } });
    if (p === '/admin/sites') return json({ sites: [{ id: SITE, name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null }] });
    if (p === '/scheduling/associates') return json({ associates: [{ id: U1, firstName: 'Hana', lastName: 'Ruiz', email: 'hana@grandhotel.example' }] });
    if (p === '/scheduling/shifts' && req.method() === 'GET') return json({ shifts: shiftsFor(url), truncated: false });
    if (p.startsWith('/scheduling/shifts/') && p.endsWith('/conflicts')) return json({ conflicts: [] });
    if (p === '/clients') return json({ clients: [], nextCursor: null });
    if (p === '/messages/unread') return json({ unread: 0 });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test('?shift=<id> opens a shift months away and moves the week to it', async ({ page }) => {
  const when = new Date(Date.UTC(2027, 1, 17, 15, 0)).toISOString(); // Wed Feb 17 2027
  const byId: string[] = [];
  await mockApi(page, (url) => {
    if (url.searchParams.get('id')) {
      byId.push(url.searchParams.get('id')!);
      return [shift(FAR, when, 'OPEN', 'Night audit')];
    }
    return [];
  });
  await page.goto(`/scheduling?shift=${FAR}&view=week`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/night audit/i).first()).toBeVisible();
  expect(byId).toEqual([FAR]);
  await expect(page).not.toHaveURL(/shift=/);
  await page.keyboard.press('Escape');
  // The week on screen is the shift's: the workweek holding Wed Feb 17 2027
  // (this tenant's week starts Saturday, the same as the This week button).
  await expect(page.getByLabel('Week start date')).toHaveValue('2027-02-13');
});

test('?open=1&view=day&date= shows that day’s open shifts only, and the chip drops the lens', async ({ page }) => {
  const day = '2027-03-10';
  await mockApi(page, () => [
    shift(OPEN, new Date(Date.UTC(2027, 2, 10, 14, 0)).toISOString(), 'OPEN', 'Bell desk'),
    shift(TAKEN, new Date(Date.UTC(2027, 2, 10, 15, 0)).toISOString(), 'ASSIGNED', 'Front desk', 'Hana Ruiz'),
  ]);
  await page.goto(`/scheduling?open=1&view=day&date=${day}`);
  await expect(page.getByText(/showing open shifts only on/i)).toBeVisible();
  await expect(page.getByLabel('Jump to a specific day')).toHaveValue(day);
  // The tiles (buttons — the position filter's <option>s carry every loaded
  // shift's name): the open one shows, the assigned one doesn't.
  await expect(page.getByRole('button', { name: /bell desk/i }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /front desk/i })).toHaveCount(0);
  await page.getByRole('button', { name: /show every shift/i }).click();
  await expect(page.getByRole('button', { name: /front desk/i }).first()).toBeVisible();
});

test('schedule keys: → next day, t today, n new shift', async ({ page }) => {
  await mockApi(page, () => []);
  await page.goto('/scheduling?view=day&date=2027-03-10');
  const dayInput = page.getByLabel('Jump to a specific day');
  await expect(dayInput).toHaveValue('2027-03-10');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(dayInput).toHaveValue('2027-03-11');
  await page.keyboard.press('t');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await expect(dayInput).toHaveValue(today);
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog').getByText(/new shift/i).first()).toBeVisible();
});
