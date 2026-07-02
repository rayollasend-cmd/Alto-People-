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

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Bound one sweep so a backlog (e.g. cron re-enabled after a week off)
// can't hold a connection for minutes; the next sweep drains the rest.
const SWEEP_CAP = 200;

export interface ShiftReminderSweepResult {
  scanned: number;
  reminded: number;
  errors: { shiftId: string; error: string }[];
}

export async function runShiftReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ShiftReminderSweepResult> {
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
  return { scanned: due.length, reminded, errors };
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
