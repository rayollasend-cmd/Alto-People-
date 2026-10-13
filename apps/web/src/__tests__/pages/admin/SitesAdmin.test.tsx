import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin } from './orgAdminHarness';

vi.mock('@/lib/orgApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/orgApi')>()),
  listSites: vi.fn(),
  createSite: vi.fn(),
  updateSite: vi.fn(),
  listOrgUnits: vi.fn(),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));

import { createSite, listOrgUnits, listSites, updateSite, type SiteRow } from '@/lib/orgApi';
import { SitesAdmin } from '@/pages/admin/SitesAdmin';

const sites: SiteRow[] = [
  { id: 's1', name: 'Harbor House', type: 'PROPERTY', timezone: 'America/New_York', state: 'FL', isActive: true, clientId: null, clientName: null, orgUnitId: 'r1', orgUnitName: 'Southeast', orgUnitType: 'REGION' },
  { id: 's2', name: 'Downtown Office', type: 'OFFICE', timezone: 'America/Chicago', state: 'TX', isActive: false, clientId: null, clientName: null, orgUnitId: null, orgUnitName: null, orgUnitType: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listSites).mockResolvedValue({ sites });
  vi.mocked(listOrgUnits).mockResolvedValue({
    units: [{ id: 'r1', type: 'REGION', parentId: null, name: 'Southeast', code: null, glCode: null, path: '/r1', clientId: null, isActive: true, sites: 1, legacyRegionId: null, legacyCostCenterId: null }],
  });
  vi.mocked(createSite).mockResolvedValue({ site: { ...sites[0]!, id: 's3', name: 'Lakeside Lodge' } });
});

describe('Sites', () => {
  it('lists every site with its type, time zone, state and unit', async () => {
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    expect(await screen.findByText('Harbor House')).toBeInTheDocument();
    expect(screen.getByText('Downtown Office')).toBeInTheDocument();
    expect(screen.getByText('Property')).toBeInTheDocument();
    expect(screen.getByText('Office')).toBeInTheDocument();
    expect(screen.getByText('America/Chicago')).toBeInTheDocument();
    expect(screen.getByText('Southeast')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('adds a property pinned to a unit with its time zone and state', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findByText('Harbor House');
    await user.click(screen.getByRole('button', { name: /^Add / }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Lakeside Lodge');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'WAREHOUSE');
    await user.selectOptions(within(dialog).getByLabelText('Time zone'), 'America/Denver');
    await waitFor(() => expect(within(dialog).getByLabelText('Unit')).not.toBeDisabled());
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'r1');
    await user.type(within(dialog).getByLabelText('State'), 'co');
    await user.click(within(dialog).getByRole('button', { name: /^Add / }));
    await waitFor(() => expect(createSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createSite).mock.calls[0]![0]).toEqual({
      name: 'Lakeside Lodge',
      type: 'WAREHOUSE',
      timezone: 'America/Denver',
      orgUnitId: 'r1',
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: 'CO',
      zip: null,
    });
  });

  it('edits a site from its row: the form is prefilled and only what changed is sent', async () => {
    vi.mocked(updateSite).mockResolvedValue({ site: { ...sites[0]!, name: 'Harbor House East', type: 'OFFICE', isActive: false } });
    const user = userEvent.setup();
    renderAsAdmin(<SitesAdmin />, '/admin/sites');
    await screen.findByText('Harbor House');
    await user.click(screen.getByRole('button', { name: 'Edit Harbor House' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Harbor House');
    expect(within(dialog).getByLabelText('Type')).toHaveValue('PROPERTY');
    expect(within(dialog).getByLabelText('Time zone')).toHaveValue('America/New_York');
    expect(within(dialog).getByLabelText('State')).toHaveValue('FL');
    await waitFor(() => expect(within(dialog).getByLabelText('Unit')).toHaveValue('r1'));
    // Nothing changed yet: nothing to save.
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Harbor House East');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'OFFICE');
    await user.click(within(dialog).getByLabelText('Status'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateSite).mock.calls[0]).toEqual(['s1', { name: 'Harbor House East', type: 'OFFICE', isActive: false }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
