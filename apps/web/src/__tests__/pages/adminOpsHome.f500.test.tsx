import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type DashboardKPIs } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * F500 G5 — the HR administrator's and the operations manager's home:
 *
 *   - "Needs you" is ONE list: the page's own counted items (incidents to
 *     review…) are rows inside the decision queue's card, not a lone card in
 *     a three-column grid; the count is the rows listed;
 *   - the snapshot is a strip of four, no "View details" on every tile, no
 *     sparkline that measures another number (open shifts drew "shifts
 *     scheduled/wk"), no Net paid on the HR desk; "Rejected 0" is not red;
 *   - the operations manager's home is the floor: the stores today, one row a
 *     store — no onboarding funnel, no generic snapshot;
 *   - on a phone the snapshot folds behind "More numbers" and the subtitle
 *     gives its line to what needs you.
 */

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: api.apiFetch }));
const kpis = vi.hoisted(() => ({ getDashboardKPIs: vi.fn() }));
vi.mock('@/lib/analyticsApi', () => kpis);
vi.mock('@/lib/w4RecollectionApi', () => ({ getW4RecollectionSummary: vi.fn(async () => ({ outstanding: 0 })) }));
vi.mock('@/lib/auditApi', () => ({ searchAuditLogs: vi.fn(async () => ({ entries: [] })) }));
const gaps = vi.hoisted(() => ({ getShiftCoverageGaps: vi.fn() }));
vi.mock('@/lib/shiftWindowsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/shiftWindowsApi')>()), getShiftCoverageGaps: gaps.getShiftCoverageGaps }));
vi.mock('@/components/home/RoleFocusRow', () => ({ RoleFocusRow: () => <div>focus row</div> }));
vi.mock('@/components/home/OpsActivityFeed', () => ({ OpsActivityFeed: () => <div>activity</div> }));
vi.mock('@/components/MyPlanCard', () => ({ MyPlanCard: () => <div>my plan</div> }));
vi.mock('@/components/ProgramAlertsCard', () => ({ ProgramAlertsCard: () => null }));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));

import { AdminDashboard } from '@/pages/AdminDashboard';

const trend = (series: number[]) => ({ series, delta: series[series.length - 2]! - series[series.length - 3]! });
const KPIS: DashboardKPIs = {
  activeAssociates: 12,
  onTheBooks: 21,
  activeWindowDays: 14,
  openShiftsNext30d: 7,
  associatesClockedIn: 3,
  pendingOnboardingApplications: 1,
  pendingI9Section2: 0,
  pendingDocumentReviews: 0,
  netPaidLast30d: 1200,
  netPendingDisbursement: 0,
  applicationStatusCounts: { DRAFT: 1, SUBMITTED: 0, IN_REVIEW: 0, APPROVED: 17, REJECTED: 0 },
  windowDays: 30,
  trends: { hoursWorked: trend([100, 120, 140, 10]), shiftsScheduled: trend([5, 6, 7, 2]), applications: trend([0, 1, 2, 1]) },
};

const STORES = {
  today: {
    filled: 3,
    open: 1,
    stores: [
      { clientId: 'c1', clientName: 'Front Beach 218', onFloor: 1, scheduledNow: 2, scheduledToday: 3, openToday: 1, callOutsToday: 2, confirmedTomorrow: 4, unconfirmedTomorrow: 1, openTomorrow: 1, noShowsToday: 0, incidentsToday: 0, unscheduledNow: 0, status: 'red' },
    ],
  },
};

function renderHome(role: 'HR_ADMINISTRATOR' | 'OPERATIONS_MANAGER') {
  const caps = ROLE_CAPABILITIES[role];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // One company decision on the queue.
  client.setQueryData(['me', 'decisions'], { decisions: [{ key: 'everify:tnc:a1', severity: 'critical', label: 'E-Verify mismatch for Maria Lopez', detail: 'Give the notice.', stakes: null, ageDays: 6, linkUrl: '/compliance', claimedBy: null, claimedByMe: false, assigned: false, note: null, escalated: false, nextStep: null }] });
  return render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'admin@example.com', role, status: 'ACTIVE' as const, clientId: null, associateId: null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter>
            <AdminDashboard />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  kpis.getDashboardKPIs.mockResolvedValue(KPIS);
  api.apiFetch.mockImplementation(async (path: string) => {
    if (path === '/osha/incidents') return { incidents: [{ status: 'REPORTED' }, { status: 'INVESTIGATING' }, { status: 'RESOLVED' }] };
    if (path === '/workforce/overview') return STORES;
    if (path.startsWith('/me/inbox')) return { total: 0, sources: [] };
    return {};
  });
  gaps.getShiftCoverageGaps.mockResolvedValue({ total: 3, covered: 2, clients: [{ clientId: 'c1', clientName: 'Coastal', uncovered: [{ locationId: 'l1', locationName: 'Front Beach 218', label: 'Swing', startMinute: 840, endMinute: 1320 }], noShift: [], supervisors: [] }] });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('the HR administrator’s home', () => {
  it('lists its own items as rows inside the decision queue’s card, and counts what is listed', async () => {
    renderHome('HR_ADMINISTRATOR');
    const rows = await screen.findByTestId('needs-you-rows');
    const incidents = within(rows).getByRole('link', { name: /Safety incidents awaiting review/ });
    expect(incidents).toHaveAttribute('href', '/compliance/osha');
    // 2 open of 3 (one is resolved).
    expect(within(incidents).getByText('2')).toBeInTheDocument();
    // Same card as the queue's rows — not a card grid beside it.
    expect(rows.closest('[class*="rounded"]')).toContainElement(screen.getByText('E-Verify mismatch for Maria Lopez'));
    // 1 queue row + 1 page row.
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('2');
  });

  it('keeps the snapshot to four tiles, each a link, with no borrowed sparkline and no "View details"', async () => {
    renderHome('HR_ADMINISTRATOR');
    const strip = await screen.findByRole('group', { name: 'Workforce snapshot' });
    const labels = [...strip.querySelectorAll(':scope > div')].map((d) => d.textContent ?? '');
    expect(labels).toHaveLength(4);
    expect(labels[0]).toMatch(/Working \(14 days\)/);
    expect(labels[1]).toMatch(/Open shifts · next 30d/);
    expect(labels[2]).toMatch(/Hours worked · last week/);
    expect(labels[3]).toMatch(/Onboarding in flight/);
    expect(strip).not.toHaveTextContent(/Net paid/);
    expect(strip).not.toHaveTextContent(/View details/i);
    // Open shifts carries no "shifts scheduled/wk" line under it.
    expect(strip).not.toHaveTextContent(/shifts scheduled/);
    const open = within(strip).getByRole('link', { name: /Open shifts/ });
    expect(open).toHaveAttribute('href', '/scheduling?open=1');
  });

  it('colours a pipeline stage only when it has someone in it', async () => {
    renderHome('HR_ADMINISTRATOR');
    const rejected = await screen.findByTitle('View rejected applications');
    const approved = screen.getByTitle('View approved applications');
    expect(within(rejected).getByText('0')).not.toHaveClass('text-alert');
    expect(within(approved).getByText('17')).toHaveClass('text-success');
  });
});

describe('the operations manager’s home', () => {
  it('is the floor: the stores today, one row a store — no onboarding funnel, no generic snapshot', async () => {
    renderHome('OPERATIONS_MANAGER');
    const grid = await screen.findByRole('table', { name: /today/i });
    const row = within(grid).getByText('Front Beach 218').closest('tr')!;
    const cells = within(row);
    expect(cells.getByText('1 of 2')).toBeInTheDocument();
    expect(cells.getByText('3')).toBeInTheDocument();
    const links = () => [...row.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    // One window (Swing) at this client has no lead — from the store-leads gaps.
    await waitFor(() => expect(links()).toContainEqual(['1', '/scheduling/supervisors']));
    expect(links()).toContainEqual(['1', expect.stringMatching(/^\/scheduling\?client=c1&open=1&date=\d{4}-\d{2}-\d{2}$/)]);
    expect(links()).toContainEqual(['2', '/call-outs']);
    // 4 confirmed of 6 tomorrow, 1 still open.
    expect(cells.getByText(/4 of 6/)).toBeInTheDocument();
    expect(cells.getByText('1 open')).toBeInTheDocument();
    expect(screen.queryByText('Workforce snapshot')).not.toBeInTheDocument();
    expect(screen.queryByText('Onboarding pipeline')).not.toBeInTheDocument();
  });

  it('says plainly when no store has a shift today', async () => {
    api.apiFetch.mockImplementation(async (path: string) => (path === '/workforce/overview' ? { today: { filled: 0, open: 0, stores: [] } } : path === '/osha/incidents' ? { incidents: [] } : {}));
    renderHome('OPERATIONS_MANAGER');
    // One quiet line, not a dashed empty box under a tile that already says so.
    expect(await screen.findByTestId('ops-stores-none')).toHaveTextContent(/has a shift or anyone on the clock today/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('on a phone', () => {
  it('folds the snapshot behind "More numbers" and leaves the subtitle out', async () => {
    window.matchMedia = ((query: string) => ({
      matches: /min-width/.test(query) && !/640px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    renderHome('HR_ADMINISTRATOR');
    const more = await screen.findByRole('button', { name: 'More numbers' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Workforce snapshot' })).not.toBeInTheDocument();
    expect(screen.queryByText(/what's happening across your workforce/i)).not.toBeInTheDocument();
    fireEvent.click(more);
    expect(await screen.findByRole('group', { name: 'Workforce snapshot' })).toBeInTheDocument();
  });
});
