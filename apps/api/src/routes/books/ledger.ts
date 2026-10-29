import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  BooksDimensionsFilterSchema,
  BooksManualEntryInputSchema,
  BooksOpeningBalancesInputSchema,
  BooksVoidInputSchema,
  BOOKS_COMPARE_KINDS,
  JOURNAL_SOURCE_LABELS,
  LEDGER_SUBTYPES,
  LedgerAccountCreateInputSchema,
  LedgerAccountUpdateInputSchema,
  toCsv,
  type BooksDimensions,
  type BooksJournalEntryDetail,
  type BooksJournalRow,
  type BooksOverview,
  type LedgerAccountRow,
  type LedgerAccountType,
} from '@alto-people/shared';
import { prisma } from '../../db.js';
import { agingReport, paidWithoutPayment } from '../../lib/books/posting/receivables.js';
import { statementAmounts, statementKey } from '../../lib/books/posting/statements.js';
import { closeProgress } from '../../lib/books/close/period.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { loadBrand } from '../../lib/docKit/index.js';
import { accountIndex, fromCents, isPeriodClosed, postEntry, toCents, voidEntry, entryForKey } from '../../lib/books/ledger.js';
import { accountDetail, balanceSheet, cashFlow, compareAsOf, compareRange, monthsBetween, profitAndLoss, trialBalance, type Dimensions } from '../../lib/books/reports.js';
import { emitBooksChange } from '../../lib/books/events.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import {
  balanceSheetPdf,
  balanceSheetXlsx,
  cashFlowPdf,
  cashFlowXlsx,
  profitAndLossPdf,
  profitAndLossXlsx,
  trialBalancePdf,
  trialBalanceXlsx,
  type ExportMeta,
} from './ledgerExports.js';

/**
 * The ledger's screens: the Books overview, the chart of accounts, the
 * journal, manual and opening entries, and the financial statements (with
 * PDF and Excel). Mounted at /books behind view:books; every write needs
 * manage:books. Posting goes through lib/books/ledger, which holds the
 * rules (balanced, closed months, idempotent sources).
 */

export const booksLedgerRouter = Router();
const MANAGE = requireCapability('manage:books');

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: entry and bill dates are @db.Date values stored at UTC midnight; today is orgDateKey.
const ymd = (d: Date) => d.toISOString().slice(0, 10);
// The company's calendar day (statements, the close and the reports count on it, not UTC's).
const today = () => orgDateKey(new Date());
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const DAY = 86_400_000;

/* ---- Shared helpers --------------------------------------------------------- */

function dims(q: unknown): Dimensions {
  const d = BooksDimensionsFilterSchema.parse(q ?? {});
  return { clientId: d.clientId ?? null, siteId: d.siteId ?? null, departmentId: d.departmentId ?? null, costCenterId: d.costCenterId ?? null };
}

async function nameMaps(ids: { clients?: string[]; sites?: string[]; departments?: string[]; costCenters?: string[]; vendors?: string[] }) {
  const tenantId = tenantIdForWrite();
  const uniq = (a?: string[]) => [...new Set((a ?? []).filter(Boolean))];
  const [clients, sites, departments, costCenters, vendors] = await Promise.all([
    uniq(ids.clients).length ? prisma.client.findMany({ where: { tenantId, id: { in: uniq(ids.clients) } }, select: { id: true, name: true } }) : [],
    uniq(ids.sites).length ? prisma.site.findMany({ where: { tenantId, id: { in: uniq(ids.sites) } }, select: { id: true, name: true } }) : [],
    uniq(ids.departments).length ? prisma.department.findMany({ where: { tenantId, id: { in: uniq(ids.departments) } }, select: { id: true, name: true } }) : [],
    uniq(ids.costCenters).length ? prisma.costCenter.findMany({ where: { tenantId, id: { in: uniq(ids.costCenters) } }, select: { id: true, name: true } }) : [],
    uniq(ids.vendors).length ? prisma.vendor.findMany({ where: { tenantId, id: { in: uniq(ids.vendors) } }, select: { id: true, name: true } }) : [],
  ]);
  const m = (rows: Array<{ id: string; name: string }>) => new Map(rows.map((r) => [r.id, r.name]));
  return { clients: m(clients), sites: m(sites), departments: m(departments), costCenters: m(costCenters), vendors: m(vendors) };
}

/** "Company", or the dimension names a report is filtered to. */
async function scopeLabel(d: Dimensions): Promise<string> {
  const n = await nameMaps({ clients: d.clientId ? [d.clientId] : [], sites: d.siteId ? [d.siteId] : [], departments: d.departmentId ? [d.departmentId] : [], costCenters: d.costCenterId ? [d.costCenterId] : [] });
  const parts = [d.clientId && n.clients.get(d.clientId), d.siteId && n.sites.get(d.siteId), d.departmentId && n.departments.get(d.departmentId), d.costCenterId && n.costCenters.get(d.costCenterId)].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Whole company';
}

async function personName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  if (!u) return null;
  return u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email);
}

const debitNormal = (t: string) => t === 'ASSET' || t === 'EXPENSE';

/** Balance (normal-signed, cents) per account through a date. */
async function balancesThrough(asOf: string): Promise<Map<string, number>> {
  const rows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { tenantId: tenantIdForWrite(), entry: { status: 'POSTED', entryDate: { lte: dateOnly(asOf) } } },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.accountId, toCents(r._sum.debit) - toCents(r._sum.credit)]));
}

function fileName(base: string, ext: string): string {
  return `${base.replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').toLowerCase()}.${ext}`;
}

async function exportMeta(d: Dimensions): Promise<ExportMeta> {
  const brand = await loadBrand(prisma as unknown as Parameters<typeof loadBrand>[0], tenantIdForWrite());
  return { company: brand.name, brand, scope: await scopeLabel(d), generatedAt: new Date() };
}

function sendFile(res: Response, buf: Buffer, name: string, kind: 'pdf' | 'xlsx'): void {
  res.setHeader('Content-Type', kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
}

/** Finalized statements with an amount that receivables in the books doesn't hold yet (cents). */
async function unpostedStatements(tenantId: string): Promise<{ count: number; amount: number }> {
  const rows = await prisma.clientStatement.findMany({ where: { tenantId, status: 'FINAL' }, select: { id: true, snapshot: true } });
  if (rows.length === 0) return { count: 0, amount: 0 };
  const posted = new Set(
    (await prisma.journalEntry.findMany({ where: { tenantId, status: 'POSTED', sourceKey: { in: rows.map((r) => statementKey(r.id)) } }, select: { sourceKey: true } })).map((e) => e.sourceKey),
  );
  let count = 0;
  let amount = 0;
  for (const r of rows) {
    const total = statementAmounts(r.snapshot).total;
    if (total === 0 || posted.has(statementKey(r.id))) continue;
    count += 1;
    amount += total;
  }
  return { count, amount };
}

/* ---- Overview --------------------------------------------------------------- */

const zeroTotals = { income: 0, costOfServices: 0, grossProfit: 0, grossMarginPct: null, expenses: 0, operatingIncome: 0, otherIncome: 0, otherExpenses: 0, netIncome: 0 };

booksLedgerRouter.get('/overview', async (_req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const asOf = today();
    const { byId } = await accountIndex(prisma);
    const bal = await balancesThrough(asOf);

    // Cash: every bank and card account.
    const cashAccounts = [...byId.values()]
      .filter((a) => a.isActive && (a.subtype === 'BANK' || a.subtype === 'CREDIT_CARD'))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((a) => {
        const net = bal.get(a.id) ?? 0;
        return { id: a.id, code: a.code, name: a.name, subtype: a.subtype, balance: fromCents(debitNormal(a.type) ? net : -net) };
      });
    const cashTotal = cashAccounts.reduce((s, a) => s + toCents(a.subtype === 'BANK' ? a.balance : -a.balance), 0);

    // Receivables: the AR accounts' balance in the ledger, and what the open statements
    // say — the same report Receivables and the finance home read (lib/books/posting/
    // receivables), aged by the one definition (lib/books/aging).
    const arTotal = [...byId.values()].filter((a) => a.subtype === 'AR').reduce((s, a) => s + (bal.get(a.id) ?? 0), 0);
    const ar = await agingReport(prisma, asOf);
    const aging = ar.totals.buckets;
    const byClient = ar.rows.map((r) => {
      const oldest = ar.statements.filter((st) => st.clientId === r.clientId).map((st) => st.dueOn).sort()[0] ?? null;
      return { clientId: r.clientId, name: r.clientName, open: r.open, oldestDueAt: oldest };
    });
    const now = dateOnly(asOf).getTime();

    // Payables.
    const bills = await prisma.bill.findMany({ where: { tenantId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] } }, select: { balance: true, dueDate: true } });
    const in7 = ymd(new Date(now + 7 * DAY));
    const apTotal = bills.reduce((s, b) => s + toCents(b.balance), 0);
    const apDue7 = bills.filter((b) => ymd(b.dueDate) <= in7 && ymd(b.dueDate) >= asOf).reduce((s, b) => s + toCents(b.balance), 0);
    const apOverdue = bills.filter((b) => ymd(b.dueDate) < asOf).reduce((s, b) => s + toCents(b.balance), 0);
    const awaitingApproval = await prisma.bill.count({ where: { tenantId, status: 'PENDING_APPROVAL' } });

    // Profit: this month, the year to date, and the last six months.
    const monthStart = `${asOf.slice(0, 7)}-01`;
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    // Last month to the same day: what this month's profit so far is compared with (MONEY-19).
    const prevStart = ymd(new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 2, 1)));
    const prevLastDay = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1, 0)).getUTCDate();
    const prevToDate = `${prevStart.slice(0, 8)}${String(Math.min(Number(asOf.slice(8, 10)), prevLastDay)).padStart(2, '0')}`;
    const [month, ytd, lastMonthToDate] = await Promise.all([profitAndLoss(prisma, monthStart, asOf), profitAndLoss(prisma, yearStart, asOf), profitAndLoss(prisma, prevStart, prevToDate)]);
    const sixBack = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 6, 1));
    const trendReport = await profitAndLoss(prisma, ymd(sixBack), asOf, {}, { columns: 'month' });
    const trend = monthsBetween(ymd(sixBack), asOf).map((m) => {
      const c = trendReport.columns.find((x) => x.key === m.key);
      return { key: m.key, label: m.label, income: c?.totals.income ?? 0, netIncome: c?.totals.netIncome ?? 0 };
    });

    // Last month's close — counted exactly as the close page counts it (lib/books/close/period.closeProgress).
    const lastMonth = ymd(new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 2, 1))).slice(0, 7);
    const period = await closeProgress(prisma, lastMonth);
    // The bank and card accounts actually connected to a feed (the Bank page's list), beside the ledger's.
    const feedAccounts = await prisma.bankFeedAccount.count({ where: { tenantId, isActive: true } });

    // QuickBooks.
    const [conn, conflicts, pending, failed, unmatched] = await Promise.all([
      prisma.qboCompanyConnection.findUnique({ where: { tenantId } }),
      prisma.qboSyncConflict.count({ where: { tenantId, status: 'OPEN' } }),
      prisma.qboOutbox.count({ where: { tenantId, status: 'PENDING' } }),
      prisma.qboOutbox.count({ where: { tenantId, status: 'FAILED' } }),
      prisma.bankTransaction.count({ where: { tenantId, status: 'UNMATCHED' } }),
    ]);

    const needsYou: BooksOverview['needsYou'] = [];
    if (awaitingApproval) needsYou.push({ key: 'bills', label: `${awaitingApproval} ${awaitingApproval === 1 ? 'bill waits' : 'bills wait'} for approval`, count: awaitingApproval, to: '/books/bills?tab=approve', tone: 'warning' });
    if (apOverdue > 0) needsYou.push({ key: 'overdue-bills', label: `${fromCents(apOverdue).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} in bills past due`, count: bills.filter((b) => ymd(b.dueDate) < asOf).length, to: '/books/bills', tone: 'alert' });
    if (unmatched) needsYou.push({ key: 'bank', label: `${unmatched} bank ${unmatched === 1 ? 'transaction' : 'transactions'} to match or categorize`, count: unmatched, to: '/books/bank', tone: 'warning' });
    if (conflicts) needsYou.push({ key: 'conflicts', label: `${conflicts} QuickBooks ${conflicts === 1 ? 'change needs' : 'changes need'} a decision`, count: conflicts, to: '/books/quickbooks', tone: 'alert' });
    if (failed) needsYou.push({ key: 'sync-failed', label: `${failed} ${failed === 1 ? 'record' : 'records'} didn’t reach QuickBooks`, count: failed, to: '/books/quickbooks', tone: 'alert' });
    // The books' receivables and the open statements should be the same money. When they aren't,
    // name the actual cause, in the direction it runs (audit 2026-10-29 MONEY-3): statements marked
    // paid with no payment in the books leave the BOOKS higher; finalized statements not yet posted
    // leave them lower. Each cause has a button that fixes it (Post history records both).
    const openOnStatements = aging.current + aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.over90;
    const fmt = (c: number) => fromCents(c).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const markedPaid = await paidWithoutPayment(prisma);
    const markedPaidCents = markedPaid.reduce((n, b) => n + b.total, 0);
    const unposted = await unpostedStatements(tenantId);
    if (Math.abs(openOnStatements - arTotal) >= 1) {
      // First: until these are in, every other number on the page is off by them.
      if (unposted.count > 0) {
        needsYou.unshift({ key: 'ar-unposted', label: `${unposted.count} finalized ${unposted.count === 1 ? 'statement' : 'statements'} (${fmt(unposted.amount)}) ${unposted.count === 1 ? 'isn’t' : 'aren’t'} in the books yet, so the books show ${fmt(arTotal)} owed against ${fmt(openOnStatements)} on open statements`, count: unposted.count, to: '/books/receivables', tone: 'warning' });
      }
      if (markedPaid.length > 0) {
        needsYou.unshift({ key: 'ar-paid-unrecorded', label: `${markedPaid.length} ${markedPaid.length === 1 ? 'statement was' : 'statements were'} marked paid (${fmt(markedPaidCents)}) with no payment in the books, so the books still count ${markedPaid.length === 1 ? 'it' : 'them'} as owed: ${fmt(arTotal)} against ${fmt(openOnStatements)} on open statements`, count: markedPaid.length, to: '/books/receivables?view=payments', tone: 'warning' });
      }
      if (unposted.count === 0 && markedPaid.length === 0) {
        needsYou.unshift({ key: 'ar-differs', label: `The books show ${fmt(arTotal)} owed by clients; the open statements add up to ${fmt(openOnStatements)} — compare them in the receivables account`, count: 1, to: '/books/receivables', tone: 'warning' });
      }
    }
    // A bank account below zero (audit 2026-10-29 MONEY-18): the Cash total nets it away, so it is
    // named here, with where the money could come from.
    for (const a of cashAccounts.filter((x) => x.subtype === 'BANK' && x.balance < 0)) {
      const short = toCents(-a.balance);
      const source = cashAccounts.filter((x) => x.subtype === 'BANK' && x.id !== a.id && toCents(x.balance) >= short).sort((x, y) => y.balance - x.balance)[0];
      needsYou.unshift({
        key: `overdrawn-${a.id}`,
        label: `${a.name} is overdrawn by ${fmt(short)}${source ? ` — move ${fmt(short)} from ${source.name} before anything else clears` : ' — fund it before anything else clears'}`,
        count: 1,
        to: `/books/accounts/${a.id}`,
        tone: 'alert',
      });
    }
    if (aging.over90 > 0) needsYou.push({ key: 'ar-90', label: `${fromCents(aging.over90).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} owed by clients for over 90 days`, count: 1, to: '/books/receivables', tone: 'alert' });
    if (period.status !== 'CLOSED' && Number(asOf.slice(8, 10)) >= 5) needsYou.push({ key: 'close', label: `${new Date(`${lastMonth}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} isn’t closed yet`, count: 1, to: `/books/close/${lastMonth}`, tone: 'info' });

    const body: BooksOverview = {
      asOf,
      cash: { total: fromCents(cashTotal), accounts: cashAccounts, connectedAccounts: feedAccounts },
      receivables: {
        total: fromCents(arTotal),
        /** What the open statements add up to (the card's source); the KPI shows this and says when the ledger differs. */
        openOnStatements: fromCents(openOnStatements),
        aging: { current: fromCents(aging.current), days1to30: fromCents(aging.days1to30), days31to60: fromCents(aging.days31to60), days61to90: fromCents(aging.days61to90), over90: fromCents(aging.over90) },
        topClients: byClient.slice(0, 5).map((c) => ({ ...c, open: fromCents(c.open) })),
        markedPaidWithoutPayment: { count: markedPaid.length, amount: fromCents(markedPaidCents) },
        notInBooks: { count: unposted.count, amount: fromCents(unposted.amount) },
      },
      payables: { total: fromCents(apTotal), dueIn7Days: fromCents(apDue7), overdue: fromCents(apOverdue), awaitingApproval },
      profit: { month: month.totals ?? zeroTotals, yearToDate: ytd.totals ?? zeroTotals, trend, lastMonthToDate: { from: prevStart, to: prevToDate, totals: lastMonthToDate.totals ?? zeroTotals } },
      close: {
        periodKey: lastMonth,
        status: period.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        closedAt: period.closedAt,
        tasksDone: period.tasksDone,
        tasksTotal: period.tasksTotal,
      },
      quickbooks: {
        connected: !!conn && conn.status !== 'DISCONNECTED',
        status: conn?.status ?? null,
        companyName: conn?.companyName ?? null,
        lastPushAt: conn?.lastPushAt?.toISOString() ?? null,
        lastPullAt: conn?.lastPullAt?.toISOString() ?? null,
        openConflicts: conflicts,
        pending,
        failed,
      },
      needsYou,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/dimensions', async (_req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const [clients, sites, departments, costCenters] = await Promise.all([
      prisma.client.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 }),
      prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, client: { select: { name: true } } }, orderBy: { name: 'asc' }, take: 2000 }),
      prisma.department.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 }),
      prisma.costCenter.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, code: true }, orderBy: { code: 'asc' }, take: 2000 }),
    ]);
    // Several clients can each have a site of the same name ("The Grand Hotel" ten times
    // in a picker): a repeated name carries its client (finance walk 15).
    const nameCount = new Map<string, number>();
    for (const s of sites) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
    const siteRows = sites.map((s) => ({ id: s.id, name: (nameCount.get(s.name) ?? 0) > 1 && s.client?.name && s.client.name !== s.name ? `${s.name} · ${s.client.name}` : s.name }));
    const body: BooksDimensions = { clients, sites: siteRows, departments, costCenters: costCenters.map((c) => ({ id: c.id, name: `${c.code} · ${c.name}` })) };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/* ---- Accounts --------------------------------------------------------------- */

/** Net movement (cents, debit − credit) per account from Jan 1 of `asOf`'s year through `asOf`. */
async function movementYearToDate(asOf: string): Promise<Map<string, number>> {
  const rows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { tenantId: tenantIdForWrite(), entry: { status: 'POSTED', entryDate: { gte: dateOnly(`${asOf.slice(0, 4)}-01-01`), lte: dateOnly(asOf) } } },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.accountId, toCents(r._sum.debit) - toCents(r._sum.credit)]));
}

async function accountRows(asOf: string): Promise<LedgerAccountRow[]> {
  const tenantId = tenantIdForWrite();
  const { byId } = await accountIndex(prisma);
  const [bal, ytd] = await Promise.all([balancesThrough(asOf), movementYearToDate(asOf)]);
  const used = new Set((await prisma.journalLine.groupBy({ by: ['accountId'], where: { tenantId } })).map((r) => r.accountId));
  return [...byId.values()]
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((a) => {
      const net = bal.get(a.id) ?? 0;
      const moved = ytd.get(a.id) ?? 0;
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type as LedgerAccountType,
        subtype: a.subtype,
        systemKey: a.systemKey,
        parentId: a.parentId,
        description: a.description,
        isActive: a.isActive,
        balance: fromCents(debitNormal(a.type) ? net : -net),
        activityYtd: fromCents(debitNormal(a.type) ? moved : -moved),
        hasEntries: used.has(a.id),
      };
    });
}

booksLedgerRouter.get('/accounts', async (req, res, next) => {
  try {
    const asOf = z.object({ asOf: Ymd.optional() }).parse(req.query).asOf ?? today();
    res.json({ accounts: await accountRows(asOf) });
  } catch (err) {
    next(err);
  }
});

function assertSubtype(type: LedgerAccountType, subtype: string): void {
  if (!LEDGER_SUBTYPES[type].includes(subtype)) throw new HttpError(400, 'bad_subtype', `${subtype} isn’t a kind of ${type.toLowerCase()} account.`);
}

async function assertParent(parentId: string | null | undefined, type: LedgerAccountType, selfId?: string): Promise<void> {
  if (!parentId) return;
  if (parentId === selfId) throw new HttpError(400, 'bad_parent', 'An account can’t be its own parent.');
  const p = await prisma.ledgerAccount.findFirst({ where: { id: parentId, tenantId: tenantIdForWrite() } });
  if (!p) throw new HttpError(400, 'bad_parent', 'The parent account doesn’t exist.');
  if (p.type !== type) throw new HttpError(400, 'bad_parent', 'A sub-account sits under an account of the same type.');
}

async function assertCodeFree(code: string, selfId?: string): Promise<void> {
  const clash = await prisma.ledgerAccount.findFirst({ where: { tenantId: tenantIdForWrite(), code, ...(selfId ? { id: { not: selfId } } : {}) }, select: { name: true } });
  if (clash) throw new HttpError(409, 'code_taken', `Account ${code} is already ${clash.name}.`);
}

booksLedgerRouter.post('/accounts', MANAGE, async (req, res, next) => {
  try {
    const input = LedgerAccountCreateInputSchema.parse(req.body);
    await accountIndex(prisma); // the chart exists before the first custom account
    assertSubtype(input.type, input.subtype);
    await assertCodeFree(input.code);
    await assertParent(input.parentId, input.type);
    const a = await prisma.ledgerAccount.create({
      data: { tenantId: tenantIdForWrite(), code: input.code, name: input.name, type: input.type, subtype: input.subtype, parentId: input.parentId ?? null, description: input.description ?? null },
    });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.account.create', entityType: 'LedgerAccount', entityId: a.id, metadata: { summary: `Added account ${a.code} ${a.name}` } }, 'books.accounts');
    emitBooksChange({ localType: 'LedgerAccount', localId: a.id, op: 'UPSERT' });
    res.status(201).json({ account: (await accountRows(today())).find((r) => r.id === a.id) });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.patch('/accounts/:id', MANAGE, async (req, res, next) => {
  try {
    const input = LedgerAccountUpdateInputSchema.parse(req.body);
    const tenantId = tenantIdForWrite();
    const a = await prisma.ledgerAccount.findFirst({ where: { id: req.params.id, tenantId } });
    if (!a) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
    const hasLines = (await prisma.journalLine.count({ where: { tenantId, accountId: a.id } })) > 0;
    const type = (input.type ?? a.type) as LedgerAccountType;
    const subtype = input.subtype ?? a.subtype;
    if ((input.type && input.type !== a.type) || (input.subtype && input.subtype !== a.subtype)) {
      if (a.systemKey && input.type && input.type !== a.type) throw new HttpError(409, 'system_account', `${a.name} is one the automatic posting uses; its type stays ${a.type.toLowerCase()}.`);
      if (hasLines) throw new HttpError(409, 'account_in_use', 'This account has entries, so its type can’t change. Make a new account and move the balance with a journal entry.');
      assertSubtype(type, subtype);
    }
    if (input.code && input.code !== a.code) await assertCodeFree(input.code, a.id);
    if (input.parentId !== undefined) await assertParent(input.parentId, type, a.id);
    if (input.isActive === false && a.isActive) {
      const net = (await balancesThrough('9999-12-31')).get(a.id) ?? 0;
      if (net !== 0) throw new HttpError(409, 'account_has_balance', `This account holds ${fromCents(Math.abs(net)).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}. Move the balance before turning it off.`);
    }
    const data: Prisma.LedgerAccountUpdateInput = {};
    if (input.code !== undefined) data.code = input.code;
    if (input.name !== undefined) data.name = input.name;
    if (input.type !== undefined) data.type = input.type;
    if (input.subtype !== undefined) data.subtype = input.subtype;
    if (input.description !== undefined) data.description = input.description;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.parentId !== undefined) data.parent = input.parentId ? { connect: { id: input.parentId } } : { disconnect: true };
    await prisma.ledgerAccount.update({ where: { id: a.id }, data });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.account.update', entityType: 'LedgerAccount', entityId: a.id, metadata: { before: { code: a.code, name: a.name, isActive: a.isActive }, changes: input } as Prisma.InputJsonValue }, 'books.accounts');
    emitBooksChange({ localType: 'LedgerAccount', localId: a.id, op: 'UPSERT' });
    res.json({ account: (await accountRows(today())).find((r) => r.id === a.id) });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.delete('/accounts/:id', MANAGE, async (req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const a = await prisma.ledgerAccount.findFirst({ where: { id: req.params.id, tenantId } });
    if (!a) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
    if (a.systemKey) throw new HttpError(409, 'system_account', `${a.name} is one the automatic posting uses. Rename it or turn it off instead.`);
    if ((await prisma.journalLine.count({ where: { tenantId, accountId: a.id } })) > 0) throw new HttpError(409, 'account_in_use', 'This account has entries. Turn it off instead.');
    await prisma.ledgerAccount.delete({ where: { id: a.id } });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.account.delete', entityType: 'LedgerAccount', entityId: a.id, metadata: { summary: `Deleted account ${a.code} ${a.name}` } }, 'books.accounts');
    emitBooksChange({ localType: 'LedgerAccount', localId: a.id, op: 'DELETE' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/accounts/:id/detail', async (req, res, next) => {
  try {
    const q = z.object({ from: Ymd.optional(), to: Ymd.optional() }).parse(req.query);
    const to = q.to ?? today();
    const from = q.from ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new HttpError(400, 'bad_range', 'The start is after the end.');
    const d = await accountDetail(prisma, req.params.id, from, to, dims(req.query));
    if (!d) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
    res.json(d);
  } catch (err) {
    next(err);
  }
});

/* ---- Journal ---------------------------------------------------------------- */

const JournalFilterQuery = z.object({
  from: Ymd.optional(),
  to: Ymd.optional(),
  source: z.string().max(24).optional(),
  origin: z.enum(['SITE', 'QUICKBOOKS']).optional(),
  status: z.enum(['POSTED', 'VOID']).optional(),
  accountId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  /** The column the server orders by (the whole filtered set, not a page). Default: newest first. */
  sort: z.enum(['date', 'number', 'amount']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});
const JournalQuery = JournalFilterQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // Bounded (deep audit CODE-24): 1e20 parsed as an integer and overflowed the database's skip.
  offset: z.coerce.number().int().min(0).max(2_000_000_000).default(0),
});
type JournalFilter = z.infer<typeof JournalFilterQuery>;

function journalWhere(q: JournalFilter): Prisma.JournalEntryWhereInput {
  return {
    tenantId: tenantIdForWrite(),
    ...(q.from || q.to ? { entryDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.origin ? { origin: q.origin } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
    ...(q.q ? { OR: [{ memo: { contains: q.q, mode: 'insensitive' } }, ...(/^\d+$/.test(q.q) ? [{ number: Number(q.q) }] : [])] } : {}),
  };
}

/** The order the whole filtered set is read in — the grid's sort, done where every row is. */
function journalOrder(q: JournalFilter): Prisma.JournalEntryOrderByWithRelationInput[] {
  const dir = q.dir ?? 'desc';
  if (q.sort === 'number') return [{ number: dir }];
  if (q.sort === 'amount') return [{ totalDebit: dir }, { number: 'desc' }];
  return [{ entryDate: dir }, { number: dir }];
}

type JournalEntryWithAccounts = Prisma.JournalEntryGetPayload<{ include: { lines: { select: { accountId: true } } } }>;

async function journalRows(entries: JournalEntryWithAccounts[]): Promise<BooksJournalRow[]> {
  const { byId } = await accountIndex(prisma);
  return entries.map((e) => {
    const accounts = [...new Set(e.lines.map((l) => l.accountId))];
    return {
      id: e.id,
      number: e.number,
      date: ymd(e.entryDate),
      memo: e.memo,
      source: e.source,
      origin: e.origin as 'SITE' | 'QUICKBOOKS',
      status: e.status as 'POSTED' | 'VOID',
      amount: fromCents(toCents(e.totalDebit)),
      accounts: accounts.length <= 2 ? accounts.map((id) => byId.get(id)?.name ?? '—').join(' / ') : `${accounts.length} accounts`,
      reverseOn: e.reverseOn ? ymd(e.reverseOn) : null,
    };
  });
}

booksLedgerRouter.get('/journal', async (req, res, next) => {
  try {
    const q = JournalQuery.parse(req.query);
    const where = journalWhere(q);
    const [total, entries] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        orderBy: journalOrder(q),
        skip: q.offset,
        take: q.limit,
        include: { lines: { select: { accountId: true }, orderBy: { lineNo: 'asc' } } },
      }),
    ]);
    res.json({ entries: await journalRows(entries), total });
  } catch (err) {
    next(err);
  }
});

/** The most rows one export carries; past it the file says so on its last line. */
const JOURNAL_EXPORT_CAP = 50_000;

/**
 * GET /books/journal.csv — every entry the filters match, in the grid's
 * order (not just the page on screen), ONE ROW PER LINE (deep audit
 * MONEY-22): entry number, date and memo, the account, debit and credit,
 * the line's client and site — what an accountant ties out or loads
 * elsewhere. Through the shared writer: numbers stay numbers, BOM and CRLF.
 */
booksLedgerRouter.get('/journal.csv', async (req, res, next) => {
  try {
    const q = JournalFilterQuery.parse(req.query);
    const where = journalWhere(q);
    const [total, entries] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        orderBy: journalOrder(q),
        take: JOURNAL_EXPORT_CAP,
        include: { lines: { select: { accountId: true, debit: true, credit: true, memo: true, clientId: true, siteId: true }, orderBy: { lineNo: 'asc' } } },
      }),
    ]);
    const { byId } = await accountIndex(prisma);
    const names = await nameMaps({ clients: entries.flatMap((e) => e.lines.map((l) => l.clientId ?? '')), sites: entries.flatMap((e) => e.lines.map((l) => l.siteId ?? '')) });
    const rows: Array<Array<string | number>> = [['Entry', 'Date', 'Memo', 'Account', 'Account name', 'Debit', 'Credit', 'Line memo', 'Client', 'Site', 'From', 'Status', 'Reverses on']];
    for (const e of entries) {
      const from = e.origin === 'QUICKBOOKS' ? 'QuickBooks' : (JOURNAL_SOURCE_LABELS[e.source] ?? e.source);
      for (const l of e.lines) {
        const a = byId.get(l.accountId);
        rows.push([
          e.number,
          ymd(e.entryDate),
          e.memo ?? '',
          a?.code ?? '',
          a?.name ?? '',
          fromCents(toCents(l.debit)),
          fromCents(toCents(l.credit)),
          l.memo ?? '',
          l.clientId ? (names.clients.get(l.clientId) ?? '') : '',
          l.siteId ? (names.sites.get(l.siteId) ?? '') : '',
          from,
          e.status === 'VOID' ? 'Void' : 'Posted',
          e.reverseOn ? ymd(e.reverseOn) : '',
        ]);
      }
    }
    if (total > entries.length) rows.push([`First ${entries.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} entries — narrow the dates for the rest.`]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(`journal-${q.from ?? 'start'}-to-${q.to ?? today()}`, 'csv')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
});

async function sourceLinkFor(e: { sourceType: string | null; sourceId: string | null; source: string; origin: string }): Promise<{ label: string; to: string } | null> {
  if (e.origin === 'QUICKBOOKS') return null;
  const id = e.sourceId;
  if (!id) return null;
  switch (e.sourceType) {
    case 'PayrollRun':
      return { label: 'Open the payroll run', to: `/payroll/runs/${id}` };
    case 'ClientStatement': {
      const s = await prisma.clientStatement.findFirst({ where: { id, tenantId: tenantIdForWrite() }, select: { clientId: true } });
      return s ? { label: 'Open the client’s statements', to: `/clients/${s.clientId}?tab=statements` } : null;
    }
    case 'ClientPayment':
      return { label: 'Open receivables', to: '/books/receivables' };
    case 'Bill':
      return { label: 'Open the bill', to: `/books/bills/${id}` };
    case 'BillPayment':
      return { label: 'Open bills', to: '/books/bills' };
    case 'BankTransaction':
      return { label: 'Open bank and cards', to: '/books/bank' };
    case 'FixedAsset':
      return { label: 'Open the asset', to: `/books/assets/${id}` };
    case 'JournalEntry':
      return { label: 'Open the original entry', to: `/books/journal/${id}` };
    default:
      return null;
  }
}

booksLedgerRouter.get('/journal/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'entry_not_found', 'Journal entry not found.');
    const tenantId = tenantIdForWrite();
    const e = await prisma.journalEntry.findFirst({
      where: { id: req.params.id, tenantId },
      include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: true } }, reverses: { select: { id: true, number: true } }, reversal: { select: { id: true, number: true } } },
    });
    if (!e) throw new HttpError(404, 'entry_not_found', 'Journal entry not found.');
    const names = await nameMaps({
      clients: e.lines.map((l) => l.clientId!).filter(Boolean),
      sites: e.lines.map((l) => l.siteId!).filter(Boolean),
      departments: e.lines.map((l) => l.departmentId!).filter(Boolean),
      costCenters: e.lines.map((l) => l.costCenterId!).filter(Boolean),
      vendors: e.lines.map((l) => l.vendorId!).filter(Boolean),
    });
    const named = (m: Map<string, string>, id: string | null) => (id ? { id, name: m.get(id) ?? '—' } : null);
    const [createdByName, voidedByName, periodClosed, sourceLink] = await Promise.all([personName(e.createdById), personName(e.voidedById), isPeriodClosed(prisma, e.periodKey), sourceLinkFor(e)]);
    const entry: BooksJournalEntryDetail = {
      id: e.id,
      number: e.number,
      date: ymd(e.entryDate),
      periodKey: e.periodKey,
      memo: e.memo,
      source: e.source,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      sourceLink,
      origin: e.origin as 'SITE' | 'QUICKBOOKS',
      status: e.status as 'POSTED' | 'VOID',
      reverseOn: e.reverseOn ? ymd(e.reverseOn) : null,
      reverses: e.reverses,
      reversedBy: e.reversal,
      total: fromCents(toCents(e.totalDebit)),
      createdByName,
      postedAt: e.postedAt.toISOString(),
      voidedAt: e.voidedAt?.toISOString() ?? null,
      voidedByName,
      voidReason: e.voidReason,
      periodClosed,
      lines: e.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        account: { id: l.account.id, code: l.account.code, name: l.account.name, type: l.account.type as LedgerAccountType },
        debit: fromCents(toCents(l.debit)),
        credit: fromCents(toCents(l.credit)),
        memo: l.memo,
        client: named(names.clients, l.clientId),
        site: named(names.sites, l.siteId),
        department: named(names.departments, l.departmentId),
        costCenter: named(names.costCenters, l.costCenterId),
        vendor: named(names.vendors, l.vendorId),
        cleared: !!l.clearedAt,
      })),
    };
    res.json({ entry });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.post('/journal', MANAGE, async (req, res, next) => {
  try {
    const input = BooksManualEntryInputSchema.parse(req.body);
    if (input.reverseOn && input.reverseOn <= input.date) throw new HttpError(400, 'bad_reverse_on', 'An accrual reverses after the day it’s posted.');
    for (const l of input.lines) {
      if ((l.debit > 0) === (l.credit > 0)) throw new HttpError(400, 'bad_line', 'Each line is a debit or a credit — one, not both, and not zero.');
    }
    const entry = await postEntry(prisma, {
      date: input.date,
      memo: input.memo ?? null,
      source: input.reverseOn ? 'ACCRUAL' : 'MANUAL',
      reverseOn: input.reverseOn ?? null,
      createdById: req.user!.id,
      lines: input.lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo ?? null, clientId: l.clientId ?? null, siteId: l.siteId ?? null, departmentId: l.departmentId ?? null, costCenterId: l.costCenterId ?? null })),
    });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.journal.post', entityType: 'JournalEntry', entityId: entry.id, metadata: { summary: `Posted entry #${entry.number} for ${Number(entry.totalDebit).toFixed(2)}`, date: input.date } }, 'books.journal');
    res.status(201).json({ entry: { id: entry.id, number: entry.number } });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.post('/journal/:id/void', MANAGE, async (req, res, next) => {
  try {
    const { reason } = BooksVoidInputSchema.parse(req.body);
    const tenantId = tenantIdForWrite();
    const e = await prisma.journalEntry.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, number: true, source: true, origin: true } });
    if (!e) throw new HttpError(404, 'entry_not_found', 'Journal entry not found.');
    // An entry the platform posted belongs to its record: void the bill, the run, the statement there.
    if (!['MANUAL', 'ACCRUAL', 'OPENING'].includes(e.source) && e.origin === 'SITE') {
      throw new HttpError(409, 'entry_owned', 'This entry was posted by its record (a payroll run, a bill, a statement …). Change or void that record and the books follow.');
    }
    const r = await voidEntry(prisma, e.id, { reason, userId: req.user!.id });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.journal.void', entityType: 'JournalEntry', entityId: e.id, metadata: { summary: `${r.voided ? 'Voided' : 'Reversed'} entry #${e.number}: ${reason}` } }, 'books.journal');
    res.json({ voided: r.voided, reversalId: r.reversal?.id ?? null });
  } catch (err) {
    next(err);
  }
});

const OPENING_KEY = 'opening-balances';

booksLedgerRouter.get('/opening-balances', async (_req, res, next) => {
  try {
    const e = await entryForKey(prisma, OPENING_KEY);
    if (!e || e.status !== 'POSTED') return void res.json({ date: null, lines: [] });
    const { byId, byKey } = await accountIndex(prisma);
    const plug = byKey.get('OPENING_BALANCE')?.id;
    res.json({
      date: ymd(e.entryDate),
      lines: e.lines
        .filter((l) => l.accountId !== plug)
        .map((l) => {
          const a = byId.get(l.accountId)!;
          const net = toCents(l.debit) - toCents(l.credit);
          return { accountId: l.accountId, amount: fromCents(debitNormal(a.type) ? net : -net) };
        }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * The balances the books start from. One entry (rewritten while its month is
 * open), each account on its normal side, the difference to opening balance
 * equity so it always balances.
 */
booksLedgerRouter.post('/opening-balances', MANAGE, async (req, res, next) => {
  try {
    const input = BooksOpeningBalancesInputSchema.parse(req.body);
    const { byId } = await accountIndex(prisma);
    const lines: Array<{ account: string; debit?: number; credit?: number }> = [];
    let net = 0;
    for (const l of input.lines) {
      const a = byId.get(l.accountId);
      if (!a) throw new HttpError(400, 'unknown_account', 'An account in the list doesn’t exist.');
      const cents = toCents(l.amount);
      if (cents === 0) continue;
      const debit = debitNormal(a.type) ? cents : -cents;
      net += debit;
      lines.push(debit > 0 ? { account: a.id, debit: fromCents(debit) } : { account: a.id, credit: fromCents(-debit) });
    }
    if (lines.length === 0) throw new HttpError(400, 'nothing_to_post', 'Every balance is zero.');
    if (net !== 0) lines.push(net > 0 ? { account: 'OPENING_BALANCE', credit: fromCents(net) } : { account: 'OPENING_BALANCE', debit: fromCents(-net) });
    const entry = await postEntry(prisma, { date: input.date, source: 'OPENING', sourceKey: OPENING_KEY, memo: 'Opening balances', createdById: req.user!.id, lines });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.opening_balances', entityType: 'JournalEntry', entityId: entry.id, metadata: { summary: `Opening balances as of ${input.date}` } }, 'books.journal');
    res.json({ entry: { id: entry.id, number: entry.number } });
  } catch (err) {
    next(err);
  }
});

/* ---- Reports ---------------------------------------------------------------- */

function rangeQuery(req: Request): { from: string; to: string } {
  const q = z.object({ from: Ymd.optional(), to: Ymd.optional() }).parse(req.query);
  const to = q.to ?? today();
  const from = q.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw new HttpError(400, 'bad_range', 'The start is after the end.');
  return { from, to };
}
const asOfQuery = (req: Request) => z.object({ asOf: Ymd.optional() }).parse(req.query).asOf ?? today();
const columnsQuery = (req: Request) => z.object({ columns: z.enum(['none', 'month', 'client']).default('none') }).parse(req.query).columns;
/** ?compare=prior|yoy — the statement beside the same one for the comparison range. */
const compareQuery = (req: Request) => z.object({ compare: z.enum(BOOKS_COMPARE_KINDS).optional() }).parse(req.query).compare;

booksLedgerRouter.get('/reports/trial-balance', async (req, res, next) => {
  try {
    res.json(await trialBalance(prisma, asOfQuery(req), dims(req.query)));
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/reports/profit-and-loss', async (req, res, next) => {
  try {
    const { from, to } = rangeQuery(req);
    const d = dims(req.query);
    const columns = columnsQuery(req);
    const kind = compareQuery(req);
    const r = await profitAndLoss(prisma, from, to, d, { columns });
    // A comparison sits beside the total; split columns (by month, by client) are their own comparison.
    let compare = null;
    if (kind && columns === 'none') {
      const c = compareRange(from, to, kind);
      const cr = await profitAndLoss(prisma, c.from, c.to, d);
      compare = { kind, from: c.from, to: c.to, sections: cr.sections, totals: cr.totals };
    }
    res.json({ ...r, compare });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/reports/balance-sheet', async (req, res, next) => {
  try {
    const asOf = asOfQuery(req);
    const d = dims(req.query);
    const kind = compareQuery(req);
    const r = await balanceSheet(prisma, asOf, d);
    let compare = null;
    if (kind) {
      const c = await balanceSheet(prisma, compareAsOf(asOf, kind), d);
      compare = { kind, asOf: c.asOf, assets: c.assets, liabilities: c.liabilities, equity: c.equity, totals: c.totals };
    }
    res.json({ ...r, compare });
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/reports/cash-flow', async (req, res, next) => {
  try {
    const { from, to } = rangeQuery(req);
    const d = dims(req.query);
    const kind = compareQuery(req);
    const r = await cashFlow(prisma, from, to, d);
    let compare = null;
    if (kind) {
      const c = compareRange(from, to, kind);
      const cr = await cashFlow(prisma, c.from, c.to, d);
      compare = { kind, from: c.from, to: c.to, netIncome: cr.netIncome, operating: cr.operating, investing: cr.investing, financing: cr.financing, totals: cr.totals };
    }
    res.json({ ...r, compare });
  } catch (err) {
    next(err);
  }
});

for (const kind of ['pdf', 'xlsx'] as const) {
  booksLedgerRouter.get(`/reports/trial-balance.${kind}`, async (req, res, next) => {
    try {
      const d = dims(req.query);
      const r = await trialBalance(prisma, asOfQuery(req), d);
      const meta = await exportMeta(d);
      sendFile(res, kind === 'pdf' ? await trialBalancePdf(r, meta) : await trialBalanceXlsx(r, meta), fileName(`trial-balance-${r.asOf}`, kind), kind);
    } catch (err) {
      next(err);
    }
  });
  booksLedgerRouter.get(`/reports/profit-and-loss.${kind}`, async (req, res, next) => {
    try {
      const d = dims(req.query);
      const { from, to } = rangeQuery(req);
      const r = await profitAndLoss(prisma, from, to, d, { columns: columnsQuery(req) });
      const meta = await exportMeta(d);
      sendFile(res, kind === 'pdf' ? await profitAndLossPdf(r, meta) : await profitAndLossXlsx(r, meta), fileName(`profit-and-loss-${from}-to-${to}`, kind), kind);
    } catch (err) {
      next(err);
    }
  });
  booksLedgerRouter.get(`/reports/balance-sheet.${kind}`, async (req, res, next) => {
    try {
      const d = dims(req.query);
      const r = await balanceSheet(prisma, asOfQuery(req), d);
      const meta = await exportMeta(d);
      sendFile(res, kind === 'pdf' ? await balanceSheetPdf(r, meta) : await balanceSheetXlsx(r, meta), fileName(`balance-sheet-${r.asOf}`, kind), kind);
    } catch (err) {
      next(err);
    }
  });
  booksLedgerRouter.get(`/reports/cash-flow.${kind}`, async (req, res, next) => {
    try {
      const d = dims(req.query);
      const { from, to } = rangeQuery(req);
      const r = await cashFlow(prisma, from, to, d);
      const meta = await exportMeta(d);
      sendFile(res, kind === 'pdf' ? await cashFlowPdf(r, meta) : await cashFlowXlsx(r, meta), fileName(`cash-flow-${from}-to-${to}`, kind), kind);
    } catch (err) {
      next(err);
    }
  });
}
