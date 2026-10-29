import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { I18nProvider } from '@/lib/i18n';
import type { Ride, RideRun } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({ LazyLiveMap: () => null }));

import { apiFetch } from '@/lib/api';
import { listQueuedWrites } from '@/lib/offlineQueue';
import { DriverHome } from '@/pages/transport/DriverHome';

/**
 * The floor walk on the driver's phone: a tap with no signal is kept and
 * shown as on its way (5); Report a problem can take the van off the road
 * (16); "I'm here" is one tap and later stops show where they are (18);
 * fuel is logged at the pump (transport walk 9); the assistant offers the
 * driver's own questions (19).
 */

const tz = 'America/Chicago';
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: at(2),
    serviceDate: new Date().toISOString().slice(0, 10),
    status: 'SCHEDULED',
    shiftId: null,
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    point: null,
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
    rider: { associateId: `a-${over.id}`, name: 'Maria Lopez', phone: '555-0100' },
    pickupOrder: 1,
    pickupAt: at(1),
    run: { id: 'run1', status: 'ACTIVE', departAt: at(0.5), van: { id: 'v1', name: 'Van 2', plate: 'ALT 101' }, driver: { userId: 'u', name: 'Dana', associateId: null } },
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

function activeRun(): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: new Date().toISOString().slice(0, 10),
    departAt: at(0.5),
    status: 'ACTIVE',
    startedAt: at(-0.2),
    endedAt: null,
    notes: null,
    van: { id: 'v1', name: 'Van 2', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'u', name: 'Dana' },
    seats: { taken: 2, capacity: 12 },
    rides: [
      ride({ id: 'r1' }),
      ride({
        id: 'r2',
        pickupOrder: 2,
        rider: { associateId: 'a-r2', name: 'Ben Ray', phone: null },
        pickup: { kind: 'address', id: null, name: null, address: '12 Palm St' },
      }),
    ],
  } as RideRun;
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Handler = () => undefined) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out !== undefined) return out as never;
    if (path === '/transport/driver/runs') return { today: new Date().toISOString().slice(0, 10), runs: [activeRun()] } as never;
    if (path === '/transport/driver/requests') return { van: { id: 'v1', name: 'Van 2', plate: 'ALT 101', capacity: 12, look: '' }, requests: [] } as never;
    if (path.startsWith('/transport/driver/schedule?')) return { from: '', to: '', van: null, runs: [], asking: [] } as never;
    return { run: null } as never;
  });
}

function renderDriver() {
  const caps = ROLE_CAPABILITIES.DRIVER;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'dana@altohr.com', role: 'DRIVER', status: 'ACTIVE', clientId: null, associateId: 'a' },
          role: 'DRIVER',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <I18nProvider>
          <ConfirmProvider>
            <MemoryRouter>
              <DriverHome />
            </MemoryRouter>
          </ConfirmProvider>
        </I18nProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const postsTo = (path: string) => vi.mocked(apiFetch).mock.calls.filter(([p, init]) => p === path && (init as { method?: string } | undefined)?.method === 'POST');

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  window.localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('floor walk 5 — a tap with no signal is kept', () => {
  it('On board with no signal: nothing sent, the row says it is on its way, and the pill counts it', async () => {
    // At the kerb: both riders at Seaside Housing, the van arrived a minute ago.
    const here = at(-1 / 60);
    routes((path) =>
      path === '/transport/driver/runs'
        ? { today: new Date().toISOString().slice(0, 10), runs: [{ ...activeRun(), rides: [ride({ id: 'r1', vanArrivedAt: here }), ride({ id: 'r2', pickupOrder: 2, vanArrivedAt: here, rider: { associateId: 'a-r2', name: 'Ben Ray', phone: null } })] }] }
        : undefined,
    );
    renderDriver();
    const card = await screen.findByRole('region', { name: /Van 2/ });
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await userEvent.click(within(card).getByRole('button', { name: 'On board: Maria Lopez' }));
    expect(await within(card).findByText('On board (sending)')).toBeInTheDocument();
    expect(screen.getByText('1 tap waiting to send')).toBeInTheDocument();
    expect(postsTo('/transport/driver/rides/r1/board')).toHaveLength(0);
    expect(listQueuedWrites()).toEqual([expect.objectContaining({ path: '/transport/driver/rides/r1/board', body: expect.objectContaining({ replay: true }) })]);
    // One tap locks its own row, never the card: Ben can still be marked, and the stop's button counts only him.
    expect(within(card).getByRole('button', { name: 'On board: Ben Ray' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'On board · Ben R.' })).toBeEnabled();
  });
});

describe('floor walk 18 — rider texts and stop details', () => {
  it('"I’m here" is one tap per rider with a phone; a later stop shows its address and directions', async () => {
    const here = at(-1 / 60);
    routes((path, init) => {
      if (path === '/transport/driver/rides/r1/text-here' && init?.method === 'POST') return { sent: true, reason: null, body: 'Dana is outside', smsHref: null };
      if (path === '/transport/driver/runs') {
        const run = activeRun();
        return { today: new Date().toISOString().slice(0, 10), runs: [{ ...run, rides: [ride({ id: 'r1', vanArrivedAt: here }), run.rides[1]!] }] };
      }
      return undefined;
    });
    renderDriver();
    const card = await screen.findByRole('region', { name: /Van 2/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Text “I\'m here”: Maria Lopez' }));
    await waitFor(() => expect(postsTo('/transport/driver/rides/r1/text-here')).toHaveLength(1));
    // Ben has no phone: no text button for him.
    expect(within(card).queryByRole('button', { name: /Text .*Ben Ray/ })).toBeNull();
    // The stop after this one: its address and Navigate.
    expect(within(card).getByRole('list', { name: 'Later stops' })).toHaveTextContent('12 Palm St');
    expect(within(card).getByRole('link', { name: 'Navigate: 12 Palm St' })).toBeInTheDocument();
  });
});

describe('floor walk 16 — Report a problem takes the van off the road', () => {
  it('sends the run, the switch, and says the van is off the road', async () => {
    routes((path, init) => (path === '/transport/issues' && init?.method === 'POST' ? { id: 'i1', vanParked: true, runs: { moved: [], flagged: ['run1'] } } : undefined));
    renderDriver();
    await screen.findByRole('region', { name: /Van 2/ });
    await userEvent.click(screen.getAllByRole('button', { name: 'Report a problem' })[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Brakes grinding, pedal soft.');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Van can't run safely/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take the van off the road' }));
    await waitFor(() => expect(postsTo('/transport/issues')).toHaveLength(1));
    expect(postsTo('/transport/issues')[0]![1]).toMatchObject({ body: { category: 'VEHICLE', body: 'Brakes grinding, pedal soft.', runId: 'run1', vanOutOfService: true } });
  });
});

describe('transport walk 9 — fuel at the pump', () => {
  it('Log fuel on the van being driven: the total in cents, gallons, the odometer', async () => {
    routes((path, init) =>
      path === '/transport/driver/vans/v1/fuel' && init?.method === 'POST' ? { entry: { id: 'e1', kind: 'FUEL', occurredAt: '2026-10-21', odometerMiles: 40120, costCents: 6212, notes: null } } : undefined,
    );
    renderDriver();
    await screen.findByRole('region', { name: /Van 2/ });
    // With a run under way, Log fuel sits at the foot of the run's sheet (its button is the one in view).
    const card = screen.getByRole('region', { name: /Van 2/ });
    await userEvent.click(within(card).getByRole('button', { name: 'Log fuel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fuel — Van 2' });
    await userEvent.type(within(dialog).getByLabelText(/Total/), '62.12');
    await userEvent.type(within(dialog).getByLabelText('Gallons'), '18.4');
    await userEvent.type(within(dialog).getByLabelText(/Odometer/), '40120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postsTo('/transport/driver/vans/v1/fuel')).toHaveLength(1));
    expect(postsTo('/transport/driver/vans/v1/fuel')[0]![1]).toMatchObject({ body: { costCents: 6212, gallons: 18.4, odometerMiles: 40120, photoKey: null } });
  });
});

describe('floor walk 19 — the driver’s assistant', () => {
  it('offers the driver’s own questions, never a rider’s ride', async () => {
    routes((path) =>
      path === '/hugo'
        ? { name: 'Hugo', audience: 'driver', intro: '', model: true, can: [{ key: 'DRIVER_NEXT_RUN', label: 'My next run', example: 'When is my next run?' }] }
        : undefined,
    );
    renderDriver();
    const seat = await screen.findByTestId('hugo-seat');
    expect(within(seat).getByRole('button', { name: /When is my next run\?/ })).toBeInTheDocument();
    expect(within(seat).getByRole('button', { name: /Who's on this run\?/ })).toBeInTheDocument();
    expect(within(seat).queryByText(/What time is my ride/)).toBeNull();
  });
});
