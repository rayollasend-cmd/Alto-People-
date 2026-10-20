import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { BudgetDetail, BudgetVsActual } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  listBudgets: vi.fn(),
  getBudget: vi.fn(),
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  deleteBudget: vi.fn(),
  saveBudgetLines: vi.fn(),
  budgetFromActuals: vi.fn(),
  getBudgetVsActual: vi.fn(),
  budgetVsActualXlsxUrl: (id: string) => `/api/books/budgets/${id}/vs-actual.xlsx`,
  listAccountOptions: vi.fn(),
}));
vi.mock('@/lib/books/closeApi', () => api);

import { BudgetsPage } from '@/pages/books/budgets/BudgetsPage';
import { BudgetDetailPage } from '@/pages/books/budgets/BudgetDetailPage';

/** Budgets: the list, the grid editor (a year total spreads evenly), and budget vs actual. */

const periods = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const budget = (o: Partial<BudgetDetail> = {}): BudgetDetail => ({
  id: 'b1',
  name: '2026 plan',
  fiscalYear: 2026,
  status: 'DRAFT',
  notes: null,
  totalIncome: 132000,
  totalExpense: 0,
  net: 132000,
  lineCount: 1,
  updatedAt: '2026-10-01T12:00:00.000Z',
  periods,
  lines: [{ accountId: 'rev', clientId: null, departmentId: null, months: Array(12).fill(11000), total: 132000 }],
  accounts: [
    { id: 'rev', code: '4000', name: 'Staffing services revenue', type: 'INCOME', subtype: 'INCOME' },
    { id: 'rent', code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE' },
  ],
  ...o,
});

const vs: BudgetVsActual = {
  budgetId: 'b1',
  fiscalYear: 2026,
  through: '2026-09',
  periods,
  monthsElapsed: 9,
  sections: [
    {
      key: 'income',
      label: 'Income',
      rows: [
        {
          accountId: 'rev',
          code: '4000',
          name: 'Staffing services revenue',
          section: 'income',
          months: periods.map(() => ({ budget: 11000, actual: 12000, variance: 1000, variancePct: 9.1 })),
          ytd: { budget: 99000, actual: 108000, variance: 9000, variancePct: 9.1, favorable: true },
          annualBudget: 132000,
          forecast: 141000,
          runRate: 144000,
        },
      ],
      ytd: { budget: 99000, actual: 108000, variance: 9000, variancePct: 9.1 },
      annualBudget: 132000,
      forecast: 141000,
      runRate: 144000,
    },
  ],
  netIncome: { ytd: { budget: 99000, actual: 108000, variance: 9000, variancePct: 9.1 }, annualBudget: 132000, forecast: 141000, runRate: 144000 },
};

const atBudget = () =>
  renderAs(
    'FINANCE_ACCOUNTANT',
    <Routes>
      <Route path="/books/budgets/:id" element={<BudgetDetailPage />} />
    </Routes>,
    '/books/budgets/b1',
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.listAccountOptions.mockResolvedValue({ accounts: [] });
});

describe('BudgetsPage', () => {
  it('lists budgets and starts a new one from last year’s actuals', async () => {
    api.listBudgets.mockResolvedValue({ budgets: [budget({ status: 'ACTIVE', fiscalYear: new Date().getFullYear() })] });
    api.createBudget.mockResolvedValue({ budget: budget({ id: 'b2' }) });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <BudgetsPage />, '/books/budgets');
    expect(await screen.findAllByText('2026 plan')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /New budget/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create budget' }));
    await waitFor(() => expect(api.createBudget).toHaveBeenCalledWith(expect.objectContaining({ fromActuals: { growthPct: 5 } })));
  });
});

describe('BudgetDetailPage', () => {
  it('a year total typed into a row spreads evenly; adding an account and saving sends the grid', async () => {
    api.getBudget.mockResolvedValue({ budget: budget() });
    api.saveBudgetLines.mockResolvedValue({ budget: budget() });
    const user = userEvent.setup();
    atBudget();
    await screen.findByRole('heading', { name: '2026 plan' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Add an account' }), 'rent');
    const total = screen.getByRole('textbox', { name: /6100 Rent, year total/ });
    await user.type(total, '24000');
    await user.tab();
    expect(screen.getByRole('textbox', { name: '6100 Rent, Jan' })).toHaveValue('2000');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save budget/ }));
    await waitFor(() =>
      expect(api.saveBudgetLines).toHaveBeenCalledWith('b1', {
        lines: [
          { accountId: 'rev', clientId: null, departmentId: null, months: Array(12).fill(11000) },
          { accountId: 'rent', clientId: null, departmentId: null, months: Array(12).fill(2000) },
        ],
      }),
    );
  });

  it('budget vs actual shows the variance, the forecast and the run rate', async () => {
    api.getBudget.mockResolvedValue({ budget: budget() });
    api.getBudgetVsActual.mockResolvedValue(vs);
    const user = userEvent.setup();
    atBudget();
    await screen.findByRole('heading', { name: '2026 plan' });
    await user.click(screen.getByRole('tab', { name: 'Budget vs actual' }));
    expect(await screen.findByText('Forecast to year end')).toBeInTheDocument();
    expect(screen.getAllByText('+$9,000.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$141,000.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Excel/ })).toHaveAttribute('href', expect.stringContaining('/books/budgets/b1/vs-actual.xlsx'));
  });
});
