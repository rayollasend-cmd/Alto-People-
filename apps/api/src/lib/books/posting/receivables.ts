import { Prisma } from '@prisma/client';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { emitBooksChange } from '../events.js';
import { accountByKey, postEntry } from '../ledger.js';
import { cents, voidByKey, ymd, type Db } from './common.js';
import { postStatement, statementAmounts } from './statements.js';
import { orgDateKey } from '../../timeAnomalies.js';
import { AGING_BUCKETS, bucketFor, daysPastDue, dueOnFor, zeroBuckets, type AgingBucket } from '../aging.js';

/**
 * Money clients pay, and what they still owe.
 *
 * A ClientPayment is the money received; its applications say which
 * statements it pays. It posts Dr the deposit account (operating checking,
 * or Undeposited funds for a check not yet banked) Cr Accounts receivable.
 * When a statement's applications cover it, the statement is marked paid —
 * the same paidAt the statements screen always used, so "Mark paid" there is
 * just a payment of the open balance through here (one path, one ledger).
 */

export const paymentKey = (id: string) => `client-payment:${id}`;

export type ClientPaymentMethod = 'ACH' | 'CHECK' | 'WIRE' | 'CARD' | 'OTHER';

export interface StatementBalance {
  statementId: string;
  clientId: string;
  number: number | null;
  periodStart: string;
  periodEnd: string;
  finalizedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  total: number; // cents
  applied: number; // cents
  open: number; // cents
}

/** Final statements and what's still open on each (a statement marked paid before payments existed is closed). */
export async function statementBalances(db: Db, where: Prisma.ClientStatementWhereInput = {}): Promise<StatementBalance[]> {
  const rows = await db.clientStatement.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'FINAL', ...where },
    select: { id: true, clientId: true, number: true, periodStart: true, periodEnd: true, finalizedAt: true, dueAt: true, paidAt: true, snapshot: true },
    orderBy: [{ dueAt: 'asc' }, { periodStart: 'asc' }],
  });
  if (rows.length === 0) return [];
  const apps = await db.clientPaymentApplication.groupBy({
    by: ['statementId'],
    where: { statementId: { in: rows.map((r) => r.id) }, payment: { voidedAt: null } },
    _sum: { amount: true },
  });
  const applied = new Map(apps.map((a) => [a.statementId, cents(a._sum.amount)]));
  return rows.map((r) => {
    const total = statementAmounts(r.snapshot).total;
    const got = applied.get(r.id) ?? 0;
    // Paid before payments were recorded here: nothing open.
    const open = r.paidAt && got === 0 ? 0 : Math.max(0, total - got);
    return {
      statementId: r.id,
      clientId: r.clientId,
      number: r.number,
      periodStart: ymd(r.periodStart),
      periodEnd: ymd(r.periodEnd),
      finalizedAt: r.finalizedAt?.toISOString() ?? null,
      dueAt: r.dueAt ? ymd(r.dueAt) : null,
      paidAt: r.paidAt?.toISOString() ?? null,
      total,
      applied: got,
      open,
    };
  });
}

export interface RecordPaymentInput {
  clientId: string;
  receivedOn: string;
  /** Dollars. */
  amount: number;
  method: ClientPaymentMethod;
  reference?: string | null;
  /** A ledger account id; default operating checking (Undeposited funds for a check). */
  depositAccountId?: string | null;
  applications: Array<{ statementId: string; amount: number }>;
  userId: string | null;
}

export async function recordClientPayment(
  db: Prisma.TransactionClient | import('@prisma/client').PrismaClient,
  input: RecordPaymentInput,
  opts: { settleMarkedPaid?: boolean } = {},
) {
  const tenantId = tenantIdForWrite();
  const amount = cents(input.amount);
  if (amount <= 0) throw new HttpError(400, 'invalid_amount', 'A payment is more than zero.');
  const client = await db.client.findFirst({ where: { id: input.clientId, tenantId }, select: { id: true, name: true } });
  if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');

  const deposit = input.depositAccountId
    ? await db.ledgerAccount.findFirst({ where: { id: input.depositAccountId, tenantId } })
    : await accountByKey(db, input.method === 'CHECK' ? 'UNDEPOSITED' : 'CASH_OPERATING');
  if (!deposit || deposit.type !== 'ASSET' || !['BANK', 'CURRENT_ASSET'].includes(deposit.subtype)) {
    throw new HttpError(400, 'invalid_deposit_account', 'Deposit to a bank account or Undeposited funds.');
  }

  const apps = input.applications.map((a) => ({ statementId: a.statementId, amount: cents(a.amount) })).filter((a) => a.amount > 0);
  const appliedTotal = apps.reduce((s, a) => s + a.amount, 0);
  if (appliedTotal > amount) throw new HttpError(400, 'over_applied', 'The statements paid add up to more than the payment.');
  if (new Set(apps.map((a) => a.statementId)).size !== apps.length) throw new HttpError(400, 'duplicate_statement', 'Each statement once.');
  const balances = apps.length ? await statementBalances(db, { id: { in: apps.map((a) => a.statementId) } }) : [];
  const byId = new Map(balances.map((b) => [b.statementId, b]));
  // A statement marked paid before payments were recorded reads 0 open; settling it records the money it was marked paid with.
  const openOf = (b: StatementBalance) => (opts.settleMarkedPaid && b.paidAt && b.applied === 0 ? b.total : b.open);
  for (const a of apps) {
    const b = byId.get(a.statementId);
    if (!b || b.clientId !== client.id) throw new HttpError(400, 'statement_not_open', 'A statement in this payment isn’t a final statement of this client.');
    if (a.amount > openOf(b)) throw new HttpError(400, 'over_statement', `More than statement ${b.number ?? ''} still owes (${(openOf(b) / 100).toFixed(2)}).`.replace('  ', ' '));
  }

  const run = async (tx: Prisma.TransactionClient) => {
    const payment = await tx.clientPayment.create({
      data: {
        tenantId,
        clientId: client.id,
        receivedOn: new Date(`${input.receivedOn}T00:00:00.000Z`),
        amount: new Prisma.Decimal(amount / 100),
        method: input.method,
        reference: input.reference?.trim().slice(0, 80) || null,
        depositAccountId: deposit.id,
        createdById: input.userId,
        applications: { create: apps.map((a) => ({ tenantId, statementId: a.statementId, amount: new Prisma.Decimal(a.amount / 100) })) },
      },
      include: { applications: true },
    });
    const entry = await postEntry(tx, {
      date: input.receivedOn,
      memo: `Payment from ${client.name}${payment.reference ? ` · ${payment.reference}` : ''}`,
      source: 'CLIENT_PAYMENT',
      sourceType: 'ClientPayment',
      sourceId: payment.id,
      sourceKey: paymentKey(payment.id),
      createdById: input.userId,
      lines: [
        { account: deposit.id, debit: amount / 100, clientId: client.id },
        { account: 'AR', credit: amount / 100, clientId: client.id },
      ],
    });
    await tx.clientPayment.update({ where: { id: payment.id }, data: { journalEntryId: entry.id } });
    // Statements this payment finishes are paid (one already marked paid keeps its date and reference).
    for (const a of apps) {
      const b = byId.get(a.statementId)!;
      if (opts.settleMarkedPaid && b.paidAt) continue;
      if (a.amount >= b.open) {
        await tx.clientStatement.update({
          where: { id: a.statementId },
          data: { paidAt: new Date(`${input.receivedOn}T12:00:00.000Z`), paidById: input.userId, paymentRef: payment.reference ?? `${input.method} payment` },
        });
      }
    }
    return { ...payment, journalEntryId: entry.id };
  };
  const payment = '$transaction' in db ? await (db as import('@prisma/client').PrismaClient).$transaction(run) : await run(db as Prisma.TransactionClient);
  emitBooksChange({ localType: 'ClientPayment', localId: payment.id, op: 'UPSERT' });
  return payment;
}

/** Take a payment back (entered by mistake, a bounced check): off the books, its statements open again. */
export async function undoClientPayment(db: import('@prisma/client').PrismaClient, id: string, input: { reason: string; userId: string | null }) {
  const tenantId = tenantIdForWrite();
  const payment = await db.clientPayment.findFirst({ where: { id, tenantId }, include: { applications: true } });
  if (!payment) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
  if (payment.voidedAt) throw new HttpError(409, 'already_undone', 'This payment was already undone.');
  // A bank deposit matched to this payment's lines goes back to review with it — otherwise the bank page would
  // show it done while the cash it stands for is off the books. One already in a completed reconciliation stops this.
  const lineIds = payment.journalEntryId ? (await db.journalLine.findMany({ where: { tenantId, entryId: payment.journalEntryId }, select: { id: true, clearedAt: true } })) : [];
  const deposits = lineIds.length ? await db.bankTransaction.findMany({ where: { tenantId, status: 'MATCHED', matchedLineId: { in: lineIds.map((l) => l.id) } }, select: { id: true, matchedLineId: true } }) : [];
  if (deposits.some((d) => lineIds.find((l) => l.id === d.matchedLineId)?.clearedAt)) {
    throw new HttpError(409, 'reconciled', 'The deposit this payment was matched to is in a completed reconciliation. Undo that reconciliation first.');
  }
  const claimed = await db.$transaction(async (tx) => {
    const undone = await tx.clientPayment.updateMany({ where: { id, voidedAt: null }, data: { voidedAt: new Date() } });
    if (undone.count === 0) return false;
    await voidByKey(tx, paymentKey(id), input.reason);
    if (deposits.length) {
      await tx.bankTransaction.updateMany({
        where: { id: { in: deposits.map((d) => d.id) }, status: 'MATCHED' },
        data: { status: 'UNMATCHED', matchedLineId: null, journalEntryId: null, ruleId: null, decidedById: null, decidedAt: null },
      });
    }
    return true;
  });
  if (!claimed) throw new HttpError(409, 'already_undone', 'This payment was already undone.');
  // A statement this payment had finished is open again.
  const balances = await statementBalances(db, { id: { in: payment.applications.map((a) => a.statementId) } });
  for (const b of balances) {
    const otherApplied = await db.clientPaymentApplication.count({ where: { statementId: b.statementId, payment: { voidedAt: null } } });
    if (b.paidAt && (b.applied < b.total || otherApplied === 0)) {
      await db.clientStatement.update({ where: { id: b.statementId }, data: { paidAt: null, paidById: null, paymentRef: null } });
    }
  }
  emitBooksChange({ localType: 'ClientPayment', localId: id, op: 'DELETE' });
}

/**
 * "Mark paid" on a statement: a payment of whatever is still open on it,
 * received today (the company's day, not UTC's), through the one payment
 * path. A statement with nothing open (a $0 statement) is simply marked paid.
 */
export async function recordStatementPaidInFull(db: import('@prisma/client').PrismaClient, input: { statementId: string; userId: string | null; paymentRef: string | null; receivedOn?: string; method?: ClientPaymentMethod }) {
  const [b] = await statementBalances(db, { id: input.statementId });
  if (!b) throw new HttpError(404, 'not_found', 'Statement not found.');
  const receivedOn = input.receivedOn ?? orgDateKey(new Date());
  if (b.open > 0) {
    await recordClientPayment(db, {
      clientId: b.clientId,
      receivedOn,
      amount: b.open / 100,
      method: input.method ?? 'OTHER',
      reference: input.paymentRef,
      applications: [{ statementId: b.statementId, amount: b.open / 100 }],
      userId: input.userId,
    });
  }
  // The statement keeps the reference as given, paid the day the money arrived (MONEY-17: a check that came last week isn't dated today).
  return db.clientStatement.update({
    where: { id: input.statementId },
    data: { paidAt: new Date(`${receivedOn}T12:00:00.000Z`), paidById: input.userId, paymentRef: input.paymentRef },
    include: { finalizedBy: { select: { email: true } } },
  });
}

/**
 * Statements marked paid with no payment behind them (audit 2026-10-29
 * MONEY-3): finalized, posted to receivables in the books, marked paid on
 * the statement — but no ClientPayment, so the books still count them as
 * owed while the statements read paid. Older "Mark paid" flows and seeded
 * data wrote paidAt directly. Cents.
 */
export async function paidWithoutPayment(db: Db, where: Prisma.ClientStatementWhereInput = {}): Promise<StatementBalance[]> {
  return (await statementBalances(db, { paidAt: { not: null }, ...where })).filter((b) => b.applied === 0 && b.total > 0);
}

/**
 * Record the payment each of those statements was marked paid with — dated
 * the company day it was marked paid, for its full amount, into operating
 * checking — so the books' receivables match the statements. Idempotent:
 * a statement with a payment is no longer in the list. The statement's own
 * paidAt and reference are kept. Returns what it recorded.
 */
export async function settleMarkedPaidStatements(db: import('@prisma/client').PrismaClient, opts: { userId: string | null; since?: Date }): Promise<{ payments: number; amount: number; failed: Array<{ statementId: string; error: string }> }> {
  const list = await paidWithoutPayment(db, opts.since ? { paidAt: { gte: opts.since } } : {});
  const out = { payments: 0, amount: 0, failed: [] as Array<{ statementId: string; error: string }> };
  for (const b of list) {
    try {
      // Receivables first: a statement that never posted would leave the payment crediting nothing.
      await postStatement(db, b.statementId);
      const ref = (await db.clientStatement.findFirst({ where: { id: b.statementId }, select: { paymentRef: true } }))?.paymentRef ?? null;
      await recordClientPayment(
        db,
        {
          clientId: b.clientId,
          receivedOn: orgDateKey(new Date(b.paidAt!)),
          amount: b.total / 100,
          method: 'OTHER',
          reference: ref ?? `Marked paid${b.number !== null ? ` · No. ${String(b.number).padStart(4, '0')}` : ''}`,
          applications: [{ statementId: b.statementId, amount: b.total / 100 }],
          userId: opts.userId,
        },
        { settleMarkedPaid: true },
      );
      out.payments += 1;
      out.amount += b.total;
    } catch (err) {
      out.failed.push({ statementId: b.statementId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/* ---- Aging ------------------------------------------------------------ */

// The one aging definition lives in lib/books/aging (finance walk 3); re-exported for callers here.
export { AGING_BUCKETS, bucketFor };
export type { AgingBucket };

export async function agingReport(db: Db, asOf: string, opts: { clientId?: string } = {}) {
  const open = (await statementBalances(db, opts.clientId ? { clientId: opts.clientId } : {})).filter((b) => b.open > 0);
  const clientIds = [...new Set(open.map((b) => b.clientId))];
  const [clients, unapplied] = await Promise.all([
    db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    unappliedCredits(db, clientIds),
  ]);
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const zero = () => zeroBuckets();
  const byClient = new Map<string, { clientId: string; clientName: string; buckets: Record<AgingBucket, number>; open: number; statements: number; oldestDaysPastDue: number; unapplied: number }>();
  const statements = open.map((b) => {
    const due = dueOnFor(b) ?? b.periodEnd;
    const days = daysPastDue(due, asOf);
    const bucket = bucketFor(days);
    const row = byClient.get(b.clientId) ?? { clientId: b.clientId, clientName: names.get(b.clientId) ?? 'A client', buckets: zero(), open: 0, statements: 0, oldestDaysPastDue: 0, unapplied: unapplied.get(b.clientId) ?? 0 };
    row.buckets[bucket] += b.open;
    row.open += b.open;
    row.statements += 1;
    row.oldestDaysPastDue = Math.max(row.oldestDaysPastDue, days);
    byClient.set(b.clientId, row);
    return { ...b, dueOn: due, daysPastDue: days, bucket, clientName: names.get(b.clientId) ?? 'A client' };
  });
  const rows = [...byClient.values()].sort((a, b) => b.open - a.open);
  const totals = rows.reduce((t, r) => {
    for (const k of AGING_BUCKETS) t.buckets[k] += r.buckets[k];
    t.open += r.open;
    return t;
  }, { buckets: zero(), open: 0 });
  return { asOf, rows, statements, totals };
}

/** Money a client paid that no statement has taken yet, cents. */
export async function unappliedCredits(db: Db, clientIds: string[]): Promise<Map<string, number>> {
  if (clientIds.length === 0) return new Map();
  const payments = await db.clientPayment.findMany({
    where: { tenantId: tenantIdForWrite(), clientId: { in: clientIds }, voidedAt: null },
    select: { clientId: true, amount: true, applications: { select: { amount: true } } },
  });
  const out = new Map<string, number>();
  for (const p of payments) {
    const left = cents(p.amount) - p.applications.reduce((s, a) => s + cents(a.amount), 0);
    if (left > 0) out.set(p.clientId, (out.get(p.clientId) ?? 0) + left);
  }
  return out;
}
