import { test, expect, type Page, type Request } from '@playwright/test';
import { defaultTenantProfile } from '@alto-people/shared';

/**
 * Brief 2-1b — a direct employer invites a hire from the onboarding screen,
 * in a real browser.
 *
 *   The tenant is a hotel: no client portal, no clients. The "New
 *   application" dialog must not ask for a client, must offer the tenant's
 *   properties, and must post the invite with a site and no client; the
 *   dialog's words are the hotel's. The full-stack walk
 *   (hotel-journey.spec.ts) invites through the API; this proves the screen.
 *
 *   The API is mocked at the network layer, as in hotel-schedule.spec.ts, so
 *   it runs with or without the full stack; unmocked calls get a 404.
 */

const SITE = '11111111-1111-4111-8111-111111111111';
const TEMPLATE = '55555555-5555-4555-8555-555555555555';
const U1 = '33333333-3333-4333-8333-333333333333';

/** The hotel's real defaults: its modules and its full terminology table, as /auth/me sends them. */
const HOTEL = defaultTenantProfile('DIRECT_EMPLOYER');

const user = {
  id: U1, email: 'hr@grandhotel.example', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};

/** The hotel's rule: none of these words, singular or plural, whole words, "Alto People" exempt. */
const FORBIDDEN = /\b(clients?|bill\s+rates?|housing|vans?|stores?|associates?|alto)\b/i;

async function mockApi(page: Page, posted: Request[]) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const m = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') {
      return json({ user, tenant: { id: 't-hotel', ...HOTEL } });
    }
    if (p === '/onboarding/applications' && m === 'POST') {
      posted.push(req);
      return json({ id: '66666666-6666-4666-8666-666666666666', invitedUserId: '77777777-7777-4777-8777-777777777777', inviteUrl: null, emailDueAt: null }, 201);
    }
    if (p === '/onboarding/applications') return json({ applications: [], total: 0, page: 1, pageSize: 50 });
    if (p === '/onboarding/applications/stats') {
      return json({ total: 0, byStatus: {}, inFlight: 0, stale: 0, bounced: 0, avgPercent: 0, staleSamples: [], bouncedSamples: [] });
    }
    if (p === '/onboarding/templates') {
      return json({ templates: [{ id: TEMPLATE, clientId: null, name: 'Hotel standard', track: 'STANDARD', tasks: [] }] });
    }
    if (p === '/admin/sites') {
      return json({ sites: [{ id: SITE, name: 'The Grand Hotel', type: 'PROPERTY', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null }] });
    }
    if (p === '/org/shift-positions') return json({ shiftPositions: [{ id: 'p1', clientId: null, name: 'Housekeeper', sortOrder: 0, isLead: false }] });
    if (p === '/messages/unread') return json({ unread: 0 });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test('a hotel invites a hire at its property from the onboarding screen: no client, a site, the hotel\'s words', async ({ page }) => {
  const posted: Request[] = [];
  await mockApi(page, posted);
  await page.goto('/onboarding');

  await page.getByRole('button', { name: /new application/i }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/new onboarding application/i)).toBeVisible();

  // No client anywhere, and the property is offered and picked (the only one).
  await expect(dialog.getByLabel(/^client/i)).toHaveCount(0);
  const site = dialog.getByLabel(/^property/i).first();
  await expect(site).toHaveValue(SITE);

  await dialog.getByLabel(/first name/i).fill('Tess');
  await dialog.getByLabel(/last name/i).fill('Member');
  await dialog.getByLabel(/^email/i).fill('tess.member@example.com');
  await dialog.getByLabel(/onboarding template/i).selectOption(TEMPLATE);

  // The dialog speaks the hotel's words before anything is sent.
  const text = (await dialog.innerText()).replace(/Alto People/g, ' ');
  expect(text, 'a forbidden word in the invite dialog').not.toMatch(FORBIDDEN);

  await dialog.getByRole('button', { name: /^create & invite$/i }).click();

  await expect.poll(() => posted.length).toBe(1);
  const body = posted[0]!.postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({
    associateFirstName: 'Tess',
    associateLastName: 'Member',
    associateEmail: 'tess.member@example.com',
    templateId: TEMPLATE,
    locationId: SITE,
  });
  expect(body).not.toHaveProperty('clientId');
});
