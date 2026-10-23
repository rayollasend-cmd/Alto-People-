import type { Vendor } from '@prisma/client';
import type { BooksVendor, BooksVendorInput, BooksVendorUpdate } from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { enqueueAudit } from '../../audit.js';
import { createApprovalRequest, registerApplyHandler, type Decider } from '../../approvalRequests.js';
import { isValidRouting } from '../../banking/nacha.js';
import { decryptString, encryptString } from '../../crypto.js';
import { tenantIdForWrite } from '../../tenant.js';
import { emitBooksChange } from '../events.js';
import { cents, dateOnly, dollars, todayYmd, userNames, ymd, type Db } from './shared.js';

/**
 * Vendors — the people and companies the company pays.
 *
 * The tax ID and the bank details are kept encrypted (lib/crypto) and only
 * their last four digits ever leave the API. Bank details given on a NEW
 * vendor land at once; a CHANGE to an existing vendor's bank details is the
 * classic vendor-fraud move ("we changed banks — please pay here"), so it
 * waits for a second holder of manage:books (VENDOR_BANK approval) and the
 * old account keeps getting paid meanwhile.
 */

export interface SealedBank {
  routingNumberEnc: string;
  accountNumberEnc: string;
  accountLast4: string;
}

export function sealBank(routing: string, account: string): SealedBank {
  if (!isValidRouting(routing)) throw new HttpError(400, 'invalid_routing', 'That routing number does not pass the bank check digit.');
  const acct = account.replace(/\s/g, '');
  if (!/^[0-9A-Za-z-]{4,17}$/.test(acct)) throw new HttpError(400, 'invalid_account', 'Account numbers are 4 to 17 characters.');
  return { routingNumberEnc: encryptString(routing).toString('base64'), accountNumberEnc: encryptString(acct).toString('base64'), accountLast4: acct.slice(-4) };
}

/** The vendor's bank details in the clear — only for building an ACH entry. */
export function vendorBank(v: Pick<Vendor, 'routingNumberEnc' | 'accountNumberEnc'>): { routing: string; account: string } | null {
  if (!v.routingNumberEnc || !v.accountNumberEnc) return null;
  return { routing: decryptString(v.routingNumberEnc), account: decryptString(v.accountNumberEnc) };
}

export async function vendorInReach(db: Db, id: string): Promise<Vendor> {
  const v = /^[0-9a-f-]{36}$/i.test(id) ? await db.vendor.findFirst({ where: { id, tenantId: tenantIdForWrite(), deletedAt: null } }) : null;
  if (!v) throw new HttpError(404, 'vendor_not_found', 'Vendor not found.');
  return v;
}

async function assertExpenseAccount(db: Db, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  const a = await db.ledgerAccount.findFirst({ where: { id: accountId, tenantId: tenantIdForWrite() } });
  if (!a) throw new HttpError(400, 'unknown_account', 'That ledger account does not exist.');
  if (!a.isActive) throw new HttpError(400, 'inactive_account', `${a.code} ${a.name} is inactive.`);
}

/** Open bills owed per vendor (approved or partly paid). */
export async function balancesByVendor(db: Db, vendorIds?: string[]): Promise<Map<string, number>> {
  const rows = await db.bill.groupBy({
    by: ['vendorId'],
    where: { tenantId: tenantIdForWrite(), status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, ...(vendorIds ? { vendorId: { in: vendorIds } } : {}) },
    _sum: { balance: true },
  });
  return new Map(rows.map((r) => [r.vendorId, dollars(cents(r._sum.balance))]));
}

/**
 * What each vendor was paid this calendar year and when it was last paid —
 * every payment not voided (card included: this is cash out the door, not
 * the 1099 total, which leaves card out).
 */
export async function paymentsByVendor(db: Db, vendorIds: string[], now: Date = new Date()): Promise<Map<string, { paidThisYear: number; lastPaidOn: string | null }>> {
  if (vendorIds.length === 0) return new Map();
  const year = todayYmd(now).slice(0, 4);
  const where = { tenantId: tenantIdForWrite(), vendorId: { in: vendorIds }, status: { not: 'VOID' } };
  const [thisYear, last] = await Promise.all([
    db.billPayment.groupBy({ by: ['vendorId'], where: { ...where, paidOn: { gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) } }, _sum: { amount: true } }),
    db.billPayment.groupBy({ by: ['vendorId'], where, _max: { paidOn: true } }),
  ]);
  const out = new Map<string, { paidThisYear: number; lastPaidOn: string | null }>();
  for (const id of vendorIds) out.set(id, { paidThisYear: 0, lastPaidOn: null });
  for (const r of thisYear) out.get(r.vendorId)!.paidThisYear = dollars(cents(r._sum.amount));
  for (const r of last) out.get(r.vendorId)!.lastPaidOn = r._max.paidOn ? ymd(r._max.paidOn) : null;
  return out;
}

export async function shapeVendors(db: Db, vendors: Vendor[]): Promise<BooksVendor[]> {
  if (vendors.length === 0) return [];
  const tenantId = tenantIdForWrite();
  const [balances, paid, accounts, pending] = await Promise.all([
    balancesByVendor(db, vendors.map((v) => v.id)),
    paymentsByVendor(db, vendors.map((v) => v.id)),
    db.ledgerAccount.findMany({ where: { tenantId, id: { in: vendors.map((v) => v.defaultExpenseAccountId).filter((x): x is string => !!x) } }, select: { id: true, code: true, name: true } }),
    db.approvalRequest.findMany({ where: { tenantId, kind: 'VENDOR_BANK', status: 'PENDING', subjectId: { in: vendors.map((v) => v.id) } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const names = await userNames(db, pending.map((p) => p.requesterUserId));
  const acct = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const pendingBy = new Map<string, (typeof pending)[number]>();
  for (const p of pending) if (!pendingBy.has(p.subjectId)) pendingBy.set(p.subjectId, p);
  return vendors.map((v) => {
    const p = pendingBy.get(v.id);
    return {
      id: v.id,
      name: v.name,
      email: v.email,
      phone: v.phone,
      addressLine1: v.addressLine1,
      addressLine2: v.addressLine2,
      city: v.city,
      state: v.state,
      zip: v.zip,
      is1099: v.is1099,
      hasTaxId: !!v.taxIdEnc,
      taxIdLast4: v.taxIdLast4,
      defaultExpenseAccountId: v.defaultExpenseAccountId,
      defaultExpenseAccountName: v.defaultExpenseAccountId ? (acct.get(v.defaultExpenseAccountId) ?? null) : null,
      paymentMethod: v.paymentMethod as BooksVendor['paymentMethod'],
      hasBank: !!(v.routingNumberEnc && v.accountNumberEnc),
      accountLast4: v.accountLast4,
      termsDays: v.termsDays,
      notes: v.notes,
      isActive: v.isActive,
      balance: balances.get(v.id) ?? 0,
      paidThisYear: paid.get(v.id)?.paidThisYear ?? 0,
      lastPaidOn: paid.get(v.id)?.lastPaidOn ?? null,
      pendingBankChange: p
        ? { approvalId: p.id, accountLast4: String((p.proposed as { accountLast4?: string }).accountLast4 ?? ''), requestedAt: p.createdAt.toISOString(), requestedByName: p.requesterUserId ? (names.get(p.requesterUserId) ?? null) : null }
        : null,
      createdAt: v.createdAt.toISOString(),
    };
  });
}

function plainFields(input: BooksVendorUpdate) {
  const data: Record<string, unknown> = {};
  for (const k of ['name', 'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'zip', 'is1099', 'defaultExpenseAccountId', 'paymentMethod', 'termsDays', 'notes', 'isActive'] as const) {
    if (input[k] !== undefined) data[k] = input[k];
  }
  if (input.state !== undefined) data.state = input.state ? input.state.toUpperCase() : null;
  if (input.taxId !== undefined) {
    data.taxIdEnc = input.taxId ? encryptString(input.taxId) : null;
    data.taxIdLast4 = input.taxId ? input.taxId.slice(-4) : null;
  }
  return data;
}

export async function createVendor(db: Db, input: BooksVendorInput, actorUserId: string): Promise<Vendor> {
  await assertExpenseAccount(db, input.defaultExpenseAccountId);
  if (!!input.routingNumber !== !!input.accountNumber) throw new HttpError(400, 'bank_incomplete', 'Give both the routing and the account number, or neither.');
  const bank = input.routingNumber && input.accountNumber ? sealBank(input.routingNumber, input.accountNumber) : null;
  const v = await db.vendor.create({
    data: {
      tenantId: tenantIdForWrite(),
      ...(plainFields(input) as object),
      name: input.name,
      ...(bank ? { routingNumberEnc: Buffer.from(bank.routingNumberEnc, 'base64'), accountNumberEnc: Buffer.from(bank.accountNumberEnc, 'base64'), accountLast4: bank.accountLast4 } : {}),
    },
  });
  enqueueAudit({ actorUserId, clientId: null, action: 'books.vendor_created', entityType: 'Vendor', entityId: v.id, metadata: { name: v.name, is1099: v.is1099, bankLast4: v.accountLast4 } }, 'books.payables');
  emitBooksChange({ localType: 'Vendor', localId: v.id, op: 'UPSERT' });
  return v;
}

/**
 * Update a vendor. Everything but the bank lands now; new bank details on a
 * vendor that already has some go to a second person (202 pending).
 */
export async function updateVendor(db: Db, v: Vendor, input: BooksVendorUpdate, actorUserId: string): Promise<{ vendor: Vendor; pendingApprovalId: string | null }> {
  await assertExpenseAccount(db, input.defaultExpenseAccountId);
  if (!!input.routingNumber !== !!input.accountNumber) throw new HttpError(400, 'bank_incomplete', 'Give both the routing and the account number, or neither.');
  const bank = input.routingNumber && input.accountNumber ? sealBank(input.routingNumber, input.accountNumber) : null;
  const data = plainFields(input);
  let pendingApprovalId: string | null = null;
  if (bank && !v.routingNumberEnc) {
    // First bank details on file: nothing is being redirected.
    Object.assign(data, { routingNumberEnc: Buffer.from(bank.routingNumberEnc, 'base64'), accountNumberEnc: Buffer.from(bank.accountNumberEnc, 'base64'), accountLast4: bank.accountLast4 });
  } else if (bank) {
    const same = vendorBank(v);
    if (!(same && same.routing === input.routingNumber && same.account === input.accountNumber!.replace(/\s/g, ''))) {
      const approval = await createApprovalRequest(db, {
        kind: 'VENDOR_BANK',
        subjectType: 'Vendor',
        subjectId: v.id,
        title: `New bank account for ${v.name}`,
        summary: `Payments to ${v.name} would go to the account ending ${bank.accountLast4} (routing ${input.routingNumber}) instead of the one ending ${v.accountLast4 ?? '—'}. Call the vendor on a number you already had to confirm before approving.`,
        proposed: { vendorId: v.id, ...bank },
        before: { accountLast4: v.accountLast4 },
        requesterUserId: actorUserId,
        approver: { capability: 'manage:books' },
      });
      pendingApprovalId = approval.id;
      enqueueAudit({ actorUserId, clientId: null, action: 'books.vendor_bank_requested', entityType: 'Vendor', entityId: v.id, metadata: { approvalId: approval.id, last4: bank.accountLast4 } }, 'books.payables');
    }
  }
  const updated = Object.keys(data).length ? await db.vendor.update({ where: { id: v.id }, data }) : v;
  if (Object.keys(data).length) {
    enqueueAudit({ actorUserId, clientId: null, action: 'books.vendor_updated', entityType: 'Vendor', entityId: v.id, metadata: { fields: Object.keys(data).map((k) => (k.endsWith('Enc') ? k.replace(/Enc$/, '') : k)) } }, 'books.payables');
    emitBooksChange({ localType: 'Vendor', localId: v.id, op: 'UPSERT' });
  }
  return { vendor: updated, pendingApprovalId };
}

registerApplyHandler('VENDOR_BANK', async (db, row, decider: Decider) => {
  const p = row.proposed as unknown as { vendorId: string } & SealedBank;
  const v = await db.vendor.findFirst({ where: { id: p.vendorId, deletedAt: null } });
  if (!v) throw new Error('The vendor no longer exists.');
  await db.vendor.update({
    where: { id: v.id },
    data: { routingNumberEnc: Buffer.from(p.routingNumberEnc, 'base64'), accountNumberEnc: Buffer.from(p.accountNumberEnc, 'base64'), accountLast4: p.accountLast4 },
  });
  enqueueAudit({ actorUserId: decider.id, clientId: null, action: 'books.vendor_bank_changed', entityType: 'Vendor', entityId: v.id, metadata: { approvalId: row.id, last4: p.accountLast4 } }, 'books.payables');
  emitBooksChange({ localType: 'Vendor', localId: v.id, op: 'UPSERT' });
});
