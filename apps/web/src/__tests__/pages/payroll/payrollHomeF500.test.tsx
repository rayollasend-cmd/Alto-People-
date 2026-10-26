import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * The payroll home at the F500 bar (G3): what needs this desk in one card,
 * one primary for running payroll, the runs as one section whose status
 * filter is in the URL, a run drawer that opens the run's own page, and a
 * run wizard whose first step asks only what it must.
 */

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body });
      const key = `${method} ${path.split('?')[0]}`;
      if (`${method} ${path}` in routes) return routes[`${method} ${path}`];
      if (key in routes) return routes[key];
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { AdminPayrollView } from '@/pages/payroll/AdminPayrollView';
import { RunPayrollWizard } from '@/pages/payroll/RunPayrollWizard';
import { payrollNeeds } from '@/pages/payroll/PayrollNeedsYou';
import { RunStatusStepper } from '@/components/payroll/RunStatusStepper';

const RUN = '77777777-7777-4777-8777-777777777777';
const SCH = '11111111-1111-4111-8111-111111111111';

const paidRun = {
  id: RUN,
  payrollScheduleId: null,
  payrollScheduleName: null,
  clientId: null,
  clientName: null,
  periodStart: '2026-08-29',
  periodEnd: '2026-09-11',
  status: 'DISBURSED',
  totalGross: 4054.5,
  totalTax: 564.3,
  totalNet: 3490.2,
  totalEmployerTax: 0,
  itemCount: 0,
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
  payDate: null,
  reviewSignedAt: null,
  totalsAgree: false,
  itemsGross: 0,
  itemsNet: 0,
  paychecks: 0,
  nextStep: { key: 'deposit', label: 'Create the tax deposit', to: `/payroll/runs/${RUN}/close`, waitingOn: null },
};

const WISE_401 = {
  provider: 'WISE',
  health: 'erroring',
  detail: 'x',
  lastEventAt: '2026-10-15T01:48:34.398Z',
  minutesSinceLastEvent: 1,
  eventsLast24h: 0,
  errorsLast7d: 1,
  pendingFinalizedItems: 0,
  latestError: { at: '2026-10-17T18:48:34.398Z', eventType: 'connection', notes: 'Wise refused the token (HTTP 401): Invalid token' },
};

const INBOX = {
  total: 13,
  sources: [
    { key: 'timesheets', label: 'Timesheets to approve', description: 'x', count: 6, path: '/time-attendance?tab=queue', urgency: 'routine', dueAt: null },
    { key: 'payroll-missed-paydays', label: 'Paydays with no run', description: '2 paydays passed with no run.', count: 2, path: '/payroll?ledger=missed', urgency: 'money', dueAt: null },
    { key: 'pay-schedule-unassigned', label: 'People on no pay schedule', description: 'Hired people no pay schedule covers. No payroll run will pay them until a rule, the company default or a person puts them on one.', count: 10, path: '/payroll/schedules?view=unassigned', urgency: 'routine', dueAt: null },
    { key: 'financial-changes', label: 'Pay account changes to verify', description: 'x', count: 0, path: '/payroll/financial-changes', urgency: 'money', dueAt: null },
    { key: 'payroll-funding', label: 'Payroll funding', description: 'x', count: 3, path: '/payroll/banking', urgency: 'money', dueAt: null, watching: true },
  ],
};

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe('Needs you', () => {
  it('lists what stops money first, each with its count and the list behind it', () => {
    const needs = payrollNeeds({
      payout: WISE_401,
      runs: [paidRun as never],
      inbox: INBOX.sources,
      readiness: { missingCount: 10 },
      garnishments: { eiwoToReview: 1, remittancesPending: 0 },
    });
    expect(needs.map((n) => [n.key, n.count ?? null, n.title, n.to])).toEqual([
      ['payouts', null, 'Payouts can’t go out', '/payroll/banking'],
      // Its totals and paychecks disagree: on hold, said as that — not "Create the tax deposit" (F500 audit 2026-10-26).
      [`run:${RUN}`, null, 'Totals and paychecks disagree', `/payroll/runs/${RUN}`],
      ['inbox:payroll-missed-paydays', 2, 'Paydays with no run', '/payroll?ledger=missed'],
      ['readiness', 10, 'People who can’t be paid yet', '/payroll/readiness'],
      ['eiwo', 1, 'e-IWO order to answer', '/payroll/garnishments?tab=eiwo'],
      ['inbox:pay-schedule-unassigned', 10, 'People on no pay schedule', '/payroll/schedules?view=unassigned'],
    ]);
    expect(needs[0]!.detail).toBe('Wise rejected our sign-in on Oct 17, 2026.');
    expect(needs[1]!.detail).toBe('Aug 29 – Sep 11, 2026 run · nothing moves until they agree');
    expect(needs[1]!.tone).toBe('alert');
    // A queue another desk owns, a zero count and a non-payroll queue are left out.
    expect(needs.some((n) => n.key.includes('payroll-funding') || n.key.includes('financial-changes') || n.key.includes('timesheets'))).toBe(false);
  });

  it('is empty when nothing waits', () => {
    expect(payrollNeeds({ payout: { ...WISE_401, health: 'healthy' }, runs: [{ ...paidRun, totalsAgree: true, nextStep: { ...paidRun.nextStep, key: 'done' } } as never], inbox: [], readiness: { missingCount: 0 }, garnishments: { eiwoToReview: 0, remittancesPending: 0 } })).toEqual([]);
  });
});

function homeRoutes() {
  routes = {
    'GET /payroll/runs': { runs: [paidRun] },
    'GET /payroll/disbursement/webhook-status': WISE_401,
    'GET /me/inbox': INBOX,
    'GET /payroll/readiness': { total: 10, readyCount: 0, missingCount: 10, rows: [] },
    'GET /garnishment-desk': { orders: [], totals: { active: 0, eiwoToReview: 1, remittancesPending: 0, remittancesPendingAmount: 0, overdue: 0 }, stateRules: [], levyYears: [], rejectReasons: [] },
    'GET /payroll/upcoming': { nextRun: null, lastRun: null, bySchedule: [] },
    [`GET /payroll/runs/${RUN}`]: { ...paidRun, items: [] },
    'GET /payroll/config': { requireSecondApproval: false },
  };
}

describe('Payroll home', () => {
  it('shows what needs the desk, before the hero', async () => {
    homeRoutes();
    renderAs('FINANCE_ACCOUNTANT', <AdminPayrollView canProcess canVoid={false} />, '/payroll');
    const card = await screen.findByTestId('payroll-needs-you');
    await waitFor(() => expect(within(card).getAllByRole('link')).toHaveLength(6));
    expect(within(card).getByRole('link', { name: /Payouts can’t go out/ })).toHaveAttribute('href', '/payroll/banking');
    expect(within(card).getByRole('link', { name: /Totals and paychecks disagree/ })).toHaveAttribute('href', `/payroll/runs/${RUN}`);
    expect(within(card).queryByRole('link', { name: /Create the tax deposit/ })).toBeNull();
  });

  it('one primary to run payroll: the header offers an off-cycle run, the sibling desks are links, and there are no tabs', async () => {
    homeRoutes();
    renderAs('FINANCE_ACCOUNTANT', <AdminPayrollView canProcess canVoid={false} />, '/payroll');
    expect(await screen.findByRole('button', { name: /Off-cycle run/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^New run$/ })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('link', { name: 'Garnishments' })).toHaveAttribute('href', '/payroll/garnishments');
    expect(screen.getByRole('link', { name: 'Pay schedules' })).toHaveAttribute('href', '/payroll/schedules');
  });

  it('the status filter lives in the URL: ?status=DISBURSED asks for paid runs and marks that chip', async () => {
    homeRoutes();
    renderAs('FINANCE_ACCOUNTANT', <AdminPayrollView canProcess canVoid={false} />, '/payroll?status=DISBURSED');
    await waitFor(() => expect(calls.some((c) => c.path === '/payroll/runs?status=DISBURSED')).toBe(true));
    expect(await screen.findByRole('button', { name: 'Paid', pressed: true })).toBeInTheDocument();
  });

  it('the run drawer opens the run’s own page, keeps a paid run’s report, and never ticks a sign-off that isn’t on record', async () => {
    homeRoutes();
    renderAs('FINANCE_ACCOUNTANT', <AdminPayrollView canProcess canVoid={false} />, `/payroll?run=${RUN}&status=ALL`);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('link', { name: /Open run/ })).toHaveAttribute('href', `/payroll/runs/${RUN}`);
    expect(within(drawer).getByRole('link', { name: /Review report/ })).toHaveAttribute('href', `/payroll/runs/${RUN}/review`);
    expect(within(drawer).getByText('No sign-off')).toBeInTheDocument();
  });
});

describe('Run status stepper', () => {
  it('a paid run with a sign-off on record ticks it', () => {
    renderAs('FINANCE_ACCOUNTANT', <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: '2026-09-17T15:00:00.000Z', nextStep: { key: 'done', label: 'Done', to: '/payroll', waitingOn: null } }} signedOff={false} />);
    expect(screen.getByText('Signed off')).toBeInTheDocument();
    expect(screen.queryByText('No sign-off')).toBeNull();
  });

  it('a paid run with none says so instead of a tick', () => {
    renderAs('FINANCE_ACCOUNTANT', <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: null, nextStep: undefined }} signedOff={false} />);
    expect(screen.getByText('No sign-off')).toBeInTheDocument();
  });

  it('where no sign-off is required, the step says so in the quiet colour, not as a warning', () => {
    renderAs('FINANCE_ACCOUNTANT', <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: null, nextStep: undefined }} signedOff={false} signoffRequired={false} />);
    expect(screen.queryByText('No sign-off')).toBeNull();
    expect(screen.getByText('Not required')).toBeInTheDocument();
  });

  it('a run whose totals and paychecks disagree is on hold: no next step that moves money or files taxes', () => {
    renderAs(
      'FINANCE_ACCOUNTANT',
      <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: null, totalsAgree: false, nextStep: { key: 'deposit', label: 'Create the tax deposit', to: '/payroll', waitingOn: null } }} signedOff={false} />,
    );
    expect(screen.getByTestId('run-on-hold')).toHaveTextContent('On hold: the totals and the paychecks disagree.');
    expect(screen.queryByText('Create the tax deposit')).toBeNull();
  });
});

describe('Run payroll wizard, step 1', () => {
  const schedule = {
    id: SCH, clientId: null, clientName: null, name: 'Biweekly — Seaside', frequency: 'BIWEEKLY', anchorDate: '2026-12-19', payDateOffsetDays: 7, isActive: true, notes: null, associateCount: 3,
    nextPeriodStart: '2027-01-02', nextPeriodEnd: '2027-01-15', nextPayDate: '2027-01-22', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('picks the only schedule, asks no fallback rate up front, and names who has no rate with a fix', async () => {
    routes = {
      'GET /payroll/schedules': { schedules: [schedule] },
      'POST /payroll/runs/exceptions': {
        exceptions: [{ associateId: 'a1', associateName: 'Ana Ruiz', kind: 'MISSING_COMP_RECORD', severity: 'WARNING', message: 'No compensation record' }],
        counts: { blocking: 0, warning: 1, info: 0 },
      },
    };
    renderAs('FINANCE_ACCOUNTANT', <RunPayrollWizard open onOpenChange={() => {}} onCreated={() => {}} seed={null} />, '/payroll');
    expect(await screen.findByText('Step 1 of 4: Pick schedule + period')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Biweekly — Seaside' })).toBeChecked());
    const note = await screen.findByTestId('wizard-no-rate');
    expect(note).toHaveTextContent('1 person has no hourly rate on file.');
    expect(within(note).getByRole('link', { name: 'Fix Ana Ruiz' })).toBeInTheDocument();
    // The fallback rate is behind "Advanced", not a prime field.
    expect(screen.queryByLabelText('Default hourly rate')).toBeNull();
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByLabelText('Fallback hourly rate')).toBeInTheDocument();
  });

  it('“Off-cycle run” opens on Off-cycle, not on a regular run', async () => {
    routes = { 'GET /payroll/schedules': { schedules: [schedule] } };
    renderAs('FINANCE_ACCOUNTANT', <RunPayrollWizard open onOpenChange={() => {}} onCreated={() => {}} seed={null} initialKind="OFF_CYCLE" />, '/payroll');
    expect(await screen.findByText('Step 1 of 4: Pick schedule + period')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Off-cycle/ })).toBeChecked());
    expect(screen.getByRole('radio', { name: /^Regular/ })).not.toBeChecked();
  });
});
