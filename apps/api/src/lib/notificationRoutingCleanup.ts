import type { PrismaClient } from '@prisma/client';
import { roleWantsCategory } from '@alto-people/shared';

/**
 * One-off cleanup for notifications sent before routing was narrowed
 * (CATEGORY_ROLE_ROUTING in @alto-people/shared): a marketing manager still
 * held dozens of unread compliance and floor alerts that were never theirs.
 *
 * Marks — never deletes — every UNREAD in-app row whose recipient's role the
 * routing now excludes, so the record stays and the badge clears.
 * Idempotent: a second run finds nothing unread to change. Dry run by
 * default; `apply: true` writes.
 */
export async function cleanupMisroutedNotifications(
  prisma: PrismaClient,
  opts: { apply?: boolean; now?: Date } = {},
): Promise<{ scanned: number; misrouted: number; byRole: Record<string, number>; updated: number }> {
  const now = opts.now ?? new Date();
  const byRole: Record<string, number> = {};
  const ids: string[] = [];
  let scanned = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await prisma.notification.findMany({
      where: { channel: 'IN_APP', readAt: null, recipientUserId: { not: null }, category: { not: null } },
      select: { id: true, category: true, recipientUser: { select: { role: true } } },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const n of page) {
      scanned++;
      const role = n.recipientUser?.role;
      if (role && !roleWantsCategory(role, n.category)) {
        ids.push(n.id);
        byRole[role] = (byRole[role] ?? 0) + 1;
      }
    }
    if (page.length < 1000) break;
    cursor = page[page.length - 1]!.id;
  }
  let updated = 0;
  if (opts.apply) {
    for (let i = 0; i < ids.length; i += 500) {
      const r = await prisma.notification.updateMany({
        where: { id: { in: ids.slice(i, i + 500) }, readAt: null },
        data: { status: 'READ', readAt: now, seenAt: now },
      });
      updated += r.count;
    }
  }
  return { scanned, misrouted: ids.length, byRole, updated };
}
