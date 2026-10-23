import { Router, type Request } from 'express';
import type { QboSyncConflict } from '@prisma/client';
import {
  QboImportHistoryInputSchema,
  QboRelinkInputSchema,
  QboResolveInputSchema,
  QboSyncSettingsSchema,
  type QboConflictRow,
  type QboMappingRow,
  type QboOutboxRow,
  type QboSyncStatus,
} from '@alto-people/shared';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { requireCapability } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/error.js';
import { encryptString } from '../../lib/crypto.js';
import { enqueueAudit } from '../../lib/audit.js';
import { tenantIdForWrite } from '../../lib/tenant.js';
import { accountIndex } from '../../lib/books/ledger.js';
import {
  authorizeUrl,
  companyConnection,
  exchangeCompanyCode,
  isStubMode,
  qboClientFor,
  readSettings,
  saveCompanyConnection,
  verifyCompanyState,
  writeSettings,
} from '../../lib/books/qbo/connection.js';
import { fingerprint, linkFor, remoteFingerprint, saveLink } from '../../lib/books/qbo/links.js';
import { initialLink } from '../../lib/books/qbo/mapping.js';
import { enqueue, registerOutboxListener, retryOutbox } from '../../lib/books/qbo/outbox.js';
import { pushCtx, siteVersion } from '../../lib/books/qbo/push.js';
import { resolveConflict } from '../../lib/books/qbo/resolve.js';
import { importHistory, runSync, syncCounts } from '../../lib/books/qbo/sync.js';
import { webhookVerifier } from '../../lib/books/qbo/webhook.js';
import type { QboEntity } from '../../lib/books/qbo/types.js';

/**
 * /books/quickbooks — the company's own QuickBooks Online, kept in step both
 * ways (lib/books/qbo). The contract is packages/shared/src/books/quickbooks.ts.
 * Reading needs view:books (the books router); every change manage:books.
 */

// Site changes start queueing for QuickBooks once this module is loaded.
registerOutboxListener();

export const booksQuickbooksRouter = Router();
const MANAGE = requireCapability('manage:books');

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

async function connectedClient() {
  const conn = await companyConnection(prisma);
  if (!conn || conn.status === 'DISCONNECTED') throw new HttpError(409, 'quickbooks_not_connected', 'Connect QuickBooks first.');
  return { conn, qbo: qboClientFor(prisma, conn) };
}

/* ---- Status and connection ----------------------------------------------- */

booksQuickbooksRouter.get('/status', async (_req, res, next) => {
  try {
    const conn = await companyConnection(prisma);
    const [counts, linked, settings] = await Promise.all([
      syncCounts(prisma),
      prisma.qboSyncLink.count({ where: { tenantId: tenantIdForWrite(), deletedAt: null } }),
      readSettings(prisma),
    ]);
    const body: QboSyncStatus = {
      connection:
        conn && conn.status !== 'DISCONNECTED'
          ? {
              realmId: conn.realmId,
              companyName: conn.companyName,
              status: conn.status as 'CONNECTED' | 'NEEDS_RECONNECT' | 'PAUSED',
              connectedAt: conn.createdAt.toISOString(),
              lastPushAt: iso(conn.lastPushAt),
              lastPullAt: iso(conn.lastPullAt),
              pulledThrough: iso(conn.pulledThrough),
              lastError: conn.lastError,
              qboClosingDate: ymd(conn.qboClosingDate),
            }
          : null,
      counts: { ...counts, linked },
      sandboxOnly: isStubMode(),
      webhooksOn: !!webhookVerifier(),
      settings,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.get('/connect', MANAGE, (req, res) => {
  res.json({ authorizeUrl: authorizeUrl(tenantIdForWrite(), req.user!.id) });
});

/** Intuit sends the person back here (signed in) with the code. */
booksQuickbooksRouter.get('/callback', async (req, res) => {
  const back = (q: string) => res.redirect(`/books/quickbooks?${q}`);
  try {
    const q = z.object({ code: z.string().min(1), state: z.string().min(1), realmId: z.string().min(1).max(40) }).parse(req.query);
    const who = verifyCompanyState(q.state);
    if (!who || who.tenantId !== tenantIdForWrite() || who.userId !== req.user!.id) return back('error=state');
    const tokens = await exchangeCompanyCode(q.code);
    const conn = await saveCompanyConnection(prisma, { realmId: q.realmId, tokens, userId: req.user!.id });
    const qbo = qboClientFor(prisma, conn);
    const info = await qbo.companyInfo();
    await prisma.qboCompanyConnection.update({ where: { id: conn.id }, data: { companyName: info.companyName, qboClosingDate: info.bookCloseDate ? new Date(`${info.bookCloseDate}T00:00:00.000Z`) : null } });
    await initialLink(await pushCtx(prisma, qbo, info.bookCloseDate));
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.connected', entityType: 'QboCompanyConnection', entityId: conn.id, metadata: { realmId: q.realmId, companyName: info.companyName } }, 'books.quickbooks');
    return back('connected=1');
  } catch (err) {
    console.error('[books] QuickBooks connect failed', err);
    return back('error=connect');
  }
});

booksQuickbooksRouter.post('/disconnect', MANAGE, async (req, res, next) => {
  try {
    const conn = await companyConnection(prisma);
    if (!conn) throw new HttpError(404, 'quickbooks_not_connected', 'QuickBooks isn’t connected.');
    await prisma.qboCompanyConnection.update({ where: { id: conn.id }, data: { status: 'DISCONNECTED', accessTokenEnc: encryptString(''), refreshTokenEnc: encryptString(''), expiresAt: new Date(0) } });
    await prisma.qboOutbox.deleteMany({ where: { tenantId: tenantIdForWrite(), status: 'PENDING' } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.disconnected', entityType: 'QboCompanyConnection', entityId: conn.id, metadata: { realmId: conn.realmId } }, 'books.quickbooks');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

for (const [path, status] of [
  ['/pause', 'PAUSED'],
  ['/resume', 'CONNECTED'],
] as const) {
  booksQuickbooksRouter.post(path, MANAGE, async (req, res, next) => {
    try {
      const conn = await companyConnection(prisma);
      if (!conn || conn.status === 'DISCONNECTED') throw new HttpError(404, 'quickbooks_not_connected', 'QuickBooks isn’t connected.');
      if (status === 'CONNECTED' && conn.status === 'NEEDS_RECONNECT') throw new HttpError(409, 'quickbooks_reconnect_required', 'QuickBooks needs to be reconnected, not resumed.');
      await prisma.qboCompanyConnection.update({ where: { id: conn.id }, data: { status } });
      enqueueAudit({ actorUserId: req.user!.id, action: `books.quickbooks.${status === 'PAUSED' ? 'paused' : 'resumed'}`, entityType: 'QboCompanyConnection', entityId: conn.id, metadata: {} }, 'books.quickbooks');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

booksQuickbooksRouter.post('/sync-now', MANAGE, async (_req, res, next) => {
  try {
    const conn = await companyConnection(prisma);
    if (!conn || conn.status !== 'CONNECTED') throw new HttpError(409, 'quickbooks_not_connected', conn?.status === 'PAUSED' ? 'The sync is paused. Resume it first.' : 'Connect QuickBooks first.');
    res.json(await runSync(prisma));
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.post('/link', MANAGE, async (_req, res, next) => {
  try {
    const { conn, qbo } = await connectedClient();
    res.json(await initialLink(await pushCtx(prisma, qbo, conn.qboClosingDate ? ymd(conn.qboClosingDate) : null)));
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.post('/import-history', MANAGE, async (req, res, next) => {
  try {
    const { since } = QboImportHistoryInputSchema.parse(req.body);
    const out = await importHistory(prisma, since);
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.history_imported', entityType: 'QboCompanyConnection', entityId: (await companyConnection(prisma))!.id, metadata: { since, ...out } }, 'books.quickbooks');
    res.json(out);
  } catch (err) {
    next(err);
  }
});

/* ---- What a local record is called, and where it lives -------------------- */

async function describeLocal(localType: string, localId: string): Promise<{ label: string; link: string | null }> {
  const tenantId = tenantIdForWrite();
  switch (localType) {
    case 'LedgerAccount': {
      const a = await prisma.ledgerAccount.findFirst({ where: { id: localId, tenantId }, select: { code: true, name: true } });
      return { label: a ? `Account ${a.code} ${a.name}` : 'An account', link: `/books/accounts/${localId}` };
    }
    case 'Vendor': {
      const v = await prisma.vendor.findFirst({ where: { id: localId, tenantId }, select: { name: true } });
      return { label: v ? `Vendor ${v.name}` : 'A vendor', link: `/books/vendors/${localId}` };
    }
    case 'Client': {
      const c = await prisma.client.findFirst({ where: { id: localId, tenantId }, select: { name: true } });
      return { label: c ? `Customer ${c.name}` : 'A client', link: `/clients/${localId}` };
    }
    case 'JournalEntry': {
      const e = await prisma.journalEntry.findFirst({ where: { id: localId, tenantId }, select: { number: true, memo: true } });
      return { label: e ? `Journal entry #${e.number}${e.memo ? ` — ${e.memo.slice(0, 60)}` : ''}` : 'A journal entry', link: e ? `/books/journal/${localId}` : null };
    }
    case 'Bill': {
      const b = await prisma.bill.findFirst({ where: { id: localId, tenantId }, select: { billNumber: true, total: true, vendor: { select: { name: true } } } });
      return { label: b ? `Bill${b.billNumber ? ` ${b.billNumber}` : ''} — ${b.vendor.name}, $${Number(b.total).toFixed(2)}` : 'A bill', link: `/books/bills/${localId}` };
    }
    case 'BillPayment': {
      const p = await prisma.billPayment.findFirst({ where: { id: localId, tenantId }, select: { amount: true, vendor: { select: { name: true } } } });
      return { label: p ? `Payment to ${p.vendor.name}, $${Number(p.amount).toFixed(2)}` : 'A bill payment', link: '/books/bills' };
    }
    case 'ClientStatement': {
      const s = await prisma.clientStatement.findFirst({ where: { id: localId, tenantId }, select: { number: true, client: { select: { name: true } } } });
      return { label: s ? `Statement${s.number ? ` ${String(s.number).padStart(4, '0')}` : ''} — ${s.client.name}` : 'A statement', link: '/books/receivables' };
    }
    case 'ClientPayment': {
      const p = await prisma.clientPayment.findFirst({ where: { id: localId, tenantId }, select: { amount: true, clientId: true } });
      const c = p ? await prisma.client.findFirst({ where: { id: p.clientId, tenantId }, select: { name: true } }) : null;
      return { label: p ? `Payment from ${c?.name ?? 'a client'}, $${Number(p.amount).toFixed(2)}` : 'A client payment', link: '/books/receivables' };
    }
  }
  return { label: localType, link: null };
}

/* ---- Outbox and history ------------------------------------------------- */

booksQuickbooksRouter.get('/outbox', async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']).optional() }).parse(req.query);
    const rows = await prisma.qboOutbox.findMany({ where: { tenantId: tenantIdForWrite(), ...(q.status ? { status: q.status } : { status: { in: ['PENDING', 'FAILED'] } }) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const out: QboOutboxRow[] = [];
    for (const r of rows) {
      const d = await describeLocal(r.localType, r.localId);
      out.push({ id: r.id, localType: r.localType, localId: r.localId, label: d.label, link: d.link, op: r.op as 'UPSERT' | 'DELETE', status: r.status as QboOutboxRow['status'], attempts: r.attempts, nextAttemptAt: r.nextAttemptAt.toISOString(), lastError: r.lastError, createdAt: r.createdAt.toISOString() });
    }
    res.json({ rows: out });
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.post('/outbox/retry-failed', MANAGE, async (_req, res, next) => {
  try {
    const r = await prisma.qboOutbox.updateMany({ where: { tenantId: tenantIdForWrite(), status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    res.json({ retried: r.count });
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.post('/outbox/:id/retry', MANAGE, async (req, res, next) => {
  try {
    const row = await retryOutbox(prisma, z.string().uuid().parse(req.params.id));
    if (!row) throw new HttpError(404, 'not_found', 'Nothing waiting with that id.');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Send one site record to QuickBooks again (queued for the next run). */
booksQuickbooksRouter.post('/resend', MANAGE, async (req, res, next) => {
  try {
    const body = z.object({ localType: z.enum(['LedgerAccount', 'Vendor', 'Client', 'JournalEntry', 'Bill', 'BillPayment', 'ClientStatement', 'ClientPayment']), localId: z.string().uuid() }).parse(req.body);
    await enqueue(prisma, body.localType, body.localId, 'UPSERT');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.get('/events', async (req, res, next) => {
  try {
    const q = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), result: z.enum(['OK', 'ERROR', 'CONFLICT', 'SKIPPED']).optional() }).parse(req.query);
    const rows = await prisma.qboSyncEvent.findMany({
      where: { tenantId: tenantIdForWrite(), ...(q.result ? { result: q.result } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, q.limit);
    res.json({
      events: page.map((e) => ({ id: e.id, direction: e.direction, result: e.result, localType: e.localType, localId: e.localId, qboType: e.qboType, qboId: e.qboId, message: e.message, createdAt: e.createdAt.toISOString() })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    });
  } catch (err) {
    next(err);
  }
});

/* ---- Conflicts ----------------------------------------------------------- */

const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const money = (v: unknown) => (v === null || v === undefined ? null : `$${Number(v).toFixed(2)}`);

/** Each side, field by field, in words. */
function conflictFields(localType: string, site: Record<string, unknown>, e: QboEntity | null): QboConflictRow['fields'] {
  const rows: Array<[string, string | null, string | null]> = [];
  if (localType === 'LedgerAccount') {
    rows.push(['Name', s(site.name), s(e?.Name)], ['Number', s(site.code), s(e?.AcctNum)], ['Active', site.active === false ? 'No' : 'Yes', e ? (e.Active === false ? 'No' : 'Yes') : null]);
  } else if (localType === 'Vendor') {
    rows.push(
      ['Name', s(site.name), s(e?.DisplayName)],
      ['Email', s(site.email), s((e?.PrimaryEmailAddr as { Address?: string } | undefined)?.Address)],
      ['Gets a 1099', site.is1099 ? 'Yes' : 'No', e ? (e.Vendor1099 ? 'Yes' : 'No') : null],
      ['Active', site.active === false ? 'No' : 'Yes', e ? (e.Active === false ? 'No' : 'Yes') : null],
    );
  } else {
    const lines = (site.lines as Array<{ d?: number; amt?: number }> | undefined) ?? [];
    const siteTotal = site.total ?? site.amount ?? (lines.length ? lines.reduce((n, l) => n + Number(l.d ?? l.amt ?? 0), 0) : null);
    const qboLines = ((e?.Line as unknown[] | undefined) ?? []).length;
    rows.push(
      ['Date', s(site.date), s(e?.TxnDate)],
      ['Amount', money(siteTotal), e ? money(e.TotalAmt ?? (localType === 'JournalEntry' ? ((e.Line as Array<{ Amount?: number; JournalEntryLineDetail?: { PostingType?: string } }> | undefined) ?? []).filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((n, l) => n + Number(l.Amount ?? 0), 0) : null)) : null],
      ['Lines', lines.length ? String(lines.length) : null, e ? String(qboLines) : null],
      ['Note', s(site.memo), s(e?.PrivateNote)],
    );
  }
  return rows.filter(([, a, b]) => a !== null || b !== null).map(([label, a, b]) => ({ label, site: a, quickbooks: b, differs: a !== b }));
}

async function conflictRow(c: QboSyncConflict): Promise<QboConflictRow> {
  const q = c.qboVersion as { type?: string; id?: string; entity?: QboEntity | null; reason?: string };
  const reason = (q.reason === 'DELETED_IN_QUICKBOOKS' || q.reason === 'SITE_PERIOD_CLOSED' || q.reason === 'BOOKS_CLOSED' ? q.reason : 'BOTH_CHANGED') as QboConflictRow['reason'];
  const by = c.resolvedById ? await prisma.user.findFirst({ where: { id: c.resolvedById }, select: { email: true, displayName: true } }) : null;
  const d = await describeLocal(c.localType, c.localId);
  return {
    id: c.id,
    localType: c.localType,
    localId: c.localId,
    summary: c.summary,
    reason,
    fields: conflictFields(c.localType, (c.siteVersion ?? {}) as Record<string, unknown>, q.entity ?? null),
    qboType: q.type ?? '',
    qboId: q.id ?? '',
    status: c.status as QboConflictRow['status'],
    resolvedByName: by ? (by.displayName ?? by.email) : null,
    resolvedAt: iso(c.resolvedAt),
    createdAt: c.createdAt.toISOString(),
    link: reason === 'SITE_PERIOD_CLOSED' && c.localType === 'JournalEntry' && !(await prisma.journalEntry.findFirst({ where: { id: c.localId, tenantId: tenantIdForWrite() }, select: { id: true } })) ? null : d.link,
  };
}

booksQuickbooksRouter.get('/conflicts', async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(['OPEN', 'KEPT_SITE', 'KEPT_QUICKBOOKS', 'DISMISSED', 'ALL']).default('OPEN') }).parse(req.query);
    const rows = await prisma.qboSyncConflict.findMany({ where: { tenantId: tenantIdForWrite(), ...(q.status === 'ALL' ? {} : { status: q.status }) }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ conflicts: await Promise.all(rows.map(conflictRow)) });
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.post('/conflicts/:id/resolve', MANAGE, async (req: Request, res, next) => {
  try {
    const { keep } = QboResolveInputSchema.parse(req.body);
    const done = await resolveConflict(prisma, z.string().uuid().parse(req.params.id), keep, req.user!.id);
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.conflict_resolved', entityType: 'QboSyncConflict', entityId: done.id, metadata: { keep, localType: done.localType, localId: done.localId, summary: `Kept ${keep === 'SITE' ? 'the version here' : keep === 'QUICKBOOKS' ? 'QuickBooks' : 'both as they are'}: ${done.summary}` } }, 'books.quickbooks');
    res.json(await conflictRow(done));
  } catch (err) {
    next(err);
  }
});

/* ---- Mapping ------------------------------------------------------------- */

booksQuickbooksRouter.get('/mappings', async (req, res, next) => {
  try {
    const { kind } = z.object({ kind: z.enum(['accounts', 'vendors', 'customers']).default('accounts') }).parse(req.query);
    const tenantId = tenantIdForWrite();
    const conn = await companyConnection(prisma);
    const qbo = conn && conn.status === 'CONNECTED' ? qboClientFor(prisma, conn) : null;
    const localType = kind === 'accounts' ? 'LedgerAccount' : kind === 'vendors' ? 'Vendor' : 'Client';
    const qboType = kind === 'accounts' ? 'Account' : kind === 'vendors' ? 'Vendor' : 'Customer';
    const links = new Map((await prisma.qboSyncLink.findMany({ where: { tenantId, localType, deletedAt: null } })).map((l) => [l.localId, l]));
    const names = new Map<string, string>();
    if (qbo) {
      try {
        for (const e of await qbo.query(qboType, 'Active IN (true,false)')) names.set(e.Id, String(kind === 'accounts' ? `${e.AcctNum ? `${e.AcctNum} ` : ''}${e.Name}` : e.DisplayName));
      } catch {
        /* the names are a nicety; the links stand on their own */
      }
    }
    let locals: Array<{ id: string; name: string; detail: string | null }> = [];
    if (kind === 'accounts') {
      const { byId } = await accountIndex(prisma);
      locals = [...byId.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).map((a) => ({ id: a.id, name: `${a.code} ${a.name}`, detail: a.isActive ? a.type.charAt(0) + a.type.slice(1).toLowerCase() : 'Inactive' }));
    } else if (kind === 'vendors') {
      locals = (await prisma.vendor.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, is1099: true } })).map((v) => ({ id: v.id, name: v.name, detail: v.is1099 ? 'Gets a 1099' : null }));
    } else {
      locals = (await prisma.client.findMany({ where: { tenantId, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } })).map((c) => ({ id: c.id, name: c.name, detail: null }));
    }
    const rows: QboMappingRow[] = locals.map((l) => {
      const link = links.get(l.id);
      return { localId: l.id, siteName: l.name, siteDetail: l.detail, qboId: link?.qboId ?? null, qboName: link ? (names.get(link.qboId) ?? null) : null, owner: (link?.owner as 'SITE' | 'QUICKBOOKS' | undefined) ?? null, lastSyncedAt: iso(link?.lastSyncedAt) };
    });
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.get('/qbo-accounts', async (_req, res, next) => {
  try {
    const { qbo } = await connectedClient();
    const accounts = (await qbo.query('Account', 'Active IN (true,false)')).map((e) => ({ id: e.Id, name: String(e.Name), number: (e.AcctNum as string | undefined) ?? null, type: String(e.AccountType ?? ''), active: e.Active !== false }));
    accounts.sort((a, b) => (a.number ?? a.name).localeCompare(b.number ?? b.name, undefined, { numeric: true }));
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

/** Point a site account at a different QuickBooks account. */
booksQuickbooksRouter.put('/mappings/accounts/:accountId', MANAGE, async (req, res, next) => {
  try {
    const accountId = z.string().uuid().parse(req.params.accountId);
    const { qboId } = QboRelinkInputSchema.parse(req.body);
    const { qbo } = await connectedClient();
    const e = await qbo.get('Account', qboId);
    if (!e) throw new HttpError(404, 'qbo_account_not_found', 'QuickBooks has no account with that id.');
    const sv = await siteVersion(prisma, 'LedgerAccount', accountId);
    if (!sv) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
    const before = await linkFor(prisma, 'LedgerAccount', accountId);
    await saveLink(prisma, { localType: 'LedgerAccount', localId: accountId, qboType: 'Account', qboId, syncToken: e.SyncToken ?? null, owner: (before?.owner as 'SITE' | 'QUICKBOOKS' | undefined) ?? 'SITE', localHash: fingerprint(sv.payload), remoteHash: remoteFingerprint('Account', e) });
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.account_relinked', entityType: 'LedgerAccount', entityId: accountId, metadata: { from: before?.qboId ?? null, to: qboId, summary: `${sv.payload.code} ${sv.payload.name} now posts to QuickBooks account ${e.Name}` } }, 'books.quickbooks');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---- Settings ------------------------------------------------------------ */

booksQuickbooksRouter.get('/settings', async (_req, res, next) => {
  try {
    res.json(await readSettings(prisma));
  } catch (err) {
    next(err);
  }
});

booksQuickbooksRouter.put('/settings', MANAGE, async (req, res, next) => {
  try {
    const input = QboSyncSettingsSchema.partial().parse(req.body);
    const out = await writeSettings(prisma, input);
    enqueueAudit({ actorUserId: req.user!.id, action: 'books.quickbooks.settings', entityType: 'QboCompanyConnection', entityId: (await companyConnection(prisma))?.id ?? tenantIdForWrite(), metadata: { ...out, summary: `QuickBooks class: ${out.classMode.toLowerCase()}, location: ${out.locationMode.toLowerCase()}` } }, 'books.quickbooks');
    res.json(out);
  } catch (err) {
    next(err);
  }
});

