import type { PrismaClient } from '@prisma/client';
import { orgDateKey } from '../../timeAnomalies.js';
import { tenantIdForWrite } from '../../tenant.js';
import { accountByKey, entryForKey, isPeriodClosed, periodOf, postEntry, voidEntry, type PostLine } from '../ledger.js';
import { logEvent } from './connection.js';
import { raiseConflict } from './conflicts.js';
import { fingerprint, linkFor, linkForQbo, remoteFingerprint, saveLink, siteAccountType } from './links.js';
import { labelOf, siteVersion } from './push.js';
import type { QboChange, QboClient, QboEntity, QboType } from './types.js';

/**
 * QuickBooks → site. Every change QuickBooks reports (change-data-capture,
 * or a webhook nudging it) is applied by who owns the record:
 *
 *  - made in QuickBooks (no link, or owner QUICKBOOKS): accounts and vendors
 *    are created/updated on the site; anything that moves money becomes a
 *    ledger entry (origin QUICKBOOKS, sourceKey "qbo:<Type>:<Id>") — edited
 *    when edited there, voided when deleted there. Never pushed back.
 *  - made on the site (owner SITE): an echo of our own push is ignored (its
 *    fingerprint matches). A real edit there is applied to the site only
 *    for ledger-only records (an account, a vendor, a manual entry) that
 *    weren't also changed here; anything else — a payroll entry, a bill, a
 *    statement, a payment — becomes a conflict for a person to decide.
 *  - a change landing in a month the site has CLOSED is a conflict too.
 */

export interface PullCtx {
  db: PrismaClient;
  qbo: QboClient;
  /** A person chose "keep QuickBooks": apply even into a closed month or over a site edit. */
  force?: boolean;
}

export const PULL_TYPES: QboType[] = ['Account', 'Vendor', 'Customer', 'JournalEntry', 'Purchase', 'Deposit', 'Transfer', 'Bill', 'BillPayment', 'Invoice', 'Payment'];
const TXN_TYPES = new Set<QboType>(['JournalEntry', 'Purchase', 'Deposit', 'Transfer', 'Bill', 'BillPayment', 'Invoice', 'Payment']);
/** "2026-08" → "August 2026", for the words a person reads. */
const monthWords = (periodKey: string): string => new Date(`${periodKey}-15T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The site record each QuickBooks transaction type is, when it was made on the site. */
const SITE_TYPE_OF: Partial<Record<QboType, string>> = { JournalEntry: 'JournalEntry', Bill: 'Bill', BillPayment: 'BillPayment', Invoice: 'ClientStatement', Payment: 'ClientPayment' };

const ref = (r: unknown) => (r as { value?: string } | undefined)?.value ?? null;
const amt = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

export type PullOutcome = { result: 'OK' | 'SKIPPED' | 'CONFLICT' | 'ERROR'; message: string; localType?: string; localId?: string };

/* ---- References: QuickBooks ids → site ids --------------------------------- */

async function accountId(ctx: PullCtx, qboId: string | null): Promise<string | null> {
  if (!qboId) return null;
  const link = await linkForQbo(ctx.db, 'Account', qboId);
  if (link && !link.deletedAt) return link.localId;
  const e = await ctx.qbo.get('Account', qboId);
  if (!e) return null;
  return (await upsertAccount(ctx, e)).localId ?? null;
}

async function clientIdOf(ctx: PullCtx, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  return (await linkForQbo(ctx.db, 'Customer', customerId))?.localId ?? null;
}

async function vendorIdOf(ctx: PullCtx, vendorId: string | null): Promise<string | null> {
  if (!vendorId) return null;
  const link = await linkForQbo(ctx.db, 'Vendor', vendorId);
  if (link) return link.localId;
  const e = await ctx.qbo.get('Vendor', vendorId);
  return e ? ((await upsertVendor(ctx, e)).localId ?? null) : null;
}

/** The site dimensions a QuickBooks Class / Location / Customer stands for. */
async function dimsOf(ctx: PullCtx, d: { classId?: string | null; departmentId?: string | null; customerId?: string | null }): Promise<Pick<PostLine, 'clientId' | 'siteId' | 'departmentId'>> {
  const out: Pick<PostLine, 'clientId' | 'siteId' | 'departmentId'> = {};
  if (d.customerId) out.clientId = await clientIdOf(ctx, d.customerId);
  if (d.classId) {
    const l = await linkForQbo(ctx.db, 'Class', d.classId);
    if (l?.localType === 'ClientClass') out.clientId ??= l.localId;
    if (l?.localType === 'DepartmentClass') out.departmentId = l.localId;
  }
  if (d.departmentId) {
    const l = await linkForQbo(ctx.db, 'Department', d.departmentId);
    if (l?.localType === 'Site') out.siteId = l.localId;
  }
  return out;
}

/** An item's account: income for a sale, expense for a purchase. */
async function itemAccount(ctx: PullCtx, itemId: string | null, side: 'income' | 'expense'): Promise<string> {
  if (itemId) {
    const link = await linkForQbo(ctx.db, 'Item', itemId);
    if (link) return link.localId;
    const item = await ctx.qbo.get('Item', itemId);
    const acct = await accountId(ctx, ref(side === 'income' ? item?.IncomeAccountRef : item?.ExpenseAccountRef));
    if (acct) return acct;
  }
  return (await accountByKey(ctx.db, side === 'income' ? 'REVENUE_STAFFING' : 'UNCATEGORIZED_EXPENSE')).id;
}

/* ---- Accounts and vendors ------------------------------------------------- */

async function freeCode(ctx: PullCtx, wanted: string | null, qboId: string): Promise<string> {
  const tenantId = tenantIdForWrite();
  for (const code of [wanted, `QB${qboId}`, `QB${qboId}-${Date.now() % 10000}`]) {
    if (!code) continue;
    const taken = await ctx.db.ledgerAccount.findFirst({ where: { tenantId, code: code.slice(0, 20) }, select: { id: true } });
    if (!taken) return code.slice(0, 20);
  }
  return `QB${qboId}`.slice(0, 20);
}

/** An account QuickBooks has: created or updated on the site, by who owns it. */
export async function upsertAccount(ctx: PullCtx, e: QboEntity): Promise<PullOutcome> {
  const tenantId = tenantIdForWrite();
  const link = await linkForQbo(ctx.db, 'Account', e.Id);
  const fp = remoteFingerprint('Account', e);
  const t = siteAccountType(String(e.AccountType ?? ''), (e.AccountSubType as string | undefined) ?? null);
  if (link) {
    if (link.remoteHash === fp && !ctx.force) return { result: 'SKIPPED', message: 'No change.', localType: 'LedgerAccount', localId: link.localId };
    const sv = await siteVersion(ctx.db, 'LedgerAccount', link.localId);
    if (!sv) return { result: 'SKIPPED', message: 'The site account is gone.' };
    if (link.owner === 'SITE' && !ctx.force && link.localHash && fingerprint(sv.payload) !== link.localHash) {
      await raiseConflict(ctx.db, { linkId: link.id, localType: 'LedgerAccount', localId: link.localId, summary: `The account “${sv.payload.name}” was changed here and in QuickBooks.`, siteVersion: sv.payload, qboVersion: { type: 'Account', id: e.Id, entity: e } });
      return { result: 'CONFLICT', message: 'Changed on both sides.', localType: 'LedgerAccount', localId: link.localId };
    }
    const acctNum = (e.AcctNum as string | undefined) ?? null;
    const codeOk = acctNum && acctNum !== sv.payload.code ? !(await ctx.db.ledgerAccount.findFirst({ where: { tenantId, code: acctNum.slice(0, 20), NOT: { id: link.localId } }, select: { id: true } })) : false;
    await ctx.db.ledgerAccount.update({ where: { id: link.localId }, data: { name: String(e.Name).slice(0, 160), isActive: e.Active !== false, ...(codeOk ? { code: acctNum!.slice(0, 20) } : {}) } });
    const after = await siteVersion(ctx.db, 'LedgerAccount', link.localId);
    await saveLink(ctx.db, { localType: 'LedgerAccount', localId: link.localId, qboType: 'Account', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: link.owner as 'SITE' | 'QUICKBOOKS', localHash: fingerprint(after!.payload), remoteHash: fp });
    return { result: 'OK', message: `Updated the account “${e.Name}”.`, localType: 'LedgerAccount', localId: link.localId };
  }
  const code = await freeCode(ctx, (e.AcctNum as string | undefined) ?? null, e.Id);
  const a = await ctx.db.ledgerAccount.create({ data: { tenantId, code, name: String(e.Name).slice(0, 160), type: t.type, subtype: t.subtype, isActive: e.Active !== false, description: 'Made in QuickBooks.' } });
  const sv = await siteVersion(ctx.db, 'LedgerAccount', a.id);
  await saveLink(ctx.db, { localType: 'LedgerAccount', localId: a.id, qboType: 'Account', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'QUICKBOOKS', localHash: fingerprint(sv!.payload), remoteHash: fp });
  return { result: 'OK', message: `Added the account “${e.Name}” from QuickBooks.`, localType: 'LedgerAccount', localId: a.id };
}

export async function upsertVendor(ctx: PullCtx, e: QboEntity): Promise<PullOutcome> {
  const tenantId = tenantIdForWrite();
  const link = await linkForQbo(ctx.db, 'Vendor', e.Id);
  const fp = remoteFingerprint('Vendor', e);
  const addr = (e.BillAddr as { Line1?: string; Line2?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string } | undefined) ?? {};
  const fields = {
    name: String(e.DisplayName ?? e.CompanyName ?? 'Vendor').slice(0, 160),
    email: ((e.PrimaryEmailAddr as { Address?: string } | undefined)?.Address ?? null)?.slice(0, 200) ?? null,
    phone: ((e.PrimaryPhone as { FreeFormNumber?: string } | undefined)?.FreeFormNumber ?? null)?.slice(0, 40) ?? null,
    addressLine1: addr.Line1?.slice(0, 200) ?? null,
    addressLine2: addr.Line2?.slice(0, 200) ?? null,
    city: addr.City?.slice(0, 100) ?? null,
    state: addr.CountrySubDivisionCode?.slice(0, 2) ?? null,
    zip: addr.PostalCode?.slice(0, 10) ?? null,
    is1099: e.Vendor1099 === true,
    isActive: e.Active !== false,
  };
  if (link) {
    if (link.remoteHash === fp && !ctx.force) return { result: 'SKIPPED', message: 'No change.', localType: 'Vendor', localId: link.localId };
    const sv = await siteVersion(ctx.db, 'Vendor', link.localId);
    if (!sv) return { result: 'SKIPPED', message: 'The site vendor is gone.' };
    if (link.owner === 'SITE' && !ctx.force && link.localHash && fingerprint(sv.payload) !== link.localHash) {
      await raiseConflict(ctx.db, { linkId: link.id, localType: 'Vendor', localId: link.localId, summary: `The vendor “${sv.payload.name}” was changed here and in QuickBooks.`, siteVersion: sv.payload, qboVersion: { type: 'Vendor', id: e.Id, entity: e } });
      return { result: 'CONFLICT', message: 'Changed on both sides.', localType: 'Vendor', localId: link.localId };
    }
    await ctx.db.vendor.update({ where: { id: link.localId }, data: fields });
    const after = await siteVersion(ctx.db, 'Vendor', link.localId);
    await saveLink(ctx.db, { localType: 'Vendor', localId: link.localId, qboType: 'Vendor', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: link.owner as 'SITE' | 'QUICKBOOKS', localHash: fingerprint(after!.payload), remoteHash: fp });
    return { result: 'OK', message: `Updated the vendor “${fields.name}”.`, localType: 'Vendor', localId: link.localId };
  }
  const v = await ctx.db.vendor.create({ data: { tenantId, ...fields, paymentMethod: 'CHECK', notes: 'Made in QuickBooks.' } });
  const sv = await siteVersion(ctx.db, 'Vendor', v.id);
  await saveLink(ctx.db, { localType: 'Vendor', localId: v.id, qboType: 'Vendor', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'QUICKBOOKS', localHash: fingerprint(sv!.payload), remoteHash: fp });
  return { result: 'OK', message: `Added the vendor “${fields.name}” from QuickBooks.`, localType: 'Vendor', localId: v.id };
}

/** A QuickBooks customer: linked to the site client of the same name. Clients themselves are never made from QuickBooks. */
async function upsertCustomer(ctx: PullCtx, e: QboEntity): Promise<PullOutcome> {
  const link = await linkForQbo(ctx.db, 'Customer', e.Id);
  if (link) {
    await ctx.db.qboSyncLink.update({ where: { id: link.id }, data: { syncToken: e.SyncToken ?? null, remoteHash: remoteFingerprint('Customer', e), lastSyncedAt: new Date() } });
    return { result: 'SKIPPED', message: 'Customer already linked.', localType: 'Client', localId: link.localId };
  }
  const name = String(e.DisplayName ?? '').trim();
  const client = name ? await ctx.db.client.findFirst({ where: { tenantId: tenantIdForWrite(), name: { equals: name, mode: 'insensitive' } }, select: { id: true } }) : null;
  if (!client) return { result: 'SKIPPED', message: `QuickBooks customer “${name}” has no client of that name here; its transactions come over without a client.` };
  await saveLink(ctx.db, { localType: 'Client', localId: client.id, qboType: 'Customer', qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'SITE', remoteHash: remoteFingerprint('Customer', e) });
  return { result: 'OK', message: `Linked QuickBooks customer “${name}” to the client.`, localType: 'Client', localId: client.id };
}

/* ---- Transactions → ledger lines ----------------------------------------- */

type Line = Record<string, unknown>;

/** A QuickBooks transaction as balanced ledger lines (site accounts and dimensions). */
export async function linesOf(ctx: PullCtx, type: QboType, e: QboEntity): Promise<PostLine[]> {
  const lines = (e.Line as Line[] | undefined) ?? [];
  const out: PostLine[] = [];
  const headerDims = await dimsOf(ctx, { departmentId: ref(e.DepartmentRef), customerId: ref(e.CustomerRef) });
  const must = async (qboAcct: string | null, fallbackKey: string) => (await accountId(ctx, qboAcct)) ?? (await accountByKey(ctx.db, fallbackKey)).id;
  switch (type) {
    case 'JournalEntry':
      for (const l of lines) {
        const d = l.JournalEntryLineDetail as Record<string, unknown> | undefined;
        if (!d) continue;
        const entity = d.Entity as { Type?: string; EntityRef?: { value?: string } } | undefined;
        const dims = await dimsOf(ctx, { classId: ref(d.ClassRef), departmentId: ref(d.DepartmentRef), customerId: entity?.Type === 'Customer' ? (entity.EntityRef?.value ?? null) : null });
        const vendorId = entity?.Type === 'Vendor' ? await vendorIdOf(ctx, entity.EntityRef?.value ?? null) : null;
        const account = await must(ref(d.AccountRef), 'UNCATEGORIZED_EXPENSE');
        out.push({ account, [d.PostingType === 'Credit' ? 'credit' : 'debit']: amt(l.Amount), memo: (l.Description as string) ?? null, ...dims, vendorId });
      }
      return out;
    case 'Purchase': {
      const sign = e.Credit === true ? -1 : 1; // a refund runs the other way
      for (const l of lines) {
        const ab = l.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
        const ib = l.ItemBasedExpenseLineDetail as Record<string, unknown> | undefined;
        if (!ab && !ib) continue;
        const account = ab ? await must(ref(ab.AccountRef), 'UNCATEGORIZED_EXPENSE') : await itemAccount(ctx, ref(ib!.ItemRef), 'expense');
        const dims = await dimsOf(ctx, { classId: ref((ab ?? ib)!.ClassRef), customerId: ref((ab ?? ib)!.CustomerRef) });
        out.push({ account, debit: sign * amt(l.Amount), memo: (l.Description as string) ?? null, ...headerDims, ...dims });
      }
      const vendorId = (e.EntityRef as { type?: string; value?: string } | undefined)?.type === 'Vendor' ? await vendorIdOf(ctx, ref(e.EntityRef)) : null;
      out.push({ account: await must(ref(e.AccountRef), 'CASH_OPERATING'), credit: sign * amt(e.TotalAmt), memo: (e.PrivateNote as string) ?? null, vendorId });
      return out;
    }
    case 'Deposit': {
      for (const l of lines) {
        const d = l.DepositLineDetail as Record<string, unknown> | undefined;
        const linked = ((l.LinkedTxn as unknown[] | undefined) ?? []).length > 0;
        const account = d?.AccountRef ? await must(ref(d.AccountRef), 'UNDEPOSITED') : linked ? (await accountByKey(ctx.db, 'UNDEPOSITED')).id : (await accountByKey(ctx.db, 'UNCATEGORIZED_INCOME')).id;
        const dims = await dimsOf(ctx, { classId: ref(d?.ClassRef), customerId: ref((d?.Entity as { value?: string } | undefined) ?? null) });
        out.push({ account, credit: amt(l.Amount), memo: (l.Description as string) ?? null, ...headerDims, ...dims });
      }
      out.push({ account: await must(ref(e.DepositToAccountRef), 'CASH_OPERATING'), debit: amt(e.TotalAmt), memo: (e.PrivateNote as string) ?? null });
      return out;
    }
    case 'Transfer':
      return [
        { account: await must(ref(e.ToAccountRef), 'CASH_OPERATING'), debit: amt(e.Amount) },
        { account: await must(ref(e.FromAccountRef), 'CASH_OPERATING'), credit: amt(e.Amount) },
      ];
    case 'Bill': {
      const vendorId = await vendorIdOf(ctx, ref(e.VendorRef));
      for (const l of lines) {
        const ab = l.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
        const ib = l.ItemBasedExpenseLineDetail as Record<string, unknown> | undefined;
        if (!ab && !ib) continue;
        const account = ab ? await must(ref(ab.AccountRef), 'UNCATEGORIZED_EXPENSE') : await itemAccount(ctx, ref(ib!.ItemRef), 'expense');
        const dims = await dimsOf(ctx, { classId: ref((ab ?? ib)!.ClassRef), customerId: ref((ab ?? ib)!.CustomerRef) });
        out.push({ account, debit: amt(l.Amount), memo: (l.Description as string) ?? null, ...headerDims, ...dims, vendorId });
      }
      out.push({ account: await must(ref(e.APAccountRef), 'AP'), credit: amt(e.TotalAmt), vendorId });
      return out;
    }
    case 'BillPayment': {
      const vendorId = await vendorIdOf(ctx, ref(e.VendorRef));
      const bank = ref((e.CheckPayment as Record<string, unknown> | undefined)?.BankAccountRef) ?? ref((e.CreditCardPayment as Record<string, unknown> | undefined)?.CCAccountRef);
      return [
        { account: await must(ref(e.APAccountRef), 'AP'), debit: amt(e.TotalAmt), vendorId },
        { account: await must(bank, 'CASH_OPERATING'), credit: amt(e.TotalAmt), vendorId },
      ];
    }
    case 'Invoice': {
      const clientId = await clientIdOf(ctx, ref(e.CustomerRef));
      for (const l of lines) {
        const s = l.SalesItemLineDetail as Record<string, unknown> | undefined;
        if (l.DetailType === 'DiscountLineDetail') {
          out.push({ account: (await accountByKey(ctx.db, 'REVENUE_ADJUSTMENTS')).id, debit: amt(l.Amount), clientId });
          continue;
        }
        if (!s) continue;
        const dims = await dimsOf(ctx, { classId: ref(s.ClassRef) });
        out.push({ account: await itemAccount(ctx, ref(s.ItemRef), 'income'), credit: amt(l.Amount), memo: (l.Description as string) ?? null, ...headerDims, ...dims, clientId });
      }
      out.push({ account: await must(ref(e.ARAccountRef), 'AR'), debit: amt(e.TotalAmt), clientId });
      return out;
    }
    case 'Payment': {
      const clientId = await clientIdOf(ctx, ref(e.CustomerRef));
      return [
        { account: await must(ref(e.DepositToAccountRef), 'UNDEPOSITED'), debit: amt(e.TotalAmt), clientId },
        { account: await must(ref(e.ARAccountRef), 'AR'), credit: amt(e.TotalAmt), clientId },
      ];
    }
    default:
      return [];
  }
}

/** Voided in QuickBooks: its total (a transfer's amount) and every line are zero. */
const isVoided = (e: QboEntity) => amt(e.TotalAmt ?? e.Amount) === 0 && ((e.Line as Line[] | undefined) ?? []).every((l) => amt(l.Amount) === 0);

function describe(type: QboType, e: QboEntity): string {
  const who = ((e.VendorRef ?? e.CustomerRef ?? e.EntityRef) as { name?: string } | undefined)?.name;
  const label = { JournalEntry: 'journal entry', Purchase: 'expense', Deposit: 'deposit', Transfer: 'transfer', Bill: 'bill', BillPayment: 'bill payment', Invoice: 'invoice', Payment: 'payment' }[type as string] ?? type;
  return `${label}${e.DocNumber ? ` ${e.DocNumber}` : ''}${who ? ` (${who})` : ''} of $${amt(e.TotalAmt ?? e.Amount).toFixed(2)} dated ${e.TxnDate ?? '—'}`;
}

/** A transaction made in QuickBooks: on the site as a ledger entry, kept in step. */
async function applyQboMade(ctx: PullCtx, type: QboType, e: QboEntity): Promise<PullOutcome> {
  const sourceKey = `qbo:${type}:${e.Id}`;
  const link = await linkForQbo(ctx.db, type, e.Id);
  const fp = remoteFingerprint(type, e);
  if (link && link.remoteHash === fp && !ctx.force) return { result: 'SKIPPED', message: 'No change.', localType: 'JournalEntry', localId: link.localId };
  const existing = await entryForKey(ctx.db, sourceKey);
  if (isVoided(e)) {
    if (existing && existing.status === 'POSTED') await voidEntry(ctx.db, existing.id, { reason: 'Voided in QuickBooks.' });
    if (link) await ctx.db.qboSyncLink.update({ where: { id: link.id }, data: { remoteHash: fp, syncToken: e.SyncToken ?? null, lastSyncedAt: new Date() } });
    return { result: 'OK', message: `Voided the ${describe(type, e)} — voided in QuickBooks.`, localType: 'JournalEntry', localId: existing?.id };
  }
  const date = String(e.TxnDate ?? orgDateKey(new Date())).slice(0, 10);
  const closed = (await isPeriodClosed(ctx.db, periodOf(date))) || (existing ? await isPeriodClosed(ctx.db, existing.periodKey) : false);
  if (closed && !ctx.force) {
    await raiseConflict(ctx.db, {
      linkId: link?.id ?? existing?.id ?? pseudoId(type, e.Id),
      localType: 'JournalEntry',
      localId: existing?.id ?? pseudoId(type, e.Id),
      summary: `QuickBooks ${existing ? 'changed' : 'added'} a ${describe(type, e)} in ${monthWords(periodOf(date))}, which is closed in the books here.`,
      // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: entryDate is a @db.Date stored at UTC midnight.
      siteVersion: existing ? { number: existing.number, date: existing.entryDate.toISOString().slice(0, 10), total: Number(existing.totalDebit) } : {},
      qboVersion: { type, id: e.Id, entity: e, reason: 'SITE_PERIOD_CLOSED' },
    });
    return { result: 'CONFLICT', message: `${monthWords(periodOf(date))} is closed in the books here.` };
  }
  const lines = await linesOf(ctx, type, e);
  const entry = await postEntry(ctx.db, {
    date,
    memo: `From QuickBooks: ${describe(type, e)}${e.PrivateNote ? ` — ${String(e.PrivateNote)}` : ''}`.slice(0, 500),
    source: 'QUICKBOOKS',
    sourceType: `Qbo${type}`,
    sourceId: e.Id,
    sourceKey,
    origin: 'QUICKBOOKS',
    lines,
  });
  await saveLink(ctx.db, { localType: 'JournalEntry', localId: (await entryForKey(ctx.db, sourceKey))?.id ?? entry.id, qboType: type, qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'QUICKBOOKS', remoteHash: fp });
  return { result: 'OK', message: `${existing ? 'Updated' : 'Added'} the ${describe(type, e)} from QuickBooks.`, localType: 'JournalEntry', localId: entry.id };
}

/** A stable placeholder id for a QuickBooks record not on the site yet (a conflict needs a uuid). */
function pseudoId(type: string, id: string): string {
  const h = fingerprint(`${type}:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A transaction made on the site, changed or deleted in QuickBooks. */
async function applyToSiteOwned(ctx: PullCtx, type: QboType, change: QboChange, link: NonNullable<Awaited<ReturnType<typeof linkForQbo>>>): Promise<PullOutcome> {
  const e = change.entity;
  const fp = e ? remoteFingerprint(type, e) : null;
  if (e && fp === link.remoteHash && !ctx.force) return { result: 'SKIPPED', message: 'No change (our own push coming back).', localType: link.localType, localId: link.localId };
  const sv = await siteVersion(ctx.db, link.localType, link.localId);
  if (!sv) return { result: 'SKIPPED', message: 'The site record is gone.' };
  if (!e) {
    if (link.deletedAt || sv.gone) return { result: 'SKIPPED', message: 'Deleted on both sides.' };
    await raiseConflict(ctx.db, { linkId: link.id, localType: link.localType, localId: link.localId, summary: `This ${labelOf(link.localType)} was deleted in QuickBooks but is still in the books here.`, siteVersion: sv.payload, qboVersion: { type, id: link.qboId, entity: null, reason: 'DELETED_IN_QUICKBOOKS' } });
    return { result: 'CONFLICT', message: 'Deleted in QuickBooks.', localType: link.localType, localId: link.localId };
  }
  const siteChanged = !!link.localHash && fingerprint(sv.payload) !== link.localHash;
  const closed = sv.date ? await isPeriodClosed(ctx.db, periodOf(sv.date)) : false;
  const entry = link.localType === 'JournalEntry' ? await ctx.db.journalEntry.findFirst({ where: { id: link.localId, tenantId: tenantIdForWrite() }, select: { source: true } }) : null;
  const ledgerOnly = entry?.source === 'MANUAL';
  if (ctx.force || (ledgerOnly && !siteChanged && !closed)) return applyQboVersion(ctx, type, e, link);
  const why = closed ? `in ${monthWords(periodOf(sv.date!))}, which is closed in the books here` : siteChanged ? 'and here since they last matched' : 'but its record lives here (payroll, bills, statements and payments come from their own records)';
  await raiseConflict(ctx.db, { linkId: link.id, localType: link.localType, localId: link.localId, summary: `This ${labelOf(link.localType)} was changed in QuickBooks ${why}.`, siteVersion: sv.payload, qboVersion: { type, id: link.qboId, entity: e } });
  return { result: 'CONFLICT', message: 'Waiting for a decision.', localType: link.localType, localId: link.localId };
}

/**
 * Make the site agree with QuickBooks' version of a site-owned transaction.
 * A manual entry is replaced (voided, and the QuickBooks version posted);
 * anything posted by an operational flow keeps its entry and gets a
 * correcting entry for the difference ("qbo-correction:<Type>:<Id>").
 */
export async function applyQboVersion(ctx: PullCtx, type: QboType, e: QboEntity, link: NonNullable<Awaited<ReturnType<typeof linkForQbo>>>): Promise<PullOutcome> {
  const tenantId = tenantIdForWrite();
  const fp = remoteFingerprint(type, e);
  const qboLines = await linesOf(ctx, type, e);
  const date = String(e.TxnDate ?? orgDateKey(new Date())).slice(0, 10);
  const entry = link.localType === 'JournalEntry' ? await ctx.db.journalEntry.findFirst({ where: { id: link.localId, tenantId }, include: { lines: true } }) : null;
  if (entry && entry.source === 'MANUAL' && !(await isPeriodClosed(ctx.db, entry.periodKey)) && !(await isPeriodClosed(ctx.db, periodOf(date)))) {
    await voidEntry(ctx.db, entry.id, { reason: 'Replaced by the version edited in QuickBooks.' });
    const next = await postEntry(ctx.db, { date, memo: entry.memo, source: 'MANUAL', origin: 'QUICKBOOKS', lines: qboLines, createdById: entry.createdById });
    const sv = await siteVersion(ctx.db, 'JournalEntry', next.id);
    await ctx.db.qboSyncLink.delete({ where: { id: link.id } });
    await saveLink(ctx.db, { localType: 'JournalEntry', localId: next.id, qboType: type, qboId: e.Id, syncToken: e.SyncToken ?? null, owner: 'SITE', localHash: fingerprint(sv!.payload), remoteHash: fp });
    return { result: 'OK', message: `Entry #${entry.number} replaced by QuickBooks’ version (#${next.number}).`, localType: 'JournalEntry', localId: next.id };
  }
  // Everything the site has posted for this record, netted, against QuickBooks' version.
  const posted = await ctx.db.journalLine.findMany({
    where: { tenantId, entry: { status: 'POSTED', OR: entry ? [{ id: entry.id }, { sourceKey: { startsWith: `qbo-correction:${type}:${e.Id}` } }] : [{ sourceType: link.localType, sourceId: link.localId }, { sourceKey: { startsWith: `qbo-correction:${type}:${e.Id}` } }] } },
  });
  const key = (l: { accountId?: string; account?: string; clientId?: string | null; siteId?: string | null; departmentId?: string | null; vendorId?: string | null }) => [l.accountId ?? l.account, l.clientId ?? null, l.siteId ?? null, l.departmentId ?? null, l.vendorId ?? null].join('|');
  const net = new Map<string, PostLine & { cents: number }>();
  for (const l of qboLines) {
    const k = key(l);
    const cur = net.get(k) ?? { ...l, debit: 0, credit: 0, cents: 0 };
    cur.cents += Math.round((Number(l.debit ?? 0) - Number(l.credit ?? 0)) * 100);
    net.set(k, cur);
  }
  for (const l of posted) {
    const k = key(l);
    const cur = net.get(k) ?? { account: l.accountId, clientId: l.clientId, siteId: l.siteId, departmentId: l.departmentId, vendorId: l.vendorId, debit: 0, credit: 0, cents: 0 };
    cur.cents -= Math.round((Number(l.debit) - Number(l.credit)) * 100);
    net.set(k, cur);
  }
  const diff = [...net.values()].filter((l) => l.cents !== 0).map(({ cents, ...l }) => ({ ...l, debit: cents > 0 ? cents / 100 : 0, credit: cents < 0 ? -cents / 100 : 0 }));
  if (diff.length > 0) {
    const n = await ctx.db.journalEntry.count({ where: { tenantId, sourceKey: { startsWith: `qbo-correction:${type}:${e.Id}` } } });
    await postEntry(ctx.db, {
      date: orgDateKey(new Date()) > date ? orgDateKey(new Date()) : date,
      memo: `Correction to match QuickBooks: ${describe(type, e)}`,
      source: 'QUICKBOOKS',
      sourceType: link.localType,
      sourceId: link.localId,
      sourceKey: `qbo-correction:${type}:${e.Id}:${n + 1}`,
      origin: 'QUICKBOOKS',
      lines: diff,
    });
  }
  const sv = await siteVersion(ctx.db, link.localType, link.localId);
  await saveLink(ctx.db, { localType: link.localType, localId: link.localId, qboType: type, qboId: e.Id, syncToken: e.SyncToken ?? null, owner: link.owner as 'SITE' | 'QUICKBOOKS', localHash: sv ? fingerprint(sv.payload) : link.localHash, remoteHash: fp });
  return { result: 'OK', message: diff.length ? `Posted a correction so the books here match QuickBooks’ ${describe(type, e)}.` : 'Already matched QuickBooks.', localType: link.localType, localId: link.localId };
}

/* ---- One change ---------------------------------------------------------- */

export async function applyChange(ctx: PullCtx, change: QboChange): Promise<PullOutcome> {
  const { type } = change;
  if (type === 'Account') return change.entity ? upsertAccount(ctx, change.entity) : { result: 'SKIPPED', message: 'Accounts aren’t deleted in QuickBooks.' };
  if (type === 'Vendor') return change.entity ? upsertVendor(ctx, change.entity) : { result: 'SKIPPED', message: 'Vendors aren’t deleted in QuickBooks.' };
  if (type === 'Customer') return change.entity ? upsertCustomer(ctx, change.entity) : { result: 'SKIPPED', message: 'Customers aren’t deleted in QuickBooks.' };
  if (!TXN_TYPES.has(type)) return { result: 'SKIPPED', message: `${type} isn’t synced.` };
  const link = await linkForQbo(ctx.db, type, change.id);
  if (link && link.owner === 'SITE' && SITE_TYPE_OF[type] === link.localType) return applyToSiteOwned(ctx, type, change, link);
  if (!change.entity) {
    const existing = await entryForKey(ctx.db, `qbo:${type}:${change.id}`);
    if (existing && existing.status === 'POSTED') await voidEntry(ctx.db, existing.id, { reason: 'Deleted in QuickBooks.' });
    if (link) await ctx.db.qboSyncLink.update({ where: { id: link.id }, data: { deletedAt: new Date(), lastSyncedAt: new Date() } });
    return existing ? { result: 'OK', message: `Voided entry #${existing.number} — deleted in QuickBooks.`, localType: 'JournalEntry', localId: existing.id } : { result: 'SKIPPED', message: 'Deleted in QuickBooks; never in the books here.' };
  }
  return applyQboMade(ctx, type, change.entity);
}

/** Apply a batch of changes in dependency order (names before transactions), logging each. */
export async function applyChanges(ctx: PullCtx, changes: QboChange[]): Promise<{ ok: number; conflicts: number; errors: number; skipped: number }> {
  const order = (t: QboType) => (t === 'Account' ? 0 : t === 'Vendor' ? 1 : t === 'Customer' ? 2 : 3);
  const sorted = [...changes].sort((a, b) => order(a.type) - order(b.type));
  const tally = { ok: 0, conflicts: 0, errors: 0, skipped: 0 };
  for (const c of sorted) {
    let out: PullOutcome;
    try {
      out = await applyChange(ctx, c);
    } catch (err) {
      out = { result: 'ERROR', message: err instanceof Error ? err.message : String(err) };
    }
    if (out.result === 'OK') tally.ok += 1;
    else if (out.result === 'CONFLICT') tally.conflicts += 1;
    else if (out.result === 'ERROR') tally.errors += 1;
    else tally.skipped += 1;
    // An echo of our own push isn't worth a history line.
    if (out.result === 'SKIPPED' && out.message.startsWith('No change')) continue;
    await logEvent(ctx.db, { direction: 'PULL', result: out.result, localType: out.localType ?? null, localId: out.localId ?? null, qboType: c.type, qboId: c.id, message: out.message });
  }
  return tally;
}

export { linkFor };
