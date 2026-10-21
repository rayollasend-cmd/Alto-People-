import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
vi.mock('@/lib/programsApi', () => ({ listMyProgramAlerts: vi.fn().mockResolvedValue({ alerts: [], settings: {} }) }));
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
    helping?: Record<string, unknown> | null;
    clockedIn?: boolean;
    role?: 'SHIFT_SUPERVISOR' | 'FLOOR_SUPERVISOR';
    floorTeam?: Record<string, unknown>;
    arrivals?: Array<Record<string, unknown>>;
    flags?: Array<Record<string, unknown>>;
    handover?: Array<Record<string, unknown>>;
    week?: Array<Record<string, unknown>>;
    lateNow?: Array<Record<string, unknown>>;
  } = {},
) {
  const role = opts.role ?? 'SHIFT_SUPERVISOR';
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === '/ops/my-sop')
      return { sop: opts.sop ?? null, submitted: opts.submitted ?? null, helping: opts.helping ?? null };
    if (path === '/me/floor-team') return opts.floorTeam ?? { role: null };
    if (path === '/shift-covers' && init?.method === 'POST')
      return { cover: { id: 'cv1', ...(init.body as object), note: null, coverName: 'Marcus Hill' } };
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
    if (path === '/transport/arrivals') return { arrivals: opts.arrivals ?? [] };
    // The floor from a phone (field roles, 2026-10).
    if (path === '/floor/flags') return { flags: opts.flags ?? [] };
    if (path.startsWith('/floor/flags/') && init?.method === 'POST') return { ok: true };
    if (path === '/floor/handover') return { items: opts.handover ?? [] };
    if (path === '/floor/week') return { today: '2026-10-17', timezone: tz, days: opts.week ?? [] };
    if (path === '/approvals/count')
      return { swaps: 1, pickups: 2, timeOff: 2, timesheets: 6, clockIns: 1, total: 12 };
    // Attendance insights: who isn't in, and eight weeks of fill.
    if (path.startsWith('/attendance/late-now'))
      return { generatedAt: at(0), graceMinutes: 7, noShowRiskMinutes: 30, canText: role === 'SHIFT_SUPERVISOR', people: opts.lateNow ?? [] };
    if (path.startsWith('/attendance/trends'))
      return {
        generatedAt: at(0),
        siteId: null,
        fillTargetPct: 95,
        weeks: ['2026-10-03', '2026-10-10', '2026-10-17'].map((weekStart, i) => ({ weekStart, inProgress: i === 2, scheduledShifts: 20, filledShifts: 18 + i, fillRatePct: 90 + i * 5, noCallNoShows: 0, callOuts: 0, lates: 0, overtimeHours: 0 })),
      };
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

  const caps = ROLE_CAPABILITIES[role];
  const auth = {
    isInitializing: false,
    isOffline: false,
    user: {
      id: 'u',
      // The greeting uses the account's first name, never the mailbox.
      firstName: 'Dana',
      email: 'dana.reyes@altohr.com',
      role,
      status: 'ACTIVE' as const,
      clientId: 'c1',
      clientName: 'Coastal Resort Holdings',
      associateId: 'a',
    },
    role,
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
    expect(await screen.findByRole('heading', { level: 1, name: /, Dana.$/ })).toBeInTheDocument();
    expect(await screen.findByText('Front Beach 218')).toBeInTheDocument();
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
    await screen.findByText('Front Beach 218');
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
    await screen.findByText('Front Beach 218');
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

  it('names the block to work now and what is overdue', async () => {
    renderPage({
      sop: {
        id: 'sop1', windowLabel: 'Morning', position: 'Morning shift', locationName: 'Front Beach 218',
        dueAt: new Date(Date.now() + 5 * 3_600_000).toISOString(), openedAt: new Date().toISOString(),
        sopDone: 8, sopTotal: 40, requiredOpen: 30, handoverCount: 0, overdue: 3,
        block: { section: 'Backroom · 7:30–9:30', dueAt: new Date(Date.now() - 10 * 60_000).toISOString(), open: 3 },
      },
    });
    expect(await screen.findByText(/Now: Backroom · 7:30–9:30 · 3 left · was due/)).toBeInTheDocument();
    expect(screen.getByText('· 3 overdue')).toBeInTheDocument();
  });

  it("off the clock, the shift starts on My floor — Clock in, and the SOP opens", async () => {
    renderPage({ clockedIn: false });
    expect(await screen.findByText("You're off the clock")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeInTheDocument();
  });

  it('on the clock with no SOP open, no clock card', async () => {
    renderPage({ clockedIn: true });
    await screen.findByText('Front Beach 218');
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

const marcusOn = new Date(Date.now() - 90 * 60_000).toISOString();
const leadTeam = {
  role: 'lead',
  today: new Date().toISOString().slice(0, 10),
  team: [
    {
      userId: 'u-marcus',
      name: 'Marcus Hill',
      associateId: 'a-marcus',
      onClockSince: marcusOn,
      windows: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Swing', startMinute: 840, endMinute: 1320 }],
      coveringToday: false,
    },
  ],
  covers: [],
};
const floorTeam = (covers: unknown[] = []) => ({
  role: 'floor',
  today: new Date().toISOString().slice(0, 10),
  lead: {
    userId: 'u-dana',
    name: 'Dana Reyes',
    associateId: 'a-dana',
    onClockSince: null,
    windows: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Swing', startMinute: 840, endMinute: 1320 }],
  },
  covers,
});

describe('<SupervisorDashboard> — the shift supervisor and their floor supervisors', () => {
  it('lists who reports to them, on the clock or not, one tap to message', async () => {
    renderPage({ clockedIn: true, floorTeam: leadTeam });
    expect(await screen.findByText('My floor supervisors')).toBeInTheDocument();
    expect(screen.getByText('Marcus Hill')).toBeInTheDocument();
    expect(screen.getByText(/On the clock since/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Message Marcus Hill' })).toHaveAttribute('href', '/messages?to=u-marcus');
  });

  it('hands their shift to a floor supervisor for a day', async () => {
    const user = userEvent.setup();
    renderPage({ clockedIn: true, floorTeam: leadTeam });
    await user.click(await screen.findByRole('button', { name: /Hand over my shift/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/can.t clock out until it.s submitted/);
    // One floor supervisor: already picked.
    expect(screen.getByRole('radio', { name: /Marcus Hill/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Hand over' }));
    const today = new Date().toISOString().slice(0, 10);
    expect(apiFetch).toHaveBeenCalledWith('/shift-covers', {
      method: 'POST',
      body: { coverUserId: 'u-marcus', fromDate: today, toDate: today, note: undefined },
    });
  });
});

describe('<SupervisorDashboard> — the floor supervisor\'s floor', () => {
  it('the same floor, watch-only: no schedule, approvals, or week — their shift supervisor instead', async () => {
    vi.clearAllMocks();
    renderPage({ role: 'FLOOR_SUPERVISOR', clockedIn: true, floorTeam: floorTeam() });
    expect(await screen.findByRole('heading', { level: 1, name: /, Dana.$/ })).toBeInTheDocument();
    expect(await screen.findByText('Front Beach 218')).toBeInTheDocument();
    expect(await screen.findByText('Your shift supervisor')).toBeInTheDocument();
    expect(screen.getByText('Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('Off the clock')).toBeInTheDocument();
    expect(screen.queryByText('decision queue')).not.toBeInTheDocument();
    expect(screen.queryByText('week chart')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open schedule/ })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/approvals/count');
    expect(listShifts).not.toHaveBeenCalled();
    expect(getSchedulingKpis).not.toHaveBeenCalled();
    // The floor today: who's not in, what's unfilled.
    expect(screen.getByText('Not in yet')).toBeInTheDocument();
    expect(screen.getByText('Unfilled today')).toBeInTheDocument();
    // Dana's SOP isn't open yet — they help on it once it is.
    expect(screen.getByText(/Dana's SOP opens when Dana clocks in/)).toBeInTheDocument();
  });

  it("on the clock with Dana's SOP running: help on it", async () => {
    renderPage({
      role: 'FLOOR_SUPERVISOR',
      clockedIn: true,
      floorTeam: floorTeam(),
      helping: {
        id: 'sop1',
        windowLabel: 'Swing',
        position: 'Swing shift',
        locationName: 'Front Beach 218',
        dueAt: null,
        sopDone: 3,
        sopTotal: 12,
        runBy: { id: 'u-dana', name: 'Dana Reyes' },
      },
    });
    const banner = await screen.findByRole('link', { name: /Dana's Swing SOP/ });
    expect(banner).toHaveAttribute('href', '/ops?tab=shift&shift=sop1');
    expect(banner).toHaveTextContent('3 of 12 done');
    expect(banner).toHaveTextContent('Dana submits it');
  });

  it('on a day they were handed the shift, off the clock: the clock-in opens it for them', async () => {
    const today = new Date().toISOString().slice(0, 10);
    renderPage({
      role: 'FLOOR_SUPERVISOR',
      clockedIn: false,
      floorTeam: floorTeam([
        { id: 'cv1', fromDate: today, toDate: today, note: null, leadUserId: 'u-dana', leadName: 'Dana Reyes', today: true },
      ]),
    });
    expect(await screen.findByText("You're running Dana's shift today")).toBeInTheDocument();
    expect(
      screen.getByText(/Clock in at the store tablet with your clock-in number — the shift’s SOP opens for you, and it’s yours to submit/),
    ).toBeInTheDocument();
    // They punch at the tablet only — no clock button in the app.
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
  });

  it('off the clock on an ordinary day: where to clock in, never a clock button', async () => {
    renderPage({ role: 'FLOOR_SUPERVISOR', clockedIn: false, floorTeam: floorTeam() });
    expect(await screen.findByText(/Clock in at the store tablet with your clock-in number — you help on Dana’s SOP/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock in' })).not.toBeInTheDocument();
  });

  it("SOP submitted: clock out at the tablet — no clock-out button", async () => {
    renderPage({
      role: 'FLOOR_SUPERVISOR',
      clockedIn: true,
      floorTeam: floorTeam(),
      submitted: { id: 'sop1', windowLabel: 'Swing', position: 'Swing shift', closedAt: new Date().toISOString(), closedIncomplete: false },
    });
    expect(await screen.findByText('Clock out at the store tablet whenever you’re done.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clock out' })).not.toBeInTheDocument();
  });

  it('running it for their shift supervisor: the SOP card says for whom', async () => {
    renderPage({
      role: 'FLOOR_SUPERVISOR',
      clockedIn: true,
      floorTeam: floorTeam(),
      sop: {
        id: 'sop1',
        windowLabel: 'Swing',
        position: 'Swing shift',
        locationName: 'Front Beach 218',
        dueAt: null,
        openedAt: new Date().toISOString(),
        sopDone: 0,
        sopTotal: 12,
        requiredOpen: 12,
        handoverCount: 0,
        coveringFor: { id: 'u-dana', name: 'Dana Reyes' },
      },
    });
    expect(await screen.findByText("You're running Dana's Swing SOP")).toBeInTheDocument();
  });
});

const late = (id: string, name: string, minutesLate: number, status: string, phone: string | null) => ({
  shiftId: id,
  associateId: `a-${id}`,
  name,
  position: 'Server',
  clientId: 'c1',
  siteId: 'l1',
  siteName: 'Front Beach 218',
  startsAt: at(-minutesLate / 60),
  endsAt: at(6),
  timezone: tz,
  minutesLate,
  status,
  calledOutHow: null,
  hasPhone: phone !== null,
  textable: phone !== null,
  phone,
});

describe('<SupervisorDashboard> — who isn\u2019t in, and the fill line', () => {
  it('lists who hasn\u2019t punched in with Call and Text, texts them all at once, and sends a no-show to cover', async () => {
    vi.clearAllMocks();
    renderPage({ lateNow: [late('n1', 'Gus Hale', 42, 'no-show-risk', '+15555550111'), late('n2', 'Ivy Moss', 11, 'late', '+15555550112')] });
    const list = await screen.findByRole('list', { name: 'Not in yet' });
    expect(within(list).getByText('42 min late')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Call Gus Hale' })).toHaveAttribute('href', 'tel:+15555550111');
    expect(within(list).getByRole('link', { name: 'Text Ivy Moss' })).toHaveAttribute('href', 'sms:+15555550112');
    expect(within(list).getByRole('link', { name: /No-show → find cover/ })).toHaveAttribute('href', '/scheduling?shift=n1');
    expect(screen.getByRole('button', { name: 'Text the 2 late' })).toBeInTheDocument();
    // Eight weeks of fill against the 95% line — and never a labor budget.
    expect(await screen.findByRole('heading', { name: 'Fill rate · 8 weeks' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /met the 95% target in 2 of 3 weeks/ })).toBeInTheDocument();
    expect(screen.queryByText(/budget/i)).not.toBeInTheDocument();
  });

  it('the watch-only lead sees who is missing, without numbers, texts, cover or the fill chart', async () => {
    vi.clearAllMocks();
    renderPage({ role: 'FLOOR_SUPERVISOR', floorTeam: floorTeam(), lateNow: [late('n1', 'Gus Hale', 42, 'no-show-risk', null)] });
    const list = await screen.findByRole('list', { name: 'Not in yet' });
    expect(within(list).getByText('Gus Hale')).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: /Call|find cover/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Text the/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Fill rate · 8 weeks' })).toBeNull();
  });
});

describe('<SupervisorDashboard> — arriving by van', () => {
  it('gives a heads-up of who is coming in on the vans, flagging anyone without a shift', async () => {
    renderPage({
      arrivals: [
        {
          rideId: 'r1',
          associateId: 'a1',
          name: 'Maria Lopez',
          store: { id: 'l1', name: 'Front Beach 218' },
          arriveBy: at(2),
          etaAt: at(2.2),
          lateMinutes: 12,
          status: 'SCHEDULED',
          van: 'Van 1',
          hasShift: true,
        },
        {
          rideId: 'r2',
          associateId: 'a2',
          name: 'Kim Nguyen',
          store: { id: 'l1', name: 'Front Beach 218' },
          arriveBy: at(3),
          status: 'REQUESTED',
          van: null,
          hasShift: false,
        },
      ],
    });
    expect(await screen.findByText('Arriving by van')).toBeInTheDocument();
    expect(screen.getByText('Maria Lopez')).toBeInTheDocument();
    expect(screen.getByText('Kim Nguyen')).toBeInTheDocument();
    expect(screen.getByText('1 without a shift here')).toBeInTheDocument();
    expect(screen.getByText('No shift')).toBeInTheDocument();
    expect(screen.getByText('Waiting on a van')).toBeInTheDocument();
    // A van on the road that's running late says so.
    expect(screen.getByText('~12 min late')).toBeInTheDocument();
    expect(screen.getByText(/Van 1 · here about/)).toBeInTheDocument();
  });

  it('stays out of the way when nobody is coming by van', async () => {
    renderPage();
    await screen.findByText('Front Beach 218');
    expect(screen.queryByText('Arriving by van')).not.toBeInTheDocument();
  });
});

describe('<SupervisorDashboard> — the floor from a phone', () => {
  it('the last shift\u2019s handover is the first thing the lead sees, and a floor flag waits for their "Got it"', async () => {
    renderPage({
      handover: [{ id: 'h1', kind: 'EQUIPMENT', body: 'Pallet jack 3 is down.', priority: 'HIGH', createdAt: new Date().toISOString(), from: { shiftId: 'o1', position: 'Evening lead', period: 'EVENING', dateKey: '2026-10-16', department: 'Grocery', by: 'Marcus Hill' } }],
      flags: [{ id: 'f1', kind: 'NO_SHOW', note: 'Not here 20 minutes in.', status: 'OPEN', createdAt: new Date().toISOString(), acknowledgedAt: null, associate: { id: 'a1', name: 'Ann Lee' }, shiftId: null, raisedBy: 'Marcus Hill' }],
    });
    const banner = await screen.findByTestId('handover-banner');
    expect(banner).toHaveTextContent('Marcus’s Evening lead shift handed over 1 note');
    expect(banner).toHaveTextContent('Pallet jack 3 is down.');
    const flags = await screen.findByTestId('floor-flags');
    expect(flags).toHaveTextContent('Ann Lee · Not here 20 minutes in.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Got it' }));
    expect(apiFetch).toHaveBeenCalledWith('/floor/flags/f1/ack', { method: 'POST' });
  });

  it('files an incident from the home, and never shows money', async () => {
    renderPage();
    await screen.findByText('Front Beach 218');
    // One tap from anywhere: the sticky floor-actions row.
    await userEvent.setup().click(screen.getByRole('button', { name: /report incident/i }));
    expect(await screen.findByRole('dialog', { name: /report an incident/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a photo/i })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it('a watch-only floor lead flags a no-show in two taps and sees the week beyond tomorrow', async () => {
    vi.clearAllMocks();
    renderPage({
      role: 'FLOOR_SUPERVISOR',
      clockedIn: true,
      floorTeam: floorTeam(),
      week: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(17 + i).padStart(2, '0')}`, scheduled: i === 2 ? 5 : 0, open: i === 2 ? 1 : 0, confirmed: 0 })),
    });
    expect(await screen.findByTestId('floor-week')).toHaveTextContent('This week at the store');
    expect(screen.queryByTestId('floor-flags')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /raise a flag/i }));
    expect(await screen.findByRole('dialog', { name: /flag it/i })).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalledWith('/floor/flags');
  });
});
