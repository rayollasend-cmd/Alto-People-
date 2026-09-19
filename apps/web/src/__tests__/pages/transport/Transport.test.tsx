import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { zonedDayKey } from '@/lib/format';
import type { MyLiveRide, MyTransport, Ride, RideRun, RunMap, TransportBoard } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
// No WebGL in jsdom — the map is stood in for by its markers' labels.
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ markers, ariaLabel }: { markers: Array<{ id: string; label?: string }>; ariaLabel: string }) => (
    <ul aria-label={ariaLabel}>
      {markers.map((m) => (
        <li key={m.id}>{m.label}</li>
      ))}
    </ul>
  ),
}));

import { apiFetch } from '@/lib/api';
import { RideHome } from '@/pages/transport/RideHome';
import { DriverHome } from '@/pages/transport/DriverHome';
import { TransportHome } from '@/pages/transport/TransportHome';

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
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal Resort Holdings' },
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
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function me(over: Partial<MyTransport> = {}): MyTransport {
  return {
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
    consent: { acceptedAt: new Date().toISOString() },
    places: [],
    stops: [{ id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' }],
    stores: [{ id: 'l1', name: 'Front Beach 218', timezone: tz, clientName: 'Coastal Resort Holdings', address: null }],
    shifts: [],
    rides: [],
    charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: null },
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

describe('<RideHome> — the associate’s Ride tab', () => {
  it('shows the deal once — $5 a ride, $1 for a missed van, from pay — and records the agreement', async () => {
    let agreed = false;
    routes((path, init) => {
      if (path === '/transport/me') return me({ consent: agreed ? { acceptedAt: 'now' } : null });
      if (path === '/transport/me/consent' && init?.method === 'POST') {
        agreed = true;
        return { ok: true };
      }
    });
    renderAs('ASSOCIATE', <RideHome />);
    expect(await screen.findByText('$5.00 each way — $10.00 to work and back')).toBeInTheDocument();
    expect(screen.getByText('$1.00 if you miss your van')).toBeInTheDocument();
    expect(screen.getByText(/Taken out of your paycheck each pay period/)).toBeInTheDocument();
    expect(screen.getByText('Book at least 10 hours ahead')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /I agree/ }));
    expect(apiFetch).toHaveBeenCalledWith('/transport/me/consent', { method: 'POST' });
    expect(await screen.findByText('No rides booked')).toBeInTheDocument();
  });

  it('leads with the next ride — the pickup time, the van and driver — and cancels it', async () => {
    const pickupAt = hoursFromNow(19);
    const r = ride({
      id: 'r1',
      status: 'SCHEDULED',
      pickupAt,
      run: {
        id: 'run1',
        status: 'PLANNED',
        departAt: hoursFromNow(18.8),
        van: { id: 'v1', name: 'Van 1', plate: 'ALT 101' },
        driver: { userId: 'd1', name: 'Mike Chen' },
      },
    });
    routes((path, init) => {
      if (path === '/transport/me') return me({ rides: [r] });
      if (path === '/transport/me/rides/r1/cancel' && init?.method === 'POST') return { ok: true };
    });
    renderAs('ASSOCIATE', <RideHome />);
    const hero = await screen.findByRole('region', { name: 'Your next ride' });
    expect(within(hero).getByText(/Pickup/)).toHaveTextContent(
      new Date(pickupAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    );
    expect(within(hero).getByText(/Van 1 · driver Mike/)).toBeInTheDocument();
    expect(within(hero).getByText('Seaside Housing')).toBeInTheDocument();
    expect(within(hero).getByText('Van confirmed')).toBeInTheDocument();
    await userEvent.click(within(hero).getByRole('button', { name: 'Cancel ride' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel ride' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/me/rides/r1/cancel', { method: 'POST' }));
  });

  it('won’t book inside the 10-hour cutoff', async () => {
    routes((path) => (path === '/transport/me' ? me() : undefined));
    renderAs('ASSOCIATE', <RideHome />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Book a ride' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Day/), { target: { value: zonedDayKey(new Date(), tz) } });
    fireEvent.change(within(dialog).getByLabelText(/Be at work by/), { target: { value: '00:00' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Too soon — book at least 10 hours ahead/);
    expect(within(dialog).getByRole('button', { name: 'Book ride' })).toBeDisabled();
  });

  it('books both ways from a shift on their schedule — arrive by the start, leave at the end', async () => {
    const start = new Date(Date.now() + 26 * 3_600_000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 8 * 3_600_000);
    const shift = { id: 'sh1', startsAt: start.toISOString(), endsAt: end.toISOString(), position: 'Server', locationId: 'l1' };
    routes((path, init) => {
      if (path === '/transport/me') return me({ shifts: [shift] });
      if (path === '/transport/me/rides' && init?.method === 'POST') return { ride: ride({ id: 'new' }) };
    });
    renderAs('ASSOCIATE', <RideHome />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Book a ride' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Both ways' }));
    await userEvent.click(within(dialog).getByRole('button', { pressed: false, name: /–/ }));
    expect(within(dialog).getByText('$10.00, taken from your pay')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book both rides' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/transport/me/rides', {
        method: 'POST',
        body: { direction: 'TO_WORK', locationId: 'l1', stopId: 's1', targetAt: start.toISOString(), shiftId: 'sh1' },
      }),
    );
    expect(apiFetch).toHaveBeenCalledWith('/transport/me/rides', {
      method: 'POST',
      body: { direction: 'FROM_WORK', locationId: 'l1', stopId: 's1', targetAt: end.toISOString(), shiftId: 'sh1' },
    });
  });
});

describe('<DriverHome> — driver mode', () => {
  function run(): RideRun {
    const r1 = ride({ id: 'r1', status: 'SCHEDULED', pickupOrder: 1, pickupAt: hoursFromNow(1) });
    const r2 = ride({
      id: 'r2',
      status: 'SCHEDULED',
      pickupOrder: 2,
      pickupAt: hoursFromNow(1.2),
      rider: { associateId: 'a2', name: 'Ben Ray', phone: null },
    });
    return {
      id: 'run1',
      direction: 'TO_WORK',
      serviceDate: zonedDayKey(new Date(), tz),
      departAt: hoursFromNow(0.8),
      status: 'PLANNED',
      startedAt: null,
      endedAt: null,
      notes: null,
      van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
      driver: { userId: 'u', name: 'Mike Chen' },
      seats: { taken: 2, capacity: 12 },
      rides: [r1, r2],
    };
  }

  it('lists the riders in pickup order and marks them on board or a no-show', async () => {
    routes((path, init) => {
      if (path === '/transport/driver/runs') return { today: zonedDayKey(new Date(), tz), runs: [run()] };
      if (path.startsWith('/transport/driver/rides/') && init?.method === 'POST') return { ride: ride({ id: 'x' }) };
    });
    renderAs('DRIVER', <DriverHome />);
    const card = await screen.findByRole('region', { name: /Van 1/ });
    const items = within(card).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Maria Lopez');
    expect(items[1]).toHaveTextContent('Ben Ray');
    expect(within(card).getByText('2/12 seats', { exact: false })).toBeInTheDocument();

    await userEvent.click(within(items[0]!).getByRole('button', { name: 'On board' }));
    expect(apiFetch).toHaveBeenCalledWith('/transport/driver/rides/r1/board', { method: 'POST' });

    await userEvent.click(within(items[1]!).getByRole('button', { name: 'No-show' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Mark Ben Ray a no-show?');
    expect(confirm).toHaveTextContent('$1.00 no-show fee');
    await userEvent.click(within(confirm).getByRole('button', { name: 'No-show' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/driver/rides/r2/no-show', { method: 'POST' }));
  });
});

describe('<TransportHome> — the command center', () => {
  function board(): TransportBoard {
    const a = ride({ id: 'r1', targetAt: hoursFromNow(20) });
    const b = ride({
      id: 'r2',
      targetAt: hoursFromNow(20.1),
      rider: { associateId: 'a2', name: 'Kim Nguyen', phone: null },
      pickup: { kind: 'address', id: null, name: null, address: '12 Palm St' },
    });
    return {
      date: zonedDayKey(new Date(), tz),
      settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
      kpis: { booked: 2, needsVan: 2, scheduled: 0, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 0, runs: 0, openIssues: 1 },
      rides: [a, b],
      runs: [],
      vans: [{ id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 }],
      drivers: [{ userId: 'd1', name: 'Mike Chen', role: 'DRIVER' }],
    };
  }

  it('groups the bookings waiting on a van and dispatches them onto a run in pickup order', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/runs' && init?.method === 'POST') return { run: {} };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    expect(await screen.findByText(/To Front Beach 218/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Issues/ })).toHaveTextContent('1');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pick all 2' }));
    await userEvent.click(screen.getByRole('button', { name: /Dispatch 2/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Maria Lopez')).toBeInTheDocument();
    expect(within(dialog).getByText('Kim Nguyen')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Dispatch 2/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/runs', expect.objectContaining({ method: 'POST' })));
    const call = vi.mocked(apiFetch).mock.calls.find(([p]) => p === '/transport/runs')!;
    const body = (call[1] as { body: { vanId: string; driverUserId: string; direction: string; rides: Array<{ rideId: string }> } }).body;
    expect(body.vanId).toBe('v1');
    expect(body.driverUserId).toBe('d1');
    expect(body.direction).toBe('TO_WORK');
    expect(body.rides.map((r) => r.rideId)).toEqual(['r1', 'r2']);
  });

  it('reads without acting for a view-only role', async () => {
    routes((path) => (path.startsWith('/transport/board') ? board() : undefined));
    renderAs('EXECUTIVE_CHAIRMAN', <TransportHome />);
    expect(await screen.findByText(/To Front Beach 218/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});

describe('the vans live', () => {
  const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  it('the rider sees how far off the van is, the stops before them, and the map', async () => {
    const pickupAt = hoursFromNow(0.3);
    const r = ride({
      id: 'r1',
      status: 'SCHEDULED',
      targetAt: hoursFromNow(1),
      pickupAt,
      run: {
        id: 'run1',
        status: 'ACTIVE',
        departAt: hoursFromNow(-0.2),
        van: { id: 'v1', name: 'Van 1', plate: 'ALT 101' },
        driver: { userId: 'd1', name: 'Mike Chen' },
      },
    });
    const live: MyLiveRide = {
      rideId: 'r1',
      direction: 'TO_WORK',
      status: 'SCHEDULED',
      runStatus: 'ACTIVE',
      timezone: tz,
      departAt: hoursFromNow(-0.2),
      van: { name: 'Van 1', plate: 'ALT 101' },
      driver: 'Mike',
      position: { lat: 30.3, lng: -85.95, heading: 90, speedMps: 11, at: new Date().toISOString() },
      stale: false,
      pickup: { label: 'Seaside Housing', point: { lat: 30.21, lng: -85.86 }, scheduledAt: pickupAt, etaAt: minutesFromNow(8) },
      destination: { label: 'Front Beach 218', point: { lat: 30.17, lng: -85.8 }, dueAt: hoursFromNow(1), etaAt: minutesFromNow(30) },
      stopsBefore: 1,
      lateMinutes: 0,
    };
    routes((path) => {
      if (path === '/transport/me') return me({ rides: [r] });
      if (path === '/transport/me/live') return { live };
    });
    renderAs('ASSOCIATE', <RideHome />);
    expect(await screen.findByText(/About [78] min away/)).toBeInTheDocument();
    expect(screen.getByText(/Van 1 is on its way · 1 stop before you/)).toBeInTheDocument();
    expect(screen.getByText('Updated just now')).toBeInTheDocument();
    const map = screen.getByRole('list', { name: 'Map of your van' });
    expect(within(map).getByText('Van 1')).toBeInTheDocument();
    expect(within(map).getByText('Seaside Housing')).toBeInTheDocument();
  });

  it('the driver’s phone shares the van’s position once the run is on the road', async () => {
    const watchers: Array<(p: GeolocationPosition) => void> = [];
    const geo = {
      watchPosition: vi.fn((ok: (p: GeolocationPosition) => void) => {
        watchers.push(ok);
        return 1;
      }),
      clearWatch: vi.fn(),
      getCurrentPosition: vi.fn(),
    };
    Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    const active: RideRun = {
      id: 'run1',
      direction: 'TO_WORK',
      serviceDate: zonedDayKey(new Date(), tz),
      departAt: hoursFromNow(-0.1),
      status: 'ACTIVE',
      startedAt: hoursFromNow(-0.1),
      endedAt: null,
      notes: null,
      van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
      driver: { userId: 'u', name: 'Mike Chen' },
      seats: { taken: 1, capacity: 12 },
      rides: [ride({ id: 'r1', status: 'SCHEDULED', pickupOrder: 1, pickupAt: hoursFromNow(0.2) })],
    };
    routes((path, init) => {
      if (path === '/transport/driver/runs') return { today: zonedDayKey(new Date(), tz), runs: [active] };
      if (path === '/transport/driver/runs/run1/live') return { run: null };
      if (path === '/transport/driver/runs/run1/location' && init?.method === 'POST') return { ok: true };
    });
    renderAs('DRIVER', <DriverHome />);
    expect(await screen.findByText('Finding the van…')).toBeInTheDocument();
    await waitFor(() => expect(watchers).toHaveLength(1));
    act(() =>
      watchers[0]!({
        coords: { latitude: 30.3, longitude: -85.95, heading: 90, speed: 11, accuracy: 8 },
        timestamp: Date.now(),
      } as unknown as GeolocationPosition),
    );
    expect(await screen.findByText('Sharing the van’s location with riders')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/transport/driver/runs/run1/location', {
      method: 'POST',
      body: { lat: 30.3, lng: -85.95, heading: 90, speed: 11, accuracy: 8 },
    });
  });

  it('the desk’s live map lists every van on the road — on time or late, the next stop, the signal', async () => {
    const run: RunMap = {
      runId: 'run1',
      status: 'ACTIVE',
      direction: 'TO_WORK',
      serviceDate: zonedDayKey(new Date(), tz),
      departAt: hoursFromNow(-0.2),
      timezone: tz,
      van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
      driver: { userId: 'd1', name: 'Mike Chen' },
      position: { lat: 30.3, lng: -85.95, heading: 90, speedMps: 11, at: new Date().toISOString() },
      stale: false,
      trail: [[-85.96, 30.31], [-85.95, 30.3]],
      waypoints: [
        { kind: 'pickup', point: { lat: 30.21, lng: -85.86 }, etaAt: minutesFromNow(6), label: 'Kim Rider', rideIds: ['r1'] },
        { kind: 'store', point: { lat: 30.17, lng: -85.8 }, etaAt: minutesFromNow(25), label: 'Front Beach 218', rideIds: ['r1'] },
      ],
      stores: [{ locationId: 'l1', name: 'Front Beach 218', point: { lat: 30.17, lng: -85.8 } }],
      late: [{ locationId: 'l1', store: 'Front Beach 218', minutes: 12 }],
      riders: [{ rideId: 'r1', name: 'Kim Rider', status: 'SCHEDULED', pickupAt: null, point: null, pickupEtaAt: minutesFromNow(6), dropEtaAt: minutesFromNow(25) }],
    };
    routes((path) => {
      if (path.startsWith('/transport/board')) return { ...board0(), rides: [] };
      if (path.startsWith('/transport/live')) return { date: run.serviceDate, generatedAt: new Date().toISOString(), runs: [run] };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <TransportHome />);
    await userEvent.click(await screen.findByRole('tab', { name: /Live map/ }));
    const row = await screen.findByRole('button', { name: /Van 1/ });
    expect(row).toHaveTextContent('~12 min late');
    expect(row).toHaveTextContent(/Next: Kim Rider · about [56] min/);
    expect(row).toHaveTextContent('Updated just now');
    const map = screen.getByRole('list', { name: 'Live map of the vans' });
    expect(within(map).getByText('Van 1 · Mike Chen')).toBeInTheDocument();
    expect(within(map).getByText('Kim Rider')).toBeInTheDocument();
  });

  function board0(): TransportBoard {
    return {
      date: zonedDayKey(new Date(), tz),
      settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
      kpis: { booked: 0, needsVan: 0, scheduled: 0, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 1, runs: 1, openIssues: 0 },
      rides: [],
      runs: [],
      vans: [],
      drivers: [],
    };
  }
});

