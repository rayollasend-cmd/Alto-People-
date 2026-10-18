import { ROLE_CAPABILITIES, type Capability, type Role } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { notifyUser, trackNotificationWork } from '../notify.js';
import { tenantIdForWrite } from '../tenant.js';

/**
 * Tell the people who act on a provider's answer — everyone in the tenant
 * whose role holds the capability. Fire-and-forget, tracked so tests can
 * await it.
 */
async function holders(capability: Capability): Promise<string[]> {
  const roles = (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((r) => ROLE_CAPABILITIES[r].has(capability));
  const users = await prisma.user.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null, role: { in: roles } },
    select: { id: true },
    take: 200,
  });
  return users.map((u) => u.id);
}

export async function notifyCapability(capability: Capability, subject: string, body: string, linkUrl: string, category = 'compliance'): Promise<void> {
  const ids = await holders(capability);
  for (const id of ids) void trackNotificationWork(notifyUser(id, { subject, body, linkUrl, category }));
}

export function notifyCompliance(subject: string, body: string, linkUrl: string): Promise<void> {
  return notifyCapability('manage:compliance', subject, body, linkUrl);
}
