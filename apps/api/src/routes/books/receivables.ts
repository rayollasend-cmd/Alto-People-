import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ClientPaymentInputSchema, type ClientPaymentRow, type ReceivableStatement } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { agingReport, recordClientPayment, undoClientPayment, unappliedCredits } from '../../lib/books/posting/receivables.js';
import { backfillPosting, postingGaps } from '../../lib/books/posting/gaps.js';
import { cents, ymd } from '../../lib/books/posting/common.js';
import { accountByKey } from '../../lib/books/ledger.js';
import { paymentFromDeposit } from '../../lib/books/bank/service.js';
import { nextReminderOn } from '../../lib/statementDunning.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';

/**
 * /books/receivables — what clients owe and the money they pay (contract:
 * packages/shared/src/books/receivables.ts). Reads need view:books (the
 * books router); recording, undoing and the backfill need manage:books.
 */
export const booksReceivablesRouter = Router();
const MANAGE = requireCapability('manage:books');

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dollars = (c: number) => Math.round(c) / 100;

type AgingStatement = Awaited<ReturnType<typeof agingReport>>['statements'][number];
const statementDto = (s: AgingStatement): ReceivableStatement => ({
  statementId: s.statementId,
  clientId: s.clientId,
  clientName: s.clientName,
  number: s.number,
  periodStart: s.periodStart,
  periodEnd: s.periodEnd,
  dueOn: s.dueOn,
  daysPastDue: s.daysPastDue,
  bucket: s.bucket,
  total: dollars(s.total),
  applied: dollars(s.applied),
  open: dollars(s.open),
});

const bucketsDto = (b: Record<string, number>) => ({
  current: dollars(b.current ?? 0),
  days1to30: dollars(b.days1to30 ?? 0),
  days31to60: dollars(b.days31to60 ?? 0),
  days61to90: dollars(b.days61to90 ?? 0),
  over90: dollars(b.over90 ?? 0),
});

booksReceivablesRouter.get('/', async (req, res, next) => {
  try {
    const q = z.object({ asOf: Ymd.optional() }).parse(req.query);
    const r = await agingReport(prisma, q.asOf ?? orgDateKey(new Date()));
    res.json({
      asOf: r.asOf,
      rows: r.rows.map((row) => ({ ...row, buckets: bucketsDto(row.buckets), open: dollars(row.open), unapplied: dollars(row.unapplied) })),
      statements: r.statements.map(statementDto),
      totals: { buckets: bucketsDto(r.totals.buckets), open: dollars(r.totals.open) },
    });
  } catch (err) {
    next(err);
  }
});

const paymentInclude = {
  applications: true,
} satisfies Prisma.ClientPaymentInclude;

async function paymentRows(where: Prisma.ClientPaymentWhereInput): Promise<ClientPaymentRow[]> {
  const rows = await prisma.clientPayment.findMany({ where: { tenantId: tenantIdForWrite(), ...where }, include: paymentInclude, orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], take: 500 });
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const statementIds = [...new Set(rows.flatMap((r) => r.applications.map((a) => a.statementId)))];
  const accountIds = [...new Set(rows.map((r) => r.depositAccountId))];
  const [clients, statements, accounts] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    prisma.clientStatement.findMany({ where: { id: { in: statementIds } }, select: { id: true, number: true } }),
    prisma.ledgerAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true, name: true } }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const number = new Map(statements.map((s) => [s.id, s.number]));
  const account = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((p) => {
    const applied = p.applications.reduce((s, a) => s + cents(a.amount), 0);
    return {
      id: p.id,
      clientId: p.clientId,
      clientName: clientName.get(p.clientId) ?? 'A client',
      receivedOn: ymd(p.receivedOn),
      amount: Number(p.amount),
      method: p.method as ClientPaymentRow['method'],
      reference: p.reference,
      depositAccount: account.get(p.depositAccountId) ?? null,
      applied: dollars(applied),
      unapplied: dollars(cents(p.amount) - applied),
      applications: p.applications.map((a) => ({ statementId: a.statementId, number: number.get(a.statementId) ?? null, amount: Number(a.amount) })),
      journalEntryId: p.journalEntryId,
      undone: !!p.voidedAt,
      createdAt: p.createdAt.toISOString(),
    };
  });
}

booksReceivablesRouter.get('/payments', async (req, res, next) => {
  try {
    const q = z.object({ clientId: z.string().uuid().optional(), includeUndone: z.enum(['true', 'false']).optional() }).parse(req.query);
    res.json({ payments: await paymentRows({ ...(q.clientId ? { clientId: q.clientId } : {}), ...(q.includeUndone === 'true' ? {} : { voidedAt: null }) }) });
  } catch (err) {
    next(err);
  }
});

booksReceivablesRouter.post('/payments', MANAGE, async (req, res, next) => {
  try {
    const input = ClientPaymentInputSchema.parse(req.body);
    // Recorded from a bank deposit: it lands in that bank's account, and the deposit is matched to it after.
    const bankTxnId = input.bankTransactionId ?? null;
    if (bankTxnId) {
      // From a bank deposit: claimed, recorded on its date into its bank, and matched — one transaction (lib/books/bank).
      const { paymentId, transaction } = await paymentFromDeposit(prisma, bankTxnId, { ...input, reference: input.reference ?? null, depositAccountId: input.depositAccountId ?? null, userId: req.user!.id });
      enqueueAudit(
        { actorUserId: req.user!.id, clientId: input.clientId, action: 'books.client_payment_recorded', entityType: 'ClientPayment', entityId: paymentId, metadata: { amount: input.amount, method: input.method, statements: input.applications.length, bankTransactionId: bankTxnId } },
        'books.receivables',
      );
      enqueueAudit({ actorUserId: req.user!.id, action: 'books.bank.matched', entityType: 'BankTransaction', entityId: bankTxnId, metadata: { lineId: transaction.matched?.lineId ?? null, clientPaymentId: paymentId } }, 'books.bank');
      const [row] = await paymentRows({ id: paymentId });
      res.status(201).json({ payment: row, bankTransaction: transaction, depositMatched: transaction.status === 'MATCHED' && !!transaction.matched });
      return;
    }
    const payment = await recordClientPayment(prisma, { ...input, reference: input.reference ?? null, depositAccountId: input.depositAccountId ?? null, userId: req.user!.id });
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: input.clientId, action: 'books.client_payment_recorded', entityType: 'ClientPayment', entityId: payment.id, metadata: { amount: input.amount, method: input.method, statements: input.applications.length } },
      'books.receivables',
    );
    const [row] = await paymentRows({ id: payment.id });
    res.status(201).json({ payment: row });
  } catch (err) {
    next(err);
  }
});

booksReceivablesRouter.delete('/payments/:id', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body ?? {});
    await undoClientPayment(prisma, id, { reason, userId: req.user!.id });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.client_payment_undone', entityType: 'ClientPayment', entityId: id, metadata: { reason } }, 'books.receivables');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * Finance walk 7 — the collections worklist: every open statement with where
 * the reminder cadence stands (stage, last sent, next scheduled), the
 * latest promise or note, whether the client is paused, and the day the
 * next action falls due — the sort the page opens on.
 */
booksReceivablesRouter.get('/worklist', async (_req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const today = orgDateKey(new Date());
    const r = await agingReport(prisma, today);
    const ids = r.statements.map((s) => s.statementId);
    const clientIds = [...new Set(r.statements.map((s) => s.clientId))];
    const [rows, clients, notes] = await Promise.all([
      ids.length ? prisma.clientStatement.findMany({ where: { id: { in: ids } }, select: { id: true, dueAt: true, reminderStage: true, lastReminderAt: true } }) : [],
      clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, dunningPausedAt: true, dunningPauseNote: true, contactEmail: true } }) : [],
      clientIds.length ? prisma.clientCollectionNote.findMany({ where: { tenantId, clientId: { in: clientIds } }, orderBy: { createdAt: 'desc' }, take: 2000 }) : [],
    ]);
    const stmt = new Map(rows.map((x) => [x.id, x]));
    const client = new Map(clients.map((c) => [c.id, c]));
    // The latest note per statement, else per client.
    const latestFor = (clientId: string, statementId: string) => notes.find((n) => n.statementId === statementId) ?? notes.find((n) => n.clientId === clientId && !n.statementId) ?? null;
    const items = r.statements.map((s) => {
      const x = stmt.get(s.statementId);
      const c = client.get(s.clientId);
      const paused = !!c?.dunningPausedAt;
      const next = paused ? null : nextReminderOn(x?.dueAt ?? null, x?.reminderStage ?? 0);
      const note = latestFor(s.clientId, s.statementId);
      const promise = note?.kind === 'PROMISE' && note.promisedOn ? ymd(note.promisedOn) : null;
      // What to do next, and when: keep a promise's date, else the cadence's next send, else today (it is late).
      const nextActionOn = promise && promise >= today ? promise : next && next >= today ? next : s.daysPastDue > 0 ? today : (next ?? promise ?? today);
      return {
        ...statementDto(s),
        reminderStage: x?.reminderStage ?? 0,
        lastReminderAt: x?.lastReminderAt?.toISOString() ?? null,
        nextReminderOn: next,
        paused,
        pauseNote: c?.dunningPauseNote ?? null,
        contactEmail: c?.contactEmail ?? null,
        lastNote: note
          ? { id: note.id, kind: note.kind as 'PROMISE' | 'CALL' | 'NOTE', note: note.note, promisedOn: note.promisedOn ? ymd(note.promisedOn) : null, promisedAmount: note.promisedAmount === null ? null : Number(note.promisedAmount), createdAt: note.createdAt.toISOString() }
          : null,
        nextActionOn,
      };
    });
    items.sort((a, b) => a.nextActionOn.localeCompare(b.nextActionOn) || b.daysPastDue - a.daysPastDue);
    res.json({ asOf: today, items, totals: { open: dollars(r.totals.open), statements: items.length } });
  } catch (err) {
    next(err);
  }
});

/**
 * Days to collect, month by month (finance walk 7's DSO trend): for the
 * statements paid in each month, the average days from finalized to paid,
 * with how many and how much were collected.
 */
booksReceivablesRouter.get('/dso', async (req, res, next) => {
  try {
    const q = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (q.months - 1), 1));
    const paid = await prisma.clientStatement.findMany({
      where: { tenantId: tenantIdForWrite(), status: 'FINAL', paidAt: { gte: first }, finalizedAt: { not: null } },
      select: { paidAt: true, finalizedAt: true, snapshot: true },
      take: 10_000,
    });
    const months: Array<{ key: string; label: string; days: number | null; statements: number; collected: number }> = [];
    for (let i = 0; i < q.months; i++) {
      const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
      const key = d.toISOString().slice(0, 7);
      const mine = paid.filter((s) => s.paidAt!.toISOString().slice(0, 7) === key);
      const lags = mine.map((s) => (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / 86_400_000);
      months.push({
        key,
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        days: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null,
        statements: mine.length,
        collected: Math.round(mine.reduce((a, s) => a + Number((s.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount ?? 0), 0) * 100) / 100,
      });
    }
    // The two numbers Receivables leads with: days to collect over the
    // last 90 days (statements paid in that window, finalized → paid), and
    // the cash clients paid this calendar month (payments not undone).
    const since90 = new Date(now.getTime() - 90 * 86_400_000);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [paid90, received] = await Promise.all([
      prisma.clientStatement.findMany({
        where: { tenantId: tenantIdForWrite(), status: 'FINAL', paidAt: { gte: since90, lte: now }, finalizedAt: { not: null } },
        select: { paidAt: true, finalizedAt: true },
        take: 10_000,
      }),
      prisma.clientPayment.aggregate({
        where: { tenantId: tenantIdForWrite(), voidedAt: null, receivedOn: { gte: monthStart, lte: now } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    const lags90 = paid90.map((s) => (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / 86_400_000);
    res.json({
      months,
      last90: { days: lags90.length ? Math.round(lags90.reduce((a, b) => a + b, 0) / lags90.length) : null, statements: lags90.length },
      collectedThisMonth: { amount: Math.round(Number(received._sum.amount ?? 0) * 100) / 100, payments: received._count._all },
    });
  } catch (err) {
    next(err);
  }
});

/** Where a payment can be deposited: the bank accounts and Undeposited funds. */
booksReceivablesRouter.get('/deposit-accounts', async (_req, res, next) => {
  try {
    await accountByKey(prisma, 'UNDEPOSITED'); // the chart, seeded on first use
    const rows = await prisma.ledgerAccount.findMany({
      where: { tenantId: tenantIdForWrite(), isActive: true, type: 'ASSET', OR: [{ subtype: 'BANK' }, { systemKey: 'UNDEPOSITED' }] },
      select: { id: true, code: true, name: true, systemKey: true },
      orderBy: { code: 'asc' },
    });
    res.json({ accounts: rows.map((a) => ({ id: a.id, code: a.code, name: a.name, isDefault: a.systemKey === 'CASH_OPERATING', forChecks: a.systemKey === 'UNDEPOSITED' })) });
  } catch (err) {
    next(err);
  }
});

booksReceivablesRouter.get('/clients/:clientId', async (req, res, next) => {
  try {
    const clientId = z.string().uuid().parse(req.params.clientId);
    const client = await prisma.client.findFirst({ where: { id: clientId, tenantId: tenantIdForWrite() }, select: { id: true, name: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found.');
    const [aging, payments, unapplied] = await Promise.all([agingReport(prisma, orgDateKey(new Date()), { clientId }), paymentRows({ clientId, voidedAt: null }), unappliedCredits(prisma, [clientId])]);
    const credit = unapplied.get(clientId) ?? 0;
    res.json({
      client,
      balance: dollars(aging.totals.open - credit),
      unapplied: dollars(credit),
      openStatements: aging.statements.map(statementDto),
      payments,
    });
  } catch (err) {
    next(err);
  }
});

booksReceivablesRouter.post('/backfill', MANAGE, async (req, res, next) => {
  try {
    const q = z.object({ since: Ymd.optional() }).parse(req.body ?? {});
    const result = await backfillPosting(prisma, q.since ? { since: new Date(`${q.since}T00:00:00.000Z`) } : {});
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.posting_backfilled', entityType: 'Tenant', entityId: tenantIdForWrite(), metadata: { ...result, failed: result.failed.length } }, 'books.receivables');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

booksReceivablesRouter.get('/gaps', async (req, res, next) => {
  try {
    const q = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    res.json({ gaps: await postingGaps(prisma, q.period) });
  } catch (err) {
    next(err);
  }
});
