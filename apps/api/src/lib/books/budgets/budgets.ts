import { Prisma, type LedgerAccount, type PrismaClient } from '@prisma/client';
import type {
  BudgetCreateInput,
  BudgetDetail,
  BudgetLineView,
  BudgetLinesInput,
  BudgetListResponse,
  BudgetSummary,
  BudgetUpdateInput,
  BudgetVsActual,
  BudgetVsActualCell,
  BudgetVsActualRow,
  BudgetVsActualSection,
} from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { accountIndex, fromCents, toCents } from '../ledger.js';

/**
 * Budgets: one per fiscal year can be ACTIVE. A budget is a grid — an
 * income or expense account (optionally for one client or department) ×
 * the twelve months — and reads against the ledger as budget vs actual,
 * month by month and year to date, with two forecasts to year end: actual
 * so far + the budget left, and actual carried at its pace (run rate).
 *
 * Budget vs actual compares by ACCOUNT: client and department rows of the
 * same account add up to that account's budget, read against everything
 * the ledger has on it.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Section = BudgetVsActualRow['section'];

const SECTION_LABEL: Record<Section, string> = {
  income: 'Income',
  costOfServices: 'Cost of services',
  expenses: 'Operating expenses',
  otherIncome: 'Other income',
  otherExpenses: 'Other expenses',
};
const SECTION_ORDER: Section[] = ['income', 'costOfServices', 'expenses', 'otherIncome', 'otherExpenses'];

export function sectionOf(a: Pick<LedgerAccount, 'type' | 'subtype'>): Section {
  if (a.type === 'INCOME') return a.subtype === 'OTHER_INCOME' ? 'otherIncome' : 'income';
  if (a.subtype === 'COST_OF_SERVICES') return 'costOfServices';
  if (a.subtype === 'OTHER_EXPENSE') return 'otherExpenses';
  return 'expenses';
}
const isIncome = (s: Section) => s === 'income' || s === 'otherIncome';

export const periodsOf = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

/** Spread cents over 12 months evenly; the rounding lands in the last months. */
export function spread(totalCents: number): number[] {
  const base = Math.trunc(totalCents / 12);
  const rest = totalCents - base * 12;
  return Array.from({ length: 12 }, (_, i) => base + (i >= 12 - Math.abs(rest) ? Math.sign(rest) : 0));
}

async function findBudget(db: Db, id: string) {
  const b = await db.budget.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { lines: true } });
  if (!b) throw new HttpError(404, 'budget_not_found', 'Budget not found.');
  return b;
}

function summary(b: { id: string; name: string; fiscalYear: number; status: string; notes: string | null; updatedAt: Date; lines: Array<{ accountId: string; amount: Prisma.Decimal }> }, byId: Map<string, LedgerAccount>): BudgetSummary {
  let income = 0;
  let expense = 0;
  for (const l of b.lines) {
    const a = byId.get(l.accountId);
    if (!a) continue;
    if (a.type === 'INCOME') income += toCents(l.amount);
    else if (a.type === 'EXPENSE') expense += toCents(l.amount);
  }
  const keys = new Set(b.lines.map((l) => l.accountId));
  return { id: b.id, name: b.name, fiscalYear: b.fiscalYear, status: b.status as BudgetSummary['status'], notes: b.notes, totalIncome: fromCents(income), totalExpense: fromCents(expense), net: fromCents(income - expense), lineCount: keys.size, updatedAt: b.updatedAt.toISOString() };
}

export async function listBudgets(db: Db): Promise<BudgetListResponse> {
  const { byId } = await accountIndex(db);
  const rows = await db.budget.findMany({ where: { tenantId: tenantIdForWrite() }, include: { lines: { select: { accountId: true, amount: true } } }, orderBy: [{ fiscalYear: 'desc' }, { status: 'asc' }, { name: 'asc' }] });
  return { budgets: rows.map((b) => summary(b, byId)) };
}

export async function budgetDetail(db: Db, id: string): Promise<BudgetDetail> {
  const b = await findBudget(db, id);
  const { byId } = await accountIndex(db);
  const periods = periodsOf(b.fiscalYear);
  const rows = new Map<string, BudgetLineView>();
  for (const l of b.lines) {
    const k = `${l.accountId}|${l.clientId ?? ''}|${l.departmentId ?? ''}`;
    const r = rows.get(k) ?? { accountId: l.accountId, clientId: l.clientId, departmentId: l.departmentId, months: Array(12).fill(0), total: 0 };
    const i = periods.indexOf(l.periodKey);
    if (i >= 0) r.months[i] = fromCents(toCents(r.months[i]) + toCents(l.amount));
    rows.set(k, r);
  }
  const lines = [...rows.values()].map((r) => ({ ...r, total: fromCents(r.months.reduce((s, m) => s + toCents(m), 0)) }));
  lines.sort((x, y) => (byId.get(x.accountId)?.code ?? '').localeCompare(byId.get(y.accountId)?.code ?? '', undefined, { numeric: true }));
  const accounts = [...byId.values()]
    .filter((a) => a.isActive && (a.type === 'INCOME' || a.type === 'EXPENSE'))
    .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))
    .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
  return { ...summary(b, byId), periods, lines, accounts };
}

/** The year's actual per account per month, cents, signed to the account's normal side. */
async function actuals(db: Db, year: number, through?: string): Promise<Map<string, number[]>> {
  const tenantId = tenantIdForWrite();
  const periods = periodsOf(year).filter((p) => !through || p <= through);
  if (!periods.length) return new Map();
  const { byId } = await accountIndex(db);
  const rows = await db.journalLine.findMany({
    where: { tenantId, account: { type: { in: ['INCOME', 'EXPENSE'] } }, entry: { status: 'POSTED', periodKey: { in: periods } } },
    select: { accountId: true, debit: true, credit: true, entry: { select: { periodKey: true } } },
  });
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const a = byId.get(r.accountId);
    if (!a) continue;
    const m = Number(r.entry.periodKey.slice(5, 7)) - 1;
    const net = toCents(r.debit) - toCents(r.credit);
    const arr = out.get(r.accountId) ?? Array(12).fill(0);
    arr[m] += a.type === 'EXPENSE' ? net : -net;
    out.set(r.accountId, arr);
  }
  return out;
}

async function writeLines(tx: Prisma.TransactionClient, budgetId: string, year: number, lines: Array<{ accountId: string; clientId: string | null; departmentId: string | null; months: number[] }>) {
  const tenantId = tenantIdForWrite();
  const periods = periodsOf(year);
  await tx.budgetLine.deleteMany({ where: { budgetId } });
  const data = lines.flatMap((l) =>
    l.months.map((cents, i) => ({ tenantId, budgetId, accountId: l.accountId, periodKey: periods[i]!, amount: new Prisma.Decimal(fromCents(cents)), clientId: l.clientId, departmentId: l.departmentId })).filter((x) => !x.amount.isZero()),
  );
  if (data.length) await tx.budgetLine.createMany({ data });
  await tx.budget.update({ where: { id: budgetId }, data: { updatedAt: new Date() } });
}

/** Last year's actuals, grown by growthPct, account by account. */
async function linesFromActuals(db: Db, year: number, growthPct: number) {
  const prior = await actuals(db, year - 1);
  return [...prior.entries()]
    .filter(([, months]) => months.some((m) => m !== 0))
    .map(([accountId, months]) => ({ accountId, clientId: null, departmentId: null, months: months.map((c) => Math.round(c * (1 + growthPct / 100))) }));
}

export async function createBudget(db: PrismaClient, input: BudgetCreateInput, userId: string | null): Promise<BudgetDetail> {
  const tenantId = tenantIdForWrite();
  const b = await db.budget.create({ data: { tenantId, name: input.name, fiscalYear: input.fiscalYear, notes: input.notes ?? null, createdById: userId } });
  if (input.fromActuals) {
    const lines = await linesFromActuals(db, input.fiscalYear, input.fromActuals.growthPct);
    await db.$transaction((tx) => writeLines(tx, b.id, input.fiscalYear, lines));
  }
  return budgetDetail(db, b.id);
}

export async function updateBudget(db: PrismaClient, id: string, input: BudgetUpdateInput): Promise<{ budget: BudgetDetail; demoted: string | null }> {
  const b = await findBudget(db, id);
  let demoted: string | null = null;
  await db.$transaction(async (tx) => {
    if (input.status === 'ACTIVE' && b.status !== 'ACTIVE') {
      // One active budget per year: the one it replaces goes back to draft.
      const other = await tx.budget.findFirst({ where: { tenantId: tenantIdForWrite(), fiscalYear: b.fiscalYear, status: 'ACTIVE', id: { not: id } } });
      if (other) {
        await tx.budget.update({ where: { id: other.id }, data: { status: 'DRAFT' } });
        demoted = other.name;
      }
    }
    await tx.budget.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
  });
  return { budget: await budgetDetail(db, id), demoted };
}

export async function deleteBudget(db: PrismaClient, id: string): Promise<void> {
  const b = await findBudget(db, id);
  if (b.status !== 'DRAFT') throw new HttpError(409, 'budget_not_draft', 'Only a draft budget can be deleted — archive this one instead.');
  await db.budget.delete({ where: { id } });
}

export async function setBudgetLines(db: PrismaClient, id: string, input: BudgetLinesInput): Promise<BudgetDetail> {
  const b = await findBudget(db, id);
  if (b.status === 'ARCHIVED') throw new HttpError(409, 'budget_archived', 'An archived budget can’t be edited.');
  const { byId } = await accountIndex(db);
  const lines = input.lines.map((l) => {
    const a = byId.get(l.accountId);
    if (!a || (a.type !== 'INCOME' && a.type !== 'EXPENSE')) throw new HttpError(400, 'bad_budget_account', 'A budget line needs an income or expense account.');
    const months = l.months ? l.months.map((m) => toCents(m)) : l.annual !== undefined ? spread(toCents(l.annual)) : Array(12).fill(0);
    return { accountId: l.accountId, clientId: l.clientId ?? null, departmentId: l.departmentId ?? null, months };
  });
  const seen = new Set<string>();
  for (const l of lines) {
    const k = `${l.accountId}|${l.clientId ?? ''}|${l.departmentId ?? ''}`;
    if (seen.has(k)) throw new HttpError(400, 'duplicate_budget_line', `${byId.get(l.accountId)?.name ?? 'An account'} appears twice for the same client and department.`);
    seen.add(k);
  }
  await db.$transaction((tx) => writeLines(tx, id, b.fiscalYear, lines));
  return budgetDetail(db, id);
}

export async function budgetFromActuals(db: PrismaClient, id: string, growthPct: number): Promise<BudgetDetail> {
  const b = await findBudget(db, id);
  if (b.status === 'ARCHIVED') throw new HttpError(409, 'budget_archived', 'An archived budget can’t be edited.');
  const lines = await linesFromActuals(db, b.fiscalYear, growthPct);
  if (!lines.length) throw new HttpError(409, 'no_prior_actuals', `There are no ${b.fiscalYear - 1} actuals in the books to start from.`);
  await db.$transaction((tx) => writeLines(tx, id, b.fiscalYear, lines));
  return budgetDetail(db, id);
}

const cell = (budget: number, actual: number): BudgetVsActualCell => ({
  budget: fromCents(budget),
  actual: fromCents(actual),
  variance: fromCents(actual - budget),
  variancePct: budget !== 0 ? Math.round(((actual - budget) / Math.abs(budget)) * 1000) / 10 : null,
});

export async function budgetVsActual(db: Db, id: string, through: string): Promise<BudgetVsActual> {
  const b = await findBudget(db, id);
  const { byId } = await accountIndex(db);
  const periods = periodsOf(b.fiscalYear);
  const elapsed = periods.filter((p) => p <= through).length;
  const budgetBy = new Map<string, number[]>();
  for (const l of b.lines) {
    const i = periods.indexOf(l.periodKey);
    if (i < 0) continue;
    const arr = budgetBy.get(l.accountId) ?? Array(12).fill(0);
    arr[i] += toCents(l.amount);
    budgetBy.set(l.accountId, arr);
  }
  const actualBy = await actuals(db, b.fiscalYear, through);
  const ids = new Set([...budgetBy.keys(), ...actualBy.keys()]);
  const sections = new Map<Section, BudgetVsActualRow[]>(SECTION_ORDER.map((s) => [s, []]));
  const totals = new Map<Section, { b: number; a: number; annual: number; forecast: number; run: number }>(SECTION_ORDER.map((s) => [s, { b: 0, a: 0, annual: 0, forecast: 0, run: 0 }]));
  for (const accountId of ids) {
    const a = byId.get(accountId);
    if (!a) continue;
    const section = sectionOf(a);
    const bud = budgetBy.get(accountId) ?? Array(12).fill(0);
    const act = actualBy.get(accountId) ?? Array(12).fill(0);
    const bYtd = bud.slice(0, elapsed).reduce((s, x) => s + x, 0);
    const aYtd = act.slice(0, elapsed).reduce((s, x) => s + x, 0);
    const annual = bud.reduce((s, x) => s + x, 0);
    const forecast = aYtd + bud.slice(elapsed).reduce((s, x) => s + x, 0);
    const run = elapsed ? Math.round((aYtd / elapsed) * 12) : 0;
    const ytd = cell(bYtd, aYtd);
    sections.get(section)!.push({
      accountId,
      code: a.code,
      name: a.name,
      section,
      months: periods.map((p, i) => (p <= through ? cell(bud[i]!, act[i]!) : cell(bud[i]!, 0))),
      ytd: { ...ytd, favorable: isIncome(section) ? aYtd >= bYtd : aYtd <= bYtd },
      annualBudget: fromCents(annual),
      forecast: fromCents(forecast),
      runRate: fromCents(run),
    });
    const t = totals.get(section)!;
    t.b += bYtd;
    t.a += aYtd;
    t.annual += annual;
    t.forecast += forecast;
    t.run += run;
  }
  const out: BudgetVsActualSection[] = SECTION_ORDER.filter((s) => sections.get(s)!.length).map((s) => {
    const t = totals.get(s)!;
    return {
      key: s,
      label: SECTION_LABEL[s],
      rows: sections.get(s)!.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true })),
      ytd: cell(t.b, t.a),
      annualBudget: fromCents(t.annual),
      forecast: fromCents(t.forecast),
      runRate: fromCents(t.run),
    };
  });
  const net = (pick: (t: { b: number; a: number; annual: number; forecast: number; run: number }) => number) =>
    SECTION_ORDER.reduce((s, k) => s + (isIncome(k) ? 1 : -1) * pick(totals.get(k)!), 0);
  return {
    budgetId: b.id,
    fiscalYear: b.fiscalYear,
    through,
    periods,
    monthsElapsed: elapsed,
    sections: out,
    netIncome: { ytd: cell(net((t) => t.b), net((t) => t.a)), annualBudget: fromCents(net((t) => t.annual)), forecast: fromCents(net((t) => t.forecast)), runRate: fromCents(net((t) => t.run)) },
  };
}
