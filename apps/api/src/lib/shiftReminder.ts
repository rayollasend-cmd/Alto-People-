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
import { notifyAllAdmins, notifyClientSupervisors } from './notify.js';
import { recordNoShowAttendance } from './attendance.js';
import { endOfWeekUTC, startOfWeekUTC } from './timeAnomalies.js';

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
  /** "Please confirm" asks sent to associates who haven't acknowledged. */
  confirmNudges: number;
  /** PENDING pickup claims whose shift already started — flipped to EXPIRED. */
  expiredClaims: number;
  /** Shifts flagged to admins as possible no-shows this sweep. */
  noShows: number;
  /** Associates alerted for projected weekly overtime this sweep. */
  otAlerts: number;
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

  // ----- Confirm nudges ---------------------------------------------------
  // Shifts inside the same 24h window whose associate still hasn't tapped
  // "I'll be there": one automatic "please confirm" ask, claim-before-send
  // via confirmNudgedAt (shared with the admin panel's manual nudge-all so
  // neither path double-pesters).
  const unconfirmed = await prisma.shift.findMany({
    where: {
      status: 'ASSIGNED',
      publishedAt: { not: null },
      assignedAssociateId: { not: null },
      acknowledgedAt: null,
      confirmNudgedAt: null,
      startsAt: { gt: now, lte: new Date(now.getTime() + WINDOW_MS) },
    },
    orderBy: { startsAt: 'asc' },
    take: SWEEP_CAP,
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });
  let confirmNudges = 0;
  for (const shift of unconfirmed) {
    try {
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, confirmNudgedAt: null },
        data: { confirmNudgedAt: now },
      });
      if (claim.count === 0) continue;
      await notifyShift(prisma, {
        associateId: shift.assignedAssociateId!,
        subject: 'Please confirm your shift',
        body: `Quick tap needed: are you coming to ${formatShiftLine({
          position: shift.position,
          clientName: shift.client?.name ?? null,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: shift.locationRel?.timezone ?? null,
        })}? Open your schedule and tap "I'll be there".`,
        category: 'shift_confirm',
        senderUserId: null,
      });
      confirmNudges++;
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
  // PERF: one batched "is anyone actually working?" probe for all suspects
  // instead of a findFirst per shift. Earliest shift start bounds the
  // covering-entry window for the whole batch; exact per-shift coverage is
  // re-checked in JS.
  const suspectAssociateIds = [
    ...new Set(suspects.map((s) => s.assignedAssociateId!).filter(Boolean)),
  ];
  const earliestStart = suspects.reduce(
    (min, s) => (s.startsAt < min ? s.startsAt : min),
    now,
  );
  const coveringEntries =
    suspectAssociateIds.length > 0
      ? await prisma.timeEntry.findMany({
          where: {
            associateId: { in: suspectAssociateIds },
            clockInAt: { lte: now },
            OR: [{ clockOutAt: null }, { clockOutAt: { gte: earliestStart } }],
          },
          select: { associateId: true, clockOutAt: true },
        })
      : [];
  const entriesByAssociate = new Map<string, { clockOutAt: Date | null }[]>();
  for (const e of coveringEntries) {
    const arr = entriesByAssociate.get(e.associateId) ?? [];
    arr.push({ clockOutAt: e.clockOutAt });
    entriesByAssociate.set(e.associateId, arr);
  }

  for (const shift of suspects) {
    try {
      // Matcher blind spot: an associate who punched in >2h early (or via
      // an admin-created entry) is working but unlinked. Any open/covering
      // entry means "showed up" — stamp without alerting.
      const working = (entriesByAssociate.get(shift.assignedAssociateId!) ?? []).some(
        (e) => e.clockOutAt === null || e.clockOutAt >= shift.startsAt,
      );
      const claim = await prisma.shift.updateMany({
        where: { id: shift.id, noShowNotifiedAt: null },
        data: { noShowNotifiedAt: now },
      });
      if (claim.count === 0 || working) continue;

      const who = shift.assignedAssociate
        ? `${shift.assignedAssociate.firstName} ${shift.assignedAssociate.lastName}`
        : 'The assigned associate';
      const noShowNotice = {
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
      };
      // Fire-and-forget — both helpers never reject, and the sweep's job
      // is the claim stamp, not the delivery.
      void notifyAllAdmins(noShowNotice);
      // The on-site supervisor is the one person who can physically walk
      // the floor and find (or replace) the associate.
      void notifyClientSupervisors(shift.clientId, noShowNotice);
      // Attendance points: approved time off = excused (no event), a
      // pending same-day request = CALL_OUT, silence = NO_CALL_NO_SHOW.
      void recordNoShowAttendance(prisma, {
        id: shift.id,
        clientId: shift.clientId,
        startsAt: shift.startsAt,
        assignedAssociateId: shift.assignedAssociateId!,
      });
      noShows++;
    } catch (err) {
      errors.push({
        shiftId: shift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----- OT radar ---------------------------------------------------------
  // Projected overtime: worked-so-far + remaining ASSIGNED shift minutes
  // this week > 40h. One alert per (associate, week) via OtAlertStamp —
  // claim-before-notify, same discipline as reminders and no-shows. Warns
  // only; never blocks or reschedules anything.
  let otAlerts = 0;
  try {
    otAlerts = await runOtRadar(prisma, now);
  } catch (err) {
    errors.push({
      shiftId: 'ot-radar',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { scanned: due.length, reminded, confirmNudges, expiredClaims: expired.count, noShows, otAlerts, errors };
}

const OT_THRESHOLD_MIN = 40 * 60;

async function runOtRadar(prisma: PrismaClient, now: Date): Promise<number> {
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  const weekShifts = await prisma.shift.findMany({
    where: {
      status: 'ASSIGNED',
      assignedAssociateId: { not: null },
      startsAt: { gte: weekStart, lt: weekEnd },
    },
    select: {
      assignedAssociateId: true,
      clientId: true,
      startsAt: true,
      endsAt: true,
    },
    take: 5000,
  });
  // Remaining scheduled minutes per associate (rest of a running shift +
  // shifts not yet started). No remainder → the week is already decided.
  const remaining = new Map<string, { min: number; clientId: string }>();
  for (const s of weekShifts) {
    const from = Math.max(s.startsAt.getTime(), now.getTime());
    const min = Math.max(0, (s.endsAt.getTime() - from) / 60_000);
    if (min <= 0) continue;
    const cur = remaining.get(s.assignedAssociateId!);
    remaining.set(s.assignedAssociateId!, {
      min: (cur?.min ?? 0) + min,
      clientId: cur?.clientId ?? s.clientId,
    });
  }
  const candidates = [...remaining.keys()];
  if (candidates.length === 0) return 0;

  const [stamps, entries] = await Promise.all([
    prisma.otAlertStamp.findMany({
      where: { associateId: { in: candidates }, weekStart },
      select: { associateId: true },
    }),
    prisma.timeEntry.findMany({
      where: {
        associateId: { in: candidates },
        status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
        clockInAt: { gte: weekStart },
      },
      select: {
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
      },
      take: 20_000,
    }),
  ]);
  const stamped = new Set(stamps.map((s) => s.associateId));
  const worked = new Map<string, number>();
  for (const e of entries) {
    const end = (e.clockOutAt ?? now).getTime();
    let ms = end - e.clockInAt.getTime();
    for (const b of e.breaks) {
      const bEnd = b.endedAt ? b.endedAt.getTime() : end;
      ms -= Math.max(0, bEnd - b.startedAt.getTime());
    }
    worked.set(e.associateId, (worked.get(e.associateId) ?? 0) + Math.max(0, ms / 60_000));
  }

  let alerts = 0;
  for (const associateId of candidates) {
    if (stamped.has(associateId)) continue;
    const rem = remaining.get(associateId)!;
    const projected = (worked.get(associateId) ?? 0) + rem.min;
    if (projected <= OT_THRESHOLD_MIN) continue;
    // Claim the (associate, week) before notifying.
    try {
      await prisma.otAlertStamp.create({ data: { associateId, weekStart } });
    } catch {
      continue; // concurrent sweep won the claim
    }
    const associate = await prisma.associate.findUnique({
      where: { id: associateId },
      select: { firstName: true, lastName: true },
    });
    if (!associate) continue;
    const otHours = (projected - OT_THRESHOLD_MIN) / 60;
    const otBillRate =
      env.DEFAULT_ASSOCIATE_BILL_RATE > 0 ? env.DEFAULT_ASSOCIATE_BILL_RATE * 1.5 : null;
    const cost = otBillRate ? ` (≈ $${(otHours * otBillRate).toFixed(0)} billed at 1.5×)` : '';
    const notice = {
      subject: `Overtime ahead — ${associate.firstName} ${associate.lastName}`,
      body: `${associate.firstName} ${associate.lastName} is on track for ~${otHours.toFixed(1)}h of overtime this week if their remaining shifts run as scheduled${cost}. Trim or reassign a shift now to avoid it.`,
      category: 'ot_radar',
      linkUrl: '/scheduling',
    };
    void notifyAllAdmins(notice);
    void notifyClientSupervisors(rem.clientId, notice);
    alerts++;
  }
  return alerts;
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
