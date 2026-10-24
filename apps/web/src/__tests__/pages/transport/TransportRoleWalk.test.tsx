import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { ApiError, apiFetch } from '@/lib/api';
import { TransportHome } from '@/pages/transport/TransportHome';

/**
 * The transport role walk on the director's screen: dispatch defaults to a
 * van and driver who are free (walk 1) and marks the busy ones; a driver
 * with no licence is marked (2); Plan runs tops up and dispatches all or
 * nothing with a result sheet (3, 10); a stuck run reads "Not closed" (4);
 * the rider's record (7); unsigned riders at dispatch, with Ask (8); the
 * phone header (11); the keyboard (12); one charges range in the URL (13);
 * the van roster (audit Tier 3).
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: at(20),
    serviceDate: zonedDayKey(at(20), tz),
    status: 'REQUESTED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: { lat: 30.2, lng: -85.9 },
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
    acceptedAt: null,
    declines: 0,
    allDeclined: false,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Van 1 / Mike, leaving at 19h — the walk's 5:09 run. */
function plannedRun(over: Partial<RideRun> = {}): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: zonedDayKey(at(20), tz),
    departAt: at(19.4),
    status: 'PLANNED',
    startedAt: null,
    endedAt: null,
    notes: null,
    van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'mike', name: 'Mike Chen' },
    seats: { taken: 3, capacity: 12 },
    rides: [ride({ id: 'r9', status: 'SCHEDULED', pickupOrder: 1, pickupAt: at(19.6), rider: { associateId: 'a9', name: 'Kim Nguyen', phone: null }, signatureNeeded: 'No signed ride authorization on file.' })],
    ...over,
  };
}

function board(over: Partial<TransportBoard> = {}): TransportBoard {
  return {
    date: zonedDayKey(at(20), tz),
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: null },
    kpis: { booked: 3, needsVan: 2, scheduled: 1, onBoard: 0, completed: 0, noShows: 0, cancelled: 0, vansOut: 0, runs: 1, openIssues: 0 },
    rides: [
      ride({ id: 'r1', signatureNeeded: 'No signed ride authorization on file.' }),
      ride({ id: 'r2', rider: { associateId: 'a-r2', name: 'Ben Ray', phone: null }, point: null }),
    ],
    runs: [plannedRun()],
    vans: [
      { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, driverUserId: 'mike' },
      { id: 'v2', name: 'Van 2', plate: 'ALT 102', capacity: 12, driverUserId: null },
    ],
    drivers: [
      { userId: 'mike', name: 'Mike Chen', role: 'DRIVER', drivesByTrade: true, phone: null, licenceOnFile: true, canDrive: true, credentialProblem: null },
      { userId: 'sam', name: 'Sam Ortiz', role: 'DRIVER', drivesByTrade: true, phone: null, licenceOnFile: false, canDrive: false, credentialProblem: 'No licence on file' },
      { userId: 'tasha', name: 'Tasha Grant', role: 'DRIVER', drivesByTrade: true, phone: null, licenceOnFile: true, canDrive: true, credentialProblem: null },
    ],
    credentialsEnforced: true,
    ...over,
  };
}

function liveRun(over: Partial<RunMap> = {}): RunMap {
  return {
    runId: 'old',
    status: 'ACTIVE',
    direction: 'TO_WORK',
    serviceDate: zonedDayKey(new Date(), tz),
    departAt: at(-32 * 24),
    timezone: tz,
    van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'mike', name: 'Mike Chen' },
    position: { lat: 30.3, lng: -85.95, heading: 90, speedMps: 0, at: at(-32 * 24) },
    stale: true,
    stuck: true,
    trail: [],
    waypoints: [{ kind: 'pickup', point: null, etaAt: at(0.1), label: 'Kim Nguyen', rideIds: ['r9'] }],
    stores: [],
    late: [{ locationId: 'l1', store: 'Front Beach 218', minutes: 46_000 }],
    riders: [],
    ...over,
  };
}

function renderAs(role: Role, url = '/transport') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[url]}>
            <TransportHome />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
/** The page's side panels (needs-you, trends, the map's stores) answer empty unless a test says otherwise. */
function routes(handler: Handler) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out instanceof Error) throw out;
    if (out !== undefined) return out as never;
    if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] } as never;
    if (path === '/transport/needs-you') return { total: 0, items: [] } as never;
    if (path.startsWith('/transport/trends')) return { weeks: [], note: '' } as never;
    if (path.startsWith('/transport/plan-map')) return { date: '', trips: [] } as never;
    if (path === '/transport/route') throw new ApiError(400, 'x', 'no route in tests');
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  });
}

const callsTo = (path: string) => vi.mocked(apiFetch).mock.calls.filter(([p]) => p === path);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('walk 1 and 2 — dispatch defaults to a free van and driver', () => {
  it('opens on Van 2 and a driver who is free and licensed; the busy ones say which run, the unlicensed one says why', async () => {
    // Morning on a weekday: the planned run leaves "19.4 hours from now", which
    // after ~4:30 AM UTC lands on the next service day and stops making Van 1 busy.
    const real = new Date();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), 13)) });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    routes((path) => (path.startsWith('/transport/board') ? board() : undefined));
    renderAs('TRANSPORTATION_DIRECTOR');
    await userEvent.click(await screen.findByRole('button', { name: /^Dispatch Front Beach 218/ }));
    const dialog = await screen.findByRole('dialog');
    const van = within(dialog).getByRole('combobox', { name: /Van/ }) as HTMLSelectElement;
    const driver = within(dialog).getByRole('combobox', { name: /Driver/ }) as HTMLSelectElement;
    // Van 1 and Mike are on the run leaving minutes earlier — not the default.
    expect(van.value).toBe('v2');
    expect(driver.value).toBe('tasha');
    expect(within(van).getByRole('option', { name: /Van 1 .*\(on .* run\)/ })).toBeInTheDocument();
    expect(within(driver).getByRole('option', { name: /Mike Chen \(on .* run\)/ })).toBeInTheDocument();
    expect(within(driver).getByRole('option', { name: /Sam Ortiz \(no licence on file\)/ })).toBeInTheDocument();
    // Picking the busy van says dispatch will refuse it.
    await userEvent.selectOptions(van, 'v1');
    expect(within(dialog).getByText(/Van 1 is on .* run — dispatch will refuse it\./)).toBeInTheDocument();
    // Walk 8 at dispatch, and walk 5's honest gap: who hasn't signed, who has no map point.
    expect(within(dialog).getByText('Unsigned')).toBeInTheDocument();
    expect(within(dialog).getByText('no map location')).toBeInTheDocument();
  });
});

describe('walk 3 and 10 — Plan runs tops up, then dispatches all or nothing', () => {
  const plan: DayPlan = {
    date: zonedDayKey(at(20), tz),
    proposals: [
      {
        key: 'topUp|run1',
        kind: 'topUp',
        runId: 'run1',
        direction: 'TO_WORK',
        serviceDate: zonedDayKey(at(20), tz),
        store: { id: 'l1', name: 'Front Beach 218', timezone: tz, point: { lat: 30.17, lng: -85.8 } },
        vanId: 'v1',
        driverUserId: 'mike',
        departAt: at(19.3),
        arriveAt: at(19.9),
        rides: [
          { rideId: 'r9', name: 'Kim Nguyen', place: 'Seaside Housing', pickupAt: at(19.5), point: null, existing: true },
          { rideId: 'r1', name: 'Maria Lopez', place: 'Seaside Housing', pickupAt: at(19.5), point: null },
        ],
        seats: { taken: 4, capacity: 12, added: 1 },
        warnings: [],
      },
      {
        key: 'new|1',
        kind: 'new',
        runId: null,
        direction: 'FROM_WORK',
        serviceDate: zonedDayKey(at(20), tz),
        store: { id: 'l1', name: 'Front Beach 218', timezone: tz, point: null },
        vanId: 'v2',
        driverUserId: 'tasha',
        departAt: at(28),
        arriveAt: null,
        rides: [{ rideId: 'r2', name: 'Ben Ray', place: 'Gulf Pines', pickupAt: at(28), point: null }],
        seats: { taken: 1, capacity: 12, added: 1 },
        warnings: [],
      },
    ],
    unplaced: [],
  };

  it('shows the top-up as "Add 1 to Van 1 (3→4/12)"; a refused batch names the one that can’t go and writes nothing', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/plan' && init?.method === 'POST') return plan;
      if (path === '/transport/runs/batch') {
        return new ApiError(409, 'batch_refused', "1 of 2 can't go — nothing was dispatched.", {
          errors: [{ key: 'new|1', code: 'driver_busy', message: 'Tasha Grant is already driving Van 3’s run leaving 4:00 AM.' }],
        });
      }
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Plan runs' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Add 1 to Van 1 (3→4/12)')).toBeInTheDocument();
    expect(within(dialog).getByText('Existing run')).toBeInTheDocument();
    expect(within(dialog).getByText(/Kim Nguyen · Seaside Housing · already on it/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dispatch 2 runs' }));
    const sheet = await within(dialog).findByRole('alert');
    expect(sheet).toHaveTextContent('1 of 2 can’t go — nothing was dispatched.');
    expect(sheet).toHaveTextContent(/Home from Front Beach 218 .*Tasha Grant is already driving/);
    expect(within(dialog).getByText('Can’t go')).toBeInTheDocument();
    // One request, with the top-up as a top-up and the new run as a run.
    const [call] = callsTo('/transport/runs/batch');
    const body = (call![1] as { body: { runs: Array<{ key: string }>; topUps: Array<{ key: string; runId: string; rides: Array<{ rideId: string }> }> } }).body;
    expect(body.runs.map((r) => r.key)).toEqual(['new|1']);
    expect(body.topUps).toEqual([{ key: 'topUp|run1', runId: 'run1', rides: [expect.objectContaining({ rideId: 'r9' }), expect.objectContaining({ rideId: 'r1' })] }]);
    expect(callsTo('/transport/runs')).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('walk 8 — unsigned riders, visible and askable', () => {
  it('the board counts who won’t be charged and asks them in one tap; rows carry the chip', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/authorizations/remind' && init?.method === 'POST') return { sent: 2, skipped: 0 };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText(/2 riders .* won’t be charged — not signed/)).toBeInTheDocument();
    await userEvent.click(within(attention).getByRole('button', { name: 'Ask all 2 to sign' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/authorizations/remind', { method: 'POST', body: { associateIds: ['a-r1', 'a9'] } }));
    const waiting = screen.getByRole('region', { name: 'Needs a van' });
    expect(within(waiting).getAllByText('Unsigned')).toHaveLength(1);
    const runs = screen.getByRole('region', { name: 'Runs' });
    expect(within(runs).getByText('Unsigned')).toBeInTheDocument();
  });
});

describe('walk 7 — the rider’s record, one click from a name', () => {
  it('opens the drawer with rides, no-shows, what’s held, and Ask to sign', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/riders/a-r1') {
        return {
          rider: {
            associateId: 'a-r1',
            name: 'Maria Lopez',
            phone: '555-0100',
            since: '2026-01-05T00:00:00Z',
            rides: 12,
            noShows: 3,
            cancelled: 1,
            userId: 'u-maria',
            noShowRate: 20,
            owedCents: 0,
            heldCents: 1500,
            takenCents: 2000,
            waivedCents: 0,
            notAuthorizedCents: 300,
            authorization: { current: false, signedAt: null, reason: 'No signed ride authorization on file.', withdrawnAt: null },
            openIssues: 1,
          },
          recent: [ride({ id: 'old', status: 'NO_SHOW', noShowDistanceM: 40 })],
        };
      }
      if (path === '/transport/authorizations/remind' && init?.method === 'POST') return { sent: 1, skipped: 0 };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    const waiting = await screen.findByRole('region', { name: 'Needs a van' });
    await userEvent.click(within(waiting).getByRole('button', { name: 'Maria Lopez' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Must sign')).toBeInTheDocument();
    expect(within(drawer).getByText('20% of marked rides')).toBeInTheDocument();
    expect(within(drawer).getByText('$15.00 held until they sign')).toBeInTheDocument();
    expect(within(drawer).getByText('van 40 m away')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Text/ })).toHaveAttribute('href', 'sms:5550100');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Ask to sign' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/authorizations/remind', { method: 'POST', body: { associateIds: ['a-r1'] } }));
  });

  it('opens straight from a link (?rider=…)', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/riders/a-r2') return { rider: { associateId: 'a-r2', name: 'Ben Ray', phone: null, since: '2026-01-05T00:00:00Z', rides: 0, noShows: 0, cancelled: 0 }, recent: [] };
    });
    renderAs('TRANSPORTATION_DIRECTOR', '/transport?rider=a-r2');
    expect(await screen.findByRole('heading', { name: 'Ben Ray' })).toBeInTheDocument();
  });
});

describe('walk 4 — a run nobody closed', () => {
  it('reads "Not closed" with Close run on the live map, and is one alert on the board, not two', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board({ runs: [] });
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [liveRun()] };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    await waitFor(() => expect(within(attention).getByText(/Van 1 has been out for .* — still open/)).toBeInTheDocument());
    expect(within(attention).queryByText(/no signal/)).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Live map' }));
    const runs = await screen.findByRole('region', { name: 'Runs' });
    expect(within(runs).getByText('Not closed')).toBeInTheDocument();
    expect(within(runs).getByRole('button', { name: 'Close run' })).toBeInTheDocument();
    expect(within(runs).queryByText(/late/)).toBeNull();
    expect(within(runs).queryByText(/Next: /)).toBeNull();
  });
});

describe('walk 12 — the keyboard', () => {
  it('j/x pick the first waiting group, d dispatches it; p opens Plan runs', async () => {
    routes((path, init) => {
      if (path.startsWith('/transport/board')) return board();
      if (path === '/transport/plan' && init?.method === 'POST') return { date: '', proposals: [], unplaced: [] };
    });
    renderAs('TRANSPORTATION_DIRECTOR');
    await screen.findByRole('region', { name: 'Needs a van' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'x' });
    expect(await screen.findByRole('button', { name: /^Dispatch 2$/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'd' });
    expect(await screen.findByRole('dialog', { name: 'Dispatch a van' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
    fireEvent.keyDown(window, { key: 'p' });
    expect(await screen.findByRole('dialog', { name: 'Plan runs' })).toBeInTheDocument();
  });
});

describe('walk 13 — one charges range, in the URL', () => {
  it('both sections read ?from&to; repeat no-shows are listed and open the rider', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/charges?')) {
        return {
          from: '2026-09-01',
          to: '2026-09-14',
          rows: [
            { associateId: 'a-r1', name: 'Maria Lopez', rides: 6, noShows: 3, owedCents: 300, takenCents: 0, waivedCents: 0, unauthorizedCents: 0, deferredCents: 0, authorization: 'current' },
            { associateId: 'a-r2', name: 'Ben Ray', rides: 4, noShows: 1, owedCents: 100, takenCents: 0, waivedCents: 0, unauthorizedCents: 0, deferredCents: 0, authorization: 'current' },
          ],
          totals: { rides: 10, noShows: 4, owedCents: 400, takenCents: 0, waivedCents: 0, unauthorizedCents: 0, deferredCents: 0 },
          rate: null,
        };
      }
      if (path.startsWith('/transport/costs?')) return { from: '2026-09-01', to: '2026-09-14', rows: [], totals: null, note: '' };
      if (path === '/transport/riders/a-r1') return { rider: { associateId: 'a-r1', name: 'Maria Lopez', phone: null, since: '2026-01-05T00:00:00Z', rides: 6, noShows: 3, cancelled: 0 }, recent: [] };
    });
    renderAs('TRANSPORTATION_DIRECTOR', '/transport?tab=charges&from=2026-09-01&to=2026-09-14');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/charges?from=2026-09-01&to=2026-09-14'));
    expect(apiFetch).toHaveBeenCalledWith('/transport/costs?from=2026-09-01&to=2026-09-14');
    expect(await screen.findByText(/Repeat no-shows · 1 rider with 2 or more/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Server CSV/ })).toHaveAttribute('href', '/api/transport/charges?from=2026-09-01&to=2026-09-14&format=csv');
    // Moving one end of the range moves both sections.
    fireEvent.change(screen.getAllByLabelText('From')[0]!, { target: { value: '2026-08-25' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/costs?from=2026-08-25&to=2026-09-14'));
    expect(apiFetch).toHaveBeenCalledWith('/transport/charges?from=2026-08-25&to=2026-09-14');
  });
});

describe('walk 11 — the header on a phone', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it('keeps the four daily tabs and Setup (no More menu), a Today/Tomorrow control, and the attention list as one line', async () => {
    window.matchMedia = ((query: string) => ({ ...original(query), matches: false })) as typeof window.matchMedia;
    routes((path) => (path.startsWith('/transport/board') ? board() : undefined));
    renderAs('TRANSPORTATION_DIRECTOR');
    expect(await screen.findByRole('button', { name: /need you/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull();
    // F500 G2: the day's four tabs, then one Setup tab for the fleet, drivers, stops, fares and charges.
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Today', 'Live map', 'Rides', 'Issues', 'Setup']);
    expect(screen.queryByRole('button', { name: 'More tabs' })).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Jump to' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /need you/ }));
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();
  });
});

describe('audit Tier 3 — the van list has a screen', () => {
  it('the Vans tab lists every van from /transport/vans, retired ones too, with their record a click away', async () => {
    routes((path) => {
      if (path.startsWith('/transport/board')) return board();
      if (path.startsWith('/transport/fleet')) return { from: '', to: '', vans: [] };
      if (path === '/transport/driver-access') return { rows: [], clients: [], drivers: [] };
      if (path === '/transport/vans') {
        return {
          vans: [
            { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12, isActive: true, notes: null, make: 'Ford', model: 'Transit', color: 'White', year: 2023, look: 'White Ford Transit 2023', outOfService: { since: at(-2), reason: 'brakes' }, papersDue: [], driver: { userId: 'mike', name: 'Mike Chen', associateId: null, phone: null } },
            { id: 'v9', name: 'Old Van', plate: null, capacity: 8, isActive: false, notes: null, make: null, model: null, color: null, year: null, look: '', outOfService: null, papersDue: [], driver: null },
          ],
        };
      }
    });
    renderAs('TRANSPORTATION_DIRECTOR', '/transport?tab=vans');
    const roster = await screen.findByRole('region', { name: 'All vans' });
    expect(await within(roster).findByText('Out of service · brakes')).toBeInTheDocument();
    expect(within(roster).getByText('Retired')).toBeInTheDocument();
    expect(within(roster).getAllByRole('button', { name: 'Record' }).length).toBeGreaterThan(0);
  });
});
