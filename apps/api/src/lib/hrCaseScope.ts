import type { Prisma } from '@prisma/client';
import { ROLE_CAPABILITIES, can, type CapabilityHolder, type Role } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { prisma } from '../db.js';
import { scopeAssociatesIncludingFormer } from './scope.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * The HR cases a desk may see: this tenant's, about people inside the
 * caller's reach (a site-scoped HR lead works their sites' cases — and a
 * case outlives the job, so someone who has just left still counts). The
 * case list, its detail, the summary and the Inbox badge all read it.
 */
export function hrCaseReach(user: SessionUser): Prisma.HrCaseWhereInput {
  return { tenantId: tenantIdForWrite(), associate: scopeAssociatesIncludingFormer(user) };
}

/** True when this staff caller may open the case (the person who filed it always may, separately). */
export async function hrCaseInReach(user: SessionUser, caseId: string): Promise<boolean> {
  const hit = await prisma.hrCase.findFirst({ where: { AND: [{ id: caseId }, hrCaseReach(user)] }, select: { id: true } });
  return !!hit;
}

/**
 * What slice of the case desk a staff account works: every case, the
 * PAYROLL category only, or none (PEOPLE-5). HR is the HR-admin family —
 * view:hr-admin AND manage:onboarding (HR administrator, Operations
 * manager, Manager). It used to be manage:onboarding alone, which the
 * recruiter and the workforce manager hold for the onboarding desk: both
 * read harassment cases. The read-only chairman holds view:hr-admin but
 * works no cases. Finance (process:payroll) works the PAYROLL desk. Anyone
 * — these roles included — still files and follows their OWN cases.
 */
export function hrDeskScope(user: CapabilityHolder): 'all' | 'payroll' | null {
  if (can(user, 'view:hr-admin') && can(user, 'manage:onboarding')) return 'all';
  if (can(user, 'process:payroll')) return 'payroll';
  return null;
}

/** May this account work a case of this category? */
export function mayWorkHrCase(user: CapabilityHolder, category: string): boolean {
  const scope = hrDeskScope(user);
  return scope === 'all' || (scope === 'payroll' && category === 'PAYROLL');
}

/** The built-in roles that work some desk — the routing directory's people. */
export function hrDeskRoles(): Role[] {
  return (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) => hrDeskScope({ role: r }) !== null);
}
