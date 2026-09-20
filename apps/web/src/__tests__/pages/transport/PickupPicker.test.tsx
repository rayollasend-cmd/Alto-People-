import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@/lib/i18n';
import { PickupPicker, type Pickup } from '@/pages/transport/PickupPicker';

vi.mock('@/lib/transportApi', () => ({
  searchRideAddresses: vi.fn(),
  whereAmI: vi.fn(),
}));
// The map is a ~1MB lazy chunk and jsdom has no WebGL; the pin step's
// contract here is that it appears and returns a point, not how it draws.
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ onPick }: { onPick?: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" onClick={() => onPick?.({ lat: 25.999, lng: -80.999 })}>
      map
    </button>
  ),
}));

import { searchRideAddresses, whereAmI } from '@/lib/transportApi';

/**
 * Picking, not typing. A free-text address was only an address if a
 * geocoder agreed; anything else was accepted, stored without
 * coordinates, and turned up in the driver's stop list as a row with no
 * pin. Everything offered here carries its own point.
 */

const STOPS = [{ id: 's1', name: 'Seaside Housing', address: '100 Gulf Blvd' }];
const PLACES = [{ id: 'p1', label: 'Home', address: '12 Oak St, Destin FL' }];

function setup(onChange = vi.fn(), value: Pickup | null = null) {
  render(
    <I18nProvider>
      <PickupPicker
        value={value}
        onChange={onChange}
        stops={STOPS}
        places={PLACES}
        locationId="l1"
        label="Take me to work from"
      />
    </I18nProvider>,
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchRideAddresses).mockResolvedValue({ results: [] });
});

describe('picking a pickup', () => {
  it('offers where they have been before, with no network at all', async () => {
    setup();
    await userEvent.click(screen.getByRole('combobox'));
    // Saved places first, then the company's stops — both already in hand.
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveTextContent('Home');
    expect(options[1]).toHaveTextContent('Seaside Housing');
    expect(searchRideAddresses).not.toHaveBeenCalled();
  });

  it('waits for a real query before spending a geocoder call', async () => {
    setup();
    await userEvent.type(screen.getByRole('combobox'), '150');
    await new Promise((r) => setTimeout(r, 500));
    // Three characters match everything and mean nothing.
    expect(searchRideAddresses).not.toHaveBeenCalled();
  });

  it('suggests addresses, and hands back the point that came with one', async () => {
    vi.mocked(searchRideAddresses).mockResolvedValue({
      results: [
        { label: '1500 NW 7th St', address: '1500 NW 7th St, Miami FL', lat: 25.78, lng: -80.22, precision: 'exact' },
      ],
    });
    const onChange = setup();
    await userEvent.type(screen.getByRole('combobox'), '1500 NW 7th');
    const opt = await screen.findByRole('option', { name: /1500 NW 7th St/ });
    await userEvent.click(opt);

    expect(vi.mocked(searchRideAddresses).mock.calls[0]?.[1]).toBe('l1'); // biased to the store
    expect(onChange).toHaveBeenCalledWith({
      kind: 'address',
      address: '1500 NW 7th St, Miami FL',
      lat: 25.78,
      lng: -80.22,
      precision: 'exact',
    });
  });

  it('an approximate match is not chosen until the pin has been moved', async () => {
    vi.mocked(searchRideAddresses).mockResolvedValue({
      results: [
        { label: '1500 NW 7th Ave', address: '1500 NW 7th Ave, Miami FL', lat: 25.79, lng: -80.21, precision: 'approximate' },
      ],
    });
    const onChange = setup();
    await userEvent.type(screen.getByRole('combobox'), '1500 NW 7th');
    await userEvent.click(await screen.findByRole('option', { name: /1500 NW 7th Ave/ }));

    // Nothing committed yet — the street was found, the building wasn't.
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByText(/Move the pin to your door/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'map' })); // drop it elsewhere
    await userEvent.click(screen.getByRole('button', { name: /This is the spot/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'address', lat: 25.999, lng: -80.999, precision: 'exact' }),
    );
  });

  it('keeps the phone’s own fix even when the address lookup comes back empty', async () => {
    vi.mocked(whereAmI).mockResolvedValue({ address: null });
    // Spreading `navigator` drops its prototype methods, so define the one
    // property instead of replacing the whole object.
    Object.defineProperty(window.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 30.1, longitude: -85.8 } } as GeolocationPosition),
      },
    });
    const onChange = setup();
    await userEvent.click(screen.getByRole('button', { name: /Use where I am now/ }));
    // A point with no street name still gets the van there.
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'address', lat: 30.1, lng: -85.8 }),
      ),
    );
  });

  it('shows what was chosen, and lets them change it', async () => {
    const onChange = setup(vi.fn(), { kind: 'place', id: 'p1', label: 'Home', address: '12 Oak St, Destin FL' });
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
