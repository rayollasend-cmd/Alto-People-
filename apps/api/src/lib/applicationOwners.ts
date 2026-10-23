import { prisma } from '../db.js';
import { userDisplayName } from './clientProspects.js';

/**
 * Who owns an application on the onboarding desk: the person who sent the
 * invite — the actor on its `onboarding.application_created` audit event
 * (every invite path writes one: the single invite, bulk invite, the
 * recruiting hand-off). There is no owner column on Application; the event
 * is the record. Imports and seed rows have no event, so they read null
 * ("—"), never a guessed name.
 *
 * Callers pass ids they already read inside the caller's reach, so the
 * lookup adds no reach of its own; it is still held to the tenant.
 */
export async function applicationOwners(
  applicationIds: readonly string[],
  tenantId: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (applicationIds.length === 0) return out;
  const events = await prisma.auditLog.findMany({
    take: 1000,
    where: {
      ...(tenantId ? { tenantId } : {}),
      entityType: 'Application',
      action: 'onboarding.application_created',
      entityId: { in: [...applicationIds] },
      actorUserId: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      entityId: true,
      actorUser: { select: { email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  for (const e of events) {
    if (out.has(e.entityId) || !e.actorUser) continue;
    out.set(e.entityId, userDisplayName(e.actorUser));
  }
  return out;
}
