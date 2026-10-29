import type { Prisma, PrismaClient } from '@prisma/client';
import type { CloseCheckItem } from '@alto-people/shared';
import { tenantIdForWrite } from '../../tenant.js';
import type { CloseTaskAction } from '@alto-people/shared';
import { depreciationSchedule, monthEnd } from '../assets/depreciation.js';
import { postingGaps } from '../posting/gaps.js';
import { fromCents, toCents } from '../ledger.js';
import { fmtDay } from '../../humanDates.js';

/**
 * A month's close checklist. Every month gets the same steps (CloseTask
 * rows, made the first time the month is opened). Most of them check
 * themselves against the books, live, each time the page is read:
 *
 *   bank_reconciled      every bank/card account reconciled through month end
 *                        (a ledger bank account with activity and no feed fails)
 *   bank_reviewed        no bank or card line from the month left to review
 *   nothing_to_post      nothing the platform produced is missing from the ledger
 *   bills_approved       no bill dated in the month stuck in approval
 *   statements_final     every client statement for the month finalized
 *   depreciation_posted  every asset's depreciation for the month posted
 *   payroll_liabilities  each tax payable on the books at month end equals
 *                        what the tax desk still owed that agency kind
 *                        (finance walk 16; like with like since MONEY-4)
 *   quickbooks_in_sync   no sync conflict open, nothing waiting to go over
 *
 * and two are a person's judgment, ticked by hand with a note:
 *
 *   accruals_reviewed, budget_review.
 *
 * Two steps carry their own button (finance walk 16): "Finalize N
 * statements" and "Post history" run from the checklist itself.
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
  { key: 'payroll_liabilities', title: 'Tie payroll liabilities to deposits', detail: 'Each payroll tax payable on the books at month end equals what the tax desk still owes that agency — federal, unemployment, state and local, each against its own.', auto: true, link: () => '/payroll/taxes?tab=deposits' },
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
  /** The step's own button (finalize the drafts, post history), when it can be done from the checklist. */
  action?: CloseTaskAction | null;
}

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Ledger bank and card accounts with posted activity in the month that no active bank feed covers. */
async function activeLedgerBanksWithoutFeed(db: Db, tenantId: string, start: Date, end: Date, fed: Set<string>): Promise<Array<{ id: string; name: string; entries: number }>> {
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId, subtype: { in: ['BANK', 'CREDIT_CARD'] } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
  const candidates = accounts.filter((a) => !fed.has(a.id));
  if (candidates.length === 0) return [];
  const activity = await db.journalLine.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: candidates.map((a) => a.id) }, entry: { status: 'POSTED', entryDate: { gte: start, lte: end } } }, _count: { _all: true } });
  const count = new Map(activity.map((r) => [r.accountId, r._count._all]));
  return candidates.filter((a) => (count.get(a.id) ?? 0) > 0).map((a) => ({ id: a.id, name: `${a.code} ${a.name}`, entries: count.get(a.id)! }));
}

/** The tax desk's agency kinds and the payable accounts the payroll entry credits for each. */
const TAX_TIES = [
  { kind: 'FEDERAL_WITHHOLDING', label: 'Federal withholding and FICA', keys: ['FIT_PAYABLE', 'FICA_PAYABLE'] },
  { kind: 'FEDERAL_UNEMPLOYMENT', label: 'Federal unemployment', keys: ['FUTA_PAYABLE'] },
  { kind: 'STATE_WITHHOLDING', label: 'State withholding', keys: ['SIT_PAYABLE'] },
  { kind: 'STATE_UNEMPLOYMENT', label: 'State unemployment and programs', keys: ['SUTA_PAYABLE'] },
  { kind: 'LOCAL', label: 'Local taxes', keys: ['LOCAL_TAX_PAYABLE'] },
] as const;

/**
 * Per agency kind: the payable balance in the ledger at month end, and what
 * the tax desk still owed at month end — its liabilities accrued by then and
 * not paid by then (a payment dated after month end still owed at month
 * end, as the ledger sees it), plus older per-run deposits for runs the desk
 * never itemized (lib/books/posting/remittances posts those instead). Cents.
 */
export async function payrollTaxTies(db: Db, tenantId: string, end: Date): Promise<Array<{ kind: string; label: string; ledger: number; desk: number }>> {
  const endEx = new Date(end.getTime() + 86_400_000);
  const accounts = await db.ledgerAccount.findMany({ where: { tenantId, systemKey: { in: TAX_TIES.flatMap((t) => [...t.keys]) } }, select: { id: true, systemKey: true } });
  const sums = accounts.length
    ? await db.journalLine.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: accounts.map((a) => a.id) }, entry: { status: 'POSTED', entryDate: { lte: end } } }, _sum: { debit: true, credit: true } })
    : [];
  const keyOf = new Map(accounts.map((a) => [a.id, a.systemKey]));
  const ledgerBy = new Map<string, number>();
  for (const r of sums) {
    const k = keyOf.get(r.accountId);
    if (k) ledgerBy.set(k, (ledgerBy.get(k) ?? 0) + toCents(r._sum.credit) - toCents(r._sum.debit));
  }
  const liabilities = await db.taxLiability.findMany({
    where: { tenantId, status: { not: 'VOID' }, liabilityDate: { lte: end } },
    select: { kind: true, amount: true, status: true, payrollRunId: true, periodLabel: true, payment: { select: { paidAt: true, dueDate: true } } },
  });
  const deskBy = new Map<string, number>();
  const add = (kind: string, c: number) => deskBy.set(kind, (deskBy.get(kind) ?? 0) + c);
  for (const l of liabilities) {
    const paidOn = l.status === 'PAID' ? (l.payment?.paidAt ?? l.payment?.dueDate ?? null) : null;
    const owedAtEnd = l.status === 'OPEN' || l.status === 'SCHEDULED' || (l.status === 'PAID' && paidOn !== null && paidOn.getTime() >= endEx.getTime());
    if (owedAtEnd) add(l.kind, toCents(l.amount));
  }
  // Older per-run deposits, where the desk never itemized the run (or, for FUTA, the year).
  const itemizedRuns = new Set(liabilities.map((l) => l.payrollRunId).filter((id): id is string => !!id));
  const futaYears = new Set(liabilities.filter((l) => l.kind === 'FEDERAL_UNEMPLOYMENT').map((l) => l.periodLabel.slice(0, 4)));
  const deposits = await db.taxDeposit.findMany({
    where: { tenantId, liabilityDate: { lte: end }, OR: [{ status: 'PENDING' }, { status: 'PAID', paidAt: { gte: endEx } }] },
    select: { kind: true, amount: true, payrollRunId: true, periodLabel: true },
  });
  for (const d of deposits) {
    if (String(d.kind) === 'FUTA') {
      if (!futaYears.has(d.periodLabel.slice(0, 4))) add('FEDERAL_UNEMPLOYMENT', toCents(d.amount));
    } else if (!d.payrollRunId || !itemizedRuns.has(d.payrollRunId)) add('FEDERAL_WITHHOLDING', toCents(d.amount));
  }
  return TAX_TIES.map((t) => ({ kind: t.kind, label: t.label, ledger: t.keys.reduce((n, k) => n + (ledgerBy.get(k) ?? 0), 0), desk: deskBy.get(t.kind) ?? 0 }));
}

/** Run every auto check for the month. */
export async function runChecks(db: Db, periodKey: string): Promise<Map<string, CheckResult>> {
  const tenantId = tenantIdForWrite();
  const start = dateOnly(`${periodKey}-01`);
  const end = dateOnly(monthEnd(periodKey));
  const out = new Map<string, CheckResult>();

  // Bank and card: every active feed account reconciled through month end; nothing left to review.
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, ledgerAccountId: true } });
  const recs = feeds.length
    ? await db.bankReconciliation.groupBy({ by: ['feedAccountId'], where: { tenantId, status: 'COMPLETED', statementEndDate: { gte: end } }, _count: { _all: true } })
    : [];
  const reconciled = new Set(recs.map((r) => r.feedAccountId));
  const notReconciled = feeds.filter((f) => !reconciled.has(f.id));
  // A bank or card account in the ledger with activity in the month and no
  // feed has nothing to reconcile it against (audit 2026-10-29 MONEY-5): the
  // step used to pass on "no accounts connected" while Payroll checking was
  // overdrawn. It fails until a feed or statement is in, or someone skips it
  // with a note saying it was reconciled by hand.
  const unfed = await activeLedgerBanksWithoutFeed(db, tenantId, start, end, new Set(feeds.map((f) => f.ledgerAccountId)));
  const unfedItem = (a: (typeof unfed)[number]) => ({ label: `${a.name}: ${plural(a.entries, 'entry', 'entries')} this month and no bank feed — connect the account or import its statement, or skip this step with a note if you reconciled it by hand`, link: '/books/bank' });
  const bankSummary = (() => {
    if (feeds.length === 0 && unfed.length === 0) return 'No bank or card account had activity this month.';
    const parts: string[] = [];
    if (notReconciled.length) parts.push(`${plural(notReconciled.length, 'account')} not reconciled through month end`);
    if (unfed.length) parts.push(`${plural(unfed.length, 'account')} with activity and no bank feed to reconcile ${unfed.length === 1 ? 'it' : 'them'}`);
    return parts.length ? `${parts.join('; ')}.` : `All ${plural(feeds.length, 'account')} reconciled through ${fmtDay(end, { year: true })}.`;
  })();
  out.set('bank_reconciled', {
    passing: notReconciled.length === 0 && unfed.length === 0,
    summary: bankSummary,
    items: [...notReconciled.map((f) => ({ label: `Reconcile ${f.name}`, link: `/books/bank/${f.id}/reconcile` })), ...unfed.map(unfedItem)],
  });
  const toReview = feeds.length
    ? await db.bankTransaction.groupBy({ by: ['feedAccountId'], where: { tenantId, status: 'UNMATCHED', postedOn: { gte: start, lte: end } }, _count: { _all: true } })
    : [];
  const reviewCount = toReview.reduce((n, r) => n + r._count._all, 0);
  const feedName = new Map(feeds.map((f) => [f.id, f.name]));
  out.set('bank_reviewed', {
    passing: reviewCount === 0 && unfed.length === 0,
    summary:
      reviewCount === 0 && unfed.length === 0
        ? feeds.length === 0
          ? 'No bank or card account had activity this month.'
          : 'Every line from the month is matched, categorized or excluded.'
        : [reviewCount ? `${plural(reviewCount, 'line')} from the month to review` : '', unfed.length ? `${plural(unfed.length, 'account')} with activity and no bank lines to review it against` : ''].filter(Boolean).join('; ') + '.',
    items: [...toReview.map((r) => ({ label: `${feedName.get(r.feedAccountId) ?? 'An account'}: ${plural(r._count._all, 'line')} to review`, link: `/books/bank/${r.feedAccountId}` })), ...unfed.map(unfedItem)],
  });

  // The platform's own activity, posted.
  const gaps = await postingGaps(db as PrismaClient, periodKey);
  out.set('nothing_to_post', {
    passing: gaps.length === 0,
    summary: gaps.length === 0 ? 'Everything the platform produced for the month is in the ledger.' : `${plural(gaps.length, 'item')} not posted to the ledger yet.`,
    items: gaps.slice(0, 25).map((g) => ({ label: g.label, link: g.link ?? null })),
    action: gaps.length ? { kind: 'post_history', label: 'Post history' } : null,
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
    action: drafts.length ? { kind: 'finalize_statements', label: `Finalize ${plural(drafts.length, 'statement')}` } : null,
  });

  // Payroll liabilities tie to what the tax desk still owes, agency by agency
  // (audit 2026-10-29 MONEY-4): each payable account in the ledger against
  // the desk's own liabilities of that kind still unpaid at month end. It
  // used to sum every tax account (state withholding and unemployment
  // included) against TaxDeposit, which only knows Form 941 and FUTA, so a
  // month with state unemployment owed could never tie.
  const ties = await payrollTaxTies(db, tenantId, end);
  const money = (c: number) => fromCents(c).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const off = ties.filter((t) => Math.abs(t.ledger - t.desk) >= 100);
  const nothing = ties.every((t) => t.ledger === 0 && t.desk === 0);
  const bookTotal = ties.reduce((n, t) => n + t.ledger, 0);
  const deskTotal = ties.reduce((n, t) => n + t.desk, 0);
  out.set('payroll_liabilities', {
    passing: off.length === 0,
    summary: nothing
      ? 'No payroll tax liabilities on the books and nothing owed on the tax desk.'
      : off.length === 0
        ? `Tax liabilities on the books (${money(bookTotal)}) equal what the tax desk still owes (${money(deskTotal)}), agency by agency.`
        : off.map((t) => `${t.label}: ${money(t.ledger)} on the books, ${money(t.desk)} owed on the tax desk`).join('; ') + '.',
    items: off.map((t) =>
      t.ledger > t.desk
        ? { label: `${t.label}: ${money(t.ledger - t.desk)} more on the books than the tax desk owes — a payment the books haven’t posted, or a payroll the desk hasn’t itemized`, link: '/payroll/taxes?tab=deposits' }
        : { label: `${t.label}: ${money(t.desk - t.ledger)} owed on the tax desk and not on the books — post the payroll behind it`, link: '/books/journal' },
    ),
  });

  // Depreciation due in the month and not posted.
  const assets = await db.fixedAsset.findMany({ where: { tenantId, status: { in: ['ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'] }, inServiceOn: { lte: end } }, include: { depreciation: { where: { periodKey } } } });
  const unposted = assets.filter((a) => a.depreciation.length === 0 && depreciationSchedule(a).some((m) => m.periodKey === periodKey && m.amount > 0));
  out.set('depreciation_posted', {
    passing: unposted.length === 0,
    summary: assets.length === 0 ? 'No fixed assets on the register.' : unposted.length === 0 ? 'Depreciation for the month is posted.' : `${plural(unposted.length, 'asset')} without the month’s depreciation.`,
    items: unposted.slice(0, 25).map((a) => ({ label: `${a.name} — depreciation for ${new Date(`${periodKey}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })}`, link: `/books/assets/${a.id}` })),
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
