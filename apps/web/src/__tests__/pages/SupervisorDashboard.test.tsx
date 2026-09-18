import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { minuteOfDayInZone } from '@alto-people/shared';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn(),
  getSchedulingKpis: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({ listClientLocations: vi.fn() }));
vi.mock('@/components/RoleDecisionQueue', () => ({ RoleDecisionQueue: () => <div>decision queue</div> }));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => <div>my plan</div> }));
vi.mock('@/pages/portal/portalCharts', async (orig) => ({
  ...(await orig<typeof import('@/pages/portal/portalCharts')>()),
  CoverageCurve: () => <div>coverage curve</div>,
  WeekFillChart: () => <div>week chart</div>,
}));

import { apiFetch } from '@/lib/api';
import { getSchedulingKpis, listShifts } from '@/lib/schedulingApi';
import { listClientLocations } from '@/lib/clientsApi';
import { SupervisorDashboard } from '@/pages/SupervisorDashboard';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const row = (id: string, name: string | null, state: string, from = -2, to = 6) => ({
  shiftId: id,
  associateId: name ? `a-${id}` : null,
  name,
  position: 'Server',
  isLead: false,
  clockInAt: state === 'on-floor' ? at(from) : null,
  clockOutAt: null,
  startsAt: at(from),
  endsAt: at(to),
  timezone: tz,
  locationId: 'l1',
  locationName: 'Front Beach 218',
  state,
});

function day(roster: ReturnType<typeof row>[]) {
  return {
    client: { id: 'c1', name: 'Coastal Resort Holdings' },
    store: null,
    date: new Date().toISOString().slice(0, 10),
    today: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    target: 4,
    roster,
    summary: { expected: 3, worked: 2, onFloor: 2, missed: 0, open: 1 },
  };
}

type Live = Array<{ associateId: string; name: string; clockInAt: string; position: string | null }>;
type MyWindow = { label: string; startMinute: number; endMinute: number; targetCount: number };

function renderPage(
  opts: {
    onFloorNow?: Live;
    extraRows?: ReturnType<typeof row>[];
    myWindows?: MyWindow[];
    kpis?: { fillRatePercent: number; assignedShifts: number; completedShifts: number; openShifts: number };
    sop?: Record<string, unknown> | null;
    submitted?: Record<string, unknown> | null;
    clockedIn?: boolean;
  } = {},
) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/ops/my-sop') return { sop: opts.sop ?? null, submitted: opts.submitted ?? null };
    if (path === '/time/me/active') return { active: opts.clockedIn ? { id: 'e1' } : null };
    if (path === '/me/shift-windows')
      return {
        windows: (opts.myWindows ?? []).map((w) => ({
          ...w,
          locationId: 'l1',
          locationName: 'Front Beach 218',
          timezone: tz,
        })),
      };
    if (path.startsWith('/client-portal/day?date=')) return day([row('t1', 'Cy Dale', 'unconfirmed', 20, 28)]);
    if (path.startsWith('/client-portal/day'))
      return {
        ...day([
          row('s1', 'Ann Lee', 'on-floor'),
          row('s2', 'Ben Ray', 'on-floor'),
          row('s3', 'Cy Dale', 'not-in'),
          row('s4', null, 'open'),
          ...(opts.extraRows ?? []),
        ]),
        ...(opts.onFloorNow ? { onFloorNow: opts.onFloorNow } : {}),
      };
    if (path === '/approvals/count')
      return { swaps: 1, pickups: 2, timeOff: 2, timesheets: 6, clockIns: 1, total: 12 };
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(listShifts).mockResolvedValue({ shifts: [] } as never);
  vi.mocked(getSchedulingKpis).mockResolvedValue({
    fillRatePercent: 94,
    assignedShifts: 80,
    completedShifts: 8,
    openShifts: 6,
    draftShifts: 0,
    totalShifts: 94,
    totalScheduledMinutes: 0,
    projectedLaborCost: null,
    shiftsWithoutRate: null,
    from: '',
    to: '',
    ...opts.kpis,
  });
  vi.mocked(listClientLocations).mockResolvedValue({
    locations: [
      {
        id: 'l1',
        clientId: 'c1',
        name: 'Front Beach 218',
        addressLine1: '15495 Panama City Beach Pkwy',
        addressLine2: null,
        city: 'Panama City Beach',
        state: 'FL',
        zip: '32413',
        latitude: null,
        longitude: null,
        geofenceRadiusMeters: null,
        isActive: true,
      },
    ],
  } as never);

  const caps = ROLE_CAPABILITIES.SHIFT_SUPERVISOR;
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      email: 'dana.reyes@altohr.com',
      role: 'SHIFT_SUPERVISOR' as const,
      status: 'ACTIVE' as const,
      clientId: 'c1',
      clientName: 'Coastal Resort Holdings',
      associateId: 'a',
    },
    role: 'SHIFT_SUPERVISOR' as const,
    capabilities: new Set<Capability>(caps),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: (c: Capability) => caps.has(c),
  };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <SupervisorDashboard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('<SupervisorDashboard> — My floor', () => {
  it('leads with the place and the floor against the contracted line', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' })).toBeInTheDocument();
    expect(screen.getByText(/15495 Panama City Beach Pkwy · Panama City Beach, FL 32413/)).toBeInTheDocument();
    expect(screen.getByText('/ 4')).toBeInTheDocument();
    expect(screen.getByText(/2 short of the contracted headcount/)).toBeInTheDocument();
    expect(screen.getByText('coverage curve')).toBeInTheDocument();
  });

  it('carries the four numbers the week runs on, each explained', async () => {
    renderPage();
    expect(await screen.findByText('94%')).toBeInTheDocument();
    // The store's workweek — the week the store manager's portal grades.
    expect(getSchedulingKpis).toHaveBeenCalledWith({ week: 'this' });
    expect(getSchedulingKpis).toHaveBeenCalledWith({ week: 'last' });
    expect(screen.getByText('88 of 94 shifts filled')).toBeInTheDocument();
    expect(await screen.findByText('1 walk-in · 1 swap · 2 pickups · 2 time off · 6 timesheets')).toBeInTheDocument();
    expect(screen.getByText('Waiting on you').closest('a')).toHaveAttribute('href', '/approvals');
    expect(await screen.findByText(/1 awaiting confirmation/)).toBeInTheDocument();
  });

  it('shows shifts as waves and people as faces — never a roster of names, never money', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' });
    expect(screen.getByText('Who is in').closest('a')).toHaveAttribute('href', '/today');
    for (const link of screen.getAllByRole('link', { name: /open schedule/i })) {
      expect(link).toHaveAttribute('href', '/scheduling');
    }
    // The names live on the face wall (/today), not as rows here.
    expect(screen.queryByText('Ann Lee')).not.toBeInTheDocument();
    expect(screen.queryByText('Cy Dale')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it('counts everyone clocked in — walk-ins and covers too — not just matched shifts', async () => {
    // Two matched to their shifts, plus a walk-in and a cover with none.
    const clockIn = new Date().toISOString();
    renderPage({
      onFloorNow: [
        { associateId: 'a-s1', name: 'Ann Lee', clockInAt: clockIn, position: 'Server' },
        { associateId: 'a-s2', name: 'Ben Ray', clockInAt: clockIn, position: 'Server' },
        { associateId: 'a-w1', name: 'Wes Park', clockInAt: clockIn, position: null },
        { associateId: 'a-w2', name: 'Rosa Vega', clockInAt: clockIn, position: null },
      ],
    });
    await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' });
    // 4 on the floor against a target of 4 — met, not "2 short".
    expect(screen.getByText(/Staffed to the contracted headcount/)).toBeInTheDocument();
    expect(screen.queryByText(/short of the contracted headcount/)).not.toBeInTheDocument();
  });

  it('opens on their shift — their crew against their window — with the whole store one tap away', async () => {
    try {
      sessionStorage.removeItem('alto.floor.focus');
    } catch {
      /* no storage in this env */
    }
    const user = userEvent.setup();
    const clockIn = new Date().toISOString();
    // Swing runs from 3 hours ago to an hour from now; Zed's shift began
    // 8 hours ago, so he's on the floor but not on Dana's shift.
    const mod = (h: number) => minuteOfDayInZone(new Date(Date.now() + h * 3_600_000), tz);
    renderPage({
      myWindows: [{ label: 'Swing', startMinute: mod(-3), endMinute: mod(1), targetCount: 5 }],
      extraRows: [row('x1', 'Zed Old', 'on-floor', -8, 0.5)],
      onFloorNow: [
        { associateId: 'a-s1', name: 'Ann Lee', clockInAt: clockIn, position: 'Server' },
        { associateId: 'a-s2', name: 'Ben Ray', clockInAt: clockIn, position: 'Server' },
        { associateId: 'a-x1', name: 'Zed Old', clockInAt: clockIn, position: 'Server' },
        { associateId: 'a-w1', name: 'Wes Park', clockInAt: clockIn, position: null },
      ],
    });
    // Ann, Ben and walk-in Wes are Swing; Zed isn't. 3 of Swing's 5.
    expect(await screen.findByText(/2 short of Swing's target right now/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /My shift · Swing/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('/ 5')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Whole store' }));
    // All four against the store's contracted 4.
    expect(await screen.findByText(/Staffed to the contracted headcount/)).toBeInTheDocument();
    expect(screen.getByText('/ 4')).toBeInTheDocument();
  });

  it('reads a week with nothing scheduled yet as a dash, not 0%', async () => {
    renderPage({ kpis: { fillRatePercent: 0, assignedShifts: 0, completedShifts: 0, openShifts: 0 } });
    expect(await screen.findByText('Nothing scheduled this week yet')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('keeps their open SOP on top — progress, due time, and the way back into it', async () => {
    renderPage({
      sop: {
        id: 'sop1', windowLabel: 'Overnight', position: 'Overnight shift', locationName: 'Front Beach 218',
        dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), openedAt: new Date().toISOString(),
        sopDone: 3, sopTotal: 12, requiredOpen: 9, handoverCount: 0,
      },
    });
    const banner = await screen.findByText('Your Overnight SOP is open');
    expect(screen.getByText(/3 of 12 done/)).toBeInTheDocument();
    expect(screen.getByText(/submit it before you clock out/)).toBeInTheDocument();
    expect(banner.closest('a')).toHaveAttribute('href', '/ops?tab=shift&shift=sop1');
  });

  it("off the clock, the shift starts on My floor — Clock in, and the SOP opens", async () => {
    renderPage({ clockedIn: false });
    expect(await screen.findByText("You're off the clock")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeInTheDocument();
  });

  it('on the clock with no SOP open, no clock card', async () => {
    renderPage({ clockedIn: true });
    await screen.findByRole('heading', { level: 1, name: 'Front Beach 218' });
    expect(screen.queryByText("You're off the clock")).not.toBeInTheDocument();
  });

  it("SOP submitted and still on the clock: it says so, and the clock-out is right there", async () => {
    renderPage({
      clockedIn: true,
      submitted: { id: 's1', windowLabel: 'Morning', position: 'Morning shift', closedAt: new Date().toISOString(), closedIncomplete: false },
    });
    expect(await screen.findByText('Your Morning SOP is submitted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock out' })).toBeInTheDocument();
  });
});
