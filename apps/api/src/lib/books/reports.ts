import type { LedgerAccount, Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../tenant.js';
import { accountIndex, fromCents, toCents } from './ledger.js';

/**
 * The financial statements, read straight from the ledger (POSTED entries
 * only): trial balance, profit and loss, balance sheet, cash flow, and an
 * account's detail. Every report takes the same optional dimension filter
 * (client, site, department, cost center), so a P&L "for Coastal Resort"
 * is the same code as the company's.
 *
 * Amounts come back in dollars, signed to the account's normal side
 * (an expense is positive, a contra like accumulated depreciation negative).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface Dimensions {
  clientId?: string | null;
  siteId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
}

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

function lineWhere(dims: Dimensions, entry: Prisma.JournalEntryWhereInput): Prisma.JournalLineWhereInput {
  return {
    tenantId: tenantIdForWrite(),
    entry: { status: 'POSTED', ...entry },
    ...(dims.clientId ? { clientId: dims.clientId } : {}),
    ...(dims.siteId ? { siteId: dims.siteId } : {}),
    ...(dims.departmentId ? { departmentId: dims.departmentId } : {}),
    ...(dims.costCenterId ? { costCenterId: dims.costCenterId } : {}),
  };
}

/** Net (debit − credit, cents) per account over the entries matching `entry`. */
async function netByAccount(db: Db, dims: Dimensions, entry: Prisma.JournalEntryWhereInput): Promise<Map<string, number>> {
  const rows = await db.journalLine.groupBy({ by: ['accountId'], where: lineWhere(dims, entry), _sum: { debit: true, credit: true } });
  return new Map(rows.map((r) => [r.accountId, toCents(r._sum.debit) - toCents(r._sum.credit)]));
}

const debitNormal = (a: LedgerAccount) => a.type === 'ASSET' || a.type === 'EXPENSE';
/** Cents signed to the account's normal side. */
const signed = (a: LedgerAccount, net: number) => (debitNormal(a) ? net : -net);

export interface ReportRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  amount: number;
}

const row = (a: LedgerAccount, cents: number): ReportRow => ({ accountId: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype, amount: fromCents(cents) });
const byCode = (x: { code: string }, y: { code: string }) => x.code.localeCompare(y.code, undefined, { numeric: true });

/* ---- Trial balance ------------------------------------------------------- */

export async function trialBalance(db: Db, asOf: string, dims: Dimensions = {}) {
  const { byId } = await accountIndex(db);
  const net = await netByAccount(db, dims, { entryDate: { lte: dateOnly(asOf) } });
  const rows = [...net.entries()]
    .filter(([, n]) => n !== 0)
    .map(([id, n]) => {
      const a = byId.get(id)!;
      return { accountId: id, code: a.code, name: a.name, type: a.type, debit: n > 0 ? fromCents(n) : 0, credit: n < 0 ? fromCents(-n) : 0 };
    })
    .sort(byCode);
  const debit = rows.reduce((s, r) => s + toCents(r.debit), 0);
  const credit = rows.reduce((s, r) => s + toCents(r.credit), 0);
  return { asOf, rows, totals: { debit: fromCents(debit), credit: fromCents(credit), balanced: debit === credit } };
}

/* ---- Profit and loss ----------------------------------------------------- */

const SECTION: Record<string, 'income' | 'costOfServices' | 'expenses' | 'otherIncome' | 'otherExpenses'> = {
  INCOME: 'income',
  OTHER_INCOME: 'otherIncome',
  COST_OF_SERVICES: 'costOfServices',
  EXPENSE: 'expenses',
  OTHER_EXPENSE: 'otherExpenses',
};

function sectionOf(a: LedgerAccount): 'income' | 'costOfServices' | 'expenses' | 'otherIncome' | 'otherExpenses' {
  if (a.type === 'INCOME') return a.subtype === 'OTHER_INCOME' ? 'otherIncome' : 'income';
  return SECTION[a.subtype] ?? 'expenses';
}

/**
 * Income − cost of services = gross profit; − operating expenses =
 * operating income; ± other = net income. `columns` splits the period by
 * month (or by client) beside the total.
 */
export async function profitAndLoss(db: Db, from: string, to: string, dims: Dimensions = {}, opts: { columns?: 'none' | 'month' | 'client' } = {}) {
  const { byId } = await accountIndex(db);
  const where: Prisma.JournalEntryWhereInput = { entryDate: { gte: dateOnly(from), lte: dateOnly(to) } };

  const build = (net: Map<string, number>) => {
    const sections = { income: [] as ReportRow[], costOfServices: [] as ReportRow[], expenses: [] as ReportRow[], otherIncome: [] as ReportRow[], otherExpenses: [] as ReportRow[] };
    for (const [id, n] of net) {
      const a = byId.get(id);
      if (!a || (a.type !== 'INCOME' && a.type !== 'EXPENSE') || n === 0) continue;
      sections[sectionOf(a)].push(row(a, signed(a, n)));
    }
    for (const k of Object.keys(sections) as Array<keyof typeof sections>) sections[k].sort(byCode);
    const sum = (rows: ReportRow[]) => rows.reduce((s, r) => s + toCents(r.amount), 0);
    const income = sum(sections.income);
    const cos = sum(sections.costOfServices);
    const exp = sum(sections.expenses);
    const otherIn = sum(sections.otherIncome);
    const otherEx = sum(sections.otherExpenses);
    const grossProfit = income - cos;
    const operatingIncome = grossProfit - exp;
    const netIncome = operatingIncome + otherIn - otherEx;
    return {
      sections,
      totals: {
        income: fromCents(income),
        costOfServices: fromCents(cos),
        grossProfit: fromCents(grossProfit),
        grossMarginPct: income ? Math.round((grossProfit / income) * 1000) / 10 : null,
        expenses: fromCents(exp),
        operatingIncome: fromCents(operatingIncome),
        otherIncome: fromCents(otherIn),
        otherExpenses: fromCents(otherEx),
        netIncome: fromCents(netIncome),
      },
    };
  };

  const total = build(await netByAccount(db, dims, where));
  let columns: Array<{ key: string; label: string; report: ReturnType<typeof build> }> = [];
  if (opts.columns === 'month') {
    for (const m of monthsBetween(from, to)) {
      const start = m.start < from ? from : m.start;
      const end = m.end > to ? to : m.end;
      columns.push({ key: m.key, label: m.label, report: build(await netByAccount(db, dims, { entryDate: { gte: dateOnly(start), lte: dateOnly(end) } })) });
    }
  } else if (opts.columns === 'client') {
    const rows = await db.journalLine.groupBy({ by: ['clientId', 'accountId'], where: lineWhere(dims, where), _sum: { debit: true, credit: true } });
    const byClient = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const k = r.clientId ?? 'none';
      const m = byClient.get(k) ?? new Map<string, number>();
      m.set(r.accountId, toCents(r._sum.debit) - toCents(r._sum.credit));
      byClient.set(k, m);
    }
    const ids = [...byClient.keys()].filter((k) => k !== 'none');
    const names = new Map((await db.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    columns = [...byClient.entries()]
      .map(([k, m]) => ({ key: k, label: k === 'none' ? 'Company' : (names.get(k) ?? 'A client'), report: build(m) }))
      .sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : a.label.localeCompare(b.label)));
  }
  return { from, to, ...total, columns: columns.map((c) => ({ key: c.key, label: c.label, sections: c.report.sections, totals: c.report.totals })) };
}

export function monthsBetween(from: string, to: string): Array<{ key: string; label: string; start: string; end: string }> {
  const out: Array<{ key: string; label: string; start: string; end: string }> = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const [ty, tm] = to.slice(0, 7).split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ key, label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` });
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
    if (out.length > 120) break;
  }
  return out;
}

/* ---- Comparison ranges ---------------------------------------------------- */

export type CompareKind = 'prior' | 'yoy';

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parts = (s: string) => s.split('-').map(Number) as [number, number, number];
const fmtYmd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const isMonthEnd = (s: string) => {
  const [y, m, d] = parts(s);
  return d === lastDayOf(y, m);
};

/** A date `n` months away; the day clamps to the month (Mar 31 − 1 month = Feb 28), or lands on its last day with `toEnd`. */
export function shiftMonths(s: string, n: number, toEnd = false): string {
  const [y, m, d] = parts(s);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = lastDayOf(ny, nm);
  return fmtYmd(ny, nm, toEnd ? last : Math.min(d, last));
}

function addDays(s: string, n: number): string {
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: day arithmetic on YYYY-MM-DD keys anchored at UTC midnight.
  return new Date(Date.parse(`${s}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The range a period statement is compared with. `yoy`: the same dates a
 * year earlier. `prior`: the same span just before — the month before a
 * month (or month-to-date), the quarter before a quarter, last year's for
 * a year (or year-to-date), the same number of months before any other
 * range that starts on the 1st, and the same number of days before one
 * that doesn't.
 */
export function compareRange(from: string, to: string, kind: CompareKind): { from: string; to: string } {
  if (kind === 'yoy') return { from: shiftMonths(from, -12), to: shiftMonths(to, -12, isMonthEnd(to)) };
  const [fy, fm, fd] = parts(from);
  const [ty, tm] = parts(to);
  if (fd === 1) {
    const months = ty * 12 + tm - (fy * 12 + fm) + 1;
    const sameQuarter = fy === ty && Math.floor((fm - 1) / 3) === Math.floor((tm - 1) / 3);
    const shift = months === 1 ? 1 : (fm - 1) % 3 === 0 && sameQuarter ? 3 : fm === 1 && fy === ty ? 12 : months;
    return { from: shiftMonths(from, -shift), to: shiftMonths(to, -shift, isMonthEnd(to)) };
  }
  const days = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
  const end = addDays(from, -1);
  return { from: addDays(end, -(days - 1)), to: end };
}

/** The date a point-in-time statement is compared with: a month earlier (prior) or a year earlier (yoy); a month end stays a month end. */
export function compareAsOf(asOf: string, kind: CompareKind): string {
  return shiftMonths(asOf, kind === 'yoy' ? -12 : -1, isMonthEnd(asOf));
}

/* ---- Balance sheet ------------------------------------------------------- */

/**
 * Assets = liabilities + equity, as of a date. This year's profit so far is
 * shown as its own equity line; earlier years' profit rolls into retained
 * earnings (no closing entry needed — it's computed from the fiscal year).
 */
export async function balanceSheet(db: Db, asOf: string, dims: Dimensions = {}, opts: { fiscalYearStartMonth?: number } = {}) {
  const { byId, byKey } = await accountIndex(db);
  const fyStartMonth = opts.fiscalYearStartMonth ?? 1;
  const [y, m] = asOf.slice(0, 7).split('-').map(Number) as [number, number];
  const fyYear = m >= fyStartMonth ? y : y - 1;
  const fyStart = `${fyYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  const net = await netByAccount(db, dims, { entryDate: { lte: dateOnly(asOf) } });
  const assets: ReportRow[] = [];
  const liabilities: ReportRow[] = [];
  const equity: ReportRow[] = [];
  let priorEarnings = 0;
  let currentEarnings = 0;
  const yearNet = await netByAccount(db, dims, { entryDate: { gte: dateOnly(fyStart), lte: dateOnly(asOf) } });
  for (const [id, n] of net) {
    const a = byId.get(id);
    if (!a || n === 0) continue;
    if (a.type === 'ASSET') assets.push(row(a, n));
    else if (a.type === 'LIABILITY') liabilities.push(row(a, -n));
    else if (a.type === 'EQUITY') equity.push(row(a, -n));
    else {
      // Income and expense: this fiscal year's part is current earnings, the rest prior.
      const thisYear = yearNet.get(id) ?? 0;
      currentEarnings += -thisYear;
      priorEarnings += -(n - thisYear);
    }
  }
  const re = byKey.get('RETAINED_EARNINGS');
  if (priorEarnings !== 0) {
    const existing = re ? equity.find((r) => r.accountId === re.id) : undefined;
    if (existing) existing.amount = fromCents(toCents(existing.amount) + priorEarnings);
    else equity.push({ accountId: re?.id ?? 'retained-earnings', code: re?.code ?? '3100', name: 'Retained earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS', amount: fromCents(priorEarnings) });
  }
  equity.push({ accountId: 'net-income', code: '—', name: 'Net income this year', type: 'EQUITY', subtype: 'CURRENT_EARNINGS', amount: fromCents(currentEarnings) });
  for (const list of [assets, liabilities, equity]) list.sort(byCode);
  const sum = (rows: ReportRow[]) => rows.reduce((s, r) => s + toCents(r.amount), 0);
  const tA = sum(assets);
  const tL = sum(liabilities);
  const tE = sum(equity);
  return {
    asOf,
    fiscalYearStart: fyStart,
    assets,
    liabilities,
    equity,
    totals: { assets: fromCents(tA), liabilities: fromCents(tL), equity: fromCents(tE), liabilitiesAndEquity: fromCents(tL + tE), balanced: tA === tL + tE },
  };
}

/* ---- Cash flow (indirect) ------------------------------------------------ */

const CASH = new Set(['BANK']);
const INVESTING = new Set(['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'OTHER_ASSET']);
const FINANCING = new Set(['LONG_TERM_LIABILITY', 'EQUITY', 'RETAINED_EARNINGS']);

/**
 * Net income, adjusted for what didn't move cash (depreciation, the change
 * in receivables, payables and payroll liabilities) = cash from operations;
 * fixed assets bought or sold = investing; loans and owner money =
 * financing. The three add up to the change in the bank accounts.
 */
export async function cashFlow(db: Db, from: string, to: string, dims: Dimensions = {}) {
  const { byId } = await accountIndex(db);
  const net = await netByAccount(db, dims, { entryDate: { gte: dateOnly(from), lte: dateOnly(to) } });
  let netIncome = 0;
  const operating: ReportRow[] = [];
  const investing: ReportRow[] = [];
  const financing: ReportRow[] = [];
  let cashChange = 0;
  for (const [id, n] of net) {
    const a = byId.get(id);
    if (!a || n === 0) continue;
    if (a.type === 'INCOME' || a.type === 'EXPENSE') {
      netIncome += -n;
      continue;
    }
    if (a.type === 'ASSET' && CASH.has(a.subtype)) {
      cashChange += n;
      continue;
    }
    // Cash effect of a balance-sheet account: an asset growing uses cash, a liability growing provides it.
    const effect = -n;
    const r = row(a, effect);
    if (a.subtype === 'ACCUMULATED_DEPRECIATION') operating.push({ ...r, name: 'Depreciation' });
    else if (INVESTING.has(a.subtype)) investing.push(r);
    else if (FINANCING.has(a.subtype) || a.type === 'EQUITY') financing.push(r);
    else operating.push(r);
  }
  for (const list of [operating, investing, financing]) list.sort(byCode);
  const sum = (rows: ReportRow[]) => rows.reduce((s, r) => s + toCents(r.amount), 0);
  const ops = netIncome + sum(operating);
  const inv = sum(investing);
  const fin = sum(financing);
  return {
    from,
    to,
    netIncome: fromCents(netIncome),
    operating,
    investing,
    financing,
    totals: { operating: fromCents(ops), investing: fromCents(inv), financing: fromCents(fin), netChange: fromCents(ops + inv + fin), cashChange: fromCents(cashChange), reconciles: ops + inv + fin === cashChange },
  };
}

/* ---- Account detail ------------------------------------------------------ */

export async function accountDetail(db: Db, accountId: string, from: string, to: string, dims: Dimensions = {}, opts: { limit?: number } = {}) {
  const { byId } = await accountIndex(db);
  const a = byId.get(accountId);
  if (!a) return null;
  const before = await db.journalLine.aggregate({ where: { ...lineWhere(dims, { entryDate: { lt: dateOnly(from) } }), accountId }, _sum: { debit: true, credit: true } });
  const opening = signed(a, toCents(before._sum.debit) - toCents(before._sum.credit));
  const lines = await db.journalLine.findMany({
    where: { ...lineWhere(dims, { entryDate: { gte: dateOnly(from), lte: dateOnly(to) } }), accountId },
    include: { entry: { select: { id: true, number: true, entryDate: true, memo: true, source: true, sourceType: true, sourceId: true, origin: true } } },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
    take: Math.min(opts.limit ?? 2000, 5000),
  });
  let running = opening;
  const rows = lines.map((l) => {
    const n = toCents(l.debit) - toCents(l.credit);
    running += signed(a, n);
    return {
      lineId: l.id,
      entryId: l.entry.id,
      number: l.entry.number,
      // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: entryDate is a @db.Date stored at UTC midnight.
      date: l.entry.entryDate.toISOString().slice(0, 10),
      memo: l.memo ?? l.entry.memo,
      source: l.entry.source,
      sourceType: l.entry.sourceType,
      sourceId: l.entry.sourceId,
      origin: l.entry.origin,
      debit: fromCents(toCents(l.debit)),
      credit: fromCents(toCents(l.credit)),
      balance: fromCents(running),
      clientId: l.clientId,
      cleared: !!l.clearedAt,
    };
  });
  return { account: { id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }, from, to, opening: fromCents(opening), closing: fromCents(running), rows };
}
