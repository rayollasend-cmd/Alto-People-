import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * How early an associate can punch in and still count as working the
 * upcoming shift. Two hours covers "showed up on the early bus" without
 * swallowing a genuinely separate earlier shift — back-to-back shifts
 * disambiguate by nearest-start below anyway.
 */
const EARLY_WINDOW_MS = 2 * 3_600_000;

/**
 * Punch↔shift link: find the scheduled shift a punch fulfills.
 *
 * Matches the associate's ASSIGNED shift whose window — widened by the
 * early-arrival allowance — covers the punch instant. When two shifts
 * qualify (short gap between back-to-back shifts), the one whose start
 * is CLOSEST to the punch wins: punching during shift A's tail but near
 * shift B's start means "here for B".
 *
 * Returns the shift id or null (unscheduled punch). Never throws for
 * "no match" — an unlinked entry is normal, not an error. Cancelled and
 * draft shifts never match; unpublished-but-assigned ones do, so a
 * schedule an admin forgot to publish still reconciles.
 */
export async function matchShiftForPunch(
  db: Db,
  associateId: string,
  at: Date,
): Promise<string | null> {
  const candidates = await db.shift.findMany({
    where: {
      assignedAssociateId: associateId,
      status: 'ASSIGNED',
      startsAt: { lte: new Date(at.getTime() + EARLY_WINDOW_MS) },
      endsAt: { gte: at },
    },
    select: { id: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: 'asc' },
    take: 10,
  });

  let best: { id: string; distance: number } | null = null;
  for (const s of candidates) {
    // The punch must fall inside [startsAt - early window, endsAt].
    if (at.getTime() < s.startsAt.getTime() - EARLY_WINDOW_MS) continue;
    if (at.getTime() > s.endsAt.getTime()) continue;
    const distance = Math.abs(at.getTime() - s.startsAt.getTime());
    if (!best || distance < best.distance) best = { id: s.id, distance };
  }
  return best?.id ?? null;
}
