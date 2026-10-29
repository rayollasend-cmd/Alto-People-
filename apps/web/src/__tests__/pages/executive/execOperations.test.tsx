import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { ApiError, apiFetch } from '@/lib/api';
import { ExecOperationsPage } from '@/pages/executive/OperationsPage';
import type { LegacyBatons, LegacyBriefing, LegacyPortalEngagement, LegacySummary } from '@/pages/executive/ops/execLegacyApi';
import { renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Operations pulse: today's coverage and the six days
 * ahead, the live floor, the work moving between teams (a zero is never
 * coloured), store operations, thirty days of attendance, placements and
 * the clients' portal — each card on its own request, so one failure
 * leaves the rest standing.
 */

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const BRIEFING: LegacyBriefing = {
  generatedAt: '2026-10-27T15:32:00.000Z',
  today: {
    dateKey: '2026-10-27',
    shiftsTotal: 21,
    shiftsAssigned: 20,
    shiftsOpen: 1,
    openShifts: [{ clientName: 'Coastal Resort Holdings', locationName: 'Front Beach 218', position: 'Deli clerk', startsAt: inHours(1.5), count: 1 }],
    estBilledToday: 3117.87,
    incidents: [
      { kind: 'NO_CALL_NO_SHOW', associateName: 'Tyler Alvarez', clientName: 'Coastal Resort Holdings' },
      { kind: 'LATE', associateName: 'Andre Baptiste', clientName: null },
    ],
  },
  outlook: [
    { dateKey: '2026-10-28', published: 22, assigned: 21, open: 1 },
    { dateKey: '2026-10-29', published: 21, assigned: 21, open: 0 },
  ],
  capacity: { bench: 0, funnel: { inFlight: 3, approved30d: 4 }, j1Active: 0, j1Cliff: [] },
};

const BATONS: LegacyBatons = {
  generatedAt: '2026-10-27T15:32:00.000Z',
  batons: { fieldglass: { closeOuts: 0, transfers: 0, adds: 0 }, readyToSchedule: 1, unapprovedTimesheets: 21, payrollCasesOpen: 0, incidentsOpen: 1 },
};

const SUMMARY: Partial<LegacySummary> = {
  attendance30d: [
    { kind: 'LATE', count: 26 },
    { kind: 'NO_CALL_NO_SHOW', count: 10 },
  ],
  clients: [
    { clientId: 'c2', clientName: 'Seaside Hospitality Group', activeAssociates: 10 },
    { clientId: 'c1', clientName: 'Coastal Resort Holdings', activeAssociates: 26 },
  ],
};

const ENGAGEMENT: LegacyPortalEngagement = {
  accounts: [
    { id: 'p1', email: 'portal@coastalresort.example', status: 'ACTIVE', scope: 'Front Beach 218 (Coastal Resort Holdings)', clientId: 'c1', lastSeenAt: inHours(-22), signIns7d: 23, downloads: [] },
    { id: 'p2', email: 'new@seaside.example', status: 'INVITED', scope: 'Seaside Grand', clientId: 'c2', lastSeenAt: null, signIns7d: 0, downloads: [] },
  ],
  totals: { accounts: 2, active7d: 1, neverSignedIn: 1, downloads7d: 0 },
};

const FLOOR = {
  generatedAt: '2026-10-27T15:32:00.000Z',
  rows: [
    { locationId: 'l1', locationName: 'Front Beach 218', clientId: 'c1', clientName: 'Coastal Resort Holdings', clockedIn: 5, expected: 5, windowLabel: 'Morning', totalTarget: null },
    { locationId: 'l2', locationName: 'Destin Harbor 507', clientId: 'c1', clientName: 'Coastal Resort Holdings', clockedIn: 1, expected: 3, windowLabel: 'Morning', totalTarget: null },
  ],
};

const SCORECARD = {
  weeks: 4,
  rows: [{ clientName: 'Coastal Resort Holdings', storeName: 'Front Beach 218', locationId: 'l1', period: 'MORNING', department: 'Deli & Bakery', shifts: 8, sopPct: 82, incomplete: 1, tempAlerts: 0 }],
  totals: { shifts: 8, tempChecks: 31, tempInRange: 31, tempOutOfRange: 0, handoverCreated: 0, handoverCarried: 0, handoverReviewed: 0, handoverDismissed: 0, handoverPending: 0, onTime: 7, onTimeOf: 8 },
  weekly: [],
};

const ROUTES = {
  '/executive/briefing': BRIEFING,
  '/executive/batons': BATONS,
  '/executive/summary': SUMMARY,
  '/executive/portal-engagement': ENGAGEMENT,
  '/scheduling/floor-now': FLOOR,
  '/ops/scorecard': SCORECARD,
  '/ops/board': { dateKey: '2026-10-27', generatedAt: '2026-10-27T15:32:00.000Z', active: [{}, {}], closedToday: [] },
};

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Operations pulse', () => {
  it('reads today: coverage, the open shift and how soon it starts, the days ahead, the last 24 hours', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi(ROUTES) as never);
    renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations' });
    const today = await screen.findByTestId('exec-ops-today');
    expect(await within(today).findByTestId('exec-ops-coverage')).toHaveTextContent('95%');
    expect(today).toHaveTextContent('20 of 21 shifts covered · 1 open');
    expect(today).toHaveTextContent('$3.12k');
    expect(today).not.toHaveTextContent('$3,117.87');
    expect(today).toHaveTextContent(/In (1 hour|2 hours)/);
    expect(within(today).getByRole('link', { name: /Wed, Oct 28: 21 of 22 covered, 1 open/ })).toBeInTheDocument();
    expect(within(today).getByText('Filled')).toBeInTheDocument();
    expect(today).toHaveTextContent('2 unexcused attendance events.');
    expect(within(today).getByText('No-call no-show · Coastal Resort Holdings')).toBeInTheDocument();
    expect(today).not.toHaveTextContent('NO_CALL_NO_SHOW');
  });

  it('colours a waiting count, never a zero', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi(ROUTES) as never);
    renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations' });
    const batons = await screen.findByTestId('exec-ops-batons');
    await within(batons).findByText('Timesheets to approve');
    const tone = (key: string) => within(screen.getByTestId(`exec-baton-${key}`)).getByText(/^\d/).getAttribute('data-tone');
    expect(tone('unapprovedTimesheets')).toBe('caution');
    expect(tone('incidentsOpen')).toBe('negative');
    expect(tone('payrollCasesOpen')).toBe('none');
    expect(tone('closeOuts')).toBe('none');
    expect(batons).toHaveTextContent('23 items are waiting on the next team.');
    expect(screen.getByTestId('exec-baton-unapprovedTimesheets')).toHaveAttribute('href', '/time-attendance');
  });

  it('shows the floor, store standards, attendance, placements and the portal', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi(ROUTES) as never);
    renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations' });
    const floor = await screen.findByTestId('exec-ops-floor');
    expect(await within(floor).findByText('6')).toBeInTheDocument();
    expect(floor).toHaveTextContent('on the floor, of 8 expected across 2 stores');
    expect(floor).toHaveTextContent('1 of 3 · Morning');

    const store = screen.getByTestId('exec-ops-store');
    expect(await within(store).findByText('Shifts run')).toBeInTheDocument();
    expect(store).toHaveTextContent('of 31 checks');
    expect(store).toHaveTextContent('Weakest standard: Coastal Resort Holdings · Deli & Bakery, 82% of the checklist done.');
    expect(within(store).getByText('0')).toHaveAttribute('data-tone', 'none');

    const att = screen.getByTestId('exec-ops-attendance');
    expect(att).toHaveTextContent('36 unexcused events, by kind.');
    expect(within(att).getAllByRole('listitem')[0]).toHaveTextContent('Late arrivals26');

    const placements = screen.getByTestId('exec-ops-placements');
    expect(within(placements).getAllByRole('listitem')[0]).toHaveTextContent('Coastal Resort Holdings26 working');

    const portal = screen.getByTestId('exec-ops-portal');
    expect(portal).toHaveTextContent('1 of 2 accounts in this week · 0 reports pulled · 1 never signed in');
    expect(portal).toHaveTextContent('Invited, not in yet');
  });

  it('one failed card says so and the rest still stand', async () => {
    vi.mocked(apiFetch).mockImplementation(
      routeApi({
        ...ROUTES,
        '/executive/batons': () => {
          throw new ApiError(500, 'boom', 'Request failed (500)');
        },
      }) as never,
    );
    renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations' });
    expect(await screen.findByText(/Couldn.t load the work between teams/)).toBeInTheDocument();
    expect(await within(screen.getByTestId('exec-ops-today')).findByTestId('exec-ops-coverage')).toHaveTextContent('95%');
  });

  it('a company without the client portal sees no client cards', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi(ROUTES) as never);
    renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations', off: ['clientPortal'] });
    await screen.findByTestId('exec-ops-today');
    expect(screen.queryByTestId('exec-ops-placements')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exec-ops-portal')).not.toBeInTheDocument();
  });

  it('a hotel keeps today, the floor, the work between teams and attendance — without Fieldglass or client words', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi(ROUTES) as never);
    const { container } = renderAsChairman(<ExecOperationsPage />, { route: '/executive/operations', off: ['clientPortal', 'billRates'] });
    const batons = await screen.findByTestId('exec-ops-batons');
    await within(batons).findByText('Timesheets to approve');
    expect(batons).not.toHaveTextContent('Fieldglass');
    expect(within(screen.getByTestId('exec-ops-today')).queryByText('est. billed today')).not.toBeInTheDocument();
    expect(await screen.findByTestId('exec-ops-floor')).toBeInTheDocument();
    expect(screen.getByTestId('exec-ops-attendance')).toBeInTheDocument();
    expect(container.querySelector('h1')!.parentElement!.parentElement!.textContent).not.toMatch(/\bclients?\b/i);
    expect(screen.queryByTestId('exec-ops-placements')).not.toBeInTheDocument();
  });
});
