import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClientStatement, ReceivablesAgingResponse } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';
import { renderAs } from '../hrPack/harness';

const clients = vi.hoisted(() => ({
  listClientStatements: vi.fn(),
  getClientDunning: vi.fn(),
  markClientStatementPaid: vi.fn(),
}));
vi.mock('@/lib/clientsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/clientsApi')>()), ...clients }));
const books = vi.hoisted(() => ({ getReceivablesAging: vi.fn(), listDepositAccounts: vi.fn(), recordClientPayment: vi.fn() }));
vi.mock('@/lib/books/receivablesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/books/receivablesApi')>()), ...books }));

import { StatementsSection, statementMoney } from '@/pages/clients/StatementsSection';

/**
 * Deep audit 2026-10-29:
 *   MONEY-17  The client tab's payment is the full Record-payment dialog
 *             (date, method, account, amount) for the people who keep the
 *             books; "Mark paid" for everyone else asks when and how the
 *             money came — never "today, Other" by default.
 *   CODE-14   "Past due" reads the local calendar day, not UTC's.
 *   MONEY-26  The statement's rows add up to the total it prints.
 */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const FINAL = '00000000-0000-4000-8000-0000000000f1';
const sla = { publishedShifts: 0, assignedShifts: 0, fillRatePct: null, punctualPct: null, noShows: 0, pendingEntries: 0 };

function statement(over: Partial<ClientStatement> = {}): ClientStatement {
  return {
    id: FINAL,
    clientId: C1,
    periodStart: '2026-10-05',
    periodEnd: '2026-10-11',
    number: 7,
    status: 'FINAL',
    snapshot: {
      clientName: 'Harbor Grill',
      periodStart: '2026-10-05',
      periodEnd: '2026-10-11',
      lines: [
        { label: 'Associate — Cook — regular', hours: 40, rate: 25, amount: 1000 },
        { label: 'Associate — Cook — overtime (1.5×)', hours: 2.5, rate: 37.5, amount: 93.75 },
      ],
      stores: [],
      adjustments: [{ label: 'Retro pay rebilled', basis: 'Sep 26 – Oct 2', hours: 4, amount: 12 }],
      totals: { hours: 42.5, regularHours: 40, otHours: 2.5, amount: 1182.35, hoursAmount: 1093.75, adjustmentsAmount: 12, subtotal: 1105.75, salesTaxRatePct: 7, salesTax: 76.6 },
      sla,
    },
    finalizedAt: '2026-10-12T12:00:00.000Z',
    finalizedByEmail: 'fin@alto.test',
    paidAt: null,
    dueAt: ymdLocal(),
    ...over,
  } as ClientStatement;
}

const AGING: ReceivablesAgingResponse = {
  asOf: '2026-10-21',
  rows: [{ clientId: C1, clientName: 'Harbor Grill', buckets: { current: 1182.35, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 }, open: 1182.35, statements: 1, oldestDaysPastDue: 0, unapplied: 0 }],
  statements: [{ statementId: FINAL, clientId: C1, clientName: 'Harbor Grill', number: 7, periodStart: '2026-10-05', periodEnd: '2026-10-11', dueOn: '2026-10-14', daysPastDue: 0, bucket: 'current', total: 1182.35, applied: 0, open: 1182.35 }],
  totals: { buckets: { current: 1182.35, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 }, open: 1182.35 },
};

beforeEach(() => {
  vi.clearAllMocks();
  clients.listClientStatements.mockResolvedValue({ statements: [statement()] });
  clients.getClientDunning.mockResolvedValue({ poNumber: null, paymentTermsDays: 30, salesTaxable: true, salesTaxRatePct: 7, paused: null, reminders: [] });
  clients.markClientStatementPaid.mockResolvedValue(statement({ paidAt: '2026-10-20T12:00:00.000Z' }));
  books.getReceivablesAging.mockResolvedValue(AGING);
  books.listDepositAccounts.mockResolvedValue({ accounts: [{ id: 'acc-op', code: '1000', name: 'Operating checking', isDefault: true, forChecks: false }, { id: 'acc-ud', code: '1050', name: 'Undeposited funds', isDefault: false, forChecks: true }] });
  books.recordClientPayment.mockResolvedValue({ payment: { amount: 1182.35, clientName: 'Harbor Grill', unapplied: 0 } });
});

describe('recording a payment from the client’s Statements tab (MONEY-17)', () => {
  it('the people who keep the books get the full Record-payment dialog, prefilled with the statement', async () => {
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <StatementsSection clientId={C1} />, `/clients/${C1}?tab=statements`);
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record a payment' });
    expect(within(dialog).getByLabelText('Amount received')).toHaveValue('1182.35');
    expect(within(dialog).getByLabelText('Amount for statement 7')).toHaveValue('1182.35');
    await user.click(within(dialog).getByRole('button', { name: 'Record $1,182.35' }));
    await waitFor(() => expect(books.recordClientPayment).toHaveBeenCalledWith(expect.objectContaining({ clientId: C1, amount: 1182.35, applications: [{ statementId: FINAL, amount: 1182.35 }] })));
    expect(clients.markClientStatementPaid).not.toHaveBeenCalled();
  });

  it('“Mark paid” (without the books) asks when and how the money came', async () => {
    const user = userEvent.setup();
    renderAs('OPERATIONS_MANAGER', <StatementsSection clientId={C1} />, `/clients/${C1}?tab=statements`);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record payment' });
    expect(within(dialog).getByLabelText(/Received on/)).toHaveValue(ymdLocal());
    await user.selectOptions(within(dialog).getByLabelText('How'), 'CHECK');
    await user.type(within(dialog).getByLabelText('Payment reference (optional)'), 'Check 1042');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(clients.markClientStatementPaid).toHaveBeenCalledWith(C1, FINAL, 'Check 1042', { receivedOn: ymdLocal(), method: 'CHECK' }));
  });
});

describe('the client’s hours sign-off on each statement (portal)', () => {
  it('a flagged week is a caution chip linking to the sign-off card; signed weeks a quiet line; nothing without the portal', async () => {
    clients.listClientStatements.mockResolvedValue({
      statements: [
        statement({ hoursSignOff: { signed: 1, flagged: 1 } }),
        statement({ id: '00000000-0000-4000-8000-0000000000f2', number: 6, periodStart: '2026-09-28', periodEnd: '2026-10-04', hoursSignOff: { signed: 2, flagged: 0 } }),
        statement({ id: '00000000-0000-4000-8000-0000000000f3', number: 5, periodStart: '2026-09-21', periodEnd: '2026-09-27' }),
      ],
    });
    renderAs('FINANCE_ACCOUNTANT', <StatementsSection clientId={C1} />, `/clients/${C1}?tab=statements`);
    const chip = await screen.findByRole('link', { name: /1 week flagged/ });
    expect(chip).toHaveAttribute('href', `/clients/${C1}?tab=overview`);
    expect(screen.getAllByText('Hours signed by the client')).toHaveLength(1);
  });
});

describe('the statement reads true', () => {
  it('a statement due today is due, not past due (CODE-14: the local day)', async () => {
    renderAs('FINANCE_ACCOUNTANT', <StatementsSection clientId={C1} />, `/clients/${C1}?tab=statements`);
    await screen.findByRole('button', { name: 'Record payment' });
    expect(screen.queryByText(/Past due since/)).toBeNull();
    expect(screen.getByText(/^Due /)).toBeInTheDocument();
  });

  it('the rows add up to the total it prints: services, adjustments, subtotal, tax (MONEY-26)', () => {
    const m = statementMoney(statement().snapshot);
    expect(m).toEqual({ services: 1093.75, adjustments: 12, subtotal: 1105.75, salesTax: 76.6, salesTaxRate: 7, total: 1182.35 });
    expect(Math.round((m.services + m.adjustments + m.salesTax) * 100)).toBe(Math.round(m.total * 100));
  });
});
