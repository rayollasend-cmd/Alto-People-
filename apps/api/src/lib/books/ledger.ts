import { createHash } from 'node:crypto';
import { Prisma, type JournalEntry, type JournalLine, type LedgerAccount, type PrismaClient } from '@prisma/client';
import { HttpError } from '../../middleware/error.js';
import { tenantIdForWrite } from '../tenant.js';
import { ensureChart } from './chart.js';
import { emitBooksChange } from './events.js';

/**
 * The general ledger's one door. Everything that moves money in the books
 * — payroll, statements, payments, bills, the bank, depreciation, a manual
 * entry, a change pulled from QuickBooks — posts through here, so every
 * rule holds in one place:
 *
 *  - an entry balances (debits = credits, to the cent) or it isn't posted;
 *  - a CLOSED month takes nothing: a late change to a closed month lands as
 *    an adjustment in the first open month instead;
 *  - automatic posting is idempotent by sourceKey ("payroll-run:<id>"):
 *    posting the same thing twice changes nothing, posting it CHANGED
 *    rewrites the entry while its month is open, or posts the difference
 *    once it's closed;
 *  - void and reverse never delete: a voided entry stays on the record.
 *
 * Amounts in and out are dollars as numbers; inside, everything is cents.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type JournalSource =
  | 'MANUAL'
  | 'PAYROLL'
  | 'PAYROLL_DISBURSEMENT'
  | 'STATEMENT'
  | 'CLIENT_PAYMENT'
  | 'TAX_PAYMENT'
  | 'REIMBURSEMENT'
  | 'GARNISHMENT'
  | 'BILL'
  | 'BILL_PAYMENT'
  | 'BANK'
  | 'DEPRECIATION'
  | 'ACCRUAL'
  | 'REVERSAL'
  | 'QUICKBOOKS'
  | 'OPENING'
  | 'ASSET_DISPOSAL';

export interface PostLine {
  /** A systemKey ("AR", "WAGES_DIRECT") or an account id. */
  account: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
  clientId?: string | null;
  siteId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  vendorId?: string | null;
}

export interface PostInput {
  /** YYYY-MM-DD */
  date: string;
  memo?: string | null;
  source: JournalSource;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Idempotency key for automatic posting. Omit for a manual entry. */
  sourceKey?: string | null;
  lines: PostLine[];
  createdById?: string | null;
  /** An accrual: reverse automatically on this date (YYYY-MM-DD). */
  reverseOn?: string | null;
  origin?: 'SITE' | 'QUICKBOOKS';
}

export type EntryWithLines = JournalEntry & { lines: JournalLine[] };

export const toCents = (n: number | string | Prisma.Decimal | null | undefined): number => Math.round(Number(n ?? 0) * 100);
export const fromCents = (c: number): number => Math.round(c) / 100 + 0;
export const periodOf = (ymd: string): string => ymd.slice(0, 7);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/* ---- Accounts ------------------------------------------------------------ */

/** Every account by id and by systemKey, for the tenant in context (the chart seeded on first use). */
export async function accountIndex(db: Db): Promise<{ byId: Map<string, LedgerAccount>; byKey: Map<string, LedgerAccount> }> {
  const tenantId = tenantIdForWrite();
  let accounts = await db.ledgerAccount.findMany({ where: { tenantId } });
  if (accounts.length === 0) {
    await ensureChart(db);
    accounts = await db.ledgerAccount.findMany({ where: { tenantId } });
  }
  return {
    byId: new Map(accounts.map((a) => [a.id, a])),
    byKey: new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a])),
  };
}

/** The account a systemKey names (the chart seeded if need be). */
export async function accountByKey(db: Db, systemKey: string): Promise<LedgerAccount> {
  const { byKey } = await accountIndex(db);
  let a = byKey.get(systemKey);
  if (!a) {
    await ensureChart(db);
    a = (await accountIndex(db)).byKey.get(systemKey);
  }
  if (!a) throw new HttpError(500, 'account_missing', `No ledger account for ${systemKey}.`);
  return a;
}

/* ---- Periods ------------------------------------------------------------- */

export async function isPeriodClosed(db: Db, periodKey: string): Promise<boolean> {
  const p = await db.fiscalPeriod.findUnique({ where: { tenantId_periodKey: { tenantId: tenantIdForWrite(), periodKey } }, select: { status: true } });
  return p?.status === 'CLOSED';
}

/** The first day on or after `date` whose month is open. */
export async function firstOpenDate(db: Db, date: string): Promise<string> {
  const closed = new Set(
    (await db.fiscalPeriod.findMany({ where: { tenantId: tenantIdForWrite(), status: 'CLOSED', periodKey: { gte: periodOf(date) } }, select: { periodKey: true } })).map((p) => p.periodKey),
  );
  let d = date;
  for (let i = 0; i < 240 && closed.has(periodOf(d)); i++) {
    const [y, m] = periodOf(d).split('-').map(Number) as [number, number];
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return d;
}

export async function assertPeriodOpen(db: Db, date: string): Promise<void> {
  if (await isPeriodClosed(db, periodOf(date))) {
    throw new HttpError(409, 'period_closed', `${periodOf(date)} is closed. Reopen it, or date the entry in an open month.`);
  }
}

/* ---- Lines --------------------------------------------------------------- */

interface ResolvedLine {
  accountId: string;
  debit: number; // cents
  credit: number; // cents
  memo: string | null;
  clientId: string | null;
  siteId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  vendorId: string | null;
}

async function resolveLines(db: Db, lines: PostLine[]): Promise<ResolvedLine[]> {
  const { byId, byKey } = await accountIndex(db);
  const out: ResolvedLine[] = [];
  for (const l of lines) {
    const account = isUuid(l.account) ? byId.get(l.account) : byKey.get(l.account);
    if (!account) throw new HttpError(400, 'unknown_account', `No ledger account "${l.account}".`);
    if (!account.isActive) throw new HttpError(400, 'inactive_account', `${account.code} ${account.name} is inactive.`);
    let debit = toCents(l.debit);
    let credit = toCents(l.credit);
    // A negative amount is the other side; a line on both sides nets.
    if (debit < 0) [credit, debit] = [credit - debit, 0];
    if (credit < 0) [debit, credit] = [debit - credit, 0];
    const net = debit - credit;
    if (net === 0) continue;
    out.push({
      accountId: account.id,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
      memo: l.memo?.slice(0, 300) ?? null,
      clientId: l.clientId ?? null,
      siteId: l.siteId ?? null,
      departmentId: l.departmentId ?? null,
      costCenterId: l.costCenterId ?? null,
      vendorId: l.vendorId ?? null,
    });
  }
  return out;
}

function assertBalanced(lines: ResolvedLine[]): number {
  if (lines.length < 2) throw new HttpError(400, 'entry_too_short', 'An entry needs at least one debit and one credit.');
  const d = lines.reduce((n, l) => n + l.debit, 0);
  const c = lines.reduce((n, l) => n + l.credit, 0);
  if (d !== c) throw new HttpError(400, 'entry_unbalanced', `Debits ${fromCents(d).toFixed(2)} and credits ${fromCents(c).toFixed(2)} don’t match (off by ${fromCents(Math.abs(d - c)).toFixed(2)}).`);
  return d;
}

const lineKey = (l: ResolvedLine) => [l.accountId, l.clientId, l.siteId, l.departmentId, l.costCenterId, l.vendorId].join('|');

/** What an entry says, independent of line order — equal fingerprints mean nothing changed. */
function fingerprint(date: string, memo: string | null, lines: ResolvedLine[]): string {
  const body = lines.map((l) => `${lineKey(l)}|${l.debit}|${l.credit}|${l.memo ?? ''}`).sort().join('\n');
  return createHash('sha256').update(`${date}\n${memo ?? ''}\n${body}`).digest('hex');
}

function dbLines(lines: JournalLine[]): ResolvedLine[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    debit: toCents(l.debit),
    credit: toCents(l.credit),
    memo: l.memo,
    clientId: l.clientId,
    siteId: l.siteId,
    departmentId: l.departmentId,
    costCenterId: l.costCenterId,
    vendorId: l.vendorId,
  }));
}

/* ---- Posting ------------------------------------------------------------- */

async function nextNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`journal:${tenantId}`}, 0))`;
  const max = await tx.journalEntry.aggregate({ where: { tenantId }, _max: { number: true } });
  return (max._max.number ?? 0) + 1;
}

async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return '$transaction' in db ? (db as PrismaClient).$transaction(fn) : fn(db as Prisma.TransactionClient);
}

async function createEntry(tx: Prisma.TransactionClient, input: PostInput, date: string, lines: ResolvedLine[], sourceKey: string | null): Promise<EntryWithLines> {
  const tenantId = tenantIdForWrite();
  const total = assertBalanced(lines);
  const number = await nextNumber(tx, tenantId);
  return tx.journalEntry.create({
    data: {
      tenantId,
      number,
      entryDate: dateOnly(date),
      periodKey: periodOf(date),
      memo: input.memo?.slice(0, 500) ?? null,
      source: input.source,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceKey,
      origin: input.origin ?? 'SITE',
      reverseOn: input.reverseOn ? dateOnly(input.reverseOn) : null,
      totalDebit: new Prisma.Decimal(fromCents(total)),
      createdById: input.createdById ?? null,
      lines: {
        create: lines.map((l, i) => ({
          tenantId,
          lineNo: i + 1,
          accountId: l.accountId,
          debit: new Prisma.Decimal(fromCents(l.debit)),
          credit: new Prisma.Decimal(fromCents(l.credit)),
          memo: l.memo,
          clientId: l.clientId,
          siteId: l.siteId,
          departmentId: l.departmentId,
          costCenterId: l.costCenterId,
          vendorId: l.vendorId,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
}

/**
 * Post an entry. With a sourceKey it's an upsert: unchanged → the existing
 * entry; changed and its month open → rewritten in place; changed and its
 * month closed → the difference posted as an adjustment in the first open
 * month ("<key>:adj:<n>"). Without a sourceKey (a manual entry) the month
 * must be open.
 */
export async function postEntry(db: Db, input: PostInput): Promise<EntryWithLines> {
  const lines = await resolveLines(db, input.lines);
  assertBalanced(lines);
  const result = await inTx(db, async (tx) => {
    const tenantId = tenantIdForWrite();
    if (!input.sourceKey) {
      await assertPeriodOpen(tx, input.date);
      return { entry: await createEntry(tx, input, input.date, lines, null), op: 'created' as const };
    }
    const existing = await tx.journalEntry.findUnique({ where: { tenantId_sourceKey: { tenantId, sourceKey: input.sourceKey } }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!existing || existing.status === 'VOID') {
      if (existing) {
        // A voided entry gives its key up so the thing can post again.
        await tx.journalEntry.update({ where: { id: existing.id }, data: { sourceKey: `${input.sourceKey}#void:${existing.id.slice(0, 8)}` } });
      }
      const date = (await isPeriodClosed(tx, periodOf(input.date))) ? await firstOpenDate(tx, input.date) : input.date;
      return { entry: await createEntry(tx, input, date, lines, input.sourceKey), op: 'created' as const };
    }
    const was = ymd(existing.entryDate);
    // Everything ever posted under this key (the entry and its adjustments), netted.
    const adjustments = await tx.journalEntry.findMany({ where: { tenantId, sourceKey: { startsWith: `${input.sourceKey}:adj:` }, status: 'POSTED' }, include: { lines: true } });
    const posted = [...dbLines(existing.lines), ...adjustments.flatMap((a) => dbLines(a.lines))];
    if (adjustments.length === 0 && fingerprint(was, existing.memo, dbLines(existing.lines)) === fingerprint(input.date, input.memo ?? null, lines)) {
      return { entry: existing, op: 'unchanged' as const };
    }
    if (adjustments.length === 0 && !(await isPeriodClosed(tx, existing.periodKey)) && !(await isPeriodClosed(tx, periodOf(input.date)))) {
      // Rewrite in place: same number, same key, new lines.
      const total = assertBalanced(lines);
      await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
      const entry = await tx.journalEntry.update({
        where: { id: existing.id },
        data: {
          entryDate: dateOnly(input.date),
          periodKey: periodOf(input.date),
          memo: input.memo?.slice(0, 500) ?? null,
          totalDebit: new Prisma.Decimal(fromCents(total)),
          lines: {
            create: lines.map((l, i) => ({ tenantId, lineNo: i + 1, accountId: l.accountId, debit: new Prisma.Decimal(fromCents(l.debit)), credit: new Prisma.Decimal(fromCents(l.credit)), memo: l.memo, clientId: l.clientId, siteId: l.siteId, departmentId: l.departmentId, costCenterId: l.costCenterId, vendorId: l.vendorId })),
          },
        },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      return { entry, op: 'rewritten' as const };
    }
    // A closed month: post only what changed, in the first open month.
    const net = new Map<string, ResolvedLine>();
    const add = (l: ResolvedLine, sign: 1 | -1) => {
      const k = lineKey(l);
      const cur = net.get(k) ?? { ...l, debit: 0, credit: 0 };
      const amount = (l.debit - l.credit) * sign + (cur.debit - cur.credit);
      net.set(k, { ...cur, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 });
    };
    for (const l of lines) add(l, 1);
    for (const l of posted) add(l, -1);
    const diff = [...net.values()].filter((l) => l.debit !== 0 || l.credit !== 0);
    if (diff.length === 0) return { entry: existing, op: 'unchanged' as const };
    const date = await firstOpenDate(tx, input.date > ymd(new Date()) ? input.date : ymd(new Date()));
    const entry = await createEntry(tx, { ...input, memo: `Adjustment to entry #${existing.number}${input.memo ? ` — ${input.memo}` : ''}` }, date, diff, `${input.sourceKey}:adj:${adjustments.length + 1}`);
    return { entry, op: 'adjusted' as const };
  });
  if (result.op !== 'unchanged') emitBooksChange({ localType: 'JournalEntry', localId: result.entry.id, op: 'UPSERT', source: input.source, origin: input.origin ?? 'SITE' });
  return result.entry;
}

/** The entry posted under a sourceKey, if any (its adjustments not included). */
export async function entryForKey(db: Db, sourceKey: string): Promise<EntryWithLines | null> {
  return db.journalEntry.findUnique({ where: { tenantId_sourceKey: { tenantId: tenantIdForWrite(), sourceKey } }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
}

/**
 * Take an entry off the books. Its month open: it's voided (kept, marked
 * VOID, out of every report). Its month closed: a reversing entry is posted
 * in the first open month instead, and the original stands.
 */
export async function voidEntry(db: Db, id: string, input: { reason: string; userId?: string | null }): Promise<{ voided: boolean; reversal: EntryWithLines | null }> {
  const tenantId = tenantIdForWrite();
  const entry = await db.journalEntry.findFirst({ where: { id, tenantId }, include: { lines: true } });
  if (!entry) throw new HttpError(404, 'entry_not_found', 'Journal entry not found.');
  if (entry.status === 'VOID') throw new HttpError(409, 'already_void', 'This entry is already void.');
  if (!(await isPeriodClosed(db, entry.periodKey))) {
    await db.journalEntry.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidedById: input.userId ?? null, voidReason: input.reason.slice(0, 300) } });
    emitBooksChange({ localType: 'JournalEntry', localId: id, op: 'DELETE', source: entry.source as JournalSource, origin: entry.origin as 'SITE' | 'QUICKBOOKS' });
    return { voided: true, reversal: null };
  }
  const reversal = await reverseEntry(db, id, { date: ymd(new Date()), memo: `Reverses #${entry.number} (its month is closed): ${input.reason}`, userId: input.userId });
  return { voided: false, reversal };
}

/** Post the mirror image of an entry on `date` (an accrual's reversal, or a correction to a closed month). */
export async function reverseEntry(db: Db, id: string, input: { date: string; memo?: string; userId?: string | null }): Promise<EntryWithLines> {
  const tenantId = tenantIdForWrite();
  const entry = await db.journalEntry.findFirst({ where: { id, tenantId }, include: { lines: true } });
  if (!entry) throw new HttpError(404, 'entry_not_found', 'Journal entry not found.');
  const date = await firstOpenDate(db, input.date);
  const reversal = await postEntry(db, {
    date,
    memo: input.memo ?? `Reverses #${entry.number}`,
    source: 'REVERSAL',
    sourceType: 'JournalEntry',
    sourceId: entry.id,
    sourceKey: `reversal:${entry.id}`,
    createdById: input.userId ?? null,
    lines: entry.lines.map((l) => ({
      account: l.accountId,
      debit: Number(l.credit),
      credit: Number(l.debit),
      memo: l.memo,
      clientId: l.clientId,
      siteId: l.siteId,
      departmentId: l.departmentId,
      costCenterId: l.costCenterId,
      vendorId: l.vendorId,
    })),
  });
  await db.journalEntry.update({ where: { id: reversal.id }, data: { reversesId: entry.id } });
  return reversal;
}

/* ---- Balances ------------------------------------------------------------ */

/** An account's balance through a date (inclusive), signed so its normal side is positive. */
/**
 * The cash position: every active bank account's balance, less the card
 * balances — the one number the Books overview, the cash forecast and the
 * bill run read (finance walk 2, 8).
 */
export async function cashOnHand(db: Db, through: string): Promise<{ total: number; accounts: number; postedAccounts: number }> {
  const tenantId = tenantIdForWrite();
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId, isActive: true, subtype: { in: ['BANK', 'CREDIT_CARD'] } }, select: { id: true, subtype: true } });
  if (accounts.length === 0) return { total: 0, accounts: 0, postedAccounts: 0 };
  const rows = await db.journalLine.groupBy({
    by: ['accountId'],
    where: { tenantId, accountId: { in: accounts.map((a) => a.id) }, entry: { status: 'POSTED', entryDate: { lte: dateOnly(through) } } },
    _sum: { debit: true, credit: true },
  });
  const net = new Map(rows.map((r) => [r.accountId, toCents(r._sum.debit) - toCents(r._sum.credit)]));
  // A bank account is debit-normal (cash in = debit); a card's balance is what is owed, so it counts against cash.
  const total = accounts.reduce((s, a) => s + (net.get(a.id) ?? 0), 0);
  // postedAccounts: how many of them hold any posted line — 0 means the
  // books have accounts but no balance on file, not a real $0.00.
  return { total: fromCents(total), accounts: accounts.length, postedAccounts: rows.length };
}

export async function accountBalance(db: Db, accountId: string, through: string): Promise<number> {
  const tenantId = tenantIdForWrite();
  const account = await db.ledgerAccount.findFirst({ where: { id: accountId, tenantId } });
  if (!account) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
  const agg = await db.journalLine.aggregate({
    where: { tenantId, accountId, entry: { status: 'POSTED', entryDate: { lte: dateOnly(through) } } },
    _sum: { debit: true, credit: true },
  });
  const net = toCents(agg._sum.debit) - toCents(agg._sum.credit);
  return fromCents(account.type === 'ASSET' || account.type === 'EXPENSE' ? net : -net);
}
