import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { accountByKey, postEntry } from '../../lib/books/ledger.js';
import { spread } from '../../lib/books/budgets/budgets.js';

/**
 * Budgets: a grid of income and expense accounts × months, started from
 * last year's actuals (grown), an annual amount spread evenly, one ACTIVE
 * budget per year, and budget vs actual — month by month, year to date,
 * the forecast (actual + budget left) and the run rate.
 *
 *   Today is Monday Oct 19, 2026: actuals run through September.
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

describe('spreading', () => {
  it('spreads an annual amount evenly, rounding in the last months', () => {
    expect(spread(120000)).toEqual(Array(12).fill(10000));
    const s = spread(100005);
    expect(s.reduce((a, b) => a + b, 0)).toBe(100005);
    expect(s[0]).toBe(8333);
    expect(s[11]).toBe(8334);
  });
});

describe('budgets', () => {
  it('start from last year, read against actuals, and one is active per year', async () => {
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const a = await loginAs(agent(), user.email);
    // 2025: $10,000 revenue and $6,000 direct labor every month.
    for (let m = 1; m <= 12; m++) {
      const date = `2025-${String(m).padStart(2, '0')}-28`;
      await postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'AR', debit: 10000 }, { account: 'REVENUE_STAFFING', credit: 10000 }] });
      await postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 6000 }, { account: 'CASH_PAYROLL', credit: 6000 }] });
    }
    const made = await a.post('/books/budgets').send({ name: '2026 plan', fiscalYear: 2026, fromActuals: { growthPct: 10 } });
    expect(made.status).toBe(201);
    const budget = made.body.budget;
    expect(budget).toMatchObject({ status: 'DRAFT', totalIncome: 132000, totalExpense: 79200, net: 52800, lineCount: 2 });
    expect(budget.periods[0]).toBe('2026-01');
    const rev = await accountByKey(prisma, 'REVENUE_STAFFING');
    expect(budget.lines.find((l: { accountId: string }) => l.accountId === rev.id).months).toEqual(Array(12).fill(11000));

    // Rent: an annual amount spread evenly, added to the grid.
    const rent = await accountByKey(prisma, 'RENT');
    const lines = [...budget.lines.map((l: { accountId: string; months: number[] }) => ({ accountId: l.accountId, months: l.months })), { accountId: rent.id, annual: 24000 }];
    const put = await a.put(`/books/budgets/${budget.id}/lines`).send({ lines });
    expect(put.status).toBe(200);
    expect(put.body.budget.totalExpense).toBe(103200);
    expect((await a.put(`/books/budgets/${budget.id}/lines`).send({ lines: [...lines, { accountId: rent.id, annual: 1 }] })).body.error.code).toBe('duplicate_budget_line');
    const ar = await accountByKey(prisma, 'AR');
    expect((await a.put(`/books/budgets/${budget.id}/lines`).send({ lines: [{ accountId: ar.id, annual: 1 }] })).body.error.code).toBe('bad_budget_account');

    // 2026 so far: Jan–Sep, $12,000 revenue and $7,000 labor a month; rent $2,500.
    for (let m = 1; m <= 9; m++) {
      const date = `2026-0${m}-28`;
      await postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'AR', debit: 12000 }, { account: 'REVENUE_STAFFING', credit: 12000 }] });
      await postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'WAGES_DIRECT', debit: 7000 }, { account: 'CASH_PAYROLL', credit: 7000 }] });
      await postEntry(prisma, { date, source: 'MANUAL', lines: [{ account: 'RENT', debit: 2500 }, { account: 'CASH_OPERATING', credit: 2500 }] });
    }
    const vs = await a.get(`/books/budgets/${budget.id}/vs-actual`);
    expect(vs.status).toBe(200);
    expect(vs.body).toMatchObject({ through: '2026-09', monthsElapsed: 9 });
    const income = vs.body.sections.find((x: { key: string }) => x.key === 'income');
    const revRow = income.rows[0];
    expect(revRow.ytd).toMatchObject({ budget: 99000, actual: 108000, variance: 9000, variancePct: 9.1, favorable: true });
    expect(revRow).toMatchObject({ annualBudget: 132000, forecast: 108000 + 33000, runRate: 144000 });
    expect(revRow.months[0]).toMatchObject({ budget: 11000, actual: 12000 });
    const rentRow = vs.body.sections.find((x: { key: string }) => x.key === 'expenses').rows[0];
    expect(rentRow.ytd).toMatchObject({ budget: 18000, actual: 22500, variance: 4500, favorable: false });
    expect(vs.body.netIncome.ytd).toMatchObject({ budget: 99000 - 59400 - 18000, actual: 108000 - 63000 - 22500 });

    const asOf = await a.get(`/books/budgets/${budget.id}/vs-actual?through=2026-03`);
    expect(asOf.body.monthsElapsed).toBe(3);

    const xlsx = await a.get(`/books/budgets/${budget.id}/vs-actual.xlsx`).buffer(true);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);

    // One active budget per year: activating another sends the first back to draft.
    await a.patch(`/books/budgets/${budget.id}`).send({ status: 'ACTIVE' }).expect(200);
    const other = await a.post('/books/budgets').send({ name: '2026 stretch', fiscalYear: 2026 });
    const activated = await a.patch(`/books/budgets/${other.body.budget.id}`).send({ status: 'ACTIVE' });
    expect(activated.body.demoted).toBe('2026 plan');
    expect((await a.get('/books/budgets')).body.budgets.filter((b: { status: string }) => b.status === 'ACTIVE')).toHaveLength(1);
    expect((await a.delete(`/books/budgets/${other.body.budget.id}`)).body.error.code).toBe('budget_not_draft');
    await a.delete(`/books/budgets/${budget.id}`).expect(204);

    // No prior actuals to copy.
    const y27 = await a.post('/books/budgets').send({ name: '2028', fiscalYear: 2028 });
    expect((await a.post(`/books/budgets/${y27.body.budget.id}/from-actuals`).send({ growthPct: 5 })).body.error.code).toBe('no_prior_actuals');
  });
});
