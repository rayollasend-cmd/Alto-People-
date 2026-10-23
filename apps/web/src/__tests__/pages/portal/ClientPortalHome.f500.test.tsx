import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
vi.mock('@/components/home/HugoSeat', () => ({ HugoSeat: () => null }));
vi.mock('@/components/PushPrompt', () => ({ PushPrompt: () => null }));

import { apiFetch } from '@/lib/api';
import { ClientPortalHome } from '@/pages/portal/ClientPortalHome';

/**
 * The store manager's home (F500 G5): Needs you leads with what the store
 * owes and is owed (statements past due with money, the late reply, the
 * answer, candidates), the hero says the contract gap plainly with a way to
 * ask for coverage, statements carry money and how late, and a region
 * account that opened a store reads it without the client's own acts.
 */

const today = new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const week = (start: string, current = false) => ({
  start, end: plus(6), filled: 0, total: 0, fillPct: null, showed: 0, reliabilityPct: 0, showedUpPct: null,
  contracted: 1120, delivered: 0, noCallNoShows: 0, callOuts: 0, lates: 0, replaced: 0, current,
});

function overview(over: Record<string, unknown> = {}) {
  return {
    client: { id: 'c1', name: 'Coastal Resort Holdings' },
    store: { id: 'l1', name: 'Front Beach 218', timezone: 'America/Chicago', address: '15495 Panama City Beach Pkwy' },
    stores: [],
    generatedAt: new Date().toISOString(),
    now: { onFloor: [], scheduledNow: 0, target: 8, targetLabel: 'Morning' },
    today: { date: today, roster: [], filled: 0, open: 0 },
    week: { start: plus(-3), end: plus(3), days: [], filled: 2, open: 1, fillRatePct: 67, hours: 21, workedHours: 0, contractedHours: 1120 },
    tomorrow: { confirmed: 0, unconfirmed: 0, open: 0, coverInFlight: 0, target: 20 },
    leads: { people: [], supportEmail: null },
    ops: null,
    opsPlan: { everRan: true, next: { department: 'Food & Consumables', windowLabel: 'Swing', startsAt: `${today}T19:00:00.000Z` }, missedToday: 0 },
    reliability: { weeks: [week(plus(-28)), week(plus(-21)), week(plus(-14)), week(plus(-7)), week(plus(0), true)], grade: 'F', score: 0, basis: 'contract' },
    clearance: { total: 2, i9Complete: 1, checksInFlight: 0, flagged: 0, cleared: 1 },
    statements: [
      { id: 's4', number: 4, periodStart: '2026-08-29', periodEnd: '2026-09-04', amount: 2880, hours: 128, storeHours: 128, storeAmount: 2880, finalizedAt: '2026-09-06T00:00:00.000Z', paidAt: null, dueAt: '2026-10-07', poNumber: 'PO-7781', daysPastDue: 15, pdfUrl: '/api/client-portal/statements/s4.pdf', reviewed: null },
      { id: 's2', number: 2, periodStart: '2026-07-25', periodEnd: '2026-07-31', amount: 2880, hours: 128, storeHours: 128, storeAmount: 2880, finalizedAt: null, paidAt: '2026-09-01T12:00:00.000Z', dueAt: '2026-08-30', poNumber: null, daysPastDue: null, pdfUrl: '/api/client-portal/statements/s2.pdf', reviewed: null },
    ],
    balance: { count: 2, amount: 5760, pastDue: 2, pastDueAmount: 5760, oldestDaysPastDue: 44, pastDueIds: ['s3', 's4'] },
    candidatesWaiting: 1,
    requests: { overdue: 1, overdueDays: 32, overdueId: 'r1', answered: 1, answeredId: 'r2' },
    coverage: { weekStart: plus(-3), noCallNoShows: 0, callOuts: 0, lates: 0, replacementsFound: 0 },
    safety: { monthIncidents: 0, open: 0, daysSinceLast: null },
    serviceReport: { weekStart: plus(-10), url: '/api/client-portal/service-report.pdf', reviewed: null, hadShifts: true },
    ...over,
  };
}

function renderAs(user: Record<string, unknown>, entry = '/', fail?: ApiError) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path.startsWith('/client-portal/overview')) {
      if (fail) throw fail;
      return overview() as never;
    }
    if (path.startsWith('/client-portal/requests')) return { requests: [] } as never;
    return {} as never;
  });
  const caps = ROLE_CAPABILITIES.CLIENT_PORTAL;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'portal@x.example', role: 'CLIENT_PORTAL', status: 'ACTIVE', clientId: null, associateId: null, ...user } as never,
          role: 'CLIENT_PORTAL',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[entry]}>
            <ClientPortalHome />
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const STORE = { clientId: 'c1', locationId: 'l1' };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the store home: Needs you', () => {
  it('leads with statements past due (money, how late), the service report, candidates, the late reply and the answer — each with its link', async () => {
    renderAs(STORE);
    const list = await screen.findByRole('list', { name: 'Needs you' });
    const st = within(list).getByTestId('need-statements');
    expect(st).toHaveTextContent('2 statements past due');
    expect(st).toHaveTextContent('$5,760.00 · oldest 44 days past due');
    expect(within(st).getByRole('link')).toHaveAttribute('href', '#portal-statements');
    expect(within(list).getByTestId('need-report')).toHaveTextContent(/Last week’s service report \(.+\) is ready to review/);
    expect(within(within(list).getByTestId('need-report')).getByRole('button', { name: /Mark reviewed/ })).toBeInTheDocument();
    expect(within(within(list).getByTestId('need-candidates')).getByRole('link')).toHaveAttribute('href', '/portal/candidates');
    const late = within(list).getByTestId('need-requests-overdue');
    expect(late).toHaveTextContent('1 request past its reply-by');
    expect(late).toHaveTextContent('Reply overdue · 32 days');
    expect(within(late).getByRole('link')).toHaveAttribute('href', '/portal/requests?id=r1');
    expect(within(within(list).getByTestId('need-requests-answered')).getByRole('link')).toHaveAttribute('href', '/portal/requests?id=r2');
    // Counted as listed.
    expect(screen.getByTestId('needs-you-count')).toHaveTextContent('5');
  });

  it('says the contract gap and offers coverage; the KPIs carry the contract', async () => {
    renderAs(STORE);
    expect(await screen.findByTestId('portal-hero-line')).toHaveTextContent('Nothing is scheduled for today’s Morning window. Your contract is 8.');
    // The hero carries the coverage ask (the header doesn't repeat it).
    expect(screen.getAllByRole('button', { name: /Request coverage/ })).toHaveLength(1);
    expect(screen.getByText('Scheduled vs contracted · this week')).toBeInTheDocument();
    expect(screen.getByText('/ 1,120h')).toBeInTheDocument();
    expect(screen.getByTestId('tomorrow-vs-contract')).toHaveTextContent('0 of 20 contracted scheduled');
    // The grade explains itself.
    expect(screen.getByText('0 of 4,480 contracted person-hours delivered')).toBeInTheDocument();
    // Clearance counts I-9: 1 of 2, never "2 of 2" beside "1 I-9 pending".
    expect(screen.getByText('1 of 2 cleared')).toBeInTheDocument();
    // Checklists: what is next, not "evidence appears once … runs its SOP shifts".
    expect(screen.getByTestId('portal-ops-plan')).toHaveTextContent(/Nothing started yet today\. Next: Food & Consumables, Swing, /);
    expect(screen.queryByText(/SOP/)).toBeNull();
    expect(screen.queryByText(/Counts only/)).toBeNull();
  });

  it('statements: money, the due date, how late, the open balance', async () => {
    renderAs(STORE);
    const rows = await screen.findAllByTestId('portal-statement');
    expect(rows[0]).toHaveTextContent('$2,880.00');
    expect(rows[0]).toHaveTextContent('15 days past due');
    expect(rows[0]).toHaveTextContent('PO PO-7781');
    expect(rows[0]).toHaveTextContent(/due Oct 7/);
    expect(rows[1]).toHaveTextContent(/Paid Sep 1/);
    // A paid statement keeps its PDF only.
    expect(within(rows[1]).queryByRole('button', { name: /Question this/ })).toBeNull();
    expect(screen.getByTestId('open-balance')).toHaveTextContent('Open balance $5,760.00 · 2 statements');
  });
});

describe('a region account in a store', () => {
  const REGION = { clientId: null, regionId: 'rg1' };

  it('reads the store without the client’s own acts, and goes back to the command center', async () => {
    renderAs(REGION, '/portal?locationId=l1');
    expect(await screen.findByRole('link', { name: /Back to Command center/ })).toHaveAttribute('href', '/region');
    expect(screen.queryByRole('button', { name: /Request coverage/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Question this/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark reviewed/ })).toBeNull();
    expect(screen.queryByText('Make a request')).toBeNull();
  });

  it('a store-less /portal says the API’s sentence and the way back — no pointless Retry', async () => {
    renderAs(REGION, '/portal', new ApiError(400, 'store_required', 'Pick a store in your region.'));
    expect(await screen.findByText('Pick a store in your region.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to Command center/ })).toHaveAttribute('href', '/region');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
