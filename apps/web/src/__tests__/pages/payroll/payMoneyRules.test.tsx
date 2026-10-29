import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ROLE_CAPABILITIES, type Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';
import { ConfirmProvider } from '@/lib/confirm';
import { renderAs } from '../hrPack/harness';

/**
 * Payroll's money rules (deep audit 2026-10-29, builder PAY):
 *   MONEY-10/21  every money-moving button confirms with the amount, the account or agency, and the date
 *   MONEY-13     a closed run's stepper is all ticks; Overview carries the review's money summary
 *   MONEY-12     taxes withheld include state programs and local tax, and each paycheck row adds up
 *   MONEY-28     the next deposit is everything due that day, never "paid up" while it's owed
 *   CODE-29      a failed add-ons read is an error, not "no add-ons"
 *   CODE-3/21    a run whose bank file waits for its upload offers no second Disburse, and the toast
 *                says what happened
 */

type Call = { path: string; method: string; body: unknown; headers?: Record<string, string> };
const calls: Call[] = [];
let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body, headers: init?.headers });
      const key = `${method} ${path.split('?')[0]}`;
      const hit = `${method} ${path}` in routes ? routes[`${method} ${path}`] : key in routes ? routes[key] : undefined;
      if (hit instanceof Error) throw hit;
      if (hit !== undefined) return hit;
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { ApiError } from '@/lib/api';
import { RunStatusStepper } from '@/components/payroll/RunStatusStepper';
import { moneyConfirmLines, accountName } from '@/components/payroll/MoneyConfirm';
import { RunFundingCard } from '@/pages/payrollBanking/FundingCard';
import { FUNDING_LABEL } from '@/lib/bankingApi';
import { requestEarnedWage } from '@/lib/earnedWageApi';
import { PayrollTaxesDesk, nextDepositSummary, nextDepositHint } from '@/pages/payrollTaxes/PayrollTaxesDesk';
import { RunRecordPage, paycheckTaxes, paycheckDeductions, runTaxesWithheld } from '@/pages/payroll/RunRecordPage';
import { AdminPayrollView, DraftAddOnsSection } from '@/pages/payroll/AdminPayrollView';
import { bulkDisburseMessage, disburseOutcome, retryMessage, waitsOnBankUpload } from '@/pages/payroll/disburseOutcome';

const RUN = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

const posts = (prefix: string) => calls.filter((c) => c.method === 'POST' && c.path.startsWith(prefix));

/* ----- MONEY-10: Pull funds confirms with the amount, the account and the settle date ----------- */

const funding = {
  id: 'f1',
  payrollRunId: RUN,
  status: 'NOT_STARTED',
  amountCents: 3549365,
  breakdown: { netPayCents: 3000000, achPeople: 12, otherRailNetCents: 0, taxesCents: 549365, garnishmentsCents: 0, feesCents: 0 },
  payDate: '2026-10-30',
  debitEffectiveDate: '2026-10-28',
  fundingDeadline: '2026-10-27T21:00:00.000Z',
  achSpeed: 'NEXT_DAY',
  bankAccountId: null,
  approvalRequestId: null,
  submittedAt: null,
  settledAt: null,
  returnCode: null,
  returnReason: null,
  returnedAt: null,
  note: null,
};

describe('Pull funds (MONEY-10)', () => {
  it('opens a confirm naming the amount, the account and the settle date, and pulls nothing until confirmed', async () => {
    routes = {
      [`GET /payroll-banking/runs/${RUN}/funding`]: { applies: true, funding },
      'GET /payroll-banking/summary': {
        profile: { bankRail: 'ACH', fundingAccountId: 'acct-1', gaps: [] },
        connection: null,
        accounts: [{ id: 'acct-1', label: 'Operating', bankName: 'First Bank', accountLast4: '1234', routingNumber: '0', accountType: 'CHECKING', status: 'VERIFIED' }],
        runs: [],
        openReturns: 0,
        sameDayWindows: [],
      },
      [`POST /payroll-banking/runs/${RUN}/funding`]: { funding: { ...funding, status: 'SUBMITTED' } },
    };
    renderAs('FINANCE_ACCOUNTANT', <RunFundingCard runId={RUN} runFinalized />);
    const pull = await screen.findByRole('button', { name: 'Pull $35,493.65' });
    await waitFor(() => expect(calls.some((c) => c.path === '/payroll-banking/summary')).toBe(true));
    fireEvent.click(pull);
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Pull payroll funds?')).toBeInTheDocument();
    const facts = within(dialog).getByTestId('money-confirm-facts');
    expect(facts).toHaveTextContent('$35,493.65');
    await waitFor(() => expect(within(dialog).getByTestId('money-confirm-facts')).toHaveTextContent('Operating at First Bank ····1234'));
    expect(facts).toHaveTextContent(/Settles/);
    expect(posts('/payroll-banking')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByText('Pull payroll funds?')).toBeNull());
    expect(posts('/payroll-banking')).toHaveLength(0);
    // Confirmed: now it pulls, once.
    fireEvent.click(screen.getByRole('button', { name: 'Pull $35,493.65' }));
    const again = await screen.findByText('Pull payroll funds?');
    fireEvent.click(within(again.closest('[role="alertdialog"],[role="dialog"]') as HTMLElement).getByRole('button', { name: 'Pull $35,493.65' }));
    await waitFor(() => expect(posts(`/payroll-banking/runs/${RUN}/funding`)).toHaveLength(1));
  });

  it('a pull being sent right now reads "Being pulled" and offers no second Pull', async () => {
    expect(FUNDING_LABEL.SUBMITTING).toBe('Being pulled');
    routes = { [`GET /payroll-banking/runs/${RUN}/funding`]: { applies: true, funding: { ...funding, status: 'SUBMITTING' } } };
    renderAs('FINANCE_ACCOUNTANT', <RunFundingCard runId={RUN} runFinalized />);
    expect(await screen.findByText('Being pulled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pull/ })).toBeNull();
  });

  it('the confirm lines name the amount first, then the route', () => {
    expect(moneyConfirmLines({ amount: 12.5, from: 'Operating ····1234', to: 'IRS', when: 'Today' })).toEqual([
      { label: 'Amount', value: '$12.50' },
      { label: 'From', value: 'Operating ····1234' },
      { label: 'To', value: 'IRS' },
      { label: 'When', value: 'Today' },
    ]);
    expect(accountName({ label: 'Operating', bankName: 'First Bank', accountLast4: '1234' })).toBe('Operating at First Bank ····1234');
    expect(accountName(null)).toBeNull();
  });
});

/* ----- CODE-10: an earned-wage advance carries one idempotency key per tap ---------------- */

describe('Earned-wage advance (CODE-10)', () => {
  it('sends an Idempotency-Key, a new one for each tap', async () => {
    routes = { 'POST /me/earned-wage': { id: 'x', status: 'PAID', amount: 50, fee: 0, failureReason: null } };
    await requestEarnedWage(50);
    await requestEarnedWage(50);
    const keys = posts('/me/earned-wage').map((c) => c.headers?.['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^ewa-/);
    expect(keys[0]).not.toBe(keys[1]);
    await requestEarnedWage(50, 'ewa-same');
    expect(posts('/me/earned-wage').at(-1)?.headers?.['Idempotency-Key']).toBe('ewa-same');
  });
});

/* ----- MONEY-21 + MONEY-28: the payroll taxes desk ---------------------------------------- */

const overview = (over: Record<string, unknown> = {}) => ({
  today: '2026-10-29',
  filing: { mode: 'PROVIDER', providerLabel: 'Check', penaltyGuarantee: false, environment: 'sandbox' },
  totals: { owedOpen: 2112.45, overdue: 0, dueSoon: 0, failedPayments: 0, openNotices: 0 },
  overdue: [],
  dueSoon: [],
  upcoming: [
    { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', agency: 'IRS', dueDate: '2027-02-01', amount: 384.09, liabilities: 1, scheduled: 0, accountId: null },
    { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', agency: 'Florida Department of Revenue', dueDate: '2027-02-01', amount: 1728.36, liabilities: 1, scheduled: 0, accountId: null },
  ],
  returns: { previous: { periodLabel: '2026-Q3', items: [] }, current: { periodLabel: '2026-Q4', items: [] } },
  registrations: [],
  noticesDue: [],
  quarter: { periodLabel: '2026-Q4', posted: 2112.45, deposited: 0 },
  hasLiabilities: true,
  unposted: { count: 0, amount: 0, runs: [] },
  ...over,
});

describe('Payroll taxes (MONEY-28, MONEY-21)', () => {
  it('the next deposit is everything due that day, and the desk never says "paid up" while it is owed', async () => {
    routes = { 'GET /payroll-taxes/overview': overview() };
    renderAs('FINANCE_ACCOUNTANT', <PayrollTaxesDesk />, '/payroll/taxes');
    expect(await screen.findByText('$2,112.45 to 2 agencies')).toBeInTheDocument();
    expect(screen.queryByText('You’re paid up')).toBeNull();
    expect(screen.getByText('Nothing due in the next 14 days')).toBeInTheDocument();
  });

  it('sums the API’s nextDeposit when it sends one, and the lines itself when it doesn’t', () => {
    const o = overview() as never;
    expect(nextDepositSummary(o)).toEqual({ dueDate: '2027-02-01', amount: 2112.45, agencies: ['IRS', 'Florida Department of Revenue'], lines: 2 });
    expect(nextDepositSummary({ ...(o as object), nextDeposit: null } as never)).toBeNull();
    expect(nextDepositHint({ dueDate: '2027-02-01', amount: 384.09, agencies: ['IRS'], lines: 1 })).toBe('$384.09 to IRS');
  });

  it('“Send again” on a failed provider payment confirms with the amount, the agency and why it failed', async () => {
    routes = {
      'GET /payroll-taxes/overview': overview(),
      'GET /payroll-taxes/payments': {
        payments: [
          { id: 'p1', kind: 'STATE_UNEMPLOYMENT', kindLabel: 'State unemployment', jurisdiction: 'FL', agency: 'Florida Department of Revenue', accountId: null, periodLabel: '2026-Q3', amount: 1728.36, dueDate: '2026-10-31', method: 'PROVIDER', status: 'FAILED', providerRef: null, confirmationNumber: null, submittedAt: null, paidAt: null, late: false, failureReason: 'The provider has no Florida account number', createdAt: '2026-10-20T00:00:00.000Z' },
        ],
      },
      'POST /payroll-taxes/payments/p1/retry': { payment: { id: 'p1', status: 'SUBMITTED' } },
    };
    renderAs('FINANCE_ACCOUNTANT', <PayrollTaxesDesk />, '/payroll/taxes?tab=deposits');
    fireEvent.click(await screen.findByRole('radio', { name: 'Payments' }).catch(() => screen.findByRole('button', { name: 'Payments' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Send again' }));
    const title = await screen.findByText('Send the Florida Department of Revenue payment again?');
    const dialog = title.closest('[role="alertdialog"],[role="dialog"]') as HTMLElement;
    const facts = within(dialog).getByTestId('money-confirm-facts');
    expect(facts).toHaveTextContent('$1,728.36');
    expect(facts).toHaveTextContent('Florida Department of Revenue');
    expect(facts).toHaveTextContent('The provider has no Florida account number');
    expect(posts('/payroll-taxes/payments/p1/retry')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send $1,728.36 again' }));
    await waitFor(() => expect(posts('/payroll-taxes/payments/p1/retry')).toHaveLength(1));
  });
});

/* ----- MONEY-13: a closed run's stepper ------------------------------------------------- */

describe('Run status stepper (MONEY-13)', () => {
  it('a fully closed run ticks every step and has no current step', () => {
    renderAs(
      'FINANCE_ACCOUNTANT',
      <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: '2026-09-17T15:00:00.000Z', nextStep: { key: 'done', label: 'Closed', to: '/payroll', waitingOn: null } }} signedOff />,
    );
    const stepper = screen.getByTestId('run-status-stepper');
    expect(within(stepper).queryByText('5')).toBeNull();
    expect(stepper.querySelector('[aria-current="step"]')).toBeNull();
    expect(stepper.querySelectorAll('svg').length).toBeGreaterThanOrEqual(5);
  });

  it('a paid run still owing its deposit sits on Paid', () => {
    renderAs('FINANCE_ACCOUNTANT', <RunStatusStepper status="DISBURSED" lifecycle={{ reviewSignedAt: '2026-09-17T15:00:00.000Z', nextStep: { key: 'deposit', label: 'Pay', to: '/x', waitingOn: null } }} signedOff />);
    expect(screen.getByTestId('run-status-stepper').querySelector('[aria-current="step"]')).toHaveTextContent('Paid');
  });
});

/* ----- MONEY-12 + MONEY-13: the run record ------------------------------------------------ */

const item = {
  id: 'i1', payrollRunId: RUN, associateId: 'a1', associateName: 'Ana Ruiz', hoursWorked: 80, hourlyRate: 20, grossPay: 1600, federalWithholding: 120, fica: 99.2, medicare: 23.2, stateWithholding: 40, taxState: 'CA',
  ytdWages: 1600, ytdMedicareWages: 1600, employerFica: 99.2, employerMedicare: 23.2, employerFuta: 9.6, employerSuta: 4.8,
  preTaxDeductions: 50, postTaxDeductions: 10, localWithholding: 0, reimbursementsTotal: 25, stateProgramTaxes: [{ code: 'CA_SDI', label: 'CA SDI', amount: 19.2 }],
  // 1600 − (120 + 99.2 + 23.2 + 40 + 19.2) − (50 + 10) + 25 = 1263.40
  netPay: 1263.4, status: 'DISBURSED', disbursementRef: null, disbursedAt: '2026-09-18T15:00:00.000Z', failureReason: null, earnings: [],
};
const detail = {
  id: RUN, payrollScheduleId: null, payrollScheduleName: null, clientId: null, clientName: null, periodStart: '2026-08-29', periodEnd: '2026-09-11', status: 'DISBURSED',
  totalGross: 1600, totalTax: 282.4, totalNet: 1263.4, totalEmployerTax: 136.8, itemCount: 1, notes: null, finalizedAt: '2026-09-17T15:00:00.000Z', disbursedAt: '2026-09-18T15:00:00.000Z',
  createdAt: '2026-09-15T15:00:00.000Z', kind: 'REGULAR', amendsRunId: null, amendmentReason: null, cancelledAt: null, cancelledById: null, cancelReason: null, payDate: '2026-09-18',
  reviewSignedAt: '2026-09-17T15:00:00.000Z', totalsAgree: true, nextStep: { key: 'done', label: 'Closed', to: `/payroll/runs/${RUN}/close`, waitingOn: null }, items: [item],
};
const review = {
  report: {
    rows: [{ itemId: 'i1', associateId: 'a1', name: 'Ana Ruiz', flags: ['NO_FEDERAL'] }],
    cash: { lines: [], total: 1450.2 },
    taxes: { employee: [{ key: 'fed', label: 'Federal', amount: 301.6 }], employer: [{ key: 'er', label: 'Employer', amount: 136.8 }], total: 438.4 },
    totals: { people: 1 },
  },
  signoff: { required: true, current: null, stale: null, history: [], canSign: false, cannotSignReason: null },
};

function renderRecord(path: string) {
  const caps = ROLE_CAPABILITIES.FINANCE_ACCOUNTANT;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthContext.Provider
        value={{ isInitializing: false, isOffline: false, user: { id: 'u', email: 'f@x.com', role: 'FINANCE_ACCOUNTANT', status: 'ACTIVE', clientId: null, associateId: null } as never, role: 'FINANCE_ACCOUNTANT', primaryRole: 'FINANCE_ACCOUNTANT', availableRoles: ['FINANCE_ACCOUNTANT'], capabilities: caps, tenant: DEFAULT_TENANT, signIn: vi.fn(), submitMfaChallenge: vi.fn(), signOut: vi.fn(), refreshUser: vi.fn(), switchRole: vi.fn(), can: (c: Capability) => caps.has(c) }}
      >
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/payroll/runs/:id/:tab" element={<RunRecordPage />} />
              <Route path="/payroll/runs/:id" element={<RunRecordPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe('The run record’s money (MONEY-12, MONEY-13)', () => {
  it('the header’s taxes withheld include state programs even where the stored total left them out; Overview shows cash required, taxes owed and paychecks to look at', async () => {
    routes = { [`GET /payroll/runs/${RUN}`]: detail, [`GET /payroll/runs/${RUN}/review`]: review };
    renderRecord(`/payroll/runs/${RUN}`);
    // 120 + 99.2 + 23.2 + 40 + 19.2 (CA SDI)
    expect((await screen.findAllByText('$301.60')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Cash required')).toBeInTheDocument();
    expect(screen.getByText('$1,450.20')).toBeInTheDocument();
    expect(screen.getByText('Taxes owed')).toBeInTheDocument();
    expect(screen.getByText('Paychecks to look at')).toBeInTheDocument();
    expect(screen.getByText(/Ana Ruiz: no federal income tax withheld/)).toBeInTheDocument();
    // Closed run: no step left current.
    expect(screen.getByTestId('run-status-stepper').querySelector('[aria-current="step"]')).toBeNull();
  });

  it('each paycheck row adds up: gross − taxes − deductions + reimbursements = net', () => {
    const taxes = paycheckTaxes(item as never);
    const deductions = paycheckDeductions(item as never);
    expect(taxes).toBe(301.6);
    expect(deductions).toBe(60);
    expect(Math.round((item.grossPay - taxes - deductions + item.reimbursementsTotal) * 100) / 100).toBe(item.netPay);
    expect(paycheckTaxes({ ...item, taxesTotal: 310 } as never)).toBe(310);
    // An older run's stored total left the programs out: the header sums the paychecks.
    expect(runTaxesWithheld({ ...detail, totalTax: 282.4 } as never)).toBe(301.6);
    // Totals that disagree, or no paychecks: the stored total, like every header fact.
    expect(runTaxesWithheld({ ...detail, totalTax: 282.4, totalsAgree: false } as never)).toBe(282.4);
    expect(runTaxesWithheld({ ...detail, totalTax: 282.4, items: [] } as never)).toBe(282.4);
  });

  it('the Paychecks tab has Taxes, Deductions and Reimbursements columns', async () => {
    routes = { [`GET /payroll/runs/${RUN}`]: detail };
    renderRecord(`/payroll/runs/${RUN}/paychecks`);
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    for (const h of ['Taxes', 'Deductions', 'Reimbursements']) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getAllByText('$301.60').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$60.00').length).toBeGreaterThan(0);
  });
});

/* ----- CODE-29: a failed add-ons read ---------------------------------------------------- */

describe('Run add-ons (CODE-29)', () => {
  it('a failed read says so and blocks adding, instead of reading as "no add-ons"', async () => {
    routes = { [`GET /payroll/runs/${RUN}/add-ons`]: new ApiError(500, 'server_error', 'Database unavailable') };
    renderAs('FINANCE_ACCOUNTANT', <DraftAddOnsSection runId={RUN} runItems={[]} onChanged={() => undefined} />);
    expect(await screen.findByText(/Couldn.t load the extra earnings already on this run/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add line/ })).toBeDisabled();
  });
});

/* ----- CODE-3 / CODE-21: the in-house bank file ----------------------------------------- */

const waiting = { key: 'uploadFile', label: 'Upload the bank file, then mark it uploaded', to: '/payroll/banking?tab=files', waitingOn: null } as const;

describe('Disburse on the in-house bank file (CODE-3, CODE-21)', () => {
  it('a run whose file waits for the upload shows that, with no Disburse button', async () => {
    const run = { ...detail, status: 'FINALIZED', disbursedAt: null, nextStep: waiting, items: [{ ...item, status: 'PENDING', disbursedAt: null }] };
    routes = {
      'GET /payroll/runs': { runs: [run] },
      [`GET /payroll/runs/${RUN}`]: run,
      'GET /payroll/config': { requireSecondApproval: false },
      'GET /payroll/upcoming': { nextRun: null, lastRun: null, bySchedule: [] },
      [`GET /payroll-banking/runs/${RUN}/funding`]: { applies: false, funding: null },
      [`GET /payroll/runs/${RUN}/review/status`]: { fingerprint: 'x', signoff: { required: false, current: null, stale: null, history: [], canSign: true, cannotSignReason: null } },
    };
    renderAs('FINANCE_ACCOUNTANT', <AdminPayrollView canProcess canVoid={false} />, `/payroll?run=${RUN}&status=ALL`);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('link', { name: /Waiting for the bank upload/ })).toHaveAttribute('href', '/payroll/banking?tab=files');
    expect(within(drawer).queryByRole('button', { name: /^Disburse/ })).toBeNull();
  });

  it('the toast follows what happened: paid, a file waiting for the bank, or paychecks held', () => {
    expect(disburseOutcome({ status: 'DISBURSED', items: [] } as never)).toMatchObject({ tone: 'success', message: 'Run disbursed.' });
    const queued = disburseOutcome({ status: 'FINALIZED', nextStep: waiting, items: [{ status: 'PENDING' }, { status: 'PENDING' }] } as never);
    expect(queued.waitingOnBank).toBe(true);
    expect(queued.message).toMatch(/^The bank file is ready for 2 paychecks\. Nobody is paid until/);
    expect(queued.message).not.toMatch(/disbursed/i);
    expect(disburseOutcome({ status: 'FINALIZED', items: [{ status: 'HELD' }, { status: 'DISBURSED' }] } as never)).toMatchObject({ tone: 'error', message: 'Not paid in full yet: 1 paycheck held.' });
    expect(waitsOnBankUpload({ status: 'FINALIZED', nextStep: waiting })).toBe(true);
    expect(waitsOnBankUpload({ status: 'DISBURSED', nextStep: waiting })).toBe(false);
    expect(bulkDisburseMessage([{ status: 'DISBURSED', items: [] }, { status: 'FINALIZED', nextStep: waiting, items: [{ status: 'PENDING' }] }] as never, 1, 0)).toEqual({
      tone: 'error',
      message: 'Disburse: 1 paid · 1 waiting for the bank upload · 1 failed.',
    });
    expect(retryMessage({ retried: 3, succeeded: 0, awaitingBankUpload: 3 }).message).toMatch(/^3 paychecks went into a new bank file\./);
    expect(retryMessage({ retried: 3, succeeded: 0, awaitingBankUpload: 3 }).message).not.toMatch(/paid\./);
    expect(retryMessage({ retried: 2, succeeded: 1 })).toEqual({ tone: 'error', message: 'Retried 2: 1 paid, 1 failed again.' });
  });
});

/* ----- The rule, held in code: money-moving calls sit behind a money confirm -------------- */

describe('Every money-moving button confirms with the amount (MONEY-10/21 rule)', () => {
  // A call that moves money (or releases it) → the file must confirm it with useMoneyConfirm, or be listed
  // here with the dialog that already names the amount.
  const MONEY_CALLS = ['pullFunding(', 'retryTaxPayment(', 'createTaxPayment(', 'retryRunFailures(', 'disbursePayrollRun(', 'runDailyPayNow('];
  const CEREMONIES: Record<string, string> = {
    // The disburse ceremony: "Disburse $X" in its own dialog with the facts (DisburseFacts).
    'payroll/AdminPayrollView.tsx|disbursePayrollRun(': 'disburse ceremony',
    // "Pay <agency>" dialog: the amount and the due date, then "Start payment".
    'payrollTaxes/PayrollTaxesDesk.tsx|createTaxPayment(': 'PayDepositDialog + money confirm on Pay selected',
  };
  const root = join(__dirname, '../../../pages');
  const files = ['payroll', 'payrollBanking', 'payrollTaxes'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `${dir}/${f}`),
  );

  it.each(files)('%s', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    for (const call of MONEY_CALLS) {
      if (!src.includes(call) || src.includes(`export const ${call.slice(0, -1)}`)) continue;
      const covered = src.includes('useMoneyConfirm(') || CEREMONIES[`${file}|${call}`] !== undefined;
      expect(covered, `${file} calls ${call.slice(0, -1)} without a money confirm`).toBe(true);
    }
  });
});
