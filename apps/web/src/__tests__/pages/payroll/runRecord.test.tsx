import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * One run, one record (F500 G3). The run lived in four places — a drawer,
 * /review, /close and /checks — that didn't link to each other. Now
 * /payroll/runs/:id names the run, says how it stands and what it moved,
 * makes its next step the primary, and holds each part as a tab whose
 * address is the old page's address.
 */

let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string) => {
      const exact = routes[path];
      if (exact !== undefined) return exact;
      const base = path.split('?')[0]!;
      if (routes[base] !== undefined) return routes[base];
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { RunRecordPage } from '@/pages/payroll/RunRecordPage';
import { PayrollClosePage, openStep, type PayrollClose } from '@/pages/payroll/PayrollClosePage';
import { PayrollChecksPage } from '@/pages/payroll/PayrollChecksPage';
import { PayrollReviewsPage } from '@/pages/payroll/PayrollReviewsPage';

const RUN = 'run-1';
const detail = {
  id: RUN,
  payrollScheduleId: 'sch-1',
  payrollScheduleName: 'Biweekly — Seaside',
  clientId: null,
  clientName: null,
  periodStart: '2026-08-29',
  periodEnd: '2026-09-11',
  status: 'DISBURSED',
  totalGross: 4054.5,
  totalTax: 564.3,
  totalNet: 3490.2,
  totalEmployerTax: 310.18,
  itemCount: 1,
  notes: null,
  finalizedAt: '2026-09-17T15:00:00.000Z',
  disbursedAt: '2026-09-18T15:00:00.000Z',
  createdAt: '2026-09-15T15:00:00.000Z',
  kind: 'REGULAR',
  amendsRunId: null,
  amendmentReason: null,
  cancelledAt: null,
  cancelledById: null,
  cancelReason: null,
  payDate: '2026-09-18',
  reviewSignedAt: null,
  totalsAgree: true,
  nextStep: { key: 'deposit', label: 'Create the tax deposit', to: `/payroll/runs/${RUN}/close`, waitingOn: null },
  items: [
    {
      id: 'i1', payrollRunId: RUN, associateId: 'a1', associateName: 'Ana Ruiz', hoursWorked: 80, hourlyRate: 20, grossPay: 1600, federalWithholding: 120, fica: 99.2, medicare: 23.2, stateWithholding: 0, taxState: 'FL',
      ytdWages: 1600, ytdMedicareWages: 1600, employerFica: 99.2, employerMedicare: 23.2, employerFuta: 9.6, employerSuta: 4.8, netPay: 1357.6, postTaxDeductions: 0, status: 'DISBURSED', disbursementRef: null, disbursedAt: '2026-09-18T15:00:00.000Z', failureReason: null, earnings: [],
    },
  ],
};

function renderAt(path: string, element: React.ReactNode, pattern: string) {
  const caps = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'f@x.com', role: 'FINANCE_ACCOUNTANT', status: 'ACTIVE', clientId: null, associateId: null } as never, role: 'FINANCE_ACCOUNTANT', primaryRole: 'FINANCE_ACCOUNTANT', availableRoles: ['FINANCE_ACCOUNTANT'], capabilities: caps, tenant: DEFAULT_TENANT, signIn: vi.fn(), submitMfaChallenge: vi.fn(), signOut: vi.fn(), refreshUser: vi.fn(), switchRole: vi.fn(), can: (c: Capability) => caps.has(c) }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
              {pattern.includes(':tab') && <Route path="/payroll/runs/:id" element={element} />}
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

const close = (over: Partial<PayrollClose> = {}): PayrollClose =>
  ({
    run: { id: RUN, status: 'DISBURSED', kind: 'REGULAR', clientName: null, periodStart: '2026-08-29', periodEnd: '2026-09-11', totalGross: 4054.5, totalNet: 3490.2, totalEmployerTax: 310.18, finalizedAt: '2026-09-17T15:00:00Z', approvedAt: null, approvedByEmail: null, disbursedAt: '2026-09-18T15:00:00Z' },
    approvalRequired: true,
    review: { required: true, signedByName: null, signedAt: null, soleReviewer: false, staleSignedByName: null, staleSignedAt: null },
    items: { pending: 0, disbursed: 1, held: 0, failed: 0, voided: 0 },
    heldItems: [],
    paidItems: [],
    rerouted: 0,
    readiness: { missingW4: [], missingPayout: [], unverifiedPayout: [], unsupportedState: [] },
    exceptions: null,
    deposit: null,
    remittances: [],
    quickbooks: { connected: false, status: null, companyName: null },
    steps: [
      { key: 'readiness', label: 'Readiness', state: 'done', blockers: 0, warnings: 0, to: '/payroll/readiness' },
      { key: 'approve', label: 'Finalize', state: 'done', blockers: 0, warnings: 0, to: `/payroll?run=${RUN}` },
      { key: 'review', label: 'Review and sign off', state: 'done', blockers: 0, warnings: 0, to: `/payroll/runs/${RUN}/review` },
      { key: 'disburse', label: 'Disburse', state: 'done', blockers: 0, warnings: 0, to: `/payroll?run=${RUN}` },
      { key: 'deposits', label: 'Tax deposit', state: 'warn', blockers: 0, warnings: 0, to: '/payroll/taxes?tab=deposits' },
    ],
    ...over,
  }) as unknown as PayrollClose;

beforeEach(() => {
  routes = {};
});

describe('the run record', () => {
  it('names the run, its facts and its next step as the primary; each part is a tab', async () => {
    routes = { [`/payroll/runs/${RUN}`]: detail };
    renderAt(`/payroll/runs/${RUN}`, <RunRecordPage />, '/payroll/runs/:id/:tab');
    expect(await screen.findByRole('heading', { level: 1, name: 'Aug 29 – Sep 11, 2026 run' })).toBeInTheDocument();
    // Facts in the header (and the money again on Overview's tiles).
    expect(screen.getAllByText('$4,054.50').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$564.30').length).toBeGreaterThan(0);
    expect(screen.getByText('Fri, Sep 18, 2026')).toBeInTheDocument();
    const next = screen.getByRole('link', { name: /Create the tax deposit/ });
    expect(next).toHaveAttribute('href', `/payroll/runs/${RUN}/close`);
    for (const tab of ['Overview', 'Paychecks', 'Review', 'Close', 'Paper checks', 'Confirmations']) expect(screen.getByRole('tab', { name: new RegExp(tab) })).toBeInTheDocument();
    // A paid run with no sign-off on record: the stepper says so.
    expect(screen.getByText('No sign-off')).toBeInTheDocument();
  });

  it('the old /close address opens the Close tab', async () => {
    routes = { [`/payroll/runs/${RUN}`]: detail, [`/payroll/runs/${RUN}/close`]: close() };
    renderAt(`/payroll/runs/${RUN}/close`, <RunRecordPage />, '/payroll/runs/:id/:tab');
    expect(await screen.findByRole('tab', { name: 'Close', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Close steps' })).toBeInTheDocument();
  });

  it('Paychecks lists every paycheck in the run', async () => {
    routes = { [`/payroll/runs/${RUN}`]: detail };
    renderAt(`/payroll/runs/${RUN}/paychecks`, <RunRecordPage />, '/payroll/runs/:id/:tab');
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.getAllByText('$1,357.60').length).toBeGreaterThan(0);
  });
});

describe('the guided close', () => {
  it('the step that needs a look is the primary, even when it is only a warning', () => {
    expect(openStep(close().steps)?.key).toBe('deposits');
    expect(openStep(close({ steps: [{ key: 'a', label: 'A', state: 'warn', blockers: 0, warnings: 1, to: '/a' }, { key: 'b', label: 'B', state: 'blocked', blockers: 1, warnings: 0, to: '/b' }] } as never).steps)?.key).toBe('b');
  });

  it('a paid run’s unsigned review reads "Skipped", finished steps are one line, and the step title is the link', async () => {
    routes = { [`/payroll/runs/${RUN}/close`]: close() };
    renderAt(`/payroll/runs/${RUN}/close`, <PayrollClosePage />, '/payroll/runs/:id/close');
    const steps = await screen.findByRole('list', { name: 'Close steps' });
    expect(within(steps).getByText('Skipped')).toBeInTheDocument();
    expect(within(steps).getByText('Paid out with no sign-off on record.')).toBeInTheDocument();
    // Finished: a line with when it finished.
    expect(within(steps).getByText('Finalized Sep 17, 2026')).toBeInTheDocument();
    expect(within(steps).getByText(/Paid Sep 18, 2026/)).toBeInTheDocument();
    // No "Open" under every step: the title is the link.
    expect(within(steps).queryByRole('link', { name: 'Open' })).toBeNull();
    expect(within(steps).getByRole('link', { name: '5. Tax deposit' })).toHaveAttribute('href', '/payroll/taxes?tab=deposits');
    // The header primary is the step that needs a look.
    expect(screen.getByRole('link', { name: /^Tax deposit/ })).toHaveAttribute('href', '/payroll/taxes?tab=deposits');
    // The run's numbers as tiles, not a line of small text.
    expect(screen.getByRole('group', { name: 'Run totals' })).toBeInTheDocument();
  });
});

describe('paper checks', () => {
  const checks = (over: Record<string, unknown>) => ({
    run: { id: RUN, status: 'DISBURSED', kind: 'REGULAR', periodStart: '2026-08-29', periodEnd: '2026-09-11' },
    checks: [],
    overrides: [],
    requests: [],
    settings: { ready: false, gaps: ['No bank account chosen to draw checks on'] },
    ...over,
  });

  it('a run with no paper checks raises no red setup alarm', async () => {
    routes = { [`/payroll/runs/${RUN}/checks`]: checks({}) };
    renderAt(`/payroll/runs/${RUN}/checks`, <PayrollChecksPage />, '/payroll/runs/:id/checks');
    expect(await screen.findByText('No paper checks in this run')).toBeInTheDocument();
    expect(screen.queryByText('Set up check printing first')).toBeNull();
  });

  it('with a check to print, the setup gaps are said', async () => {
    routes = { [`/payroll/runs/${RUN}/checks`]: checks({ overrides: [{ itemId: 'i1', name: 'Ana Ruiz', reason: 'Asked', source: 'PAYROLL' }] }) };
    renderAt(`/payroll/runs/${RUN}/checks`, <PayrollChecksPage />, '/payroll/runs/:id/checks');
    expect(await screen.findByText('Set up check printing first')).toBeInTheDocument();
  });
});

describe('payroll to review', () => {
  it('keeps a record of runs paid without a sign-off', async () => {
    routes = {
      '/payroll/reviews': { waiting: [], recent: [] },
      '/payroll/runs': { runs: [{ ...detail, items: undefined }] },
    };
    renderAt('/payroll/review?all=1', <PayrollReviewsPage />, '/payroll/review');
    const list = await screen.findByRole('list', { name: 'Paid without a sign-off' });
    expect(within(list).getByRole('link', { name: /Aug 29, 2026 – Sep 11, 2026/ })).toHaveAttribute('href', `/payroll/runs/${RUN}/review`);
  });
});
