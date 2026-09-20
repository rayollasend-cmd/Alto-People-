import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { zonedDayKey } from '@/lib/format';
import type { Ride, RideRun, RunMap, TransportBoard } from '@/lib/transportApi';
import type { DayPlan } from '@/lib/transportDispatchApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
}));

import { apiFetch } from '@/lib/api';
import { TransportHome } from '@/pages/transport/TransportHome';

/**
 * The Transportation Director's command center: what needs attention first,
 * the day's waiting bookings planned onto runs in one go, and the runs as
 * they happen — with a message to a van's riders one tap away.
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
    rider: { associateId: `a-${over.id}`, name: 'Maria Lopez', phone: null },
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
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function activeRun(): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: zonedDayKey(new Date(), tz),
    departAt: hoursFromNow(-0.3),
    status: 'ACTIVE',
    startedAt: hoursFromNow(-0.3),
    endedAt: null,
    notes: null,
    van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'd1', name: 'Mike Chen' },
    seats: { taken: 1, capacity: 12 },
    rides: [
      ride({
        id: 'r9',
        status: 'SCHEDULED',
        pickupOrder: 1,
        pickupAt: hoursFromNow(0.1),
        rider: { associateId: 'a9', name: 'Kim Nguyen', phone: null },
        riderSignal: { kind: 'OUTSIDE', at: new Date().toISOString() },
      }),
    ],
  };
}

function board(over: Partial<TransportBoard> = {}): TransportBoard {
  return {
    date: zonedDayKey(new Date(), tz),
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10 },
    kpis: { booked: 3, needsVan: 2, scheduled: 1, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 1, runs: 1, openIssues: 0 },
    rides: [ride({ id: 'r1' }), ride({ id: 'r2', rider: { associateId: 'a2', name: 'Ben Ray', phone: null } })],
    runs: [activeRun()],
    vans: [{ id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 }, { id: 'v2', name: 'Van 2', plate: 'ALT 102', capacity: 12 }],
    drivers: [{ userId: 'd1', name: 'Mike Chen', role: 'DRIVER', phone: '555-0101' }],
    ...over,
  };
}

function liveRun(over: Partial<RunMap> = {}): RunMap {
  return {
    runId: 'run1',
    status: 'ACTIVE',
    direction: 'TO_WORK',
    serviceDate: zonedDayKey(new Date(), tz),
    departAt: hoursFromNow(-0.3),
    timezone: tz,
    van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'd1', name: 'Mike Chen' },
    position: { lat: 30.3, lng: -85.95, heading: 90, speedMps: 11, at: new Date().toISOString() },
    stale: false,
    trail: [],
    waypoints: [{ kind: 'pickup', point: null, etaAt: new Date(Date.now() + 6 * 60_000).toISOString(), label: 'Kim Nguyen', rideIds: ['r9'] }],
    stores: [],
    late: [{ locationId: 'l1', store: 'Front Beach 218', minutes: 12 }],
    riders: [],
    ...over,
  };
}

function renderAs(role: Role) {
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
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
          <MemoryRouter>
            <TransportHome />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Handler) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
    return out as never;
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('<TransportHome> — what needs attention, first', () => {
  it('puts the late van, the riders without one, and a one-tap fix for each on top', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [liveRun()] };
      if (path === '/transport/runs/run1/message' && init?.method === 'POST') return { sent: 2 };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    const panel = await screen.findByRole('region', { name: 'Needs attention' });
    expect(await within(panel).findByText('Van 1 is running about 12 min late')).toBeInTheDocument();
    expect(within(panel).getByText('2 seat requests are waiting for a driver')).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: 'Message riders' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'About 12 late — on our way');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/transport/runs/run1/message', { method: 'POST', body: { body: 'About 12 late — on our way' } }),
    );
  });

  it('says all clear when nothing needs attention', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board({ rides: [], kpis: { ...board().kpis, needsVan: 0 } });
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [liveRun({ late: [] })] };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    expect(await screen.findByText(/All clear/)).toBeInTheDocument();
  });

  it('shows each run as it happens — on time or late, the next stop, a rider who’s outside — with the driver a call away', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [liveRun()] };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    const runs = await screen.findByRole('region', { name: 'Runs' });
    expect(await within(runs).findByText('~12 min late')).toBeInTheDocument();
    expect(within(runs).getByText(/Next: /)).toHaveTextContent(/Kim Nguyen · about [56] min/);
    expect(within(runs).getByText('Outside')).toBeInTheDocument();
    expect(within(runs).getByRole('link', { name: /Call Mike/ })).toHaveAttribute('href', 'tel:555-0101');
  });
});

describe('<TransportHome> — plan the day in one go', () => {
  it('proposes runs for every waiting booking, and dispatches them all', async () => {
    const plan: DayPlan = {
      date: zonedDayKey(new Date(), tz),
      proposals: [
        {
          key: 'p1',
          direction: 'TO_WORK',
          serviceDate: zonedDayKey(hoursFromNow(20), tz),
          store: { id: 'l1', name: 'Front Beach 218', timezone: tz },
          vanId: 'v2',
          driverUserId: 'd1',
          departAt: hoursFromNow(19),
          arriveAt: hoursFromNow(19.8),
          rides: [
            { rideId: 'r2', name: 'Ben Ray', place: 'Gulf Pines', pickupAt: hoursFromNow(19.2), point: null },
            { rideId: 'r1', name: 'Maria Lopez', place: 'Seaside Housing', pickupAt: hoursFromNow(19.4), point: null },
          ],
          warnings: [],
        },
      ],
      unplaced: [],
    };
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] };
      if (path === '/transport/plan' && init?.method === 'POST') return plan;
      if (path === '/transport/runs' && init?.method === 'POST') return { run: {} };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Plan runs' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('To Front Beach 218')).toBeInTheDocument();
    expect(within(dialog).getByText(/Ben Ray · Gulf Pines/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dispatch 1 run' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/runs', expect.objectContaining({ method: 'POST' })));
    const body = (vi.mocked(apiFetch).mock.calls.find(([p]) => p === '/transport/runs')![1] as { body: { vanId: string; rides: Array<{ rideId: string }> } }).body;
    expect(body.vanId).toBe('v2');
    expect(body.rides.map((r) => r.rideId)).toEqual(['r2', 'r1']);
  });

  it('a group dispatches in one click — the dialog opens already in the best order', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] };
      if (path === '/transport/route' && init?.method === 'POST') {
        return {
          direction: 'TO_WORK',
          departAt: hoursFromNow(19),
          arriveAt: hoursFromNow(19.8),
          rides: [
            { rideId: 'r2', pickupAt: hoursFromNow(19.2) },
            { rideId: 'r1', pickupAt: hoursFromNow(19.4) },
          ],
        };
      }
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    await userEvent.click(await screen.findByRole('button', { name: /^Dispatch Front Beach 218/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/route', { method: 'POST', body: { rideIds: ['r1', 'r2'] } }));
    await waitFor(() => {
      const names = within(dialog).getAllByText(/Maria Lopez|Ben Ray/).map((el) => el.textContent);
      expect(names[0]).toBe('Ben Ray');
    });
  });
});

describe('<TransportHome> — dispatching from the Rides tab', () => {
  /**
   * Today's board shows one service date, so a week of unassigned rides had
   * to be dispatched a day at a time. This tab is the one that spans days
   * and shows them all, and it could only cancel and waive.
   */
  const tomorrow = ride({ id: 'r1', rider: { associateId: 'a1', name: 'Marcus Hill', phone: null } });
  const alsoTomorrow = ride({ id: 'r2', rider: { associateId: 'a2', name: 'Aaliyah Brooks', phone: null } });
  const nextWeek = ride({
    id: 'r3',
    rider: { associateId: 'a3', name: 'Dana Reyes', phone: null },
    targetAt: hoursFromNow(200),
    serviceDate: zonedDayKey(hoursFromNow(200), tz),
  });
  const goingHome = ride({
    id: 'r4',
    rider: { associateId: 'a4', name: 'Nia Carter', phone: null },
    direction: 'FROM_WORK',
  });
  // Already on a van — a run can't take it, so it must not be selectable.
  const onAVan = ride({
    id: 'r5',
    status: 'SCHEDULED',
    rider: { associateId: 'a5', name: 'Rosa Vega', phone: null },
    run: {
      id: 'run1', status: 'PLANNED', departAt: hoursFromNow(19),
      van: { id: 'v1', name: 'Van 1', plate: null, capacity: 12 },
      driver: { userId: 'd1', name: 'Mike Chen', associateId: null },
    },
  });

  const openRides = async ({ boardFails = false } = {}) => {
    routes((path) => {
      if (path.startsWith('/transport/rides')) {
        return { rides: [tomorrow, alsoTomorrow, nextWeek, goingHome, onAVan] };
      }
      if (path.startsWith('/transport/board')) return boardFails ? undefined : board();
      if (path.startsWith('/transport/live')) return { runs: [] };
      return undefined;
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    await userEvent.click(await screen.findByRole('tab', { name: /^Rides/ }));
    return screen.findByRole('table');
  };

  it('offers a checkbox only for rides a run can actually take', async () => {
    await openRides();
    expect(await screen.findByRole('checkbox', { name: 'Select Marcus Hill' })).toBeInTheDocument();
    // Rosa is already on a van.
    expect(screen.queryByRole('checkbox', { name: 'Select Rosa Vega' })).not.toBeInTheDocument();
  });

  it('refuses a selection the server would reject, and says which rule', async () => {
    await openRides();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Marcus Hill' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Aaliyah Brooks' }));
    // Two riders, same way, same day — good to go.
    expect(screen.getByRole('button', { name: /Dispatch 2/ })).toBeEnabled();

    // A run is one van going one way: adding the ride home blocks it.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Nia Carter' }));
    expect(screen.getByText('One way per run')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dispatch 3/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Nia Carter' }));

    // And one day: a ride next week can't share the run either.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Dana Reyes' }));
    expect(screen.getByText('One day per run')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dispatch 3/ })).toBeDisabled();
  });

  it('says so when the vans for that day cannot be loaded', async () => {
    // The dialog can't open without a board, and the selection still looks
    // ready — so a failure here has to be visible, not a dead button.
    await openRides({ boardFails: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Marcus Hill' }));
    await userEvent.click(screen.getByRole('button', { name: /Dispatch 1/ }));
    expect(await screen.findByText(/the vans for that day/)).toBeInTheDocument();
  });

  it('select-all takes only the ones waiting for a van', async () => {
    await openRides();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Select all 4 waiting for a van/ }));
    // Four eligible; Rosa is not among them — and they span two ways and
    // two days, so it says so rather than letting it fail at the server.
    expect(screen.getByRole('button', { name: /Dispatch 4/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('button', { name: /Dispatch/ })).not.toBeInTheDocument();
  });
});
