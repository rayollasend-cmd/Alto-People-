import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { BooksOverview, BooksProfitAndLoss, LedgerAccountRow } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  BOOKS_KEY: ['books'],
  getBooksOverview: vi.fn(),
  getBooksDimensions: vi.fn(),
  listLedgerAccounts: vi.fn(),
  createLedgerAccount: vi.fn(),
  updateLedgerAccount: vi.fn(),
  deleteLedgerAccount: vi.fn(),
  getAccountDetail: vi.fn(),
  listJournal: vi.fn(),
  getJournalEntry: vi.fn(),
  postManualEntry: vi.fn(),
  voidJournalEntry: vi.fn(),
  getOpeningBalances: vi.fn(),
  postOpeningBalances: vi.fn(),
  getProfitAndLoss: vi.fn(),
  getBalanceSheet: vi.fn(),
  getCashFlow: vi.fn(),
  getTrialBalance: vi.fn(),
  downloadReport: vi.fn(),
}));
vi.mock('@/lib/books/ledgerApi', () => api);

import { BooksHome } from '@/pages/books/BooksHome';
import { BooksReportsPage } from '@/pages/books/reports/BooksReportsPage';
import { JournalEntryPage } from '@/pages/books/ledger/JournalEntryPage';
import { AccountsPage } from '@/pages/books/ledger/AccountsPage';

/**
 * The ledger's screens: the overview reads the money at a glance, the
 * statements open amounts to their accounts and download, a manual entry
 * posts only once it balances, and the chart of accounts guards the
 * accounts the automatic posting uses.
 */

const acct = (o: Partial<LedgerAccountRow>): LedgerAccountRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  code: '1000',
  name: 'Operating checking',
  type: 'ASSET',
  subtype: 'BANK',
  systemKey: 'CASH_OPERATING',
  parentId: null,
  description: null,
  isActive: true,
  balance: 0,
  hasEntries: false,
  ...o,
});
const RENT = acct({ id: '00000000-0000-4000-8000-000000000002', code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'RENT', balance: 2500, hasEntries: true });
const CASH = acct({ balance: 7500, hasEntries: true });
const MEALS = acct({ id: '00000000-0000-4000-8000-000000000003', code: '6990', name: 'Meals', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: null });

const totals = (o: Partial<BooksProfitAndLoss['totals']> = {}) => ({ income: 0, costOfServices: 0, grossProfit: 0, grossMarginPct: null, expenses: 0, operatingIncome: 0, otherIncome: 0, otherExpenses: 0, netIncome: 0, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  api.getBooksDimensions.mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' }], sites: [], departments: [], costCenters: [] });
  api.listLedgerAccounts.mockResolvedValue({ accounts: [CASH, RENT, MEALS] });
});

describe('the Books overview', () => {
  it('shows the money at a glance and what needs someone', async () => {
    const o: BooksOverview = {
      asOf: '2026-10-19',
      cash: { total: 7500, accounts: [{ id: CASH.id, code: '1000', name: 'Operating checking', subtype: 'BANK', balance: 7500 }] },
      receivables: { total: 1200, aging: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 1200 }, topClients: [{ clientId: 'c1', name: 'Harbor Grill', open: 1200, oldestDueAt: '2026-07-01' }] },
      payables: { total: 250, dueIn7Days: 250, overdue: 0, awaitingApproval: 1 },
      profit: { month: totals({ income: 1200, netIncome: 900 }), yearToDate: totals({ income: 5000, netIncome: 2000, grossMarginPct: 38 }), trend: [{ key: '2026-10', label: 'Oct 2026', income: 1200, netIncome: 900 }] },
      close: { periodKey: '2026-09', status: 'OPEN', closedAt: null, tasksDone: 2, tasksTotal: 8 },
      quickbooks: { connected: false, status: null, companyName: null, lastPushAt: null, lastPullAt: null, openConflicts: 0, pending: 0, failed: 0 },
      needsYou: [{ key: 'bills', label: '1 bill waits for approval', count: 1, to: '/books/bills?tab=approve', tone: 'warning' }],
    };
    api.getBooksOverview.mockResolvedValue(o);
    renderAs('FINANCE_ACCOUNTANT', <BooksHome />, '/books');
    expect((await screen.findAllByText('$7,500.00')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /1 bill waits for approval/ })).toHaveAttribute('href', '/books/bills?tab=approve');
    expect(screen.getByText('$1,200.00 over 90 days')).toBeInTheDocument();
    expect(screen.getByText('2 of 8 close steps done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect QuickBooks' })).toHaveAttribute('href', '/books/quickbooks');
    expect(screen.getByRole('link', { name: /Journal entry/ })).toBeInTheDocument();
    // The profit chart says what it shows.
    expect(screen.getByRole('img', { name: 'Income and net income, the last month. Best: Oct 2026, $900.00 kept.' })).toBeInTheDocument();
  });

  it('the executive reads but gets no posting button', async () => {
    api.getBooksOverview.mockResolvedValue({
      asOf: '2026-10-19',
      cash: { total: 0, accounts: [] },
      receivables: { total: 0, aging: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 }, topClients: [] },
      payables: { total: 0, dueIn7Days: 0, overdue: 0, awaitingApproval: 0 },
      profit: { month: totals(), yearToDate: totals(), trend: [] },
      close: { periodKey: '2026-09', status: 'CLOSED', closedAt: '2026-10-05T12:00:00Z', tasksDone: 8, tasksTotal: 8 },
      quickbooks: { connected: false, status: null, companyName: null, lastPushAt: null, lastPullAt: null, openConflicts: 0, pending: 0, failed: 0 },
      needsYou: [],
    } satisfies BooksOverview);
    renderAs('EXECUTIVE_CHAIRMAN', <BooksHome />, '/books');
    expect(await screen.findByText('All clear.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Journal entry/ })).toBeNull();
  });
});

describe('the financial statements', () => {
  it('profit and loss: sections, gross profit, an amount opens its account, and it downloads', async () => {
    api.getProfitAndLoss.mockResolvedValue({
      from: '2026-01-01',
      to: '2026-10-19',
      sections: { income: [{ accountId: '00000000-0000-4000-8000-0000000000a1', code: '4000', name: 'Staffing services revenue', type: 'INCOME', subtype: 'INCOME', amount: 40000 }], costOfServices: [], expenses: [{ accountId: RENT.id, code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', amount: 2500 }], otherIncome: [], otherExpenses: [] },
      totals: totals({ income: 40000, grossProfit: 40000, expenses: 2500, operatingIncome: 37500, netIncome: 37500 }),
      columns: [],
    } satisfies BooksProfitAndLoss);
    api.downloadReport.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <BooksReportsPage />, '/books/reports?from=2026-01-01&to=2026-10-19');
    expect(await screen.findByText('Staffing services revenue')).toBeInTheDocument();
    // The statement's own net income line, and the waterfall above it says where the money went.
    expect(screen.getAllByText('Net income').length).toBeGreaterThan(1);
    expect(screen.getByRole('img', { name: /Of \$40,000\.00 income, cost of services took \$0\.00 and operating expenses \$2,500\.00, leaving \$37,500\.00 net income \(93\.8% of income\)/ })).toBeInTheDocument();
    const rentLink = screen.getAllByRole('link').find((a) => a.getAttribute('href')?.startsWith(`/books/accounts/${RENT.id}`));
    expect(rentLink?.getAttribute('href')).toBe(`/books/accounts/${RENT.id}?from=2026-01-01&to=2026-10-19`);
    expect(api.getProfitAndLoss).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-01-01', to: '2026-10-19', columns: 'none' }));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await user.click(await screen.findByRole('menuitem', { name: 'PDF' }));
    await waitFor(() => expect(api.downloadReport).toHaveBeenCalledWith('profit-and-loss', 'pdf', expect.objectContaining({ from: '2026-01-01' })));
  });

  it('the balance sheet says whether it balances', async () => {
    api.getBalanceSheet.mockResolvedValue({ asOf: '2026-10-19', fiscalYearStart: '2026-01-01', assets: [], liabilities: [], equity: [], totals: { assets: 100, liabilities: 40, equity: 60, liabilitiesAndEquity: 100, balanced: true } });
    renderAs('FINANCE_ACCOUNTANT', <BooksReportsPage />, '/books/reports?report=balance-sheet');
    expect(await screen.findByText('Assets equal liabilities and equity.')).toBeInTheDocument();
  });
});

describe('a manual journal entry', () => {
  it('posts only once the lines balance', async () => {
    api.postManualEntry.mockResolvedValue({ entry: { id: 'e1', number: 12 } });
    const user = userEvent.setup();
    renderAs(
      'FINANCE_ACCOUNTANT',
      <Routes>
        <Route path="/books/journal/:id" element={<JournalEntryPage />} />
      </Routes>,
      '/books/journal/new',
    );
    const line1 = await screen.findByRole('listitem', { name: 'Line 1' });
    await waitFor(() => expect(within(line1).getByRole('option', { name: /6100 · Rent/ })).toBeInTheDocument());
    fireEvent.change(within(line1).getByLabelText('Line 1 account'), { target: { value: RENT.id } });
    await user.type(within(line1).getByLabelText('Line 1 debit'), '2500');
    const line2 = screen.getByRole('listitem', { name: 'Line 2' });
    fireEvent.change(within(line2).getByLabelText('Line 2 account'), { target: { value: CASH.id } });
    await user.type(within(line2).getByLabelText('Line 2 credit'), '2400');
    expect(screen.getByText('Off by $100.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post entry' })).toBeDisabled();
    await user.clear(within(line2).getByLabelText('Line 2 credit'));
    await user.type(within(line2).getByLabelText('Line 2 credit'), '2500');
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Post entry' }));
    await waitFor(() =>
      expect(api.postManualEntry).toHaveBeenCalledWith(expect.objectContaining({ lines: [expect.objectContaining({ accountId: RENT.id, debit: 2500, credit: 0 }), expect.objectContaining({ accountId: CASH.id, debit: 0, credit: 2500 })] })),
    );
  });
});

describe('the chart of accounts', () => {
  it('groups by type with balances; a system account can’t be deleted, an unused one can', async () => {
    api.deleteLedgerAccount.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <AccountsPage />, '/books/accounts');
    expect(await screen.findByText('Operating checking')).toBeInTheDocument();
    expect(screen.getByText('Assets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More for Rent' }));
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'More for Meals' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteLedgerAccount).toHaveBeenCalledWith(MEALS.id));
  });

  it('the executive reads the chart with no editing', async () => {
    renderAs('EXECUTIVE_CHAIRMAN', <AccountsPage />, '/books/accounts');
    expect(await screen.findByText('Operating checking')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New account/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More for Rent' })).toBeNull();
  });
});
