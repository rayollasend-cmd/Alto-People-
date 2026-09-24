import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

/**
 * WHO IS COVERING WHOSE TEAM TODAY.
 *
 * A manager's team inbox is scoped by Associate.managerId. Out of office,
 * they name a cover for a date range (TeamDelegation), and for those days
 * the cover's scope widens to include the delegating manager's reports —
 * the same rows, the same actions, the same audit trail under the
 * cover's own name. Nothing is reassigned and nothing is copied; the
 * delegation is a lens, and it closes itself on the end date.
 *
 * "Active" is judged on UTC calendar days, inclusive at both ends, the
 * way people write "out Monday through Friday".
 */

const dayStart = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

/** Delegations currently pointing AT `userId` — the teams they cover. */
export async function activeDelegationsTo(userId: string, now = new Date()) {
  const today = dayStart(now);
  return prisma.teamDelegation.findMany({
    where: { toUserId: userId, startsOn: { lte: today }, endsOn: { gte: today } },
    select: { id: true, fromUserId: true, endsOn: true, from: { select: { associateId: true } } },
  });
}

/** Delegations `userId` has given that are active right now. */
export async function activeDelegationsFrom(userId: string, now = new Date()) {
  const today = dayStart(now);
  return prisma.teamDelegation.findMany({
    where: { fromUserId: userId, startsOn: { lte: today }, endsOn: { gte: today } },
    select: { id: true, toUserId: true, endsOn: true },
  });
}

/**
 * The manager-side associate ids whose direct reports this user may see:
 * their own, plus every manager currently delegating to them.
 */
export async function coveringManagerIds(user: { id: string; associateId: string | null | undefined }, now = new Date()): Promise<string[]> {
  const ids = new Set<string>();
  if (user.associateId) ids.add(user.associateId);
  for (const d of await activeDelegationsTo(user.id, now)) {
    if (d.from.associateId) ids.add(d.from.associateId);
  }
  return [...ids];
}

/** A Prisma `where` for "an associate on a team this user covers". */
export async function teamScope(user: { id: string; associateId: string | null | undefined }): Promise<Prisma.AssociateWhereInput> {
  const ids = await coveringManagerIds(user);
  return { managerId: ids.length > 0 ? { in: ids } : '__none__', deletedAt: null };
}
