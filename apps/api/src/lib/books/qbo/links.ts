import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, QboSyncLink } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import type { QboEntity, QboType } from './types.js';

/**
 * The record of what is the same thing on both sides (QboSyncLink), and the
 * fingerprints that tell an edit from an echo:
 *
 *   localHash   the site record's synced fields when last in step
 *   remoteHash  QuickBooks' record's money/name fields when last in step
 *
 * A pull compares QuickBooks' current fingerprint with remoteHash (equal →
 * nothing changed there, including our own push coming back); a push or a
 * conflict check compares the site's current fingerprint with localHash.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Stable JSON → sha256: key order and line order don't matter. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).sort().join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  if (typeof v === 'number') return (Math.round(v * 100) / 100).toFixed(2);
  return JSON.stringify(v);
}

export async function linkFor(db: Db, localType: string, localId: string): Promise<QboSyncLink | null> {
  return db.qboSyncLink.findUnique({ where: { tenantId_localType_localId: { tenantId: tenantIdForWrite(), localType, localId } } });
}

export async function linkForQbo(db: Db, qboType: string, qboId: string): Promise<QboSyncLink | null> {
  return db.qboSyncLink.findUnique({ where: { tenantId_qboType_qboId: { tenantId: tenantIdForWrite(), qboType, qboId } } });
}

/** Record that a site record and a QuickBooks record are the same — replacing any other link to either. */
export async function saveLink(
  db: Db,
  l: { localType: string; localId: string; qboType: QboType | string; qboId: string; syncToken?: string | null; owner: 'SITE' | 'QUICKBOOKS'; localHash?: string | null; remoteHash?: string | null },
): Promise<QboSyncLink> {
  const tenantId = tenantIdForWrite();
  await db.qboSyncLink.deleteMany({ where: { tenantId, qboType: l.qboType, qboId: l.qboId, NOT: { localType: l.localType, localId: l.localId } } });
  const data = {
    qboType: l.qboType,
    qboId: l.qboId,
    syncToken: l.syncToken ?? null,
    owner: l.owner,
    localHash: l.localHash ?? null,
    remoteHash: l.remoteHash ?? null,
    lastSyncedAt: new Date(),
    deletedAt: null,
  };
  return db.qboSyncLink.upsert({
    where: { tenantId_localType_localId: { tenantId, localType: l.localType, localId: l.localId } },
    create: { tenantId, localType: l.localType, localId: l.localId, ...data },
    update: data,
  });
}

/* ---- QuickBooks' side, fingerprinted ------------------------------------- */

const ref = (r: unknown) => (r as { value?: string } | undefined)?.value ?? null;
const num = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** What matters about a QuickBooks record: names and money, not its SyncToken or timestamps. */
export function remoteFingerprint(type: QboType | string, e: QboEntity): string {
  switch (type) {
    case 'Account':
      return fingerprint({ n: e.Name, a: e.AcctNum ?? null, t: e.AccountType, act: e.Active !== false });
    case 'Vendor':
    case 'Customer':
      return fingerprint({ n: e.DisplayName, act: e.Active !== false, em: (e.PrimaryEmailAddr as { Address?: string } | undefined)?.Address ?? null, t: e.Vendor1099 ?? null });
    case 'Class':
    case 'Department':
    case 'Item':
      return fingerprint({ n: e.Name, act: e.Active !== false });
    default: {
      const lines = ((e.Line as Array<Record<string, unknown>> | undefined) ?? []).map((l) => {
        const detail = Object.entries(l).find(([k]) => k.endsWith('Detail'))?.[1] as Record<string, unknown> | undefined;
        return {
          a: num(l.Amount),
          acct: ref(detail?.AccountRef) ?? ref(detail?.ItemRef),
          pt: detail?.PostingType ?? null,
          linked: ((l.LinkedTxn as Array<{ TxnId?: string }> | undefined) ?? []).map((x) => x.TxnId).join(','),
        };
      });
      return fingerprint({ d: e.TxnDate ?? null, t: num(e.TotalAmt), lines });
    }
  }
}

/* ---- Account types ------------------------------------------------------ */

/** The site's subtype → QuickBooks' AccountType (and the subtype QuickBooks needs spelled out). */
export function qboAccountType(type: string, subtype: string): { AccountType: string; AccountSubType?: string } {
  switch (subtype) {
    case 'BANK':
      return { AccountType: 'Bank' };
    case 'AR':
      return { AccountType: 'Accounts Receivable' };
    case 'AP':
      return { AccountType: 'Accounts Payable' };
    case 'CREDIT_CARD':
      return { AccountType: 'Credit Card' };
    case 'FIXED_ASSET':
      return { AccountType: 'Fixed Asset' };
    case 'ACCUMULATED_DEPRECIATION':
      return { AccountType: 'Fixed Asset', AccountSubType: 'AccumulatedDepreciation' };
    case 'OTHER_ASSET':
      return { AccountType: 'Other Asset' };
    case 'LONG_TERM_LIABILITY':
      return { AccountType: 'Long Term Liability' };
    case 'COST_OF_SERVICES':
      return { AccountType: 'Cost of Goods Sold' };
    case 'OTHER_INCOME':
      return { AccountType: 'Other Income' };
    case 'OTHER_EXPENSE':
      return { AccountType: 'Other Expense' };
    case 'RETAINED_EARNINGS':
      return { AccountType: 'Equity', AccountSubType: 'RetainedEarnings' };
  }
  switch (type) {
    case 'ASSET':
      return { AccountType: 'Other Current Asset' };
    case 'LIABILITY':
      return { AccountType: 'Other Current Liability' };
    case 'EQUITY':
      return { AccountType: 'Equity' };
    case 'INCOME':
      return { AccountType: 'Income' };
    default:
      return { AccountType: 'Expense' };
  }
}

/** QuickBooks' AccountType → the site's type and subtype (for accounts made in QuickBooks). */
export function siteAccountType(accountType: string, accountSubType?: string | null): { type: string; subtype: string } {
  switch (accountType) {
    case 'Bank':
      return { type: 'ASSET', subtype: 'BANK' };
    case 'Accounts Receivable':
      return { type: 'ASSET', subtype: 'AR' };
    case 'Other Current Asset':
      return { type: 'ASSET', subtype: 'CURRENT_ASSET' };
    case 'Fixed Asset':
      return { type: 'ASSET', subtype: accountSubType === 'AccumulatedDepreciation' ? 'ACCUMULATED_DEPRECIATION' : 'FIXED_ASSET' };
    case 'Other Asset':
      return { type: 'ASSET', subtype: 'OTHER_ASSET' };
    case 'Accounts Payable':
      return { type: 'LIABILITY', subtype: 'AP' };
    case 'Credit Card':
      return { type: 'LIABILITY', subtype: 'CREDIT_CARD' };
    case 'Long Term Liability':
      return { type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY' };
    case 'Other Current Liability':
      return { type: 'LIABILITY', subtype: 'CURRENT_LIABILITY' };
    case 'Equity':
      return { type: 'EQUITY', subtype: accountSubType === 'RetainedEarnings' ? 'RETAINED_EARNINGS' : 'EQUITY' };
    case 'Income':
      return { type: 'INCOME', subtype: 'INCOME' };
    case 'Other Income':
      return { type: 'INCOME', subtype: 'OTHER_INCOME' };
    case 'Cost of Goods Sold':
      return { type: 'EXPENSE', subtype: 'COST_OF_SERVICES' };
    case 'Other Expense':
      return { type: 'EXPENSE', subtype: 'OTHER_EXPENSE' };
    default:
      return { type: 'EXPENSE', subtype: 'EXPENSE' };
  }
}

/** QuickBooks' Classification for a site type, for matching by name. */
export function classificationOf(type: string): string {
  return { ASSET: 'Asset', LIABILITY: 'Liability', EQUITY: 'Equity', INCOME: 'Revenue', EXPENSE: 'Expense' }[type] ?? 'Expense';
}
