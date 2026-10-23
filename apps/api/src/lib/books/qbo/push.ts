import type { PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import { accountByKey } from '../ledger.js';
import { logEvent, readSettings, type QboSyncSettings } from './connection.js';
import { raiseConflict } from './conflicts.js';
import { fingerprint, linkFor, qboAccountType, remoteFingerprint, saveLink } from './links.js';
import { QboError, type QboClient, type QboEntity, type QboType } from './types.js';

/**
 * Site → QuickBooks. One function per kind of record turns the site's
 * version into QuickBooks' JSON (resolving every reference — an account, a
 * vendor, a customer, a class, a location — and pushing it first if
 * QuickBooks doesn't have it yet), then creates or updates it.
 *
 * Before overwriting, QuickBooks' current version is compared with what was
 * last agreed: if the accountant changed it there since, the push stops and
 * a conflict asks a person (unless the person already chose "keep site").
 * A transaction dated on or before QuickBooks' books-closing date is not
 * pushed: it's skipped with a conflict that says why.
 */

export type LocalType = 'LedgerAccount' | 'Vendor' | 'Client' | 'JournalEntry' | 'Bill' | 'BillPayment' | 'ClientStatement' | 'ClientPayment';

export interface PushCtx {
  db: PrismaClient;
  qbo: QboClient;
  settings: QboSyncSettings;
  bookCloseDate: string | null;
  /** A person chose "keep site": overwrite QuickBooks' newer version. */
  force?: boolean;
}

export type PushOutcome = { result: 'OK' | 'SKIPPED' | 'CONFLICT'; message: string; qboId?: string };

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

export const QBO_TYPE: Record<LocalType, QboType> = {
  LedgerAccount: 'Account',
  Vendor: 'Vendor',
  Client: 'Customer',
  JournalEntry: 'JournalEntry',
  Bill: 'Bill',
  BillPayment: 'BillPayment',
  ClientStatement: 'Invoice',
  ClientPayment: 'Payment',
};

/** Journal entries these sources make sync as their own QuickBooks objects (the bill, the invoice …), not as journal entries. */
export const SOURCES_SYNCED_AS_OBJECTS = new Set(['BILL', 'BILL_PAYMENT', 'STATEMENT', 'CLIENT_PAYMENT']);

/* ---- The site's versions -------------------------------------------------- */

/** The synced fields of a site record — its fingerprint is the link's localHash. Null when it no longer exists. */
export async function siteVersion(db: PrismaClient, localType: string, localId: string): Promise<{ payload: Record<string, unknown>; gone: boolean; date: string | null } | null> {
  const tenantId = tenantIdForWrite();
  switch (localType) {
    case 'LedgerAccount': {
      const a = await db.ledgerAccount.findFirst({ where: { id: localId, tenantId } });
      if (!a) return null;
      return { payload: { code: a.code, name: a.name, type: a.type, subtype: a.subtype, active: a.isActive, description: a.description ?? null }, gone: false, date: null };
    }
    case 'Vendor': {
      const v = await db.vendor.findFirst({ where: { id: localId, tenantId } });
      if (!v) return null;
      return {
        payload: { name: v.name, email: v.email, phone: v.phone, line1: v.addressLine1, line2: v.addressLine2, city: v.city, state: v.state, zip: v.zip, is1099: v.is1099, active: v.isActive && !v.deletedAt },
        gone: false,
        date: null,
      };
    }
    case 'Client': {
      const c = await db.client.findFirst({ where: { id: localId, tenantId }, select: { name: true } });
      if (!c) return null;
      return { payload: { name: c.name }, gone: false, date: null };
    }
    case 'JournalEntry': {
      const e = await db.journalEntry.findFirst({ where: { id: localId, tenantId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!e) return null;
      return {
        payload: {
          number: e.number,
          date: ymd(e.entryDate),
          memo: e.memo,
          status: e.status,
          lines: e.lines.map((l) => ({ acct: l.accountId, d: money(l.debit), c: money(l.credit), client: l.clientId, site: l.siteId, dept: l.departmentId, vendor: l.vendorId, memo: l.memo })),
        },
        gone: e.status === 'VOID',
        date: ymd(e.entryDate),
      };
    }
    case 'Bill': {
      const b = await db.bill.findFirst({ where: { id: localId, tenantId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      if (!b) return null;
      return {
        payload: {
          vendor: b.vendorId,
          number: b.billNumber,
          date: ymd(b.billDate),
          due: ymd(b.dueDate),
          status: b.status,
          total: money(b.total),
          memo: b.memo,
          lines: b.lines.map((l) => ({ acct: l.accountId, amt: money(l.amount), desc: l.description, client: l.clientId, site: l.siteId, dept: l.departmentId })),
        },
        gone: b.status === 'VOID',
        date: ymd(b.billDate),
      };
    }
    case 'BillPayment': {
      const p = await db.billPayment.findFirst({ where: { id: localId, tenantId }, include: { applications: true } });
      if (!p) return null;
      return {
        payload: { vendor: p.vendorId, date: ymd(p.paidOn), method: p.method, amount: money(p.amount), bank: p.bankAccountId, ref: p.reference, check: p.checkNumber, status: p.status, apps: p.applications.map((a) => ({ bill: a.billId, amt: money(a.amount) })) },
        gone: p.status === 'VOID' || !!p.voidedAt,
        date: ymd(p.paidOn),
      };
    }
    case 'ClientStatement': {
      const s = await db.clientStatement.findFirst({ where: { id: localId, tenantId } });
      if (!s) return null;
      const totals = ((s.snapshot as { totals?: { amount?: number; adjustmentsAmount?: number } } | null)?.totals ?? {}) as { amount?: number; adjustmentsAmount?: number };
      const date = ymd(s.finalizedAt) ?? ymd(s.periodEnd);
      return {
        payload: { client: s.clientId, number: s.number, status: s.status, date, due: ymd(s.dueAt), period: `${ymd(s.periodStart)}..${ymd(s.periodEnd)}`, total: money(totals.amount), adjustments: money(totals.adjustmentsAmount) },
        gone: s.status !== 'FINAL',
        date,
      };
    }
    case 'ClientPayment': {
      const p = await db.clientPayment.findFirst({ where: { id: localId, tenantId }, include: { applications: true } });
      if (!p) return null;
      return {
        payload: { client: p.clientId, date: ymd(p.receivedOn), amount: money(p.amount), method: p.method, ref: p.reference, deposit: p.depositAccountId, apps: p.applications.map((a) => ({ stmt: a.statementId, amt: money(a.amount) })) },
        gone: !!p.voidedAt,
        date: ymd(p.receivedOn),
      };
    }
  }
  return null;
}

/* ---- References: push what QuickBooks needs first ------------------------ */

async function refFor(ctx: PushCtx, localType: LocalType, localId: string): Promise<string> {
  const link = await linkFor(ctx.db, localType, localId);
  if (link) return link.qboId;
  const out = await pushRecord({ ...ctx, force: false }, localType, localId);
  if (!out.qboId) throw new QboError(`${localType} ${localId} couldn’t be sent first: ${out.message}`, 400);
  return out.qboId;
}

/** A QuickBooks Class or Location (Department) by name, made if missing, remembered on the link. */
async function namedRef(ctx: PushCtx, localType: 'ClientClass' | 'DepartmentClass' | 'Site', localId: string, qboType: 'Class' | 'Department', name: string): Promise<string> {
  const link = await linkFor(ctx.db, localType, localId);
  if (link) return link.qboId;
  const found = (await ctx.qbo.query(qboType, `Name = '${name.replace(/'/g, "\\'")}'`))[0];
  const e = found ?? (await ctx.qbo.create(qboType, { Name: name }));
  await saveLink(ctx.db, { localType, localId, qboType, qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'SITE', remoteHash: remoteFingerprint(qboType, e) });
  return e.Id;
}

/** The dimension refs a line carries: Class and Location per the settings. */
async function dims(ctx: PushCtx, l: { clientId?: string | null; departmentId?: string | null; siteId?: string | null }): Promise<Record<string, unknown>> {
  const tenantId = tenantIdForWrite();
  const out: Record<string, unknown> = {};
  if (ctx.settings.classMode === 'CLIENT' && l.clientId) {
    const c = await ctx.db.client.findFirst({ where: { id: l.clientId, tenantId }, select: { name: true } });
    if (c) out.ClassRef = { value: await namedRef(ctx, 'ClientClass', l.clientId, 'Class', c.name) };
  } else if (ctx.settings.classMode === 'DEPARTMENT' && l.departmentId) {
    const d = await ctx.db.department.findFirst({ where: { id: l.departmentId, tenantId }, select: { name: true } });
    if (d) out.ClassRef = { value: await namedRef(ctx, 'DepartmentClass', l.departmentId, 'Class', d.name) };
  }
  if (ctx.settings.locationMode === 'SITE' && l.siteId) {
    const s = await ctx.db.site.findFirst({ where: { id: l.siteId, tenantId }, select: { name: true } });
    if (s) out.DepartmentRef = { value: await namedRef(ctx, 'Site', l.siteId, 'Department', s.name) };
  }
  return out;
}

/** A service item that sells into an income account (invoices need one per line). */
async function itemRef(ctx: PushCtx, incomeKey: 'REVENUE_STAFFING' | 'REVENUE_ADJUSTMENTS', name: string): Promise<string> {
  const account = await accountByKey(ctx.db, incomeKey);
  const link = await linkFor(ctx.db, 'Item', account.id);
  if (link) return link.qboId;
  const found = (await ctx.qbo.query('Item', `Name = '${name}'`))[0];
  const e = found ?? (await ctx.qbo.create('Item', { Name: name, Type: 'Service', IncomeAccountRef: { value: await refFor(ctx, 'LedgerAccount', account.id) } }));
  await saveLink(ctx.db, { localType: 'Item', localId: account.id, qboType: 'Item', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'SITE', remoteHash: remoteFingerprint('Item', e) });
  return e.Id;
}

/* ---- QuickBooks bodies --------------------------------------------------- */

async function body(ctx: PushCtx, localType: LocalType, v: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const tenantId = tenantIdForWrite();
  switch (localType) {
    case 'LedgerAccount': {
      const t = qboAccountType(String(v.type), String(v.subtype));
      return { Name: v.name, AcctNum: v.code, ...t, Active: v.active, ...(v.description ? { Description: v.description } : {}) };
    }
    case 'Vendor':
      return {
        DisplayName: v.name,
        ...(v.email ? { PrimaryEmailAddr: { Address: v.email } } : {}),
        ...(v.phone ? { PrimaryPhone: { FreeFormNumber: v.phone } } : {}),
        ...(v.line1 ? { BillAddr: { Line1: v.line1, Line2: v.line2 ?? undefined, City: v.city ?? undefined, CountrySubDivisionCode: v.state ?? undefined, PostalCode: v.zip ?? undefined } } : {}),
        Vendor1099: !!v.is1099,
        Active: v.active,
      };
    case 'Client':
      return { DisplayName: v.name };
    case 'JournalEntry': {
      const lines = v.lines as Array<{ acct: string; d: number; c: number; client: string | null; site: string | null; dept: string | null; vendor: string | null; memo: string | null }>;
      const out = [];
      for (const l of lines) {
        const entity = l.vendor ? { Type: 'Vendor', EntityRef: { value: await refFor(ctx, 'Vendor', l.vendor) } } : l.client ? { Type: 'Customer', EntityRef: { value: await refFor(ctx, 'Client', l.client) } } : undefined;
        out.push({
          Amount: l.d > 0 ? l.d : l.c,
          DetailType: 'JournalEntryLineDetail',
          ...(l.memo ? { Description: l.memo } : {}),
          JournalEntryLineDetail: {
            PostingType: l.d > 0 ? 'Debit' : 'Credit',
            AccountRef: { value: await refFor(ctx, 'LedgerAccount', l.acct) },
            ...(entity ? { Entity: entity } : {}),
            ...(await dims(ctx, { clientId: l.client, departmentId: l.dept, siteId: l.site })),
          },
        });
      }
      return { TxnDate: v.date, DocNumber: `AH-${v.number}`, ...(v.memo ? { PrivateNote: String(v.memo).slice(0, 4000) } : {}), Line: out };
    }
    case 'Bill': {
      const lines = v.lines as Array<{ acct: string; amt: number; desc: string | null; client: string | null; site: string | null; dept: string | null }>;
      const out = [];
      let location: unknown;
      for (const l of lines) {
        const d = await dims(ctx, { clientId: l.client, departmentId: l.dept, siteId: l.site });
        location ??= d.DepartmentRef;
        out.push({
          Amount: l.amt,
          DetailType: 'AccountBasedExpenseLineDetail',
          ...(l.desc ? { Description: l.desc } : {}),
          AccountBasedExpenseLineDetail: { AccountRef: { value: await refFor(ctx, 'LedgerAccount', l.acct) }, ...(d.ClassRef ? { ClassRef: d.ClassRef } : {}) },
        });
      }
      const ap = await accountByKey(ctx.db, 'AP');
      return {
        VendorRef: { value: await refFor(ctx, 'Vendor', String(v.vendor)) },
        APAccountRef: { value: await refFor(ctx, 'LedgerAccount', ap.id) },
        TxnDate: v.date,
        DueDate: v.due,
        ...(v.number ? { DocNumber: String(v.number).slice(0, 21) } : {}),
        ...(v.memo ? { PrivateNote: v.memo } : {}),
        ...(location ? { DepartmentRef: location } : {}),
        Line: out,
      };
    }
    case 'BillPayment': {
      const apps = v.apps as Array<{ bill: string; amt: number }>;
      const bank = await ctx.db.ledgerAccount.findFirst({ where: { id: String(v.bank), tenantId } });
      const bankRef = { value: await refFor(ctx, 'LedgerAccount', String(v.bank)) };
      const card = v.method === 'CARD' || bank?.subtype === 'CREDIT_CARD';
      const line = [];
      for (const a of apps) line.push({ Amount: a.amt, LinkedTxn: [{ TxnId: await refFor(ctx, 'Bill', a.bill), TxnType: 'Bill' }] });
      return {
        VendorRef: { value: await refFor(ctx, 'Vendor', String(v.vendor)) },
        PayType: card ? 'CreditCard' : 'Check',
        ...(card ? { CreditCardPayment: { CCAccountRef: bankRef } } : { CheckPayment: { BankAccountRef: bankRef } }),
        TotalAmt: v.amount,
        TxnDate: v.date,
        ...(v.check ? { DocNumber: String(v.check) } : v.ref ? { DocNumber: String(v.ref).slice(0, 21) } : {}),
        Line: line,
      };
    }
    case 'ClientStatement': {
      const total = Number(v.total ?? 0);
      const adj = Number(v.adjustments ?? 0);
      const services = Math.round((total - adj) * 100) / 100;
      const d = await dims(ctx, { clientId: String(v.client) });
      const line = [
        { Amount: services, DetailType: 'SalesItemLineDetail', Description: `Staffing services ${String(v.period).replace('..', ' – ')}`, SalesItemLineDetail: { ItemRef: { value: await itemRef(ctx, 'REVENUE_STAFFING', 'Staffing services') }, Qty: 1, UnitPrice: services, ...(d.ClassRef ? { ClassRef: d.ClassRef } : {}) } },
      ];
      if (adj !== 0) line.push({ Amount: adj, DetailType: 'SalesItemLineDetail', Description: 'Billing adjustments', SalesItemLineDetail: { ItemRef: { value: await itemRef(ctx, 'REVENUE_ADJUSTMENTS', 'Billing adjustments') }, Qty: 1, UnitPrice: adj, ...(d.ClassRef ? { ClassRef: d.ClassRef } : {}) } });
      return {
        CustomerRef: { value: await refFor(ctx, 'Client', String(v.client)) },
        TxnDate: v.date,
        ...(v.due ? { DueDate: v.due } : {}),
        ...(v.number ? { DocNumber: String(v.number).padStart(4, '0') } : {}),
        PrivateNote: `Statement for ${String(v.period).replace('..', ' – ')}`,
        Line: line,
      };
    }
    case 'ClientPayment': {
      const apps = v.apps as Array<{ stmt: string; amt: number }>;
      const line = [];
      for (const a of apps) line.push({ Amount: a.amt, LinkedTxn: [{ TxnId: await refFor(ctx, 'ClientStatement', a.stmt), TxnType: 'Invoice' }] });
      return {
        CustomerRef: { value: await refFor(ctx, 'Client', String(v.client)) },
        TotalAmt: v.amount,
        TxnDate: v.date,
        ...(v.ref ? { PaymentRefNum: String(v.ref).slice(0, 21) } : {}),
        DepositToAccountRef: { value: await refFor(ctx, 'LedgerAccount', String(v.deposit)) },
        Line: line,
      };
    }
  }
}

/* ---- Push one record ----------------------------------------------------- */

/** Not sent at all: a draft bill, a draft statement, a journal entry that syncs as its own object. */
async function notForQuickbooks(ctx: PushCtx, localType: LocalType, localId: string, v: Record<string, unknown>): Promise<string | null> {
  if (localType === 'Bill' && (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')) return 'A bill goes to QuickBooks once it’s approved.';
  if (localType === 'JournalEntry') {
    const e = await ctx.db.journalEntry.findFirst({ where: { id: localId, tenantId: tenantIdForWrite() }, select: { source: true, origin: true } });
    if (e?.origin === 'QUICKBOOKS') return 'It came from QuickBooks.';
    if (e && SOURCES_SYNCED_AS_OBJECTS.has(e.source)) return 'It goes to QuickBooks as its own bill, invoice or payment.';
  }
  return null;
}

/**
 * Bring QuickBooks in line with one site record: create, update, or (when
 * the site record is void, deleted or no longer final) void/delete/deactivate
 * it there.
 */
export async function pushRecord(ctx: PushCtx, localType: LocalType, localId: string): Promise<PushOutcome> {
  const qboType = QBO_TYPE[localType];
  const sv = await siteVersion(ctx.db, localType, localId);
  const link = await linkFor(ctx.db, localType, localId);
  if (!sv) {
    if (link) return removeRemote(ctx, localType, localId, qboType, link.qboId);
    return { result: 'SKIPPED', message: 'It no longer exists here.' };
  }
  const skip = await notForQuickbooks(ctx, localType, localId, sv.payload);
  if (skip && !(localType === 'Bill' && link)) return { result: 'SKIPPED', message: skip };
  if (sv.gone && localType !== 'LedgerAccount' && localType !== 'Vendor') {
    if (!link) return { result: 'SKIPPED', message: 'Void here, and never sent.' };
    return removeRemote(ctx, localType, localId, qboType, link.qboId);
  }
  // QuickBooks' books are closed through bookCloseDate: no transaction lands on or before it.
  if (sv.date && ctx.bookCloseDate && sv.date <= ctx.bookCloseDate && !ctx.force) {
    await raiseConflict(ctx.db, {
      linkId: link?.id ?? localId,
      localType,
      localId,
      summary: `QuickBooks’ books are closed through ${ctx.bookCloseDate}; this ${labelOf(localType)} dated ${sv.date} wasn’t sent.`,
      siteVersion: sv.payload,
      qboVersion: { type: qboType, id: link?.qboId ?? '', entity: null, reason: 'BOOKS_CLOSED' },
    });
    return { result: 'SKIPPED', message: `QuickBooks’ books are closed through ${ctx.bookCloseDate}.` };
  }
  const localHash = fingerprint(sv.payload);
  const b = await body(ctx, localType, sv.payload);
  if (!b) return { result: 'SKIPPED', message: 'Nothing to send.' };

  if (link) {
    const current = await ctx.qbo.get(qboType, link.qboId);
    if (current) {
      // The accountant changed it in QuickBooks since we last agreed: ask, don't overwrite.
      if (!ctx.force && link.remoteHash && remoteFingerprint(qboType, current) !== link.remoteHash) {
        await raiseConflict(ctx.db, {
          linkId: link.id,
          localType,
          localId,
          summary: `This ${labelOf(localType)} was changed in QuickBooks and here since they last matched.`,
          siteVersion: sv.payload,
          qboVersion: { type: qboType, id: link.qboId, entity: current },
        });
        return { result: 'CONFLICT', message: 'Changed on both sides — waiting for a decision.', qboId: link.qboId };
      }
      if (!ctx.force && link.localHash === localHash) return { result: 'SKIPPED', message: 'Already the same in QuickBooks.', qboId: link.qboId };
      const saved = await ctx.qbo.update(qboType, { ...b, Id: link.qboId, SyncToken: current.SyncToken ?? '0' });
      await saveLink(ctx.db, { localType, localId, qboType, qboId: saved.Id, syncToken: saved.SyncToken ?? null, owner: link.owner as 'SITE' | 'QUICKBOOKS', localHash, remoteHash: remoteFingerprint(qboType, saved) });
      return { result: 'OK', message: `Updated ${qboType} ${saved.Id} in QuickBooks.`, qboId: saved.Id };
    }
    // Deleted in QuickBooks: a site-owned record is sent again.
  }
  let created: QboEntity;
  try {
    created = await ctx.qbo.create(qboType, b);
  } catch (err) {
    // A name QuickBooks already has (an account or vendor nobody linked): use that one.
    if (err instanceof QboError && err.code === '6240' && (localType === 'LedgerAccount' || localType === 'Vendor' || localType === 'Client')) {
      const nameField = localType === 'LedgerAccount' ? 'Name' : 'DisplayName';
      const existing = (await ctx.qbo.query(qboType, `${nameField} = '${String(b[nameField]).replace(/'/g, "\\'")}'`))[0];
      if (existing) {
        await saveLink(ctx.db, { localType, localId, qboType, qboId: existing.Id, syncToken: existing.SyncToken ?? null, owner: 'SITE', localHash, remoteHash: remoteFingerprint(qboType, existing) });
        return { result: 'OK', message: `Linked to the ${qboType} QuickBooks already had with this name.`, qboId: existing.Id };
      }
    }
    throw err;
  }
  await saveLink(ctx.db, { localType, localId, qboType, qboId: created.Id, syncToken: created.SyncToken ?? null, owner: link?.owner === 'QUICKBOOKS' ? 'QUICKBOOKS' : 'SITE', localHash, remoteHash: remoteFingerprint(qboType, created) });
  return { result: 'OK', message: `Created ${qboType} ${created.Id} in QuickBooks.`, qboId: created.Id };
}

async function removeRemote(ctx: PushCtx, localType: LocalType, localId: string, qboType: QboType, qboId: string): Promise<PushOutcome> {
  const current = await ctx.qbo.get(qboType, qboId);
  const tenantId = tenantIdForWrite();
  if (current) {
    if (qboType === 'Invoice' || qboType === 'Payment') await ctx.qbo.voidTxn(qboType, qboId, current.SyncToken ?? '0');
    else if (qboType === 'Account' || qboType === 'Vendor' || qboType === 'Customer') await ctx.qbo.update(qboType, { ...current, Active: false, SyncToken: current.SyncToken ?? '0' });
    else await ctx.qbo.remove(qboType, qboId, current.SyncToken ?? '0');
  }
  await ctx.db.qboSyncLink.updateMany({ where: { tenantId, localType, localId }, data: { deletedAt: new Date(), lastSyncedAt: new Date() } });
  const verb = qboType === 'Invoice' || qboType === 'Payment' ? 'Voided' : qboType === 'Account' || qboType === 'Vendor' || qboType === 'Customer' ? 'Made inactive' : 'Deleted';
  return { result: 'OK', message: `${verb} ${qboType} ${qboId} in QuickBooks.`, qboId };
}

export function labelOf(localType: string): string {
  return (
    {
      LedgerAccount: 'account',
      Vendor: 'vendor',
      Client: 'client',
      JournalEntry: 'journal entry',
      Bill: 'bill',
      BillPayment: 'bill payment',
      ClientStatement: 'statement',
      ClientPayment: 'client payment',
    } as Record<string, string>
  )[localType] ?? 'record';
}

/** Push with the event written either way. */
export async function pushAndLog(ctx: PushCtx, localType: LocalType, localId: string): Promise<PushOutcome> {
  const out = await pushRecord(ctx, localType, localId);
  await logEvent(ctx.db, { direction: 'PUSH', result: out.result === 'CONFLICT' ? 'CONFLICT' : out.result, localType, localId, qboType: QBO_TYPE[localType], qboId: out.qboId ?? null, message: out.message });
  return out;
}

export async function pushCtx(db: PrismaClient, qbo: QboClient, bookCloseDate: string | null, force = false): Promise<PushCtx> {
  return { db, qbo, settings: await readSettings(db), bookCloseDate, force };
}
