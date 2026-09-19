import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import type { FinanceOverview } from '@/pages/finance/financeTypes';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { FinanceDashboard } from '@/pages/FinanceDashboard';

/**
 * The finance cockpit: the pay cycle (period → hours → run → payday), what
 * needs finance today in the order it's due, the four numbers that matter,
 * last week in Fieldglass, revenue against wages, and receivables by age.
 */

const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
const ymd = (daysFromNow: number) => {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function overview(over: Partial<FinanceOverview> = {}): FinanceOverview {
  return {
    generatedAt: new Date().toISOString(),
    payday: { next: { date: iso(13), schedule: 'Biweekly' }, inFlight: null, lastDisbursed: { periodEnd: ymd(-8), totalGross: 4054.5 } },
    payCycle: {
      periodStart: ymd(-7),
      periodEnd: ymd(6),
      payDate: ymd(13),
      schedule: 'Biweekly',
      hours: { approved: 195.5, pending: 40.6 },
      run: null,
    },
    close: { pendingEntries: 6, pendingHours: 40.6, oldestDay: ymd(-1), byClient: [{ clientId: 'c1', clientName: 'Coastal Resort', entries: 6, hours: 40.6 }] },
    payrollCases: { open: 0, assignedToMe: 0 },
    settlements: { count: 0, total: 0 },
    receivables: {
      outstandingTotal: 5760,
      outstandingCount: 2,
      oldestDays: 41,
      avgDaysToPay: 26,
      draftStatements: 1,
      aging: { current: 2880, d31: 2880, d61: 0, d91: 0 },
      byClient: [{ clientId: 'c1', clientName: 'Coastal Resort', amount: 5760, oldestDays: 41 }],
    },
    billing: {
      weekStart: ymd(-8),
      weekEnd: ymd(-2),
      weekEnding: '09/18/2026',
      // Due in a few hours: the entry task leads the list.
      dueAt: iso(0.2),
      workers: 6,
      registered: 5,
      entered: 3,
      toEnter: 3,
      rejected: 1,
      approved: 2,
      submitted: 1,
      notRegistered: 1,
      variances: 1,
      hours: 195.5,
      money: { approved: 1305, awaiting: 765, atRisk: 2328.75 },
      unpricedHours: 0,
      rejectedOpen: { count: 1, amount: 720 },
    },
    margin: {
      weeks: Array.from({ length: 8 }, (_, i) => ({
        weekStart: ymd(-7 * (7 - i) - 1),
        weekEnd: ymd(-7 * (7 - i) + 5),
        inProgress: i === 7,
        hours: i === 7 ? 0 : 128,
        revenue: i === 7 ? 0 : i === 6 ? 4398.75 : 2880,
        wages: i === 7 ? 0 : i === 6 ? 3021.75 : 2016,
        margin: i === 7 ? 0 : i === 6 ? 1377 : 864,
        marginPct: i === 7 ? null : i === 6 ? 0.313 : 0.3,
        unpricedHours: 0,
      })),
      defaultRate: 15,
      defaultRateAssociates: 1,
    },
    fieldglassQueue: [],
    fieldglassQueueTotal: 4,
    billedVsPaid: null,
    ...over,
  };
}

function renderDashboard(data: FinanceOverview) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/finance/overview') return data as never;
    throw new Error(`unexpected ${path}`);
  });
  const caps = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'fin@altohr.com', role: 'FINANCE_ACCOUNTANT', status: 'ACTIVE' as const, clientId: null, associateId: null },
          role: 'FINANCE_ACCOUNTANT',
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <MemoryRouter>
          <FinanceDashboard />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the finance cockpit', () => {
  it('the pay cycle, step by step', async () => {
    renderDashboard(overview());
    const cycle = await screen.findByRole('list', { name: 'Pay cycle' });
    expect(within(cycle).getByText('195.5h of 236.1h')).toBeInTheDocument();
    expect(within(cycle).getByText('40.6h still waiting')).toBeInTheDocument();
    expect(within(cycle).getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText(/Last payday: \$4,054\.50/)).toBeInTheDocument();
  });

  it('today, most urgent first — the Fieldglass deadline leads, rejected ones counted once', async () => {
    renderDashboard(overview());
    const today = await screen.findByRole('list', { name: 'Today' });
    const items = within(today).getAllByRole('link');
    expect(items[0]).toHaveTextContent('Enter in Fieldglass — 2 to go');
    expect(items[0]).toHaveAttribute('href', expect.stringContaining('/time-attendance/timesheets?week='));
    expect(within(today).getByRole('link', { name: /Rejected timesheets to fix and resubmit: 2/ })).toBeInTheDocument();
    expect(within(today).getByRole('link', { name: /Fieldglass setup: 4 waiting/ })).toHaveAttribute('href', '/fieldglass');
    expect(within(today).getByRole('link', { name: /Past 30 days, to collect: \$2,880\.00/ })).toBeInTheDocument();
    expect(within(today).getByRole('link', { name: /Client statements to finalize: 1/ })).toBeInTheDocument();
  });

  it('the numbers: revenue and margin last week, money at risk, receivables by age', async () => {
    renderDashboard(overview());
    expect(await screen.findByText('Revenue · last week')).toBeInTheDocument();
    expect(screen.getAllByText('31%')).toHaveLength(2); // the tile, and last week's bar
    expect(screen.getByText('$1,377.00 after wages')).toBeInTheDocument();
    // At risk: last week's $2,328.75 plus the $720 rejected earlier.
    expect(screen.getAllByText('$3,048.75').length).toBeGreaterThan(0);
    expect(screen.getByText('Billing · week ending 09/18/2026')).toBeInTheDocument();
    expect(screen.getByText('Plus 1 rejected in earlier weeks — $720.00 waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Enter in Fieldglass \(3\)/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Revenue, wages & margin' })).toBeInTheDocument();
    expect(screen.getByText('1 paid at the $15.00 fallback — no hourly pay on file')).toBeInTheDocument();
    expect(screen.getByText('31–60 days')).toBeInTheDocument();
  });

  it('all clear says so', async () => {
    renderDashboard(
      overview({
        billing: null,
        payCycle: null,
        close: { pendingEntries: 0, pendingHours: 0, oldestDay: null, byClient: [] },
        fieldglassQueueTotal: 0,
        receivables: { outstandingTotal: 0, outstandingCount: 0, oldestDays: null, avgDaysToPay: null, draftStatements: 0, aging: { current: 0, d31: 0, d61: 0, d91: 0 }, byClient: [] },
      }),
    );
    expect(await screen.findByText('All clear — nothing is waiting on finance.')).toBeInTheDocument();
    expect(screen.getByText('Nothing outstanding.', { selector: 'p' })).toBeInTheDocument();
  });
});
