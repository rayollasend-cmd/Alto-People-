import type { Role } from '@prisma/client';
import { prisma } from '../db.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { recordCriticalAudit } from './audit.js';

/**
 * Brief 2-3 step 3 — group → role. Okta and Entra assign people to groups,
 * not to Alto role names; an admin maps a group name to a role (built-in,
 * or a custom one narrowing it), and a member of a mapped group holds that
 * role. Several mapped groups: the highest priority wins, then the name.
 *
 * Leaving every mapped group changes nothing: SCIM never demotes on its own
 * (a mis-synced group would otherwise strip a whole department at once);
 * deactivation is the Users endpoint's job. Portal accounts are never
 * touched (their scope is a client and store SCIM cannot express).
 */
export async function applyGroupRoles(tenantId: string, userIds: readonly string[]): Promise<number> {
  if (!userIds.length) return 0;
  const [maps, groups] = await Promise.all([
    prisma.scimGroupRoleMap.findMany({ where: { tenantId }, orderBy: [{ priority: 'desc' }, { groupName: 'asc' }] }),
    prisma.scimGroup.findMany({ where: { tenantId, memberUserIds: { hasSome: [...userIds] } }, select: { displayName: true, memberUserIds: true } }),
  ]);
  if (!maps.length) return 0;
  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] }, tenantId, deletedAt: null },
    select: { id: true, role: true, tenantRoleId: true, additionalRoles: true, activeRole: true },
  });
  let changed = 0;
  for (const u of users) {
    if (u.role === 'CLIENT_PORTAL' || u.role === 'LIVE_ASN') continue;
    const mine = new Set(groups.filter((g) => g.memberUserIds.includes(u.id)).map((g) => g.displayName));
    const win = maps.find((m) => mine.has(m.groupName));
    if (!win) continue;
    if (win.archetype === u.role && (win.tenantRoleId ?? null) === (u.tenantRoleId ?? null)) continue;
    const role: Role = win.archetype;
    const additionalRoles = u.additionalRoles.filter((r) => r !== role);
    const activeStillGranted = !u.activeRole || u.activeRole === role || additionalRoles.includes(u.activeRole);
    await prisma.user.update({
      where: { id: u.id },
      data: {
        role,
        tenantRoleId: win.tenantRoleId,
        additionalRoles,
        ...(activeStillGranted ? {} : { activeRole: null }),
        // A role change ends live sessions, as an admin's does.
        ...(role !== u.role ? { tokenVersion: { increment: 1 } } : {}),
      },
    });
    invalidateUserCache(u.id);
    await recordCriticalAudit(
      {
        actorUserId: null,
        tenantId,
        action: 'permission.changed',
        entityType: 'User',
        entityId: u.id,
        metadata: { actor: 'scim', change: 'scim.group_role', group: win.groupName, before: { role: u.role, tenantRoleId: u.tenantRoleId }, after: { role, tenantRoleId: win.tenantRoleId } },
      },
      'scim.group_role',
    );
    changed++;
  }
  return changed;
}
