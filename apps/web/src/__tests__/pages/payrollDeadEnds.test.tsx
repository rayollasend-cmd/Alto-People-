import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { renderAs } from './hrPack/harness';

const getW4EstimatorContext = vi.fn();
const listPayrollRuns = vi.fn();
vi.mock('@/lib/payExpApi', () => ({
  getW4EstimatorContext: () => getW4EstimatorContext(),
  estimateMyW4: vi.fn(),
  getPayChecks: vi.fn(),
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
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('pay checks opened without a run offers the recent runs', async () => {
    listPayrollRuns.mockResolvedValue({
      runs: [
        { id: 'r1', periodStart: '2026-09-26', periodEnd: '2026-10-09', status: 'FINALIZED', clientName: 'Coastal', itemCount: 42 },
        { id: 'r0', periodStart: '2026-09-12', periodEnd: '2026-09-25', status: 'CANCELLED', clientName: null, itemCount: 0 },
      ],
    });
    renderAs('HR_ADMINISTRATOR', <PayChecksPage />, '/payroll/pay-checks');
    const link = await screen.findByRole('link', { name: /Coastal · 42 paychecks/ });
    expect(link).toHaveAttribute('href', '/payroll/pay-checks?run=r1');
    expect(screen.getAllByRole('link', { name: /paychecks/ })).toHaveLength(1);
  });
});
