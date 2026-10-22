import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { BankFeedAccountView, BankReconciliationDetail, BankTxnView } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  BANK_KEY: ['books', 'bank'] as const,
  listLedgerAccountOptions: vi.fn(),
  listBankAccounts: vi.fn(),
  getBankAccount: vi.fn(),
  createBankAccount: vi.fn(),
  listBankTransactions: vi.fn(),
  previewBankImport: vi.fn(),
  importBankFile: vi.fn(),
  syncBankAccount: vi.fn(),
  getTxnSuggestionsBatch: vi.fn(),
  bulkDecideTxns: vi.fn(),
  categorizeTxn: vi.fn(),
  matchTxn: vi.fn(),
  excludeTxn: vi.fn(),
  undoTxn: vi.fn(),
  listBankRules: vi.fn(),
  createBankRule: vi.fn(),
  updateBankRule: vi.fn(),
  deleteBankRule: vi.fn(),
  applyBankRules: vi.fn(),
  getPlaidStatus: vi.fn(),
  createPlaidLinkToken: vi.fn(),
  exchangePlaidToken: vi.fn(),
  listReconciliations: vi.fn(),
  startReconciliation: vi.fn(),
  getReconciliation: vi.fn(),
  tickReconciliation: vi.fn(),
  completeReconciliation: vi.fn(),
  undoReconciliation: vi.fn(),
  reconciliationReportUrl: (id: string) => `/api/books/bank/reconciliations/${id}/report.xlsx`,
  readFileText: vi.fn(),
  openPlaidLink: vi.fn(),
}));
vi.mock('@/lib/books/bankApi', () => api);

const recv = vi.hoisted(() => ({ getReceivablesAging: vi.fn(), recordClientPayment: vi.fn(), listDepositAccounts: vi.fn() }));
vi.mock('@/lib/books/receivablesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/books/receivablesApi')>()), ...recv }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/Toaster', () => ({ toast }));

type Sugg = Awaited<ReturnType<typeof import('@/lib/books/bankApi').getTxnSuggestionsBatch>>['suggestions'][string];
/** The page asks for its suggestions in one call: answer it from a per-transaction function. */
function suggest(fn: (id: string) => Sugg) {
  api.getTxnSuggestionsBatch.mockImplementation(async (ids: string[]) => ({ suggestions: Object.fromEntries(ids.map((id) => [id, fn(id)])) }));
}
const NONE: Sugg = { matches: [], rule: null, lastTime: null, exactLineId: null, client: null };

import { BankPage } from '@/pages/books/bank/BankPage';
import { BankAccountPage } from '@/pages/books/bank/BankAccountPage';
import { ReconcilePage } from '@/pages/books/bank/ReconcilePage';

const FEED = '00000000-0000-4000-8000-0000000000f1';
const CASH = '00000000-0000-4000-8000-0000000000a1';
const FUEL = '00000000-0000-4000-8000-0000000000a2';

const account = (o: Partial<BankFeedAccountView> = {}): BankFeedAccountView => ({
  id: FEED,
  ledgerAccountId: CASH,
  ledgerCode: '1000',
  ledgerName: 'Operating checking',
  subtype: 'BANK',
  name: 'Operating checking',
  institution: 'First Coast Bank',
  mask: '0042',
  feed: 'MANUAL',
  isActive: true,
  booksBalance: 12627.4,
  bankBalance: 14137.9,
  lastSyncedAt: null,
  lastError: null,
  forReview: 3,
  lastReconciled: { statementEndDate: '2026-09-30', statementBalance: 10000 },
  ...o,
});

const txn = (o: Partial<BankTxnView> & { id: string }): BankTxnView => ({
  feedAccountId: FEED,
  postedOn: '2026-10-02',
  amount: -62.1,
  description: 'SHELL OIL 57444',
  payee: null,
  reference: null,
  importedFrom: 'CSV',
  status: 'UNMATCHED',
  category: null,
  matched: null,
  journalEntryId: null,
  ruleName: null,
  decidedAt: null,
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listLedgerAccountOptions.mockResolvedValue({
    accounts: [
      { id: CASH, code: '1000', name: 'Operating checking', type: 'ASSET', subtype: 'BANK' },
      { id: FUEL, code: '6200', name: 'Vehicle fuel', type: 'EXPENSE', subtype: 'EXPENSE' },
    ],
  });
  api.getPlaidStatus.mockResolvedValue({ configured: false, environment: null });
  api.listBankRules.mockResolvedValue({ rules: [] });
  api.listReconciliations.mockResolvedValue({ reconciliations: [] });
});

describe('Bank and cards', () => {
  it('shows each account: books against bank, what is waiting, and when it was reconciled', async () => {
    api.listBankAccounts.mockResolvedValue({ accounts: [account()] });
    renderAs('FINANCE_ACCOUNTANT', <BankPage />, '/books/bank');
    const card = (await screen.findAllByText('Operating checking'))[0]!.closest('a')!;
    expect(within(card).getByText('$12,627.40')).toBeInTheDocument();
    expect(within(card).getByText('$14,137.90')).toBeInTheDocument();
    expect(within(card).getByText('3 for review')).toBeInTheDocument();
    expect(within(card).getByText(/Reconciled through/)).toBeInTheDocument();
    expect(within(card).getByText(/more at the bank/)).toBeInTheDocument();
    expect(card).toHaveAttribute('href', `/books/bank/${FEED}`);
    expect(screen.getByRole('button', { name: /Add an account/ })).toBeInTheDocument();
  });

  it('a read-only role sees no way to change anything', async () => {
    api.listBankAccounts.mockResolvedValue({ accounts: [] });
    renderAs('EXECUTIVE_CHAIRMAN', <BankPage />, '/books/bank');
    expect(await screen.findByText('Add your first bank account')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add an account/ })).toBeNull();
  });
});

function renderAccount(role: 'FINANCE_ACCOUNTANT' | 'EXECUTIVE_CHAIRMAN' = 'FINANCE_ACCOUNTANT', route = `/books/bank/${FEED}`) {
  return renderAs(
    role,
    <Routes>
      <Route path="/books/bank/:id" element={<BankAccountPage />} />
      <Route path="/books/bank/:id/reconcile" element={<ReconcilePage />} />
    </Routes>,
    route,
  );
}

describe('reviewing an account’s transactions', () => {
  beforeEach(() => {
    api.getBankAccount.mockResolvedValue({ account: account() });
  });

  it('matches the entry already in the books, accepts a rule’s category, or picks one', async () => {
    const deposit = txn({ id: 't1', amount: 4200, description: 'COASTAL RESORT ACH' });
    const fuel = txn({ id: 't2' });
    const other = txn({ id: 't3', amount: -19.99, description: 'MYSTERY' });
    api.listBankTransactions.mockResolvedValue({ transactions: [deposit, fuel, other], counts: { UNMATCHED: 3, MATCHED: 0, CATEGORIZED: 4, EXCLUDED: 0 } });
    suggest((id) =>
      id === 't1'
        ? { ...NONE, matches: [{ lineId: 'l1', entryId: 'e1', entryNumber: 12, date: '2026-10-02', memo: 'Coastal statement 12', source: 'CLIENT_PAYMENT', amount: 4200, daysApart: 1 }], exactLineId: 'l1' }
        : id === 't2'
          ? { ...NONE, rule: { ruleId: 'r1', name: 'Fuel', accountId: FUEL, accountCode: '6200', accountName: 'Vehicle fuel', vendorId: null, clientId: null, departmentId: null } }
          : NONE,
    );
    api.matchTxn.mockResolvedValue({ transaction: { ...deposit, status: 'MATCHED' } });
    api.categorizeTxn.mockResolvedValue({ transaction: { ...fuel, status: 'CATEGORIZED' } });
    const user = userEvent.setup();
    renderAccount();

    expect(await screen.findByText(/Entry #12 · Coastal statement 12/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Match' }));
    await waitFor(() => expect(api.matchTxn).toHaveBeenCalledWith('t1', 'l1'));

    expect(await screen.findByText(/Rule “Fuel” → 6200 Vehicle fuel/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.categorizeTxn).toHaveBeenCalledWith('t2', { accountId: FUEL, vendorId: null, clientId: null, departmentId: null }));

    const mystery = screen.getByText('MYSTERY').closest('li')!;
    const pick = await within(mystery).findByRole('combobox');
    await waitFor(() => expect(within(pick).getByRole('option', { name: '6200 · Vehicle fuel' })).toBeInTheDocument());
    // The account itself is never offered as its own category.
    expect(within(pick).queryByRole('option', { name: '1000 · Operating checking' })).toBeNull();
    fireEvent.change(pick, { target: { value: FUEL } });
    await user.click(within(mystery).getByRole('button', { name: 'Categorize' }));
    await waitFor(() => expect(api.categorizeTxn).toHaveBeenCalledWith('t3', { accountId: FUEL }));
    // Counts on the tabs.
    expect(screen.getByRole('tab', { name: /Categorized/ })).toHaveTextContent('4');
    // One request for the page's suggestions, not one per row.
    expect(api.getTxnSuggestionsBatch).toHaveBeenCalledWith(['t1', 't2', 't3']);
  });

  it('accepts every suggestion and matches every exact one in one click — or just the selection', async () => {
    const rows = [txn({ id: 't1', amount: 4200, description: 'COASTAL RESORT ACH' }), txn({ id: 't2' }), txn({ id: 't3', description: 'SHELL OIL 99' }), txn({ id: 't4', description: 'MYSTERY' })];
    api.listBankTransactions.mockResolvedValue({ transactions: rows, counts: { UNMATCHED: 4, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 } });
    const rule = { ruleId: 'r1', name: 'Fuel', accountId: FUEL, accountCode: '6200', accountName: 'Vehicle fuel', vendorId: null, clientId: null, departmentId: null };
    suggest((id) =>
      id === 't1' ? { ...NONE, matches: [{ lineId: 'l1', entryId: 'e1', entryNumber: 12, date: '2026-10-02', memo: null, source: 'CLIENT_PAYMENT', amount: 4200, daysApart: 0 }], exactLineId: 'l1' } : id === 't4' ? NONE : { ...NONE, rule },
    );
    api.bulkDecideTxns.mockImplementation(async (action: string, ids: string[]) => ({ action, done: ids, skipped: [] }));
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole('button', { name: 'Accept all suggested (2)' }));
    await waitFor(() => expect(api.bulkDecideTxns).toHaveBeenCalledWith('ACCEPT', ['t2', 't3']));
    await user.click(screen.getByRole('button', { name: 'Match all exact (1)' }));
    await waitFor(() => expect(api.bulkDecideTxns).toHaveBeenCalledWith('MATCH', ['t1']));

    // With a selection, the buttons act on it — and it can be excluded together.
    await user.click(screen.getByRole('checkbox', { name: 'Select SHELL OIL 99' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select MYSTERY' }));
    expect(screen.getByRole('button', { name: 'Accept suggested (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match exact (0)' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Exclude (2)' }));
    await waitFor(() => expect(api.bulkDecideTxns).toHaveBeenCalledWith('EXCLUDE', ['t3', 't4']));
  });

  it('works from the keyboard: j moves, a takes the suggestion, x excludes, u undoes', async () => {
    const rows = [txn({ id: 't1' }), txn({ id: 't2', description: 'MYSTERY' })];
    api.listBankTransactions.mockResolvedValue({ transactions: rows, counts: { UNMATCHED: 2, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 } });
    suggest((id) => (id === 't1' ? { ...NONE, lastTime: { accountId: FUEL, accountCode: '6200', accountName: 'Vehicle fuel' } } : NONE));
    api.categorizeTxn.mockResolvedValue({ transaction: { ...rows[0]!, status: 'CATEGORIZED' } });
    api.excludeTxn.mockResolvedValue({ transaction: { ...rows[1]!, status: 'EXCLUDED' } });
    api.undoTxn.mockResolvedValue({ transaction: rows[1]!, paymentKept: null, paymentUndone: false });
    const user = userEvent.setup();
    renderAccount();
    expect(await screen.findByText(/Same as last time → 6200 Vehicle fuel/)).toBeInTheDocument();
    await user.keyboard('j');
    await user.keyboard('a');
    await waitFor(() => expect(api.categorizeTxn).toHaveBeenCalledWith('t1', { accountId: FUEL }));
    // The cursor moved on to the next row.
    await user.keyboard('x');
    await waitFor(() => expect(api.excludeTxn).toHaveBeenCalledWith('t2'));
    await user.keyboard('u');
    await waitFor(() => expect(api.undoTxn).toHaveBeenCalledWith('t2', {}));
  });

  it('records a deposit as the client’s payment, prefilled, and matches it', async () => {
    const deposit = txn({ id: 't1', amount: 4200, postedOn: '2026-10-03', description: 'COASTAL RESORT HOLDINGS ACH', reference: 'TRC-88' });
    api.listBankTransactions.mockResolvedValue({ transactions: [deposit], counts: { UNMATCHED: 1, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 } });
    suggest(() => ({ ...NONE, client: { id: 'c1', name: 'Coastal Resort' } }));
    recv.getReceivablesAging.mockResolvedValue({
      asOf: '2026-10-20',
      rows: [{ clientId: 'c1', clientName: 'Coastal Resort', buckets: { current: 0, days1to30: 4200, days31to60: 0, days61to90: 0, over90: 0 }, open: 4200, unapplied: 0, statements: 1, oldestDaysPastDue: 8 }],
      statements: [{ statementId: 's1', clientId: 'c1', clientName: 'Coastal Resort', number: 7, periodStart: '2026-09-21', periodEnd: '2026-09-27', dueOn: '2026-10-12', daysPastDue: 8, bucket: 'days1to30', total: 4200, applied: 0, open: 4200 }],
      totals: { buckets: { current: 0, days1to30: 4200, days31to60: 0, days61to90: 0, over90: 0 }, open: 4200 },
    });
    recv.listDepositAccounts.mockResolvedValue({ accounts: [] });
    recv.recordClientPayment.mockResolvedValue({ payment: { id: 'p1', amount: 4200, clientName: 'Coastal Resort', unapplied: 0 }, bankTransaction: { ...deposit, status: 'MATCHED' } });
    const user = userEvent.setup();
    renderAccount();
    await user.click(await screen.findByRole('button', { name: /Payment from Coastal Resort/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Record the deposit as a payment')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Amount received')).toHaveValue('4200.00');
    expect(within(dialog).getByLabelText('Reference')).toHaveValue('TRC-88');
    await user.click(within(dialog).getByRole('button', { name: /Record \$4,200/ }));
    await waitFor(() =>
      expect(recv.recordClientPayment).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'c1', amount: 4200, receivedOn: '2026-10-03', reference: 'TRC-88', depositAccountId: CASH, bankTransactionId: 't1', applications: [{ statementId: 's1', amount: 4200 }] }),
      ),
    );
  });

  it('a key never takes an ambiguous match — the row opens its choice instead', async () => {
    const rows = [txn({ id: 't1', amount: 1000, description: 'TRANSFER IN' })];
    api.listBankTransactions.mockResolvedValue({ transactions: rows, counts: { UNMATCHED: 1, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 } });
    const line = (n: number, day: string, apart: number) => ({ lineId: `l${n}`, entryId: `e${n}`, entryNumber: n, date: day, memo: null, source: 'MANUAL', amount: 1000, daysApart: apart });
    suggest(() => ({ ...NONE, matches: [line(1, '2026-10-01', 1), line(2, '2026-10-03', 1)], exactLineId: null }));
    api.matchTxn.mockResolvedValue({ transaction: { ...rows[0]!, status: 'MATCHED' } });
    const user = userEvent.setup();
    renderAccount();
    expect(await screen.findByRole('button', { name: 'Choose (2)' })).toBeInTheDocument();
    await user.keyboard('j');
    await user.keyboard('m');
    expect(api.matchTxn).not.toHaveBeenCalled();
    const list = await screen.findByRole('list', { name: /Entries that could be TRANSFER IN/ });
    await user.click(within(list).getAllByRole('button', { name: 'Match this' })[1]!);
    await waitFor(() => expect(api.matchTxn).toHaveBeenCalledWith('t1', 'l2'));
  });

  it('a deposit with no likely payer preselects nobody; a payer owing nothing is still offered', async () => {
    const deposit = txn({ id: 't1', amount: 300, postedOn: '2026-10-03', description: 'ACH CREDIT 4471' });
    api.listBankTransactions.mockResolvedValue({ transactions: [deposit], counts: { UNMATCHED: 1, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 } });
    suggest(() => NONE);
    recv.getReceivablesAging.mockResolvedValue({
      asOf: '2026-10-20',
      rows: [{ clientId: 'c1', clientName: 'Coastal Resort', buckets: { current: 0, days1to30: 4200, days31to60: 0, days61to90: 0, over90: 0 }, open: 4200, unapplied: 0, statements: 1, oldestDaysPastDue: 8 }],
      statements: [],
      totals: { buckets: { current: 0, days1to30: 4200, days31to60: 0, days61to90: 0, over90: 0 }, open: 4200 },
    });
    recv.listDepositAccounts.mockResolvedValue({ accounts: [] });
    const user = userEvent.setup();
    renderAccount();
    await user.click(await screen.findByRole('button', { name: /More for ACH CREDIT 4471/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Record as a client payment/ }));
    const dialog = await screen.findByRole('dialog');
    // Not the biggest debtor by default: a choice.
    expect(within(dialog).getByLabelText('Client')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: /Record \$300/ })).toBeDisabled();
  });

  it('undoing a match to a client payment says the payment stands — and offers to take it back', async () => {
    const done = txn({ id: 't9', amount: 900, status: 'MATCHED', matched: { lineId: 'l9', entryId: 'e9', entryNumber: 41, memo: 'Payment from Harbor Grill', date: '2026-10-08' } });
    api.listBankTransactions.mockImplementation(async (_id: string, q: { status?: string }) =>
      q.status === 'MATCHED' ? { transactions: [done], counts: { UNMATCHED: 0, MATCHED: 1, CATEGORIZED: 0, EXCLUDED: 0 } } : { transactions: [], counts: { UNMATCHED: 0, MATCHED: 1, CATEGORIZED: 0, EXCLUDED: 0 } },
    );
    api.undoTxn.mockResolvedValue({ transaction: { ...done, status: 'UNMATCHED', matched: null }, paymentKept: { id: 'p9', clientName: 'Harbor Grill' }, paymentUndone: false });
    const user = userEvent.setup();
    renderAccount('FINANCE_ACCOUNTANT', `/books/bank/${FEED}?tab=matched`);
    await user.click(await screen.findByRole('button', { name: /Undo/ }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/The payment from Harbor Grill is still recorded/), { action: expect.objectContaining({ label: 'Undo the payment too' }) }),
    );
  });

  it('a decided transaction can be undone', async () => {
    const done = txn({ id: 't9', status: 'CATEGORIZED', category: { accountId: FUEL, code: '6200', name: 'Vehicle fuel', transfer: false }, ruleName: 'Fuel', journalEntryId: 'e9' });
    api.listBankTransactions.mockImplementation(async (_id: string, q: { status?: string }) =>
      q.status === 'CATEGORIZED' ? { transactions: [done], counts: { UNMATCHED: 0, MATCHED: 0, CATEGORIZED: 1, EXCLUDED: 0 } } : { transactions: [], counts: { UNMATCHED: 0, MATCHED: 0, CATEGORIZED: 1, EXCLUDED: 0 } },
    );
    api.undoTxn.mockResolvedValue({ transaction: { ...done, status: 'UNMATCHED' }, paymentKept: null, paymentUndone: false });
    const user = userEvent.setup();
    renderAccount('FINANCE_ACCOUNTANT', `/books/bank/${FEED}?tab=categorized`);
    expect(await screen.findByText(/6200 Vehicle fuel/)).toBeInTheDocument();
    expect(screen.getByText('Rule: Fuel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.undoTxn).toHaveBeenCalledWith('t9', {}));
  });
});

describe('reconciling', () => {
  const rec = (o: Partial<BankReconciliationDetail> = {}): BankReconciliationDetail => ({
    id: 'rec1',
    feedAccountId: FEED,
    accountName: 'Operating checking',
    subtype: 'BANK',
    statementEndDate: '2026-10-31',
    statementBalance: 14200,
    beginningBalance: 10000,
    status: 'IN_PROGRESS',
    completedAt: null,
    completedByName: null,
    clearedCount: 0,
    lines: [
      { lineId: 'l1', entryId: 'e1', entryNumber: 4, date: '2026-10-03', memo: 'Coastal payment', source: 'CLIENT_PAYMENT', amount: 4200, cleared: false },
      { lineId: 'l2', entryId: 'e2', entryNumber: 7, date: '2026-10-28', memo: 'Rent', source: 'MANUAL', amount: -2000, cleared: false },
    ],
    clearedBalance: 0,
    difference: 4200,
    canUndo: false,
    ...o,
  });

  beforeEach(() => {
    api.getBankAccount.mockResolvedValue({ account: account() });
  });

  it('starts from the statement, ticks lines, and completes only at zero', async () => {
    api.listReconciliations.mockResolvedValue({ reconciliations: [{ id: 'old', statementEndDate: '2026-09-30', statementBalance: 10000, beginningBalance: 0, status: 'COMPLETED', completedAt: '2026-10-05T12:00:00Z', completedByName: 'Fin', clearedCount: 4 }] });
    api.startReconciliation.mockResolvedValue(rec());
    api.getReconciliation.mockResolvedValue(rec());
    api.tickReconciliation.mockResolvedValue(rec({ lines: rec().lines.map((l) => (l.lineId === 'l1' ? { ...l, cleared: true } : l)), clearedBalance: 4200, difference: 0 }));
    api.completeReconciliation.mockResolvedValue(rec({ status: 'COMPLETED', difference: 0, clearedBalance: 4200 }));
    const user = userEvent.setup();
    renderAccount('FINANCE_ACCOUNTANT', `/books/bank/${FEED}/reconcile`);

    expect(await screen.findByText(/Reconciled through/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Statement end date'), { target: { value: '2026-10-31' } });
    await user.type(screen.getByLabelText('Ending balance'), '14200');
    await user.click(screen.getByRole('button', { name: /Start reconciling/ }));
    await waitFor(() => expect(api.startReconciliation).toHaveBeenCalledWith(FEED, { statementEndDate: '2026-10-31', statementBalance: 14200 }));

    expect(await screen.findByText('Deposits and other credits')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Difference must be zero' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Coastal payment/ }));
    await waitFor(() => expect(api.tickReconciliation).toHaveBeenCalledWith('rec1', ['l1'], true));
    const complete = await screen.findByRole('button', { name: 'Complete the reconciliation' });
    api.getReconciliation.mockResolvedValue(rec({ status: 'COMPLETED', difference: 0, clearedBalance: 4200 }));
    await user.click(complete);
    await waitFor(() => expect(api.completeReconciliation).toHaveBeenCalledWith('rec1'));
    expect(await screen.findAllByText('Reconciled')).not.toHaveLength(0);
  });
});
