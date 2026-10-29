import type { PrismaClient, Prisma } from '@prisma/client';
import { can, type ClientUpdateInput, type Role } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { dateColumnKey } from './timezone.js';

/**
 * The account fields of a client (CL-A, 2026-10-22): who owns the account,
 * the contract's term, and the legal facts and invoicing terms the Basics
 * card reads. PATCH /clients/:id runs its input through `accountFieldsPatch`
 * and every ClientSummary carries `accountSummaryFields`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The contract dates are DATE columns: their own day. */
const ymd = (d: Date | null | undefined): string | null => (d ? dateColumnKey(d) : null);
const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export interface AccountSummaryRow {
  accountOwnerUserId?: string | null;
  contractStartDate?: Date | null;
  contractEndDate?: Date | null;
  legalName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  zip?: string | null;
  poNumber?: string | null;
  paymentTermsDays?: number;
}

/** The account fields every ClientSummary carries (only the ones the row was read with). */
export function accountSummaryFields(row: AccountSummaryRow) {
  return {
    ...(row.accountOwnerUserId !== undefined ? { accountOwnerUserId: row.accountOwnerUserId } : {}),
    ...(row.contractStartDate !== undefined ? { contractStartDate: ymd(row.contractStartDate) } : {}),
    ...(row.contractEndDate !== undefined ? { contractEndDate: ymd(row.contractEndDate) } : {}),
    ...(row.legalName !== undefined ? { legalName: row.legalName } : {}),
    ...(row.addressLine1 !== undefined ? { addressLine1: row.addressLine1 } : {}),
    ...(row.addressLine2 !== undefined ? { addressLine2: row.addressLine2 } : {}),
    ...(row.city !== undefined ? { city: row.city } : {}),
    ...(row.zip !== undefined ? { zip: row.zip } : {}),
    ...(row.poNumber !== undefined ? { poNumber: row.poNumber } : {}),
    ...(row.paymentTermsDays !== undefined ? { paymentTermsDays: row.paymentTermsDays } : {}),
  };
}

/** Roles that are never an account's owner: the client's own logins and the workforce. */
const NOT_OWNERS: ReadonlySet<Role> = new Set<Role>(['CLIENT_PORTAL', 'ASSOCIATE', 'LIVE_ASN', 'DRIVER', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR']);

/** Can this user own a client account: internal, active, in the tenant, able to open the account. */
export function canOwnAccounts(u: { role: Role; tenantRole?: { capabilities: string[]; deletedAt: Date | null } | null }): boolean {
  if (NOT_OWNERS.has(u.role)) return false;
  const custom = u.tenantRole && !u.tenantRole.deletedAt ? u.tenantRole.capabilities : null;
  return can({ role: u.role, capabilities: custom }, 'view:clients');
}

export const OWNER_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  displayName: true,
  associate: { select: { firstName: true, lastName: true } },
  tenantRole: { select: { capabilities: true, deletedAt: true } },
} satisfies Prisma.UserSelect;

export function ownerName(u: { email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null }): string {
  return u.displayName?.trim() || (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : '') || u.email;
}

export interface AccountPatch {
  data: Prisma.ClientUncheckedUpdateInput;
  /** Set when the owner changes: for the audit row and the activity feed. */
  owner?: { from: string | null; to: string | null; toName: string | null };
  /** Set when the term changes. */
  contract?: { start: string | null; end: string | null };
}

/**
 * Validate and shape the account part of a client PATCH. The owner must be
 * an active internal user of the same tenant who can open client accounts;
 * the contract cannot end before it starts (checked against what is on file
 * when only one side is sent).
 */
export async function accountFieldsPatch(
  db: Db,
  tenantId: string,
  existing: { accountOwnerUserId: string | null; contractStartDate: Date | null; contractEndDate: Date | null },
  input: ClientUpdateInput,
): Promise<AccountPatch> {
  const out: AccountPatch = { data: {} };

  if (input.accountOwnerUserId !== undefined && input.accountOwnerUserId !== existing.accountOwnerUserId) {
    let toName: string | null = null;
    if (input.accountOwnerUserId !== null) {
      const u = await db.user.findFirst({
        where: { id: input.accountOwnerUserId, tenantId, deletedAt: null, status: { not: 'DISABLED' } },
        select: OWNER_SELECT,
      });
      if (!u || !canOwnAccounts(u)) {
        throw new HttpError(400, 'owner_not_internal', 'The account owner must be someone on your team who can open client accounts.');
      }
      toName = ownerName(u);
    }
    out.data.accountOwnerUserId = input.accountOwnerUserId;
    out.owner = { from: existing.accountOwnerUserId, to: input.accountOwnerUserId, toName };
  }

  const startIn = input.contractStartDate;
  const endIn = input.contractEndDate;
  if (startIn !== undefined || endIn !== undefined) {
    const start = startIn !== undefined ? startIn : ymd(existing.contractStartDate);
    const end = endIn !== undefined ? endIn : ymd(existing.contractEndDate);
    for (const v of [startIn, endIn]) {
      if (v && Number.isNaN(day(v).getTime())) throw new HttpError(400, 'invalid_date', `${v} is not a date.`);
    }
    if (start && end && end < start) {
      throw new HttpError(400, 'contract_dates', 'The contract cannot end before it starts.');
    }
    if (startIn !== undefined) out.data.contractStartDate = startIn ? day(startIn) : null;
    if (endIn !== undefined) out.data.contractEndDate = endIn ? day(endIn) : null;
    if (start !== ymd(existing.contractStartDate) || end !== ymd(existing.contractEndDate)) out.contract = { start, end };
  }

  if (input.legalName !== undefined) out.data.legalName = input.legalName || null;
  if (input.addressLine1 !== undefined) out.data.addressLine1 = input.addressLine1 || null;
  if (input.addressLine2 !== undefined) out.data.addressLine2 = input.addressLine2 || null;
  if (input.city !== undefined) out.data.city = input.city || null;
  if (input.zip !== undefined) out.data.zip = input.zip || null;
  return out;
}
