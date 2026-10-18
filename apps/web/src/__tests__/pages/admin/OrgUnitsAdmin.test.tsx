import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listOrgUnits: vi.fn(),
  createOrgUnit: vi.fn(),
  updateOrgUnit: vi.fn(),
  deleteOrgUnit: vi.fn(),
  listSites: vi.fn(),
}));
vi.mock('@/lib/structureApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/structureApi')>()),
  placeSite: vi.fn(),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { createOrgUnit, listOrgUnits, listSites, type OrgUnitRow, type SiteRow } from '@/lib/orgApi';
import { placeSite } from '@/lib/structureApi';
import { OrgUnitsAdmin } from '@/pages/admin/OrgUnitsAdmin';

const units: OrgUnitRow[] = [
  { id: 'd1', type: 'DIVISION', parentId: null, name: 'Hotels', code: 'HOT', glCode: '5000', path: '/d1', clientId: null, isActive: true, sites: 3, legacyRegionId: null, legacyCostCenterId: null },
  { id: 'r1', type: 'REGION', parentId: 'd1', name: 'Southeast', code: 'SE', glCode: null, path: '/d1/r1', clientId: null, isActive: true, sites: 2, legacyRegionId: 'legacy-r', legacyCostCenterId: null },
  { id: 'c1', type: 'COST_CENTER', parentId: 'r1', name: 'Housekeeping', code: 'HK', glCode: '5110', path: '/d1/r1/c1', clientId: null, isActive: true, sites: 1, legacyRegionId: null, legacyCostCenterId: null },
];

const site = (o: Partial<SiteRow>): SiteRow => ({
  id: 's',
  name: 'Site',
  type: 'STORE',
  timezone: 'America/New_York',
  state: 'FL',
  isActive: true,
  clientId: null,
  clientName: null,
  orgUnitId: null,
  orgUnitName: null,
  orgUnitType: null,
  regionId: null,
  regionName: null,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOrgUnits).mockResolvedValue({ units });
  vi.mocked(createOrgUnit).mockResolvedValue({ unit: { ...units[2]!, id: 'c2', name: 'Laundry' } });
  vi.mocked(placeSite).mockResolvedValue({ regionId: 'legacy-r', orgUnitId: 'c1', costCenterCleared: false } as never);
  vi.mocked(listSites).mockResolvedValue({
    sites: [
      site({ id: 's1', name: 'Harbor House', regionId: 'legacy-r', regionName: 'Southeast', orgUnitId: 'c1', orgUnitName: 'Housekeeping', orgUnitType: 'COST_CENTER' }),
      site({ id: 's2', name: 'Bay Inn', regionId: 'legacy-r', regionName: 'Southeast', orgUnitId: 'r1', orgUnitName: 'Southeast', orgUnitType: 'REGION' }),
      site({ id: 's3', name: 'Elsewhere Lodge', regionId: 'other', regionName: 'West' }),
    ],
  });
});

describe('Cost centers & ledger codes', () => {
  it('lists the ledger units (not regions) with where they sit, their GL codes and stores, and points to the Org chart', async () => {
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    expect(await screen.findByRole('heading', { name: 'Cost centers & ledger codes' })).toBeInTheDocument();
    expect((await screen.findAllByText('Housekeeping')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hotels').length).toBeGreaterThan(0);
    // Regions are arranged in the Org chart, not listed as ledger units.
    expect(screen.queryByRole('row', { name: /Edit Southeast/ })).toBeNull();
    expect(screen.getAllByText('Under Southeast').length).toBeGreaterThan(0);
    expect(screen.getAllByText('5110').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Org chart/ })).toHaveAttribute('href', '/org/chart?view=field');
  });

  it('adds a cost center under a region', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    await screen.findByRole('heading', { name: 'Cost centers & ledger codes' });
    await user.click(screen.getByRole('button', { name: /New cost center/ }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Laundry');
    await user.selectOptions(within(dialog).getByLabelText('Sits under'), 'r1');
    await user.type(within(dialog).getByLabelText(/GL code/), '5120');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createOrgUnit).toHaveBeenCalledWith({ type: 'COST_CENTER', name: 'Laundry', parentId: 'r1', code: null, glCode: '5120' }));
  });

  it('maps stores through the placement rule — only stores in its region can be ticked', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    await user.click((await screen.findAllByRole('button', { name: /1 stores mapped to Housekeeping/i }))[0]!);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Harbor House')).toBeInTheDocument();
    expect(within(drawer).getByText('Bay Inn')).toBeInTheDocument();
    // In another region: not offered.
    expect(within(drawer).queryByText('Elsewhere Lodge')).toBeNull();
    await user.click(within(drawer).getByRole('checkbox', { name: /Bay Inn/ }));
    await user.click(within(drawer).getByRole('checkbox', { name: /Harbor House/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(placeSite).toHaveBeenCalledTimes(2));
    expect(vi.mocked(placeSite).mock.calls).toEqual([
      ['s2', { orgUnitId: 'c1' }],
      ['s1', { orgUnitId: null }],
    ]);
  });
});
