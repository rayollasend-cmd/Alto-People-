import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));
vi.mock('@/lib/structureApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/structureApi')>()),
  getStructureOptions: vi.fn(),
  createStructureSite: vi.fn(),
  getSiteDetails: vi.fn(),
  placeSite: vi.fn(),
}));
vi.mock('@/lib/orgApi', async (orig) => ({ ...(await orig<typeof import('@/lib/orgApi')>()), updateSite: vi.fn() }));

import { suggestAddresses } from '@/lib/geoApi';
import { createStructureSite, getSiteDetails, getStructureOptions } from '@/lib/structureApi';
import { updateSite } from '@/lib/orgApi';
import type { OrgNode } from '@/lib/orgChartApi';
import { AddSiteDialog, StructureDrawer } from '@/pages/org/StructureEditor';

/**
 * The Org chart's store setup: a store added or edited by picking its
 * address takes the address's point and the zone of its place (a Panama
 * City Beach store is Central), and keeps the unit on its one street line.
 */

const PCB = {
  label: '7209 Thomas Drive Unit 5',
  address: '7209 Thomas Drive Unit 5, Panama City Beach, Florida 32408',
  line1: '7209 Thomas Drive',
  line2: 'Unit 5',
  city: 'Panama City Beach',
  state: 'FL',
  zip: '32408',
  county: 'Bay County',
  lat: 30.1766,
  lng: -85.8055,
  precision: 'exact' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStructureOptions).mockResolvedValue({ regions: [], costCenters: [], clients: [], businessModel: 'STAFFING' });
  vi.mocked(suggestAddresses).mockResolvedValue({ available: true, provider: 'mapbox', outage: false, results: [PCB] });
  vi.mocked(createStructureSite).mockResolvedValue({ site: { id: 's9', name: 'Thomas Drive', type: 'STORE', clientId: null } });
  vi.mocked(updateSite).mockResolvedValue({ site: {} as never });
});

describe('Org chart store setup from a picked address', () => {
  it('a new store takes the point, the fields and the zone of its place', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <AddSiteDialog open onClose={vi.fn()} defaults={{}} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Thomas Drive');
    await user.selectOptions(within(dialog).getByLabelText('Time zone'), 'America/New_York');
    await user.type(within(dialog).getByLabelText('Street address'), '7209 Thomas Unit 5');
    await user.click(await within(dialog).findByRole('option', { name: /7209 Thomas Drive/ }));
    // No line 2 on this form: the unit stays on the street line.
    expect(within(dialog).getByLabelText('Street address')).toHaveValue('7209 Thomas Drive Unit 5');
    expect(within(dialog).getByLabelText('Time zone')).toHaveValue('America/Chicago');
    await user.click(within(dialog).getByRole('button', { name: /^Add / }));
    await waitFor(() => expect(createStructureSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createStructureSite).mock.calls[0]![0]).toMatchObject({
      name: 'Thomas Drive',
      timezone: 'America/Chicago',
      addressLine1: '7209 Thomas Drive Unit 5',
      city: 'Panama City Beach',
      state: 'FL',
      zip: '32408',
      latitude: 30.1766,
      longitude: -85.8055,
    });
  });

  it('a store edited in the drawer sends the picked point and the zone of its place', async () => {
    vi.mocked(getSiteDetails).mockResolvedValue({
      site: { id: 's1', name: 'Beach 9', type: 'STORE', timezone: 'America/Chicago', isActive: true, addressLine1: '1 Old Rd', addressLine2: null, city: 'Panama City Beach', state: 'FL', zip: '32407', clientId: null, clientName: null, regionId: null, orgUnitId: null, costCenter: null },
    });
    const node = { id: 's:s1', kind: 'store', name: 'Beach 9' } as OrgNode;
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <StructureDrawer node={node} index={{ byId: new Map(), children: new Map(), teamSize: new Map() }} onClose={vi.fn()} onAddSite={vi.fn()} />);
    const street = await screen.findByLabelText('Street address');
    await waitFor(() => expect(street).toHaveValue('1 Old Rd'));
    await user.clear(street);
    await user.type(street, '7209 Thomas');
    await user.click(await screen.findByRole('option', { name: /7209 Thomas Drive/ }));
    expect(screen.getByText(/Placed on the map from this address/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateSite).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateSite).mock.calls[0]).toEqual([
      's1',
      expect.objectContaining({ addressLine1: '7209 Thomas Drive Unit 5', zip: '32408', timezone: 'America/Chicago', latitude: 30.1766, longitude: -85.8055 }),
    ]);
  });
});
