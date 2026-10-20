import { tenantIdForWrite } from '../../tenant.js';
import { accountIndex } from '../ledger.js';
import { logEvent } from './connection.js';
import { classificationOf, fingerprint, linkFor, linkForQbo, remoteFingerprint, saveLink } from './links.js';
import { upsertAccount, upsertVendor } from './pull.js';
import { pushRecord, siteVersion, type PushCtx } from './push.js';
import type { QboEntity } from './types.js';

/**
 * The first link after connecting: the two charts of accounts matched up
 * (by account number, else by name within the same kind of account), the
 * site's accounts QuickBooks lacks created there, QuickBooks' accounts the
 * site lacks brought here; the same for vendors; and every client linked
 * to (or created as) a QuickBooks customer. Safe to run again — what's
 * already linked is left alone.
 */

export interface LinkSummary {
  accounts: { matched: number; created: number; imported: number };
  vendors: { matched: number; created: number; imported: number };
  customers: { matched: number; created: number };
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export async function initialLink(ctx: PushCtx): Promise<LinkSummary> {
  const tenantId = tenantIdForWrite();
  const summary: LinkSummary = { accounts: { matched: 0, created: 0, imported: 0 }, vendors: { matched: 0, created: 0, imported: 0 }, customers: { matched: 0, created: 0 } };
  const pull = { db: ctx.db, qbo: ctx.qbo };

  // Accounts.
  const { byId } = await accountIndex(ctx.db);
  const qboAccounts = await ctx.qbo.query('Account', 'Active IN (true,false)');
  const taken = new Set<string>();
  for (const l of await ctx.db.qboSyncLink.findMany({ where: { tenantId, qboType: 'Account' }, select: { qboId: true } })) taken.add(l.qboId);
  const free = () => qboAccounts.filter((q) => !taken.has(q.Id));
  for (const a of [...byId.values()].sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))) {
    if (await linkFor(ctx.db, 'LedgerAccount', a.id)) continue;
    const match: QboEntity | undefined =
      free().find((q) => q.AcctNum && norm(q.AcctNum) === norm(a.code)) ?? free().find((q) => norm(q.Name) === norm(a.name) && q.Classification === classificationOf(a.type));
    if (match) {
      const sv = await siteVersion(ctx.db, 'LedgerAccount', a.id);
      await saveLink(ctx.db, { localType: 'LedgerAccount', localId: a.id, qboType: 'Account', qboId: match.Id, syncToken: match.SyncToken ?? null, owner: 'SITE', localHash: fingerprint(sv!.payload), remoteHash: remoteFingerprint('Account', match) });
      taken.add(match.Id);
      summary.accounts.matched += 1;
      continue;
    }
    if (!a.isActive) continue;
    const out = await pushRecord(ctx, 'LedgerAccount', a.id);
    if (out.qboId) {
      taken.add(out.qboId);
      summary.accounts.created += 1;
    }
  }
  for (const q of qboAccounts) {
    if (taken.has(q.Id) || (await linkForQbo(ctx.db, 'Account', q.Id))) continue;
    await upsertAccount(pull, q);
    summary.accounts.imported += 1;
  }

  // Vendors.
  const qboVendors = await ctx.qbo.query('Vendor', 'Active IN (true,false)');
  const vendorTaken = new Set((await ctx.db.qboSyncLink.findMany({ where: { tenantId, qboType: 'Vendor' }, select: { qboId: true } })).map((l) => l.qboId));
  for (const v of await ctx.db.vendor.findMany({ where: { tenantId, deletedAt: null } })) {
    if (await linkFor(ctx.db, 'Vendor', v.id)) continue;
    const match = qboVendors.find((q) => !vendorTaken.has(q.Id) && norm(q.DisplayName) === norm(v.name));
    if (match) {
      const sv = await siteVersion(ctx.db, 'Vendor', v.id);
      await saveLink(ctx.db, { localType: 'Vendor', localId: v.id, qboType: 'Vendor', qboId: match.Id, syncToken: match.SyncToken ?? null, owner: 'SITE', localHash: fingerprint(sv!.payload), remoteHash: remoteFingerprint('Vendor', match) });
      vendorTaken.add(match.Id);
      summary.vendors.matched += 1;
      continue;
    }
    if (!v.isActive) continue;
    const out = await pushRecord(ctx, 'Vendor', v.id);
    if (out.qboId) {
      vendorTaken.add(out.qboId);
      summary.vendors.created += 1;
    }
  }
  for (const q of qboVendors) {
    if (vendorTaken.has(q.Id) || (await linkForQbo(ctx.db, 'Vendor', q.Id))) continue;
    await upsertVendor(pull, q);
    summary.vendors.imported += 1;
  }

  // Customers: every client is a customer in QuickBooks.
  const qboCustomers = await ctx.qbo.query('Customer', 'Active IN (true,false)');
  const customerTaken = new Set((await ctx.db.qboSyncLink.findMany({ where: { tenantId, qboType: 'Customer' }, select: { qboId: true } })).map((l) => l.qboId));
  for (const c of await ctx.db.client.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true } })) {
    if (await linkFor(ctx.db, 'Client', c.id)) continue;
    const match = qboCustomers.find((q) => !customerTaken.has(q.Id) && norm(q.DisplayName) === norm(c.name));
    if (match) {
      await saveLink(ctx.db, { localType: 'Client', localId: c.id, qboType: 'Customer', qboId: match.Id, syncToken: match.SyncToken ?? null, owner: 'SITE', localHash: fingerprint({ name: c.name }), remoteHash: remoteFingerprint('Customer', match) });
      customerTaken.add(match.Id);
      summary.customers.matched += 1;
      continue;
    }
    const out = await pushRecord(ctx, 'Client', c.id);
    if (out.qboId) {
      customerTaken.add(out.qboId);
      summary.customers.created += 1;
    }
  }

  await logEvent(ctx.db, {
    direction: 'PUSH',
    result: 'OK',
    message: `Linked the books: accounts ${summary.accounts.matched} matched, ${summary.accounts.created} created in QuickBooks, ${summary.accounts.imported} brought over; vendors ${summary.vendors.matched} matched, ${summary.vendors.created} created, ${summary.vendors.imported} brought over; customers ${summary.customers.matched} matched, ${summary.customers.created} created.`,
  });
  return summary;
}
