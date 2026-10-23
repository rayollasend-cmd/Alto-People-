import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey, postEntry } from '../../lib/books/ledger.js';
import { compareAsOf, compareRange, shiftMonths } from '../../lib/books/reports.js';

/**
 * The F500 pass over the ledger's screens (2026-10-22): the chart of
 * accounts carries each account's activity this year, the journal sorts
 * and exports the whole filtered set on the server (not the page on
 * screen), the statements compare to the period before or the year
 * before, and the overview leads with "post history" while the books
 * don't hold it.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function finance() {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return loginAs(agent(), user.email);
}

const entry = (date: string, debit: string, credit: string, amount: number, memo?: string) =>
  postEntry(prisma, { date, source: 'MANUAL', memo: memo ?? null, lines: [{ account: debit, debit: amount }, { account: credit, credit: amount }] });

describe('comparison ranges', () => {
  it('prior: the month, quarter or year before; the same span of days otherwise; yoy: a year earlier', () => {
    expect(compareRange('2026-10-01', '2026-10-31', 'prior')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    // Month to date compares to the same days of last month.
    expect(compareRange('2026-10-01', '2026-10-22', 'prior')).toEqual({ from: '2026-09-01', to: '2026-09-22' });
    expect(compareRange('2026-03-01', '2026-03-31', 'prior')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(compareRange('2026-07-01', '2026-09-30', 'prior')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(compareRange('2026-07-01', '2026-08-15', 'prior')).toEqual({ from: '2026-04-01', to: '2026-05-15' });
    expect(compareRange('2026-01-01', '2026-10-22', 'prior')).toEqual({ from: '2025-01-01', to: '2025-10-22' });
    expect(compareRange('2026-02-01', '2026-04-30', 'prior')).toEqual({ from: '2025-11-01', to: '2026-01-31' });
    expect(compareRange('2026-10-10', '2026-10-19', 'prior')).toEqual({ from: '2026-09-30', to: '2026-10-09' });
    expect(compareRange('2028-02-01', '2028-02-29', 'yoy')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(compareRange('2026-01-01', '2026-10-22', 'yoy')).toEqual({ from: '2025-01-01', to: '2025-10-22' });
    expect(compareAsOf('2026-09-30', 'prior')).toBe('2026-08-31');
    expect(compareAsOf('2026-10-22', 'prior')).toBe('2026-09-22');
    expect(compareAsOf('2026-03-31', 'yoy')).toBe('2025-03-31');
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
  });
});

describe('the chart of accounts', () => {
  it('each account carries its net movement this year, signed like its balance', async () => {
    const f = await finance();
    await entry('2025-12-15', 'RENT', 'CASH_OPERATING', 1000);
    await entry('2026-02-01', 'RENT', 'CASH_OPERATING', 2500);
    await entry('2026-03-01', 'RENT', 'CASH_OPERATING', 2500);
    await entry('2026-03-05', 'CASH_OPERATING', 'OWNER_EQUITY', 10000);
    const rows = (await f.get('/books/accounts?asOf=2026-03-31')).body.accounts as Array<{ systemKey: string | null; balance: number; activityYtd: number }>;
    const by = (k: string) => rows.find((r) => r.systemKey === k)!;
    expect(by('RENT')).toMatchObject({ balance: 6000, activityYtd: 5000 });
    expect(by('CASH_OPERATING')).toMatchObject({ balance: 4000, activityYtd: 5000 });
    expect(by('OWNER_EQUITY')).toMatchObject({ balance: 10000, activityYtd: 10000 });
    expect(by('AR')).toMatchObject({ balance: 0, activityYtd: 0 });
    // As of February, March hasn't happened.
    const feb = (await f.get('/books/accounts?asOf=2026-02-28')).body.accounts as Array<{ systemKey: string | null; activityYtd: number }>;
    expect(feb.find((r) => r.systemKey === 'RENT')!.activityYtd).toBe(2500);
  });
});

describe('the journal', () => {
  it('sorts the whole filtered set on the server, pages it, and exports every match', async () => {
    const f = await finance();
    await entry('2026-10-01', 'RENT', 'CASH_OPERATING', 300, 'Small');
    await entry('2026-10-02', 'RENT', 'CASH_OPERATING', 9000, 'Big');
    await entry('2026-10-03', 'RENT', 'CASH_OPERATING', 50, 'Tiny');
    await entry('2026-10-04', 'UTILITIES', 'CASH_OPERATING', 700, 'Power');

    const newest = await f.get('/books/journal?limit=2');
    expect(newest.body.total).toBe(4);
    expect(newest.body.entries.map((e: { memo: string }) => e.memo)).toEqual(['Power', 'Tiny']);

    // Biggest first across all four, not just the two on the page.
    const big = await f.get('/books/journal?sort=amount&dir=desc&limit=2');
    expect(big.body.entries.map((e: { amount: number }) => e.amount)).toEqual([9000, 700]);
    const page2 = await f.get('/books/journal?sort=amount&dir=desc&limit=2&offset=2');
    expect(page2.body.entries.map((e: { amount: number }) => e.amount)).toEqual([300, 50]);
    const byNumber = await f.get('/books/journal?sort=number&dir=asc&limit=1');
    expect(byNumber.body.entries[0]).toMatchObject({ number: 1, memo: 'Small' });
    expect((await f.get('/books/journal?sort=balance')).status).toBe(400);

    const rent = await accountByKey(prisma, 'RENT');
    const csv = await f.get(`/books/journal.csv?accountId=${rent.id}&sort=amount&dir=asc`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = (csv.text as string).split('\n');
    expect(lines[0]).toBe('No.,Date,Memo,Accounts,From,Status,Amount,Reverses on');
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(['Tiny', 'Small', 'Big']);
    expect(lines[1]).toBe('3,2026-10-03,Tiny,Rent / Operating checking,Manual entry,Posted,50.00,');
  });

  it('the export is the books’: an executive reads it, marketing doesn’t', async () => {
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const { user: marketing } = await createUser({ role: 'MARKETING_MANAGER' });
    expect((await (await loginAs(agent(), exec.email)).get('/books/journal.csv')).status).toBe(200);
    expect((await (await loginAs(agent(), marketing.email)).get('/books/journal.csv')).status).toBe(403);
  });
});

describe('the statements compare', () => {
  it('profit and loss: the period before and the year before, beside this one', async () => {
    const f = await finance();
    const client = await createClient('Seaside Inn');
    const sale = (date: string, amount: number) => postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'AR', debit: amount, clientId: client.id }, { account: 'REVENUE_STAFFING', credit: amount, clientId: client.id }] });
    await sale('2025-09-10', 4000);
    await sale('2026-08-10', 6000);
    await sale('2026-09-10', 10000);
    await entry('2026-08-20', 'RENT', 'CASH_OPERATING', 1500);
    await entry('2026-09-20', 'RENT', 'CASH_OPERATING', 2000);

    const prior = await f.get('/books/reports/profit-and-loss?from=2026-09-01&to=2026-09-30&compare=prior');
    expect(prior.body.totals).toMatchObject({ income: 10000, expenses: 2000, netIncome: 8000 });
    expect(prior.body.compare).toMatchObject({ kind: 'prior', from: '2026-08-01', to: '2026-08-31', totals: { income: 6000, expenses: 1500, netIncome: 4500 } });
    expect(prior.body.compare.sections.income).toEqual([expect.objectContaining({ code: '4000', amount: 6000 })]);

    const yoy = await f.get('/books/reports/profit-and-loss?from=2026-09-01&to=2026-09-30&compare=yoy');
    expect(yoy.body.compare).toMatchObject({ kind: 'yoy', from: '2025-09-01', to: '2025-09-30', totals: { income: 4000, expenses: 0, netIncome: 4000 } });

    // Split columns are their own comparison; and no compare, no compare.
    expect((await f.get('/books/reports/profit-and-loss?from=2026-08-01&to=2026-09-30&columns=month&compare=prior')).body.compare).toBeNull();
    expect((await f.get('/books/reports/profit-and-loss?from=2026-09-01&to=2026-09-30')).body.compare).toBeNull();
    expect((await f.get('/books/reports/profit-and-loss?compare=last')).status).toBe(400);
  });

  it('balance sheet a month earlier, cash flow the period before', async () => {
    const f = await finance();
    await entry('2026-08-05', 'CASH_OPERATING', 'OWNER_EQUITY', 20000);
    await entry('2026-09-05', 'CASH_OPERATING', 'OWNER_EQUITY', 5000);
    await entry('2026-09-15', 'RENT', 'CASH_OPERATING', 1200);

    const bs = await f.get('/books/reports/balance-sheet?asOf=2026-09-30&compare=prior');
    expect(bs.body.totals).toMatchObject({ assets: 23800, balanced: true });
    expect(bs.body.compare).toMatchObject({ kind: 'prior', asOf: '2026-08-31', totals: { assets: 20000, balanced: true } });

    const cf = await f.get('/books/reports/cash-flow?from=2026-09-01&to=2026-09-30&compare=prior');
    expect(cf.body.totals).toMatchObject({ netChange: 3800, reconciles: true });
    expect(cf.body.compare).toMatchObject({ from: '2026-08-01', to: '2026-08-31', netIncome: 0, totals: { financing: 20000, netChange: 20000 } });
  });
});

describe('the overview', () => {
  it('leads with "post history" while open statements aren’t in the books', async () => {
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    const client = await createClient('Harbor Grill');
    const vendor = await prisma.vendor.create({ data: { name: 'Shell Fleet' } });
    await prisma.bill.create({ data: { vendorId: vendor.id, billDate: new Date(), dueDate: new Date(), status: 'PENDING_APPROVAL', total: 90, balance: 90 } });
    await prisma.clientStatement.create({
      data: { clientId: client.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-01-07'), status: 'FINAL', finalizedAt: new Date(), dueAt: new Date(Date.now() + 10 * 86_400_000), snapshot: { totals: { amount: 1200 } } },
    });
    const o = await e.get('/books/overview');
    expect(o.body.needsYou[0]).toMatchObject({ key: 'ar-unposted', tone: 'warning' });
    expect(o.body.needsYou.map((n: { key: string }) => n.key)).toContain('bills');
  });
});
