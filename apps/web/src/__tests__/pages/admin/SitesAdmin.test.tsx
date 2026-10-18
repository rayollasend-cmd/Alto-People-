import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultTenantProfile } from '@alto-people/shared';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listSites: vi.fn(),
  createSite: vi.fn(),
  updateSite: vi.fn(),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { createSite, listSites, updateSite, type SiteRow } from '@/lib/orgApi';
import { SitesAdmin } from '@/pages/admin/SitesAdmin';

const sites: SiteRow[] = [
  { id: 's1', name: 'Harbor House', type: 'PROPERTY', timezone: 'America/New_York', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: 'c1', orgUnitName: 'Housekeeping', orgUnitType: 'COST_CENTER', regionId: 'r-se', regionName: 'Southeast' },
  { id: 's2', name: 'Downtown Office', type: 'OFFICE', timezone: 'America/Chicago', state: 'TX', isActive: false, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null, regionId: null, regionName: null },
  { id: 's3', name: 'Front Beach 218', type: 'STORE', timezone: 'America/Chicago', state: 'FL', isActive: true, clientId: 'cl1', clientName: 'Coastal Resorts', orgUnitId: 'r1', orgUnitName: 'Panhandle', orgUnitType: 'REGION', regionId: 'r-ph', regionName: 'Panhandle' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSites).mockResolvedValue({ sites });
  vi.mocked(createSite).mockResolvedValue({ site: { ...sites[0]!, id: 's4', name: 'Lakeside Lodge' } });
});

describe('Sites', () => {
  it('lists every place with its region, client and cost center — a region pin is not a cost center', async () => {
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    expect((await screen.findAllByText('Harbor House')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Southeast').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Housekeeping').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Coastal Resorts').length).toBeGreaterThan(0);
    // Front Beach is pinned to its region's own unit: no cost center to show.
    expect(screen.queryByText(/Panhandle · Region/)).toBeNull();
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0);
  });

  it('filters to one region, or to places in no region', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findAllByText('Harbor House');
    await user.selectOptions(screen.getByLabelText('Region'), 'r-ph');
    await waitFor(() => expect(screen.queryAllByText('Harbor House')).toHaveLength(0));
    expect(screen.getAllByText('Front Beach 218').length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText('Region'), 'none');
    await waitFor(() => expect(screen.getAllByText('Downtown Office').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Front Beach 218')).toHaveLength(0);
  });

  it('adds a place with its time zone and state; a staffing tenant defaults to a store', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findAllByText('Harbor House');
    await user.click(screen.getByRole('button', { name: /^Add / }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Type')).toHaveValue('STORE');
    await user.type(within(dialog).getByLabelText('Name'), 'Lakeside Lodge');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'WAREHOUSE');
    await user.selectOptions(within(dialog).getByLabelText('Time zone'), 'America/Denver');
    await user.type(within(dialog).getByLabelText('State'), 'co');
    await user.click(within(dialog).getByRole('button', { name: /^Add / }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createSite).mock.calls[0]![0]).toEqual({
      name: 'Lakeside Lodge',
      type: 'WAREHOUSE',
      timezone: 'America/Denver',
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: 'CO',
      zip: null,
    });
  });

  it('a direct employer’s new place defaults to a property', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites', { id: 'hotel', ...defaultTenantProfile('DIRECT_EMPLOYER') });
    await screen.findAllByText('Harbor House');
    await user.click(screen.getByRole('button', { name: /^Add / }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Type')).toHaveValue('PROPERTY');
  });

  it('edits a place of your own: prefilled, only what changed is sent, placement points to the Org chart', async () => {
    vi.mocked(updateSite).mockResolvedValue({ site: { ...sites[0]!, name: 'Harbor House East', type: 'OFFICE', isActive: false } });
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findAllByText('Harbor House');
    await user.click(screen.getByRole('row', { name: 'Edit Harbor House' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Harbor House');
    expect(within(dialog).getByText(/In Southeast · costed to Housekeeping/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Change in the Org chart' })).toHaveAttribute('href', '/org/chart?view=field');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Harbor House East');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'OFFICE');
    await user.click(within(dialog).getByLabelText('Status'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateSite).mock.calls[0]).toEqual(['s1', { name: 'Harbor House East', type: 'OFFICE', isActive: false }]);
  });

  it('a client’s store opens read-only, with the way to edit it on the client', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findAllByText('Front Beach 218');
    await user.click(screen.getByRole('row', { name: 'Edit Front Beach 218' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Name')).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Edit in Coastal Resorts' })).toHaveAttribute('href', '/clients/cl1');
    expect(updateSite).not.toHaveBeenCalled();
  });
});
