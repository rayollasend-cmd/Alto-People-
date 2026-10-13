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
  listOrgUnitSites: vi.fn(),
  listSites: vi.fn(),
  setOrgUnitSites: vi.fn(),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { createOrgUnit, listOrgUnitSites, listOrgUnits, listSites, type OrgUnitRow } from '@/lib/orgApi';
import { OrgUnitsAdmin } from '@/pages/admin/OrgUnitsAdmin';

const units: OrgUnitRow[] = [
  { id: 'd1', type: 'DIVISION', parentId: null, name: 'Hotels', code: 'HOT', glCode: '5000', path: '/d1', clientId: null, isActive: true, sites: 3, legacyRegionId: null, legacyCostCenterId: null },
  { id: 'r1', type: 'REGION', parentId: 'd1', name: 'Southeast', code: 'SE', glCode: null, path: '/d1/r1', clientId: null, isActive: true, sites: 2, legacyRegionId: 'legacy-r', legacyCostCenterId: null },
  { id: 'c1', type: 'COST_CENTER', parentId: 'r1', name: 'Housekeeping', code: 'HK', glCode: '5110', path: '/d1/r1/c1', clientId: null, isActive: true, sites: 0, legacyRegionId: null, legacyCostCenterId: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listOrgUnits).mockResolvedValue({ units });
  vi.mocked(createOrgUnit).mockResolvedValue({ unit: { ...units[0]!, id: 'd2', name: 'Resorts' } });
  vi.mocked(listOrgUnitSites).mockResolvedValue({ sites: [{ id: 's1', name: 'Harbor House', clientId: null, clientName: null, orgUnitId: 'r1' }] });
  vi.mocked(listSites).mockResolvedValue({ sites: [] });
});

describe('Organizational tree', () => {
  it('renders the tree with each type, its codes and the sites count', async () => {
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    expect(await screen.findByText('Hotels')).toBeInTheDocument();
    expect(screen.getByText('Southeast')).toBeInTheDocument();
    expect(screen.getByText('Housekeeping')).toBeInTheDocument();
    expect(screen.getByText('Division')).toBeInTheDocument();
    expect(screen.getByText('Region')).toBeInTheDocument();
    expect(screen.getByText('Cost center')).toBeInTheDocument();
    expect(screen.getByText('5110')).toBeInTheDocument();
    // The region mirror is managed from its own page and cannot be removed here.
    expect(screen.getByText(/mirrors a region/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Southeast' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Housekeeping' })).toBeInTheDocument();
  });

  it('adds a division at the top of the tree', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    await screen.findByText('Hotels');
    await user.click(screen.getByRole('button', { name: 'New unit' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Resorts');
    await user.type(within(dialog).getByLabelText('GL code'), '5200');
    await user.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    await waitFor(() => expect(createOrgUnit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createOrgUnit).mock.calls[0]![0]).toEqual({ type: 'DIVISION', name: 'Resorts', parentId: null, code: null, glCode: '5200' });
  });

  it('adds a child under a unit with the parent preselected', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    await screen.findByText('Hotels');
    const hotelsRow = screen.getByText('Hotels').closest('tr')!;
    await user.click(within(hotelsRow).getByRole('button', { name: 'Add child' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('New unit under Hotels')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), 'Northeast');
    await user.click(within(dialog).getByRole('button', { name: 'Add unit' }));
    await waitFor(() => expect(createOrgUnit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createOrgUnit).mock.calls[0]![0]).toMatchObject({ type: 'REGION', name: 'Northeast', parentId: 'd1' });
  });

  it('opens the sites under a unit', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgUnitsAdmin />, '/admin/org-units');
    await screen.findByText('Hotels');
    const regionRow = screen.getByText('Southeast').closest('tr')!;
    await user.click(within(regionRow).getByRole('button', { name: '2' }));
    expect(await screen.findByText('Harbor House')).toBeInTheDocument();
    expect(listOrgUnitSites).toHaveBeenCalledWith('r1');
  });
});
