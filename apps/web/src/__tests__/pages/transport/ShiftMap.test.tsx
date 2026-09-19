import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TripMap } from '@/lib/transportApi';

// The map is a canvas — stand in for it, and let a test "tap" it.
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ ariaLabel, onPick }: { ariaLabel: string; onPick?: (p: { lat: number; lng: number }) => void }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onPick?.({ lat: 30.2, lng: -85.88 })} />
  ),
}));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { ShiftMapDrawer } from '@/pages/transport/ShiftMap';

/**
 * The driver's stops for one shift: who rides, grouped into stops in the
 * order to work them — and the pickup with no pin, dropped once on the map.
 */

const TRIP: TripMap = {
  trip: {
    locationId: 'loc1',
    store: { name: 'Front Beach 218', clientName: 'Coastal Resort Holdings', address: '1 Front Beach Rd', point: { lat: 30.1766, lng: -85.8055 }, timezone: 'America/Chicago' },
    direction: 'TO_WORK',
    windowLabel: 'Overnight',
    serviceDate: '2026-09-21',
    targetAt: '2026-09-22T03:00:00Z',
    riders: 4,
    requested: 1,
    scheduled: 3,
  },
  clusters: [
    {
      key: 'c1',
      label: 'Seaside Housing',
      address: '17751 Panama City Beach Pkwy',
      point: { lat: 30.2106, lng: -85.865 },
      order: 1,
      spreadM: 220,
      mapped: true,
      riders: [
        { rideId: 'r1', associateId: 'a1', name: 'Rosa Vega', label: 'Seaside Housing', address: '17751 Panama City Beach Pkwy', point: { lat: 30.2106, lng: -85.865 }, pinned: true, status: 'SCHEDULED' },
        { rideId: 'r2', associateId: 'a2', name: 'Kim Nguyen', label: '7209 Thomas Dr', address: '7209 Thomas Dr', point: { lat: 30.2116, lng: -85.8655 }, pinned: true, status: 'REQUESTED' },
      ],
    },
    {
      key: 'c2',
      label: '900 Nowhere Rd',
      address: '900 Nowhere Rd',
      point: null,
      order: 2,
      spreadM: 0,
      mapped: false,
      riders: [
        { rideId: 'r3', associateId: 'a3', name: 'Jay Patel', label: '900 Nowhere Rd', address: '900 Nowhere Rd', point: null, pinned: false, status: 'SCHEDULED' },
      ],
    },
  ],
  unmapped: 1,
};

function renderMap() {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body });
    if (path.startsWith('/transport/driver/trip-map')) return TRIP as never;
    if (path === '/transport/rides/r3/pin') return { ok: true, point: { lat: 30.2, lng: -85.88 } } as never;
    throw new Error(`unexpected ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ShiftMapDrawer
          trip={{ locationId: 'loc1', direction: 'TO_WORK', date: '2026-09-21', windowLabel: 'Overnight', storeName: 'Front Beach 218' }}
          open
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the stops for a shift', () => {
  it('groups the riders into stops, in order, with the store and the walk between addresses', async () => {
    const calls = renderMap();
    expect(await screen.findByText('Seaside Housing')).toBeInTheDocument();
    expect(calls[0]!.path).toContain('locationId=loc1');
    expect(calls[0]!.path).toContain('windowLabel=Overnight');
    expect(screen.getByText('4 riders · 2 stops')).toBeInTheDocument();
    expect(screen.getByText('Coastal Resort Holdings')).toBeInTheDocument();
    expect(screen.getByText(/2 riding · addresses 220 m apart/)).toBeInTheDocument();
    expect(screen.getByText('Rosa Vega')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Directions to Seaside Housing' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=30.2106,-85.865',
    );
    expect(screen.getByText('Pickups with no pin yet: 1 — set them and the van can route there.')).toBeInTheDocument();
  });

  it('a pickup with no pin: tap the map once, and it’s saved for them', async () => {
    const calls = renderMap();
    await userEvent.click(await screen.findByRole('button', { name: 'Set the pin' }));
    const dialog = await screen.findByRole('dialog', { name: /Where does the van stop for Jay Patel/ });
    const save = within(dialog).getByRole('button', { name: 'Save the pin' });
    expect(save).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Map to place the pickup pin' }));
    expect(within(dialog).getByText(/That’s the spot/)).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/transport/rides/r3/pin')).toMatchObject({ method: 'POST', body: { lat: 30.2, lng: -85.88 } }),
    );
  });
});
