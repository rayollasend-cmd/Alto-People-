import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role, type TransportReadiness } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { ymdLocal } from '@/lib/format';
import type { Ride, RideRun, TransportBoard } from '@/lib/transportApi';

const hoisted = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));
// DESK-LIVE's queue and KPI row have their own tests; here they only need to hand the board a run or riders.
vi.mock('@/pages/transport/live/LiveOpsTab', () => ({
  LiveOpsTab: ({ onOpenRide }: { onOpenRide?: (ids: string[]) => void }) => (
    <div data-testid="live-ops">
      <button type="button" onClick={() => onOpenRide?.(['w1', 'w2'])}>
        Live: assign a van
      </button>
    </div>
  ),
}));
vi.mock('@/pages/transport/live/ExceptionsQueue', async (orig) => ({
  ...(await orig<typeof import('@/pages/transport/live/ExceptionsQueue')>()),
  ExceptionsQueue: ({ onOpenRun, onOpenRide }: { onOpenRun?: (id: string) => void; onOpenRide?: (ids: string[]) => void }) => (
    <div data-testid="exceptions-queue">
      <button type="button" onClick={() => onOpenRun?.('runC')}>
        Queue: open Van 2’s run
      </button>
      <button type="button" onClick={() => onOpenRun?.('another-day')}>
        Queue: open a run from another day
      </button>
      <button type="button" onClick={() => onOpenRide?.(['w1', 'w2'])}>
        Queue: riders without a van
      </button>
    </div>
  ),
}));
vi.mock('@/pages/transport/live/TransportKpiRow', () => ({ TransportKpiRow: () => <div data-testid="kpi-row" /> }));
vi.mock('@/lib/transportOpsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/transportOpsApi')>()),
  useMoveRide: () => ({ mutateAsync: hoisted.mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { TransportHome } from '@/pages/transport/TransportHome';

/**
 * The director's Today tab at Fortune-500 dispatch standard: the day in one
 * quiet line, tomorrow's readiness with its one primary action, run cards that
 * say who is double-booked and which runs didn't run, and riders moved between
 * runs by drag or by the Move to… menu — at once, rolled back on a refusal,
 * with Undo.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = ymdLocal();
const plusDay = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};
const tomorrow = plusDay(today, 1);
const H = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const VAN1 = { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 };
const VAN2 = { id: 'v2', name: 'Van 2', plate: 'ALT 102', capacity: 12 };
const VAN3 = { id: 'v3', name: 'Van 3', plate: 'ALT 103', capacity: 7 };
const MIKE = { userId: 'mike', name: 'Mike Chen' };
const TASHA = { userId: 'tasha', name: 'Tasha Grant' };

function ride(over: Partial<Ride> & { id: string; name?: string }): Ride {
  const { name, ...rest } = over;
  return {
    direction: 'TO_WORK',
    targetAt: H(3),
    serviceDate: today,
    status: 'REQUESTED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: null,
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
    rider: { associateId: `a-${over.id}`, name: name ?? 'Maria Lopez', phone: null },
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
    ...rest,
  };
}

function run(id: string, van: typeof VAN1, driver: typeof MIKE, departIn: number, riders: Ride[], over: Partial<RideRun> = {}): RideRun {
  const departAt = H(departIn);
  const rides = riders.map((r, i) => ({
    ...r,
    status: r.status === 'REQUESTED' ? ('SCHEDULED' as const) : r.status,
    pickupOrder: i + 1,
    pickupAt: H(departIn + 0.1 * (i + 1)),
    run: { id, status: over.status ?? ('PLANNED' as const), departAt, van: { ...van }, driver: { ...driver, associateId: null } },
  }));
  return {
    id,
    direction: 'TO_WORK',
    serviceDate: today,
    departAt,
    status: 'PLANNED',
    startedAt: null,
    endedAt: null,
    notes: null,
    van,
    driver,
    seats: { taken: rides.length, capacity: van.capacity },
    rides,
    ...over,
  };
}

/** Van 1 (Mike, 3 of 12, to work), Van 3 (Tasha, full 7 of 7), Van 2 (Mike again — the overlap), Van 2 home (Tasha), and a run that didn't run. */
function board(over: Partial<TransportBoard> = {}): TransportBoard {
  const runA = run('runA', VAN1, MIKE, 1, [ride({ id: 'a1', name: 'Hannah Kowalski' }), ride({ id: 'a2', name: 'Jean-Baptiste Pierre' }), ride({ id: 'a3', name: 'Luis Ortega' })], {
    conflicts: [{ kind: 'driver', runId: 'runC', overlapMinutes: 25 }],
  });
  const runB = run('runB', VAN3, TASHA, 1.2, Array.from({ length: 7 }, (_, i) => ride({ id: `b${i}`, name: `Rider B${i}` })), { conflicts: [] });
  const runC = run('runC', VAN2, MIKE, 1.6, [ride({ id: 'c1', name: 'Mehmet Yilmaz' })], { conflicts: [{ kind: 'driver', runId: 'runA', overlapMinutes: 25 }] });
  const runD = run('runD', VAN2, TASHA, 6, [ride({ id: 'd1', name: 'Kayla Robinson', direction: 'FROM_WORK', targetAt: H(6) })], { direction: 'FROM_WORK', conflicts: [] });
  const runE = run('runE', VAN3, MIKE, -6, [ride({ id: 'e1', name: 'Tamika Freeman', targetAt: H(-5) })], { status: 'CANCELLED', notRun: true, conflicts: [], notes: 'Didn’t run — the van never started' });
  runE.rides = runE.rides.map((r) => ({ ...r, status: 'CANCELLED', cancelReason: 'The van didn’t run' }));
  const runs = [runA, runB, runC, runD, runE];
  const waiting = [ride({ id: 'w1', name: 'Ana Silva' }), ride({ id: 'w2', name: 'Ben Ray' })];
  return {
    date: today,
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: null },
    kpis: { booked: 14, needsVan: 2, scheduled: 12, onBoard: 0, completed: 0, noShows: 0, cancelled: 1, vansOut: 0, runs: 4, openIssues: 0 },
    rides: [...waiting, ...runs.flatMap((r) => r.rides)],
    runs,
    vans: [VAN1, VAN2, VAN3].map((v) => ({ ...v, driverUserId: null })),
    drivers: [
      { userId: 'mike', name: 'Mike Chen', role: 'DRIVER', drivesByTrade: true, phone: '555-0101' },
      { userId: 'tasha', name: 'Tasha Grant', role: 'TRANSPORTATION_DIRECTOR', drivesByTrade: false, phone: null },
    ],
    ...over,
  };
}

const allOk: TransportReadiness['items'] = [
  { id: 'riders_placed', label: 'Every rider has a van', ok: true, count: 0, detail: 'Every booked rider has a van.', action: null },
  { id: 'seats', label: 'No van over its seats', ok: true, count: 0, detail: 'No van is booked past its seats.', action: null },
  { id: 'drivers_assigned_ok', label: 'Drivers free, rested, under hours', ok: true, count: 0, detail: 'Every driver is free.', action: null },
  { id: 'credentials', label: 'Drivers’ papers current', ok: true, count: 0, detail: 'Every driver’s papers are current.', action: null },
  { id: 'vans_ready', label: 'Vans ready', ok: true, count: 0, detail: 'Every van is in service.', action: null },
  { id: 'vans_double_booked', label: 'No van double-booked', ok: true, count: 0, detail: 'No van is on two runs at once.', action: null },
];
const readyTomorrow: TransportReadiness = { date: tomorrow, ready: true, riders: 31, runs: 4, items: allOk };
const notReadyTomorrow: TransportReadiness = {
  date: tomorrow,
  ready: false,
  riders: 31,
  runs: 4,
  items: allOk.map((i) =>
    i.id === 'riders_placed'
      ? { ...i, ok: false, count: 3, detail: '3 riders have no van yet.', action: { label: 'Plan tomorrow', kind: 'plan' as const } }
      : i.id === 'credentials'
        ? { ...i, ok: false, count: 1, detail: 'Mike Chen’s DOT medical card expired Oct 20.', action: { label: 'Open drivers', kind: 'open_setup_drivers' as const } }
        : i,
  ),
};

function renderAs(role: Role = 'TRANSPORTATION_DIRECTOR', url = `/transport?date=${today}`) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'transport@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
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
/** The page's side panels answer empty unless a test says otherwise. */
function routes(handler: Handler = () => undefined, opts: { readiness?: TransportReadiness } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out instanceof Error) throw out;
    if (out !== undefined) return out as never;
    if (path.startsWith('/transport/board')) return board() as never;
    if (path.startsWith('/transport/readiness')) return (opts.readiness ?? readyTomorrow) as never;
    if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] } as never;
    if (path.startsWith('/transport/ops')) return { date: today, timezone: tz, generatedAt: '', vans: [], exceptions: [], kpis: [], center: null } as never;
    if (path === '/transport/needs-you') return { total: 0, items: [] } as never;
    if (path.startsWith('/transport/trends')) return { weeks: [], note: '' } as never;
    if (path.startsWith('/transport/plan-map')) return { date: '', trips: [] } as never;
    if (path === '/transport/route') throw new ApiError(400, 'x', 'no route in tests');
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
  });
}

const runCard = (van: string, depart: string) => screen.getByRole('group', { name: `${van}, leaves ${timeOf(depart)}` });
const riderRow = (name: string) => screen.getAllByRole('button', { name })[0]!.closest('li')!;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  hoisted.mutateAsync.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('the day, in one quiet line', () => {
  it('says the day’s counts under its name — no tiles — then the queue and the KPI row', async () => {
    routes();
    renderAs();
    const line = await screen.findByTestId('transport-day-line');
    expect(line).toHaveTextContent(/^Today · .* · 14 booked · 0 of 4 vans out · 0 on board · 0 done$/);
    expect(screen.getByTestId('exceptions-queue')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-row')).toBeInTheDocument();
    expect(screen.queryByTestId('transport-kpis')).toBeNull();
  });
});

describe('the desk’s paperwork', () => {
  it('what the queue doesn’t carry is one quiet line under it — incidents, access requests — never the late vans twice', async () => {
    routes((path) =>
      path === '/transport/needs-you'
        ? {
            total: 4,
            items: [
              { key: 'late', label: 'Vans running late', count: 1, path: '/transport?tab=live', tone: 'warning' },
              { key: 'incidents', label: 'Incidents to review', count: 2, path: '/transport?tab=issues', tone: 'warning' },
              { key: 'access', label: 'Driver access requests', count: 1, path: '/transport?tab=vans', tone: 'info' },
            ],
          }
        : path.startsWith('/transport/issues') || path.startsWith('/transport/incidents') || path.startsWith('/transport/feedback')
          ? new Error('not in this test')
          : undefined,
    );
    renderAs();
    const line = await screen.findByRole('navigation', { name: 'Also waiting on you' });
    expect(line).toHaveTextContent('Also waiting on you: Incidents to review 2 · Driver access requests 1');
    expect(within(line).queryByText(/running late/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
    await userEvent.click(within(line).getByRole('button', { name: /Incidents to review/ }));
    expect(await screen.findByRole('tab', { name: /Issues/, selected: true })).toBeInTheDocument();
  });
});

describe('tomorrow’s readiness', () => {
  it('a ready day is one calm line, and the page has no primary button', async () => {
    routes();
    renderAs();
    const strip = await screen.findByRole('region', { name: 'Tomorrow’s readiness' });
    expect(strip).toHaveTextContent('ready: 31 riders on 4 runs, every check passed.');
    expect(within(strip).queryByRole('button')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(`/transport/readiness?date=${tomorrow}`);
    expect(document.querySelectorAll('.btn-gold')).toHaveLength(0);
  });

  it('riders without a van: the six checks as chips, what is wrong in words, and Plan tomorrow the one primary — it plans that day', async () => {
    const tomorrowBoard = board({ date: tomorrow, runs: [], rides: [ride({ id: 't1', serviceDate: tomorrow, targetAt: H(27) })] });
    routes(
      (path, init) => {
        if (path === `/transport/board?date=${tomorrow}`) return tomorrowBoard;
        if (path === '/transport/plan' && init?.method === 'POST') return { date: tomorrow, proposals: [], unplaced: [] };
      },
      { readiness: notReadyTomorrow },
    );
    renderAs();
    const strip = await screen.findByRole('region', { name: 'Tomorrow’s readiness' });
    expect(within(strip).getByRole('heading', { name: 'Tomorrow: 31 riders on 4 runs' })).toBeInTheDocument();
    const chips = within(strip).getByRole('list', { name: 'The checks' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(6);
    expect(within(chips).getByText(/Riders placed/)).toHaveTextContent('Riders placed· 3 — needs fixing');
    expect(within(chips).getByText(/^Seats/)).toHaveTextContent('Seats — ok');
    expect(within(strip).getByText('3 riders have no van yet.')).toBeInTheDocument();
    expect(within(strip).getByText('Mike Chen’s DOT medical card expired Oct 20.')).toBeInTheDocument();
    // One gold button on the screen: Plan tomorrow. "Plan runs" for today's waiting riders is secondary.
    expect(document.querySelectorAll('.btn-gold')).toHaveLength(1);
    expect(within(strip).getByRole('button', { name: 'Plan tomorrow' })).toHaveClass('btn-gold');
    expect(screen.getByRole('button', { name: 'Plan runs' })).not.toHaveClass('btn-gold');

    await userEvent.click(within(strip).getByRole('button', { name: 'Plan tomorrow' }));
    expect(await screen.findByRole('dialog', { name: 'Plan runs' })).toBeInTheDocument();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/plan', { method: 'POST', body: { date: tomorrow } }));
  });

  it('a fix opens where it is fixed — Open drivers goes to Setup › Drivers', async () => {
    routes((path) => (path.startsWith('/transport/drivers') || path.startsWith('/transport/driver-shifts') ? new Error('not in this test') : undefined), { readiness: notReadyTomorrow });
    renderAs();
    const strip = await screen.findByRole('region', { name: 'Tomorrow’s readiness' });
    await userEvent.click(within(strip).getByRole('button', { name: 'Open drivers' }));
    expect(await screen.findByRole('tab', { name: 'Setup', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Drivers', checked: true })).toBeInTheDocument();
  });

  it('on tomorrow’s own board the strip is that day’s, and it is not shown for a day gone by', async () => {
    routes((path) => (path === `/transport/board?date=${tomorrow}` ? board({ date: tomorrow }) : path === `/transport/board?date=${plusDay(today, -1)}` ? board({ date: plusDay(today, -1) }) : undefined));
    const first = renderAs('TRANSPORTATION_DIRECTOR', `/transport?date=${tomorrow}`);
    expect(await screen.findByRole('region', { name: 'Tomorrow’s readiness' })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(`/transport/readiness?date=${tomorrow}`);
    first.unmount();
    renderAs('TRANSPORTATION_DIRECTOR', `/transport?date=${plusDay(today, -1)}`);
    await screen.findByTestId('transport-day-line');
    expect(screen.queryByRole('region', { name: /readiness/ })).toBeNull();
  });
});

describe('run cards', () => {
  it('a double-booked driver is a caution line naming the other run, which it opens; the Gantt bar says the same', async () => {
    routes();
    renderAs();
    const b = board();
    const runA = b.runs.find((r) => r.id === 'runA')!;
    const runC = b.runs.find((r) => r.id === 'runC')!;
    const cardA = await screen.findByRole('group', { name: `Van 1, leaves ${timeOf(runA.departAt)}` });
    const line = within(cardA).getByRole('button', { name: `Mike is also on Van 2 at ${timeOf(runC.departAt)} — 25 min overlap. Show that run.` });
    await userEvent.click(line);
    const cardC = runCard('Van 2', runC.departAt);
    expect(cardC.scrollIntoView).toHaveBeenCalled();
    expect(cardC.className).toMatch(/outline-accent/);
    // The bars: the double-booked colour, and the words.
    const timeline = screen.getByRole('region', { name: 'Vans by the hour' });
    expect(within(timeline).getByRole('button', { name: new RegExp(`Van 1 run leaving ${timeOf(runA.departAt)}, 3/12 seats, double-booked: Mike is also on Van 2`) })).toHaveClass('bg-alert');
  });

  it('without the server’s conflicts, the board’s own overlap rule finds the clash and measures it', async () => {
    const b = board();
    // Van 1 leaves in an hour, Van 2 in 1.6 h: both Mike's, each holds its van 15 min before to 2 h after: 1h 39m together.
    const plain = { ...b, runs: b.runs.map((r) => ({ ...r, conflicts: undefined })) };
    routes((path) => (path.startsWith('/transport/board') ? plain : undefined));
    renderAs();
    const runA = plain.runs.find((r) => r.id === 'runA')!;
    const runC = plain.runs.find((r) => r.id === 'runC')!;
    const cardA = await screen.findByRole('group', { name: `Van 1, leaves ${timeOf(runA.departAt)}` });
    expect(within(cardA).getByText(`Mike is also on Van 2 at ${timeOf(runC.departAt)} — 1h 39m overlap`)).toBeInTheDocument();
  });

  it('a run that didn’t run is muted, says so, keeps its riders, and offers nothing to do', async () => {
    routes();
    renderAs();
    const runE = board().runs.find((r) => r.id === 'runE')!;
    const card = await screen.findByRole('group', { name: `Van 3, leaves ${timeOf(runE.departAt)}` });
    expect(within(card).getByText('Didn’t run')).toBeInTheDocument();
    expect(within(card).queryByText('Planned')).toBeNull();
    expect(within(card).getByText(/Nobody started this run, so it was closed\. Its rider was told and isn’t charged\./)).toBeInTheDocument();
    expect(within(card).getByText('Tamika Freeman')).toBeInTheDocument();
    expect(within(card).getByText(/was to leave/)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Edit run|Call off|Message riders|Move|Cancel/ })).toBeNull();
    // Not the sweep's note twice.
    expect(within(card).queryByText(/the van never started/)).toBeNull();
  });

  it('a planned run past its departure that never started reads “Not started”, not “Planned”', async () => {
    const b = board();
    const late = { ...b.runs[0]!, id: 'runL', departAt: H(-2), conflicts: [] };
    routes((path) => (path.startsWith('/transport/board') ? { ...b, runs: [late] } : undefined));
    renderAs();
    const card = await screen.findByRole('group', { name: `Van 1, leaves ${timeOf(late.departAt)}` });
    expect(within(card).getByText('Not started')).toBeInTheDocument();
    expect(within(card).queryByText('Planned')).toBeNull();
  });
});

describe('drag to dispatch', () => {
  it('a rider dragged onto a run: the card says the seats after, the move shows at once, and Undo moves them back', async () => {
    routes();
    let land!: (v: unknown) => void;
    hoisted.mutateAsync.mockImplementationOnce(() => new Promise((r) => (land = r)));
    hoisted.mutateAsync.mockResolvedValue({ rideId: 'w1', fromRunId: 'runA', toRunId: null, seats: null, warnings: [] });
    renderAs();
    const runA = board().runs.find((r) => r.id === 'runA')!;
    const waiting = await screen.findByRole('region', { name: 'Needs a van' });
    const row = within(waiting).getByRole('button', { name: 'Ana Silva' }).closest('li')!;
    expect(row).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(row);
    const card = runCard('Van 1', runA.departAt);
    fireEvent.dragOver(card);
    expect(within(card).getByRole('note')).toHaveTextContent('Drop to move Ana here · 4 of 12 seats after');
    fireEvent.drop(card);

    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledWith({ rideId: 'w1', toRunId: 'runA' }));
    // Optimistic: on Van 1's card before the server answers.
    expect(within(runCard('Van 1', runA.departAt)).getByText('Ana Silva')).toBeInTheDocument();
    expect(within(runCard('Van 1', runA.departAt)).getByText('4/12 seats')).toBeInTheDocument();
    land({ rideId: 'w1', fromRunId: null, toRunId: 'runA', seats: { taken: 4, capacity: 12 }, warnings: [] });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Ana moved to Van 1 · 4 of 12 seats', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })));
    const undo = (vi.mocked(toast.success).mock.calls[0]![1] as unknown as { action: { onClick: () => void } }).action;
    undo.onClick();
    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenLastCalledWith({ rideId: 'w1', toRunId: null }));
    await waitFor(() => expect(toast.success).toHaveBeenLastCalledWith('Ana back on Needs a van', expect.anything()));
  });

  it('a run that can’t take them says why while they hover, and the drop is refused in words', async () => {
    routes();
    renderAs();
    const b = board();
    const runB = b.runs.find((r) => r.id === 'runB')!;
    const runD = b.runs.find((r) => r.id === 'runD')!;
    await screen.findByRole('region', { name: 'Needs a van' });
    fireEvent.dragStart(riderRow('Ana Silva'));
    // Full.
    const full = runCard('Van 3', runB.departAt);
    fireEvent.dragOver(full);
    expect(within(full).getByRole('note')).toHaveTextContent('Can’t take Ana: Van 3 is full — 7 of 7 seats taken.');
    fireEvent.drop(full);
    expect(toast.error).toHaveBeenCalledWith('Can’t move Ana', { description: 'Van 3 is full — 7 of 7 seats taken.' });
    // The other way.
    fireEvent.dragStart(riderRow('Ana Silva'));
    const home = runCard('Van 2', runD.departAt);
    fireEvent.dragOver(home);
    expect(within(home).getByRole('note')).toHaveTextContent('Can’t take Ana: Van 2 goes home from work — Ana’s ride is to work.');
    fireEvent.drop(home);
    expect(hoisted.mutateAsync).not.toHaveBeenCalled();
  });

  it('a refusal from the server puts the rider back and says why', async () => {
    routes();
    hoisted.mutateAsync.mockRejectedValue(new ApiError(409, 'van_full', 'Van 1 was filled by another dispatcher.'));
    renderAs();
    const runA = board().runs.find((r) => r.id === 'runA')!;
    await screen.findByRole('region', { name: 'Needs a van' });
    fireEvent.dragStart(riderRow('Ana Silva'));
    fireEvent.drop(runCard('Van 1', runA.departAt));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t move Ana', { description: 'Van 1 was filled by another dispatcher.' }));
    expect(within(screen.getByRole('region', { name: 'Needs a van' })).getByText('Ana Silva')).toBeInTheDocument();
    expect(within(runCard('Van 1', runA.departAt)).queryByText('Ana Silva')).toBeNull();
    expect(within(runCard('Van 1', runA.departAt)).getByText('3/12 seats')).toBeInTheDocument();
  });

  it('dragged off a run onto Needs a van, they wait for a van again', async () => {
    routes();
    hoisted.mutateAsync.mockResolvedValue({ rideId: 'a1', fromRunId: 'runA', toRunId: null, seats: null, warnings: [] });
    renderAs();
    await screen.findByRole('region', { name: 'Needs a van' });
    fireEvent.dragStart(riderRow('Hannah Kowalski'));
    const waiting = screen.getByRole('region', { name: 'Needs a van' });
    fireEvent.dragOver(waiting);
    expect(within(waiting).getByRole('note')).toHaveTextContent('Drop to take Hannah off their run — back to needing a van');
    fireEvent.drop(waiting);
    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledWith({ rideId: 'a1', toRunId: null }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Hannah back on Needs a van', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })));
  });
});

describe('Move to… — the keyboard and touch way to make the same move', () => {
  it('lists the runs going the same way with their seats after; a full one is there but can’t be picked; the other way isn’t offered', async () => {
    routes();
    hoisted.mutateAsync.mockResolvedValue({ rideId: 'w1', fromRunId: null, toRunId: 'runC', seats: { taken: 2, capacity: 12 }, warnings: ['Van 2 leaves in 20 minutes.'] });
    renderAs();
    const b = board();
    const runA = b.runs.find((r) => r.id === 'runA')!;
    const runC = b.runs.find((r) => r.id === 'runC')!;
    const waiting = await screen.findByRole('region', { name: 'Needs a van' });
    await userEvent.click(within(waiting).getByRole('button', { name: 'Move Ana Silva' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: `Van 1, leaves ${timeOf(runA.departAt)}, Mike Chen, 4 of 12 seats after the move` })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /^Van 3, .*: Van 3 is full — 7 of 7 seats taken\.$/ })).toHaveAttribute('data-disabled');
    expect(within(menu).queryByRole('menuitem', { name: /Kayla|home/i })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Back to Needs a van' })).toBeNull();
    await userEvent.click(within(menu).getByRole('menuitem', { name: new RegExp(`^Van 2, leaves ${timeOf(runC.departAt)}`) }));
    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledWith({ rideId: 'w1', toRunId: 'runC' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Ana moved to Van 2 · 2 of 12 seats', expect.objectContaining({ description: 'Van 2 leaves in 20 minutes.' })),
    );
  });

  it('a rider on a run can go back to Needs a van', async () => {
    routes();
    hoisted.mutateAsync.mockResolvedValue({ rideId: 'c1', fromRunId: 'runC', toRunId: null, seats: null, warnings: [] });
    renderAs();
    const runC = board().runs.find((r) => r.id === 'runC')!;
    await screen.findByRole('region', { name: 'Runs' });
    await userEvent.click(within(runCard('Van 2', runC.departAt)).getByRole('button', { name: 'Move Mehmet Yilmaz' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Back to Needs a van' }));
    await waitFor(() => expect(hoisted.mutateAsync).toHaveBeenCalledWith({ rideId: 'c1', toRunId: null }));
  });

  it('a viewer without manage sees no drag, no Move and no Cancel', async () => {
    routes();
    renderAs('EXECUTIVE_CHAIRMAN');
    const waiting = await screen.findByRole('region', { name: 'Needs a van' });
    expect(within(waiting).getByText('Ana Silva').closest('li')).not.toHaveAttribute('draggable');
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
  });
});

describe('the exceptions queue, wired to the board', () => {
  it('“open the run” scrolls to that run’s card and lights it; “riders without a van” opens their dispatch', async () => {
    routes();
    renderAs();
    const runC = board().runs.find((r) => r.id === 'runC')!;
    await userEvent.click(await screen.findByRole('button', { name: 'Queue: open Van 2’s run' }));
    const card = runCard('Van 2', runC.departAt);
    expect(card.scrollIntoView).toHaveBeenCalled();
    expect(card.className).toMatch(/outline-accent/);
    await userEvent.click(screen.getByRole('button', { name: 'Queue: riders without a van' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dispatch a van' });
    expect(within(dialog).getByText('Ana Silva')).toBeInTheDocument();
    expect(within(dialog).getByText('Ben Ray')).toBeInTheDocument();
  });

  it('a run that isn’t on this day’s board opens on the live map', async () => {
    routes();
    renderAs();
    await userEvent.click(await screen.findByRole('button', { name: 'Queue: open a run from another day' }));
    expect(await screen.findByRole('tab', { name: 'Live map', selected: true })).toBeInTheDocument();
    expect(screen.getByTestId('live-ops')).toBeInTheDocument();
  });
});

describe('links into the desk', () => {
  it('the live map’s “Assign a van” opens the dispatch for those riders over the map', async () => {
    routes();
    renderAs('TRANSPORTATION_DIRECTOR', `/transport?tab=live&date=${today}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Live: assign a van' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dispatch a van' });
    expect(within(dialog).getByText('Ana Silva')).toBeInTheDocument();
    // Still on the map underneath (the dialog hides the rest from the accessibility tree).
    expect(screen.getByRole('tab', { name: 'Live map', selected: true, hidden: true })).toBeInTheDocument();
    expect(screen.getByTestId('live-ops')).toBeInTheDocument();
  });

  it('?run= on Today lands on that run’s card; a run not on the board says so', async () => {
    routes();
    const runC = board().runs.find((r) => r.id === 'runC')!;
    const first = renderAs('TRANSPORTATION_DIRECTOR', `/transport?date=${today}&run=runC`);
    await waitFor(() => expect(runCard('Van 2', runC.departAt).scrollIntoView).toHaveBeenCalled());
    expect(runCard('Van 2', runC.departAt).className).toMatch(/outline-accent/);
    first.unmount();
    renderAs('TRANSPORTATION_DIRECTOR', `/transport?date=${today}&run=gone`);
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('That run isn’t on today’s board.'));
  });

  it('?issue= on Issues scrolls to that report and lights it — in Resolved when it was closed meanwhile', async () => {
    const issue = (id: string, status: 'OPEN' | 'RESOLVED', body: string) => ({
      id,
      category: 'LATE_VAN',
      body,
      status,
      resolution: status === 'RESOLVED' ? 'Talked to the driver.' : null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      reportedBy: { userId: 'u1', name: 'Maria Lopez', role: 'ASSOCIATE' },
      ride: null,
      run: null,
    });
    routes((path) => {
      if (path === '/transport/issues') return { issues: [issue('i1', 'OPEN', 'The van was late again.'), issue('i2', 'OPEN', 'Nobody came to Gulf Pines.')] };
      if (path === '/transport/issues?status=RESOLVED') return { issues: [issue('i9', 'RESOLVED', 'Driver was rude.')] };
      if (path.startsWith('/transport/incidents') || path.startsWith('/transport/feedback')) return new Error('not in this test');
    });
    const first = renderAs('TRANSPORTATION_DIRECTOR', '/transport?tab=issues&issue=i2');
    const card = (await screen.findByText('Nobody came to Gulf Pines.')).closest('[data-issue-id]') as HTMLElement;
    await waitFor(() => expect(card.scrollIntoView).toHaveBeenCalled());
    expect(card.className).toMatch(/outline-accent/);
    first.unmount();
    renderAs('TRANSPORTATION_DIRECTOR', '/transport?tab=issues&issue=i9');
    const closed = (await screen.findByText('Driver was rude.')).closest('[data-issue-id]') as HTMLElement;
    await waitFor(() => expect(closed.className).toMatch(/outline-accent/));
    expect(screen.getByRole('radio', { name: 'Resolved', checked: true })).toBeInTheDocument();
  });
});

describe('the Rides tab', () => {
  it('“Didn’t run” is a status of its own; Cancel only for a ride that can still be stopped', async () => {
    const future = ride({ id: 'f1', name: 'Future Rider', status: 'SCHEDULED', targetAt: H(20), run: { id: 'runA', status: 'PLANNED', departAt: H(19), van: VAN1, driver: { ...MIKE, associateId: null } } });
    const waitingFuture = ride({ id: 'f2', name: 'Waiting Rider', targetAt: H(20) });
    const past = ride({ id: 'p1', name: 'Past Rider', status: 'SCHEDULED', targetAt: H(-3), run: { id: 'runX', status: 'PLANNED', departAt: H(-4), van: VAN1, driver: { ...MIKE, associateId: null } } });
    const outNow = ride({ id: 'o1', name: 'Onroad Rider', status: 'SCHEDULED', targetAt: H(1), run: { id: 'runY', status: 'ACTIVE', departAt: H(-0.2), van: VAN2, driver: { ...MIKE, associateId: null } } });
    const done = ride({ id: 'd1', name: 'Done Rider', status: 'COMPLETED', targetAt: H(-30) });
    const didntRun = ride({ id: 'n1', name: 'Notrun Rider', status: 'CANCELLED', cancelReason: 'The van didn’t run', targetAt: H(-6) });
    routes((path) => (path.startsWith('/transport/rides') ? { rides: [future, waitingFuture, past, outNow, done, didntRun] } : undefined));
    renderAs('TRANSPORTATION_DIRECTOR', '/transport?tab=rides');
    const table = await screen.findByRole('table');
    const rowOf = (name: string) => within(table).getByRole('button', { name }).closest('tr')!;
    expect(within(rowOf('Future Rider')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(rowOf('Waiting Rider')).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(rowOf('Past Rider')).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(rowOf('Onroad Rider')).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(rowOf('Done Rider')).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(rowOf('Notrun Rider')).queryByRole('button', { name: 'Cancel' })).toBeNull();
    // In words, on the palette's chips.
    expect(within(rowOf('Notrun Rider')).getByText('Didn’t run')).toBeInTheDocument();
    const chip = (name: string, words: string) => within(rowOf(name)).getByText(words).closest('.rounded-full');
    expect(chip('Future Rider', 'On a van')).toHaveClass('bg-info-100');
    expect(chip('Waiting Rider', 'Needs a van')).toHaveClass('bg-caution-100');
    expect(chip('Done Rider', 'Done')).toHaveClass('bg-positive-100');
    expect(chip('Notrun Rider', 'Didn’t run')).not.toHaveClass('bg-negative-100');
  });
});
