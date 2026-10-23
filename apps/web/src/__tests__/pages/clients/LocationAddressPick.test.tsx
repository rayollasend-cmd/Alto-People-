import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocationSummary } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));
vi.mock('@/lib/clientsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/clientsApi')>()),
  listClientLocations: vi.fn(),
  createLocation: vi.fn(),
  updateLocation: vi.fn(),
  archiveLocation: vi.fn(),
}));

import { suggestAddresses } from '@/lib/geoApi';
import { createLocation, listClientLocations } from '@/lib/clientsApi';
import { LocationsSection } from '@/pages/clients/LocationsSection';

/**
 * A client's store, added by picking its address: the boxes fill, the
 * geofence gets the address's point (at the 150 m the "use my location"
 * button also starts from), and the time zone follows the place — a
 * Destin store opens on Central, not Florida's Eastern.
 */

const placed: LocationSummary = {
  id: 'l1', clientId: 'c1', name: 'Fort Walton', addressLine1: '99 Miracle Strip Pkwy', addressLine2: null, city: 'Fort Walton Beach', state: 'FL', zip: '32548',
  latitude: 30.405, longitude: -86.62, geofenceRadiusMeters: 200, isActive: true, timezone: 'America/Chicago',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listClientLocations).mockResolvedValue({ locations: [placed] });
  vi.mocked(createLocation).mockResolvedValue({ ...placed, id: 'l2', name: 'Destin' });
  vi.mocked(suggestAddresses).mockResolvedValue({
    available: true,
    provider: 'mapbox',
    outage: false,
    results: [
      { label: '382 Flamingo Drive', address: '382 Flamingo Drive, Destin, Florida 32541', line1: '382 Flamingo Drive', line2: null, city: 'Destin', state: 'FL', zip: '32541', county: 'Okaloosa County', lat: 30.4012345, lng: -86.5003456, precision: 'exact' },
    ],
  });
});

describe('a client location from a picked address', () => {
  it('fills the address, sets the geofence point and the zone, and saves them', async () => {
    const user = userEvent.setup();
    renderAs('HR_ADMINISTRATOR', <LocationsSection clientId="c1" />);
    await screen.findAllByText('Fort Walton');
    await user.click(screen.getByRole('button', { name: /New location/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Destin');
    await user.type(within(dialog).getByLabelText('Address line 1'), '382 Flamingo');
    await user.click(await within(dialog).findByRole('option', { name: /382 Flamingo Drive/ }));

    // Leaning toward where the client already is.
    expect(vi.mocked(suggestAddresses).mock.calls[0]![1]).toEqual({ lat: 30.405, lng: -86.62 });
    expect(within(dialog).getByLabelText('City')).toHaveValue('Destin');
    expect(within(dialog).getByLabelText('State')).toHaveValue('FL');
    expect(within(dialog).getByLabelText('ZIP')).toHaveValue('32541');
    expect(within(dialog).getByLabelText('Latitude')).toHaveValue(30.4012345);
    expect(within(dialog).getByLabelText('Longitude')).toHaveValue(-86.5003456);
    expect(within(dialog).getByLabelText('Radius (m)')).toHaveValue(150);
    expect(within(dialog).getByLabelText(/Time zone/)).toHaveValue('America/Chicago');
    expect(within(dialog).getByText(/geofence point and time zone below came from this address/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createLocation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createLocation).mock.calls[0]).toEqual([
      'c1',
      {
        name: 'Destin',
        addressLine1: '382 Flamingo Drive',
        addressLine2: null,
        city: 'Destin',
        state: 'FL',
        zip: '32541',
        latitude: 30.4012345,
        longitude: -86.5003456,
        geofenceRadiusMeters: 150,
        timezone: 'America/Chicago',
      },
    ]);
  });
});
