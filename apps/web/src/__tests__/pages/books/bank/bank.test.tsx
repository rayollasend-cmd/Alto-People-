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
  updateBankAccount: vi.fn(),
  listBankTransactions: vi.fn(),
  previewBankImport: vi.fn(),
  importBankFile: vi.fn(),
  syncBankAccount: vi.fn(),
  getTxnSuggestions: vi.fn(),
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
    api.getTxnSuggestions.mockImplementation(async (id: string) =>
      id === 't1'
        ? { matches: [{ lineId: 'l1', entryId: 'e1', entryNumber: 12, date: '2026-10-02', memo: 'Coastal statement 12', source: 'CLIENT_PAYMENT', amount: 4200, daysApart: 1 }], rule: null, lastTime: null }
        : id === 't2'
          ? { matches: [], rule: { ruleId: 'r1', name: 'Fuel', accountId: FUEL, accountCode: '6200', accountName: 'Vehicle fuel', vendorId: null, clientId: null, departmentId: null }, lastTime: null }
          : { matches: [], rule: null, lastTime: null },
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
  });

  it('a decided transaction can be undone', async () => {
    const done = txn({ id: 't9', status: 'CATEGORIZED', category: { accountId: FUEL, code: '6200', name: 'Vehicle fuel', transfer: false }, ruleName: 'Fuel', journalEntryId: 'e9' });
    api.listBankTransactions.mockImplementation(async (_id: string, q: { status?: string }) =>
      q.status === 'CATEGORIZED' ? { transactions: [done], counts: { UNMATCHED: 0, MATCHED: 0, CATEGORIZED: 1, EXCLUDED: 0 } } : { transactions: [], counts: { UNMATCHED: 0, MATCHED: 0, CATEGORIZED: 1, EXCLUDED: 0 } },
    );
    api.undoTxn.mockResolvedValue({ transaction: { ...done, status: 'UNMATCHED' } });
    const user = userEvent.setup();
    renderAccount('FINANCE_ACCOUNTANT', `/books/bank/${FEED}?tab=categorized`);
    expect(await screen.findByText(/6200 Vehicle fuel/)).toBeInTheDocument();
    expect(screen.getByText('Rule: Fuel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Undo/ }));
    await waitFor(() => expect(api.undoTxn).toHaveBeenCalledWith('t9'));
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
