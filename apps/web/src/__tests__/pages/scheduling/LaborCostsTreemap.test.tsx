import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LaborCostPosition, LaborCostRow } from '@alto-people/shared';

vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  laborCostPeriods: vi.fn(),
  laborCosts: vi.fn(),
  floorNow: vi.fn(),
  otOutlook: vi.fn(),
  storeTrends: vi.fn(),
  listStaffingTargets: vi.fn(),
}));
// jsdom never loads the real engine: the plot stays a skeleton, the frame's
// summary and table carry the figure.
vi.mock('@/components/ui/charts/echarts/engine', () => ({ loadEcharts: () => new Promise(() => {}) }));

import { floorNow, laborCostPeriods, laborCosts, otOutlook, storeTrends } from '@/lib/schedulingApi';
import { LaborCostsHome } from '@/pages/scheduling/LaborCostsHome';
import { addDaysYmd, localYmd } from '@/pages/scheduling/laborCostRange';
import { AuthContext } from '@/lib/auth';

/**
 * Labor costs › "Where the money goes": the range's cost as client → store →
 * position blocks from the server's per-position split, sized by scheduled
 * cost first (the page's primary measure) or worked cost, one sentence for a
 * screen reader and a Client / Store / Position / Cost / Share table.
 */

const TODAY = localYmd();
const CURRENT = { start: addDaysYmd(TODAY, -5), end: addDaysYmd(TODAY, 8), current: true, hasRun: false };
const LAST = { start: addDaysYmd(TODAY, -19), end: addDaysYmd(TODAY, -6), current: false, hasRun: true };

const COASTAL = '11111111-1111-4111-8111-111111111111';
const GULF = '33333333-3333-4333-8333-333333333333';
const FRONT_BEACH = '22222222-2222-4222-8222-222222222222';
const PIER_PARK = '44444444-4444-4444-8444-444444444444';
const BAYSIDE = '55555555-5555-4555-8555-555555555555';

const pos = (position: string | null, scheduledCost: number, workedCost = 0): LaborCostPosition => ({
  position,
  scheduledMinutes: Math.round(scheduledCost * 4),
  scheduledCost,
  workedMinutes: Math.round(workedCost * 4),
  workedCost,
});

/** A row whose totals are its positions' sums, as the server sends it. */
function row(date: string, clientId: string, clientName: string, locationId: string, locationName: string, positions: LaborCostPosition[]): LaborCostRow {
  const sum = (k: keyof Omit<LaborCostPosition, 'position'>) => positions.reduce((s, p) => s + p[k], 0);
  return {
    date,
    clientId,
    clientName,
    locationId,
    locationName,
    scheduledShifts: positions.filter((p) => p.scheduledMinutes > 0).length,
    scheduledMinutes: sum('scheduledMinutes'),
    scheduledCost: sum('scheduledCost'),
    scheduledNoRate: 0,
    workedPunches: positions.filter((p) => p.workedMinutes > 0).length,
    workedMinutes: sum('workedMinutes'),
    workedCost: sum('workedCost'),
    workedNoRate: 0,
    approvedMinutes: 0,
    approvedCost: 0,
    scheduledHeads: 1,
    targetHeads: null,
    leadHeads: 0,
    leadMinutes: 0,
    leadCost: 0,
    associateHeads: 1,
    associateMinutes: sum('scheduledMinutes'),
    associateCost: sum('scheduledCost'),
    scheduledRevenue: 0,
    revenueNoRate: 0,
    positions,
  };
}

const D1 = addDaysYmd(TODAY, -2);
const D2 = addDaysYmd(TODAY, -1);
// Scheduled: Front Beach Housekeeper $1,000 (two days), Front Desk $200,
// Pier Park Housekeeper $300, Bayside Cook $500 — $2,000 in all.
// Worked: Front Beach Housekeeper $300, Front Desk $250, Unscheduled $50,
// Bayside Cook $700 — $1,300.
const ROWS: LaborCostRow[] = [
  row(D1, COASTAL, 'Coastal Resort Holdings', FRONT_BEACH, 'Front Beach 218', [pos('Housekeeper', 600, 300), pos('Front Desk', 200, 250), pos(null, 0, 50)]),
  row(D1, COASTAL, 'Coastal Resort Holdings', PIER_PARK, 'Pier Park 12', [pos('Housekeeper', 300)]),
  row(D2, COASTAL, 'Coastal Resort Holdings', FRONT_BEACH, 'Front Beach 218', [pos('Housekeeper', 400)]),
  row(D2, GULF, 'Gulf Inns', BAYSIDE, 'Bayside 7', [pos('Cook', 500, 700)]),
];

function renderPage(initial = '/labor-costs') {
  const router = createMemoryRouter([{ path: '/labor-costs', element: <LaborCostsHome /> }], { initialEntries: [initial] });
  render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'ops@example.com', role: 'OPERATIONS_MANAGER', status: 'ACTIVE' },
          loading: false,
          can: (c: string) => ['manage:scheduling', 'manage:time'].includes(c),
          // The tenant's word for a store (a tenant with none set reads the bare key).
          tenant: { id: 'tenant-1', businessModel: 'WORKFORCE_PROVIDER', modules: { clientPortal: true }, terminology: { site: { en: 'Store' }, sites: { en: 'Stores' } } },
          signIn: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
        } as never
      }
    >
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
  return router;
}

const moneyTable = () => screen.findByRole('table', { name: 'Where the money goes' });
const cells = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((tr) => within(tr).getAllByRole('cell').map((td) => td.textContent));

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.mocked(laborCostPeriods).mockReset().mockResolvedValue({ periods: [CURRENT, LAST] });
  vi.mocked(laborCosts).mockReset().mockResolvedValue({ rows: ROWS, truncated: false } as never);
  vi.mocked(floorNow).mockReset().mockResolvedValue({ generatedAt: new Date().toISOString(), rows: [] } as never);
  vi.mocked(otOutlook).mockReset().mockResolvedValue({ rows: [], generatedAt: new Date().toISOString() } as never);
  vi.mocked(storeTrends).mockReset().mockResolvedValue({ stores: [], bestMarginPerHour: 0 } as never);
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('LaborCostsHome › Where the money goes', () => {
  it('opens on scheduled cost, client first: one sentence and a client → store → position table', async () => {
    renderPage();
    const table = await moneyTable();
    expect(screen.getByRole('radio', { name: 'Scheduled' })).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('img', {
        name: '$2,000.00 scheduled this pay period; Coastal Resort Holdings is 75%, led by Housekeeper at Front Beach 218 ($1,000.00).',
      }),
    ).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Client', 'Store', 'Position', 'Scheduled cost', 'Share']);
    // The two days fold into one Housekeeper cell; costliest first; no worked-only bucket.
    expect(cells(table)).toEqual([
      ['Coastal Resort Holdings', 'Front Beach 218', 'Housekeeper', '$1,000.00', '50%'],
      ['Gulf Inns', 'Bayside 7', 'Cook', '$500.00', '25%'],
      ['Coastal Resort Holdings', 'Pier Park 12', 'Housekeeper', '$300.00', '15%'],
      ['Coastal Resort Holdings', 'Front Beach 218', 'Front Desk', '$200.00', '10%'],
    ]);
  });

  it('switches to worked cost — punches on no shift as Unscheduled — and keeps the choice in the URL', async () => {
    const router = renderPage();
    await moneyTable();
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Worked' }));
    });
    expect(router.state.location.search).toContain('money=worked');
    expect(screen.getByRole('radio', { name: 'Worked' })).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('img', { name: '$1,300.00 worked this pay period; Gulf Inns is 54%, led by Cook at Bayside 7 ($700.00).' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Time worked on no shift shows as Unscheduled/)).toBeInTheDocument();
    const table = await moneyTable();
    expect(within(table).getByRole('columnheader', { name: 'Worked cost' })).toBeInTheDocument();
    expect(cells(table)).toEqual([
      ['Gulf Inns', 'Bayside 7', 'Cook', '$700.00', '54%'],
      ['Coastal Resort Holdings', 'Front Beach 218', 'Housekeeper', '$300.00', '23%'],
      ['Coastal Resort Holdings', 'Front Beach 218', 'Front Desk', '$250.00', '19%'],
      ['Coastal Resort Holdings', 'Front Beach 218', 'Unscheduled', '$50.00', '4%'],
    ]);
  });

  it('starts at the stores with one client picked, and at the positions with one store', async () => {
    renderPage(`/labor-costs?client=${COASTAL}`);
    expect(
      await screen.findByRole('img', { name: '$1,500.00 scheduled this pay period; Front Beach 218 is 80%, led by Housekeeper ($1,000.00).' }),
    ).toBeInTheDocument();
    expect(cells(await moneyTable()).map((r) => r[1])).toEqual(['Front Beach 218', 'Pier Park 12', 'Front Beach 218']);
  });

  it('with one store picked, the blocks are its positions', async () => {
    renderPage(`/labor-costs?client=${COASTAL}&store=${FRONT_BEACH}`);
    expect(await screen.findByRole('img', { name: '$1,200.00 scheduled this pay period; Housekeeper is 83% ($1,000.00).' })).toBeInTheDocument();
    expect(cells(await moneyTable()).map((r) => r[2])).toEqual(['Housekeeper', 'Front Desk']);
  });

  it('says so when the chosen side has nothing in it, and names a past range by its dates', async () => {
    vi.mocked(laborCosts).mockResolvedValue({
      rows: [row(D1, COASTAL, 'Coastal Resort Holdings', FRONT_BEACH, 'Front Beach 218', [pos('Housekeeper', 600)])],
      truncated: false,
    } as never);
    renderPage(`/labor-costs?from=${addDaysYmd(TODAY, -3)}&to=${TODAY}&money=worked`);
    expect(await screen.findByText('No worked cost in this range')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Where the money goes' })).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Scheduled' }));
    });
    expect(await screen.findByRole('img', { name: /^\$600\.00 scheduled in .+; all of it at Coastal Resort Holdings, led by Housekeeper at Front Beach 218 \(\$600\.00\)\.$/ })).toBeInTheDocument();
  });

  it('gives the figure a squarer box on a phone', async () => {
    window.matchMedia = ((query: string) => ({ ...realMatchMedia(query), matches: /prefers-reduced-motion/.test(query) })) as typeof window.matchMedia;
    renderPage();
    const figure = await screen.findByRole('img', { name: /scheduled this pay period; Coastal/ });
    expect(figure).toHaveStyle({ height: '360px' });
  });
});
