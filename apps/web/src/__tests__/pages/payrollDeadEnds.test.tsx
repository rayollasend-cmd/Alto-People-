import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { renderAs } from './hrPack/harness';

const getW4EstimatorContext = vi.fn();
const listPayrollRuns = vi.fn();
const getPayChecks = vi.fn();
vi.mock('@/lib/payExpApi', () => ({
  getW4EstimatorContext: () => getW4EstimatorContext(),
  estimateMyW4: vi.fn(),
  getPayChecks: (id: string) => getPayChecks(id),
  resolvePayCheckFlags: vi.fn(),
}));
vi.mock('@/lib/payrollApi', () => ({ updateMyW4: vi.fn(), listPayrollRuns: () => listPayrollRuns() }));

import { W4Estimator } from '@/pages/payroll/W4Estimator';
import { PayChecksPage } from '@/pages/payroll/PayChecksPage';

describe('payroll pages never dead-end', () => {
  it('an office account with no worker record is told why, not "couldn’t load"', async () => {
    getW4EstimatorContext.mockRejectedValue(new ApiError(403, 'no_associate_record', 'Only a worker has their own pay.'));
    renderAs('HR_ADMINISTRATOR', <W4Estimator />, '/payroll/w4-estimator');
    expect(await screen.findByText('This is for people on payroll')).toBeInTheDocument();
    expect(screen.queryByText(/worker record/)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('the withholding check asks four questions first; the rest waits behind “More about your situation”', async () => {
    getW4EstimatorContext.mockResolvedValue({ payFrequency: 'BIWEEKLY', payPerPeriod: 1200, periodsRemaining: 5, ytdWages: 24000, ytdFederalWithheld: 1800, current: null });
    renderAs('ASSOCIATE', <W4Estimator />, '/payroll/w4-estimator', { associateId: 'a1' });
    expect(await screen.findByLabelText('Filing status')).toBeVisible();
    expect(screen.getByLabelText('Pay per check, before taxes')).toBeVisible();
    expect(screen.getByLabelText('Checks left this year')).toBeVisible();
    expect(screen.getByLabelText('Children under 17')).toBeVisible();
    // Paid and withheld so far come from the paychecks, said once in a sentence.
    expect(screen.getByTestId('w4est-so-far')).toHaveTextContent('So far this year: $24,000.00 paid, $1,800.00 federal tax withheld.');
    const more = screen.getByText('More about your situation').closest('details')!;
    expect(more).not.toHaveAttribute('open');
    expect(screen.getByLabelText(/Another job or a working spouse/)).not.toBeVisible();
    expect(screen.getByLabelText('Other dependents')).not.toBeVisible();
  });

  it('opens “More” by itself when the W-4 on file has other income, so it isn’t hidden', async () => {
    getW4EstimatorContext.mockResolvedValue({ payFrequency: 'BIWEEKLY', payPerPeriod: 1200, periodsRemaining: 5, ytdWages: 0, ytdFederalWithheld: 0, current: { filingStatus: 'SINGLE', multipleJobs: false, dependentsAmount: 0, otherIncome: 900, deductions: 0, extraWithholding: 0 } });
    renderAs('ASSOCIATE', <W4Estimator />, '/payroll/w4-estimator', { associateId: 'a1' });
    await screen.findByLabelText('Filing status');
    await waitFor(() => expect(screen.getByText('More about your situation').closest('details')).toHaveAttribute('open'));
    expect(screen.queryByTestId('w4est-so-far')).toBeNull();
  });

  it('paycheck confirmations opened without a run opens the run still open', async () => {
    listPayrollRuns.mockResolvedValue({
      runs: [
        { id: 'r1', periodStart: '2026-09-26', periodEnd: '2026-10-09', status: 'FINALIZED', clientName: 'Coastal', itemCount: 42 },
        { id: 'r0', periodStart: '2026-09-12', periodEnd: '2026-09-25', status: 'CANCELLED', clientName: null, itemCount: 0 },
      ],
    });
    getPayChecks.mockResolvedValue({ run: { periodStart: '2026-09-26', periodEnd: '2026-10-09' }, people: 0, confirmed: 0, flagged: 0, openFlags: 0, unanswered: 0, confirmationRate: 0, open: [] });
    renderAs('HR_ADMINISTRATOR', <PayChecksPage />, '/payroll/pay-checks');
    await waitFor(() => expect(getPayChecks).toHaveBeenCalledWith('r1'));
    // No one to confirm is said, never a fake "0%".
    expect(await screen.findByText('No one to confirm yet')).toBeInTheDocument();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('with no run open, it offers the recent runs', async () => {
    listPayrollRuns.mockResolvedValue({
      runs: [
        { id: 'r2', periodStart: '2026-09-26', periodEnd: '2026-10-09', status: 'DISBURSED', clientName: 'Coastal', itemCount: 42 },
        { id: 'r0', periodStart: '2026-09-12', periodEnd: '2026-09-25', status: 'CANCELLED', clientName: null, itemCount: 0 },
      ],
    });
    renderAs('HR_ADMINISTRATOR', <PayChecksPage />, '/payroll/pay-checks');
    const link = await screen.findByRole('link', { name: /Coastal · 42 paychecks/ });
    expect(link).toHaveAttribute('href', '/payroll/pay-checks?run=r2');
    expect(screen.getAllByRole('link', { name: /paychecks/ })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Paycheck confirmations' })).toBeInTheDocument();
  });
});
