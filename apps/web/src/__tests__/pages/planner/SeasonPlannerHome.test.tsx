import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import type { SeasonPlanComputed, SeasonPlanSummary } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

vi.mock('@/lib/seasonPlansApi', () => ({
  listSeasonPlans: vi.fn(),
  getSeasonPlan: vi.fn(),
  getSeasonPlanDefaults: vi.fn(),
  createSeasonPlan: vi.fn(),
  updateSeasonPlan: vi.fn(),
  duplicateSeasonPlan: vi.fn(),
  compareSeasonPlans: vi.fn(),
  seasonPlanCsvUrl: vi.fn(() => '/api/season-plans/p1/csv'),
  seasonPlanSitePdfUrl: vi.fn(() => '/api/season-plans/p1/sites/l1/pdf'),
  getSeasonPlanLive: vi.fn().mockResolvedValue({ planId: 'p1', week: '2027-05-01', shiftHours: 8, rows: [], totals: { planned: 0, scheduled: 0, gap: 0, over: 0, drafted: 0, gapHours: 0, gapCost: null, unpriced: 0 } }),
  applySeasonPlanLive: vi.fn(),
  discardSeasonPlanLive: vi.fn(),
}));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn().mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' }], nextCursor: null }),
}));
vi.mock('@/lib/confirm', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true), usePrompt: () => vi.fn() }));
// recharts measures a container; jsdom has no layout. The chart is not
// what these tests judge — the numbers and the editor are.
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

import { getSeasonPlan, listSeasonPlans, updateSeasonPlan } from '@/lib/seasonPlansApi';
import { SeasonPlannerHome } from '@/pages/planner/SeasonPlannerHome';

const summary: SeasonPlanSummary = {
  id: 'p1',
  name: 'Summer 2027 — original',
  clientId: null,
  clientName: null,
  seasonStart: '2027-05-01',
  seasonEnd: '2027-05-14',
  targetHoursPerWeek: 40,
  shiftHours: 8,
  reservePct: 10,
  channelMix: { LOCAL: 25, J1_NORTH: 35, J1_SOUTH: 15, H2B: 25 },
  arrivalLeadWeeks: { LOCAL: 3, J1_NORTH: 10, J1_SOUTH: 12, H2B: 20 },
  housingShare: { LOCAL: 0, J1_NORTH: 100, J1_SOUTH: 100, H2B: 100 },
  rideShare: { LOCAL: 10, J1_NORTH: 100, J1_SOUTH: 100, H2B: 100 },
  notes: null,
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  siteCount: 1,
  weeks: ['2027-05-01', '2027-05-08'],
};

const week = (w: string, day: number) => ({
  week: w,
  day,
  evening: 0,
  overnight: 0,
  daily: day,
  shiftSlots: day * 7,
  associatesNeeded: Math.ceil((day * 7) / 5 * 1.1),
  bedsNeeded: 100,
  bedsAvailable: 40,
  bedsGap: 60,
  vanSeatsNeeded: 70,
  vanSeatsAvailable: 14,
  vanSeatsGap: 56,
  scheduledHours: null,
  activeHeadcount: null,
});

const plan: SeasonPlanComputed = {
  ...summary,
  sites: [
    {
      locationId: 'l1',
      siteName: 'Front Beach',
      clientId: 'c1',
      clientName: 'Walmart',
      bedsAvailable: 40,
      vanSeatsPerRun: 14,
      runsPerShift: 1,
      routeMinutes: 45,
      weeks: [week('2027-05-01', 95), week('2027-05-08', 95)],
      peak: { week: '2027-05-01', daily: 95, associatesNeeded: 147, bedsNeeded: 100, vanSeatsNeeded: 70 },
    },
  ],
  totals: [
    { week: '2027-05-01', daily: 95, associatesNeeded: 147, bedsNeeded: 100, bedsAvailable: 40, vanSeatsNeeded: 70, vanSeatsAvailable: 14, scheduledHours: null, activeHeadcount: null },
    { week: '2027-05-08', daily: 95, associatesNeeded: 147, bedsNeeded: 100, bedsAvailable: 40, vanSeatsNeeded: 70, vanSeatsAvailable: 14, scheduledHours: null, activeHeadcount: null },
  ],
  peak: { week: '2027-05-01', daily: 95, associatesNeeded: 147, bedsNeeded: 100, bedsAvailable: 40, bedsGap: 60 },
  recruiting: [
    { channel: 'LOCAL', label: 'Local hires', sharePct: 25, target: 37, recruitBy: '2027-04-10', pipeline: 12, gap: 25 },
    { channel: 'J1_NORTH', label: 'J-1 northern hemisphere', sharePct: 35, target: 51, recruitBy: '2027-02-20', pipeline: 0, gap: 51 },
    { channel: 'J1_SOUTH', label: 'J-1 southern hemisphere', sharePct: 15, target: 22, recruitBy: '2027-02-06', pipeline: 0, gap: 22 },
    { channel: 'H2B', label: 'H-2B', sharePct: 25, target: 37, recruitBy: '2026-12-12', pipeline: 0, gap: 37 },
  ],
  gaps: [
    { kind: 'BEDS', siteName: 'Front Beach', week: '2027-05-01', needed: 100, available: 40, shortfall: 60, text: 'Front Beach needs 100 beds at peak and has 40 — 60 short.' },
  ],
};

function renderPage(path = '/season-planner', role: 'HR_ADMINISTRATOR' | 'EXECUTIVE_CHAIRMAN' = 'HR_ADMINISTRATOR') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'x@example.com', role, status: 'ACTIVE' },
          loading: false,
          can: (c: Capability) => caps.has(c),
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <SeasonPlannerHome />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(listSeasonPlans).mockResolvedValue({ plans: [summary] });
  vi.mocked(getSeasonPlan).mockResolvedValue(plan);
  vi.mocked(updateSeasonPlan).mockReset();
  vi.mocked(updateSeasonPlan).mockResolvedValue(plan);
});

describe('SeasonPlannerHome', () => {
  it('lists the scenarios', async () => {
    renderPage();
    expect(await screen.findByText('Summer 2027 — original')).toBeInTheDocument();
    expect(screen.getByText('All clients')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new plan/i })).toBeInTheDocument();
  });

  it('shows the peak, every named gap, and the recruiting targets for one plan', async () => {
    renderPage('/season-planner?plan=p1');
    expect(await screen.findByText('Associates needed at peak')).toBeInTheDocument();
    // The hero figure; the same number also sits in the week table and the store summary.
    expect(screen.getAllByText('147').length).toBeGreaterThan(0);
    expect(screen.getByText('Front Beach needs 100 beds at peak and has 40 — 60 short.')).toBeInTheDocument();
    expect(screen.getByText('J-1 northern hemisphere')).toBeInTheDocument();
    expect(screen.getByText('60 short')).toBeInTheDocument();
    // Still to recruit sums the channel gaps: 25 + 51 + 22 + 37.
    // MetricCard counts up to its figure; wait for it to land.
    expect(await screen.findByText('135', {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('saves edited demand with the whole site list', async () => {
    renderPage('/season-planner?plan=p1');
    await screen.findByText('Associates needed at peak');
    const dayInput = screen.getByLabelText('Front Beach May 1 day');
    await userEvent.clear(dayInput);
    await userEvent.type(dayInput, '120');
    await userEvent.click(screen.getByRole('button', { name: /save demand/i }));
    await waitFor(() => expect(updateSeasonPlan).toHaveBeenCalled());
    const body = vi.mocked(updateSeasonPlan).mock.calls[0]![1];
    expect(body.sites).toHaveLength(1);
    expect(body.sites![0]).toMatchObject({ locationId: 'l1', bedsAvailable: 40, vanSeatsPerRun: 14, runsPerShift: 1, routeMinutes: 45 });
    expect(body.sites![0]!.demand).toEqual([
      { week: '2027-05-01', day: 120, evening: 0, overnight: 0 },
      { week: '2027-05-08', day: 95, evening: 0, overnight: 0 },
    ]);
  });

  it('is read-only without manage:org', async () => {
    renderPage('/season-planner?plan=p1', 'EXECUTIVE_CHAIRMAN');
    await screen.findByText('Associates needed at peak');
    expect(screen.queryByRole('button', { name: /save demand/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Front Beach May 1 day')).toBeDisabled();
  });
});
