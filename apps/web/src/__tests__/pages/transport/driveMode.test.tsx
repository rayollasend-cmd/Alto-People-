import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { zonedDayKey } from '@/lib/format';
import type { DriverToday, Ride, RideRun } from '@/lib/transportApi';
import { renderAs } from '../hrPack/harness';

/**
 * Drive mode — the driver's home opens on NOW, and NOW has one gold
 * button that steps through the run:
 *
 *   Pre-trip (only when this van's check isn't done today) → Start run →
 *   Navigate to stop 1 → Arrived → All on board (No-show locked until the
 *   wait has passed, the clock showing) → … → the drop-off → hold to
 *   Complete run (a tap only asks).
 *
 * Below it: Later today, the runs that never ran as one line (never
 * "Planned"), and one count for the day. Offline taps keep their banner.
 */

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { ApiError, apiFetch } from '@/lib/api';
import { DriverHome } from '@/pages/transport/DriverHome';
import { didntRun, driveStep, planDay, preTripOwed } from '@/pages/transport/driver/driveModel';
import { useNavMemory } from '@/pages/transport/driver/driveKit';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = zonedDayKey(new Date(), tz);
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const min = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: min(90),
    serviceDate: today,
    status: 'SCHEDULED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: null,
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal Resort Holdings' },
    rider: { associateId: `a-${over.id}`, name: 'Maria Lopez', phone: '555-0100' },
    pickupOrder: 1,
    pickupAt: min(35),
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
  } as Ride;
}

/** Van 2, two riders at Seaside Housing and one at Gulf Pines, to the store. */
function run(over: Partial<RideRun> = {}, rides?: Ride[]): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: today,
    departAt: min(26),
    status: 'PLANNED',
    startedAt: null,
    endedAt: null,
    notes: null,
    van: { id: 'v2', name: 'Van 2', plate: 'ALT 102', capacity: 12 },
    driver: { userId: 'u1', name: 'Mike Chen' },
    seats: { taken: 3, capacity: 12 },
    rides: rides ?? [
      ride({ id: 'r1' }),
      ride({ id: 'r2', pickupOrder: 2, rider: { associateId: 'a-r2', name: 'Hannah Kowalski', phone: null } }),
      ride({ id: 'r3', pickupOrder: 3, pickupAt: min(47), rider: { associateId: 'a-r3', name: 'Jean-Baptiste Pierre', phone: null }, pickup: { kind: 'stop', id: 's2', name: 'Gulf Pines Apartments', address: '9 Gulf Pines Rd' } }),
    ],
    ...over,
  } as RideRun;
}

const active = (rides?: Ride[], over: Partial<RideRun> = {}) => run({ status: 'ACTIVE', startedAt: min(-5), departAt: min(-5), ...over }, rides);

function driverToday(over: Partial<DriverToday> = {}): DriverToday {
  return {
    date: today,
    associateId: 'a-mike',
    runs: { total: 4, done: 0, active: 0 },
    hours: { worked: 0, driven: 0, onClock: false },
    shifts: [],
    earnings: null,
    credentials: null,
    hoursOfService: { maxPerDay: 10, minRest: 8 },
    preTripRequired: true,
    ...over,
  } as DriverToday;
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(runs: RideRun[], handler: Handler = () => undefined, todayOver: Parameters<typeof driverToday>[0] = {}) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out !== undefined) return out as never;
    if (path === '/transport/driver/runs') return { today, runs } as never;
    if (path === '/transport/driver/today') return driverToday(todayOver) as never;
    if (path === '/transport/driver/requests') return { van: { id: 'v2', name: 'Van 2', plate: 'ALT 102', capacity: 12, look: '' }, requests: [] } as never;
    if (path === '/transport/driver/clients') return { all: { id: 'x', status: 'APPROVED' }, clients: [], approved: 0, pending: 0 } as never;
    if (path.startsWith('/transport/driver/schedule')) return { from: today, to: today, van: null, runs: [], asking: [] } as never;
    if (path.startsWith('/transport/driver/shifts')) return { associateId: 'a-mike', shifts: [] } as never;
    if (path === '/transport/driver/time') return { entries: [] } as never;
    return { run: null } as never;
  });
}

const posts = (path: string) => vi.mocked(apiFetch).mock.calls.filter(([p, init]) => p === path && (init as { method?: string } | undefined)?.method === 'POST');

/** Every gold control on the drive sheet — `btn-gold` is what Button's primary paints with. */
function gold(sheet: HTMLElement): string[] {
  return [...within(sheet).queryAllByRole('button'), ...within(sheet).queryAllByRole('link')]
    .filter((el) => el.className.split(/\s+/).includes('btn-gold'))
    .map((el) => el.textContent?.trim() ?? '');
}

const now = () => screen.findByTestId('drive-now');

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  Object.defineProperty(navigator, 'geolocation', { value: { watchPosition: vi.fn(() => 1), clearWatch: vi.fn(), getCurrentPosition: vi.fn() }, configurable: true });
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

/* ----- the model ----------------------------------------------------------------- */

describe('the drive model', () => {
  it('NOW is the run on the road, else the next one today; yesterday and the didn’t-run never are', () => {
    const swept = run({ id: 'swept', status: 'CANCELLED', notRun: true, departAt: min(-300) });
    const stale = run({ id: 'stale', departAt: min(-600) }, [ride({ id: 'x', targetAt: min(-560), pickupAt: min(-590) })]);
    const old = run({ id: 'old', serviceDate: yesterday, departAt: min(-1440) }, [ride({ id: 'y', targetAt: min(-1400), pickupAt: min(-1430) })]);
    const next = run({ id: 'next' });
    const later = run({ id: 'later', departAt: min(200) });
    const done = run({ id: 'done', status: 'COMPLETED', departAt: min(-120) }, [ride({ id: 'z', status: 'COMPLETED' })]);
    const plan = planDay([old, stale, swept, done, later, next], today);
    expect(plan.now?.id).toBe('next');
    expect(plan.later.map((r) => r.id)).toEqual(['later']);
    expect(plan.notRun.map((r) => r.id).sort()).toEqual(['old', 'stale', 'swept']);
    expect(didntRun(stale, Date.now())).toBe(true);
    // One count: today's runs that ran or will (3), one done, their riders.
    expect(plan.counts).toEqual({ total: 3, done: 1, riders: 7 });
    expect(planDay([next, active()], today).now?.status).toBe('ACTIVE');
  });

  it('the didn’t-run line is the sweep’s: 3 hours past leaving, never sooner — a late run whose date rolled over is still NOW; the runs count is the API’s when it sends one', () => {
    expect(didntRun(run({ departAt: min(-170) }), Date.now())).toBe(false);
    expect(didntRun(run({ departAt: min(-185) }), Date.now())).toBe(true);
    const lateLastNight = run({ id: 'late', serviceDate: yesterday, departAt: min(-60) });
    expect(didntRun(lateLastNight, Date.now())).toBe(false);
    expect(planDay([lateLastNight], today).now?.id).toBe('late');
    expect(didntRun(active([], { departAt: min(-600) }), Date.now())).toBe(false);
    const plan = planDay([run(), run({ id: 'b', departAt: min(90) })], today, Date.now(), { total: 4, done: 2 });
    expect(plan.counts).toEqual({ total: 4, done: 2, riders: 6 });
  });

  it('the pre-trip is owed once per van per day', () => {
    const r = run();
    expect(preTripOwed(r, [r], true)).toBe(true);
    expect(preTripOwed(r, [r], false)).toBe(false);
    expect(preTripOwed(run({ preTripDone: true }), [], true)).toBe(false);
    // Before the API says so: a passed check on the same van today counts.
    const earlier = run({ id: 'early', status: 'COMPLETED', preTrip: { passed: true, at: min(-200) } });
    expect(preTripOwed(r, [earlier, r], true)).toBe(false);
    expect(preTripOwed(r, [{ ...earlier, van: { ...earlier.van, id: 'v1' } }, r], true)).toBe(true);
  });

  it('steps: navigate → arrive → board → … → drop → complete; a tap still sending moves it on', () => {
    const none = { preTripOwed: false, marks: [], navigated: () => false };
    expect(driveStep(active(), none)).toMatchObject({ kind: 'navigate', n: 1, total: 2 });
    expect(driveStep(active(), { ...none, navigated: (k) => k === 'pickup:stop:s1' })).toMatchObject({ kind: 'arrive', n: 1 });
    const here = min(-1);
    const atStop = active([ride({ id: 'r1', vanArrivedAt: here }), ride({ id: 'r3', pickupOrder: 3, pickup: { kind: 'stop', id: 's2', name: 'Gulf Pines Apartments', address: '9 Gulf Pines Rd' } })]);
    expect(driveStep(atStop, none)).toMatchObject({ kind: 'board', n: 1, arrivedSent: true });
    // r1 marked on board in a dead spot: the card is already at stop 2.
    const queued = [{ kind: 'board' as const, id: 'r1', queuedAt: here }];
    expect(driveStep(atStop, { ...none, marks: queued })).toMatchObject({ kind: 'navigate', n: 2 });
    const aboard = active([ride({ id: 'r1', status: 'BOARDED' })]);
    expect(driveStep(aboard, none)).toMatchObject({ kind: 'drop' });
    expect(driveStep(aboard, { ...none, navigated: (k) => k === 'drop:store:l1' })).toEqual({ kind: 'complete' });
    // Everyone a no-show: nothing to drop off.
    expect(driveStep(active([ride({ id: 'r1', status: 'NO_SHOW' })]), none)).toEqual({ kind: 'complete' });
    expect(driveStep(run(), { ...none, preTripOwed: true })).toEqual({ kind: 'pretrip' });
  });
});

/* ----- the state machine on screen ------------------------------------------------------ */

describe('drive mode: one gold button a step', () => {
  it('before leaving: the countdown in big type, and Pre-trip when this van’s check isn’t done', async () => {
    routes([run()], (path, init) =>
      path === '/transport/driver/runs/run1/pre-trip' && !init?.method ? { required: true, items: [{ key: 'tires', label: 'Tires and wheels', safety: true }], check: null } : undefined,
    );
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(await within(sheet).findByText('Leaves in')).toBeInTheDocument();
    expect(within(sheet).getByTestId('drive-countdown')).toHaveTextContent(/^2[5-6] min$/);
    expect(sheet).toHaveTextContent('Van 2');
    // The client's name is noise when nothing needs telling apart.
    expect(sheet).not.toHaveTextContent('Coastal Resort Holdings');
    await waitFor(() => expect(gold(sheet)).toEqual(['Pre-trip check · Van 2']));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Pre-trip check · Van 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pre-trip check' });
    // From the step it records the check; Start run is the next step.
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('the van’s check already done today: Start run is the one gold button', async () => {
    routes([run({ preTripDone: true })], (path, init) => (path === '/transport/driver/runs/run1/start' && init?.method === 'POST' ? { run: active() } : undefined));
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    await waitFor(() => expect(gold(sheet)).toEqual(['Start run']));
    expect(within(sheet).getByText('Pre-trip done for Van 2 today')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(posts('/transport/driver/runs/run1/start')).toHaveLength(1));
  });

  it('on the road: Navigate to stop 1 leads; once directions open, Arrived does', async () => {
    routes([active()], (path, init) => (path === '/transport/driver/runs/run1/arrived' && init?.method === 'POST' ? { run: active(), evidence: null } : undefined));
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(gold(sheet)).toEqual(['Navigate to stop 1']);
    expect(within(sheet).getByText('Seaside Housing')).toBeInTheDocument();
    // The stop after this one is in view, with its directions.
    expect(within(sheet).getByRole('link', { name: 'Navigate: Gulf Pines Apartments' })).toBeInTheDocument();
    const nav = within(sheet).getByRole('link', { name: 'Navigate to stop 1' });
    expect(nav).toHaveAttribute('href', expect.stringContaining('100%20Seaside%20Dr'));
    fireEvent.click(nav);
    await waitFor(() => expect(gold(sheet)).toEqual(['Arrived at Seaside Housing']));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Arrived at Seaside Housing' }));
    await waitFor(() =>
      expect(posts('/transport/driver/runs/run1/arrived')[0]![1]).toMatchObject({ body: { rideIds: ['r1', 'r2'], idempotencyKey: expect.any(String) } }),
    );
  });

  it('at the stop: the riders as a checklist, All on board leads, No-show locked until the wait passes — with the clock', async () => {
    const arrived = new Date(Date.now() - 20_000).toISOString();
    routes(
      [active([ride({ id: 'r1', vanArrivedAt: arrived }), ride({ id: 'r2', pickupOrder: 2, vanArrivedAt: arrived, rider: { associateId: 'a-r2', name: 'Hannah Kowalski', phone: null } })])],
      (path, init) => (path === '/transport/driver/runs/run1/board-all' && init?.method === 'POST' ? { run: active(), boarded: ['r1', 'r2'], already: [] } : undefined),
    );
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(gold(sheet)).toEqual(['All on board · 2']);
    const rows = within(sheet).getAllByTestId('manifest-row');
    expect(rows.map((r) => within(r).getByText(/Maria L\.|Hannah K\./).textContent)).toEqual(['Maria L.', 'Hannah K.']);
    const noShow = within(rows[0]!).getByRole('button', { name: 'No-show: Maria Lopez' });
    expect(noShow).toBeDisabled();
    expect(noShow).toHaveTextContent(/No-show in 2:[34]\d/);
    expect(within(sheet).getByRole('timer')).toHaveTextContent(/No-show opens in 2:[34]\d/);
    await userEvent.click(within(sheet).getByRole('button', { name: 'All on board · 2' }));
    await waitFor(() => expect(posts('/transport/driver/runs/run1/board-all')[0]![1]).toMatchObject({ body: { rideIds: ['r1', 'r2'] } }));
  });

  it('after the wait the No-show opens, and still asks first (the fee is said)', async () => {
    const arrived = new Date(Date.now() - 4 * 60_000).toISOString();
    routes([active([ride({ id: 'r1', vanArrivedAt: arrived, riderSignal: { kind: 'LATE', at: min(-1) } })])], (path, init) =>
      path === '/transport/driver/rides/r1/no-show' && init?.method === 'POST' ? { ride: ride({ id: 'r1', status: 'NO_SHOW' }), evidence: null } : undefined,
    );
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(within(sheet).getByText('Running late')).toBeInTheDocument();
    const noShow = within(sheet).getByRole('button', { name: 'No-show: Maria Lopez' });
    expect(noShow).toBeEnabled();
    await userEvent.click(noShow);
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('$1.00 no-show fee');
    await userEvent.click(within(confirm).getByRole('button', { name: 'No-show' }));
    await waitFor(() => expect(posts('/transport/driver/rides/r1/no-show')).toHaveLength(1));
  });

  it('everyone picked up: Navigate to the drop-off leads; Complete waits, quiet, beneath it', async () => {
    routes([active([ride({ id: 'r1', status: 'BOARDED' })])]);
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(within(sheet).getByText('Drop off at Front Beach 218')).toBeInTheDocument();
    expect(gold(sheet)).toEqual(['Navigate to the drop-off']);
    expect(within(sheet).getByRole('button', { name: /Hold to complete run/ })).toBeInTheDocument();
  });

  it('Complete run needs the hold: a tap only asks, a hold completes', async () => {
    window.sessionStorage.setItem('alto:drive:nav:run1:drop:store:l1', '1');
    routes([active([ride({ id: 'r1', status: 'BOARDED' })])], (path, init) =>
      path === '/transport/driver/runs/run1/complete' && init?.method === 'POST' ? { run: active([ride({ id: 'r1', status: 'COMPLETED' })], { status: 'COMPLETED' }) } : undefined,
    );
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    const hold = within(sheet).getByRole('button', { name: /Hold to complete run/ });
    expect(gold(sheet)).toEqual(['Hold to complete run']);
    // A plain tap: a question, never the irreversible thing.
    await userEvent.click(hold);
    const ask = await screen.findByRole('dialog');
    expect(ask).toHaveTextContent('Complete this run?');
    expect(posts('/transport/driver/runs/run1/complete')).toHaveLength(0);
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    // Letting go early cancels.
    fireEvent.pointerDown(hold, { button: 0 });
    fireEvent.pointerUp(hold);
    await new Promise((r) => setTimeout(r, 1400));
    expect(posts('/transport/driver/runs/run1/complete')).toHaveLength(0);
    // Holding it through completes.
    fireEvent.pointerDown(hold, { button: 0 });
    await waitFor(() => expect(posts('/transport/driver/runs/run1/complete')).toHaveLength(1), { timeout: 3000 });
  });
});

/* ----- around NOW -------------------------------------------------------------------------- */

describe('drive mode: the day around NOW', () => {
  it('a tap with no signal: the card moves on and the banner counts it', async () => {
    const arrived = min(-1);
    routes([active([ride({ id: 'r1', vanArrivedAt: arrived }), ride({ id: 'r3', pickupOrder: 3, rider: { associateId: 'a-r3', name: 'Jean-Baptiste Pierre', phone: null }, pickup: { kind: 'stop', id: 's2', name: 'Gulf Pines Apartments', address: '9 Gulf Pines Rd' } })])]);
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await userEvent.click(within(sheet).getByRole('button', { name: 'On board: Maria Lopez' }));
    expect(await screen.findByTestId('pending-taps')).toHaveTextContent('1 tap waiting to send');
    expect(screen.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
    expect(posts('/transport/driver/rides/r1/board')).toHaveLength(0);
    // Stop 1 is done on this phone: stop 2 is next.
    await waitFor(() => expect(gold(sheet)).toEqual(['Navigate to stop 2']));
  });

  it('runs that never ran are history, never Planned at the top; the day has one count', async () => {
    const swept = run({ id: 'swept', status: 'CANCELLED', notRun: true, departAt: min(-400) }, [ride({ id: 'x', status: 'CANCELLED', targetAt: min(-340) })]);
    const old = run({ id: 'old', serviceDate: yesterday, departAt: min(-1500), van: { id: 'v1', name: 'Van 1', plate: null, capacity: 12 } }, [ride({ id: 'y', targetAt: min(-1440), pickupAt: min(-1480) })]);
    const done = run({ id: 'done', status: 'COMPLETED', departAt: min(-180) }, [ride({ id: 'z', status: 'COMPLETED', targetAt: min(-120) })]);
    const next = run({ id: 'next', departAt: min(40) });
    const later = run({ id: 'later', departAt: min(240), direction: 'FROM_WORK' }, [ride({ id: 'h1', direction: 'FROM_WORK', targetAt: min(240) })]);
    routes([old, swept, done, next, later]);
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    expect(sheet).toHaveAttribute('aria-label', expect.stringContaining('Van 2'));
    expect(await screen.findByTestId('day-line')).toHaveTextContent('Today: 1 of 3 runs done · 5 riders');
    const rest = screen.getByTestId('later-today');
    expect(within(rest).getByRole('heading', { name: 'Later today' })).toBeInTheDocument();
    expect(within(rest).getAllByRole('button')).toHaveLength(1);
    expect(within(rest).getByTestId('didnt-run')).toHaveTextContent(/Didn’t run:.*Van 1.*Van 2/);
    expect(screen.queryByText('Planned')).toBeNull();
  });

  it('the day’s runs line reads the API’s count (the same as /driver/today)', async () => {
    vi.mocked(apiFetch).mockReset();
    routes([run()], (path) => (path === '/transport/driver/runs' ? { today, runs: [run()], counts: { total: 4, done: 2, active: 0 } } : undefined));
    renderAs('DRIVER', <DriverHome />);
    expect(await screen.findByTestId('day-line')).toHaveTextContent('Today: 2 of 4 runs done · 3 riders');
  });

  it('Start refused for want of a check opens it; a check the van already passed today just starts', async () => {
    let started = 0;
    routes([run({ preTripDone: true })], (path, init) => {
      if (path === '/transport/driver/runs/run1/start' && init?.method === 'POST') {
        started += 1;
        if (started === 1) throw new ApiError(409, 'pretrip_required', 'Do the pre-trip check before the run leaves.');
        return { run: active() };
      }
      if (path === '/transport/driver/runs/run1/pre-trip' && !init?.method) return { required: true, items: [], check: null, done: true, fromOtherRun: true };
      return undefined;
    });
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pre-trip check' });
    expect(await within(dialog).findByText('Pre-trip done for Van 2 today')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(posts('/transport/driver/runs/run1/start')).toHaveLength(2));
  });

  it('an overlap is a calm warning on the run, with dispatch one tap away', async () => {
    const other = run({ id: 'run2', departAt: min(30), van: { id: 'v1', name: 'Van 1', plate: null, capacity: 12 } });
    const mine = run({ preTripDone: true, conflicts: [{ kind: 'driver', runId: 'run2', overlapMinutes: 20 }] });
    routes([mine, other], undefined, { dispatchPhone: '850-555-0199' });
    renderAs('DRIVER', <DriverHome />);
    const sheet = await now();
    const warn = await within(sheet).findByTestId('drive-conflicts');
    expect(warn).toHaveTextContent(/Overlaps your .* run on Van 1 — call dispatch\./);
    expect(within(warn).getByRole('link', { name: /Call dispatch/ })).toHaveAttribute('href', 'tel:850-555-0199');
    // Still one gold button on the sheet.
    expect(gold(sheet)).toEqual(['Start run']);
  });

  it('the day done: all done, and when the next run is', async () => {
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    routes([
      run({ id: 'done', status: 'COMPLETED', departAt: min(-180) }, [ride({ id: 'z', status: 'COMPLETED', targetAt: min(-120) })]),
      run({ id: 'tmrw', serviceDate: tomorrow, departAt: min(24 * 60) }),
    ]);
    renderAs('DRIVER', <DriverHome />);
    const done = await screen.findByTestId('drive-done');
    expect(done).toHaveTextContent('All done for today');
    expect(done).toHaveTextContent(/Next run: Tomorrow at .* · Van 2/);
    expect(screen.queryByTestId('drive-now')).toBeNull();
  });
});

describe('the stops the driver opened directions to', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('outlast the tab reloading while the map app had the screen, one run at a time', () => {
    const first = renderHook(() => useNavMemory('run-1'));
    act(() => first.result.current.remember('stop-a'));
    expect(first.result.current.navigated('stop-a')).toBe(true);
    first.unmount();

    // The phone reloaded the tab: a fresh mount reads the same memory.
    const again = renderHook(() => useNavMemory('run-1'));
    expect(again.result.current.navigated('stop-a')).toBe(true);
    expect(renderHook(() => useNavMemory('run-2')).result.current.navigated('stop-a')).toBe(false);
  });
});
