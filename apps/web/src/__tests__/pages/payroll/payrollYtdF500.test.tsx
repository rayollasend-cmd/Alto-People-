import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * Year-to-date (F500 G3): a paid run with no paychecks behind its totals
 * read as "$0 · No disbursed paystubs" while the runs list showed it; the
 * "FICA" columns held Social Security alone; there were two search boxes;
 * the year was a number box in the header.
 */
const getPayrollYtd = vi.fn();
vi.mock('@/lib/payrollApi', async (orig) => ({ ...(await orig<typeof import('@/lib/payrollApi')>()), getPayrollYtd: (y: number) => getPayrollYtd(y) }));

import { PayrollYtd } from '@/pages/payroll/PayrollYtd';

const EMPTY = { taxYear: 2026, totals: { gross: 0, fit: 0, fica: 0, medicare: 0, sit: 0, preTax: 0, postTax: 0, net: 0, associateCount: 0, paystubCount: 0 }, rows: [], monthly: [] };

describe('Year-to-date payroll', () => {
  it('says which paid run isn’t in the numbers, with a link to it', async () => {
    getPayrollYtd.mockResolvedValue({ ...EMPTY, notInReport: [{ id: 'r1', periodStart: '2026-08-29', periodEnd: '2026-09-11', totalGross: 4054.5, totalNet: 3490.2, paychecks: 0 }] });
    renderAs('FINANCE_ACCOUNTANT', <PayrollYtd />, '/payroll/ytd');
    const alert = await screen.findByTestId('ytd-not-in-report');
    expect(alert).toHaveTextContent('1 paid run isn’t in these numbers: it records $4,054.50 gross with no paychecks.');
    expect(within(alert).getByRole('link', { name: 'Aug 29 – Sep 11, 2026 run' })).toHaveAttribute('href', '/payroll/runs/r1');
  });

  it('labels Social Security as Social Security, and the year is the picker in the filter row', async () => {
    getPayrollYtd.mockResolvedValue({
      ...EMPTY,
      totals: { ...EMPTY.totals, gross: 800, fica: 49.6, associateCount: 1, paystubCount: 1 },
      rows: [{ associateId: 'a1', firstName: 'Maria', lastName: 'Lopez', email: 'm@example.com', employmentType: 'W2_EMPLOYEE', gross: 800, fit: 60, fica: 49.6, medicare: 11.6, sit: 0, preTax: 0, postTax: 0, net: 678.8, paystubCount: 1 }],
    });
    renderAs('FINANCE_ACCOUNTANT', <PayrollYtd />, '/payroll/ytd?year=2025');
    await waitFor(() => expect(getPayrollYtd).toHaveBeenCalledWith(2025));
    expect(await screen.findAllByText('Social Security')).not.toHaveLength(0);
    expect(screen.queryByText('FICA')).toBeNull();
    expect(screen.queryByText('FIT')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Tax year' }) as HTMLSelectElement).value).toBe('2025');
    // One search: the grid's.
    expect(screen.getAllByRole('searchbox').length + screen.queryAllByPlaceholderText(/Search by name/).length).toBeGreaterThan(0);
    expect(screen.queryAllByPlaceholderText('Search by name or email…')).toHaveLength(0);
  });
});
