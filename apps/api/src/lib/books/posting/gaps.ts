import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import { ymd, type Db } from './common.js';
import { disburseKey, postPayrollRun, runKey } from './payroll.js';
import { advanceKey, garnishmentKey, postGarnishmentRemittance, postTaxDeposit, postTaxPayment, postWageAdvance, taxDepositKey, taxPaymentKey } from './remittances.js';
import { postStatement, statementAmounts, statementKey } from './statements.js';
import { paidWithoutPayment, paymentKey, settleMarkedPaidStatements } from './receivables.js';
import { fmtDay, fmtDayRange } from '../../humanDates.js';

/**
 * What should be in the books and isn't — and the catch-up that puts it
 * there. The operational code posts as things happen (lib/books/posting/
 * hooks), but a posting can fail (a closed account, an outage) or predate
 * the books; postingGaps lists those for a month (the close checklist reads
 * it) and backfillPosting walks history and posts whatever is missing.
 * Both are idempotent and read-only until asked to post.
 */

export interface PostingGap {
  kind: 'PAYROLL_RUN' | 'PAYROLL_DISBURSEMENT' | 'STATEMENT' | 'TAX_PAYMENT' | 'TAX_DEPOSIT' | 'GARNISHMENT_REMITTANCE' | 'WAGE_ADVANCE' | 'CLIENT_PAYMENT';
  sourceType: string;
  sourceId: string;
  label: string;
  link: string | null;
}

function monthRange(periodKey: string): { gte: Date; lt: Date } {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
}

async function postedKeys(db: Db, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.journalEntry.findMany({ where: { tenantId: tenantIdForWrite(), sourceKey: { in: keys }, status: 'POSTED' }, select: { sourceKey: true } });
  return new Set(rows.map((r) => r.sourceKey!));
}

const money = (n: number | Prisma.Decimal) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Everything in `periodKey` (YYYY-MM) that should have posted and hasn't. */
export async function postingGaps(db: Db, periodKey: string): Promise<PostingGap[]> {
  const tenantId = tenantIdForWrite();
  const range = monthRange(periodKey);
  const gaps: PostingGap[] = [];

  const runs = await db.payrollRun.findMany({
    where: { tenantId, status: { in: ['FINALIZED', 'DISBURSED'] }, OR: [{ periodEnd: range }, { disbursedAt: range }] },
    select: { id: true, periodStart: true, periodEnd: true, status: true, disbursedAt: true, _count: { select: { items: { where: { status: { not: 'VOIDED' } } } } } },
  });
  const runPosted = await postedKeys(db, runs.flatMap((r) => [runKey(r.id), disburseKey(r.id)]));
  for (const r of runs) {
    const label = `Payroll ${fmtDayRange(ymd(r.periodStart), ymd(r.periodEnd), { year: true })}`;
    if (r._count.items > 0 && r.periodEnd >= range.gte && r.periodEnd < range.lt && !runPosted.has(runKey(r.id))) {
      gaps.push({ kind: 'PAYROLL_RUN', sourceType: 'PayrollRun', sourceId: r.id, label: `${label} isn’t in the books`, link: `/payroll/runs/${r.id}` });
    }
    if (r.status === 'DISBURSED' && r.disbursedAt && r.disbursedAt >= range.gte && r.disbursedAt < range.lt && !runPosted.has(disburseKey(r.id))) {
      gaps.push({ kind: 'PAYROLL_DISBURSEMENT', sourceType: 'PayrollRun', sourceId: r.id, label: `${label} was paid but the payment isn’t in the books`, link: `/payroll/runs/${r.id}` });
    }
  }

  const statements = await db.clientStatement.findMany({ where: { tenantId, status: 'FINAL', finalizedAt: range }, select: { id: true, number: true, snapshot: true, client: { select: { id: true, name: true } } } });
  const stPosted = await postedKeys(db, statements.map((s) => statementKey(s.id)));
  for (const s of statements) {
    if (statementAmounts(s.snapshot).total === 0 || stPosted.has(statementKey(s.id))) continue;
    gaps.push({ kind: 'STATEMENT', sourceType: 'ClientStatement', sourceId: s.id, label: `${s.client.name} statement ${s.number != null ? `No. ${String(s.number).padStart(4, '0')} ` : ''}isn’t in receivables`, link: `/clients/${s.client.id}?tab=statements` });
  }

  const taxPayments = await db.taxPayment.findMany({ where: { tenantId, status: 'PAID', paidAt: range }, select: { id: true, jurisdiction: true, periodLabel: true, amount: true } });
  const tpPosted = await postedKeys(db, taxPayments.map((t) => taxPaymentKey(t.id)));
  for (const t of taxPayments) {
    if (!tpPosted.has(taxPaymentKey(t.id))) gaps.push({ kind: 'TAX_PAYMENT', sourceType: 'TaxPayment', sourceId: t.id, label: `Tax payment ${t.jurisdiction} ${t.periodLabel} (${money(t.amount)}) isn’t in the books`, link: '/payroll/taxes?tab=deposits' });
  }

  const deposits = await db.taxDeposit.findMany({ where: { tenantId, status: 'PAID', paidAt: range }, select: { id: true, kind: true, periodLabel: true, amount: true, payrollRunId: true } });
  const depPosted = await postedKeys(db, deposits.map((d) => taxDepositKey(d.id)));
  for (const d of deposits) {
    if (depPosted.has(taxDepositKey(d.id))) continue;
    // The tax desk's liabilities stand in for a deposit it itemized.
    if (d.payrollRunId && (await db.taxLiability.count({ where: { payrollRunId: d.payrollRunId } })) > 0) continue;
    gaps.push({ kind: 'TAX_DEPOSIT', sourceType: 'TaxDeposit', sourceId: d.id, label: `Tax deposit ${d.periodLabel} (${money(d.amount)}) isn’t in the books`, link: '/payroll/taxes?tab=deposits' });
  }

  const remits = await db.garnishmentRemittance.findMany({ where: { tenantId, status: 'SENT', sentAt: range }, select: { id: true, amount: true } });
  const remPosted = await postedKeys(db, remits.map((r) => garnishmentKey(r.id)));
  for (const r of remits) {
    if (!remPosted.has(garnishmentKey(r.id))) gaps.push({ kind: 'GARNISHMENT_REMITTANCE', sourceType: 'GarnishmentRemittance', sourceId: r.id, label: `Garnishment remittance (${money(r.amount)}) isn’t in the books`, link: '/payroll/garnishments?tab=remittances' });
  }

  const advances = await db.earnedWageAdvance.findMany({ where: { tenantId, status: { in: ['PAID', 'RECOVERED'] }, paidAt: range }, select: { id: true, amountCents: true } });
  const advPosted = await postedKeys(db, advances.map((a) => advanceKey(a.id)));
  for (const a of advances) {
    if (!advPosted.has(advanceKey(a.id))) gaps.push({ kind: 'WAGE_ADVANCE', sourceType: 'EarnedWageAdvance', sourceId: a.id, label: `Earned-wage advance (${money(a.amountCents / 100)}) isn’t in the books`, link: '/payroll/earned-wage' });
  }

  const payments = await db.clientPayment.findMany({ where: { tenantId, voidedAt: null, receivedOn: range }, select: { id: true, amount: true } });
  const payPosted = await postedKeys(db, payments.map((p) => paymentKey(p.id)));
  for (const p of payments) {
    if (!payPosted.has(paymentKey(p.id))) gaps.push({ kind: 'CLIENT_PAYMENT', sourceType: 'ClientPayment', sourceId: p.id, label: `Client payment (${money(p.amount)}) isn’t in the books`, link: '/books/receivables' });
  }
  // A statement marked paid in the month with no payment behind it: the books still count it as owed (MONEY-3).
  for (const b of await paidWithoutPayment(db, { paidAt: range })) {
    gaps.push({ kind: 'CLIENT_PAYMENT', sourceType: 'ClientStatement', sourceId: b.statementId, label: `Statement ${b.number != null ? `No. ${String(b.number).padStart(4, '0')} ` : ''}was marked paid ${fmtDay(b.paidAt!.slice(0, 10), { year: true })} (${money(b.total / 100)}) with no payment in the books`, link: '/books/receivables?view=payments' });
  }
  return gaps;
}

export interface BackfillResult {
  payrollRuns: number;
  statements: number;
  taxPayments: number;
  taxDeposits: number;
  garnishmentRemittances: number;
  wageAdvances: number;
  /** Payments recorded for statements marked paid without one. */
  clientPayments: number;
  failed: Array<{ sourceType: string; sourceId: string; error: string }>;
}

/**
 * Post (or re-sync) everything the books should hold, oldest first.
 * Idempotent: what is already right is left alone; a voided run's entries
 * come off. `since` limits it to sources from that day on.
 */
export async function backfillPosting(db: PrismaClient, opts: { since?: Date; userId?: string | null } = {}): Promise<BackfillResult> {
  const tenantId = tenantIdForWrite();
  const since = opts.since;
  const out: BackfillResult = { payrollRuns: 0, statements: 0, taxPayments: 0, taxDeposits: 0, garnishmentRemittances: 0, wageAdvances: 0, clientPayments: 0, failed: [] };
  // Counted when it changed what's in the books (newly posted, or taken off).
  const attempt = async (sourceType: string, sourceId: string, keys: string[], fn: () => Promise<unknown>, count: () => void) => {
    try {
      const before = (await postedKeys(db, keys)).size;
      await fn();
      const after = (await postedKeys(db, keys)).size;
      if (after !== before) count();
    } catch (err) {
      out.failed.push({ sourceType, sourceId, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Voided runs too: one that posted before it was voided must come off.
  const voidedWithEntries = (await db.journalEntry.findMany({ where: { tenantId, source: { in: ['PAYROLL', 'PAYROLL_DISBURSEMENT'] }, sourceType: 'PayrollRun', status: 'POSTED' }, select: { sourceId: true } })).map((e) => e.sourceId!).filter(Boolean);
  const runs = await db.payrollRun.findMany({
    where: { tenantId, OR: [{ status: { in: ['FINALIZED', 'DISBURSED'] }, ...(since ? { periodEnd: { gte: since } } : {}) }, { status: 'CANCELLED', id: { in: voidedWithEntries } }] },
    select: { id: true },
    orderBy: { periodEnd: 'asc' },
  });
  for (const r of runs) await attempt('PayrollRun', r.id, [runKey(r.id), disburseKey(r.id)], () => postPayrollRun(db, r.id), () => (out.payrollRuns += 1));

  const statements = await db.clientStatement.findMany({ where: { tenantId, status: 'FINAL', ...(since ? { finalizedAt: { gte: since } } : {}) }, select: { id: true }, orderBy: { finalizedAt: 'asc' } });
  for (const s of statements) await attempt('ClientStatement', s.id, [statementKey(s.id)], () => postStatement(db, s.id), () => (out.statements += 1));

  const taxPayments = await db.taxPayment.findMany({ where: { tenantId, status: 'PAID', ...(since ? { paidAt: { gte: since } } : {}) }, select: { id: true }, orderBy: { paidAt: 'asc' } });
  for (const t of taxPayments) await attempt('TaxPayment', t.id, [taxPaymentKey(t.id)], () => postTaxPayment(db, t.id), () => (out.taxPayments += 1));

  const deposits = await db.taxDeposit.findMany({ where: { tenantId, status: 'PAID', ...(since ? { paidAt: { gte: since } } : {}) }, select: { id: true }, orderBy: { paidAt: 'asc' } });
  for (const d of deposits) await attempt('TaxDeposit', d.id, [taxDepositKey(d.id)], () => postTaxDeposit(db, d.id), () => (out.taxDeposits += 1));

  const remits = await db.garnishmentRemittance.findMany({ where: { tenantId, status: 'SENT', ...(since ? { sentAt: { gte: since } } : {}) }, select: { id: true }, orderBy: { sentAt: 'asc' } });
  for (const r of remits) await attempt('GarnishmentRemittance', r.id, [garnishmentKey(r.id)], () => postGarnishmentRemittance(db, r.id), () => (out.garnishmentRemittances += 1));

  const advances = await db.earnedWageAdvance.findMany({ where: { tenantId, status: { in: ['PAID', 'RECOVERED'] }, paidAt: { not: null, ...(since ? { gte: since } : {}) } }, select: { id: true }, orderBy: { paidAt: 'asc' } });
  for (const a of advances) await attempt('EarnedWageAdvance', a.id, [advanceKey(a.id)], () => postWageAdvance(db, a.id), () => (out.wageAdvances += 1));

  // Statements marked paid with no payment: record the payment each was marked paid with (MONEY-3),
  // after the statements above are in receivables.
  const settled = await settleMarkedPaidStatements(db, { userId: opts.userId ?? null, since });
  out.clientPayments = settled.payments;
  for (const f of settled.failed) out.failed.push({ sourceType: 'ClientStatement', sourceId: f.statementId, error: f.error });
  return out;
}
