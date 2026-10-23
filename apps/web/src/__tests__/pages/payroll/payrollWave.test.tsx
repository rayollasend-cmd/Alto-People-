import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollRunPreviewResponse } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * The payroll wave on screen (audit 2026-10-21 + finance walk): paydays with
 * no run and "Pay these hours now", changes vs last run, the disburse
 * dialog's facts, the Pay tab for in-house payroll, the federal W-4 facts,
 * the pay-change context, readiness requests, the deposit on the close
 * step, and the executive money band.
 */

const desk = {
  getPeriodLedger: vi.fn(),
  getDisbursePreview: vi.fn(),
  getPaySummary: vi.fn(),
  getFederalW4: vi.fn(),
  saveFederalW4: vi.fn(),
  getPayChangeContext: vi.fn(),
  requestReadiness: vi.fn(),
  createRunTaxDeposit: vi.fn(),
  getExecutiveMoney: vi.fn(),
};
vi.mock('@/lib/payrollDeskApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollDeskApi')>()),
  getPeriodLedger: (...a: unknown[]) => desk.getPeriodLedger(...a),
  getDisbursePreview: (...a: unknown[]) => desk.getDisbursePreview(...a),
  getPaySummary: (...a: unknown[]) => desk.getPaySummary(...a),
  getFederalW4: (...a: unknown[]) => desk.getFederalW4(...a),
  saveFederalW4: (...a: unknown[]) => desk.saveFederalW4(...a),
  getPayChangeContext: (...a: unknown[]) => desk.getPayChangeContext(...a),
  requestReadiness: (...a: unknown[]) => desk.requestReadiness(...a),
  createRunTaxDeposit: (...a: unknown[]) => desk.createRunTaxDeposit(...a),
  getExecutiveMoney: (...a: unknown[]) => desk.getExecutiveMoney(...a),
}));
const getPayrollReadiness = vi.fn();
const markTaxDepositPaid = vi.fn();
vi.mock('@/lib/payrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollApi')>()),
  getPayrollReadiness: () => getPayrollReadiness(),
  markTaxDepositPaid: (...a: unknown[]) => markTaxDepositPaid(...a),
}));

import { MissedPaydaysStrip } from '@/pages/payroll/MissedPaydaysStrip';
import { ChangesVsLastRun } from '@/pages/payroll/ChangesVsLastRun';
import { DisburseFacts } from '@/pages/payroll/DisburseFacts';
import { PaySummaryCard } from '@/components/payroll/PaySummaryCard';
import { FederalW4Card } from '@/components/payroll/FederalW4Card';
import { PayChangeContextPanel } from '@/components/payroll/PayChangeContextPanel';
import { PayrollReadiness } from '@/pages/payroll/PayrollReadiness';
import { MoneyBand } from '@/pages/executive/MoneyBand';

beforeEach(() => {
  for (const f of Object.values(desk)) f.mockReset();
  getPayrollReadiness.mockReset();
  markTaxDepositPaid.mockReset();
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

describe('paydays with no run', () => {
  it('names the missed paydays and the hours, and "Pay these hours now" seeds an off-cycle run', async () => {
    desk.getPeriodLedger.mockResolvedValue({
      asOf: '2026-10-21',
      schedules: [
        {
          scheduleId: S,
          name: 'Biweekly',
          frequency: 'BIWEEKLY',
          clientId: null,
          periods: [
            { periodStart: '2026-08-29', periodEnd: '2026-09-11', payDate: '2026-09-18', status: 'PAID', runId: 'r1', runStatus: 'DISBURSED', runKind: 'REGULAR', unpaidHours: 0, unpaidPeople: 0 },
            { periodStart: '2026-09-12', periodEnd: '2026-09-25', payDate: '2026-10-02', status: 'MISSED', runId: null, runStatus: null, runKind: null, unpaidHours: 40.6, unpaidPeople: 3 },
            { periodStart: '2026-09-26', periodEnd: '2026-10-09', payDate: '2026-10-16', status: 'MISSED', runId: null, runStatus: null, runKind: null, unpaidHours: 0, unpaidPeople: 0 },
            { periodStart: '2026-10-10', periodEnd: '2026-10-23', payDate: '2026-10-30', status: 'DUE', runId: null, runStatus: null, runKind: null, unpaidHours: 0, unpaidPeople: 0 },
          ],
        },
      ],
      missed: { periods: 2, hours: 40.6, people: 3 },
      unpaid: [],
    });
    const onPay = vi.fn();
    renderAs('FINANCE_ACCOUNTANT', <MissedPaydaysStrip canProcess onPay={onPay} />);
    const region = await screen.findByRole('region', { name: 'Paydays with no run' });
    expect(region).toHaveTextContent('2 paydays had no run');
    expect(region).toHaveTextContent('40.6h approved and unpaid for 3 people');
    // The empty missed period says nothing is owed and offers the time queue; only the one with hours pays.
    expect(within(region).getAllByRole('button', { name: /Pay these hours now/ })).toHaveLength(1);
    expect(within(region).getByRole('link', { name: 'Check time in this period' })).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: /Pay these hours now/ }));
    expect(onPay).toHaveBeenCalledWith({ scheduleId: S, periodStart: '2026-09-12', periodEnd: '2026-09-25', missedPayday: true });
  });

  it('says nothing when every past payday has a run', async () => {
    desk.getPeriodLedger.mockResolvedValue({ asOf: '2026-10-21', schedules: [{ scheduleId: S, name: 'B', frequency: 'BIWEEKLY', clientId: null, periods: [] }], missed: { periods: 0, hours: 0, people: 0 }, unpaid: [] });
    const { container } = renderAs('FINANCE_ACCOUNTANT', <MissedPaydaysStrip canProcess onPay={vi.fn()} />);
    await waitFor(() => expect(desk.getPeriodLedger).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('changes vs last run, before the run exists', () => {
  it('shows who moved, who is new, who is missing, and a Δ per person', () => {
    const preview = {
      items: [
        { associateId: A, associateName: 'Ana Reyes', netPay: 600 },
        { associateId: B, associateName: 'Cy New', netPay: 80 },
      ],
      totals: { totalGross: 800, totalEmployeeTax: 120, totalNet: 680, totalEmployerTax: 60, totalGarnishments: 0, itemCount: 2 },
      previous: {
        runId: 'r0',
        periodStart: '2026-09-12',
        periodEnd: '2026-09-25',
        people: 2,
        gross: 400,
        net: 300,
        hours: 20,
        byAssociate: [
          { associateId: A, associateName: 'Ana Reyes', hours: 10, gross: 200, net: 156 },
          { associateId: 'x', associateName: 'Ben Ode', hours: 10, gross: 200, net: 144 },
        ],
        missing: [{ associateId: 'x', associateName: 'Ben Ode', net: 144 }],
        newPeople: [{ associateId: B, associateName: 'Cy New' }],
        moved: [{ associateId: A, associateName: 'Ana Reyes', netDelta: 444, netDeltaPct: 284.6 }],
      },
    } as unknown as PayrollRunPreviewResponse;
    renderAs('FINANCE_ACCOUNTANT', <ChangesVsLastRun preview={preview} />);
    const box = screen.getByRole('region', { name: 'Changes vs last run' });
    expect(box).toHaveTextContent('1 person moved >15%');
    expect(box).toHaveTextContent('1 new: Cy New');
    expect(box).toHaveTextContent('1 missing: Ben Ode');
    expect(box).toHaveTextContent('+$444.00');
    expect(box).toHaveTextContent('not in this run');
  });
});

describe('the disburse dialog', () => {
  it('an erroring payout provider blocks, with the two ways out; the split shows each method', () => {
    renderAs(
      'FINANCE_ACCOUNTANT',
      <DisburseFacts
        runId="r9"
        loading={false}
        data={{
          runId: 'r9',
          provider: { name: 'WISE', health: 'erroring', detail: 'The connection is failing: 401 Unauthorized.', blocked: true },
          split: [
            { method: 'DIRECT_DEPOSIT', count: 3, amount: 1200 },
            { method: 'CHECK', count: 1, amount: 300 },
          ],
          arrival: { payDate: '2026-10-30', arrivesOn: '2026-10-30', sameDay: false, cutoffEt: '16:00', submitBy: '2026-10-29', late: false },
          funding: { accountLabel: 'Operating', last4: '6789', status: 'SETTLED', amount: 1500 },
          nextStep: null,
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('WISE is failing');
    expect(screen.getByRole('link', { name: 'Fix in Payroll banking' })).toHaveAttribute('href', '/payroll/banking');
    expect(screen.getByRole('link', { name: 'Pay by paper check' })).toHaveAttribute('href', '/payroll/runs/r9/checks');
    expect(screen.getByText('Direct deposit · 3')).toBeInTheDocument();
    expect(screen.getByText('Paper check · 1')).toBeInTheDocument();
    expect(screen.getByText(/the file must reach the bank by 16:00 ET/)).toBeInTheDocument();
    expect(screen.getByText(/From Operating •••• 6789/)).toBeInTheDocument();
  });
});

describe('the Pay tab for in-house payroll', () => {
  it('shows the schedule, the pay account, the last paystubs and the year to date', async () => {
    desk.getPaySummary.mockResolvedValue({
      associateId: A,
      localTaxRuleId: null,
      schedule: { current: { scheduleId: S, name: 'Biweekly', pattern: 'Every other week, paid the next Friday', since: '2026-08-01', because: 'Rule' }, pending: null, ruleDefault: null, nextPayDate: '2026-10-30' },
      payAccount: { rail: 'BANK_ACCOUNT', last4: '4455', accountType: 'CHECKING', verified: true, prenoteStatus: null },
      paystubs: [{ itemId: 'i1', runId: 'r1', periodStart: '2026-09-12', periodEnd: '2026-09-25', runStatus: 'DISBURSED', runKind: 'REGULAR', status: 'DISBURSED', hours: 40, gross: 720, net: 610.5, paidAt: '2026-10-02T12:00:00Z' }],
      ytd: { year: 2026, paystubs: 9, gross: 6480, net: 5400, federalWithholding: 400, socialSecurity: 401.76, medicare: 93.96, stateWithholding: 0, localWithholding: 0, preTaxDeductions: 0, postTaxDeductions: 0 },
      externalPayments: 2,
    });
    renderAs('FINANCE_ACCOUNTANT', <PaySummaryCard associateId={A} />);
    expect(await screen.findByText('Biweekly')).toBeInTheDocument();
    expect(screen.getByText(/Next payday/)).toBeInTheDocument();
    expect(screen.getByTestId('pay-account')).toHaveTextContent('Direct deposit');
    expect(screen.getByTestId('pay-account')).toHaveTextContent('•••• 4455');
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Last paystubs' })).toHaveTextContent('$610.50');
    expect(screen.getByText('$6,480.00')).toBeInTheDocument();
  });
});

describe('federal W-4 facts', () => {
  it('records an IRS lock-in letter and saves it', async () => {
    const facts = { exempt: false, exemptTaxYear: null, nonresidentAlien: false, pre2020Allowances: null, lockIn: null, effective: { filingStatus: 'SINGLE', exempt: false, nonresidentAlien: false, pre2020Allowances: null, flags: [] } };
    desk.getFederalW4.mockResolvedValue(facts);
    desk.saveFederalW4.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({ ...facts, ...body }));
    renderAs('FINANCE_ACCOUNTANT', <FederalW4Card associateId={A} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Record a lock-in letter' }));
    await userEvent.selectOptions(screen.getByLabelText('Filing status the IRS set'), 'MARRIED_FILING_JOINTLY');
    await userEvent.click(screen.getByLabelText(/Nonresident alien/));
    await userEvent.click(screen.getByRole('button', { name: 'Save W-4 facts' }));
    await waitFor(() => expect(desk.saveFederalW4).toHaveBeenCalled());
    const [id, body] = desk.saveFederalW4.mock.calls[0]!;
    expect(id).toBe(A);
    expect(body).toMatchObject({ nonresidentAlien: true, lockIn: { filingStatus: 'MARRIED_FILING_JOINTLY', multipleJobs: false } });
  });
});

describe('a pay change with its context', () => {
  it('shows the band, the bill rate and margin, where it lands and the back pay', async () => {
    desk.getPayChangeContext.mockResolvedValue({
      associateId: A,
      current: { payType: 'HOURLY', amount: 18, effectiveFrom: '2026-08-01' },
      proposed: { payType: 'HOURLY', amount: 19.5, effectiveFrom: '2026-09-20' },
      deltaPct: 8.3,
      band: { name: 'Housekeeping', min: 16, mid: 19, max: 22, currentPct: 33.3, proposedPct: 58.3 },
      client: { id: 'c', name: 'Harbor Inn' },
      position: 'Housekeeper',
      billRate: 26,
      burdenPct: 12,
      marginBefore: 5.84,
      marginAfter: 4.16,
      landsIn: { scheduleName: 'Biweekly', periodStart: '2026-09-26', periodEnd: '2026-10-09', payDate: '2026-10-16' },
      backPay: { from: '2026-09-20', through: '2026-09-25', hours: 10, amount: 15 },
    });
    renderAs('HR_ADMINISTRATOR', <PayChangeContextPanel associateId={A} payType="HOURLY" amount={19.5} effectiveFrom="2026-09-20" />);
    const panel = await screen.findByLabelText('What this change means', {}, { timeout: 2000 });
    expect(panel).toHaveTextContent('33.3% → 58.3% of $16.00–$22.00');
    expect(panel).toHaveTextContent('$26.00/hr · Housekeeper');
    expect(panel).toHaveTextContent('$5.84 → $4.16');
    expect(panel).toHaveTextContent(/Lands in .* paid .*\$15\.00 back pay for 10h/);
  });
});

describe('readiness: one request to many people', () => {
  it('a column chip picks everyone missing it, and the request goes to all of them at once', async () => {
    const row = (id: string, name: string, flags: Partial<Record<string, boolean>>, requested: unknown = null) => ({
      associateId: id,
      firstName: name,
      lastName: 'Lane',
      email: `${name}@x.com`,
      employmentType: 'W2_EMPLOYEE',
      flags: { w4OnFile: true, taxStateSet: true, payoutMethodOnFile: true, payScheduleAssigned: true, userLinked: true, ...flags },
      ready: false,
      requested,
    });
    getPayrollReadiness.mockResolvedValue({
      total: 3,
      readyCount: 0,
      missingCount: 3,
      rows: [row(A, 'Ana', { w4OnFile: false }), row(B, 'Ben', { w4OnFile: false, payoutMethodOnFile: false }, { at: '2026-10-21T12:00:00Z', items: ['payout'] }), row(S, 'Cy', { payScheduleAssigned: false, userLinked: false })],
    });
    desk.requestReadiness.mockResolvedValue({ requested: 2, skipped: [] });
    renderAs('FINANCE_ACCOUNTANT', <PayrollReadiness />);
    const chips = await screen.findByLabelText('What is missing, by column');
    expect(chips).toHaveTextContent('W-4 missing 2');
    expect(chips).toHaveTextContent('Pay account 1');
    // One word over the column it filters: "Sign-in", not "No sign-in" over "User".
    expect(chips).toHaveTextContent('Sign-in 1');
    expect(chips).not.toHaveTextContent('No sign-in');
    expect(screen.getByText(/Requested Oct 21/)).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole('button', { name: /W-4 missing 2/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Request from 2' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send requests' }));
    await waitFor(() => expect(desk.requestReadiness).toHaveBeenCalled());
    const [ids, items] = desk.requestReadiness.mock.calls[0]!;
    expect([...(ids as string[])].sort()).toEqual([A, B].sort());
    expect(items).toEqual(expect.arrayContaining(['w4', 'payout']));
  });
});

describe('the executive money band', () => {
  it('shows cash, the low point, profit against budget and the last run, each linked to its desk', async () => {
    desk.getExecutiveMoney.mockResolvedValue({
      asOf: '2026-10-21',
      cash: { total: 48210.5, accounts: 2 },
      lowPoint: { weekStart: '2026-11-09', balance: 6120, belowMinimum: true, minimumCash: 10000 },
      profit: { month: '2026-10', mtdNetIncome: 3120, ytd: { actual: 41000, budget: 38000, variance: 3000 }, budgetName: 'FY26' },
      dso: [{ month: '2026-05', days: 31, paid: 4 }, { month: '2026-06', days: 28, paid: 5 }],
      payrollRuns: [{ runId: 'r1', periodStart: '2026-09-12', periodEnd: '2026-09-25', people: 22, gross: 9000, employerTaxes: 820, cost: 9820, costPerPerson: 446.36 }],
    });
    renderAs('EXECUTIVE_CHAIRMAN', <MoneyBand />);
    expect(await screen.findByText('$48,210.50')).toBeInTheDocument();
    expect(screen.getByText('$6,120.00')).toBeInTheDocument();
    expect(screen.getByText(/below the minimum/)).toBeInTheDocument();
    expect(screen.getByText('$3,120.00')).toBeInTheDocument();
    expect(screen.getByText('$9,820.00')).toBeInTheDocument();
    expect(screen.getByText('$48,210.50').closest('a')).toHaveAttribute('href', '/books');
    expect(screen.getByText('$6,120.00').closest('a')).toHaveAttribute('href', '/finance/cash-forecast');
  });
});
