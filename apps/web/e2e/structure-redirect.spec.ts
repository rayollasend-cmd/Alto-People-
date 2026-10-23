import { test, expect, type Page } from '@playwright/test';

/**
 * Regions are arranged in the Org chart's field view now; an old link to
 * the retired Regions page lands there. The API is mocked at the network layer.
 */

const user = {
  id: '33333333-3333-4333-8333-333333333333', email: 'hr@example.com', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};
const NODE = { subtitle: null, role: null, shiftLabels: null, photoUrl: null, associateId: null, userId: null, departmentId: null, departmentName: null, clientId: null, clientName: null, siteName: null, reports: 0, shiftsToday: null, filledToday: null, positionStatus: null, former: false };

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user });
    if (p === '/auth/me/nav-pins') return json({ pinned: [] });
    if (p === '/me/inbox') return json({ total: 0, sources: [] });
    if (p === '/org/chart') return json({ view: 'field', fieldOnly: 0, unplaced: 0, truncated: false, limit: 5000, nodes: [{ ...NODE, id: 'r:1', parentId: null, kind: 'region', name: 'Panhandle' }] });
    if (p === '/org/structure/options') return json({ regions: [{ id: '1', name: 'Panhandle' }], costCenters: [], clients: [], businessModel: 'WORKFORCE_PROVIDER' });
    if (p === '/clients' || p === '/scheduling/clients') return json({ clients: [], nextCursor: null });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test('an old link to Regions lands on the Org chart’s field view, where regions are edited', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/admin/regions');
  await expect(page).toHaveURL(/\/org\/chart\?view=field/);
  await expect(page.getByRole('heading', { name: 'Org chart', level: 1 })).toBeVisible();
  // Regions are added from the chart's header (F500: actions name what they do).
  await expect(page.getByRole('button', { name: 'Add region', exact: true })).toBeVisible();
  await expect(page.getByTestId('org-canvas').getByText('Panhandle')).toBeVisible();
});
