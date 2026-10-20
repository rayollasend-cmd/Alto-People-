import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  BooksDimensionsFilterSchema,
  BooksManualEntryInputSchema,
  BooksOpeningBalancesInputSchema,
  BooksVoidInputSchema,
  LEDGER_SUBTYPES,
  LedgerAccountCreateInputSchema,
  LedgerAccountUpdateInputSchema,
  type BooksDimensions,
  type BooksJournalEntryDetail,
  type BooksJournalRow,
  type BooksOverview,
  type LedgerAccountRow,
  type LedgerAccountType,
} from '@alto-people/shared';
import { prisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { loadBrand } from '../../lib/docKit/index.js';
import { accountIndex, fromCents, isPeriodClosed, postEntry, toCents, voidEntry, entryForKey } from '../../lib/books/ledger.js';
import { accountDetail, balanceSheet, cashFlow, monthsBetween, profitAndLoss, trialBalance, type Dimensions } from '../../lib/books/reports.js';
import { emitBooksChange } from '../../lib/books/events.js';
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
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const today = () => ymd(new Date());
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

    // Receivables: the AR accounts' balance, aged from the open finalized statements.
    const arTotal = [...byId.values()].filter((a) => a.subtype === 'AR').reduce((s, a) => s + (bal.get(a.id) ?? 0), 0);
    const open = await prisma.clientStatement.findMany({
      where: { tenantId, status: 'FINAL', paidAt: null },
      select: { id: true, clientId: true, dueAt: true, finalizedAt: true, snapshot: true, client: { select: { name: true } } },
    });
    const applied = open.length
      ? await prisma.clientPaymentApplication.groupBy({ by: ['statementId'], where: { tenantId, statementId: { in: open.map((s) => s.id) }, payment: { voidedAt: null } }, _sum: { amount: true } })
      : [];
    const paid = new Map(applied.map((a) => [a.statementId, toCents(a._sum.amount)]));
    const aging = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
    const byClient = new Map<string, { clientId: string; name: string; open: number; oldestDueAt: string | null }>();
    const now = dateOnly(asOf).getTime();
    for (const s of open) {
      const amount = toCents((s.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount ?? 0) - (paid.get(s.id) ?? 0);
      if (amount <= 0) continue;
      const due = s.dueAt ?? s.finalizedAt ?? new Date();
      const late = Math.floor((now - dateOnly(ymd(due)).getTime()) / DAY);
      const bucket = late <= 0 ? 'current' : late <= 30 ? 'days1to30' : late <= 60 ? 'days31to60' : late <= 90 ? 'days61to90' : 'over90';
      aging[bucket] += amount;
      const c = byClient.get(s.clientId) ?? { clientId: s.clientId, name: s.client.name, open: 0, oldestDueAt: null };
      c.open += amount;
      const d = ymd(due);
      if (!c.oldestDueAt || d < c.oldestDueAt) c.oldestDueAt = d;
      byClient.set(s.clientId, c);
    }

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
    const [month, ytd] = await Promise.all([profitAndLoss(prisma, monthStart, asOf), profitAndLoss(prisma, yearStart, asOf)]);
    const sixBack = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 6, 1));
    const trendReport = await profitAndLoss(prisma, ymd(sixBack), asOf, {}, { columns: 'month' });
    const trend = monthsBetween(ymd(sixBack), asOf).map((m) => {
      const c = trendReport.columns.find((x) => x.key === m.key);
      return { key: m.key, label: m.label, income: c?.totals.income ?? 0, netIncome: c?.totals.netIncome ?? 0 };
    });

    // Last month's close.
    const lastMonth = ymd(new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 2, 1))).slice(0, 7);
    const period = await prisma.fiscalPeriod.findUnique({ where: { tenantId_periodKey: { tenantId, periodKey: lastMonth } }, include: { closeTasks: { select: { status: true } } } });

    // QuickBooks.
    const [conn, conflicts, pending, failed, unmatched] = await Promise.all([
      prisma.qboCompanyConnection.findUnique({ where: { tenantId } }),
      prisma.qboSyncConflict.count({ where: { tenantId, status: 'OPEN' } }),
      prisma.qboOutbox.count({ where: { tenantId, status: 'PENDING' } }),
      prisma.qboOutbox.count({ where: { tenantId, status: 'FAILED' } }),
      prisma.bankTransaction.count({ where: { tenantId, status: 'UNMATCHED' } }),
    ]);

    const needsYou: BooksOverview['needsYou'] = [];
    if (awaitingApproval) needsYou.push({ key: 'bills', label: `${awaitingApproval} ${awaitingApproval === 1 ? 'bill waits' : 'bills wait'} for approval`, count: awaitingApproval, to: '/books/bills?status=PENDING_APPROVAL', tone: 'warning' });
    if (apOverdue > 0) needsYou.push({ key: 'overdue-bills', label: `${fromCents(apOverdue).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} in bills past due`, count: bills.filter((b) => ymd(b.dueDate) < asOf).length, to: '/books/bills', tone: 'alert' });
    if (unmatched) needsYou.push({ key: 'bank', label: `${unmatched} bank ${unmatched === 1 ? 'transaction' : 'transactions'} to match or categorize`, count: unmatched, to: '/books/bank', tone: 'warning' });
    if (conflicts) needsYou.push({ key: 'conflicts', label: `${conflicts} QuickBooks ${conflicts === 1 ? 'change needs' : 'changes need'} a decision`, count: conflicts, to: '/books/quickbooks', tone: 'alert' });
    if (failed) needsYou.push({ key: 'sync-failed', label: `${failed} ${failed === 1 ? 'record' : 'records'} didn’t reach QuickBooks`, count: failed, to: '/books/quickbooks', tone: 'alert' });
    // The books' receivables and the open statements should be the same money. When they aren't,
    // history hasn't been posted (a new set of books) or something failed to post — say so.
    const openOnStatements = aging.current + aging.days1to30 + aging.days31to60 + aging.days61to90 + aging.over90;
    if (Math.abs(openOnStatements - arTotal) >= 1) {
      const fmt = (c: number) => fromCents(c).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      needsYou.push({ key: 'ar-unposted', label: `Receivables in the books (${fmt(arTotal)}) don’t match open statements (${fmt(openOnStatements)}) — post history to bring them in`, count: 1, to: '/books/receivables', tone: 'warning' });
    }
    if (aging.over90 > 0) needsYou.push({ key: 'ar-90', label: `${fromCents(aging.over90).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} owed by clients for over 90 days`, count: 1, to: '/books/receivables', tone: 'alert' });
    if (period?.status !== 'CLOSED' && Number(asOf.slice(8, 10)) >= 5) needsYou.push({ key: 'close', label: `${new Date(`${lastMonth}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} isn’t closed yet`, count: 1, to: `/books/close/${lastMonth}`, tone: 'info' });

    const body: BooksOverview = {
      asOf,
      cash: { total: fromCents(cashTotal), accounts: cashAccounts },
      receivables: {
        total: fromCents(arTotal),
        aging: { current: fromCents(aging.current), days1to30: fromCents(aging.days1to30), days31to60: fromCents(aging.days31to60), days61to90: fromCents(aging.days61to90), over90: fromCents(aging.over90) },
        topClients: [...byClient.values()].sort((a, b) => b.open - a.open).slice(0, 5).map((c) => ({ ...c, open: fromCents(c.open) })),
      },
      payables: { total: fromCents(apTotal), dueIn7Days: fromCents(apDue7), overdue: fromCents(apOverdue), awaitingApproval },
      profit: { month: month.totals ?? zeroTotals, yearToDate: ytd.totals ?? zeroTotals, trend },
      close: {
        periodKey: lastMonth,
        status: period?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        closedAt: period?.closedAt?.toISOString() ?? null,
        tasksDone: period?.closeTasks.filter((t) => t.status !== 'OPEN').length ?? 0,
        tasksTotal: period?.closeTasks.length ?? 0,
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
      prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 }),
      prisma.department.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 }),
      prisma.costCenter.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, code: true }, orderBy: { code: 'asc' }, take: 2000 }),
    ]);
    const body: BooksDimensions = { clients, sites, departments, costCenters: costCenters.map((c) => ({ id: c.id, name: `${c.code} · ${c.name}` })) };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/* ---- Accounts --------------------------------------------------------------- */

async function accountRows(asOf: string): Promise<LedgerAccountRow[]> {
  const tenantId = tenantIdForWrite();
  const { byId } = await accountIndex(prisma);
  const bal = await balancesThrough(asOf);
  const used = new Set((await prisma.journalLine.groupBy({ by: ['accountId'], where: { tenantId } })).map((r) => r.accountId));
  return [...byId.values()]
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((a) => {
      const net = bal.get(a.id) ?? 0;
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

const JournalQuery = z.object({
  from: Ymd.optional(),
  to: Ymd.optional(),
  source: z.string().max(24).optional(),
  origin: z.enum(['SITE', 'QUICKBOOKS']).optional(),
  status: z.enum(['POSTED', 'VOID']).optional(),
  accountId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

booksLedgerRouter.get('/journal', async (req, res, next) => {
  try {
    const q = JournalQuery.parse(req.query);
    const tenantId = tenantIdForWrite();
    const where: Prisma.JournalEntryWhereInput = {
      tenantId,
      ...(q.from || q.to ? { entryDate: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.origin ? { origin: q.origin } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
      ...(q.q ? { OR: [{ memo: { contains: q.q, mode: 'insensitive' } }, ...(/^\d+$/.test(q.q) ? [{ number: Number(q.q) }] : [])] } : {}),
    };
    const [total, entries] = await Promise.all([
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.findMany({
        where,
        orderBy: [{ entryDate: 'desc' }, { number: 'desc' }],
        skip: q.offset,
        take: q.limit,
        include: { lines: { select: { accountId: true }, orderBy: { lineNo: 'asc' } } },
      }),
    ]);
    const { byId } = await accountIndex(prisma);
    const rows: BooksJournalRow[] = entries.map((e) => {
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
    res.json({ entries: rows, total });
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
    res.json(await profitAndLoss(prisma, from, to, dims(req.query), { columns: columnsQuery(req) }));
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/reports/balance-sheet', async (req, res, next) => {
  try {
    res.json(await balanceSheet(prisma, asOfQuery(req), dims(req.query)));
  } catch (err) {
    next(err);
  }
});

booksLedgerRouter.get('/reports/cash-flow', async (req, res, next) => {
  try {
    const { from, to } = rangeQuery(req);
    res.json(await cashFlow(prisma, from, to, dims(req.query)));
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
