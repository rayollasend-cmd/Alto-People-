import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * One home per concept (F500 G3): tax reference lived in three places and
 * year-end in four. Tax tables and Year-end are one page each now, with a
 * tab per part and one tax-year picker.
 */

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch }));

import { TaxTablesPage } from '@/pages/payroll/TaxTablesPage';
import { YearEndPage, defaultTaxYear } from '@/pages/payroll/YearEndPage';

const CONFIG = {
  year: 2026,
  ssWageBase: 184500,
  medicareSurchargeThreshold: 200000,
  fedBracketsSingle: [{ over: 0, flat: 0, rate: 0.1 }],
  fedBracketsMfj: [{ over: 0, flat: 0, rate: 0.1 }],
  fedBracketsHoh: [{ over: 0, flat: 0, rate: 0.1 }],
  updatedAt: '2026-09-18T12:00:00Z',
  requireSecondApproval: false,
};

beforeEach(() => {
  apiFetch.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/payroll/config')) return CONFIG;
    if (path.startsWith('/payroll/local-tax-rules')) return { rules: [] };
    if (path.startsWith('/payroll/year-end-close')) {
      return { taxYear: 2025, readyToClose: true, checks: [{ key: 'forms_filed', label: 'All generated forms filed', done: true, detail: 'Nothing to file for 2025.', href: '/payroll/year-end?tab=forms' }] };
    }
    return {};
  });
});

describe('Tax tables', () => {
  it('opens on Federal in plain words: who updates it, not a database migration', async () => {
    renderAs('FINANCE_ACCOUNTANT', <TaxTablesPage />, '/payroll/tax-tables');
    expect(await screen.findByText('Updated each January from the IRS tables. Last updated Sep 18, 2026.')).toBeInTheDocument();
    expect(screen.queryByText(/migration/i)).toBeNull();
    expect(screen.queryByText(/annualizes/i)).toBeNull();
    for (const tab of ['Federal', 'State', 'Local', 'Hand-set rules', 'Reciprocity']) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
  });

  it('adds a hand-set local rule in a dialog with empty fields — nothing that looks already saved', async () => {
    renderAs('FINANCE_ACCOUNTANT', <TaxTablesPage />, '/payroll/tax-tables?tab=rules');
    expect(await screen.findByText('No local rules set by hand')).toBeInTheDocument();
    // No always-open form on the page.
    expect(screen.queryByLabelText('City or county')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Add local rule/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    for (const label of ['State', 'City or county', 'Rate (%)']) {
      const input = within(dialog).getByLabelText(label) as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.placeholder ?? '').toBe('');
    }
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });
});

describe('Year-end', () => {
  it('opens on last year’s checklist, with one tax-year picker and the three parts as tabs', async () => {
    renderAs('FINANCE_ACCOUNTANT', <YearEndPage />, '/payroll/year-end');
    expect(await screen.findByText('Nothing to file for 2025.')).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Tax year' }) as HTMLSelectElement;
    expect(picker.value).toBe(String(defaultTaxYear()));
    for (const tab of ['Checklist', 'Reconcile', 'Forms']) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Checklist', selected: true })).toBeInTheDocument();
  });

  it('a ?year= link reads that year', async () => {
    renderAs('FINANCE_ACCOUNTANT', <YearEndPage />, '/payroll/year-end?year=2024');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/payroll/year-end-close?year=2024')));
  });

  it('defaultTaxYear is the year being closed', () => {
    expect(defaultTaxYear(new Date('2026-10-22T12:00:00Z'))).toBe(2025);
  });
});
