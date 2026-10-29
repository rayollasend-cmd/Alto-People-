import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ROLE_CAPABILITIES, type Capability, type Role, type TransportOpsBoard } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { transportOpsKeys } from '@/lib/transportOpsApi';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/rideAlerts', async (orig) => ({
  ...(await orig<typeof import('@/lib/rideAlerts')>()),
  rideAlert: vi.fn(),
}));
// The map is MapLibre (WebGL) — here, a list of what it was asked to draw.
const mapProps: Array<Record<string, unknown>> = [];
vi.mock('@/components/transport/LazyLiveMap', () => ({
  LazyLiveMap: (props: { markers: Array<{ id: string; label?: string; tone?: string; hollow?: boolean; struck?: boolean }>; ariaLabel: string; onMarkerClick?: (id: string) => void }) => {
    mapProps.push(props as never);
    return (
      <ul aria-label={props.ariaLabel}>
        {props.markers.map((m) => (
          <li key={m.id} data-tone={m.tone ?? ''} data-hollow={m.hollow ? '1' : ''} data-struck={m.struck ? '1' : ''}>
            <button type="button" onClick={() => props.onMarkerClick?.(m.id)}>
              {m.label}
            </button>
          </li>
        ))}
      </ul>
    );
  },
}));

import { apiFetch } from '@/lib/api';
import { rideAlert } from '@/lib/rideAlerts';
import { LiveOpsTab } from '@/pages/transport/live/LiveOpsTab';
import { ExceptionsQueue } from '@/pages/transport/live/ExceptionsQueue';
import { TransportKpiRow } from '@/pages/transport/live/TransportKpiRow';
import { busyLiveRuns, busyMorning, KPIS } from './fixtures/busyMorning';

/**
 * The desk's live operations (2026-10-28): Tasha runs six vans from a
 * desktop. The Live map is never empty, every van reads in one row, what
 * needs her sits on top with its one-click fix, an SOS is a red banner
 * that chimes, and the week's four measures read like the board's.
 */

type Handler = (path: string, init?: { method?: string; body?: unknown }) => unknown;
function routes(handler: Handler) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const out = handler(path, init);
    if (out === undefined) throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`);
    return out as never;
  });
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.search}</div>;
}

function renderAs(ui: ReactNode, { role = 'TRANSPORTATION_DIRECTOR' as Role, url = '/transport?tab=live', client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) } = {}) {
  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u', email: 'transport@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
    role,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  const utils = render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={auth}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[url]}>
            {ui}
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

const where = () => screen.getByTestId('where').textContent ?? '';

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(rideAlert).mockReset();
  mapProps.length = 0;
});

describe('<LiveOpsTab> — a busy morning', () => {
  function busy(over: Partial<TransportOpsBoard> = {}) {
    const board = { ...busyMorning(), ...over };
    routes((path) => {
      if (path.startsWith('/transport/ops')) return board;
      if (path.startsWith('/transport/live')) return { date: board.date, generatedAt: board.generatedAt, runs: busyLiveRuns() };
    });
    return board;
  }

  it('puts every van with a position on the map, coloured by what it is doing', async () => {
    busy();
    renderAs(<LiveOpsTab />);
    const map = await screen.findByRole('list', { name: 'Live map of the vans' });
    const items = within(map).getAllByRole('listitem');
    // Six of seven vans have a position; Van 7 never reported one.
    expect(items).toHaveLength(6);
    const tone = (name: RegExp) => within(map).getByRole('button', { name }).closest('li')!;
    expect(tone(/^Van 1 · Mike Chen · On time/).dataset.tone).toBe('positive');
    expect(tone(/^Van 2 · Rosa Diaz · 9 min late/).dataset.tone).toBe('caution');
    // Van 3 is 17 minutes late — and its driver pressed SOS.
    expect(tone(/^Van 3 · Andre Baptiste · SOS/).dataset.tone).toBe('negative');
    expect(tone(/^Van 4 · Tom Price · No signal/).dataset.hollow).toBe('1');
    expect(tone(/^Van 5 · Mike Chen · Leaves/).dataset.tone).toBe('neutral');
    expect(tone(/^Van 6 · Idle/).dataset.tone).toBe('neutral');
    // The day's routes, one per van on the road.
    const last = mapProps[mapProps.length - 1]!;
    expect((last.routes as unknown[]).length).toBe(4);
    expect(last.fitOnce).toBe(true);
  });

  it('lists the vans grouped — On the road, Leaving later, Idle, Out of service — each row with its driver, chip, next stop and riders', async () => {
    busy();
    renderAs(<LiveOpsTab />);
    const panel = await screen.findByRole('complementary', { name: 'The fleet right now' });
    const road = within(panel).getByRole('region', { name: /On the road/ });
    const rows = within(road).getAllByRole('listitem');
    // The SOS first, then the latest.
    expect(rows.map((r) => r.querySelector('.font-semibold')?.textContent)).toEqual(['Van 3', 'Van 2', 'Van 1', 'Van 4']);
    const van2 = rows[1]!;
    expect(van2).toHaveTextContent('ALT 102');
    expect(van2).toHaveTextContent('Rosa Diaz · To work');
    expect(van2).toHaveTextContent('9 min late');
    expect(van2).toHaveTextContent(/Next: Seaside Housing · ETA \d{1,2}:\d{2}\s?[AP]M \(due \d{1,2}:\d{2}\s?[AP]M\)/);
    expect(van2).toHaveTextContent('6 on board · 2 to pick up');
    expect(within(van2).getByRole('link', { name: 'Call Rosa Diaz' })).toHaveAttribute('href', 'tel:+18505550102');
    // A zero is left out, not shown (Van 3 has nobody on board yet).
    expect(rows[0]).toHaveTextContent('5 to pick up');
    expect(rows[0]).not.toHaveTextContent('0 on board');
    // Gone quiet: when it was last heard from.
    expect(rows[3]).toHaveTextContent('No signal');
    expect(rows[3]).toHaveTextContent('Last seen 6 min ago');

    expect(within(panel).getByRole('region', { name: /Leaving later/ })).toHaveTextContent(/Leaves \d{1,2}:\d{2}\s?[AP]M · 8 riders/);
    expect(within(panel).getByRole('region', { name: /^Idle/ })).toHaveTextContent(/Parked — last seen/);
    expect(within(panel).getByRole('region', { name: /Out of service/ })).toHaveTextContent('Van 7');
    expect(within(panel).getByRole('heading', { name: /Fleet/ })).toHaveTextContent('4 of 7 on the road');
  });

  it('a van picked in the list brings the map to it and draws its stops; a van tapped on the map is picked in the list', async () => {
    busy();
    renderAs(<LiveOpsTab />);
    const panel = await screen.findByRole('complementary', { name: 'The fleet right now' });
    const pick = within(panel).getByRole('button', { name: /^Van 2/ });
    await userEvent.click(pick);
    expect(pick).toHaveAttribute('aria-pressed', 'true');
    const last = mapProps[mapProps.length - 1]!;
    expect(last.focus).toMatchObject({ lat: 30.2012, lng: -85.8601 });
    const map = screen.getByRole('list', { name: 'Live map of the vans' });
    expect(within(map).getByRole('button', { name: 'Seaside Housing' })).toBeInTheDocument();
    expect(within(map).getByRole('button', { name: 'Front Beach 218' })).toBeInTheDocument();
    expect((last.routes as Array<{ id: string; strong: boolean }>).find((r) => r.id === 'run2')!.strong).toBe(true);

    await userEvent.click(within(map).getByRole('button', { name: /^Van 4/ }));
    expect(within(panel).getByRole('button', { name: /^Van 4/ })).toHaveAttribute('aria-pressed', 'true');
    expect(pick).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens on the depot when no van has a position, and is never an empty box', async () => {
    const board = busyMorning();
    routes((path) => {
      if (path.startsWith('/transport/ops'))
        return { ...board, vans: board.vans.map((v) => ({ ...v, state: v.state === 'out_of_service' ? v.state : 'planned', position: null, run: null, nextRun: { runId: `n-${v.vanId}`, departAt: new Date(Date.now() + 3_600_000).toISOString(), driverName: 'Mike Chen', riders: 3 } })), exceptions: [] };
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] };
    });
    renderAs(<LiveOpsTab />);
    await screen.findByRole('complementary', { name: 'The fleet right now' });
    const last = mapProps[mapProps.length - 1]!;
    expect(last.markers).toEqual([]);
    expect(last.center).toEqual({ lat: 30.1766, lng: -85.8055 });
    expect(screen.getByRole('region', { name: /Leaving later/ })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Nothing needs you right now.');
  });

  it('says so — and how to fix it — when there is no fleet yet', async () => {
    routes((path) => {
      if (path.startsWith('/transport/ops')) return { ...busyMorning(), vans: [], exceptions: [] };
      if (path.startsWith('/transport/live')) return { date: '', generatedAt: '', runs: [] };
    });
    renderAs(<LiveOpsTab />);
    expect(await screen.findByText('No vans in the fleet yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add a van' }));
    expect(where()).toContain('tab=vans');
  });

  it('reads "Not closed" with Close run for a run nobody finished, and closes it', async () => {
    const board = busy();
    const runs = busyLiveRuns().map((r) => (r.runId === 'run1' ? { ...r, stuck: true } : r));
    routes((path, init) => {
      if (path.startsWith('/transport/ops')) return board;
      if (path.startsWith('/transport/live')) return { date: board.date, generatedAt: board.generatedAt, runs };
      if (path === '/transport/runs/run1/complete' && init?.method === 'POST') return { boarded: 4, unmarkedCancelled: 0 };
    });
    renderAs(<LiveOpsTab />);
    const panel = await screen.findByRole('complementary', { name: 'The fleet right now' });
    const row = within(panel).getByRole('button', { name: /^Van 1/ }).closest('li')!;
    await waitFor(() => expect(row).toHaveTextContent('Not closed'));
    expect(row).toHaveTextContent('The driver never completed this run.');
    expect(row).not.toHaveTextContent(/Next:/);
    await userEvent.click(within(row).getByRole('button', { name: 'Close run' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close the run' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/transport/runs/run1/complete', { method: 'POST' }));
  });

  it('a viewer without manage:transport sees the run but no Close run', async () => {
    const board = busy();
    const runs = busyLiveRuns().map((r) => (r.runId === 'run1' ? { ...r, stuck: true } : r));
    routes((path) => {
      if (path.startsWith('/transport/ops')) return board;
      if (path.startsWith('/transport/live')) return { date: board.date, generatedAt: board.generatedAt, runs };
    });
    const viewer = (Object.keys(ROLE_CAPABILITIES) as Role[]).find((r) => ROLE_CAPABILITIES[r].has('view:transport') && !ROLE_CAPABILITIES[r].has('manage:transport'));
    if (!viewer) return;
    renderAs(<LiveOpsTab />, { role: viewer });
    const panel = await screen.findByRole('complementary', { name: 'The fleet right now' });
    const row = within(panel).getByRole('button', { name: /^Van 1/ }).closest('li')!;
    await waitFor(() => expect(row).toHaveTextContent('Not closed'));
    expect(within(row).queryByRole('button', { name: 'Close run' })).toBeNull();
  });
});

describe('<ExceptionsQueue>', () => {
  function serve(board: TransportOpsBoard, extra: Handler = () => undefined) {
    routes((path, init) => extra(path, init) ?? (path.startsWith('/transport/ops') ? board : undefined));
  }

  it('lists what needs the desk, highest first: the severity in a word, the title with its number, what fixes it, how long ago', async () => {
    serve(busyMorning());
    renderAs(<ExceptionsQueue date={null} />);
    const queue = await screen.findByTestId('exceptions-queue');
    expect(within(queue).getByRole('heading', { name: /^Needs you\s*7$/ })).toBeInTheDocument();
    const rows = within(queue).getAllByRole('listitem');
    // The contract's order: highest severity first, then the oldest.
    expect(rows.map((r) => r.querySelector('p')?.textContent)).toEqual([
      'Van 3 is 17 minutes late at Bay Point Apartments',
      'Van 4 has had no signal for 6 minutes',
      'Mike Chen’s DOT card lapsed 2 days ago',
      '3 riders booked for today have no van',
      'Van 2 is 9 minutes late at Seaside Housing',
      'Issue 17: “Van was late twice this week”',
    ]);
    expect(rows[0]).toHaveTextContent('Urgent');
    expect(rows[0]).toHaveTextContent('12 min ago');
    expect(rows[0]).toHaveTextContent('Five riders are waiting.');
    expect(rows[2]).toHaveTextContent('Soon');
    expect(rows[2]).toHaveTextContent('1h 30m ago');
    expect(rows[5]).toHaveTextContent('FYI');
    expect(rows[5]).toHaveTextContent('2h 30m ago');
  });

  it('pins an SOS on top as a red banner, and chimes when one arrives', async () => {
    const quiet = { ...busyMorning(), exceptions: busyMorning().exceptions.filter((e) => e.kind !== 'sos') };
    serve(quiet);
    const { client } = renderAs(<ExceptionsQueue date={null} />);
    await screen.findByTestId('exceptions-queue');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rideAlert).not.toHaveBeenCalled();
    act(() => client.setQueryData(transportOpsKeys.ops(null), busyMorning()));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('SOS — Andre Baptiste in Van 3');
    expect(banner).toHaveTextContent('Flat tire on Back Beach Rd.');
    expect(within(banner).getByRole('link', { name: /Call driver/ })).toHaveAttribute('href', 'tel:+18505550103');
    expect(within(banner).getByRole('link', { name: /Open in Maps/ })).toHaveAttribute('href', expect.stringContaining('30.1903,-85.8212'));
    expect(rideAlert).toHaveBeenCalledWith('attention');
    expect(rideAlert).toHaveBeenCalledTimes(1);
  });

  it('“I’m on it” acknowledges the SOS and refetches the board', async () => {
    let acked = false;
    serve(busyMorning(), (path, init) => {
      if (path === '/transport/runs/run3/sos/ack' && init?.method === 'POST') {
        acked = true;
        return { ok: true };
      }
      if (path.startsWith('/transport/ops') && acked) return { ...busyMorning(), exceptions: busyMorning().exceptions.filter((e) => e.kind !== 'sos') };
    });
    renderAs(<ExceptionsQueue date={null} />);
    const banner = await screen.findByRole('alert');
    const opsCalls = () => vi.mocked(apiFetch).mock.calls.filter(([p]) => String(p).startsWith('/transport/ops')).length;
    const before = opsCalls();
    await userEvent.click(within(banner).getByRole('button', { name: 'I’m on it' }));
    expect(apiFetch).toHaveBeenCalledWith('/transport/runs/run3/sos/ack', { method: 'POST' });
    await waitFor(() => expect(opsCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('gives each row its one-click fix', async () => {
    serve(busyMorning());
    const onOpenRun = vi.fn();
    const onOpenRide = vi.fn();
    renderAs(<ExceptionsQueue date={null} onOpenRun={onOpenRun} onOpenRide={onOpenRide} />, { url: '/transport?tab=live&date=2026-10-28' });
    const queue = await screen.findByTestId('exceptions-queue');

    await userEvent.click(within(queue).getByRole('button', { name: /^Open run: Van 3/ }));
    expect(onOpenRun).toHaveBeenCalledWith('run3');

    // Calling the driver dials the van's driver.
    expect(within(queue).getByRole('link', { name: /^Call driver: Van 4/ })).toHaveAttribute('href', 'tel:+18505550104');

    await userEvent.click(within(queue).getByRole('button', { name: /^Assign a van/ }));
    expect(onOpenRide).toHaveBeenCalledWith(['r1', 'r2', 'r3']);

    await userEvent.click(within(queue).getByRole('button', { name: /^Open drivers/ }));
    expect(where()).toContain('tab=drivers');
    expect(where()).toContain('date=2026-10-28');

    await userEvent.click(within(queue).getByRole('button', { name: /^Open issue/ }));
    expect(where()).toContain('tab=issues');
    expect(where()).toContain('issue=iss-17');
  });

  it('without a host’s handler, Open run opens the Live map on that van', async () => {
    serve(busyMorning());
    renderAs(<ExceptionsQueue date={null} compact />, { url: '/transport' });
    const queue = await screen.findByTestId('exceptions-queue');
    await userEvent.click(within(queue).getByRole('button', { name: /^Open run: Van 3/ }));
    expect(where()).toContain('tab=live');
    expect(where()).toContain('run=run3');
  });

  it('compact: the SOS, the top three, and See all', async () => {
    serve(busyMorning());
    renderAs(<ExceptionsQueue date={null} compact />, { url: '/transport' });
    const queue = await screen.findByTestId('exceptions-queue');
    expect(within(queue).getByRole('alert')).toBeInTheDocument();
    expect(within(queue).getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(within(queue).getByRole('button', { name: 'See all 7' }));
    expect(where()).toContain('tab=live');
  });

  it('says all clear only once the board has loaded and nothing is there', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(() => new Promise((r) => (release = r)) as never);
    renderAs(<ExceptionsQueue date={null} />);
    expect(screen.queryByText(/Nothing needs you/)).toBeNull();
    await act(async () => release({ ...busyMorning(), exceptions: [] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing needs you — every van is on time.');
  });

  it('a viewer sees the SOS but cannot acknowledge it', async () => {
    serve(busyMorning());
    const viewer = (Object.keys(ROLE_CAPABILITIES) as Role[]).find((r) => ROLE_CAPABILITIES[r].has('view:transport') && !ROLE_CAPABILITIES[r].has('manage:transport'));
    if (!viewer) return;
    renderAs(<ExceptionsQueue date={null} />, { role: viewer });
    const banner = await screen.findByRole('alert');
    expect(within(banner).queryByRole('button', { name: 'I’m on it' })).toBeNull();
  });

  it('shows a retry when the board cannot load', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('boom'));
    renderAs(<ExceptionsQueue date={null} />);
    expect(await screen.findByRole('button', { name: /Retry|Try again/ })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs you/)).toBeNull();
  });
});

describe('<TransportKpiRow>', () => {
  it('shows the four measures in order: value, change against the 7 days before, status word and dot, the 8-week line, the definition', async () => {
    routes((path) => (path.startsWith('/transport/ops') ? { ...busyMorning(), kpis: [...KPIS].reverse() } : undefined));
    renderAs(<TransportKpiRow date={null} />);
    const row = await screen.findByTestId('transport-kpi-row');
    const cards = within(row).getAllByRole('article');
    expect(cards.map((c) => within(c).getByRole('heading').textContent)).toEqual(['On-time pickups', 'Seat use', 'Cost per ride', 'No-show rate']);

    const [onTime, seats, cost, noShow] = cards as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(onTime).toHaveTextContent('92.4%');
    expect(onTime).toHaveTextContent('+3.3 pts');
    expect(onTime).toHaveTextContent('vs the 7 days before');
    expect(onTime).toHaveTextContent('On track');
    expect(onTime).toHaveAttribute('title', expect.stringContaining('Pickups within 5 minutes'));
    expect(onTime).toHaveAccessibleDescription(expect.stringContaining('Pickups within 5 minutes'));
    expect(within(onTime).getByRole('img', { name: 'On-time pickups, the last 8 weeks' })).toBeInTheDocument();
    // Up is good for on-time…
    expect(within(onTime).getByText('+3.3 pts').parentElement!.className).toContain('text-positive-800');
    // …and down is bad for seat use.
    expect(within(seats).getByText('−2.2 pts').parentElement!.className).toContain('text-negative-800');
    // Money: down is good for cost per ride.
    expect(cost).toHaveTextContent('$14.20');
    expect(within(cost).getByText('−$0.85').parentElement!.className).toContain('text-positive-800');
    // A zero change is never coloured.
    expect(noShow).toHaveTextContent('No change on the 7 days before');
    expect(noShow.innerHTML).not.toMatch(/text-(positive|negative)-800[^"]*">No change/);
  });

  it('says there is nothing to compare yet without a week before, and draws no line under four readings', async () => {
    routes((path) =>
      path.startsWith('/transport/ops')
        ? { ...busyMorning(), kpis: [{ ...KPIS[0]!, compare: null, delta: null, trend: [null, null, null, null, null, 90, 91, 92.4], status: 'none', statusLabel: 'Not enough rides yet' }] }
        : undefined,
    );
    renderAs(<TransportKpiRow date={null} />);
    const card = await screen.findByTestId('transport-kpi-onTime');
    expect(card).toHaveTextContent('Nothing to compare yet');
    expect(card).toHaveTextContent('Not enough rides yet');
    expect(within(card).queryByRole('img')).toBeNull();
  });
});
