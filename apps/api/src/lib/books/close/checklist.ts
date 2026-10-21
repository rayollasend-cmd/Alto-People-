import type { Prisma, PrismaClient } from '@prisma/client';
import type { CloseCheckItem } from '@alto-people/shared';
import { tenantIdForWrite } from '../../tenant.js';
import { depreciationSchedule, monthEnd } from '../assets/depreciation.js';
import { postingGaps } from '../posting/gaps.js';

/**
 * A month's close checklist. Every month gets the same steps (CloseTask
 * rows, made the first time the month is opened). Most of them check
 * themselves against the books, live, each time the page is read:
 *
 *   bank_reconciled      every bank/card account reconciled through month end
 *   bank_reviewed        no bank or card line from the month left to review
 *   nothing_to_post      nothing the platform produced is missing from the ledger
 *   bills_approved       no bill dated in the month stuck in approval
 *   statements_final     every client statement for the month finalized
 *   depreciation_posted  every asset's depreciation for the month posted
 *   quickbooks_in_sync   no sync conflict open, nothing waiting to go over
 *
 * and three are a person's judgment, ticked by hand with a note:
 *
 *   accruals_reviewed, payroll_liabilities, budget_review.
 *
 * An auto step can still be skipped by hand with a note (an account the
 * bank closed mid-month) — the skip is on the record.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface TaskTemplate {
  key: string;
  title: string;
  detail: string;
  auto: boolean;
  link: (periodKey: string) => string | null;
}

export const CLOSE_TASKS: readonly TaskTemplate[] = [
  { key: 'bank_reviewed', title: 'Review every bank and card line', detail: 'Each line from the month is matched to the books, categorized, or excluded.', auto: true, link: () => '/books/bank' },
  { key: 'bank_reconciled', title: 'Reconcile bank and card accounts', detail: 'Each account reconciled to its statement through the last day of the month.', auto: true, link: () => '/books/bank' },
  { key: 'nothing_to_post', title: 'Everything the platform produced is in the ledger', detail: 'Payroll, statements, client payments, tax deposits, reimbursements and garnishment payments for the month all posted.', auto: true, link: () => '/books/journal' },
  { key: 'bills_approved', title: 'Approve or void the month’s bills', detail: 'No bill dated in the month left waiting for approval.', auto: true, link: () => '/books/bills?tab=approve' },
  { key: 'statements_final', title: 'Finalize the month’s statements', detail: 'Every statement ending in the month is final, so revenue is booked.', auto: true, link: () => '/clients/statements' },
  { key: 'depreciation_posted', title: 'Post depreciation', detail: 'Every fixed asset’s depreciation for the month is on the books.', auto: true, link: () => '/books/assets' },
  { key: 'accruals_reviewed', title: 'Record accruals', detail: 'Expenses incurred but not yet billed (and wages earned but not yet paid) entered as accruals that reverse next month.', auto: false, link: (p) => `/books/close/${p}#accruals` },
  { key: 'payroll_liabilities', title: 'Tie payroll liabilities to deposits', detail: 'Withholding and payroll liability balances at month end match the deposits and filings due.', auto: false, link: () => '/payroll/taxes?tab=deposits' },
  { key: 'quickbooks_in_sync', title: 'QuickBooks in step', detail: 'No sync conflict waiting for a decision and nothing waiting to go to QuickBooks.', auto: true, link: () => '/books/quickbooks' },
  { key: 'budget_review', title: 'Review the month against budget', detail: 'Profit and loss read against the budget; big variances explained.', auto: false, link: () => '/books/budgets' },
];

export const TASK_BY_KEY = new Map(CLOSE_TASKS.map((t) => [t.key, t]));

/** The month's FiscalPeriod, and its checklist rows, made on first sight. */
export async function ensurePeriod(db: Db, periodKey: string) {
  const tenantId = tenantIdForWrite();
  // Two people opening a new month at once both try to create it: the
  // second create loses on the unique key and reads the first one's row.
  const where = { tenantId_periodKey: { tenantId, periodKey } };
  const period =
    (await db.fiscalPeriod.findUnique({ where })) ??
    (await db.fiscalPeriod.create({ data: { tenantId, periodKey } }).catch(async (err: unknown) => {
      if ((err as { code?: string }).code === 'P2002') return db.fiscalPeriod.findUniqueOrThrow({ where });
      throw err;
    }));
  await db.closeTask.createMany({
    data: CLOSE_TASKS.map((t, i) => ({ tenantId, periodId: period.id, key: t.key, title: t.title, detail: t.detail, sortOrder: i })),
    skipDuplicates: true,
  });
  return period;
}

export interface CheckResult {
  passing: boolean;
  summary: string;
  items: CloseCheckItem[];
}

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Run every auto check for the month. */
export async function runChecks(db: Db, periodKey: string): Promise<Map<string, CheckResult>> {
  const tenantId = tenantIdForWrite();
  const start = dateOnly(`${periodKey}-01`);
  const end = dateOnly(monthEnd(periodKey));
  const out = new Map<string, CheckResult>();

  // Bank and card: every active feed account reconciled through month end; nothing left to review.
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } });
  const recs = feeds.length
    ? await db.bankReconciliation.groupBy({ by: ['feedAccountId'], where: { tenantId, status: 'COMPLETED', statementEndDate: { gte: end } }, _count: { _all: true } })
    : [];
  const reconciled = new Set(recs.map((r) => r.feedAccountId));
  const notReconciled = feeds.filter((f) => !reconciled.has(f.id));
  out.set('bank_reconciled', {
    passing: notReconciled.length === 0,
    summary: feeds.length === 0 ? 'No bank or card accounts are connected to the books.' : notReconciled.length === 0 ? `All ${plural(feeds.length, 'account')} reconciled through ${end.toISOString().slice(0, 10)}.` : `${plural(notReconciled.length, 'account')} not reconciled through month end.`,
    items: notReconciled.map((f) => ({ label: `Reconcile ${f.name}`, link: `/books/bank/${f.id}/reconcile` })),
  });
  const toReview = feeds.length
    ? await db.bankTransaction.groupBy({ by: ['feedAccountId'], where: { tenantId, status: 'UNMATCHED', postedOn: { gte: start, lte: end } }, _count: { _all: true } })
    : [];
  const reviewCount = toReview.reduce((n, r) => n + r._count._all, 0);
  const feedName = new Map(feeds.map((f) => [f.id, f.name]));
  out.set('bank_reviewed', {
    passing: reviewCount === 0,
    summary: reviewCount === 0 ? 'Every line from the month is matched, categorized or excluded.' : `${plural(reviewCount, 'line')} from the month to review.`,
    items: toReview.map((r) => ({ label: `${feedName.get(r.feedAccountId) ?? 'An account'}: ${plural(r._count._all, 'line')} to review`, link: `/books/bank/${r.feedAccountId}` })),
  });

  // The platform's own activity, posted.
  const gaps = await postingGaps(db as PrismaClient, periodKey);
  out.set('nothing_to_post', {
    passing: gaps.length === 0,
    summary: gaps.length === 0 ? 'Everything the platform produced for the month is in the ledger.' : `${plural(gaps.length, 'item')} not posted to the ledger yet.`,
    items: gaps.slice(0, 25).map((g) => ({ label: g.label, link: g.link ?? null })),
  });

  // Bills stuck in approval.
  const stuck = await db.bill.findMany({ where: { tenantId, status: 'PENDING_APPROVAL', billDate: { gte: start, lte: end } }, select: { id: true, billNumber: true, total: true, vendor: { select: { name: true } } }, take: 25 });
  out.set('bills_approved', {
    passing: stuck.length === 0,
    summary: stuck.length === 0 ? 'No bill from the month is waiting for approval.' : `${plural(stuck.length, 'bill')} from the month waiting for approval.`,
    items: stuck.map((b) => ({ label: `${b.vendor.name}${b.billNumber ? ` #${b.billNumber}` : ''} — $${Number(b.total).toFixed(2)}`, link: `/books/bills/${b.id}` })),
  });

  // Client statements ending in the month, still DRAFT.
  const drafts = await db.clientStatement.findMany({ where: { tenantId, status: 'DRAFT', periodEnd: { gte: start, lte: end } }, select: { id: true, clientId: true, client: { select: { name: true } } }, take: 25 });
  out.set('statements_final', {
    passing: drafts.length === 0,
    summary: drafts.length === 0 ? 'Every statement for the month is final.' : `${plural(drafts.length, 'statement')} for the month still in draft.`,
    items: drafts.map((d) => ({ label: `${d.client.name} — draft statement`, link: `/clients/${d.clientId}?tab=statements` })),
  });

  // Depreciation due in the month and not posted.
  const assets = await db.fixedAsset.findMany({ where: { tenantId, status: { in: ['ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'] }, inServiceOn: { lte: end } }, include: { depreciation: { where: { periodKey } } } });
  const unposted = assets.filter((a) => a.depreciation.length === 0 && depreciationSchedule(a).some((m) => m.periodKey === periodKey && m.amount > 0));
  out.set('depreciation_posted', {
    passing: unposted.length === 0,
    summary: assets.length === 0 ? 'No fixed assets on the register.' : unposted.length === 0 ? 'Depreciation for the month is posted.' : `${plural(unposted.length, 'asset')} without the month’s depreciation.`,
    items: unposted.slice(0, 25).map((a) => ({ label: `${a.name} — depreciation for ${periodKey}`, link: `/books/assets/${a.id}` })),
  });

  // QuickBooks: no open conflicts, nothing pending or failed in the outbox.
  const connected = await db.qboCompanyConnection.findFirst({ where: { tenantId }, select: { status: true } });
  const [conflicts, waiting] = await Promise.all([
    db.qboSyncConflict.count({ where: { tenantId, status: 'OPEN' } }),
    db.qboOutbox.count({ where: { tenantId, status: { in: ['PENDING', 'FAILED'] } } }),
  ]);
  const qboItems: CloseCheckItem[] = [];
  if (conflicts) qboItems.push({ label: `${plural(conflicts, 'conflict')} waiting for a decision`, link: '/books/quickbooks?tab=conflicts' });
  if (waiting) qboItems.push({ label: `${plural(waiting, 'change')} waiting to go to QuickBooks`, link: '/books/quickbooks' });
  out.set('quickbooks_in_sync', {
    passing: conflicts === 0 && waiting === 0,
    summary: !connected ? 'QuickBooks isn’t connected — nothing to keep in step.' : conflicts === 0 && waiting === 0 ? 'QuickBooks and the books agree.' : qboItems.map((i) => i.label).join('; ') + '.',
    items: qboItems,
  });
  return out;
}
