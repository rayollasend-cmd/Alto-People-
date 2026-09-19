import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { zonedDayKey } from '@/lib/format';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import type { FleetVan, MyTransport, Ride, SeatRequest, TransportBoard } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
}));

import { apiFetch } from '@/lib/api';
import { RideHome } from '@/pages/transport/RideHome';
import { DriverHome } from '@/pages/transport/DriverHome';
import { TransportHome } from '@/pages/transport/TransportHome';

/**
 * Ride-share, for a seat in a van: the rider sees the van to look for and
 * their driver; the driver sees seat requests with the rider's profile and
 * accepts or declines; the director runs the fleet — who drives what, what
 * each van earns — and has the last word on a seat nobody took.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: hoursFromNow(20),
    serviceDate: zonedDayKey(hoursFromNow(20), tz),
    status: 'REQUESTED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: null,
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
    rider: { associateId: `a-${over.id}`, name: 'Maria Lopez', phone: '555-0100' },
    pickupOrder: null,
    pickupAt: null,
    run: null,
    fareCents: 500,
    noShowFeeCents: 100,
    owedCents: 0,
    waived: false,
    waiveReason: null,
    charged: false,
    boardedAt: null,
    completedAt: null,
    noShowAt: null,
    cancelledAt: null,
    cancelReason: null,
    vanArrivedAt: null,
    riderSignal: null,
    acceptedAt: null,
    declines: 0,
    allDeclined: false,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function renderAs(role: Role, ui: React.ReactElement) {
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: 'a' },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <ConfirmProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Handler) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init) ?? (path === '/transport/me/live' ? { live: null } : undefined);
    if (out === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
    return out as never;
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the rider’s van and driver', () => {
  it('shows the plate and the van to look for, and opens the driver’s card', async () => {
    const r = ride({
      id: 'r1',
      status: 'SCHEDULED',
      pickupAt: hoursFromNow(19),
      acceptedAt: new Date().toISOString(),
      run: {
        id: 'run1',
        status: 'PLANNED',
        departAt: hoursFromNow(18.8),
        van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', make: 'Ford', model: 'Transit', color: 'White', year: 2023 },
        driver: { userId: 'd1', name: 'Mike Chen', associateId: 'm1' },
      },
    });
    const me: MyTransport = {
      settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
      consent: { acceptedAt: new Date().toISOString() },
      places: [],
      stops: [],
      stores: [{ id: 'l1', name: 'Front Beach 218', timezone: tz, clientName: 'Coastal', address: null }],
      shifts: [],
      rides: [r],
      defaultPickup: null,
      defaultStoreId: 'l1',
      charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: null },
    };
    routes((path) => {
      if (path === '/transport/me') return me;
      if (path === '/transport/me/rides/r1/crew')
        return {
          crew: {
            van: { name: 'Van 1', plate: 'ALT 101', capacity: 12, make: 'Ford', model: 'Transit', color: 'White', year: 2023, look: 'White Ford Transit 2023' },
            driver: { name: 'Mike C.', associateId: 'm1', since: '2026-03-01T00:00:00.000Z', trips: 42, riders: 310 },
          },
        };
    });
    renderAs('ASSOCIATE', <RideHome />);
    const hero = await screen.findByRole('region', { name: 'Your next ride' });
    expect(within(hero).getByText('White Ford Transit 2023')).toBeInTheDocument();
    expect(within(hero).getByRole('list', { name: 'Accepted' })).toBeInTheDocument();
    await userEvent.click(within(hero).getByRole('button', { name: 'Van & driver' }));
    const card = await screen.findByRole('dialog');
    expect(await within(card).findByText('Mike C.')).toBeInTheDocument();
    expect(within(card).getByText('ALT 101')).toBeInTheDocument();
    expect(within(card).getByText('42 trips · 310 riders')).toBeInTheDocument();
  });
});

describe('the driver decides on seat requests', () => {
  const req = (over: Partial<SeatRequest> & { id: string }): SeatRequest => ({ ...ride(over), fits: null, ...over });

  it('lists the requests with who’s asking; accept puts the seat in their van, decline passes it on', async () => {
    routes((path, init) => {
      if (path === '/transport/driver/runs') return { today: zonedDayKey(new Date(), tz), runs: [] };
      if (path === '/transport/driver/requests')
        return {
          van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, look: 'White Ford Transit 2023' },
          requests: [
            req({ id: 'q1', fits: { runId: 'run1', departAt: hoursFromNow(19) } }),
            req({ id: 'q2', rider: { associateId: 'a2', name: 'Ben Ray', phone: null } }),
          ],
        };
      if (path === '/transport/driver/requests/q1/accept' && init?.method === 'POST') return { run: {} };
      if (path === '/transport/driver/requests/q2/decline' && init?.method === 'POST') return { ok: true };
      if (path === '/transport/riders/a-q1')
        return { rider: { associateId: 'a-q1', name: 'Maria Lopez', phone: '555-0100', since: '2026-01-10T00:00:00Z', rides: 12, noShows: 1, cancelled: 2 } };
    });
    renderAs('DRIVER', <DriverHome />);
    const list = await screen.findByRole('region', { name: 'Seat requests' });
    expect(within(list).getByText('White Ford Transit 2023', { exact: false })).toBeInTheDocument();
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Maria Lopez');
    expect(items[0]).toHaveTextContent(/Fits your .* run/);

    // Who's asking.
    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Maria Lopez' }));
    const profile = await screen.findByRole('dialog');
    expect(await within(profile).findByText('12 rides')).toBeInTheDocument();
    expect(within(profile).getByText('1 no-shows')).toBeInTheDocument();
    expect(within(profile).getByRole('link', { name: /555-0100/ })).toHaveAttribute('href', 'tel:555-0100');
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(items[0]!).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/driver/requests/q1/accept', { method: 'POST' }));

    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Decline' }));
    const ask = await screen.findByRole('dialog');
    await userEvent.type(within(ask).getByRole('textbox'), 'Too far out');
    await userEvent.click(within(ask).getByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/transport/driver/requests/q2/decline', { method: 'POST', body: { reason: 'Too far out' } }),
    );
  });

  it('without a van, the driver can see requests but not accept them', async () => {
    routes((path) => {
      if (path === '/transport/driver/runs') return { today: zonedDayKey(new Date(), tz), runs: [] };
      if (path === '/transport/driver/requests') return { van: null, requests: [req({ id: 'q1' })] };
    });
    renderAs('DRIVER', <DriverHome />);
    expect(await screen.findByText(/No van assigned yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
  });
});

describe('the director runs the fleet — and has the last word', () => {
  function fleetVan(over: Partial<FleetVan> = {}): FleetVan {
    return {
      id: 'v1',
      name: 'Van 1',
      plate: 'ALT 101',
      capacity: 12,
      isActive: true,
      notes: null,
      make: 'Ford',
      model: 'Transit',
      color: 'White',
      year: 2023,
      look: 'White Ford Transit 2023',
      driver: null,
      stats: { revenueCents: 12500, waivedCents: 0, runs: 6, riders: 24, noShows: 1, seatFill: 33, miles: 84.5, daily: [] },
      now: null,
      ...over,
    };
  }
  const board = (over: Partial<TransportBoard> = {}): TransportBoard => ({
    date: zonedDayKey(new Date(), tz),
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
    kpis: { booked: 1, needsVan: 1, scheduled: 0, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 0, runs: 0, openIssues: 0 },
    rides: [],
    runs: [],
    vans: [{ id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, driverUserId: null }],
    drivers: [{ userId: 'd1', name: 'Mike Chen', role: 'DRIVER', phone: null }],
    ...over,
  });

  it('the Fleet tab: what each van earned and carried, and a driver assigned in one pick', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/fleet')) return { from: '2026-08-21', to: '2026-09-19', vans: [fleetVan()] };
      if (path === '/transport/vans/v1' && init?.method === 'PATCH') return { van: fleetVan() };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Fleet' }));
    expect(await screen.findByText('White Ford Transit 2023 · 12 seats')).toBeInTheDocument();
    expect(screen.getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(screen.getByText('33%')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Driver for Van 1' }), 'd1');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/vans/v1', { method: 'PATCH', body: { driverUserId: 'd1' } }));
  });

  it('a seat every driver declined comes to the top — dispatch it, or offer it again', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board({ rides: [ride({ id: 'r1', declines: 2, allDeclined: true })] });
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] };
      if (path === '/transport/rides/r1/reoffer' && init?.method === 'POST') return { ok: true };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(panel).getByText("No driver took Maria's seat")).toBeInTheDocument();
    expect(screen.getByText('Every driver declined')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Offer again' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/rides/r1/reoffer', { method: 'POST' }));
  });
});

describe('the ride-hailing moments', () => {
  it('buzzes for news since the page opened — never for what was already there, never twice', () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    const onNew = vi.fn();
    const { rerender } = renderHook(({ keys }: { keys: string[] | null }) => useNewKeys(keys, onNew), {
      initialProps: { keys: null as string[] | null },
    });
    rerender({ keys: ['req:1'] });
    expect(onNew).not.toHaveBeenCalled(); // the page opening isn't news
    rerender({ keys: ['req:1', 'req:2'] });
    expect(onNew).toHaveBeenCalledWith(['req:2']);
    rerender({ keys: ['req:2', 'req:1'] });
    expect(onNew).toHaveBeenCalledTimes(1);
    act(() => rideAlert('arrived'));
    expect(vibrate).toHaveBeenCalledWith([250, 100, 250, 100, 250]);
  });
});
