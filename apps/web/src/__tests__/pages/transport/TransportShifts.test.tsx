import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { zonedDayKey } from '@/lib/format';
import type { DriverWeek, MyTransport, Ride, ShiftTrip } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { apiFetch } from '@/lib/api';
import { RideHome } from '@/pages/transport/RideHome';
import { RideStrip } from '@/pages/transport/RideStrip';
import { DriverHome } from '@/pages/transport/DriverHome';

/**
 * Planning ahead by shift: book the store shift you work (seats left, or
 * the waitlist you'd join), see where you stand in line and who you ride
 * with (faces, no names), your rides like a schedule; drivers see their
 * week with riders by name.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
const day = (h: number) => zonedDayKey(at(h), tz);
const WINDOWS = [
  { label: 'Morning', startMinute: 360, endMinute: 840 },
  { label: 'Swing', startMinute: 840, endMinute: 1320 },
];

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: at(40),
    serviceDate: day(40),
    status: 'REQUESTED',
    shiftId: null,
    windowLabel: 'Morning',
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
    acceptedAt: null,
    declines: 0,
    allDeclined: false,
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
    stores: [{ id: 'l1', name: 'Front Beach 218', timezone: tz, clientName: 'Coastal', address: null, windows: WINDOWS }],
    shifts: [],
    rides: [],
    defaultPickup: { kind: 'stop', stopId: 's1', label: 'Seaside Housing' },
    defaultStoreId: 'l1',
    charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: null },
    ...over,
  };
}

function renderAs(role: Role, ui: React.ReactElement) {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: 'a' },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
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

const trip = (windowLabel: string, direction: ShiftTrip['direction'], over: Partial<ShiftTrip> = {}): ShiftTrip => ({
  windowLabel,
  direction,
  targetAt: at(40),
  bookable: true,
  vans: 0,
  seats: null,
  full: false,
  waiting: 0,
  ...over,
});

describe('booking by shift', () => {
  it('picks the shift you work — seats left, or the waitlist you’d join — and books it by shift', async () => {
    const posted: unknown[] = [];
    routes((path, init) => {
      if (path === '/transport/me') return me();
      if (path.startsWith('/transport/me/trips?')) {
        return {
          windows: WINDOWS,
          trips: [
            trip('Morning', 'TO_WORK', { vans: 1, seats: { capacity: 12, taken: 12 }, full: true, waiting: 2 }),
            trip('Morning', 'FROM_WORK', { vans: 1, seats: { capacity: 12, taken: 9 } }),
            trip('Swing', 'TO_WORK'),
            trip('Swing', 'FROM_WORK'),
          ],
        };
      }
      if (path === '/transport/me/rides' && init?.method === 'POST') {
        posted.push(init.body);
        return { ride: ride({ id: `r${posted.length}`, waitlist: { position: 3, of: 3 } }) };
      }
    });
    renderAs('ASSOCIATE', <RideHome />);
    await userEvent.click((await screen.findAllByRole('button', { name: /Request a seat/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'To work' }));
    const shifts = within(dialog).getByRole('radiogroup', { name: 'Which shift?' });
    const morning = within(shifts).getByRole('radio', { name: /Morning/ });
    expect(await within(morning).findByText('Full — waitlist #3')).toBeInTheDocument();
    // A shift with nothing to report is its name and hours, one line. Its
    // "Open — a driver will take it", repeated on every shift and every
    // leg, filled a phone and pushed the Book button off the screen.
    expect(within(shifts).getByRole('radio', { name: /Swing/ })).not.toHaveTextContent(/driver will take it/);
    // Time inputs are for "Other time" only.
    expect(within(dialog).queryByLabelText(/Be at work by/)).not.toBeInTheDocument();

    // Re-query rather than reusing `morning`: the trips query resolving
    // between the two lines re-renders the group, and clicking the node
    // captured before that lands on a detached element — the whole
    // booking silently does nothing, which is how this test flaked.
    await userEvent.click(
      within(within(dialog).getByRole('radiogroup', { name: 'Which shift?' })).getByRole('radio', {
        name: /Morning/,
      }),
    );
    expect(within(dialog).getByText(/you’ll be #3 on the waitlist/)).toBeInTheDocument();
    const join = within(dialog).getByRole('button', { name: 'Join the waitlist' });
    await waitFor(() => expect(join).toBeEnabled());
    await userEvent.click(join);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ direction: 'TO_WORK', locationId: 'l1', stopId: 's1', windowLabel: 'Morning' });
    expect(posted[0]).not.toHaveProperty('targetAt');

    // The way home has seats left.
    await userEvent.click((await screen.findAllByRole('button', { name: /Request a seat/ }))[0]!);
    const again = await screen.findByRole('dialog');
    await userEvent.click(within(again).getByRole('radio', { name: 'Home' }));
    expect(await within(again).findByText('3 seats left')).toBeInTheDocument();
  });

  it('“Other time” brings back the clock for the exceptions', async () => {
    routes((path) => {
      if (path === '/transport/me') return me();
      if (path.startsWith('/transport/me/trips?')) return { windows: WINDOWS, trips: [] };
    });
    renderAs('ASSOCIATE', <RideHome />);
    await userEvent.click((await screen.findAllByRole('button', { name: /Request a seat/ }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /Other time/ }));
    expect(within(dialog).getByLabelText(/Be at work by/)).toBeInTheDocument();
  });

  it('one tap from Home books a scheduled shift by its store shift', async () => {
    const posted: Array<Record<string, unknown>> = [];
    // A shift that starts at 6:00 AM store time, two days out.
    const d = day(48);
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    const start = new Date(y, m - 1, dd, 6, 0, 0);
    const shift = { id: 'sh1', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * H).toISOString(), position: 'Stocker', locationId: 'l1' };
    routes((path, init) => {
      if (path === '/transport/me') return me({ shifts: [shift] });
      if (path === '/transport/me/rides' && init?.method === 'POST') {
        posted.push(init.body as Record<string, unknown>);
        return { ride: ride({ id: `n${posted.length}` }) };
      }
    });
    renderAs('ASSOCIATE', <RideStrip />);
    await userEvent.click(await screen.findByRole('button', { name: /Round trip/ }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((b) => [b.direction, b.windowLabel, b.date])).toEqual([
      ['TO_WORK', 'Morning', d],
      ['FROM_WORK', 'Morning', d],
    ]);
  });
});

describe('where you stand, and who you ride with', () => {
  it('a full shift: “On the waitlist · #2”, the line, and the calendar marks it', async () => {
    const r = ride({ id: 'r1', waitlist: { position: 2, of: 3 }, seats: { capacity: 12, taken: 12 } });
    routes((path) => (path === '/transport/me' ? me({ rides: [r] }) : undefined));
    renderAs('ASSOCIATE', <RideHome />);
    const hero = await screen.findByRole('region', { name: 'Your next ride' });
    expect(within(hero).getByText('On the waitlist · #2')).toBeInTheDocument();
    expect(within(hero).getByText(/You’re #2 of 3 — the first seat that opens is yours automatically/)).toBeInTheDocument();
    expect(within(hero).getByText(/Morning shift/)).toBeInTheDocument();
    const calendar = screen.getByRole('tablist', { name: 'Your rides' });
    expect(within(calendar).getAllByRole('tab').length).toBeGreaterThanOrEqual(7);
    expect(screen.getAllByText('Waitlist #2').length).toBeGreaterThan(0);
  });

  it('on a van: the faces they ride with — never names — and the seats', async () => {
    const r = ride({
      id: 'r1',
      status: 'SCHEDULED',
      pickupAt: at(39.5),
      run: {
        id: 'run1',
        status: 'PLANNED',
        departAt: at(39.3),
        van: { id: 'v1', name: 'Van 1', plate: 'ALT 101' },
        driver: { userId: 'd1', name: 'Mike Chen', associateId: null },
      },
      seats: { capacity: 12, taken: 9 },
      coRiders: [{ photoUrl: '/api/associates/x/photo' }, { photoUrl: null }],
    });
    routes((path) => (path === '/transport/me' ? me({ rides: [r] }) : undefined));
    renderAs('ASSOCIATE', <RideHome />);
    const hero = await screen.findByRole('region', { name: 'Your next ride' });
    expect(within(hero).getByText('2 riding with you · 9 of 12 seats taken')).toBeInTheDocument();
  });

  it('the calendar: a strip of days, each day’s rides under it', async () => {
    const soon = ride({ id: 'a', targetAt: at(20) });
    const later = ride({ id: 'b', targetAt: at(20 + 72), windowLabel: 'Swing', direction: 'FROM_WORK' });
    routes((path) => (path === '/transport/me' ? me({ rides: [soon, later] }) : undefined));
    renderAs('ASSOCIATE', <RideHome />);
    const calendar = await screen.findByRole('tablist', { name: 'Your rides' });
    const target = new Date(later.targetAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    await userEvent.click(within(calendar).getByRole('tab', { name: new RegExp(`^${target}`) }));
    expect(await screen.findByText(/Home from work · Front Beach 218 · Swing shift/)).toBeInTheDocument();
  });
});

describe('the driver’s week', () => {
  it('each day’s runs — the shift, seats, riders by name in pickup order — and the shifts still asking', async () => {
    const d = day(0);
    const week: DriverWeek = {
      from: d,
      to: day(24 * 6),
      van: { name: 'Van 1', plate: 'ALT 101', capacity: 12 },
      runs: [
        {
          id: 'run1',
          status: 'PLANNED',
          direction: 'TO_WORK',
          serviceDate: d,
          departAt: at(2),
          timezone: tz,
          shift: 'Morning',
          stores: ['Front Beach 218'],
          van: { name: 'Van 1', plate: 'ALT 101', capacity: 12 },
          seats: { taken: 2, capacity: 12 },
          riders: [
            { rideId: 'r1', associateId: 'a1', name: 'Ann Lee', photoUrl: null, pickupAt: at(2.2), place: 'Seaside Housing', status: 'SCHEDULED' },
            { rideId: 'r2', associateId: 'a2', name: 'Bo Ray', photoUrl: null, pickupAt: at(2.4), place: '9 Harbor Rd', status: 'SCHEDULED' },
          ],
        },
      ],
      asking: [{ serviceDate: d, direction: 'FROM_WORK', windowLabel: 'Morning', targetAt: at(10), store: { id: 'l1', name: 'Front Beach 218', timezone: tz }, count: 3 }],
    };
    routes((path) => {
      if (path === '/transport/driver/runs') return { today: d, runs: [] };
      if (path === '/transport/driver/requests') return { van: null, requests: [] };
      if (path.startsWith('/transport/driver/schedule?')) return week;
    });
    renderAs('DRIVER', <DriverHome />);
    await screen.findByRole('tablist', { name: 'Your week' });
    expect(screen.getAllByText(/Morning shift/).length).toBeGreaterThan(0);
    expect(screen.getByText('2/12 seats')).toBeInTheDocument();
    const names = screen.getAllByRole('button', { name: /Ann Lee|Bo Ray/ }).map((b) => b.textContent);
    expect(names[0]).toContain('Ann Lee');
    expect(names[1]).toContain('Bo Ray');
    expect(screen.getByText(/3 asking/)).toBeInTheDocument();
  });

  it('a request from the waitlist says so', async () => {
    const r = { ...ride({ id: 'q1', waitlist: { position: 1, of: 2 } }), fits: null };
    routes((path) => {
      if (path === '/transport/driver/runs') return { today: day(0), runs: [] };
      if (path === '/transport/driver/requests') return { van: { id: 'v1', name: 'Van 2', plate: null, capacity: 12, look: '' }, requests: [r] };
      if (path.startsWith('/transport/driver/schedule?')) return { from: day(0), to: day(0), van: null, runs: [], asking: [] };
    });
    renderAs('DRIVER', <DriverHome />);
    expect(await screen.findByText('Waitlist #1 — the Morning vans are full')).toBeInTheDocument();
    expect(screen.getByText(/Morning shift ·/)).toBeInTheDocument();
  });
});
