import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * The tenant's maker-checker switches (OrgSetting). One rule holds across
 * every switch: a second person is required only where one EXISTS. A
 * one-admin tenant is never locked out of its own payroll or offboarding —
 * the change lands and the audit row says no second approver was available.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface ApprovalPolicy {
  /** A pay-rate change this far (percent) from the current rate needs a second person; 0 = every change. */
  payChangeApprovalPct: number;
  payChangeAlwaysApprove: boolean;
  billRateApproval: boolean;
  separationSecondPerson: boolean;
  selfServiceApproval: boolean;
  roleChangeApproval: boolean;
  requisitionApproval: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  payChangeApprovalPct: 10,
  payChangeAlwaysApprove: false,
  billRateApproval: true,
  separationSecondPerson: true,
  selfServiceApproval: false,
  roleChangeApproval: true,
  requisitionApproval: true,
};

export async function loadApprovalPolicy(db: Db = defaultPrisma, tenantId: string = tenantIdForWrite()): Promise<ApprovalPolicy> {
  const row = await db.orgSetting.findUnique({
    where: { tenantId },
    select: {
      payChangeApprovalPct: true,
      payChangeAlwaysApprove: true,
      billRateApproval: true,
      separationSecondPerson: true,
      selfServiceApproval: true,
      roleChangeApproval: true,
      requisitionApproval: true,
    },
  });
  return row ?? DEFAULT_APPROVAL_POLICY;
}

/** The roles that hold a capability — the people a request can be decided by. */
export function rolesHolding(capability: Capability): Role[] {
  return (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) => ROLE_CAPABILITIES[r].has(capability));
}

/**
 * Is there anyone other than the requester who could decide this? Active
 * accounts holding the capability (by built-in role), the requester left out.
 */
export async function secondPersonExists(db: Db, capability: Capability, excludeUserId: string | null, tenantId: string = tenantIdForWrite()): Promise<boolean> {
  const roles = rolesHolding(capability);
  if (roles.length === 0) return false;
  const n = await db.user.count({
    where: {
      tenantId,
      status: 'ACTIVE',
      deletedAt: null,
      role: { in: roles },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
  return n > 0;
}

/** Does a pay change from `from` to `to` cross the tenant's threshold? */
export function payChangeNeedsApproval(policy: ApprovalPolicy, from: number | null, to: number): boolean {
  if (policy.payChangeAlwaysApprove) return true;
  if (policy.payChangeApprovalPct <= 0) return true;
  // No current rate (a first record) is a hire: nothing to compare against.
  if (from == null || from <= 0) return false;
  const pct = (Math.abs(to - from) / from) * 100;
  return pct > policy.payChangeApprovalPct;
}
