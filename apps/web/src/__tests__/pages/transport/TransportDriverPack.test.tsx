import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { navigationUrl, type DeskDriver, type DriverToday, type RideRun, type RunMap } from '@/lib/transportApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: ({ ariaLabel }: { ariaLabel: string }) => <div aria-label={ariaLabel} />,
}));

import { apiFetch } from '@/lib/api';
import { DriverTodayCard, IncidentDialog, OkPrompt, PreTripDialog, SafetyDialog } from '@/pages/transport/DriverTools';
import { CostsSection, DriversTab, SosBanner, TransportNeedsYou } from '@/pages/transport/TransportDesk';
import { RideFeedbackCard, StandingBookings } from '@/pages/transport/RideHome';
import { TrackPage } from '@/pages/transport/TrackPage';

/**
 * The driver and fleet pack on screen: the driver's day (runs → hours →
 * pay, the clock, a lapsed licence said plainly), turn-by-turn in the app
 * they like, the pre-trip check, the safety sheet and the "everything OK?"
 * prompt, the incident form; the desk's counted needs-you, the SOS banner,
 * drivers and their papers, cost per seat; the rider's thumb and standing
 * bookings; the shared trip page.
 */

function renderAs(role: Role, ui: React.ReactElement, path = '/') {
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
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
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

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const inH = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function run(over: Partial<RideRun> = {}): RideRun {
  return {
    id: 'run1',
    direction: 'TO_WORK',
    serviceDate: '2026-06-01',
    departAt: inH(1),
    status: 'PLANNED',
    startedAt: null,
    endedAt: null,
    notes: null,
    van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', capacity: 12 },
    driver: { userId: 'd1', name: 'Mike Chen' },
    seats: { taken: 1, capacity: 12 },
    rides: [
      {
        id: 'r1',
        direction: 'TO_WORK',
        targetAt: inH(2),
        serviceDate: '2026-06-01',
        status: 'SCHEDULED',
        shiftId: null,
        note: null,
        pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Gulf Blvd' },
        point: { lat: 30.21, lng: -85.86 },
        store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
        rider: { associateId: 'a-ana', name: 'Ana Rider', phone: null },
        pickupOrder: 1,
        pickupAt: inH(1.5),
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
      },
    ],
    ...over,
  } as RideRun;
}

const today = (over: Partial<DriverToday> = {}): DriverToday => ({
  date: '2026-06-01',
  associateId: 'a-mike',
  runs: { total: 3, done: 1, active: 0 },
  hours: { worked: 2.5, driven: 1.75, onClock: false },
  shifts: [{ id: 'sh1', startsAt: inH(-1), endsAt: inH(7), status: 'ASSIGNED', today: true }],
  earnings: { hourlyRate: 18, earnedSoFar: 245.5, workedHours: 13.6, projectedWeek: 612, currentShiftEarned: null, onClock: false, weekStart: '2026-05-30', weekEnd: '2026-06-05' },
  credentials: { ok: true, problems: [], dueSoon: [] },
  hoursOfService: { maxPerDay: 10, minRest: 8 },
  preTripRequired: true,
  ...over,
});

describe('the driver', () => {
  it('sees today as runs → hours → this week’s pay, clocks in, and reads their own punches', async () => {
    let onClock = false;
    const calls: string[] = [];
    routes((path, init) => {
      if (path === '/transport/driver/today') return today({ hours: { worked: 2.5, driven: 1.75, onClock } });
      if (path === '/transport/driver/time') return { entries: [{ id: 'e1', clockInAt: inH(-26), clockOutAt: inH(-18), status: 'COMPLETED', hours: 8 }] };
      if (path === '/transport/driver/clock-in' && init?.method === 'POST') {
        calls.push('in');
        onClock = true;
        return { entry: { id: 'e2', clockInAt: new Date().toISOString() } };
      }
    });
    renderAs('DRIVER', <DriverTodayCard />);
    const card = await screen.findByRole('region', { name: 'Today' });
    expect(within(card).getByText('1/3')).toBeInTheDocument();
    expect(within(card).getByText('2.5h')).toBeInTheDocument();
    expect(within(card).getByText('$245.50')).toBeInTheDocument();
    expect(within(card).getByText('My driver shifts')).toBeInTheDocument();
    expect(await within(card).findByText('8h')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /clock in/i }));
    await waitFor(() => expect(calls).toEqual(['in']));
    expect(await within(card).findByRole('button', { name: /clock out/i })).toBeInTheDocument();
  });

  it('is told plainly when their licence lapsed; a driver with no person record is told why there is no pay', async () => {
    routes((path) => {
      if (path === '/transport/driver/today') return today({ associateId: null, earnings: null, credentials: { ok: false, problems: [{ key: 'licence', label: "Driver's licence", expiresAt: '2026-05-01', expired: true }], dueSoon: [] } });
    });
    renderAs('DRIVER', <DriverTodayCard />);
    expect(await screen.findByText(/Your driver’s licence expired/)).toBeInTheDocument();
    expect(screen.getByText(/isn’t linked to a person record/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clock in/i })).not.toBeInTheDocument();
  });

  it('navigates to the next stop in the app they chose', () => {
    expect(navigationUrl('WAZE', { point: { lat: 30.21, lng: -85.86 }, address: 'x' })).toBe('https://waze.com/ul?ll=30.21,-85.86&navigate=yes');
    expect(navigationUrl('APPLE', { address: '100 Gulf Blvd' })).toBe('https://maps.apple.com/?daddr=100%20Gulf%20Blvd&dirflg=d');
    expect(navigationUrl('GOOGLE', { point: { lat: 1, lng: 2 }, address: 'x' })).toContain('destination=1%2C2');
  });

  it('walks round the van: every item answered before Done; a pass hands on to start', async () => {
    const sent: unknown[] = [];
    routes((path, init) => {
      if (path === '/transport/driver/runs/run1/pre-trip' && !init?.method)
        return {
          required: true,
          items: [
            { key: 'tires', label: 'Tires and wheels', safety: true },
            { key: 'clean', label: 'Clean inside and out', safety: false },
          ],
          check: null,
        };
      if (path === '/transport/driver/runs/run1/pre-trip' && init?.method === 'POST') {
        sent.push(init.body);
        return { check: { id: 'c1' }, passed: true, failedSafety: [] };
      }
    });
    const onPassed = vi.fn();
    renderAs('DRIVER', <PreTripDialog run={run()} onPassed={onPassed} onClose={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'Pre-trip check' });
    const done = within(dialog).getByRole('button', { name: /Done — start the run/ });
    expect(done).toBeDisabled();
    await userEvent.click(within(await within(dialog).findByRole('radiogroup', { name: 'Tires and wheels' })).getByText('OK'));
    expect(done).toBeDisabled();
    await userEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'Clean inside and out' })).getByText('Problem'));
    await userEvent.type(within(dialog).getByLabelText('Odometer (miles)'), '48212');
    await userEvent.click(done);
    await waitFor(() => expect(onPassed).toHaveBeenCalled());
    expect(sent[0]).toMatchObject({ items: [{ key: 'tires', ok: true }, { key: 'clean', ok: false }], odometerMiles: 48212 });
  });

  it('the shield: 911 one tap away, the desk alerted with a note, the trip shared, an incident one more tap', async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    routes((path, init) => {
      if (path === '/transport/driver/profile') return { profile: { navApp: 'GOOGLE' }, credentials: { ok: true, problems: [], dueSoon: [] }, associateId: 'a' };
      if (path === '/transport/driver/runs/run1/sos' && init?.method === 'POST') {
        posted.push({ path, body: init.body });
        return { ok: true };
      }
    });
    const onIncident = vi.fn();
    renderAs('DRIVER', <SafetyDialog run={run({ status: 'ACTIVE' })} onClose={vi.fn()} onIncident={onIncident} />);
    const dialog = await screen.findByRole('dialog', { name: /Safety/ });
    expect(within(dialog).getByRole('link', { name: /Call 911/ })).toHaveAttribute('href', 'tel:911');
    await userEvent.type(within(dialog).getByLabelText(/What’s happening/), 'flat tire');
    await userEvent.click(within(dialog).getByRole('button', { name: /Alert transportation/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ note: 'flat tire' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Report an incident/ }));
    expect(onIncident).toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Navigate with')).toHaveValue('GOOGLE');
  });

  it('"Everything OK?" shows only when asked, and I’m OK answers it', async () => {
    const posted: string[] = [];
    routes((path, init) => {
      if (path === '/transport/driver/runs/run1/ok' && init?.method === 'POST') {
        posted.push(path);
        return { ok: true };
      }
    });
    const { rerender } = renderAs('DRIVER', <OkPrompt run={run({ status: 'ACTIVE' })} onHelp={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <OkPrompt run={run({ status: 'ACTIVE', safety: { sosAt: null, sosAckAt: null, promptedAt: new Date().toISOString(), escalatedAt: null } })} onHelp={vi.fn()} />
      </QueryClientProvider>,
    );
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /I’m OK/ }));
    await waitFor(() => expect(posted).toEqual(['/transport/driver/runs/run1/ok']));
  });

  it('files an incident with who was hurt, the other party and the police number', async () => {
    const bodies: unknown[] = [];
    routes((path, init) => {
      if (path === '/transport/incidents' && init?.method === 'POST') {
        bodies.push(init.body);
        return { incident: { id: 'i1' } };
      }
    });
    const onClose = vi.fn();
    renderAs('DRIVER', <IncidentDialog run={run({ status: 'ACTIVE' })} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Report an incident' });
    await userEvent.type(within(dialog).getByLabelText(/Describe it/), 'Rear-ended at the light on Front Beach Rd.');
    await userEvent.click(within(dialog).getByLabelText('Someone was hurt'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ana Rider' }));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'J. Doe');
    await userEvent.type(within(dialog).getByLabelText(/Police report number/), 'PCB-42');
    await userEvent.click(within(dialog).getByRole('button', { name: 'File the report' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bodies[0]).toMatchObject({
      kind: 'COLLISION',
      runId: 'run1',
      injuries: true,
      injuredAssociateIds: ['a-ana'],
      parties: [{ name: 'J. Doe' }],
      policeReportNumber: 'PCB-42',
    });
  });
});

describe('the director', () => {
  it('sees what needs them, counted, with the loud ones first', async () => {
    routes((path) => {
      if (path === '/transport/needs-you')
        return {
          total: 4,
          items: [
            { key: 'sos', label: 'SOS from a van', count: 1, path: '/transport?tab=live', tone: 'alert' },
            { key: 'needs-van', label: 'Seats today without a van', count: 3, path: '/transport', tone: 'warning' },
          ],
        };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <TransportNeedsYou />);
    const panel = await screen.findByRole('region', { name: 'Needs you' });
    expect(within(panel).getByRole('heading', { name: 'Needs you · 4' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'SOS from a van: 1' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Seats today without a van: 3' })).toBeInTheDocument();
  });

  it('an SOS is a banner with the position and Acknowledge; an unanswered prompt says call them', async () => {
    const acked: string[] = [];
    routes((path, init) => {
      if (path === '/transport/runs/run1/sos/ack' && init?.method === 'POST') {
        acked.push(path);
        return { ok: true };
      }
    });
    const base: RunMap = {
      runId: 'run1',
      status: 'ACTIVE',
      direction: 'TO_WORK',
      serviceDate: '2026-06-01',
      departAt: inH(-0.5),
      timezone: tz,
      van: { id: 'v1', name: 'Van 1', plate: null, capacity: 12 },
      driver: { userId: 'd1', name: 'Mike Chen' },
      position: { lat: 30.21, lng: -85.86, heading: null, speedMps: 0, at: new Date().toISOString() },
      stale: false,
      trail: [],
      waypoints: [],
      stores: [],
      late: [],
      riders: [],
    };
    renderAs(
      'TRANSPORTATION_DIRECTOR',
      <SosBanner
        manage
        runs={[
          { ...base, safety: { sosAt: new Date().toISOString(), sosAckAt: null, promptedAt: null, escalatedAt: null, sosNote: 'flat tire' } },
          { ...base, runId: 'run2', driver: { userId: 'd2', name: 'Jo Park' }, safety: { sosAt: null, sosAckAt: null, promptedAt: inH(-0.2), escalatedAt: inH(-0.1) } },
        ]}
      />,
    );
    const banner = screen.getByRole('alert');
    expect(within(banner).getByText(/SOS — Mike Chen in Van 1/)).toBeInTheDocument();
    expect(within(banner).getByText(/flat tire/)).toBeInTheDocument();
    expect(within(banner).getByRole('link', { name: 'Open in Maps' })).toHaveAttribute('href', 'https://www.google.com/maps?q=30.21,-85.86');
    expect(screen.getByRole('status')).toHaveTextContent(/Jo Park hasn’t answered/);
    await userEvent.click(within(banner).getByRole('button', { name: /Acknowledge/ }));
    await waitFor(() => expect(acked).toEqual(['/transport/runs/run1/sos/ack']));
  });

  it('sees each driver’s papers — a lapsed licence stands out — and the day’s driver shifts', async () => {
    const driver = (over: Partial<DeskDriver>): DeskDriver => ({
      userId: 'd1',
      name: 'Mike Chen',
      role: 'DRIVER',
      drivesByTrade: true,
      phone: null,
      associateId: 'a1',
      photoUrl: null,
      van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', outOfService: false },
      profile: { navApp: 'GOOGLE', licenceNumber: null, licenceState: 'FL', licenceClass: 'E', licenceExpiresAt: '2026-01-01', dotMedicalRequired: false, dotMedicalExpiresAt: null, mvrCheckedAt: null, notes: null },
      credentials: { ok: false, problems: [{ key: 'licence', label: "Driver's licence", expiresAt: '2026-01-01', expired: true }], dueSoon: [] },
      today: [],
      ...over,
    });
    routes((path) => {
      if (path === '/transport/drivers')
        return {
          drivers: [
            driver({}),
            driver({ userId: 'd2', name: 'Jo Park', associateId: null, profile: { ...driver({}).profile, licenceExpiresAt: '2030-01-01' }, credentials: { ok: true, problems: [], dueSoon: [] } }),
          ],
        };
      if (path.startsWith('/transport/driver-shifts')) return { shifts: [{ id: 'sh1', startsAt: inH(1), endsAt: inH(9), status: 'ASSIGNED', notes: null, driver: { userId: 'd1', name: 'Mike Chen', associateId: 'a1' } }] };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <DriversTab manage />);
    expect(await screen.findByText('Licence lapsed')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText(/No person record — can’t be scheduled/)).toBeInTheDocument();
    const shifts = screen.getByRole('region', { name: 'Driver shifts' });
    expect(await within(shifts).findByText('Mike Chen')).toBeInTheDocument();
    expect(within(shifts).getByRole('button', { name: /Schedule a driver/ })).toBeInTheDocument();
  });

  it('reads cost per seat against fares, by client', async () => {
    routes((path) => {
      if (path.startsWith('/transport/costs'))
        return {
          from: '2026-05-30',
          to: '2026-06-12',
          rows: [{ clientId: 'c1', client: 'Coastal', runs: 4, seats: 20, noShows: 1, faresCents: 10_000, driverCents: 6_000, fuelCents: 2_000, maintenanceCents: 1_000, costCents: 9_000, netCents: 1_000, costPerSeatCents: 450, farePerSeatCents: 500 }],
          totals: { clientId: null, client: 'All', runs: 4, seats: 20, noShows: 1, faresCents: 10_000, driverCents: 6_000, fuelCents: 2_000, maintenanceCents: 1_000, costCents: 9_000, netCents: 1_000, costPerSeatCents: 450, farePerSeatCents: 500 },
          note: 'Driver cost is run hours at each driver’s hourly rate.',
        };
    });
    renderAs('TRANSPORTATION_DIRECTOR', <CostsSection />);
    const section = await screen.findByRole('region', { name: 'Cost per seat' });
    expect(await within(section).findAllByText('$4.50')).not.toHaveLength(0);
    expect(within(section).getAllByText('Coastal').length).toBeGreaterThan(0);
    expect(within(section).getByText(/\$60\.00 drivers/)).toBeInTheDocument();
  });
});

describe('the rider', () => {
  it('rates the last ride: a thumb down asks why before it sends', async () => {
    const bodies: unknown[] = [];
    routes((path, init) => {
      if (path === '/transport/me/feedback/pending')
        return { rides: [{ rideId: 'r1', direction: 'TO_WORK', completedAt: inH(-2), store: 'Front Beach 218', timezone: tz, van: 'Van 1', driver: 'Mike' }], reasons: ['GREAT', 'LATE', 'DRIVING', 'OTHER'] };
      if (path === '/transport/me/rides/r1/feedback' && init?.method === 'POST') {
        bodies.push(init.body);
        return { feedback: { id: 'f1' } };
      }
    });
    renderAs('ASSOCIATE', <RideFeedbackCard />);
    expect(await screen.findByText('How was the ride?')).toBeInTheDocument();
    expect(screen.getByText(/Van 1 with Mike/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Not good/ }));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Late' }));
    await userEvent.click(send);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ thumbsUp: false, reason: 'LATE' });
  });

  it('sees standing bookings and can stop one', async () => {
    const deleted: string[] = [];
    routes((path, init) => {
      if (path === '/transport/me/series')
        return {
          series: [
            {
              id: 'sr1',
              direction: 'TO_WORK',
              store: { id: 'l1', name: 'Front Beach 218', timezone: tz },
              pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing' },
              windowLabel: 'Morning',
              timeOfDay: null,
              daysOfWeek: [1, 3, 5],
              startsOn: '2026-06-01',
              endsOn: null,
              note: null,
              active: true,
              bookedThrough: '2026-06-08',
              rides: 3,
            },
          ],
        };
      if (path === '/transport/me/series/sr1' && init?.method === 'DELETE') {
        deleted.push(path);
        return {};
      }
    });
    renderAs('ASSOCIATE', <StandingBookings />);
    expect(await screen.findByText('Standing bookings')).toBeInTheDocument();
    expect(screen.getByText(/Mon, Wed, Fri/)).toBeInTheDocument();
    expect(screen.getByText(/Seaside Housing/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(deleted).toEqual(['/transport/me/series/sr1']));
  });
});

describe('the shared trip page', () => {
  it('shows the van and its next stop — and an honest expiry', async () => {
    routes((path) => {
      if (path === '/transport/track/good')
        return {
          trip: {
            status: 'ACTIVE',
            van: { name: 'Van 1', plate: 'ALT 101' },
            driver: 'Mike',
            position: { lat: 30.21, lng: -85.86, heading: 90, speedMps: 10, at: new Date().toISOString() },
            stale: false,
            next: { kind: 'store', label: 'Front Beach 218', etaAt: new Date(Date.now() + 12 * 60_000).toISOString() },
            stopsLeft: 2,
            endedAt: null,
            generatedAt: new Date().toISOString(),
          },
        };
    });
    renderAs('ASSOCIATE', <Routes><Route path="/track/:token" element={<TrackPage />} /></Routes>, '/track/good');
    expect(await screen.findByRole('heading', { name: /About 1[12] min to Front Beach 218/ })).toBeInTheDocument();
    expect(screen.getByText('Driven by Mike')).toBeInTheDocument();
    expect(screen.getByLabelText('Where Van 1 is')).toBeInTheDocument();
  });
});
