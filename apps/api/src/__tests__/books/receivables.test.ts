import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey } from '../../lib/books/ledger.js';
import { agingReport, bucketFor, recordClientPayment, undoClientPayment } from '../../lib/books/posting/receivables.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { flushPendingBooks } from '../../lib/books/posting/common.js';

/**
 * Receivables: payments apply to statements and mark the ones they finish
 * paid; an undone payment opens them again; aging buckets by days past due;
 * the statements screen's "Mark paid" is a payment through the same path;
 * finalizing a statement puts it in the books.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const bal = async (key: string) => (await accountBalance(prisma, (await accountByKey(prisma, key)).id, '2099-12-31')) + 0;

async function finalStatement(clientId: string, opts: { amount: number; number: number; dueAt: string; periodStart: string }) {
  const s = await prisma.clientStatement.create({
    data: {
      clientId,
      periodStart: new Date(opts.periodStart),
      periodEnd: new Date(new Date(opts.periodStart).getTime() + 6 * 86_400_000),
      status: 'FINAL',
      number: opts.number,
      finalizedAt: new Date(`${opts.periodStart}T12:00:00Z`),
      dueAt: new Date(opts.dueAt),
      snapshot: { totals: { amount: opts.amount }, lines: [], stores: [] },
    },
  });
  await postStatement(prisma, s.id);
  return s;
}

describe('payments against statements', () => {
  it('apply, finish a statement (marked paid), leave the rest open, and undo cleanly', async () => {
    const client = await createClient('Coastal Resort');
    const a = await finalStatement(client.id, { amount: 1000, number: 1, dueAt: '2026-09-15', periodStart: '2026-09-01' });
    const b = await finalStatement(client.id, { amount: 500, number: 2, dueAt: '2026-10-15', periodStart: '2026-09-08' });
    expect(await bal('AR')).toBe(1500);

    const p = await recordClientPayment(prisma, {
      clientId: client.id,
      receivedOn: '2026-10-10',
      amount: 900,
      method: 'ACH',
      reference: 'ACH 4471',
      applications: [{ statementId: a.id, amount: 400 }, { statementId: b.id, amount: 500 }],
      userId: null,
    });
    expect(await bal('AR')).toBe(600);
    expect(await bal('CASH_OPERATING')).toBe(900);
    expect((await prisma.clientStatement.findUniqueOrThrow({ where: { id: b.id } })).paymentRef).toBe('ACH 4471');
    expect((await prisma.clientStatement.findUniqueOrThrow({ where: { id: a.id } })).paidAt).toBeNull();

    const aging = await agingReport(prisma, '2026-10-20');
    expect(aging.rows).toHaveLength(1);
    expect(aging.rows[0]).toMatchObject({ clientName: 'Coastal Resort', open: 60000, statements: 1, oldestDaysPastDue: 35 });
    expect(aging.rows[0]!.buckets.days31to60).toBe(60000);

    // Can't apply more than is open, or more than was paid.
    await expect(recordClientPayment(prisma, { clientId: client.id, receivedOn: '2026-10-11', amount: 700, method: 'ACH', applications: [{ statementId: a.id, amount: 700 }], userId: null })).rejects.toMatchObject({ code: 'over_statement' });
    await expect(recordClientPayment(prisma, { clientId: client.id, receivedOn: '2026-10-11', amount: 100, method: 'ACH', applications: [{ statementId: a.id, amount: 200 }], userId: null })).rejects.toMatchObject({ code: 'over_applied' });

    await undoClientPayment(prisma, p.id, { reason: 'Bounced', userId: null });
    expect(await bal('AR')).toBe(1500);
    expect(await bal('CASH_OPERATING')).toBe(0);
    expect((await prisma.clientStatement.findUniqueOrThrow({ where: { id: b.id } })).paidAt).toBeNull();
    await expect(undoClientPayment(prisma, p.id, { reason: 'Again', userId: null })).rejects.toMatchObject({ code: 'already_undone' });
  });

  it('a check lands in Undeposited funds; money not applied is a credit on the account', async () => {
    const client = await createClient('Harbor Grill');
    await finalStatement(client.id, { amount: 300, number: 1, dueAt: '2026-11-01', periodStart: '2026-10-01' });
    await recordClientPayment(prisma, { clientId: client.id, receivedOn: '2026-10-12', amount: 350, method: 'CHECK', reference: '#1042', applications: [], userId: null });
    expect(await bal('UNDEPOSITED')).toBe(350);
    const aging = await agingReport(prisma, '2026-10-20');
    expect(aging.rows[0]).toMatchObject({ unapplied: 35000, open: 30000 });
    expect(aging.rows[0]!.buckets.current).toBe(30000);
  });

  it('buckets by days past due', () => {
    expect([0, -3, 1, 30, 31, 60, 61, 90, 91].map(bucketFor)).toEqual(['current', 'current', 'days1to30', 'days1to30', 'days31to60', 'days31to60', 'days61to90', 'days61to90', 'over90']);
  });
});

describe('the routes', () => {
  it('finance records and reads; finalize and “Mark paid” on the statements screen go through the books; others are turned away', async () => {
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const fin = await loginAs(agent(), finance.email);
    const client = await createClient('Old Town Diner');

    // Finalizing on the statements screen posts it.
    const draft = await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), snapshot: { totals: { amount: 640, hours: 32, regularHours: 32, otHours: 0 }, lines: [], stores: [] } } });
    expect((await fin.post(`/clients/${client.id}/statements/${draft.id}/finalize`)).status).toBe(200);
    await flushPendingBooks();
    expect(await bal('AR')).toBe(640);

    const aging = await fin.get('/books/receivables?asOf=2026-12-31');
    expect(aging.status).toBe(200);
    expect(aging.body.totals.open).toBe(640);
    expect(aging.body.statements[0]).toMatchObject({ statementId: draft.id, open: 640 });

    const pay = await fin.post('/books/receivables/payments').send({ clientId: client.id, receivedOn: '2026-10-20', amount: 200, method: 'WIRE', reference: 'W-88', applications: [{ statementId: draft.id, amount: 200 }] });
    expect(pay.status).toBe(201);
    expect(pay.body.payment).toMatchObject({ amount: 200, applied: 200, unapplied: 0, clientName: 'Old Town Diner', depositAccount: { code: '1000' } });
    expect((await fin.get(`/books/receivables/clients/${client.id}`)).body).toMatchObject({ balance: 440, openStatements: [{ open: 440 }] });

    // "Mark paid" pays what's left, through the same path.
    const marked = await fin.post(`/clients/${client.id}/statements/${draft.id}/mark-paid`).send({ paymentRef: 'CHK 2001' });
    expect(marked.status).toBe(200);
    expect(marked.body.paymentRef).toBe('CHK 2001');
    expect(await bal('AR')).toBe(0);
    expect(await prisma.clientPayment.count()).toBe(2);
    expect((await fin.get('/books/receivables/payments')).body.payments).toHaveLength(2);

    expect((await fin.delete(`/books/receivables/payments/${pay.body.payment.id}`).send({ reason: 'Entered twice' })).status).toBe(204);
    expect((await fin.get('/books/receivables/payments?includeUndone=true')).body.payments.find((p: { id: string }) => p.id === pay.body.payment.id).undone).toBe(true);

    expect((await fin.get('/books/receivables/gaps?period=2026-10')).body.gaps).toEqual([]);
    expect((await fin.post('/books/receivables/backfill').send({})).body).toMatchObject({ statements: 0, failed: [] });

    const rec = await loginAs(agent(), recruiter.email);
    expect((await rec.get('/books/receivables')).status).toBe(403);
  });
});

describe('GET /books/receivables/dso — the two numbers Receivables leads with', () => {
  it('days to collect over the last 90 days and the cash collected this month, undone payments and older paid statements left out', async () => {
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), fin.email);
    const client = await createClient('Coastal Resort');
    const DAY = 86_400_000;
    const now = Date.now();
    const paidStatement = (n: number, finalizedDaysAgo: number, paidDaysAgo: number) =>
      prisma.clientStatement.create({
        data: { clientId: client.id, periodStart: new Date(Date.UTC(2026, 0, n * 7)), periodEnd: new Date(Date.UTC(2026, 0, n * 7 + 6)), status: 'FINAL', number: n, finalizedAt: new Date(now - finalizedDaysAgo * DAY), paidAt: new Date(now - paidDaysAgo * DAY), snapshot: { totals: { amount: 100 } } },
      });
    // Paid in the last 90 days: 30 and 20 days to collect → 25 on average.
    await paidStatement(1, 40, 10);
    await paidStatement(2, 60, 40);
    // Paid 120 days ago: outside the window.
    await paidStatement(3, 200, 120);
    // Cash this month: two payments, one undone.
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const today = new Date().toISOString().slice(0, 10);
    await prisma.clientPayment.create({ data: { clientId: client.id, receivedOn: new Date(`${today}T00:00:00Z`), amount: 1250.5, method: 'ACH', depositAccountId: cash.id } });
    await prisma.clientPayment.create({ data: { clientId: client.id, receivedOn: new Date(`${today}T00:00:00Z`), amount: 300, method: 'CHECK', depositAccountId: cash.id, voidedAt: new Date() } });
    const r = await a.get('/books/receivables/dso?months=6');
    expect(r.status).toBe(200);
    expect(r.body.last90).toEqual({ days: 25, statements: 2 });
    expect(r.body.collectedThisMonth).toEqual({ amount: 1250.5, payments: 1 });
  });
});
