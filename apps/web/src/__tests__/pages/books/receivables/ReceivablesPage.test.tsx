import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReceivablesAgingResponse } from '@alto-people/shared';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  RECEIVABLES_KEY: ['books', 'receivables'],
  getReceivablesAging: vi.fn(),
  listClientPayments: vi.fn(),
  listDepositAccounts: vi.fn(),
  recordClientPayment: vi.fn(),
  undoClientPayment: vi.fn(),
  backfillPosting: vi.fn(),
  getClientReceivables: vi.fn(),
  getPostingGaps: vi.fn(),
  getCollectionsWorklist: vi.fn(),
  getDsoTrend: vi.fn(),
  sendReminderNow: vi.fn(),
  addCollectionNote: vi.fn(),
  autoApply: undefined as unknown,
}));
const clients = vi.hoisted(() => ({ pauseClientDunning: vi.fn(), resumeClientDunning: vi.fn() }));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...clients }));
vi.mock('@/lib/books/receivablesApi', async (orig) => {
  const real = await orig<typeof import('@/lib/books/receivablesApi')>();
  return { ...api, autoApply: real.autoApply };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/Toaster', () => ({ toast }));

import { ReceivablesPage } from '@/pages/books/receivables/ReceivablesPage';
import { autoApply } from '@/lib/books/receivablesApi';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const zero = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
const stmt = (id: string, number: number, open: number, dueOn: string, daysPastDue: number) => ({
  statementId: id, clientId: C1, clientName: 'Coastal Resort', number, periodStart: '2026-09-01', periodEnd: '2026-09-07', dueOn, daysPastDue, bucket: daysPastDue > 30 ? 'days31to60' : daysPastDue > 0 ? 'days1to30' : 'current', total: open, applied: 0, open,
}) as ReceivablesAgingResponse['statements'][number];

const AGING: ReceivablesAgingResponse = {
  asOf: '2026-10-20',
  rows: [{ clientId: C1, clientName: 'Coastal Resort', buckets: { ...zero, days31to60: 1000, current: 500 }, open: 1500, statements: 2, oldestDaysPastDue: 35, unapplied: 0 }],
  statements: [stmt(S1, 1, 1000, '2026-09-15', 35), stmt(S2, 2, 500, '2026-10-30', -10)],
  totals: { buckets: { ...zero, days31to60: 1000, current: 500 }, open: 1500 },
};

const item = (st: ReturnType<typeof stmt>, extra: Record<string, unknown>) => ({ ...st, reminderStage: 0, lastReminderAt: null, nextReminderOn: null, paused: false, pauseNote: null, contactEmail: 'ap@coastal.test', lastNote: null, nextActionOn: '2026-10-20', ...extra });
const WORKLIST = {
  asOf: '2026-10-20',
  items: [
    item(stmt(S1, 1, 1000, '2026-09-15', 35), { reminderStage: 3, lastReminderAt: '2026-09-22T12:00:00Z', nextReminderOn: '2026-09-29' }),
    item(stmt(S2, 2, 500, '2026-10-30', -10), { nextReminderOn: '2026-10-27', nextActionOn: '2026-10-27' }),
  ],
  totals: { open: 1500, statements: 2 },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getReceivablesAging.mockResolvedValue(AGING);
  api.listClientPayments.mockResolvedValue({ payments: [] });
  api.listDepositAccounts.mockResolvedValue({ accounts: [{ id: 'acc-op', code: '1000', name: 'Operating checking', isDefault: true, forChecks: false }, { id: 'acc-ud', code: '1050', name: 'Undeposited funds', isDefault: false, forChecks: true }] });
  api.recordClientPayment.mockResolvedValue({ payment: { amount: 1200, clientName: 'Coastal Resort', unapplied: 0 } });
  api.getCollectionsWorklist.mockResolvedValue(WORKLIST);
  api.getDsoTrend.mockResolvedValue({ months: [{ key: '2026-09', label: 'Sep 26', days: 31, statements: 2, collected: 2400 }, { key: '2026-10', label: 'Oct 26', days: 26, statements: 1, collected: 900 }] });
  api.sendReminderNow.mockResolvedValue({ stage: 3, recipients: 2 });
  api.addCollectionNote.mockResolvedValue({ note: { id: 'n1' } });
  api.backfillPosting.mockResolvedValue({ payrollRuns: 3, statements: 2, taxPayments: 0, taxDeposits: 0, garnishmentRemittances: 0, wageAdvances: 0, failed: [] });
});

describe('Receivables', () => {
  it('shows what clients owe by age, with the late money called out', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables');
    expect(await screen.findByRole('link', { name: 'Coastal Resort' })).toHaveAttribute('href', `/clients/${C1}?tab=statements`);
    expect(screen.getByText('Owed to you').parentElement).toHaveTextContent('$1,500.00');
    expect(screen.getByText('Past due').parentElement).toHaveTextContent('$1,000.00');
  });

  it('records a payment applied oldest first, and the deposit account follows the method', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables');
    await user.click(await screen.findByRole('button', { name: /Record a payment/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount received'), '1200');
    await waitFor(() => expect(within(dialog).getByLabelText('Amount for statement 1')).toHaveValue('1000.00'));
    expect(within(dialog).getByLabelText('Amount for statement 2')).toHaveValue('200.00');
    await user.type(within(dialog).getByLabelText('Reference'), 'ACH 4471');
    await user.click(within(dialog).getByRole('button', { name: 'Record $1,200.00' }));
    await waitFor(() =>
      expect(api.recordClientPayment).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: C1, amount: 1200, method: 'ACH', reference: 'ACH 4471', depositAccountId: 'acc-op', applications: [{ statementId: S1, amount: 1000 }, { statementId: S2, amount: 200 }] }),
      ),
    );
  });

  it('“Full balance” fills what the client owes in one click', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables');
    await user.click(await screen.findByRole('button', { name: /Record a payment/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Full balance · $1,500.00' }));
    expect(within(dialog).getByLabelText('Amount received')).toHaveValue('1500.00');
    await waitFor(() => expect(within(dialog).getByLabelText('Amount for statement 2')).toHaveValue('500.00'));
    // Once it's the full balance, the chip has done its job.
    expect(within(dialog).queryByRole('button', { name: /Full balance/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Record $1,500.00' }));
    await waitFor(() => expect(api.recordClientPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: 1500, applications: [{ statementId: S1, amount: 1000 }, { statementId: S2, amount: 500 }] })));
  });

  it('posts history with a summary of what it did; read-only roles see no buttons', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables');
    await user.click(await screen.findByRole('button', { name: /Post history/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Posted 3 payroll runs, 2 statements.'));
    unmount();
    renderAs('EXECUTIVE_CHAIRMAN', <ReceivablesPage />, '/books/receivables');
    await screen.findByRole('link', { name: 'Coastal Resort' });
    expect(screen.queryByRole('button', { name: /Record a payment/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Post history/ })).toBeNull();
  });
});

describe('collections (finance walk 7)', () => {
  it('lists open statements by when the next action is due, sends a reminder now and logs a promise', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables?view=collections');
    const grid = await screen.findByRole('table', { name: /Collections/ });
    const rows = within(grid).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('No. 0001');
    expect(rows[0]).toHaveTextContent('7 days late · sent');
    expect(rows[0]).toHaveTextContent('Today');
    expect(rows[1]).toHaveTextContent('No. 0002');
    // The worklist total is the sum of its rows.
    expect(WORKLIST.items.reduce((a, i) => a + i.open, 0)).toBe(WORKLIST.totals.open);

    await user.click(within(rows[0]!).getByRole('button', { name: /Send reminder now/ }));
    await waitFor(() => expect(api.sendReminderNow).toHaveBeenCalledWith(C1, S1));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Reminder sent to Coastal Resort \(2 people\)/));

    await user.click(within(rows[0]!).getByRole('button', { name: /Log promise/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Pays by'), '2026-10-31');
    await user.type(within(dialog).getByLabelText('Note'), 'Check Friday');
    await user.click(within(dialog).getByRole('button', { name: 'Log promise' }));
    await waitFor(() => expect(api.addCollectionNote).toHaveBeenCalledWith(C1, { kind: 'PROMISE', note: 'Check Friday', statementId: S1, promisedOn: '2026-10-31', promisedAmount: 1000 }));
  });

  it('the aging view shows what each client owes by age and the days-to-collect trend', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ReceivablesPage />, '/books/receivables');
    expect(await screen.findByRole('img', { name: /1 client with money open; 1 past due\. Most owed: Coastal Resort, \$1,500\.00\./ })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Days to collect over the last 2 months: Sep 26 31, Oct 26 26\./ })).toBeInTheDocument();
  });
});

describe('autoApply', () => {
  it('fills the oldest due first and stops at the amount', () => {
    expect(autoApply(AGING.statements, 120000)).toEqual({ [S1]: 100000, [S2]: 20000 });
    expect(autoApply(AGING.statements, 50000)).toEqual({ [S1]: 50000 });
  });
});
