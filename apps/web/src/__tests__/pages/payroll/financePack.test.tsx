import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import type { ReactNode } from 'react';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { EarnedWageCard } from '@/components/EarnedWageCard';
import { PayrollClosePage, type PayrollClose } from '@/pages/payroll/PayrollClosePage';
import { CashForecastPage } from '@/pages/finance/CashForecastPage';
import { EarnedWageDesk } from '@/pages/payroll/EarnedWageDesk';
import { TimeOffPoliciesView } from '@/pages/timeoff/TimeOffPoliciesView';
import { financeTasks } from '@/pages/finance/FinanceCockpit';
import type { FinanceOverview } from '@/pages/finance/financeTypes';

/**
 * The pay & finance pack, on screen: pay before payday on the associate's
 * pay page, the guided close, the cash forecast, Finance's earned-wage
 * desk, the time-off policies desk, and the hold queue in "Today".
 */

function renderAs(role: Role, ui: ReactNode, path = '/', routePath = '/') {
  const caps = ROLE_CAPABILITIES[role];
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{
          isInitializing: false,
          isOffline: false,
          user: { id: 'u', email: 'x@altohr.com', role, status: 'ACTIVE' as const, clientId: null, associateId: role === 'ASSOCIATE' ? 'a1' : null },
          role,
          capabilities: new Set<Capability>(caps),
          signIn: vi.fn(),
          signOut: vi.fn(),
          can: (c: Capability) => caps.has(c),
        }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={routePath} element={ui} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('pay before payday', () => {
  const avail = {
    enabled: true,
    blocker: null,
    periodStart: '2026-10-10',
    periodEnd: '2026-10-23',
    payDate: '2026-10-30',
    hoursWorked: 10,
    earnedGross: 200,
    earnedNet: 156,
    capPct: 50,
    cap: 78,
    maxPerPeriod: 1000,
    drawn: 0,
    available: 78,
    fee: 0,
  };

  it('shows what is available and draws it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/me/earned-wage' && opts?.method === 'POST') return { id: 'x', status: 'PAID', amount: 40, fee: 0, failureReason: null } as never;
      if (path === '/me/earned-wage') return avail as never;
      throw new Error(`unexpected ${path}`);
    });
    renderAs('ASSOCIATE', <EarnedWageCard />);
    const card = await screen.findByTestId('earned-wage-card');
    expect(within(card).getByText('$78.00')).toBeInTheDocument();
    expect(within(card).getByText(/earned about \$156\.00/)).toBeInTheDocument();
    expect(within(card).getByText('No fee')).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText('How much?'), { target: { value: '40' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Get $40.00' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/me/earned-wage', { method: 'POST', body: { amount: 40 } }));
  });

  it('says why when nothing can be drawn', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ...avail, blocker: 'NO_VERIFIED_ACCOUNT', available: 0 } as never);
    renderAs('ASSOCIATE', <EarnedWageCard />);
    expect(await screen.findByText('Add a pay account and let payroll verify it first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get/ })).not.toBeInTheDocument();
  });
});

describe('the guided close', () => {
  const close: PayrollClose = {
    run: { id: 'r1', status: 'DRAFT', kind: 'REGULAR', clientName: 'Coastal Resort', periodStart: '2026-10-10', periodEnd: '2026-10-23', totalGross: 4000, totalNet: 3200, totalEmployerTax: 300, finalizedAt: null, approvedAt: null, approvedByEmail: null, disbursedAt: null, qboJournalEntryId: null, qboSyncError: null },
    approvalRequired: false,
    items: { pending: 3, disbursed: 0, held: 0, failed: 0, voided: 0 },
    heldItems: [],
    paidItems: [],
    rerouted: 0,
    readiness: { missingW4: [], missingPayout: [], unverifiedPayout: [], unsupportedState: ['Pat Nguyen (AR)'] },
    exceptions: { counts: { blocking: 1, warning: 0, info: 0 }, rows: [{ associateName: 'Pat Nguyen', kind: 'UNSUPPORTED_STATE', severity: 'BLOCKING', message: 'State income tax is not supported for AR.' }] },
    deposit: null,
    remittances: [],
    quickbooks: { connected: false, glByCostCenter: false },
    steps: [
      { key: 'readiness', label: 'Readiness', state: 'blocked', blockers: 1, warnings: 0, to: '/payroll/readiness' },
      { key: 'exceptions', label: 'Exceptions', state: 'blocked', blockers: 1, warnings: 0, to: '/payroll?run=r1' },
      { key: 'approve', label: 'Finalize', state: 'blocked', blockers: 0, warnings: 0, to: '/payroll?run=r1' },
      { key: 'disburse', label: 'Disburse', state: 'todo', blockers: 0, warnings: 0, to: '/payroll?run=r1' },
      { key: 'deposits', label: 'Tax deposit', state: 'todo', blockers: 0, warnings: 0, to: '/payroll/tax' },
      { key: 'quickbooks', label: 'QuickBooks', state: 'skip', blockers: 0, warnings: 0, to: '/clients' },
    ],
  };

  it('walks the six steps with what blocks each', async () => {
    vi.mocked(apiFetch).mockResolvedValue(close as never);
    renderAs('FINANCE_ACCOUNTANT', <PayrollClosePage />, '/payroll/runs/r1/close', '/payroll/runs/:id/close');
    const steps = await screen.findByRole('list', { name: 'Close steps' });
    expect(steps.children).toHaveLength(6);
    expect(within(steps).getByText('State not supported:')).toBeInTheDocument();
    expect(within(steps).getByText(/Pat Nguyen \(AR\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear 1 blocker' })).toHaveAttribute('href', '/payroll/readiness');
    expect(within(steps).getByText('Not applicable')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/payroll/runs/r1/close');
  });
});

describe('the cash forecast', () => {
  it('weeks with a running total, and every line behind them', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      generatedAt: '2026-10-17T12:00:00Z',
      from: '2026-10-17',
      to: '2026-11-13',
      weeks: [
        { weekStart: '2026-10-17', weekEnd: '2026-10-23', inflow: 3000, outflow: 0, net: 3000, cumulative: 3000 },
        { weekStart: '2026-10-24', weekEnd: '2026-10-30', inflow: 0, outflow: 4200, net: -4200, cumulative: -1200 },
      ],
      lines: [
        { date: '2026-10-22', kind: 'RECEIVABLE', label: 'Coastal Resort — statement No. 0007', amount: 3000, confidence: 'scheduled', linkUrl: '/clients/statements?statement=s1' },
        { date: '2026-10-30', kind: 'PAYROLL', label: 'Payroll 2026-10-10 – 2026-10-23 (projected)', amount: -4200, confidence: 'estimated', linkUrl: '/payroll' },
      ],
      totals: { inflow: 3000, outflow: 4200, net: -1200 },
    } as never);
    renderAs('FINANCE_ACCOUNTANT', <CashForecastPage />);
    expect(await screen.findByText('Coastal Resort — statement No. 0007')).toBeInTheDocument();
    expect(screen.getByText('Client payment · Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Payroll · Estimated')).toBeInTheDocument();
    expect(screen.getAllByText('-$1,200.00').length).toBeGreaterThan(0);
    expect(apiFetch).toHaveBeenCalledWith('/finance/cash-forecast?weeks=4');
  });
});

describe("Finance's earned-wage desk", () => {
  it('shows the exposure, every advance, and saves the policy', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.startsWith('/payroll/earned-wage/settings') && opts?.method === 'PATCH') return { enabled: true, capPct: 40, fee: 0, maxPerPeriod: 1000 } as never;
      if (path.startsWith('/payroll/earned-wage'))
        return {
          settings: { enabled: true, capPct: 50, fee: 0, maxPerPeriod: 1000 },
          outstanding: { count: 1, amount: 50 },
          advances: [
            { id: 'a', periodStart: '2026-10-10', periodEnd: '2026-10-23', amount: 50, fee: 0, status: 'PAID', provider: 'STUB', failureReason: null, requestedAt: '2026-10-15T12:00:00Z', paidAt: '2026-10-15T12:00:01Z', recovered: 0, recoveredAt: null, associate: { id: 'p', name: 'Lena Osei' } },
          ],
        } as never;
      throw new Error(`unexpected ${path}`);
    });
    renderAs('FINANCE_ACCOUNTANT', <EarnedWageDesk />);
    expect((await screen.findAllByText('Lena Osei')).length).toBeGreaterThan(0);
    expect(screen.getByText('Out until payday')).toBeInTheDocument();
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Cap (% of earned net)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/payroll/earned-wage/settings', { method: 'PATCH', body: { enabled: true, capPct: 40, fee: 0, maxPerPeriod: 1000 } }),
    );
  });
});

describe('time-off policies', () => {
  it('lists policies in plain words with who they apply to', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      policies: [
        {
          id: 'p1',
          name: 'Vacation — hourly staff',
          category: 'VACATION',
          accrualMode: 'PER_HOUR_WORKED',
          accrualPerHour: 0.03333,
          minutesPerPeriod: null,
          annualMinutes: null,
          policyAnchorDate: '2000-01-01',
          capMinutes: 2400,
          carryoverMaxMinutes: 600,
          waitingPeriodDays: 90,
          tenureTiers: [{ afterMonths: 24, accrualPerHour: 0.05 }],
          isActive: true,
          notes: null,
          updatedAt: '2026-10-01T00:00:00Z',
          assignments: [{ id: 'x', scopeKind: 'SITE', scopeId: 's1' }],
          people: 12,
        },
      ],
      scopeNames: { s1: 'Front Beach' },
    } as never);
    renderAs('HR_ADMINISTRATOR', <TimeOffPoliciesView canManage />);
    expect(await screen.findByText('Vacation — hourly staff')).toBeInTheDocument();
    expect(screen.getByText('1 h for every 30 h worked')).toBeInTheDocument();
    expect(screen.getByText('40 h')).toBeInTheDocument();
    expect(screen.getByText('90 days after hire')).toBeInTheDocument();
    expect(screen.getByText('Front Beach')).toBeInTheDocument();
    expect(screen.getByText(/after 24 mo: 1 h for every 20 h worked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New policy' })).toBeInTheDocument();
  });
});

describe('the hold queue in Today', () => {
  it('puts held pay-account changes near the top', () => {
    const t = ((k: string, v?: Record<string, unknown>) => `${k}${v ? JSON.stringify(v) : ''}`) as never;
    const data = {
      payday: { next: null, inFlight: null, lastDisbursed: null },
      close: { pendingEntries: 0, pendingHours: 0, oldestDay: null, byClient: [] },
      payrollCases: { open: 0, assignedToMe: 0 },
      settlements: { count: 0, total: 0 },
      receivables: { outstandingTotal: 0, outstandingCount: 0, oldestDays: null, avgDaysToPay: null, draftStatements: 0 },
      fieldglassQueue: [],
      billedVsPaid: null,
      generatedAt: '',
      financialChanges: { pending: 1, held: 2, open: 3 },
    } as unknown as FinanceOverview;
    const tasks = financeTasks(data, t, Date.now());
    expect(tasks[0]).toMatchObject({ key: 'verify', tone: 'alert', to: '/payroll/financial-changes' });
    expect(tasks[0].title).toContain('"count":3');
  });
});
