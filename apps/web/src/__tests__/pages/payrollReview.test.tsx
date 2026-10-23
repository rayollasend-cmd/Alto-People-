import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { PayrollReviewReport, ReviewRow, ReviewState } from '@/lib/payrollReviewApi';
import { renderAs } from './hrPack/harness';

const getPayrollReview = vi.fn();
const signPayrollReview = vi.fn();
const getReviewQueue = vi.fn();
vi.mock('@/lib/payrollReviewApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollReviewApi')>()),
  getPayrollReview: (...a: unknown[]) => getPayrollReview(...a),
  signPayrollReview: (...a: unknown[]) => signPayrollReview(...a),
  getReviewQueue: () => getReviewQueue(),
}));

import { PayrollReviewPage } from '@/pages/payroll/PayrollReviewPage';
import { PayrollReviewsPage } from '@/pages/payroll/PayrollReviewsPage';

const row = (o: Partial<ReviewRow> & Pick<ReviewRow, 'itemId' | 'name' | 'net'>): ReviewRow => ({
  associateId: o.itemId,
  department: 'Housekeeping',
  state: 'FL',
  type: 'W2',
  hours: 30,
  rate: 20,
  gross: 600,
  preTax: 0,
  federal: 40,
  socialSecurity: 37.2,
  medicare: 8.7,
  stateTax: 0,
  localTax: 0,
  postTax: 0,
  other: 0,
  reimbursements: 0,
  employerTaxes: 50,
  prior: null,
  netChange: null,
  netChangeShare: null,
  flags: [],
  ...o,
});

const REPORT: PayrollReviewReport = {
  company: 'Alto HR',
  generatedAt: '2026-04-20T15:00:00Z',
  fingerprint: 'f'.repeat(64),
  run: { id: 'run1', status: 'FINALIZED', kind: 'REGULAR', clientName: 'Coastal', periodStart: '2026-04-13', periodEnd: '2026-04-19', createdByName: 'maker@example.com', createdAt: '2026-04-20T12:00:00Z', finalizedAt: '2026-04-20T13:00:00Z' },
  totals: { people: 2, contractors: 0, hours: 38, gross: 760, preTax: 0, employeeTaxes: 110, postTax: 0, other: 0, reimbursements: 0, net: 650, employerTaxes: 70, employerCost: 830 },
  cash: { lines: [{ key: 'net', label: 'Net pay to people', amount: 650 }, { key: 'employeeTaxes', label: 'Taxes withheld from pay', amount: 110 }, { key: 'employerTaxes', label: 'Employer taxes', amount: 70 }], total: 830 },
  taxes: { employee: [{ key: 'federal', label: 'Federal income tax', amount: 50 }], employer: [{ key: 'futa', label: 'Federal unemployment (FUTA)', amount: 5 }], total: 180 },
  byDepartment: [{ name: 'Housekeeping', people: 2, gross: 760, net: 650, employerTaxes: 70 }],
  byState: [{ name: 'FL', people: 2, gross: 760, net: 650, employerTaxes: 70 }],
  previous: { runId: 'run0', periodStart: '2026-04-06', periodEnd: '2026-04-12', people: 1, gross: 160, net: 140, employerTaxes: 12 },
  flagCounts: { NET_UP: 1, FIRST_PAYCHECK: 1 },
  rows: [
    row({ itemId: 'i1', name: 'Maria Lopez', net: 514.1, prior: { gross: 160, net: 139.76, periodEnd: '2026-04-12' }, netChange: 374.34, netChangeShare: 2.678, flags: ['NET_UP'] }),
    row({ itemId: 'i2', name: 'Sam Okafor', net: 135.9, gross: 160, flags: ['FIRST_PAYCHECK'] }),
  ],
};

const state = (o: Partial<ReviewState> = {}): ReviewState => ({ required: true, current: null, stale: null, history: [], canSign: true, cannotSignReason: null, ...o });

function renderReview() {
  return renderAs(
    'FINANCE_ACCOUNTANT',
    <Routes>
      <Route path="/payroll/runs/:id/review" element={<PayrollReviewPage />} />
    </Routes>,
    '/payroll/runs/run1/review',
  );
}

beforeEach(() => {
  getPayrollReview.mockReset();
  signPayrollReview.mockReset();
  getReviewQueue.mockReset();
});

describe('<PayrollReviewPage>', () => {
  it('a run with gross on record and no paychecks raises an alert; with nothing to check it says so, not "all clear"', async () => {
    const empty: PayrollReviewReport = { ...REPORT, run: { ...REPORT.run, storedGross: 4054.5 }, totals: { ...REPORT.totals, people: 0, gross: 0, net: 0 }, rows: [], flagCounts: {} };
    getPayrollReview.mockResolvedValue({ report: empty, signoff: state() });
    renderReview();
    expect(await screen.findByText(/records \$4,054\.50 gross but has no paychecks/)).toBeInTheDocument();
    expect(screen.getByText('Nothing to check')).toBeInTheDocument();
    expect(screen.queryByText('Nothing unusual')).not.toBeInTheDocument();
  });

  it('reads like a register: totals against last payroll, cash, taxes, and the paychecks that moved', async () => {
    getPayrollReview.mockResolvedValue({ report: REPORT, signoff: state() });
    renderReview();
    expect(await screen.findByText('Not signed off yet')).toBeInTheDocument();
    expect(screen.getByText('Total cash required')).toBeInTheDocument();
    expect(screen.getByText('Total taxes')).toBeInTheDocument();
    // Net went from $140 to $650: +$510 against last payroll.
    expect(screen.getByText(/\+\$510\.00/)).toBeInTheDocument();
    const lookAt = screen.getByText(/Paychecks to look at/).closest('div[class]')!.parentElement!;
    expect(within(lookAt).getByText('Net pay up sharply')).toBeInTheDocument();
    expect(within(lookAt).getByText('First paycheck')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /every paycheck/i })).toBeInTheDocument();
  });

  it('signs off only after the reviewer confirms, and sends the version they read', async () => {
    getPayrollReview.mockResolvedValue({ report: REPORT, signoff: state() });
    signPayrollReview.mockResolvedValue({ signoff: { id: 's1', signedByName: 'checker@example.com', signedAt: '2026-04-20T16:00:00Z', note: null, soleReviewer: false } });
    renderReview();
    const button = await screen.findByRole('button', { name: /sign off on these numbers/i });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /i reviewed these numbers/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /note for the record/i }), 'Tied out.');
    await userEvent.click(button);
    await waitFor(() => expect(signPayrollReview).toHaveBeenCalledWith('run1', { fingerprint: REPORT.fingerprint, note: 'Tied out.' }));
  });

  it('a stale sign-off says the numbers changed; the creator is told who signs instead', async () => {
    getPayrollReview.mockResolvedValue({
      report: REPORT,
      signoff: state({
        canSign: false,
        cannotSignReason: 'You created this run, so someone else who processes payroll signs off on it.',
        stale: { id: 's0', signedByName: 'checker@example.com', signedAt: '2026-04-20T14:00:00Z', note: null, soleReviewer: false },
        history: [{ id: 's0', signedByName: 'checker@example.com', signedAt: '2026-04-20T14:00:00Z', note: null, soleReviewer: false }],
      }),
    });
    renderReview();
    expect(await screen.findByRole('alert')).toHaveTextContent(/numbers changed after the sign-off/i);
    expect(screen.getByText('Numbers changed since')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign off on these numbers/i })).toBeNull();
    expect(screen.getByText(/someone else who processes payroll signs off/i)).toBeInTheDocument();
  });

  it('a signed run says who signed and offers no second sign-off', async () => {
    const s = { id: 's1', signedByName: 'checker@example.com', signedAt: '2026-04-20T16:00:00Z', note: 'Tied out.', soleReviewer: false };
    getPayrollReview.mockResolvedValue({ report: REPORT, signoff: state({ current: s, history: [s], canSign: false, cannotSignReason: 'These numbers are already signed off.' }) });
    renderReview();
    expect((await screen.findAllByText(/Signed off by checker@example.com/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('checkbox', { name: /i reviewed these numbers/i })).toBeNull();
    for (const l of screen.getAllByRole('link', { name: /guided close/i })) expect(l).toHaveAttribute('href', '/payroll/runs/run1/close');
  });
});

describe('<PayrollReviewsPage>', () => {
  it('lists the runs waiting on a sign-off, oldest first, each opening its report', async () => {
    getReviewQueue.mockResolvedValue({
      waiting: [
        { id: 'run1', status: 'FINALIZED', kind: 'REGULAR', clientName: 'Coastal', periodStart: '2026-04-13', periodEnd: '2026-04-19', people: 2, totalGross: 760, totalNet: 650, createdByName: 'maker@example.com', changedSinceSignoff: true },
        { id: 'run2', status: 'DRAFT', kind: 'REGULAR', clientName: 'Harbor', periodStart: '2026-04-13', periodEnd: '2026-04-19', people: 1, totalGross: 300, totalNet: 260, createdByName: 'maker@example.com', changedSinceSignoff: false },
      ],
      recent: [],
    });
    renderAs('FINANCE_ACCOUNTANT', <PayrollReviewsPage />, '/payroll/review');
    const link = await screen.findByRole('link', { name: /Coastal · 2 paychecks/ });
    expect(link).toHaveAttribute('href', '/payroll/runs/run1/review');
    expect(within(link).getByText('Changed since sign-off')).toBeInTheDocument();
  });

  it('one run waiting opens its report straight away', async () => {
    getReviewQueue.mockResolvedValue({
      waiting: [{ id: 'run1', status: 'FINALIZED', kind: 'REGULAR', clientName: 'Coastal', periodStart: '2026-04-13', periodEnd: '2026-04-19', people: 2, totalGross: 760, totalNet: 650, createdByName: 'maker@example.com', changedSinceSignoff: false }],
      recent: [],
    });
    renderAs(
      'FINANCE_ACCOUNTANT',
      <Routes>
        <Route path="/payroll/review" element={<PayrollReviewsPage />} />
        <Route path="/payroll/runs/:id/review" element={<p>the report for run1</p>} />
      </Routes>,
      '/payroll/review',
    );
    expect(await screen.findByText('the report for run1')).toBeInTheDocument();
  });
});

describe('after sign-off', () => {
  it('offers to pay the run, and the breadcrumb returns to the run', async () => {
    const s = { id: 's1', signedByName: 'checker@example.com', signedAt: '2026-04-20T16:00:00Z', note: null, soleReviewer: false };
    getPayrollReview.mockResolvedValue({ report: REPORT, signoff: state({ current: s, history: [s], canSign: false, cannotSignReason: 'These numbers are already signed off.' }) });
    renderReview();
    const pay = await screen.findByRole('link', { name: /Disburse \$650\.00/ });
    expect(pay).toHaveAttribute('href', '/payroll?run=run1&next=pay');
    // The trail names the run: Payroll › the run › Review (F500 G3).
    expect(screen.getByRole('link', { name: 'Run' })).toHaveAttribute('href', '/payroll/runs/run1');
    // The waterfall's table twin carries every step.
    expect(screen.getByRole('img', { name: /Gross pay \$760\.00 becomes net pay \$650\.00/ })).toBeInTheDocument();
  });
});
