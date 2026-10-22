import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The timesheet count opens the queue on the rows it counted (audit Tier 1
 * #6; walk ops 1, floor 1, HR 1): with nothing pending in the current
 * period and six in an older, paid one, the queue opens on that period and
 * says so. Time & attendance opens on the queue when nobody is clocked in
 * and something waits (ops 19). A supervisor's own rows get no Approve
 * (floor 25).
 */

vi.mock('@/lib/timeApi', () => ({
  addTimeEntryBreak: vi.fn(),
  adminCreateTimeEntry: vi.fn(),
  adminEditTimeEntry: vi.fn(),
  approveTimeEntry: vi.fn(),
  bulkApplyBreakTimeEntries: vi.fn(),
  bulkApproveTimeEntries: vi.fn(),
  bulkRejectTimeEntries: vi.fn(),
  countAdminTimeEntries: vi.fn(),
  deleteTimeEntryBreak: vi.fn(),
  exportPayrollSheet: vi.fn(),
  exportTimeEntries: vi.fn(),
  exportTimeSummary: vi.fn(),
  exportExternalPayrollSheet: vi.fn(),
  getActiveDashboard: vi.fn(async () => ({ entries: [] })),
  listAdminTimeEntries: vi.fn(async () => ({ entries: [] })),
  listPayPeriods: vi.fn(),
  rejectTimeEntry: vi.fn(),
  updateTimeEntryBreak: vi.fn(),
}));
vi.mock('@/lib/directoryApi', () => ({ listDirectory: vi.fn(async () => ({ associates: [] })) }));
vi.mock('@/lib/clientsApi', () => ({
  listClients: vi.fn(async () => ({ clients: [] })),
  listClientLocations: vi.fn(async () => ({ locations: [] })),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn(async () => ({ shifts: [] })),
  listSchedulingAssociates: vi.fn(async () => ({ associates: [] })),
}));
vi.mock('@/lib/externalPaymentsApi', () => ({ getPeriodPrefill: vi.fn(), recordPayPeriod: vi.fn() }));

import { countAdminTimeEntries, getActiveDashboard, listAdminTimeEntries, listPayPeriods } from '@/lib/timeApi';
import { AdminTimeView } from '@/pages/time/AdminTimeView';
import { AuthContext } from '@/lib/auth';

const ymd = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

// Biweekly periods around today: the current one (today inside) and the
// one before it, already paid. The six pending rows sit in the paid one.
const CURRENT = { start: ymd(daysAgo(6)), end: ymd(daysAgo(-7)), current: true, hasRun: false };
const PAID = { start: ymd(daysAgo(20)), end: ymd(daysAgo(7)), current: false, hasRun: true };
const OLDEST_IN = daysAgo(18);
OLDEST_IN.setHours(9, 0, 0, 0);

function authValue(associateId: string | null) {
  return {
    isInitializing: false,
    isOffline: false,
    user: { id: 'u-dana', email: 'dana@example.com', role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', clientId: 'c1', clientName: 'Hotel', associateId },
    role: 'SHIFT_SUPERVISOR',
    capabilities: new Set(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    can: () => true,
  } as never;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string, associateId: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={authValue(associateId)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/time-attendance"
              element={
                <>
                  <AdminTimeView canManage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const entry = (id: string, associateId: string, name: string) => ({
  id,
  associateId,
  associateName: name,
  clientId: 'c1',
  clientName: 'Hotel',
  clockInAt: OLDEST_IN.toISOString(),
  clockOutAt: new Date(OLDEST_IN.getTime() + 8 * 3_600_000).toISOString(),
  status: 'COMPLETED',
  notes: null,
  rejectionReason: null,
  approvedById: null,
  approverEmail: null,
  approvedAt: null,
  minutesElapsed: 480,
  anomalies: [],
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listPayPeriods).mockResolvedValue({ periods: [CURRENT, PAID] });
  vi.mocked(countAdminTimeEntries).mockResolvedValue({
    count: 6,
    oldestPendingAt: OLDEST_IN.toISOString(),
    byPeriod: [{ start: PAID.start, end: PAID.end, count: 6, hasRun: true }],
  });
  vi.mocked(getActiveDashboard).mockResolvedValue({ entries: [] } as never);
  vi.mocked(listAdminTimeEntries).mockClear();
  vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: [entry('e1', 'a-maria', 'Maria Lopez')], truncated: false } as never);
});

describe('the timesheet queue opens where the pending rows are', () => {
  it('opens on the oldest period with pending entries and shows the chip', async () => {
    renderAt('/time-attendance?tab=queue');
    // The picker lands on the paid period, not the current one.
    await waitFor(() => {
      expect((screen.getByLabelText('Pay period') as HTMLSelectElement).value).toBe(`${PAID.start}|${PAID.end}`);
    });
    // The count asked for the per-period breakdown.
    expect(vi.mocked(countAdminTimeEntries).mock.calls[0]?.[2]).toEqual({ groupBy: 'payPeriod' });
    // The chip says where the work is.
    const chip = screen.getByTestId('pending-period-chip');
    expect(chip.textContent).toMatch(/^6 pending · /);
    // The dropdown carries the count next to the period.
    const option = screen.getByRole('option', { name: /6 pending · paid/ });
    expect(option).toBeTruthy();
    // The list was asked for that window.
    await waitFor(() => {
      const last = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0];
      expect(last?.from?.slice(0, 10)).toBe(PAID.start);
    });
    // Rows in a paid period say so.
    await screen.findByText('Paid period');
  });

  it('a window with no pending rows offers to show the older ones', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({ entries: [], truncated: false } as never);
    // Deep link into the current period: nothing there.
    const user = renderAt(`/time-attendance?tab=queue&from=${CURRENT.start}&to=${CURRENT.end}`);
    await screen.findByText(/6 pending entries are older than this period/);
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => {
      const last = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0];
      expect(last?.from?.slice(0, 10)).toBe(ymd(OLDEST_IN));
      expect(last?.to?.slice(0, 10) >= ymd(new Date())).toBe(true);
    });
  });

  it('honours status=COMPLETED from the shared link', async () => {
    localStorage.setItem('alto:list.time.status.v1', JSON.stringify('APPROVED'));
    renderAt(`/time-attendance?tab=queue&status=COMPLETED&from=${PAID.start}&to=${PAID.end}`);
    await waitFor(() => {
      const last = vi.mocked(listAdminTimeEntries).mock.calls.at(-1)?.[0];
      expect(last?.status).toBe('COMPLETED');
    });
  });

  it('Time & attendance opens on the queue when nobody is clocked in and something waits', async () => {
    renderAt('/time-attendance');
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/time-attendance?tab=queue');
    });
  });

  it('stays on Live when someone is clocked in', async () => {
    vi.mocked(getActiveDashboard).mockResolvedValue({
      entries: [{ id: 'live1', associateId: 'a1', associateName: 'On Floor', clientId: 'c1', clientName: 'Hotel', clockInAt: new Date().toISOString(), minutesElapsed: 30, locationId: null, locationName: null, locationTimezone: null, shiftStartsAt: null, shiftEndsAt: null, geofenceOk: null, onBreak: false, jobName: null }],
    } as never);
    renderAt('/time-attendance');
    await screen.findByText('On Floor');
    expect(screen.getByTestId('location').textContent).toBe('/time-attendance');
  });

  it('on a phone the filters sit behind one chip and the exports are gone (floor 8)', async () => {
    // jsdom's matchMedia stub matches every min-width; a phone matches none.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const user = renderAt(`/time-attendance?tab=queue&from=${PAID.start}&to=${PAID.end}`);
      await screen.findByText('Maria Lopez');
      // The list is the first screen: no filter controls, no exports.
      expect(screen.queryByLabelText('Pay period')).toBeNull();
      expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull();
      const chip = screen.getByTestId('queue-filter-chip');
      expect(chip.textContent).toMatch(/^Pending review · /);
      await user.click(chip);
      // The sheet holds the filters.
      await screen.findByRole('dialog');
      expect(screen.getByLabelText('Pay period')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('a supervisor gets no Approve on her own row, and the row is not selectable', async () => {
    vi.mocked(listAdminTimeEntries).mockResolvedValue({
      entries: [entry('mine', 'a-dana', 'Dana Lead'), entry('theirs', 'a-maria', 'Maria Lopez')],
      truncated: false,
    } as never);
    renderAt(`/time-attendance?tab=queue&from=${PAID.start}&to=${PAID.end}`, 'a-dana');
    await screen.findByText('Dana Lead');
    expect(screen.getByText('Yours — someone else approves it')).toBeTruthy();
    // One Approve button on the page: Maria's.
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    const mineRow = document.getElementById('time-row-mine')!;
    const theirsRow = document.getElementById('time-row-theirs')!;
    expect((mineRow.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.disabled ?? true).toBe(true);
    expect((theirsRow.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(false);
  });
});
