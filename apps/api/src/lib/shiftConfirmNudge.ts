import type { Prisma, PrismaClient } from '@prisma/client';
import { formatShiftLine, notifyShift } from './notifyShift.js';
import { companyWorkweek } from './timeAnomalies.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Published, assigned and not yet "I'll be there" — the chase list's rows. */
export const UNCONFIRMED_SHIFT: Prisma.ShiftWhereInput = {
  status: 'ASSIGNED',
  publishedAt: { not: null },
  assignedAssociateId: { not: null },
  acknowledgedAt: null,
};

/**
 * Send the confirm nudge to every unconfirmed shift `where` reaches —
 * skipping anyone nudged in the last `renudgeAfterHours` so a mashed button
 * (or a supervisor and Hugo both chasing) doesn't spam people. Each shift is
 * claimed before its nudge goes out: a concurrent click or sweep loses.
 * The caller scopes `where` to what the asker may reach.
 */
export async function nudgeUnconfirmedShifts(
  db: Db,
  where: Prisma.ShiftWhereInput,
  actorUserId: string | null,
  now: Date = new Date(),
  renudgeAfterHours = 20,
): Promise<{ nudged: number; scanned: number; firstShiftId: string | null }> {
  const renudgeCutoff = new Date(now.getTime() - renudgeAfterHours * 60 * 60 * 1000);
  const notRecently: Prisma.ShiftWhereInput = { OR: [{ confirmNudgedAt: null }, { confirmNudgedAt: { lt: renudgeCutoff } }] };
  const due = await db.shift.findMany({
    where: { AND: [where, UNCONFIRMED_SHIFT, { startsAt: { gt: now } }, notRecently] },
    orderBy: { startsAt: 'asc' },
    take: 500,
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });

  let nudged = 0;
  for (const shift of due) {
    // Claim before sending — a concurrent click or cron sweep loses.
    const claim = await db.shift.updateMany({
      where: { AND: [{ id: shift.id }, notRecently] },
      data: { confirmNudgedAt: now },
    });
    if (claim.count === 0) continue;
    const line = formatShiftLine({
      position: shift.position,
      clientName: shift.client?.name ?? 'your site',
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      timezone: shift.locationRel?.timezone ?? companyWorkweek().timezone,
    });
    await notifyShift(db, {
      associateId: shift.assignedAssociateId!,
      subject: 'Please confirm your shift',
      body: `Quick tap needed: are you coming to ${line}? Open your schedule and tap "I'll be there" so your supervisor doesn't have to chase you.`,
      category: 'shift_confirm',
      senderUserId: actorUserId,
    });
    nudged += 1;
  }
  return { nudged, scanned: due.length, firstShiftId: due[0]?.id ?? null };
}
