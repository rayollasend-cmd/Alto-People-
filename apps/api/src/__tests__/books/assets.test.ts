import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import type { Test } from 'supertest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { depreciationSchedule } from '../../lib/books/assets/depreciation.js';
import { accountBalance, accountByKey } from '../../lib/books/ledger.js';
import { trialBalance } from '../../lib/books/reports.js';
import { runCloseJobs } from '../../lib/books/jobs/close.js';

/**
 * Fixed assets: the depreciation math (straight line to salvage, double
 * declining switching to straight line, full-month convention), posting
 * that's idempotent and never lands in a closed month (a closed month's
 * missing depreciation goes to the first open one, flagged), and disposal
 * with its gain or loss — the books balanced throughout.
 *
 *   Today is Monday Oct 19, 2026: September is the last month that has ended.
 */

const NOW = new Date('2026-10-19T15:00:00.000Z');
type Agent = TestAgent<Test>;

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

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const asCents = (n: number) => Math.round(n * 100);

describe('the schedule', () => {
  it('straight line: equal months to salvage, the last month takes the rounding', () => {
    const s = depreciationSchedule({ inServiceOn: d('2026-01-15'), cost: 10000 as never, salvageValue: 1000 as never, usefulLifeMonths: 7, method: 'STRAIGHT_LINE', disposedOn: null });
    expect(s).toHaveLength(7);
    expect(s[0]).toMatchObject({ periodKey: '2026-01', amount: 128571 });
    expect(s.reduce((n, m) => n + m.amount, 0)).toBe(900000);
    expect(s[6]!.netBookValue).toBe(100000);
  });

  it('double declining: book value × 2 ÷ life, switching to straight line once that is larger', () => {
    const s = depreciationSchedule({ inServiceOn: d('2026-01-01'), cost: 12000 as never, salvageValue: 0 as never, usefulLifeMonths: 12, method: 'DECLINING_BALANCE', disposedOn: null });
    // Month 1: 12000 × 2/12 = 2000.
    expect(s[0]!.amount).toBe(200000);
    expect(s[1]!.amount).toBe(166667);
    expect(s).toHaveLength(12);
    expect(s.reduce((n, m) => n + m.amount, 0)).toBe(1200000);
    // From month 8 straight line over the months left is larger: equal amounts to the end.
    const tail = s.slice(7).map((m) => m.amount);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(1);
    expect(s[7]!.amount).toBeGreaterThan(Math.round(s[6]!.netBookValue * 2 / 12));
  });

  it('double declining never goes below salvage — a high salvage ends the schedule early', () => {
    const s = depreciationSchedule({ inServiceOn: d('2026-01-01'), cost: 12000 as never, salvageValue: 2000 as never, usefulLifeMonths: 12, method: 'DECLINING_BALANCE', disposedOn: null });
    expect(s.length).toBeLessThan(12);
    expect(s[s.length - 1]!.netBookValue).toBe(200000);
    expect(s.reduce((n, m) => n + m.amount, 0)).toBe(1000000);
  });

  it('stops the month before disposal', () => {
    const s = depreciationSchedule({ inServiceOn: d('2026-01-01'), cost: 1200 as never, salvageValue: 0 as never, usefulLifeMonths: 12, method: 'STRAIGHT_LINE', disposedOn: d('2026-04-10') });
    expect(s.map((m) => m.periodKey)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

async function seed(): Promise<Agent> {
  const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return loginAs(agent(), user.email);
}

describe('the register', () => {
  it('registers a van with its acquisition, posts depreciation once, flags a closed month’s, and disposes with a gain', async () => {
    const a = await seed();
    const van = await prisma.van.create({ data: { name: 'Van 7', plate: 'ALT 107', capacity: 12 } });
    const list0 = await a.get('/books/assets');
    expect(list0.status).toBe(200);
    expect(list0.body.suggestions).toEqual([expect.objectContaining({ kind: 'VAN', id: van.id, category: 'VEHICLE' })]);

    const cash = await accountByKey(prisma, 'CASH_OPERATING');
    const made = await a.post('/books/assets').send({
      name: 'Ford Transit — Van 7',
      category: 'VEHICLE',
      vanId: van.id,
      acquiredOn: '2026-06-10',
      cost: 36000,
      salvageValue: 6000,
      usefulLifeMonths: 60,
      acquisition: { creditAccountId: cash.id },
    });
    expect(made.status).toBe(201);
    const id = made.body.asset.id as string;
    expect(made.body.asset).toMatchObject({ status: 'ACTIVE', netBookValue: 36000, duePeriods: 4, linkedLabel: 'Van 7 · ALT 107' });
    expect(await accountBalance(prisma, (await accountByKey(prisma, 'FA_VEHICLES')).id, '2026-06-30')).toBe(36000);
    expect((await a.get('/books/assets')).body.suggestions).toEqual([]);
    // The same van can't be registered twice.
    expect((await a.post('/books/assets').send({ name: 'Again', category: 'VEHICLE', vanId: van.id, acquiredOn: '2026-06-10', cost: 1, usefulLifeMonths: 12 })).status).toBe(409);

    // August closed before anyone posted depreciation.
    await prisma.fiscalPeriod.create({ data: { periodKey: '2026-08', status: 'CLOSED', closedAt: new Date() } });
    await runCloseJobs(prisma, NOW);
    await runCloseJobs(prisma, NOW);
    const entries = await prisma.depreciationEntry.findMany({ where: { fixedAssetId: id }, orderBy: { periodKey: 'asc' } });
    expect(entries.map((e) => [e.periodKey, Number(e.amount)])).toEqual([
      ['2026-06', 500],
      ['2026-07', 500],
      ['2026-08', 500],
      ['2026-09', 500],
    ]);
    // August's was posted into the first open month, flagged.
    const detail = await a.get(`/books/assets/${id}`);
    const aug = detail.body.asset.schedule.find((m: { periodKey: string }) => m.periodKey === '2026-08');
    expect(aug).toMatchObject({ posted: true, postedLate: true });
    const augEntry = await prisma.journalEntry.findFirstOrThrow({ where: { sourceKey: `depreciation:${id}:2026-08` } });
    expect(augEntry.periodKey).toBe('2026-09');
    expect(augEntry.memo).toMatch(/posted late/);
    expect(detail.body.asset).toMatchObject({ accumulated: 2000, netBookValue: 34000, duePeriods: 0 });

    // Changing the life after depreciation posted is refused.
    expect((await a.patch(`/books/assets/${id}`).send({ usefulLifeMonths: 72 })).body.error.code).toBe('schedule_started');

    // Sold Oct 12 for $35,000: October isn't depreciated; NBV 34,000 → a $1,000 gain.
    const sold = await a.post(`/books/assets/${id}/dispose`).send({ disposedOn: '2026-10-12', proceeds: 35000, proceedsAccountId: cash.id });
    expect(sold.status).toBe(200);
    expect(sold.body.asset).toMatchObject({ status: 'DISPOSED', netBookValue: 0, disposalProceeds: 35000 });
    const gain = await accountByKey(prisma, 'ASSET_DISPOSAL_GAIN_LOSS');
    expect(await accountBalance(prisma, gain.id, '2026-10-31')).toBe(-1000);
    expect(await accountBalance(prisma, (await accountByKey(prisma, 'FA_VEHICLES')).id, '2026-10-31')).toBe(0);
    expect(await accountBalance(prisma, (await accountByKey(prisma, 'ACCUM_DEPRECIATION')).id, '2026-10-31')).toBe(0);
    expect((await trialBalance(prisma, '2026-12-31')).totals.balanced).toBe(true);
    expect((await a.post(`/books/assets/${id}/dispose`).send({ disposedOn: '2026-10-12' })).body.error.code).toBe('already_disposed');
  });

  it('a loss on disposal, a manual run, and read-only roles kept out', async () => {
    const a = await seed();
    const made = await a.post('/books/assets').send({ name: 'Kiosk tablets', category: 'COMPUTERS', acquiredOn: '2026-01-05', cost: 2400, usefulLifeMonths: 24, method: 'DECLINING_BALANCE' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.asset.id as string;
    expect((await a.post('/books/assets/depreciation/run?through=2026-10')).body.error.code).toBe('month_not_ended');
    const run = await a.post('/books/assets/depreciation/run?through=2026-03');
    expect(run.body).toMatchObject({ through: '2026-03', posted: 3, assets: 1 });
    expect((await a.post('/books/assets/depreciation/run?through=2026-03')).body).toMatchObject({ posted: 0 });
    const dep = (await prisma.depreciationEntry.findMany({ where: { fixedAssetId: id } })).reduce((n, e) => n + asCents(Number(e.amount)), 0);
    // Scrapped Apr 2 for nothing: a loss of the book value.
    await a.post(`/books/assets/${id}/dispose`).send({ disposedOn: '2026-04-02' }).expect(200);
    const loss = await accountByKey(prisma, 'ASSET_DISPOSAL_GAIN_LOSS');
    expect(asCents(await accountBalance(prisma, loss.id, '2026-04-30'))).toBe(240000 - dep);
    expect((await trialBalance(prisma, '2026-12-31')).totals.balanced).toBe(true);

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.get('/books/assets')).status).toBe(200);
    expect((await e.post('/books/assets').send({ name: 'X', category: 'OTHER', acquiredOn: '2026-01-01', cost: 10, usefulLifeMonths: 12 })).status).toBe(403);
  });
});
