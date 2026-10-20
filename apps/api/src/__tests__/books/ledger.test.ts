import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, truncateAll } from '../../../test/db.js';
import { ensureChart, DEFAULT_CHART } from '../../lib/books/chart.js';
import { accountBalance, accountByKey, entryForKey, postEntry, reverseEntry, voidEntry } from '../../lib/books/ledger.js';
import { accountDetail, balanceSheet, cashFlow, profitAndLoss, trialBalance } from '../../lib/books/reports.js';

/**
 * The ledger's rules: an entry balances or isn't posted; automatic posting
 * is idempotent; a change to a closed month lands as an adjustment in the
 * first open month; void and reverse never delete; and the statements
 * agree with each other (TB balances, A = L + E, cash flow reconciles).
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const close = (periodKey: string) => prisma.fiscalPeriod.create({ data: { periodKey, status: 'CLOSED', closedAt: new Date() } });

describe('the chart', () => {
  it('seeds every account the posting needs, once, and keeps the accountant’s edits', async () => {
    expect(await ensureChart(prisma)).toBe(DEFAULT_CHART.length);
    const ar = await accountByKey(prisma, 'AR');
    await prisma.ledgerAccount.update({ where: { id: ar.id }, data: { name: 'Trade receivables' } });
    expect(await ensureChart(prisma)).toBe(0);
    expect((await accountByKey(prisma, 'AR')).name).toBe('Trade receivables');
  });
});

describe('posting', () => {
  it('posts a balanced entry and refuses an unbalanced or one-sided one', async () => {
    const e = await postEntry(prisma, {
      date: '2026-10-05',
      source: 'MANUAL',
      memo: 'Owner puts money in',
      lines: [
        { account: 'CASH_OPERATING', debit: 10000 },
        { account: 'OWNER_EQUITY', credit: 10000 },
      ],
    });
    expect(e).toMatchObject({ number: 1, periodKey: '2026-10', status: 'POSTED' });
    expect(Number(e.totalDebit)).toBe(10000);
    await expect(postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 10 }, { account: 'OWNER_EQUITY', credit: 9.99 }] })).rejects.toMatchObject({ code: 'entry_unbalanced' });
    await expect(postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 10 }] })).rejects.toMatchObject({ code: 'entry_too_short' });
    await expect(postEntry(prisma, { date: '2026-10-05', source: 'MANUAL', lines: [{ account: 'NOPE', debit: 1 }, { account: 'OWNER_EQUITY', credit: 1 }] })).rejects.toMatchObject({ code: 'unknown_account' });
    expect(await accountBalance(prisma, (await accountByKey(prisma, 'CASH_OPERATING')).id, '2026-10-31')).toBe(10000);
  });

  it('is idempotent by sourceKey, rewrites a changed entry while its month is open, and adjusts once it is closed', async () => {
    const base = { date: '2026-09-30', source: 'STATEMENT' as const, sourceKey: 'statement:abc', memo: 'Statement 12' };
    const first = await postEntry(prisma, { ...base, lines: [{ account: 'AR', debit: 1000 }, { account: 'REVENUE_STAFFING', credit: 1000 }] });
    const again = await postEntry(prisma, { ...base, lines: [{ account: 'REVENUE_STAFFING', credit: 1000 }, { account: 'AR', debit: 1000 }] });
    expect(again.id).toBe(first.id);
    expect(await prisma.journalEntry.count()).toBe(1);

    const rewritten = await postEntry(prisma, { ...base, lines: [{ account: 'AR', debit: 1200 }, { account: 'REVENUE_STAFFING', credit: 1200 }] });
    expect(rewritten).toMatchObject({ id: first.id, number: first.number });
    expect(Number(rewritten.totalDebit)).toBe(1200);

    // September closes; the statement changes again — the difference lands in October.
    await close('2026-09');
    const adj = await postEntry(prisma, { ...base, lines: [{ account: 'AR', debit: 1500 }, { account: 'REVENUE_STAFFING', credit: 1500 }] });
    expect(adj.id).not.toBe(first.id);
    expect(adj.periodKey >= '2026-10').toBe(true);
    expect(adj.sourceKey).toBe('statement:abc:adj:1');
    expect(Number(adj.totalDebit)).toBe(300);
    // Posting the same final version again changes nothing.
    await postEntry(prisma, { ...base, lines: [{ account: 'AR', debit: 1500 }, { account: 'REVENUE_STAFFING', credit: 1500 }] });
    expect(await prisma.journalEntry.count()).toBe(2);
    const ar = await accountByKey(prisma, 'AR');
    expect(await accountBalance(prisma, ar.id, '2099-12-31')).toBe(1500);
    // The September entry itself never changed.
    expect(Number((await entryForKey(prisma, 'statement:abc'))!.totalDebit)).toBe(1200);
  });

  it('a manual entry can’t land in a closed month', async () => {
    await close('2026-08');
    await expect(postEntry(prisma, { date: '2026-08-15', source: 'MANUAL', lines: [{ account: 'RENT', debit: 2000 }, { account: 'CASH_OPERATING', credit: 2000 }] })).rejects.toMatchObject({ code: 'period_closed' });
  });

  it('voids in an open month and reverses in the first open month once it’s closed', async () => {
    const a = await postEntry(prisma, { date: '2026-10-02', source: 'MANUAL', lines: [{ account: 'RENT', debit: 2000 }, { account: 'CASH_OPERATING', credit: 2000 }] });
    expect(await voidEntry(prisma, a.id, { reason: 'Duplicate' })).toEqual({ voided: true, reversal: null });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('VOID');
    const rent = await accountByKey(prisma, 'RENT');
    expect(await accountBalance(prisma, rent.id, '2026-10-31')).toBe(0);

    const b = await postEntry(prisma, { date: '2026-07-01', source: 'MANUAL', lines: [{ account: 'RENT', debit: 2000 }, { account: 'CASH_OPERATING', credit: 2000 }] });
    await close('2026-07');
    const r = await voidEntry(prisma, b.id, { reason: 'Paid by the landlord’s credit' });
    expect(r.voided).toBe(false);
    expect(r.reversal!.periodKey >= '2026-08').toBe(true);
    expect(r.reversal!.reversesId).toBeNull(); // set by reverseEntry's update; read it fresh
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.reversal!.id } })).reversesId).toBe(b.id);
    expect(await accountBalance(prisma, rent.id, '2099-12-31')).toBe(0);
    // Reversing twice gives the same reversal.
    expect((await reverseEntry(prisma, b.id, { date: '2026-10-01' })).id).toBe(r.reversal!.id);
  });
});

describe('the statements', () => {
  it('trial balance balances, A = L + E with this year’s profit, cash flow reconciles, and P&L splits by client', async () => {
    const client = await prisma.client.create({ data: { name: 'Coastal Resort' } });
    // Prior year: equity in, a little profit.
    await postEntry(prisma, { date: '2025-12-01', source: 'OPENING', lines: [{ account: 'CASH_OPERATING', debit: 50000 }, { account: 'OWNER_EQUITY', credit: 50000 }] });
    await postEntry(prisma, { date: '2025-12-15', source: 'MANUAL', lines: [{ account: 'CASH_OPERATING', debit: 3000 }, { account: 'OTHER_INCOME', credit: 3000 }] });
    // This year: bill a client, pay direct labor, buy a van, depreciate it, owe a vendor.
    await postEntry(prisma, { date: '2026-03-31', source: 'STATEMENT', sourceKey: 's1', lines: [{ account: 'AR', debit: 40000, clientId: client.id }, { account: 'REVENUE_STAFFING', credit: 40000, clientId: client.id }] });
    await postEntry(prisma, { date: '2026-03-31', source: 'PAYROLL', sourceKey: 'p1', lines: [{ account: 'WAGES_DIRECT', debit: 25000, clientId: client.id }, { account: 'CASH_PAYROLL', credit: 21000 }, { account: 'FIT_PAYABLE', credit: 4000 }] });
    await postEntry(prisma, { date: '2026-04-10', source: 'CLIENT_PAYMENT', lines: [{ account: 'CASH_OPERATING', debit: 30000 }, { account: 'AR', credit: 30000, clientId: client.id }] });
    await postEntry(prisma, { date: '2026-04-15', source: 'MANUAL', lines: [{ account: 'FA_VEHICLES', debit: 36000 }, { account: 'CASH_OPERATING', credit: 36000 }] });
    await postEntry(prisma, { date: '2026-04-30', source: 'DEPRECIATION', lines: [{ account: 'DEPRECIATION_EXPENSE', debit: 600 }, { account: 'ACCUM_DEPRECIATION', credit: 600 }] });
    await postEntry(prisma, { date: '2026-04-20', source: 'BILL', lines: [{ account: 'FUEL', debit: 900 }, { account: 'AP', credit: 900 }] });

    const tb = await trialBalance(prisma, '2026-04-30');
    expect(tb.totals.balanced).toBe(true);

    const pl = await profitAndLoss(prisma, '2026-01-01', '2026-04-30', {}, { columns: 'client' });
    expect(pl.totals).toMatchObject({ income: 40000, costOfServices: 25000, grossProfit: 15000, grossMarginPct: 37.5, expenses: 1500, netIncome: 13500 });
    const coastal = pl.columns.find((c) => c.label === 'Coastal Resort')!;
    expect(coastal.totals).toMatchObject({ income: 40000, costOfServices: 25000, grossProfit: 15000 });
    const forClient = await profitAndLoss(prisma, '2026-01-01', '2026-04-30', { clientId: client.id });
    expect(forClient.totals.netIncome).toBe(15000);
    const byMonth = await profitAndLoss(prisma, '2026-03-01', '2026-04-30', {}, { columns: 'month' });
    expect(byMonth.columns.map((c) => c.key)).toEqual(['2026-03', '2026-04']);
    expect(byMonth.columns[1]!.totals.expenses).toBe(1500);

    const bs = await balanceSheet(prisma, '2026-04-30');
    expect(bs.totals.balanced).toBe(true);
    expect(bs.equity.find((r) => r.name === 'Net income this year')!.amount).toBe(13500);
    expect(bs.equity.find((r) => r.subtype === 'RETAINED_EARNINGS')!.amount).toBe(3000);
    expect(bs.assets.find((r) => r.subtype === 'ACCUMULATED_DEPRECIATION')!.amount).toBe(-600);

    const cf = await cashFlow(prisma, '2026-01-01', '2026-04-30');
    expect(cf.totals.reconciles).toBe(true);
    expect(cf.totals.investing).toBe(-36000);
    expect(cf.totals.cashChange).toBe(30000 - 21000 - 36000);

    const ar = await accountByKey(prisma, 'AR');
    const detail = await accountDetail(prisma, ar.id, '2026-01-01', '2026-12-31');
    expect(detail!.rows.map((r) => r.balance)).toEqual([40000, 10000]);
  });
});

describe('the chart under load', () => {
  it('two first requests at once both get the chart — neither fails on the unique key', async () => {
    const [a, b] = await Promise.all([ensureChart(prisma), ensureChart(prisma)]);
    expect(a + b).toBe(DEFAULT_CHART.length);
    expect(await prisma.ledgerAccount.count()).toBe(DEFAULT_CHART.length);
  });
});
