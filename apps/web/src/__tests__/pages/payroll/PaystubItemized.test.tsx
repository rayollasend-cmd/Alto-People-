import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { PayrollItem } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

const getMyPayrollItemYtd = vi.fn();
vi.mock('@/lib/payrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollApi')>()),
  getMyPayrollItemYtd: (...a: unknown[]) => getMyPayrollItemYtd(...a),
}));

import { PaystubCard } from '@/pages/payroll/AssociatePayrollView';

const item: PayrollItem = {
  id: '11111111-1111-4111-8111-111111111111',
  payrollRunId: '22222222-2222-4222-8222-222222222222',
  associateId: '33333333-3333-4333-8333-333333333333',
  associateName: 'Pat Kowalski',
  hoursWorked: 40,
  hourlyRate: 20,
  grossPay: 800,
  federalWithholding: 40,
  fica: 44.95,
  medicare: 10.51,
  stateWithholding: 22.26,
  taxState: 'PA',
  ytdWages: 0,
  ytdMedicareWages: 0,
  employerFica: 44.95,
  employerMedicare: 10.51,
  employerFuta: 4.35,
  employerSuta: 20,
  netPay: 477.28,
  preTaxDeductions: 175,
  preTaxRetirement: 100,
  postTaxDeductions: 30,
  status: 'DISBURSED',
  disbursementRef: null,
  disbursedAt: '2026-04-24T15:00:00.000Z',
  failureReason: null,
  earnings: [],
  deductions: [
    { key: 'RET_401K|e1', code: 'RET_401K', category: 'PRE_TAX', label: '401(k)', employeeAmount: 100, employerAmount: 0 },
    { key: 'MEDICAL|e2', code: 'MEDICAL', category: 'PRE_TAX', label: 'Medical', employeeAmount: 50, employerAmount: 0 },
    { key: 'HSA|e3', code: 'HSA', category: 'PRE_TAX', label: 'HSA', employeeAmount: 25, employerAmount: 0 },
    { key: 'GARNISHMENT|g1', code: 'GARNISHMENT', category: 'POST_TAX', label: 'Child support — case CS9 (PA SDU)', employeeAmount: 30, employerAmount: 0 },
    { key: 'ER_HEALTH|e2', code: 'ER_HEALTH', category: 'EMPLOYER', label: 'Employer health coverage', employeeAmount: 0, employerAmount: 200 },
  ],
};

describe('the paystub, itemized', () => {
  it('lists each deduction with its own YTD, pre-tax first, and what the employer paid on top', async () => {
    getMyPayrollItemYtd.mockResolvedValue({
      year: 2026, paystubCount: 3, gross: 2400, federalWithholding: 120, fica: 134.85, medicare: 31.53, stateWithholding: 66.78,
      preTaxDeductions: 525, postTaxDeductions: 90, netPay: 1431.84, employerFica: 134.85, employerMedicare: 31.53, employerFuta: 13.05, employerSuta: 60,
      byKind: {}, transport: 0,
      deductions: { 'RET_401K|e1': { employee: 300, employer: 0 }, 'MEDICAL|e2': { employee: 150, employer: 0 }, 'HSA|e3': { employee: 75, employer: 0 }, 'GARNISHMENT|g1': { employee: 90, employer: 0 }, 'ER_HEALTH|e2': { employee: 0, employer: 600 } },
    });
    renderAs('ASSOCIATE', <PaystubCard item={item} expanded onToggle={() => {}} onAsk={() => {}} />, '/payroll', { associateId: item.associateId });
    const row = async (label: string) => (await screen.findByText(label)).closest('tr')!;
    expect(within(await row('401(k) (pre-tax)')).getByText('−$300.00')).toBeInTheDocument();
    expect(within(await row('Medical (pre-tax)')).getByText('−$50.00')).toBeInTheDocument();
    expect(within(await row('Child support — case CS9 (PA SDU)')).getByText('−$90.00')).toBeInTheDocument();
    expect(within(await row('Employer health coverage')).getByText('$600.00')).toBeInTheDocument();
    // Total deductions now include the pre-tax lines, so the stub adds up to net.
    expect(within(await row('Total deductions')).getByText('−$322.72')).toBeInTheDocument();
  });
});
