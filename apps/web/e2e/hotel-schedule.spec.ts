import { test, expect, type Page, type Request } from '@playwright/test';

/**
 * Brief 2-1b — a direct employer creates a shift from the schedule page,
 * in a real browser.
 *
 *   The tenant is a hotel: no client portal, no clients. The schedule
 *   page's "New shift" dialog must not ask for a client, must offer the
 *   tenant's properties, and must post the shift with a site and no
 *   client. The full-stack walk (hotel-journey.spec.ts) creates its shift
 *   through the API; this proves the screen itself.
 *
 *   The API is mocked at the network layer, as in kiosk-issue-return.spec.ts,
 *   so it runs with or without the full stack; every /api request is
 *   answered here and unmocked calls get a 404.
 */

const SITE = '11111111-1111-4111-8111-111111111111';
const U1 = '33333333-3333-4333-8333-333333333333';

const HOTEL_MODULES = {
  scheduling: true, time: true, hrCases: true, compliance: true, payrollSync: true,
  housingLink: false, transportation: false, programs: false, billRates: false, clientPortal: false, robotics: false, agentBuilder: false,
};

const user = {
  id: U1, email: 'hr@grandhotel.example', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};

async function mockApi(page: Page, posted: Request[]) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api/, '');
    const m = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') {
      return json({ user, tenant: { id: 't-hotel', businessModel: 'DIRECT_EMPLOYER', modules: HOTEL_MODULES, terminology: {} } });
    }
    if (p === '/admin/sites') {
      return json({ sites: [{ id: SITE, name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null }] });
    }
    if (p === '/org/shift-positions') return json({ shiftPositions: [{ id: 'p1', clientId: null, name: 'Housekeeper', sortOrder: 0, isLead: false }] });
    if (p === '/scheduling/associates') return json({ associates: [] });
    if (p === '/scheduling/shifts' && m === 'POST') {
      posted.push(req);
      return json({ id: 's1' }, 201);
    }
    if (p === '/scheduling/shifts' && m === 'GET') return json({ shifts: [], nextCursor: null });
    if (p === '/clients') return json({ clients: [], nextCursor: null });
    if (p === '/messages/unread') return json({ unread: 0 });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test('a hotel creates a shift at its property from the schedule page: no client field, a site, no client in the request', async ({ page }) => {
  const posted: Request[] = [];
  await mockApi(page, posted);
  await page.goto('/scheduling');

  await page.getByRole('button', { name: /new shift/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/new shift/i).first()).toBeVisible();

  // No client anywhere in the dialog, and the property is offered and picked.
  await expect(dialog.getByLabel(/^client/i)).toHaveCount(0);
  await expect(dialog.getByText(/no clients available/i)).toHaveCount(0);
  const location = dialog.getByLabel(/location/i).first();
  await expect(location).toHaveValue(SITE);

  await dialog.getByLabel(/position/i).first().selectOption('Housekeeper');
  await dialog.getByRole('button', { name: /save as draft/i }).click();

  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0]!.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ locationId: SITE, position: 'Housekeeper' });
  expect(body).not.toHaveProperty('clientId');
});
