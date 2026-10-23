import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { BooksJournalEntryDetail, BooksJournalRow, BooksOverview, BooksProfitAndLoss, LedgerAccountRow } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  getBooksOverview: vi.fn(),
  getBooksDimensions: vi.fn(),
  listLedgerAccounts: vi.fn(),
  createLedgerAccount: vi.fn(),
  updateLedgerAccount: vi.fn(),
  deleteLedgerAccount: vi.fn(),
  getAccountDetail: vi.fn(),
  listJournal: vi.fn(),
  downloadJournalCsv: vi.fn(),
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
const receivables = vi.hoisted(() => ({ backfillPosting: vi.fn() }));
vi.mock('@/lib/books/receivablesApi', () => receivables);
vi.mock('@/lib/savedViewsApi', () => ({ listSavedViews: vi.fn(async () => ({ views: [] })), createSavedView: vi.fn(), updateSavedView: vi.fn(), deleteSavedView: vi.fn() }));

import { BooksHome } from '@/pages/books/BooksHome';
import { BooksReportsPage, periodPresets, asOfPresets } from '@/pages/books/reports/BooksReportsPage';
import { JournalPage } from '@/pages/books/ledger/JournalPage';
import { JournalEntryPage } from '@/pages/books/ledger/JournalEntryPage';
import { AccountsPage } from '@/pages/books/ledger/AccountsPage';
import { AccountDetailPage } from '@/pages/books/ledger/AccountDetailPage';

/**
 * The F500 pass over the ledger's screens (2026-10-22): the journal's
 * count, sort and export are the server's whole filtered set; an empty
 * journal says how to fill it; a voided entry's Void sits under More and
 * its lines stack on a phone; the chart of accounts is a searchable grid
 * with this year's activity and full names on a phone; the statements
 * lead with their tabs, offer period presets and compare; the overview
 * leads with "post history" and lists the latest entries.
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
  balance: 7500,
  hasEntries: true,
  activityYtd: 1250,
  ...o,
});
const CASH = acct({});
const RENT = acct({ id: '00000000-0000-4000-8000-000000000002', code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'RENT', balance: 2500, activityYtd: 2500 });
const OLD = acct({ id: '00000000-0000-4000-8000-000000000003', code: '6995', name: 'Old supplies', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: null, isActive: false, balance: 0, activityYtd: 0 });

const row = (n: number, o: Partial<BooksJournalRow> = {}): BooksJournalRow => ({
  id: `e${n}`,
  number: n,
  date: '2026-10-05',
  memo: `Entry ${n}`,
  source: 'MANUAL',
  origin: 'SITE',
  status: 'POSTED',
  amount: n * 100,
  accounts: 'Rent / Operating checking',
  reverseOn: null,
  ...o,
});

const totals = (o: Partial<BooksProfitAndLoss['totals']> = {}) => ({ income: 0, costOfServices: 0, grossProfit: 0, grossMarginPct: null, expenses: 0, operatingIncome: 0, otherIncome: 0, otherExpenses: 0, netIncome: 0, ...o });

const realMatchMedia = window.matchMedia;
/** A 390px phone: every min-width query fails. */
const asPhone = () => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getBooksDimensions.mockResolvedValue({ clients: [{ id: 'c1', name: 'Coastal Resort' }], sites: [], departments: [], costCenters: [] });
  api.listLedgerAccounts.mockResolvedValue({ accounts: [CASH, RENT, OLD] });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});

describe('the journal', () => {
  it('counts every match, sorts and exports on the server, not the page on screen', async () => {
    api.listJournal.mockResolvedValue({ entries: Array.from({ length: 200 }, (_, i) => row(1060 - i)), total: 1060 });
    api.downloadJournalCsv.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <JournalPage />, '/books/journal?source=MANUAL');
    expect(await screen.findByText('1,060 entries · 1–200 shown')).toBeInTheDocument();
    expect(api.listJournal).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'MANUAL', limit: 200, offset: 0 }));
    // A header click asks the server for the whole set in that order.
    await user.click(screen.getByRole('button', { name: /Amount/ }));
    await waitFor(() => expect(api.listJournal).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'amount', source: 'MANUAL', offset: 0 })));
    // Export is every match with the same filters and order.
    await user.click(screen.getByRole('button', { name: /Export/ }));
    await waitFor(() => expect(api.downloadJournalCsv).toHaveBeenCalledWith(expect.objectContaining({ source: 'MANUAL', sort: 'amount' })));
    // Older goes to the next page of the same order.
    await user.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(api.listJournal).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'amount', offset: 200 })));
  });

  it('a quick view is one tap: manual entries this month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T12:00:00'));
    api.listJournal.mockResolvedValue({ entries: [row(3)], total: 1 });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <JournalPage />, '/books/journal');
    await user.click(await screen.findByRole('button', { name: 'Manual entries this month' }));
    await waitFor(() => expect(api.listJournal).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'MANUAL', from: '2026-10-01' })));
    expect(screen.getByRole('button', { name: 'Manual entries this month' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('an empty journal says how to fill it, and posts history from there', async () => {
    api.listJournal.mockResolvedValue({ entries: [], total: 0 });
    receivables.backfillPosting.mockResolvedValue({ payrollRuns: 3, statements: 12, taxPayments: 0, taxDeposits: 0, garnishmentRemittances: 0, wageAdvances: 0, failed: [] });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <JournalPage />, '/books/journal');
    expect(await screen.findByText('Nothing in the books yet')).toBeInTheDocument();
    // No search box, no "0 entries", no export over nothing.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Post history' }));
    await waitFor(() => expect(receivables.backfillPosting).toHaveBeenCalledTimes(1));
  });

  it('an empty year is not an empty journal: it offers the year before', async () => {
    api.listJournal.mockImplementation(async (f: { from?: string }) => (f.from ? { entries: [], total: 0 } : { entries: [row(1)], total: 4 }));
    renderAs('FINANCE_ACCOUNTANT', <JournalPage />, '/books/journal');
    expect(await screen.findByText(/^No entries since/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Show \d{4} too$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post history' })).toBeNull();
  });
});

describe('a journal entry', () => {
  const entry = (o: Partial<BooksJournalEntryDetail> = {}): BooksJournalEntryDetail => ({
    id: 'e9',
    number: 9,
    date: '2026-10-05',
    periodKey: '2026-10',
    memo: 'October rent',
    source: 'MANUAL',
    sourceType: null,
    sourceId: null,
    sourceLink: null,
    origin: 'SITE',
    status: 'POSTED',
    reverseOn: null,
    reverses: null,
    reversedBy: [],
    total: 2500,
    createdByName: 'Fin Ance',
    postedAt: '2026-10-05T15:00:00.000Z',
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    periodClosed: false,
    lines: [
      { id: 'l1', lineNo: 1, account: { id: RENT.id, code: '6100', name: 'Rent', type: 'EXPENSE' }, debit: 2500, credit: 0, memo: 'Suite 4', client: null, site: null, department: null, costCenter: null, vendor: null, cleared: false },
      { id: 'l2', lineNo: 2, account: { id: CASH.id, code: '1000', name: 'Operating checking', type: 'ASSET' }, debit: 0, credit: 2500, memo: null, client: null, site: null, department: null, costCenter: null, vendor: null, cleared: false },
    ],
    ...o,
  });
  const at = (path: string, role: 'FINANCE_ACCOUNTANT' | 'EXECUTIVE_CHAIRMAN' = 'FINANCE_ACCOUNTANT') =>
    renderAs(
      role,
      <Routes>
        <Route path="/books/journal/:id" element={<JournalEntryPage />} />
      </Routes>,
      path,
    );

  it('reads as a record: facts in the header, Void under More behind its reason, lines stacked for a phone', async () => {
    api.getJournalEntry.mockResolvedValue({ entry: entry() });
    api.voidJournalEntry.mockResolvedValue({ voided: true, reversalId: null });
    const user = userEvent.setup();
    at('/books/journal/e9');
    expect(await screen.findByRole('heading', { name: 'Journal entry #9' })).toBeInTheDocument();
    const facts = screen.getByTestId('page-facts');
    expect(facts).toHaveTextContent('$2,500.00');
    expect(facts).toHaveTextContent('Manual entry');
    // Void is not a button in the header's row.
    expect(screen.queryByRole('button', { name: /Void entry/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /More/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Void entry/ }));
    await user.type(await screen.findByRole('textbox'), 'Entered twice');
    await user.click(screen.getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(api.voidJournalEntry).toHaveBeenCalledWith('e9', 'Entered twice'));
    // The stacked list: account and memo on the left, the amount and its side on the right.
    const stacked = screen.getByRole('list', { name: 'Lines' });
    const first = within(stacked).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent('6100Rent');
    expect(first).toHaveTextContent('Suite 4');
    expect(first).toHaveTextContent('$2,500.00Debit');
  });

  it('an entry a record posted offers no void; the executive gets no actions', async () => {
    api.getJournalEntry.mockResolvedValue({ entry: entry({ source: 'PAYROLL', sourceLink: { label: 'Open the payroll run', to: '/payroll/runs/r1' } }) });
    at('/books/journal/e9');
    expect(await screen.findByRole('link', { name: 'Open the payroll run' })).toHaveAttribute('href', '/payroll/runs/r1');
    expect(screen.queryByRole('button', { name: /More/ })).toBeNull();
  });

  it('a new entry says nothing about balance until there is money on it', async () => {
    at('/books/journal/new');
    expect(await screen.findByRole('listitem', { name: 'Line 1' })).toBeInTheDocument();
    expect(screen.queryByText('Balanced')).toBeNull();
    expect(screen.queryByText(/Off by/)).toBeNull();
    // No Back button: the trail above the title is the way back.
    expect(screen.queryByRole('link', { name: /^Back$/ })).toBeNull();
  });
});

describe('the chart of accounts', () => {
  it('a searchable grid with this year’s activity; turned-off accounts behind a filter; CSV of what’s shown', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <AccountsPage />, '/books/accounts');
    expect(await screen.findByRole('columnheader', { name: /Activity YTD/ })).toBeInTheDocument();
    const rent = screen.getByText('Rent').closest('tr')!;
    expect(rent).toHaveTextContent('$2,500.00');
    expect(screen.queryByText('Old supplies')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /Show 1 turned-off account/ }));
    expect(await screen.findByText('Old supplies')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), '6100');
    await waitFor(() => expect(screen.queryByText('Operating checking')).toBeNull());
    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export/ })).toBeInTheDocument();
  });

  it('on a phone the whole name shows, with the code and type under it, and no lock icon', async () => {
    asPhone();
    api.listLedgerAccounts.mockResolvedValue({ accounts: [acct({ name: 'Operating checking — Harbor National Bank, the long one' }), RENT] });
    renderAs('FINANCE_ACCOUNTANT', <AccountsPage />, '/books/accounts');
    const name = await screen.findByText('Operating checking — Harbor National Bank, the long one');
    expect(name.className).not.toMatch(/truncate/);
    expect(screen.getByText('1000 · Bank')).toBeInTheDocument();
    expect(screen.queryByLabelText('Used by automatic posting')).toBeNull();
  });
});

describe('an account’s register', () => {
  it('an empty range names the account and the dates, and widens them', async () => {
    api.getAccountDetail.mockResolvedValue({ account: { id: RENT.id, code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE' }, from: '2026-01-01', to: '2026-10-22', opening: 0, closing: 0, rows: [] });
    const user = userEvent.setup();
    renderAs(
      'FINANCE_ACCOUNTANT',
      <Routes>
        <Route path="/books/accounts/:id" element={<AccountDetailPage />} />
      </Routes>,
      `/books/accounts/${RENT.id}?from=2026-01-01&to=2026-10-22`,
    );
    expect(await screen.findByText('Nothing posted to Rent, Jan 1 – Oct 22, 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Widen the dates to Jan 1, 2025' }));
    await waitFor(() => expect(api.getAccountDetail).toHaveBeenLastCalledWith(RENT.id, expect.objectContaining({ from: '2025-01-01', to: '2026-10-22' })));
  });
});

describe('the financial statements', () => {
  it('presets name the periods; the tabs come before the filters', () => {
    expect(periodPresets('2026-10-22').map((p) => [p.label, p.from, p.to])).toEqual([
      ['This month', '2026-10-01', '2026-10-31'],
      ['Last month', '2026-09-01', '2026-09-30'],
      ['Quarter to date', '2026-10-01', '2026-10-22'],
      ['Year to date', '2026-01-01', '2026-10-22'],
      ['Last year', '2025-01-01', '2025-12-31'],
    ]);
    expect(periodPresets('2026-01-15')[1]).toMatchObject({ from: '2025-12-01', to: '2025-12-31' });
    expect(asOfPresets('2026-02-10').map((p) => p.asOf)).toEqual(['2026-02-10', '2026-01-31', '2025-12-31', '2025-12-31']);
  });

  it('compares with the period before: each account and the totals side by side, with the change', async () => {
    const pnl: BooksProfitAndLoss = {
      from: '2026-09-01',
      to: '2026-09-30',
      sections: { income: [{ accountId: 'a0000000-0000-4000-8000-0000000000a1', code: '4000', name: 'Staffing services revenue', type: 'INCOME', subtype: 'INCOME', amount: 10000 }], costOfServices: [], expenses: [{ accountId: RENT.id, code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', amount: 2000 }], otherIncome: [], otherExpenses: [] },
      totals: totals({ income: 10000, grossProfit: 10000, expenses: 2000, operatingIncome: 8000, netIncome: 8000 }),
      columns: [],
      compare: {
        kind: 'prior',
        from: '2026-08-01',
        to: '2026-08-31',
        sections: { income: [{ accountId: 'a0000000-0000-4000-8000-0000000000a1', code: '4000', name: 'Staffing services revenue', type: 'INCOME', subtype: 'INCOME', amount: 6000 }], costOfServices: [], expenses: [{ accountId: RENT.id, code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', amount: 1500 }, { accountId: 'a0000000-0000-4000-8000-0000000000b2', code: '6200', name: 'Utilities', type: 'EXPENSE', subtype: 'EXPENSE', amount: 300 }], otherIncome: [], otherExpenses: [] },
        totals: totals({ income: 6000, grossProfit: 6000, expenses: 1800, operatingIncome: 4200, netIncome: 4200 }),
      },
    };
    api.getProfitAndLoss.mockResolvedValue(pnl);
    renderAs('FINANCE_ACCOUNTANT', <BooksReportsPage />, '/books/reports?from=2026-09-01&to=2026-09-30&compare=prior');
    expect(await screen.findByText('Staffing services revenue')).toBeInTheDocument();
    expect(api.getProfitAndLoss).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-09-01', to: '2026-09-30', compare: 'prior' }));
    // The headings say what each column covers.
    expect(screen.getByText('Sep 1 – 30, 2026')).toBeInTheDocument();
    expect(screen.getByText('Aug 1 – 31, 2026')).toBeInTheDocument();
    // Rent: $2,000 against $1,500, up $500. Utilities moved only last month: it still gets its line.
    const rent = screen.getByText('Rent').parentElement!.parentElement!;
    expect(rent).toHaveTextContent('$2,000.00$1,500.00+$500.00');
    const utilities = screen.getByText('Utilities').parentElement!.parentElement!;
    expect(utilities).toHaveTextContent('$0.00$300.00−$300.00');
    expect(screen.getByText('Net income', { selector: 'span' }).parentElement!).toHaveTextContent('$8,000.00$4,200.00+$3,800.00');
    // The period reads as its preset; the tabs sit above it.
    const tabs = screen.getByRole('tablist');
    const period = screen.getByRole('combobox', { name: 'Period' });
    expect(tabs.compareDocumentPosition(period) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(period).toHaveValue('last-month');
  });

  it('by month, a comparison is not offered (the months are the comparison)', async () => {
    api.getProfitAndLoss.mockResolvedValue({ from: '2026-01-01', to: '2026-03-31', sections: { income: [], costOfServices: [], expenses: [], otherIncome: [], otherExpenses: [] }, totals: totals(), columns: [], compare: null } satisfies BooksProfitAndLoss);
    renderAs('FINANCE_ACCOUNTANT', <BooksReportsPage />, '/books/reports?from=2026-01-01&to=2026-03-31&columns=month&compare=prior');
    await waitFor(() => expect(api.getProfitAndLoss).toHaveBeenCalled());
    expect(api.getProfitAndLoss).toHaveBeenCalledWith(expect.not.objectContaining({ compare: 'prior' }));
    expect(screen.queryByRole('combobox', { name: 'Compare with' })).toBeNull();
  });
});

describe('the Books overview', () => {
  const overview = (o: Partial<BooksOverview> = {}): BooksOverview => ({
    asOf: '2026-10-22',
    cash: { total: 0, accounts: [], connectedAccounts: 0 },
    receivables: { total: 0, openOnStatements: 5760, aging: { current: 0, days1to30: 2880, days31to60: 2880, days61to90: 0, over90: 0 }, topClients: [] },
    payables: { total: 0, dueIn7Days: 0, overdue: 0, awaitingApproval: 0 },
    profit: { month: totals(), yearToDate: totals(), trend: [] },
    close: { periodKey: '2026-09', status: 'OPEN', closedAt: null, tasksDone: 6, tasksTotal: 10 },
    quickbooks: { connected: false, status: null, companyName: null, lastPushAt: null, lastPullAt: null, openConflicts: 0, pending: 0, failed: 0 },
    needsYou: [
      { key: 'ar-unposted', label: 'Receivables in the books ($0.00) don’t match open statements ($5,760.00) — post history to bring them in', count: 1, to: '/books/receivables', tone: 'warning' },
      { key: 'close', label: 'September isn’t closed yet', count: 1, to: '/books/close/2026-09', tone: 'info' },
    ],
    ...o,
  });

  it('leads with post history — one press, right there — and lists the latest entries', async () => {
    api.getBooksOverview.mockResolvedValue(overview());
    api.listJournal.mockResolvedValue({ entries: [row(12, { memo: 'Payroll — period Oct 3–Oct 16', amount: 48211.36 })], total: 12 });
    receivables.backfillPosting.mockResolvedValue({ payrollRuns: 1, statements: 2, taxPayments: 0, taxDeposits: 0, garnishmentRemittances: 0, wageAdvances: 0, failed: [] });
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <BooksHome />, '/books');
    const needs = (await screen.findByText(/post history to bring them in/)).closest('li')!;
    await user.click(within(needs).getByRole('button', { name: 'Post history' }));
    await waitFor(() => expect(receivables.backfillPosting).toHaveBeenCalledTimes(1));
    const recent = await screen.findByRole('link', { name: /Payroll — period Oct 3–Oct 16/ });
    expect(recent).toHaveAttribute('href', '/books/journal/e12');
    expect(recent).toHaveTextContent('$48,211.36');
    expect(screen.queryByText('Go to')).toBeNull();
    // An ended month that isn't closed says so, and how long it has waited.
    expect(screen.getByText('Not closed')).toBeInTheDocument();
    expect(screen.getByText('6 of 10 close steps done · 22 days since month end')).toBeInTheDocument();
  });

  it('someone who only reads the books gets no post-history button', async () => {
    api.getBooksOverview.mockResolvedValue(overview());
    api.listJournal.mockResolvedValue({ entries: [], total: 0 });
    renderAs('EXECUTIVE_CHAIRMAN', <BooksHome />, '/books');
    expect(await screen.findByText(/post history to bring them in/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post history' })).toBeNull();
  });
});
