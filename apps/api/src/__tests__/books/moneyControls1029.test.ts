import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountBalance, accountByKey, postEntry } from '../../lib/books/ledger.js';
import { postStatement } from '../../lib/books/posting/statements.js';
import { flushPendingBooks } from '../../lib/books/posting/common.js';
import { payrollTaxTies } from '../../lib/books/close/checklist.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Deep audit 2026-10-29 — the controls on top of the books' arithmetic:
 *
 *   MONEY-4  "Tie payroll liabilities" compares like with like: each tax
 *            payable on the books against the tax desk's own liabilities of
 *            that kind (state unemployment against state unemployment), not
 *            every tax account against Form 941/FUTA deposits.
 *   MONEY-5  "Reconcile bank and card accounts" fails while a ledger bank
 *            account has activity and no feed to reconcile it against.
 *   MONEY-3  Statements marked paid with no payment: the Books warning names
 *            that cause (the books are HIGHER), and its button records the
 *            payments, so the books and the statements agree.
 *   MONEY-18 An overdrawn bank account is named, with where to move money from.
 *   MONEY-19 Profit this month compares with last month to the same day.
 *   MONEY-8  Receivables' figure is "Average days to pay" (finalized → paid).
 *
 *   Today is Thursday Oct 29, 2026.
 */

const NOW = new Date('2026-10-29T16:00:00.000Z');
const DAY = 86_400_000;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function people() {
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { fin, a: await loginAs(agent(), fin.email) };
}

const task = (body: { tasks: Array<{ key: string }> }, key: string) => body.tasks.find((t) => t.key === key) as { key: string; status: string; passing: boolean | null; summary: string; items: Array<{ label: string; link: string }> };

async function finalStatement(clientId: string, o: { amount: number; number: number; finalizedAt: Date; paidAt?: Date }) {
  const periodStart = new Date(o.finalizedAt.getTime() - 8 * DAY);
  const st = await prisma.clientStatement.create({
    data: {
      clientId,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + 6 * DAY),
      status: 'FINAL',
      number: o.number,
      finalizedAt: o.finalizedAt,
      dueAt: new Date(o.finalizedAt.getTime() + 30 * DAY),
      snapshot: { totals: { amount: o.amount, hours: 10, regularHours: 10, otHours: 0 }, lines: [], stores: [] },
    },
  });
  await postStatement(prisma, st.id);
  // The way seeded and older data marked statements paid: the date only, no payment.
  if (o.paidAt) await prisma.clientStatement.update({ where: { id: st.id }, data: { paidAt: o.paidAt, paymentRef: 'ACH 4471' } });
  return st;
}

describe('MONEY-4: payroll liabilities tie agency by agency', () => {
  it('state unemployment on the books ties to the desk’s open state unemployment liability (it never could against TaxDeposit)', async () => {
    const p = await people();
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'EMPLOYER_TAX_DIRECT', debit: 1728.36 }, { account: 'SUTA_PAYABLE', credit: 1728.36 }] });
    await prisma.taxLiability.create({ data: { kind: 'STATE_UNEMPLOYMENT', jurisdiction: 'FL', periodLabel: '2026-Q4', liabilityDate: new Date('2026-10-09'), dueDate: new Date('2027-02-01'), amount: 1728.36, breakdown: { unemployment: 1728.36 } } });
    const t = task((await p.a.get('/books/close/2026-10')).body, 'payroll_liabilities');
    expect(t).toMatchObject({ passing: true });
    expect(t.summary).toBe('Tax liabilities on the books ($1,728.36) equal what the tax desk still owes ($1,728.36), agency by agency.');
  });

  it('a mismatch names the agency, both figures, and the tax desk — not Receivables', async () => {
    const p = await people();
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'EMPLOYER_TAX_DIRECT', debit: 864.58 }, { account: 'SUTA_PAYABLE', credit: 864.58 }] });
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 500 }, { account: 'FIT_PAYABLE', credit: 500 }] });
    await prisma.taxLiability.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q4', liabilityDate: new Date('2026-10-09'), dueDate: new Date('2026-10-14'), amount: 500, breakdown: { federalIncomeTax: 500 } } });
    const t = task((await p.a.get('/books/close/2026-10')).body, 'payroll_liabilities');
    expect(t.passing).toBe(false);
    expect(t.summary).toBe('State unemployment and programs: $864.58 on the books, $0.00 owed on the tax desk.');
    expect(t.items).toEqual([{ label: expect.stringMatching(/^State unemployment and programs: \$864\.58 more on the books than the tax desk owes/), link: '/payroll/taxes?tab=deposits' }]);
    expect(JSON.stringify(t.items)).not.toContain('/books/receivables');
  });

  it('a liability paid after month end was still owed at month end, as the ledger sees it', async () => {
    await postEntry(prisma, { date: '2026-09-25', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 300 }, { account: 'FIT_PAYABLE', credit: 300 }] });
    const pay = await prisma.taxPayment.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q3', amount: 300, dueDate: new Date('2026-10-02'), method: 'EFTPS', status: 'PAID', paidAt: new Date('2026-10-02T15:00:00Z') } });
    await prisma.taxLiability.create({ data: { kind: 'FEDERAL_WITHHOLDING', jurisdiction: 'US', periodLabel: '2026-Q3', liabilityDate: new Date('2026-09-25'), dueDate: new Date('2026-10-02'), amount: 300, breakdown: { federalIncomeTax: 300 }, status: 'PAID', paymentId: pay.id } });
    const ties = await payrollTaxTies(prisma, ALTO_TENANT_ID, new Date('2026-09-30T00:00:00Z'));
    expect(ties.find((t) => t.kind === 'FEDERAL_WITHHOLDING')).toMatchObject({ ledger: 30000, desk: 30000 });
  });
});

describe('MONEY-5: no bank feed is not "reconciled"', () => {
  it('fails both bank steps for a ledger bank account with activity and no feed, and says what to do', async () => {
    const p = await people();
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 3908.97 }, { account: 'CASH_PAYROLL', credit: 3908.97 }] });
    const body = (await p.a.get('/books/close/2026-10')).body;
    const rec = task(body, 'bank_reconciled');
    expect(rec.passing).toBe(false);
    expect(rec.summary).toBe('1 account with activity and no bank feed to reconcile it.');
    expect(rec.items[0]).toMatchObject({ label: expect.stringMatching(/^1010 Payroll checking: 1 entry this month and no bank feed/), link: '/books/bank' });
    expect(task(body, 'bank_reviewed').passing).toBe(false);
    // Reconciled by hand: skipped with a note, on the record.
    const skipped = await p.a.post('/books/close/2026-10/tasks/bank_reconciled').send({ status: 'SKIPPED', note: 'Reconciled Payroll checking to the October statement by hand.' });
    expect(task(skipped.body, 'bank_reconciled').status).toBe('SKIPPED');
  });

  it('a month with no bank activity at all still passes', async () => {
    const p = await people();
    const body = (await p.a.get('/books/close/2026-10')).body;
    expect(task(body, 'bank_reconciled')).toMatchObject({ passing: true, summary: 'No bank or card account had activity this month.' });
  });
});

describe('MONEY-3/18/19/8: the Books overview and Receivables say what is true', () => {
  it('statements marked paid with no payment: the warning names that cause, and one press records the payments', async () => {
    const p = await people();
    const client = await createClient('Coastal Resort');
    await finalStatement(client.id, { amount: 1200, number: 1081, finalizedAt: new Date('2026-10-02T15:00:00Z'), paidAt: new Date('2026-10-09T02:30:00Z') });
    await finalStatement(client.id, { amount: 800, number: 1090, finalizedAt: new Date('2026-10-23T15:00:00Z') });
    await flushPendingBooks();

    const before = (await p.a.get('/books/overview')).body;
    expect(before.receivables).toMatchObject({ total: 2000, openOnStatements: 800, markedPaidWithoutPayment: { count: 1, amount: 1200 }, notInBooks: { count: 0, amount: 0 } });
    const warn = before.needsYou.find((n: { key: string }) => n.key === 'ar-paid-unrecorded');
    expect(warn.label).toBe('1 statement was marked paid ($1,200.00) with no payment in the books, so the books still count it as owed: $2,000.00 against $800.00 on open statements');
    expect(before.needsYou.find((n: { key: string }) => n.key === 'ar-unposted')).toBeUndefined();
    // Receivables: never "nothing collected" beside a paid statement.
    const dso = (await p.a.get('/books/receivables/dso')).body;
    expect(dso.markedPaidThisMonth).toEqual({ statements: 1, amount: 1200 });

    const settled = await p.a.post('/books/receivables/settle-marked-paid');
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ payments: 1, amount: 1200, failed: [] });
    const payment = await prisma.clientPayment.findFirstOrThrow({ include: { applications: true } });
    // Dated the company day it was marked paid (Oct 8, Eastern), not UTC's Oct 9; the statement keeps its own date and reference.
    expect(payment.receivedOn.toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(payment).toMatchObject({ method: 'OTHER', reference: 'ACH 4471' });
    expect(Number(payment.applications[0]!.amount)).toBe(1200);
    expect((await prisma.clientStatement.findFirstOrThrow({ where: { number: 1081 } })).paymentRef).toBe('ACH 4471');

    const after = (await p.a.get('/books/overview')).body;
    expect(after.receivables).toMatchObject({ total: 800, openOnStatements: 800, markedPaidWithoutPayment: { count: 0, amount: 0 } });
    expect(after.needsYou.some((n: { key: string }) => n.key.startsWith('ar-'))).toBe(false);
    // Idempotent.
    expect((await p.a.post('/books/receivables/settle-marked-paid')).body).toMatchObject({ payments: 0 });
    expect((await p.a.get('/books/receivables/dso')).body.collectedThisMonth).toEqual({ amount: 1200, payments: 1 });
  });

  it('Post history records them too (the same fix from the close checklist)', async () => {
    const p = await people();
    const client = await createClient('Harbor Grill');
    await finalStatement(client.id, { amount: 640, number: 1070, finalizedAt: new Date('2026-10-02T15:00:00Z'), paidAt: new Date('2026-10-12T16:00:00Z') });
    await flushPendingBooks();
    expect(task((await p.a.get('/books/close/2026-10')).body, 'nothing_to_post').items.map((i) => i.label)).toContain('Statement No. 1070 was marked paid Oct 12, 2026 ($640.00) with no payment in the books');
    const r = await p.a.post('/books/receivables/backfill').send({});
    expect(r.body.clientPayments).toBe(1);
    expect(await accountBalance(prisma, (await accountByKey(prisma, 'AR')).id, '2099-12-31')).toBe(0);
  });

  it('names an overdrawn bank account and where to move money from; profit compares month to date', async () => {
    const p = await people();
    await postEntry(prisma, { date: '2026-09-02', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 20000 }, { account: 'OWNER_EQUITY', credit: 20000 }] });
    await postEntry(prisma, { date: '2026-10-09', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 3908.97 }, { account: 'CASH_PAYROLL', credit: 3908.97 }] });
    await postEntry(prisma, { date: '2026-09-30', source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 1000 }, { account: 'CASH_OPERATING', credit: 1000 }] });
    const o = (await p.a.get('/books/overview')).body;
    const alert = o.needsYou.find((n: { key: string }) => n.key.startsWith('overdrawn-'));
    expect(alert).toMatchObject({ tone: 'alert', label: 'Payroll checking is overdrawn by $3,908.97 — move $3,908.97 from Operating checking before anything else clears' });
    expect(o.needsYou[0].key).toBe(alert.key);
    // Oct 1–29 against Sep 1–29: the Sep 30 wages are outside last month to date.
    expect(o.profit.lastMonthToDate).toMatchObject({ from: '2026-09-01', to: '2026-09-29' });
    expect(o.profit.lastMonthToDate.totals.netIncome).toBe(0);
    expect(o.profit.month.netIncome).toBe(-3908.97);
  });

  it('Receivables’ collection speed is “Average days to pay” — finalized to paid (MONEY-8); days to collect (DSO) is the executive pages’', async () => {
    const p = await people();
    const client = await createClient('Seaside Inn');
    await finalStatement(client.id, { amount: 6000, number: 1, finalizedAt: new Date('2026-09-10T15:00:00Z'), paidAt: new Date('2026-09-17T15:00:00Z') });
    await finalStatement(client.id, { amount: 3000, number: 2, finalizedAt: new Date('2026-10-20T15:00:00Z') });
    const dso = (await p.a.get('/books/receivables/dso')).body;
    expect(dso.last90).toEqual({ days: 7, statements: 1 });
    expect(dso.daysToCollect).toBeUndefined();
  });
});
