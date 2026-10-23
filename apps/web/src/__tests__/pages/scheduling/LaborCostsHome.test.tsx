import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FloorNowResponse, LaborCostRow } from '@alto-people/shared';

vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  laborCostPeriods: vi.fn(),
  laborCosts: vi.fn(),
  floorNow: vi.fn(),
  otOutlook: vi.fn(),
  storeTrends: vi.fn(),
  listStaffingTargets: vi.fn(),
}));

import { floorNow, laborCostPeriods, laborCosts, otOutlook, storeTrends } from '@/lib/schedulingApi';
import { LaborCostsHome } from '@/pages/scheduling/LaborCostsHome';
import { addDaysYmd, localYmd } from '@/pages/scheduling/laborCostRange';
import { AuthContext } from '@/lib/auth';

/**
 * Labor costs (F500 G2): opens on the pay period to date, never dresses a
 * zero as good news, draws every day of the range, shows one daily grid,
 * names the shifts it can't place, and keeps its range in the URL.
 */

const TODAY = localYmd();
const CURRENT = { start: addDaysYmd(TODAY, -5), end: addDaysYmd(TODAY, 8), current: true, hasRun: false };
const LAST = { start: addDaysYmd(TODAY, -19), end: addDaysYmd(TODAY, -6), current: false, hasRun: true };
const localMidnightIso = (ymd: string) => new Date(`${ymd}T00:00:00`).toISOString();

const CLIENT = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';

function row(over: Partial<LaborCostRow> = {}): LaborCostRow {
  return {
    date: addDaysYmd(TODAY, -1),
    clientId: CLIENT,
    clientName: 'Coastal Resort Holdings',
    locationId: STORE,
    locationName: 'Front Beach 218',
    scheduledShifts: 3,
    scheduledMinutes: 1260,
    scheduledCost: 297.5,
    scheduledNoRate: 0,
    workedPunches: 0,
    workedMinutes: 0,
    workedCost: 0,
    workedNoRate: 0,
    approvedMinutes: 0,
    approvedCost: 0,
    scheduledHeads: 2,
    targetHeads: 8,
    leadHeads: 0,
    leadMinutes: 0,
    leadCost: 0,
    associateHeads: 2,
    associateMinutes: 1260,
    associateCost: 297.5,
    scheduledRevenue: 435.47,
    revenueNoRate: 0,
    windows: [],
    ...over,
  } as LaborCostRow;
}

function floor(clockedIn: number): FloorNowResponse {
  return {
    generatedAt: new Date().toISOString(),
    rows: [
      {
        locationId: STORE,
        locationName: 'Front Beach 218',
        clientId: CLIENT,
        clientName: 'Coastal Resort Holdings',
        clockedIn,
        expected: 6,
        windowLabel: null,
        totalTarget: 6,
        loadedPerHour: clockedIn * 20,
        billedPerHour: clockedIn * 30,
        loadedSoFar: 0,
        billedSoFar: 0,
        otHeads: 0,
        projectedOtHeads: 0,
      },
    ],
  } as FloorNowResponse;
}

const CAPS = ['manage:scheduling', 'manage:time', 'view:time-live'];

function renderPage(initial = '/labor-costs') {
  const router = createMemoryRouter([{ path: '/labor-costs', element: <LaborCostsHome /> }], { initialEntries: [initial] });
  render(
    <AuthContext.Provider
      value={
        {
          user: { id: 'u1', email: 'ops@example.com', role: 'OPERATIONS_MANAGER', status: 'ACTIVE' },
          loading: false,
          can: (c: string) => CAPS.includes(c),
          tenant: { id: 'tenant-1', businessModel: 'WORKFORCE_PROVIDER', modules: { clientPortal: true }, terminology: {} },
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

beforeEach(() => {
  vi.mocked(laborCostPeriods).mockReset().mockResolvedValue({ periods: [CURRENT, LAST] });
  vi.mocked(laborCosts).mockReset().mockResolvedValue({ rows: [row()], truncated: false } as never);
  vi.mocked(floorNow).mockReset().mockResolvedValue(floor(0));
  vi.mocked(otOutlook).mockReset().mockResolvedValue({ rows: [], generatedAt: new Date().toISOString() } as never);
  vi.mocked(storeTrends).mockReset().mockResolvedValue({ stores: [], bestMarginPerHour: 0 } as never);
});

describe('LaborCostsHome', () => {
  it('opens on the current pay period to date, not on today', async () => {
    renderPage();
    await waitFor(() => expect(laborCosts).toHaveBeenCalled());
    expect(laborCosts).toHaveBeenCalledWith({
      from: localMidnightIso(CURRENT.start),
      to: localMidnightIso(addDaysYmd(TODAY, 1)),
    });
    expect(await screen.findByText('pay period to date', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'This period' })).toHaveAttribute('aria-checked', 'true');
  });

  it('with no punches, says so instead of a green variance or a green $0 awaiting approval', async () => {
    renderPage();
    const tiles = await screen.findByRole('group', { name: 'Labor cost in this range' });
    expect(within(tiles).getByText('$297.50')).toBeInTheDocument();
    // Margin over a real billable value: 435.47 − 297.50.
    expect(within(tiles).getByText('+$137.97')).toBeInTheDocument();
    expect(within(tiles).getAllByText('No punches in range')).toHaveLength(2);
    expect(screen.queryByText(/vs scheduled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/every worked hour is approved/i)).not.toBeInTheDocument();
  });

  it('prices the variance and the unapproved hours when there are punches', async () => {
    vi.mocked(laborCosts).mockResolvedValue({
      rows: [row({ workedPunches: 2, workedMinutes: 960, workedCost: 320, approvedMinutes: 840, approvedCost: 280 })],
      truncated: false,
      fallbacks: { associateBillRate: 21.21 },
    } as never);
    renderPage();
    // 320 − 297.50 over plan, 320 / 297.50 = 108%.
    expect(await screen.findByText('+$22.50 vs scheduled (108%)')).toBeInTheDocument();
    // 120 unapproved minutes × $21.21/h.
    expect(screen.getByText('$42.42')).toBeInTheDocument();
    expect(screen.getByText(/2\.0h worked but not approved/)).toBeInTheDocument();
  });

  it('says "No one on the floor" rather than "+$0.00/hr", and gives the rates when people are on', async () => {
    renderPage();
    const line = await screen.findByTestId('live-floor');
    expect(within(line).getByText(/No one on the floor/)).toBeInTheDocument();
    expect(within(line).getByText(/6 expected/)).toBeInTheDocument();
    expect(line.textContent).not.toMatch(/\/hr/);
    expect(within(line).getByRole('link', { name: /Control room/ })).toHaveAttribute('href', '/control-room');
  });

  it('gives the live rates when people are on the floor', async () => {
    vi.mocked(floorNow).mockResolvedValue(floor(3));
    renderPage();
    const line = await screen.findByTestId('live-floor');
    await waitFor(() => expect(line.textContent).toMatch(/3 of 6 on the floor/));
    expect(line.textContent).toMatch(/burn \$60\.00\/hr/);
    expect(line.textContent).toMatch(/margin \+\$30\.00\/hr/);
  });

  it('draws every day of the range, gaps included', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: 'Daily labor cost vs billable value' });
    // Six days, CURRENT.start … today, plus the header row — not just the one day with shifts.
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 6);
  });

  it('shows the daily detail as one grid grouped by day', async () => {
    vi.mocked(laborCosts).mockResolvedValue({
      rows: [row(), row({ date: addDaysYmd(TODAY, -3), scheduledCost: 100, associateCost: 100 })],
      truncated: false,
    } as never);
    renderPage();
    expect(await screen.findAllByRole('table', { name: 'Daily labor detail' })).toHaveLength(1);
    // One heading per day with activity, newest first.
    const headings = screen.getAllByRole('button', { expanded: true }).filter((b) => /Scheduled \d/.test(b.textContent ?? ''));
    expect(headings).toHaveLength(2);
  });

  it('names the shifts with no client and narrows the grid to them on request', async () => {
    vi.mocked(laborCosts).mockResolvedValue({
      rows: [
        row(),
        row({ clientId: null, clientName: null, locationId: null, locationName: 'The Grand Hotel', scheduledShifts: 2, scheduledCost: 210, associateCost: 210 }),
      ],
      truncated: false,
    } as never);
    const router = renderPage();
    expect(await screen.findByText(/2 shifts have no client \(\$210\.00 scheduled\)/)).toBeInTheDocument();
    // No donut slice called "No client" posing as a client.
    expect(screen.queryByText('Share of scheduled cost by client')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show this row' }));
    });
    await waitFor(() => expect(router.state.location.search).toContain('focus=gaps'));
    const grid = screen.getByRole('table', { name: 'Daily labor detail' });
    expect(within(grid).getByText('The Grand Hotel')).toBeInTheDocument();
    expect(within(grid).queryByText('Front Beach 218')).not.toBeInTheDocument();
  });

  it('keeps the range in the URL: a preset writes it, the default clears it', async () => {
    const router = renderPage();
    await screen.findByRole('group', { name: 'Labor cost in this range' });
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Last period' }));
    });
    await waitFor(() => expect(router.state.location.search).toBe(`?from=${LAST.start}&to=${LAST.end}`));
    await waitFor(() =>
      expect(laborCosts).toHaveBeenLastCalledWith({ from: localMidnightIso(LAST.start), to: localMidnightIso(addDaysYmd(LAST.end, 1)) }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'This period' }));
    });
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('opens a shared link on its own dates', async () => {
    renderPage(`/labor-costs?from=${LAST.start}&to=${LAST.end}`);
    await waitFor(() =>
      expect(laborCosts).toHaveBeenCalledWith({ from: localMidnightIso(LAST.start), to: localMidnightIso(addDaysYmd(LAST.end, 1)) }),
    );
    expect(await screen.findByRole('radio', { name: 'Last period' })).toHaveAttribute('aria-checked', 'true');
  });
});
