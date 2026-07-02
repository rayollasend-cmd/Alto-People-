// Day-before shift reminders.
//
// Every sweep finds published, assigned shifts starting within the next
// 24 hours that haven't been reminded yet, claims each one by stamping
// reminderSentAt with a guarded update (so overlapping sweeps or multi-
// replica deployments can't double-send), and notifies the associate via
// notifyShift (bell + email, mute-pref aware).
//
// Shifts assigned less than a day out get their reminder on the next
// sweep after assignment — which doubles as "you were just scheduled for
// tomorrow" coverage on top of the assignment notification.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { formatShiftLine, notifyShift } from './notifyShift.js';
import { notifyAllAdmins } from './notify.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Bound one sweep so a backlog (e.g. cron re-enabled after a week off)
// can't hold a connection for minutes; the next sweep drains the rest.
const SWEEP_CAP = 200;
// How long past the scheduled start before an unlinked shift counts as a
// possible no-show. Covers kiosk queues and "walking in the door" — a
// 5-minute alert would cry wolf every morning.
const NO_SHOW_GRACE_MS = 15 * 60 * 1000;
// Don't alert on ancient shifts when the cron comes back after downtime;
// a 12h-old no-show is history, not something an admin can still fix.
const NO_SHOW_LOOKBACK_MS = 12 * 60 * 60 * 1000;

export interface ShiftReminderSweepResult {
  scanned: number;
  reminded: number;
  /** PENDING pickup claims whose shift already started — flipped to EXPIRED. */
  expiredClaims: number;
  /** Shifts flagged to admins as possible no-shows this sweep. */
  noShows: number;
  errors: { shiftId: string; error: string }[];
}

export async function runShiftReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ShiftReminderSweepResult> {
  // Housekeeping first: a pickup request for a shift that has already
  // started can never be approved sensibly — expire it so the admin
  // queue only shows decisions that still matter. Bulk update, no
  // notifications (the shift is in the past; pinging is just noise).
  const expired = await prisma.openShiftClaim.updateMany({
    where: { status: 'PENDING', shift: { is: { startsAt: { lte: now } } } },
    data: { status: 'EXPIRED', decidedAt: now, decisionNote: 'Shift started' },
  });
  const due = await prisma.shift.findMany({
    where: {
      status: 'ASSIGNED',
      publishedAt: { not: null },
      assignedAssociateId: { not: null },
      reminderSentAt: null,
      startsAt: { gt: now, lte: new Date(now.getTime() + WINDOW_MS) },
    },
    orderBy: { startsAt: 'asc' },
    take: SWEEP_CAP,
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });

  let reminded = 0;
  const errors: { shiftId: string; error: string }[] = [];
  for (const shift of due) {
    try {
      // Claim before sending — count 0 means another sweep got here first.
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claim.count === 0) continue;
      await notifyShift(prisma, {
        associateId: shift.assignedAssociateId!,
        subject: 'Shift reminder',
        body: `You're scheduled soon: ${formatShiftLine({
          position: shift.position,
          clientName: shift.client?.name ?? null,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: shift.locationRel?.timezone ?? null,
        })}`,
        category: 'shift_reminder',
        senderUserId: null,
      });
      reminded++;
    } catch (err) {
      errors.push({
        shiftId: shift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // ----- No-show detection ------------------------------------------------
  // Published, assigned shifts whose start passed >15min ago with NO
  // TimeEntry linked (the punch↔shift matcher links every in-window
  // punch). Claim-before-notify via noShowNotifiedAt, same pattern as
  // reminders, so each shift alerts admins at most once.
  const suspects = await prisma.shift.findMany({
    where: {
      status: 'ASSIGNED',
      publishedAt: { not: null },
      assignedAssociateId: { not: null },
      noShowNotifiedAt: null,
      startsAt: {
        lte: new Date(now.getTime() - NO_SHOW_GRACE_MS),
        gte: new Date(now.getTime() - NO_SHOW_LOOKBACK_MS),
      },
      timeEntries: { none: {} },
    },
    orderBy: { startsAt: 'asc' },
    take: SWEEP_CAP,
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
      assignedAssociate: { select: { firstName: true, lastName: true } },
    },
  });

  let noShows = 0;
  for (const shift of suspects) {
    try {
      // Matcher blind spot: an associate who punched in >2h early (or via
      // an admin-created entry) is working but unlinked. Any open/covering
      // entry means "showed up" — stamp without alerting.
      const working = await prisma.timeEntry.findFirst({
        where: {
          associateId: shift.assignedAssociateId!,
          clockInAt: { lte: now },
          OR: [{ clockOutAt: null }, { clockOutAt: { gte: shift.startsAt } }],
        },
        select: { id: true },
      });
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, noShowNotifiedAt: null },
        data: { noShowNotifiedAt: now },
      });
      if (claim.count === 0 || working) continue;

      const who = shift.assignedAssociate
        ? `${shift.assignedAssociate.firstName} ${shift.assignedAssociate.lastName}`
        : 'The assigned associate';
      await notifyAllAdmins({
        subject: `Possible no-show — ${who}`,
        body: `${who} hasn't clocked in for ${formatShiftLine({
          position: shift.position,
          clientName: shift.client?.name ?? null,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: shift.locationRel?.timezone ?? null,
        })}. Worth a call — the shift started over 15 minutes ago.`,
        category: 'shift_no_show',
        linkUrl: '/scheduling',
      });
      noShows++;
    } catch (err) {
      errors.push({
        shiftId: shift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scanned: due.length, reminded, expiredClaims: expired.count, noShows, errors };
}

let timer: NodeJS.Timeout | null = null;

export function startShiftReminderCron(): void {
  if (timer) return;
  const seconds = env.SHIFT_REMINDER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runShiftReminderSweep().catch((err) => {
    console.error('[alto-people/api] shift reminder sweep failed:', err);
  });
  timer = setInterval(() => {
    void runShiftReminderSweep().catch((err) => {
      console.error('[alto-people/api] shift reminder sweep failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] shift reminder cron armed (every ${seconds}s)`);
}

export function stopShiftReminderCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
