import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollExceptionsResponse, PayrollItem } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * Payroll click savers: the pre-flight list fixes things in place (opens
 * itself when something blocks, approves clean time for the people it
 * names, Fix links carry the run's period), and a paystub link opens
 * that paystub.
 */

const listAdminTimeEntries = vi.fn();
const bulkApproveTimeEntries = vi.fn();
vi.mock('@/lib/timeApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/timeApi')>()),
  listAdminTimeEntries: (...a: unknown[]) => listAdminTimeEntries(...a),
  bulkApproveTimeEntries: (...a: unknown[]) => bulkApproveTimeEntries(...a),
}));

const listMyPayrollItems = vi.fn();
const getMyPayrollItemYtd = vi.fn();
vi.mock('@/lib/payrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollApi')>()),
  listMyPayrollItems: () => listMyPayrollItems(),
  getMyPayrollItemYtd: (...a: unknown[]) => getMyPayrollItemYtd(...a),
}));

vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  // Everything else on the pay page (next payday, cards) is out of reach here.
  return { ...real, apiFetch: vi.fn(async () => Promise.reject(new real.ApiError(403, 'forbidden', 'no'))) };
});

import { ExceptionStrip, fixHref } from '@/pages/payroll/PayrollExceptionStrip';
import { AssociatePayrollView } from '@/pages/payroll/AssociatePayrollView';

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const PERIOD = { start: '2026-10-03', end: '2026-10-16' };

const exceptions = (blocking: boolean): PayrollExceptionsResponse => ({
  exceptions: [
    { associateId: ANA, associateName: 'Ana Reyes', kind: 'UNAPPROVED_TIME', severity: 'WARNING', message: '6.0 unapproved hours in this period.', detail: {} },
    ...(blocking ? [{ associateId: BEN, associateName: 'Ben Ode', kind: 'MISSING_W4' as const, severity: 'BLOCKING' as const, message: 'No W-4 on file.', detail: {} }] : []),
  ],
  counts: { blocking: blocking ? 1 : 0, warning: 1, info: 0 },
});

beforeEach(() => {
  listAdminTimeEntries.mockReset();
  bulkApproveTimeEntries.mockReset();
  getMyPayrollItemYtd.mockReset();
  listMyPayrollItems.mockReset();
});

describe('the pre-flight list', () => {
  it('opens on its own when something blocks, and each Fix link lands with the period', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ExceptionStrip exceptions={exceptions(true)} loading={false} paychecks={2} period={PERIOD} />, '/payroll');
    expect(screen.getByRole('button', { name: /1 blocking issue/ })).toHaveAttribute('aria-expanded', 'true');
    const fixes = screen.getAllByRole('link', { name: /Fix/ });
    expect(fixes[0]).toHaveAttribute('href', `/time-attendance?tab=queue&associate=${ANA}&name=Ana+Reyes&from=2026-10-03&to=2026-10-16`);
    expect(fixes[1]).toHaveAttribute('href', `/people/${BEN}?tab=pay`);
  });

  it('stays folded when nothing blocks', () => {
    renderAs('FINANCE_ACCOUNTANT', <ExceptionStrip exceptions={exceptions(false)} loading={false} paychecks={2} period={PERIOD} />, '/payroll');
    expect(screen.getByRole('button', { name: /1 issue to review/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('approves the clean time for the people it names — flagged entries and other people stay', async () => {
    listAdminTimeEntries.mockResolvedValue({
      truncated: false,
      entries: [
        { id: 'e-clean', associateId: ANA, status: 'COMPLETED', anomalies: [] },
        { id: 'e-flag', associateId: ANA, status: 'COMPLETED', anomalies: ['NO_BREAK'] },
        { id: 'e-other', associateId: BEN, status: 'COMPLETED', anomalies: [] },
      ],
    });
    bulkApproveTimeEntries.mockResolvedValue({ succeeded: 1, failed: 0, results: [] });
    const approved = vi.fn();
    renderAs('FINANCE_ACCOUNTANT', <ExceptionStrip exceptions={exceptions(true)} loading={false} paychecks={2} period={PERIOD} onTimeApproved={approved} />, '/payroll');
    await userEvent.click(screen.getByRole('button', { name: /Approve clean time for this person/ }));
    await waitFor(() => expect(approved).toHaveBeenCalled());
    expect(listAdminTimeEntries).toHaveBeenCalledWith({ status: 'COMPLETED', from: '2026-10-03', to: '2026-10-17' });
    expect(bulkApproveTimeEntries).toHaveBeenCalledWith({ entryIds: ['e-clean'] });
  });

  it('sends each kind of problem to the page that fixes it', () => {
    const ex = (kind: string) => ({ associateId: ANA, associateName: 'Ana Reyes', kind, severity: 'BLOCKING', message: '', detail: {} }) as never;
    expect(fixHref(ex('TERMINATED_IN_RUN'))).toBe(`/people/${ANA}?tab=employment`);
    expect(fixHref(ex('UNSUPPORTED_STATE'))).toBe('/payroll/state-tax');
    expect(fixHref(ex('UNAPPROVED_TIME'))).toBe(`/time-attendance?tab=queue&associate=${ANA}&name=Ana+Reyes`);
  });
});

const stub = (id: string, disbursedAt: string, net: number): PayrollItem =>
  ({
    id,
    payrollRunId: 'r',
    associateId: 'a1',
    associateName: 'Pat',
    hoursWorked: 40,
    hourlyRate: 20,
    grossPay: 800,
    federalWithholding: 40,
    fica: 49.6,
    medicare: 11.6,
    stateWithholding: 20,
    taxState: 'FL',
    ytdWages: 0,
    ytdMedicareWages: 0,
    employerFica: 0,
    employerMedicare: 0,
    employerFuta: 0,
    employerSuta: 0,
    netPay: net,
    preTaxDeductions: 0,
    preTaxRetirement: 0,
    postTaxDeductions: 0,
    status: 'DISBURSED',
    disbursementRef: null,
    disbursedAt,
    failureReason: null,
    earnings: [],
    deductions: [],
  }) as PayrollItem;

describe('my pay', () => {
  const ytd = { year: 2026, paystubCount: 3, gross: 2400, federalWithholding: 120, fica: 148.8, medicare: 34.8, stateWithholding: 60, preTaxDeductions: 0, postTaxDeductions: 0, netPay: 2036.4, employerFica: 0, employerMedicare: 0, employerFuta: 0, employerSuta: 0, byKind: {}, transport: 0, deductions: {} };
  const items = [stub('s3', '2026-10-16T15:00:00.000Z', 678.8), stub('s2', '2026-10-02T15:00:00.000Z', 678.8), stub('s1', '2026-09-18T15:00:00.000Z', 678.8)];

  it('opens the newest paystub, shows where it went, and the recent take-home trend', async () => {
    listMyPayrollItems.mockResolvedValue({ items });
    getMyPayrollItemYtd.mockResolvedValue(ytd);
    renderAs('ASSOCIATE', <AssociatePayrollView />, '/payroll', { associateId: 'a1' });
    await waitFor(() => expect(getMyPayrollItemYtd).toHaveBeenCalledWith('s3'));
    const split = await screen.findByRole('region', { name: 'Where this check went' });
    expect(within(split).getByText('Take-home')).toBeInTheDocument();
    expect(within(split).getByText('$678.80')).toBeInTheDocument();
    expect(screen.getByText('Your recent checks')).toBeInTheDocument();
    expect(getMyPayrollItemYtd).toHaveBeenCalledTimes(1);
  });

  it('?item= opens that paystub instead', async () => {
    listMyPayrollItems.mockResolvedValue({ items });
    getMyPayrollItemYtd.mockResolvedValue(ytd);
    renderAs('ASSOCIATE', <AssociatePayrollView />, '/payroll?item=s1', { associateId: 'a1' });
    await waitFor(() => expect(getMyPayrollItemYtd).toHaveBeenCalledWith('s1'));
    expect(getMyPayrollItemYtd).not.toHaveBeenCalledWith('s3');
  });
});
