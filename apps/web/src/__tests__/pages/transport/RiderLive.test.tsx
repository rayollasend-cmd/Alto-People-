import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { ApiError } from '@/lib/api';
import { zonedDayKey } from '@/lib/format';
import type { MyLiveRide, MyTransport, Ride } from '@/lib/transportApi';

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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';
import { RideHome } from '@/pages/transport/RideHome';
import { RideStrip } from '@/pages/transport/RideStrip';
import { TrackPage } from '@/pages/transport/TrackPage';
import { chargeGroups, chargeRows, fareWords } from '@/pages/transport/rider/charges';
import { liveTripView } from '@/pages/transport/rider/tripState';

/**
 * The transport upgrade (2026-10-28) — the rider's trip, Uber-style: one
 * state at a time in big type over the map, the driver and the plate, one
 * row of actions, where to wait, the fare in words; the page around it
 * (one gold button, one row of views, no wrapped times); the Home card in
 * miniature; the shared-trip page; and what they owe, with its ledger.
 */

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const hoursFromNow = (h: number) => minutesFromNow(h * 60);
const today = zonedDayKey(new Date(), tz);
const PAYDAY = { payDate: '2026-11-13', periodStart: '2026-10-24', periodEnd: '2099-01-01' };

type Phase = 'before' | 'onWay' | 'late' | 'arrived' | 'onBoard';

function ride(over: Partial<Ride> & { id: string }): Ride {
  return {
    direction: 'TO_WORK',
    targetAt: hoursFromNow(1),
    serviceDate: today,
    status: 'SCHEDULED',
    shiftId: null,
    windowLabel: 'Morning',
    note: null,
    pickup: { kind: 'stop', id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' },
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal Resort Holdings' },
    rider: { associateId: 'a', name: 'Maria Lopez', phone: null },
    pickupOrder: 2,
    pickupAt: minutesFromNow(30),
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
    point: null,
    acceptedAt: null,
    declines: 0,
    allDeclined: false,
    createdAt: new Date().toISOString(),
    ...over,
  } as Ride;
}

/** The ride and its live feed in one phase of the trip. */
function trip(phase: Phase, extra: Partial<MyLiveRide> = {}): { r: Ride; live: MyLiveRide } {
  const active = phase !== 'before';
  const r = ride({
    id: 'r1',
    status: phase === 'onBoard' ? 'BOARDED' : 'SCHEDULED',
    pickupAt: phase === 'before' ? minutesFromNow(34) : minutesFromNow(4),
    vanArrivedAt: phase === 'arrived' ? minutesFromNow(-0.5) : null,
    boardedAt: phase === 'onBoard' ? minutesFromNow(-8) : null,
    seats: { capacity: 12, taken: 3 },
    run: {
      id: 'run1',
      status: active ? 'ACTIVE' : 'PLANNED',
      departAt: active ? minutesFromNow(-14) : minutesFromNow(26),
      van: { id: 'v1', name: 'Van 1', plate: 'ALT 101', make: 'Ford', model: 'Transit', color: 'White', year: 2023 },
      driver: { userId: 'd1', name: 'Mike Chen', associateId: null },
    },
  });
  const live: MyLiveRide = {
    rideId: 'r1',
    direction: 'TO_WORK',
    status: r.status,
    runStatus: active ? 'ACTIVE' : 'PLANNED',
    timezone: tz,
    departAt: r.run!.departAt,
    van: { name: 'Van 1', plate: 'ALT 101' },
    driver: 'Mike',
    position: active ? { lat: 30.22, lng: -85.88, heading: 300, speedMps: 11, at: new Date().toISOString() } : null,
    stale: false,
    pickup: {
      label: 'Seaside Housing',
      point: { lat: 30.236, lng: -85.907 },
      scheduledAt: r.pickupAt,
      etaAt: phase === 'onWay' ? minutesFromNow(6.2) : phase === 'late' ? minutesFromNow(9.2) : null,
    },
    destination: { label: 'Front Beach 218', point: { lat: 30.206, lng: -85.862 }, dueAt: hoursFromNow(1), etaAt: phase === 'onBoard' ? minutesFromNow(13) : null },
    stopsBefore: phase === 'onWay' || phase === 'late' ? 1 : 0,
    lateMinutes: phase === 'late' ? 4 : 0,
    vanArrivedAt: r.vanArrivedAt,
    riderSignal: null,
    driverFirstName: 'Mike',
    vanLook: { color: 'White', make: 'Ford', model: 'Transit', year: 2023 },
    pickupNote: 'By the front gate, under the awning',
    waitMinutes: 3,
    dispatchPhone: '(850) 555-0142',
    fare: { cents: 500, words: 'Taken from your pay on Nov 13' },
    ...extra,
  };
  return { r, live };
}

function me(over: Partial<MyTransport> = {}): MyTransport {
  return {
    settings: { fareCents: 500, noShowFeeCents: 100, cutoffHours: 10, shortNoticeMinutes: 90, dispatchPhone: null },
    consent: { acceptedAt: new Date().toISOString() },
    places: [],
    stops: [{ id: 's1', name: 'Seaside Housing', address: '100 Seaside Dr' }],
    stores: [{ id: 'l1', name: 'Front Beach 218', timezone: tz, clientName: 'Coastal Resort Holdings', address: null }],
    shifts: [],
    rides: [],
    defaultPickup: { kind: 'stop', stopId: 's1', label: 'Seaside Housing' },
    defaultStoreId: 'l1',
    charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: null },
    ...over,
  };
}

function renderAs(ui: React.ReactElement, entry = '/') {
  const role: Role = 'ASSOCIATE';
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'maria@example.com', role, status: 'ACTIVE' as const, clientId: null, associateId: 'a' },
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
          <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Handler) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out =
      handler(path, init) ??
      (path === '/transport/me/live'
        ? { live: null }
        : path === '/transport/me/feedback/pending'
          ? { rides: [], reasons: [] }
          : path === '/transport/me/series'
            ? { series: [] }
            : undefined);
    if (out === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
    return out as never;
  });
}

function serveTrip(phase: Phase, extra: Partial<MyLiveRide> = {}, data: Partial<MyTransport> = {}, more?: Handler) {
  const { r, live } = trip(phase, extra);
  routes((path, init) => {
    if (path === '/transport/me') return me({ rides: [r], ...data });
    if (path === '/transport/me/live') return { live };
    return more?.(path, init);
  });
  return { r, live };
}

async function hero() {
  return screen.findByRole('region', { name: 'Your next ride' });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

describe('the live trip — one state at a time, over the map', () => {
  it('before the van leaves: "Van 1 leaves at …" and the pickup, the van to look for, where to wait', async () => {
    const { r } = serveTrip('before');
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    expect(h).toHaveAttribute('data-phase', 'before');
    const leaves = new Date(r.run!.departAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    expect(within(h).getByTestId('trip-headline')).toHaveTextContent(`Van 1 leaves at ${leaves}`);
    expect(within(h).getByText(/^Pickup \d.* at Seaside Housing$/)).toBeInTheDocument();
    expect(within(h).getByText(/Van leaves in 2\dm/)).toBeInTheDocument();
    // The driver card: first name, the van's look, the plate as a plate, the seats.
    expect(within(h).getByText('Mike')).toBeInTheDocument();
    expect(within(h).getByText('White Ford Transit · Van 1')).toBeInTheDocument();
    expect(within(h).getByText('ALT 101')).toBeInTheDocument();
    expect(within(h).getByText(/3 of 12 seats taken/)).toBeInTheDocument();
    // Where exactly to wait, and the rule in words.
    expect(within(h).getByText('By the front gate, under the awning')).toBeInTheDocument();
    expect(within(h).getByText('The van waits 3 minutes once it arrives — be outside a few minutes early.')).toBeInTheDocument();
    // No signals before the van is out; the trip map is there.
    expect(within(h).queryByRole('button', { name: 'I’m outside' })).not.toBeInTheDocument();
    expect(within(h).getByRole('list', { name: 'Map of your van' })).toBeInTheDocument();
    // Cancel and report stay — secondary, not gold.
    expect(within(h).getByRole('button', { name: 'Cancel ride' })).not.toHaveClass('btn-gold');
    expect(within(h).getByRole('button', { name: 'Report a problem' })).toBeInTheDocument();
  });

  it('on the way: "Mike is 6 min away", on time, the stops before them, the van on the map', async () => {
    serveTrip('onWay');
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    expect(await within(h).findByTestId('trip-headline')).toHaveTextContent('Mike is 6 min away');
    expect(within(h).getByText('On time')).toBeInTheDocument();
    expect(within(h).getByText(/1 stop before you/)).toBeInTheDocument();
    expect(within(h).getByText('Updated just now')).toBeInTheDocument();
    const map = within(h).getByRole('list', { name: 'Map of your van' });
    expect(within(map).getByText('Van 1')).toBeInTheDocument();
    expect(within(map).getByText('Seaside Housing')).toBeInTheDocument();
  });

  it('under a minute out it says "Arriving now"; late is said honestly', async () => {
    const soon = trip('onWay', { pickup: { label: 'Seaside Housing', point: null, scheduledAt: null, etaAt: minutesFromNow(0.5) } });
    expect(liveTripView(soon.r, soon.live, Date.now())).toMatchObject({ arrivingNow: true, phase: 'onWay' });

    serveTrip('late');
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    expect(await within(h).findByTestId('trip-headline')).toHaveTextContent('Mike is 9 min away');
    expect(within(h).getByText('Running 4 min late')).toBeInTheDocument();
    expect(within(h).queryByText('On time')).not.toBeInTheDocument();
  });

  it('arrived: "Mike is here", the van to look for, and how long he waits, running down', async () => {
    serveTrip('arrived');
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    expect(within(h).getByTestId('trip-headline')).toHaveTextContent('Mike is here');
    expect(within(h).getByText('Look for the white Ford Transit, ALT 101')).toBeInTheDocument();
    expect(within(h).getByText('Mike waits 3 minutes')).toBeInTheDocument();
    expect(within(h).getByText(/2:[2-3]\d to get on board/)).toBeInTheDocument();
  });

  it('on board: "On the way — arriving …" with a progress bar', async () => {
    const { live } = serveTrip('onBoard');
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    const at = new Date(live.destination.etaAt!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    expect(within(h).getByTestId('trip-headline')).toHaveTextContent(`On the way — arriving ${at}`);
    expect(within(h).getByRole('progressbar', { name: 'How far along the ride is' })).toBeInTheDocument();
    expect(within(h).getByText('To Front Beach 218')).toBeInTheDocument();
    expect(within(h).queryByRole('button', { name: 'I’m outside' })).not.toBeInTheDocument();
  });

  it('done: the trip’s last state is the rating — "You made it", then how was it', async () => {
    routes((path) => {
      if (path === '/transport/me') return me();
      if (path === '/transport/me/feedback/pending')
        return { rides: [{ rideId: 'r0', direction: 'TO_WORK', completedAt: minutesFromNow(-10), store: 'Front Beach 218', timezone: tz, van: 'Van 1', driver: 'Mike' }], reasons: ['GREAT', 'LATE'] };
    });
    renderAs(<RideHome />, '/rides');
    expect(await screen.findByText('You made it to Front Beach 218')).toBeInTheDocument();
    const card = screen.getByTestId('ride-feedback');
    expect(card).toHaveAttribute('data-done', 'true');
    expect(within(card).getByText('How was the ride?')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /Good/ })).toBeInTheDocument();
    // Said once — not a second card below the next ride.
    expect(screen.getAllByText('How was the ride?')).toHaveLength(1);
  });
});

describe('the trip’s actions', () => {
  it('"I’m outside" tells the driver and shows it was sent', async () => {
    const posted: unknown[] = [];
    serveTrip('arrived', {}, {}, (path, init) => {
      if (path === '/transport/me/rides/r1/signal' && init?.method === 'POST') {
        posted.push(init.body);
        return { ok: true };
      }
    });
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    const outside = within(h).getByRole('button', { name: 'I’m outside' });
    expect(outside.querySelector('.btn-gold')).not.toBeNull();
    await userEvent.click(outside);
    await waitFor(() => expect(posted).toEqual([{ kind: 'OUTSIDE' }]));
    expect(await within(h).findByRole('status')).toHaveTextContent('Mike knows you’re outside');
    expect(within(h).getByRole('button', { name: 'I’m outside' })).toBeDisabled();
    expect(within(h).getByRole('button', { name: 'I’m outside' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(h).getByRole('button', { name: 'Running late' })).toBeDisabled();
  });

  it('"Running late" is sent; "I’m outside" stays open for when they get there', async () => {
    serveTrip('onWay', { riderSignal: 'LATE' });
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    expect(await within(h).findByRole('status')).toHaveTextContent('Mike knows you’re running late');
    expect(within(h).getByRole('button', { name: 'Running late' })).toBeDisabled();
    expect(within(h).getByRole('button', { name: 'I’m outside' })).toBeEnabled();
  });

  it('"Call dispatch" rings the transport desk — and is not there without a number (never the driver’s)', async () => {
    serveTrip('onWay');
    const { unmount } = renderAs(<RideHome />, '/rides');
    let h = await hero();
    const call = within(h).getByRole('link', { name: 'Call dispatch at (850) 555-0142' });
    expect(call).toHaveAttribute('href', 'tel:8505550142');
    unmount();

    serveTrip('onWay', { dispatchPhone: null });
    renderAs(<RideHome />, '/rides');
    h = await hero();
    expect(within(h).queryByText('Call dispatch')).not.toBeInTheDocument();
    expect(within(h).queryByRole('link', { name: /Call/ })).not.toBeInTheDocument();
  });

  it('"Share trip" opens the phone’s share sheet with the link', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    try {
      serveTrip('onWay', {}, {}, (path, init) => {
        if (path === '/transport/me/rides/r1/share' && init?.method === 'POST') return { url: 'https://app.example/track/tok', expiresAt: hoursFromNow(6) };
      });
      renderAs(<RideHome />, '/rides');
      const h = await hero();
      await userEvent.click(within(h).getByRole('button', { name: 'Share trip' }));
      await waitFor(() => expect(share).toHaveBeenCalledWith({ url: 'https://app.example/track/tok', title: 'My ride', text: 'Follow my van live — Van 1' }));
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it('without a share sheet, the link goes on the clipboard and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    serveTrip('onWay', {}, {}, (path, init) => {
      if (path === '/transport/me/rides/r1/share' && init?.method === 'POST') return { url: 'https://app.example/track/tok', expiresAt: hoursFromNow(6) };
    });
    renderAs(<RideHome />, '/rides');
    const h = await hero();
    await user.click(within(h).getByRole('button', { name: 'Share trip' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.example/track/tok'));
    expect(toast.success).toHaveBeenCalledWith('Link copied — paste it in a text');
  });

  it('the fare in words — never a bare number', async () => {
    serveTrip('before');
    const { unmount } = renderAs(<RideHome />, '/rides');
    // The API's words, with the amount: "$5.00 — taken from your pay on Nov 13".
    expect(within(await hero()).getByTestId('trip-fare')).toHaveTextContent(/^\$5\.00 — taken from your pay on Nov 13$/);
    unmount();
    // Before the API sends the words: from the fare and their next payday.
    serveTrip('before', { fare: undefined }, { charges: { pendingCents: 0, rides: 0, noShows: 0, nextPayday: PAYDAY } });
    const second = renderAs(<RideHome />, '/rides');
    expect(within(await hero()).getByTestId('trip-fare')).toHaveTextContent(/^\$5\.00 — taken from your pay on \w{3}, Nov 13$/);
    second.unmount();
    // A ride that costs nothing says so, with no amount.
    serveTrip('before', { fare: { cents: 0, words: 'No charge' } });
    renderAs(<RideHome />, '/rides');
    expect(within(await hero()).getByTestId('trip-fare')).toHaveTextContent(/^No charge$/);
  });
});

describe('the page around the trip', () => {
  const shiftAt = (h: number) => {
    const start = new Date(Date.now() + h * 3_600_000);
    start.setMinutes(0, 0, 0);
    return { id: `sh-${h}`, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 8 * 3_600_000).toISOString(), position: 'Server', locationId: 'l1' };
  };
  const golds = () => document.querySelectorAll('.btn-gold').length;

  it('one row of views; the shift times never break mid-time; ONE gold button ("Book all"), the rows secondary', async () => {
    const shifts = [shiftAt(30), shiftAt(54), shiftAt(78)];
    routes((path) => (path === '/transport/me' ? me({ shifts }) : undefined));
    renderAs(<RideHome />, '/rides');
    const bar = await screen.findByRole('radiogroup', { name: 'Your rides' });
    expect(within(bar).getAllByRole('radio')).toHaveLength(4);
    expect(bar.className).not.toMatch(/flex-wrap/);
    for (const radio of within(bar).getAllByRole('radio')) expect(radio).toHaveClass('whitespace-nowrap');

    const times = await screen.findAllByTestId('shift-time');
    expect(times).toHaveLength(3);
    for (const el of times) {
      expect(el).toHaveClass('whitespace-nowrap');
      expect(el.textContent).toMatch(/^\d{1,2}:\d{2}\s?[AP]M–\d{1,2}:\d{2}\s?[AP]M$/);
    }
    // The day is its own line, not glued to the time range.
    expect(screen.getAllByTestId('shift-day')[0]).not.toHaveTextContent(/–/);

    expect(screen.getByRole('button', { name: /Book all/ })).toHaveClass('btn-gold');
    for (const b of screen.getAllByRole('button', { name: /^Round trip/ })) expect(b).not.toHaveClass('btn-gold');
    expect(golds()).toBe(1);
  });

  it('while the van is coming, "I’m outside" is the only gold button on the screen', async () => {
    const { r, live } = trip('onWay');
    routes((path) => {
      if (path === '/transport/me') return me({ rides: [r], shifts: [shiftAt(30), shiftAt(54)] });
      if (path === '/transport/me/live') return { live };
    });
    renderAs(<RideHome />, '/rides');
    await hero();
    await screen.findByRole('button', { name: /Book all/ });
    expect(golds()).toBe(1);
    expect(screen.getByRole('button', { name: 'I’m outside' }).querySelector('.btn-gold')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Book all/ })).not.toHaveClass('btn-gold');
  });

  it('the next ride is not listed twice: the calendar is for the rides after it', async () => {
    const { r, live } = trip('before');
    const later = ride({ id: 'r2', targetAt: hoursFromNow(50), pickupAt: hoursFromNow(49.5), serviceDate: zonedDayKey(hoursFromNow(50), tz), status: 'REQUESTED' });
    routes((path) => {
      if (path === '/transport/me') return me({ rides: [r] });
      if (path === '/transport/me/live') return { live };
    });
    const { unmount } = renderAs(<RideHome />, '/rides');
    await hero();
    expect(screen.queryByRole('tablist', { name: 'Your rides' })).not.toBeInTheDocument();
    unmount();

    routes((path) => {
      if (path === '/transport/me') return me({ rides: [r, later] });
      if (path === '/transport/me/live') return { live };
    });
    renderAs(<RideHome />, '/rides');
    const calendar = await screen.findByRole('tablist', { name: 'Your rides' });
    expect(within(calendar).getAllByRole('tab').length).toBeGreaterThanOrEqual(3);
    // Only the later ride is listed under the strip; its cancel is a full-size target.
    const cancels = screen.getAllByRole('button', { name: 'Cancel ride' });
    expect(cancels.some((b) => b.className.includes('h-10'))).toBe(true);
  });
});

describe('the Home card, in miniature', () => {
  it('on the way: the countdown, the van and its plate, linking to the Ride page', async () => {
    serveTrip('onWay');
    renderAs(<RideStrip />);
    const card = await screen.findByTestId('home-ride');
    await waitFor(() => expect(within(card).getByTestId('home-ride-line')).toHaveTextContent('Mike is 6 min away'));
    expect(card).toHaveTextContent('Van 1 · To work');
    expect(within(card).getByText('ALT 101')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Your ride/ })).toHaveAttribute('href', '/rides');
    expect(within(card).getByRole('list', { name: 'Map of your van' })).toBeInTheDocument();
    expect(within(card).queryByTestId('home-owed')).not.toBeInTheDocument();
  });

  it('late, it says so on the card', async () => {
    serveTrip('late');
    renderAs(<RideStrip />);
    const card = await screen.findByTestId('home-ride');
    await waitFor(() => expect(card).toHaveTextContent('Running 4 min late'));
  });

  it('arrived: "Mike is here", what to look for, and "I’m outside" right there', async () => {
    const posted: unknown[] = [];
    serveTrip('arrived', {}, {}, (path, init) => {
      if (path === '/transport/me/rides/r1/signal' && init?.method === 'POST') {
        posted.push(init.body);
        return { ok: true };
      }
    });
    renderAs(<RideStrip />);
    const card = await screen.findByTestId('home-ride');
    await waitFor(() => expect(within(card).getByTestId('home-ride-line')).toHaveTextContent('Mike is here'));
    expect(card).toHaveTextContent('Look for the white Ford Transit');
    await userEvent.click(within(card).getByRole('button', { name: 'I’m outside' }));
    await waitFor(() => expect(posted).toEqual([{ kind: 'OUTSIDE' }]));
    expect(await within(card).findByRole('status')).toHaveTextContent('Mike knows you’re outside');
  });

  it('what they owe shows in one line only above zero', async () => {
    serveTrip('onWay', {}, { charges: { pendingCents: 1500, rides: 3, noShows: 0, nextPayday: { ...PAYDAY, periodEnd: '2099-01-01' } } });
    renderAs(<RideStrip />);
    const owed = await screen.findByTestId('home-owed');
    expect(owed).toHaveTextContent(/^You owe \$15\.00 for rides · from your pay \w{3}, Nov 13$/);
    expect(owed).toHaveAttribute('href', '/rides?view=charges');
  });
});

describe('what they owe, and the ledger', () => {
  it('nothing owed is quiet: muted words, no coloured zero', async () => {
    routes((path) => (path === '/transport/me' ? me() : undefined));
    renderAs(<RideHome />, '/rides');
    const card = await screen.findByTestId('owed-card');
    expect(card).toHaveTextContent('What you owe · Nothing owed');
    expect(card).not.toHaveTextContent('$0.00');
    expect(card.innerHTML).not.toMatch(/positive|negative|success|alert/);
  });

  it('owed: the amount, the payday it comes out on, what it is for, and the way into the ledger', async () => {
    routes((path) => (path === '/transport/me' ? me({ charges: { pendingCents: 1500, rides: 2, noShows: 1, nextPayday: PAYDAY } }) : undefined));
    renderAs(<RideHome />, '/rides');
    const card = await screen.findByTestId('owed-card');
    expect(card).toHaveTextContent(/\$15\.00 · comes out of your pay on \w{3}, Nov 13/);
    expect(card).toHaveTextContent('2 rides · 1 no-show fee');
    await userEvent.click(within(card).getByRole('button', { name: 'See every charge' }));
    expect(await screen.findByTestId('ride-view-charges')).toBeInTheDocument();
  });

  const ledgerRides = (): Ride[] => [
    ride({ id: 'p1', status: 'COMPLETED', serviceDate: '2026-10-27', targetAt: '2026-10-27T12:00:00.000Z', owedCents: 500 }),
    ride({ id: 'n1', status: 'NO_SHOW', serviceDate: '2026-10-26', targetAt: '2026-10-26T12:00:00.000Z', owedCents: 100 }),
    ride({ id: 'w1', status: 'NO_SHOW', serviceDate: '2026-10-25', targetAt: '2026-10-25T12:00:00.000Z', waived: true, waiveKind: 'MANAGER', waiveReason: 'The van was early' }),
    ride({ id: 'x1', status: 'CANCELLED', serviceDate: '2026-10-28', targetAt: '2026-10-28T12:00:00.000Z', cancelReason: 'The van didn’t run' }),
    ride({ id: 't1', status: 'COMPLETED', serviceDate: '2026-10-14', targetAt: '2026-10-14T12:00:00.000Z', charged: true, chargedPayDate: '2026-10-30' } as Partial<Ride> & { id: string }),
    ride({ id: 'h1', status: 'COMPLETED', serviceDate: '2026-10-24', targetAt: '2026-10-24T12:00:00.000Z', owedCents: 500, heldForSignature: true }),
  ];

  it('the ledger’s states in words: pending, held, taken on a payday, waived with its reason, not charged when the van didn’t run', () => {
    const rows = chargeRows(ledgerRides());
    const state = Object.fromEntries(rows.map((r) => [r.ride.id, r.state]));
    expect(state).toEqual({ p1: 'pending', n1: 'pending', w1: 'waived', x1: 'notRun', t1: 'taken', h1: 'held' });
    expect(rows.find((r) => r.ride.id === 'n1')).toMatchObject({ kind: 'noShow', cents: 100, counts: true });
    expect(rows.find((r) => r.ride.id === 'w1')).toMatchObject({ reason: 'The van was early', counts: false });
    expect(rows.find((r) => r.ride.id === 'x1')).toMatchObject({ cents: 500, counts: false });
    const groups = chargeGroups(rows, PAYDAY);
    expect(groups.map((g) => g.key)).toEqual(['current', 'held', 'paid-2026-10-30']);
    expect(groups[0]!.totalCents).toBe(600);
    expect(fareWords((k, v) => `${k}|${JSON.stringify(v)}`, 500, PAYDAY, '2026-10-27')).toContain('ride.fare.words');
  });

  it('the ledger page: a running total for this pay period, past paydays folded, waived and not-run said in words', async () => {
    routes((path) => (path === '/transport/me' ? me({ rides: ledgerRides(), charges: { pendingCents: 1100, rides: 2, noShows: 1, nextPayday: PAYDAY } }) : undefined));
    renderAs(<RideHome />, '/rides?view=charges');
    const current = await screen.findByTestId('ledger-current');
    expect(within(current).getByTestId('ledger-running')).toHaveTextContent('$6.00');
    expect(within(current).getByText(/Comes out of your pay on \w{3}, Nov 13/, { selector: 'p' })).toBeInTheDocument();
    expect(within(current).getByText(/Waived — The van was early/)).toBeInTheDocument();
    expect(within(current).getByText(/The van didn’t run — nothing charged/)).toBeInTheDocument();
    const rows = within(current).getAllByTestId('ledger-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['notRun', 'pending', 'pending', 'waived']);
    // Uncharged amounts are struck through, never coloured.
    const notRun = rows[0]!;
    expect(within(notRun).getByText('$5.00')).toHaveClass('line-through');
    expect(within(notRun).getByText('Not charged')).toBeInTheDocument();
    expect(within(notRun).queryByRole('button', { name: 'Question a charge' })).not.toBeInTheDocument();
    // A past payday, folded.
    const paid = screen.getByTestId('ledger-paid-2026-10-30');
    expect(paid.tagName).toBe('DETAILS');
    expect(paid).not.toHaveAttribute('open');
    expect(within(paid).getByText(/Taken on payday \w{3}, Oct 30/)).toBeInTheDocument();
    expect(screen.getByTestId('ledger-held')).toHaveTextContent('Held until you sign the ride authorization');
  });

  it('"Question a charge" opens the problem form on that ride, as a charge dispute — never a waive', async () => {
    const sent: unknown[] = [];
    routes((path, init) => {
      if (path === '/transport/me') return me({ rides: ledgerRides(), charges: { pendingCents: 1100, rides: 2, noShows: 1, nextPayday: PAYDAY } });
      if (path === '/transport/issues' && init?.method === 'POST') {
        sent.push(init.body);
        return { issue: { id: 'i1' } };
      }
    });
    renderAs(<RideHome />, '/rides?view=charges');
    const current = await screen.findByTestId('ledger-current');
    expect(screen.queryByRole('button', { name: /waive/i })).not.toBeInTheDocument();
    const noShowRow = within(current).getAllByTestId('ledger-row').find((r) => r.textContent?.includes('No-show fee'))!;
    await userEvent.click(within(noShowRow).getByRole('button', { name: 'Question a charge' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/What happened/)).toHaveValue('CHARGE_DISPUTE');
    expect(within(dialog).getByLabelText(/Which ride/)).toHaveValue('n1');
  });
});

describe('the shared trip page (/track/:token) — logged out', () => {
  function renderTrack() {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/track/tok']}>
          <Routes>
            <Route path="/track/:token" element={<TrackPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('valid: the van on the map, the ETA to the stop in big type, the plate — nothing personal', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      trip: {
        status: 'ACTIVE',
        van: { name: 'Van 1', plate: 'ALT 101' },
        driver: 'Mike',
        position: { lat: 30.22, lng: -85.88, heading: 90, speedMps: 10, at: new Date().toISOString() },
        stale: false,
        next: { kind: 'pickup', label: 'Seaside Housing', etaAt: minutesFromNow(7.2) },
        stopsLeft: 3,
        endedAt: null,
        generatedAt: new Date().toISOString(),
      },
    } as never);
    renderTrack();
    expect(await screen.findByRole('heading', { level: 1, name: 'About 7 min to Seaside Housing' })).toBeInTheDocument();
    expect(screen.getByText('ALT 101')).toBeInTheDocument();
    expect(screen.getByText('3 stops left')).toBeInTheDocument();
    expect(screen.getByLabelText('Where Van 1 is')).toBeInTheDocument();
    expect(screen.getByText(/never who is riding or where anyone lives/)).toBeInTheDocument();
  });

  it('expired and invalid links each say so', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError(410, 'link_expired', 'x'));
    renderTrack();
    expect(await screen.findByText('This shared trip has ended')).toBeInTheDocument();
    expect(screen.getByTestId('link-problem')).toHaveAttribute('data-kind', 'expired');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
