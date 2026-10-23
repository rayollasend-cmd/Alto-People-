import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultTenantProfile } from '@alto-people/shared';
import type { OrgNode } from '@/lib/orgChartApi';
import { renderAsAdmin } from './admin/orgAdminHarness';
import { renderAs } from './hrPack/harness';

const getOrgChart = vi.fn();
vi.mock('@/lib/orgChartApi', () => ({
  getOrgChart: (...a: unknown[]) => getOrgChart(...a),
  setStaffReportsTo: vi.fn(),
}));
vi.mock('@/lib/useClients', () => ({ useClients: () => ({ clients: [] }) }));
vi.mock('@/lib/useViewport', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/structureApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/structureApi')>()),
  getStructureOptions: vi.fn(),
  getSiteDetails: vi.fn(),
  createRegion: vi.fn(),
  renameRegion: vi.fn(),
  retireRegion: vi.fn(),
  placeSite: vi.fn(),
  createStructureSite: vi.fn(),
}));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), updateSite: vi.fn(), assignOrgFields: vi.fn() }));
vi.mock('@/lib/regionsApi', () => ({ listRegions: vi.fn().mockResolvedValue({ regions: [], unassigned: [] }), inviteRegionUser: vi.fn() }));
vi.mock('@/components/ApproverPicker', () => ({ ApproverPicker: () => null }));

import { createRegion, createStructureSite, getSiteDetails, getStructureOptions, placeSite } from '@/lib/structureApi';
import { updateSite } from '@/lib/orgApi';
import { OrgChart } from '@/pages/org/OrgChart';

const node = (o: Partial<OrgNode> & Pick<OrgNode, 'id' | 'kind' | 'name'>): OrgNode => ({
  parentId: null,
  subtitle: null,
  role: null,
  shiftLabels: null,
  photoUrl: null,
  associateId: null,
  userId: null,
  departmentId: null,
  departmentName: null,
  clientId: null,
  clientName: null,
  siteName: null,
  reports: 0,
  shiftsToday: null,
  filledToday: null,
  positionStatus: null,
  former: false,
  ...o,
});

const FIELD: OrgNode[] = [
  node({ id: 'r:1', kind: 'region', name: 'Panhandle' }),
  node({ id: 'r:2', kind: 'region', name: 'Gulf' }),
  node({ id: 'c:c1@1', parentId: 'r:1', kind: 'client', name: 'Coastal', clientId: 'c1', clientName: 'Coastal' }),
  node({ id: 's:site-1', parentId: 'c:c1@1', kind: 'store', name: 'Front Beach', clientId: 'c1', clientName: 'Coastal', shiftsToday: 0, filledToday: 0 }),
  node({ id: 's:site-9', kind: 'store', name: 'Head Office', shiftsToday: 0, filledToday: 0 }),
];

/** jsdom has no DataTransfer: the drag carries its data on a plain object. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    get types() {
      return [...data.keys()];
    },
    effectAllowed: 'all',
    dropEffect: 'none',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getOrgChart.mockResolvedValue({ view: 'field', nodes: FIELD, fieldOnly: 0, unplaced: 0, truncated: false, limit: 5000 });
  vi.mocked(getStructureOptions).mockResolvedValue({
    regions: [
      { id: '1', name: 'Panhandle' },
      { id: '2', name: 'Gulf' },
    ],
    costCenters: [
      { id: 'cc-loose', type: 'COST_CENTER', name: 'Company ops', code: null, glCode: '6000', regionId: null },
      { id: 'cc-gulf', type: 'COST_CENTER', name: 'Gulf ops', code: null, glCode: '6200', regionId: '2' },
    ],
    clients: [{ id: 'c1', name: 'Coastal' }],
    businessModel: 'WORKFORCE_PROVIDER',
  });
  vi.mocked(placeSite).mockResolvedValue({ regionId: '2', orgUnitId: null, costCenterCleared: false });
  vi.mocked(createRegion).mockResolvedValue({ region: { id: '3', name: 'Gulf Coast' } });
});

describe('editing the structure from the field chart', () => {
  it('drags a store onto a region card to move it there', async () => {
    renderAsAdmin(<OrgChart />, '/org/chart?view=field');
    const canvas = await screen.findByTestId('org-canvas');
    const store = canvas.querySelector('[data-node="s:site-9"]') as HTMLElement;
    const gulf = canvas.querySelector('[data-node="r:2"]') as HTMLElement;
    expect(store).toHaveAttribute('draggable', 'true');
    const dt = dataTransfer();
    fireEvent.dragStart(store, { dataTransfer: dt });
    fireEvent.dragOver(gulf, { dataTransfer: dt });
    fireEvent.drop(gulf, { dataTransfer: dt });
    await waitFor(() => expect(placeSite).toHaveBeenCalledWith('site-9', { regionId: '2' }));
  });

  it('while dragging, every region is a drop target — even ones not on screen', async () => {
    renderAsAdmin(<OrgChart />, '/org/chart?view=field&focus=c:c1@1');
    const canvas = await screen.findByTestId('org-canvas');
    const store = await waitFor(() => canvas.querySelector('[data-node="s:site-1"]') as HTMLElement);
    const dt = dataTransfer();
    act(() => {
      fireEvent.dragStart(store, { dataTransfer: dt });
    });
    const bar = await screen.findByRole('group', { name: /drop on a region/i });
    const gulf = within(bar).getByText('Gulf');
    fireEvent.dragOver(gulf, { dataTransfer: dt });
    fireEvent.drop(gulf, { dataTransfer: dt });
    await waitFor(() => expect(placeSite).toHaveBeenCalledWith('site-1', { regionId: '2' }));
  });

  it('moves a store from the keyboard: M on its row, pick the region', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgChart />, '/org/chart?view=field&layout=list');
    const tree = await screen.findByRole('tree', { name: 'Field org chart' });
    const row = within(tree).getAllByRole('treeitem').find((r) => r.textContent?.includes('Head Office'))!;
    row.focus();
    fireEvent.keyDown(row, { key: 'm' });
    const dialog = await screen.findByRole('dialog', { name: /move head office/i });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Gulf' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Region'), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(placeSite).toHaveBeenCalledWith('site-9', { regionId: '2' }));
  });

  it('details for a place of your own: edits it, and only offers cost centers under its region', async () => {
    vi.mocked(getSiteDetails).mockResolvedValue({
      site: { id: 'site-9', name: 'Head Office', type: 'OFFICE', timezone: 'America/New_York', isActive: true, addressLine1: null, addressLine2: null, city: null, state: 'FL', zip: null, clientId: null, clientName: null, regionId: null, orgUnitId: null, costCenter: null },
    });
    vi.mocked(updateSite).mockResolvedValue({ site: {} as never });
    vi.mocked(placeSite).mockResolvedValue({ regionId: '2', orgUnitId: 'cc-gulf', costCenterCleared: false });
    const user = userEvent.setup();
    renderAsAdmin(<OrgChart />, '/org/chart?view=field&layout=list');
    const tree = await screen.findByRole('tree', { name: 'Field org chart' });
    await user.click(within(tree).getByRole('button', { name: 'Details for Head Office' }));
    const drawer = await screen.findByRole('dialog');
    await waitFor(() => expect(within(drawer).getByLabelText(/^Name/)).toHaveValue('Head Office'));
    await user.selectOptions(within(drawer).getByLabelText('Region'), '2');
    // Under Gulf now: only Gulf's cost center can be picked.
    const cc = within(drawer).getByLabelText('Cost center');
    expect(within(cc).queryByRole('option', { name: /Company ops/ })).toBeNull();
    await user.selectOptions(cc, 'cc-gulf');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateSite).toHaveBeenCalledWith('site-9', expect.objectContaining({ name: 'Head Office', type: 'OFFICE' })));
    expect(placeSite).toHaveBeenCalledWith('site-9', { regionId: '2' });
    expect(placeSite).toHaveBeenCalledWith('site-9', { orgUnitId: 'cc-gulf' });
  });

  it('details for a client’s store: identity is the client’s — read-only, with the way there', async () => {
    vi.mocked(getSiteDetails).mockResolvedValue({
      site: { id: 'site-1', name: 'Front Beach', type: 'STORE', timezone: 'America/Chicago', isActive: true, addressLine1: '218 Front Beach Dr', addressLine2: null, city: 'Panama City Beach', state: 'FL', zip: null, clientId: 'c1', clientName: 'Coastal', regionId: '1', orgUnitId: null, costCenter: null },
    });
    const user = userEvent.setup();
    renderAsAdmin(<OrgChart />, '/org/chart?view=field&layout=list');
    const tree = await screen.findByRole('tree', { name: 'Field org chart' });
    await user.click(within(tree).getByRole('button', { name: 'Details for Front Beach' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('link', { name: 'Edit in Coastal' })).toHaveAttribute('href', '/clients/c1');
    expect(within(drawer).queryByLabelText(/^Name/)).toBeNull();
    expect(within(drawer).getByLabelText('Region')).toHaveValue('1');
  });

  it('adds a region from the toolbar', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<OrgChart />, '/org/chart?view=field');
    await screen.findByTestId('org-canvas');
    // The header's actions (a phone-width render: they sit behind More).
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('button', { name: 'Add region' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a region' });
    await user.type(within(dialog).getByLabelText(/Name/), 'Gulf Coast');
    await user.click(within(dialog).getByRole('button', { name: 'Add region' }));
    await waitFor(() => expect(createRegion).toHaveBeenCalledWith('Gulf Coast'));
  });

  it('only people who manage the org get the editing controls', async () => {
    renderAs('FINANCE_ACCOUNTANT', <OrgChart />, '/org/chart?view=field&layout=list');
    await screen.findByRole('tree', { name: 'Field org chart' });
    expect(screen.queryByRole('button', { name: 'Add region' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add store/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Details for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Move .* to a region/ })).toBeNull();
  });

  it('a direct employer adds a property of its own — no client field, no client words', async () => {
    vi.mocked(getStructureOptions).mockResolvedValue({ regions: [{ id: '2', name: 'Gulf' }], costCenters: [], clients: [], businessModel: 'DIRECT_EMPLOYER' });
    vi.mocked(createStructureSite).mockResolvedValue({ site: { id: 'p1', name: 'The Grand', type: 'PROPERTY', clientId: null } });
    const user = userEvent.setup();
    const hotel = { id: 'hotel', ...defaultTenantProfile('DIRECT_EMPLOYER') };
    renderAsAdmin(<OrgChart />, '/org/chart?view=field', hotel);
    await screen.findByTestId('org-canvas');
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('button', { name: 'Add property' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/client/i)).toBeNull();
    await user.type(within(dialog).getByLabelText(/Name/), 'The Grand');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Gulf' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Region'), '2');
    await user.click(within(dialog).getByRole('button', { name: /^Add / }));
    await waitFor(() => expect(createStructureSite).toHaveBeenCalledWith(expect.objectContaining({ name: 'The Grand', clientId: null, regionId: '2' })));
  });
});
