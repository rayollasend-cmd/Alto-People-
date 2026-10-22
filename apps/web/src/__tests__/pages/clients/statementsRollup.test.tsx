import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReceivablesAgingResponse } from '@alto-people/shared';
import type { StatementsRollup } from '@/lib/clientsApi';
import { renderAs } from '../hrPack/harness';

const clients = vi.hoisted(() => ({
  getStatementsRollup: vi.fn(),
  finalizeClientStatement: vi.fn(),
  generateDueStatements: vi.fn(),
  markClientStatementPaid: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...clients }));
const books = vi.hoisted(() => ({ getReceivablesAging: vi.fn(), listDepositAccounts: vi.fn(), recordClientPayment: vi.fn() }));
vi.mock('@/lib/books/receivablesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/books/receivablesApi')>()), ...books }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/confirm', async (orig) => ({ ...(await orig<typeof import('@/lib/confirm')>()), useConfirm: () => confirm }));

import { ClientStatementsRollup, deltaOf } from '@/pages/clients/ClientStatementsRollup';

/**
 * Finance walk 6 — closing the statement week with the context to decide:
 * due date, days late, the change against the last statement (over 20%
 * flagged), the weeks no statement covers, Finalize on a draft row, and
 * Record payment through the Books payment dialog, prefilled.
 */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const DRAFT = '00000000-0000-4000-8000-0000000000d1';
const FINAL = '00000000-0000-4000-8000-0000000000f1';
const sla = { publishedShifts: 0, assignedShifts: 0, fillRatePct: null, punctualPct: null, noShows: 0, pendingEntries: 0 };
const snap = (hours: number, amount: number) => ({ clientName: 'Harbor Grill', periodStart: '', periodEnd: '', lines: [], stores: [], totals: { hours, regularHours: hours, otHours: 0, amount }, sla });

const ROLLUP: StatementsRollup = {
  statements: [
    { id: DRAFT, clientId: C1, clientName: 'Harbor Grill', periodStart: '2026-10-12', periodEnd: '2026-10-18', number: null, status: 'DRAFT', snapshot: snap(52, 1300), finalizedAt: null, finalizedByEmail: null, dueOn: null, daysLate: 0, open: 0, previous: { statementId: FINAL, periodStart: '2026-10-05', hours: 40, amount: 1000 } },
    { id: FINAL, clientId: C1, clientName: 'Harbor Grill', periodStart: '2026-10-05', periodEnd: '2026-10-11', number: 7, status: 'FINAL', snapshot: snap(40, 1000), finalizedAt: '2026-10-12T12:00:00.000Z', finalizedByEmail: 'fin@alto.test', paidAt: null, dueOn: '2026-10-14', daysLate: 7, open: 1000, previous: null },
  ],
  missingWeeks: [{ clientId: C1, clientName: 'Harbor Grill', weekStart: '2026-09-28', hours: 6 }],
};

const AGING: ReceivablesAgingResponse = {
  asOf: '2026-10-21',
  rows: [{ clientId: C1, clientName: 'Harbor Grill', buckets: { current: 0, days1to30: 1000, days31to60: 0, days61to90: 0, over90: 0 }, open: 1000, statements: 1, oldestDaysPastDue: 7, unapplied: 0 }],
  statements: [{ statementId: FINAL, clientId: C1, clientName: 'Harbor Grill', number: 7, periodStart: '2026-10-05', periodEnd: '2026-10-11', dueOn: '2026-10-14', daysPastDue: 7, bucket: 'days1to30', total: 1000, applied: 0, open: 1000 }],
  totals: { buckets: { current: 0, days1to30: 1000, days31to60: 0, days61to90: 0, over90: 0 }, open: 1000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  clients.getStatementsRollup.mockResolvedValue(ROLLUP);
  clients.finalizeClientStatement.mockResolvedValue({ ...ROLLUP.statements[0], status: 'FINAL', number: 8, dueAt: '2026-11-20' });
  books.getReceivablesAging.mockResolvedValue(AGING);
  books.listDepositAccounts.mockResolvedValue({ accounts: [{ id: 'acc-op', code: '1000', name: 'Operating checking', isDefault: true, forChecks: false }] });
  books.recordClientPayment.mockResolvedValue({ payment: { amount: 1000, clientName: 'Harbor Grill', unapplied: 0 } });
});

describe('the statement week close', () => {
  it('shows due, days late and the change against the last statement, flagging over 20%', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ClientStatementsRollup />, '/clients/statements');
    const table = await screen.findByRole('table', { name: 'Client statements' });
    const [, draftRow, finalRow] = within(table).getAllByRole('row');
    expect(draftRow).toHaveTextContent('+12.0h (+30%)');
    expect(draftRow).toHaveTextContent('+$300.00 (+30%)');
    expect(within(draftRow!).getByText('+12.0h (+30%)')).toHaveAttribute('title', 'More than 20% off the last statement');
    expect(finalRow).toHaveTextContent('Oct 14, 2026');
    expect(within(finalRow!).getByText('7')).toBeInTheDocument();
    const banner = screen.getByText(/Missing weeks:/).closest('[role="status"]') as HTMLElement;
    expect(banner).toHaveTextContent('Missing weeks: 1 week has approved time on no statement');
    expect(banner).toHaveTextContent('Harbor Grill · week of Sep 28, 2026 · 6');
  });

  it('finalizes a draft from its row, and records a payment in the Books dialog, prefilled', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <ClientStatementsRollup />, '/clients/statements');
    const table = await screen.findByRole('table', { name: 'Client statements' });
    const [, draftRow, finalRow] = within(table).getAllByRole('row');
    await user.click(within(draftRow!).getByRole('button', { name: /Finalize/ }));
    await waitFor(() => expect(clients.finalizeClientStatement).toHaveBeenCalledWith(C1, DRAFT));

    await user.click(within(finalRow!).getByRole('button', { name: /Record payment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Record a payment' });
    expect(within(dialog).getByLabelText('Amount received')).toHaveValue('1000.00');
    expect(within(dialog).getByLabelText('Amount for statement 7')).toHaveValue('1000.00');
    await user.click(within(dialog).getByRole('button', { name: 'Record $1,000.00' }));
    await waitFor(() => expect(books.recordClientPayment).toHaveBeenCalledWith(expect.objectContaining({ clientId: C1, amount: 1000, depositAccountId: 'acc-op', applications: [{ statementId: FINAL, amount: 1000 }] })));
  });

  it('deltaOf: the change and whether it is worth a look', () => {
    expect(deltaOf(52, 40)).toEqual({ diff: 12, pct: 0.3, flag: true });
    expect(deltaOf(42, 40)).toMatchObject({ diff: 2, flag: false });
    expect(deltaOf(10, null)).toBeNull();
  });
});
