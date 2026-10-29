import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey } from '../../lib/books/ledger.js';
import { makeDueRecurringBills } from '../../lib/books/payables/recurring.js';
import { booksSweepRunning, runBooksJobs } from '../../lib/books/jobs.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Deep audit 2026-10-29 CODE-23: the books sweep had no in-flight guard and
 * recurring bills were check-then-create, so a slow QuickBooks pull let two
 * runs each make the same month's bill. Now the sweep runs once per tenant
 * at a time, and (recurringId, billDate) is unique: two runs racing make one
 * bill.
 */

const NOW = new Date('2026-10-19T15:00:00.000Z');

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

async function template() {
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  const a = await loginAs(agent(), fin.email);
  const v = await a.post('/books/vendors').send({ name: 'Harbor Properties', termsDays: 15 });
  const rent = await accountByKey(prisma, 'RENT');
  const r = await a.post('/books/recurring-bills').send({ vendorId: v.body.vendor.id, name: 'Yard rent', frequency: 'MONTHLY', nextDate: '2026-08-31', lines: [{ accountId: rent.id, amount: 1800 }] });
  expect(r.status).toBe(201);
  return r.body.recurring.id as string;
}

describe('recurring bills under a race', () => {
  it('two runs at once make each date’s bill once', async () => {
    const id = await template();
    const [x, y] = await Promise.all([makeDueRecurringBills(prisma, NOW), makeDueRecurringBills(prisma, NOW)]);
    const bills = await prisma.bill.findMany({ where: { recurringId: id }, orderBy: { billDate: 'asc' } });
    expect(bills.map((b) => b.billDate.toISOString().slice(0, 10))).toEqual(['2026-08-31', '2026-09-30']);
    expect(x + y).toBe(2);
  });

  it('the database refuses a second bill for the same template and date', async () => {
    const id = await template();
    await makeDueRecurringBills(prisma, NOW);
    const first = await prisma.bill.findFirstOrThrow({ where: { recurringId: id } });
    await expect(prisma.bill.create({ data: { vendorId: first.vendorId, billDate: first.billDate, dueDate: first.dueDate, total: 1, balance: 1, recurringId: id } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the books sweep', () => {
  it('runs once per tenant at a time: a second call while one runs returns at once', async () => {
    await template();
    const first = runBooksJobs(prisma, NOW);
    expect(booksSweepRunning(ALTO_TENANT_ID)).toBe(true);
    await runBooksJobs(prisma, NOW); // returns without a second sweep
    await first;
    expect(booksSweepRunning(ALTO_TENANT_ID)).toBe(false);
    expect(await prisma.bill.count()).toBe(2);
  });
});

/**
 * Deep audit 2026-10-29 CODE-28: the QuickBooks outbox named each row with
 * its own lookups — up to 200 × 1–2 sequential queries. Now one query per
 * record type for the whole page, with the same words.
 */
describe('the QuickBooks outbox list', () => {
  it('names every row (one lookup per record type, lib describeLocals)', async () => {
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), fin.email);
    const names = ['Shell Fleet', 'Gulf Coast Fuel', 'Harbor Properties'];
    const vendors = [];
    for (const name of names) vendors.push((await a.post('/books/vendors').send({ name, termsDays: 15 })).body.vendor as { id: string });
    const client = await prisma.client.create({ data: { name: 'Coastal Resort', industry: 'hospitality', status: 'ACTIVE' } });
    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const pay = await prisma.clientPayment.create({ data: { clientId: client.id, receivedOn: new Date('2026-10-16'), amount: 1200, method: 'ACH', depositAccountId: cash.id } });
    await prisma.qboOutbox.deleteMany({});
    for (const v of vendors) await prisma.qboOutbox.create({ data: { localType: 'Vendor', localId: v.id, op: 'UPSERT' } });
    await prisma.qboOutbox.create({ data: { localType: 'ClientPayment', localId: pay.id, op: 'UPSERT' } });
    await prisma.qboOutbox.create({ data: { localType: 'Bill', localId: '00000000-0000-4000-8000-00000000b111', op: 'DELETE' } });

    const r = await a.get('/books/quickbooks/outbox');
    expect(r.status).toBe(200);
    const labels = (r.body.rows as Array<{ label: string }>).map((x) => x.label).sort();
    // Every type on one page reads its own words, a missing record its fallback.
    expect(labels).toEqual(['A bill', 'Payment from Coastal Resort, $1200.00', ...names.map((n) => `Vendor ${n}`)].sort());
  });
});
