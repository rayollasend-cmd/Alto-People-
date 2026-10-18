import type { Prisma } from '@prisma/client';
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
