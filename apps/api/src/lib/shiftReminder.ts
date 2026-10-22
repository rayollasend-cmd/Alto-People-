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
import { tenantJob } from './tenantJobs.js';
import { armJob, stopJob } from './jobs.js';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { formatShiftLine, notifyShift, shiftWa } from './notifyShift.js';
import { notifyAllAdmins, notifyClientSupervisors } from './notify.js';
import {
  recordNoShowAttendance,
  withdrawContradictedNoShows,
} from './attendance.js';
import { endOfWeekUTC, startOfWeekUTC } from './timeAnomalies.js';
import { paidMinutesForRange } from '@alto-people/shared';
import { loadLiveRules } from './laborRules/live.js';
import { payFor, plannedEntry, splitHours, sumHours, type HoursEntry } from './laborRules/hours.js';
import { tenantIdForWrite } from './tenant.js';
import { associateWeekLink } from './appLinks.js';

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
// How far back the attendance-record pass looks for shifts that ended.
// Wider than the alert window: a shift that ended overnight still has to
// be judged once, even if nobody was awake to be alerted.
const NO_SHOW_RECORD_LOOKBACK_MS = 36 * 60 * 60 * 1000;

export interface ShiftReminderSweepResult {
  scanned: number;
  reminded: number;
  /** "Please confirm" asks sent to associates who haven't acknowledged. */
  confirmNudges: number;
  /** PENDING pickup claims whose shift already started — flipped to EXPIRED. */
  expiredClaims: number;
  /** Shifts flagged to admins as possible no-shows this sweep. */
  noShows: number;
  /** Ended shifts recorded as attendance no-call no-shows this sweep. */
  noShowsRecorded: number;
  /** Earlier no-shows withdrawn because a punch turned up. */
  noShowsWithdrawn: number;
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
        wa: shiftWa('alto_shift_reminder', { position: shift.position, clientName: shift.client?.name ?? null, locationName: null, startsAt: shift.startsAt, endsAt: shift.endsAt, timezone: shift.locationRel?.timezone ?? null }),
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
        // Their week, on this shift's store — where you'd reassign it.
        linkUrl: associateWeekLink({ associateId: shift.assignedAssociateId!, clientId: shift.clientId, week: shift.startsAt }),
      };
      // Fire-and-forget — both helpers never reject, and the sweep's job
      // is the claim stamp, not the delivery.
      void notifyAllAdmins(noShowNotice);
      // The on-site supervisor is the one person who can physically walk
      // the floor and find (or replace) the associate.
      void notifyClientSupervisors(shift.clientId, {
        ...noShowNotice,
        // The lead of the window this shift starts in walks the floor first
        // — or, when the missing person is a floor supervisor, the shift
        // supervisor in charge of them.
        at: { locationId: shift.locationId, startsAt: shift.startsAt },
        aboutAssociateId: shift.assignedAssociateId,
      });
      // NO attendance event here. Fifteen minutes of silence is a reason
      // to walk the floor, not a finding about the person — they may be
      // in the kiosk queue. The attendance record waits for the shift to
      // end, in the pass below.
      noShows++;
    } catch (err) {
      errors.push({
        shiftId: shift.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----- Attendance record: shifts that ENDED with nobody on them --------
  // A no-call no-show is a claim about a person, so it waits for the only
  // moment the claim can be true: the shift is over and no punch of theirs
  // ever covered it. Stamped via noShowRecordedAt (separate from the alert
  // stamp above) so each shift is judged once.
  let noShowsRecorded = 0;
  try {
    const ended = await prisma.shift.findMany({
      where: {
        status: 'ASSIGNED',
        publishedAt: { not: null },
        assignedAssociateId: { not: null },
        noShowRecordedAt: null,
        endsAt: {
          lte: now,
          gte: new Date(now.getTime() - NO_SHOW_RECORD_LOOKBACK_MS),
        },
        timeEntries: { none: {} },
      },
      orderBy: { endsAt: 'asc' },
      take: SWEEP_CAP,
      select: {
        id: true,
        clientId: true,
        startsAt: true,
        endsAt: true,
        assignedAssociateId: true,
      },
    });
    if (ended.length > 0) {
      // One probe for the whole batch: any punch of theirs overlapping the
      // shift means they worked it, however the entry got there (kiosk
      // synced late, admin keyed the timesheet, matcher never linked it).
      const ids = [...new Set(ended.map((s) => s.assignedAssociateId!))];
      const earliest = ended.reduce(
        (min, s) => (s.startsAt < min ? s.startsAt : min),
        now,
      );
      const entries = await prisma.timeEntry.findMany({
        where: {
          associateId: { in: ids },
          clockInAt: { lte: now },
          OR: [{ clockOutAt: null }, { clockOutAt: { gte: earliest } }],
        },
        select: { associateId: true, clockInAt: true, clockOutAt: true },
      });
      const byAssociate = new Map<string, typeof entries>();
      for (const e of entries) {
        const arr = byAssociate.get(e.associateId) ?? [];
        arr.push(e);
        byAssociate.set(e.associateId, arr);
      }
      for (const shift of ended) {
        try {
          const claim = await prisma.shift.updateMany({
            where: { id: shift.id, noShowRecordedAt: null },
            data: { noShowRecordedAt: now },
          });
          if (claim.count === 0) continue;
          const worked = (byAssociate.get(shift.assignedAssociateId!) ?? []).some(
            (e) =>
              e.clockInAt < shift.endsAt &&
              (e.clockOutAt === null || e.clockOutAt > shift.startsAt),
          );
          if (worked) continue;
          // Approved time off = excused (no event), a pending same-day
          // request = CALL_OUT, silence = NO_CALL_NO_SHOW.
          await recordNoShowAttendance(prisma, {
            id: shift.id,
            clientId: shift.clientId,
            startsAt: shift.startsAt,
            assignedAssociateId: shift.assignedAssociateId!,
          });
          noShowsRecorded++;
        } catch (err) {
          errors.push({
            shiftId: shift.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } catch (err) {
    errors.push({
      shiftId: 'no-show-record',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ----- Withdraw no-shows the punch record has since disproven ----------
  // Backstop for evidence that lands after the record pass ran: a
  // timesheet keyed in the next morning, a kiosk that syncs a day late.
  let noShowsWithdrawn = 0;
  try {
    noShowsWithdrawn = await withdrawContradictedNoShows(prisma, now);
  } catch (err) {
    errors.push({
      shiftId: 'no-show-withdraw',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ----- OT radar ---------------------------------------------------------
  // Projected overtime: worked-so-far + remaining ASSIGNED shifts this week,
  // split by the labor-rules engine as the paycheck will split them (past
  // 40, or a live jurisdiction's daily and double-time rules), land hours in
  // overtime. One alert per (associate, week) via OtAlertStamp —
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

  return {
    scanned: due.length,
    reminded,
    confirmNudges,
    expiredClaims: expired.count,
    noShows,
    noShowsRecorded,
    noShowsWithdrawn,
    otAlerts,
    errors,
  };
}

/** "1.5×", or "1.5× and 2×" when double time is in it — the multipliers the engine priced. */
const multLabel = (s: { overtimeMultiplier: number; doubleMultiplier: number }, dt: number) =>
  dt > 0 ? `${s.overtimeMultiplier}× and ${s.doubleMultiplier}×` : `${s.overtimeMultiplier}×`;

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
      locationRel: { select: { id: true, state: true, city: true, timezone: true } },
    },
    take: 5000,
  });
  // What's still scheduled per associate (rest of a running shift + shifts
  // not yet started), in PAID minutes — the meal the schedule assumes is
  // never projected as worked. No remainder → the week is already decided.
  const remaining = new Map<string, { planned: HoursEntry[]; clientId: string | null }>();
  for (const s of weekShifts) {
    const from = new Date(Math.max(s.startsAt.getTime(), now.getTime()));
    const min = paidMinutesForRange(from, s.endsAt);
    if (min <= 0) continue;
    const cur = remaining.get(s.assignedAssociateId!) ?? { planned: [], clientId: s.clientId };
    cur.planned.push(plannedEntry({ startsAt: from, endsAt: s.endsAt, paidMinutes: min, site: s.locationRel }));
    remaining.set(s.assignedAssociateId!, cur);
  }
  const candidates = [...remaining.keys()];
  if (candidates.length === 0) return 0;

  const [stamps, entries, rules] = await Promise.all([
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
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
        location: { select: { id: true, state: true, city: true, timezone: true } },
      },
      take: 20_000,
    }),
    loadLiveRules(prisma, tenantIdForWrite()),
  ]);
  const stamped = new Set(stamps.map((s) => s.associateId));
  const worked = new Map<string, HoursEntry[]>();
  for (const e of entries) {
    const list = worked.get(e.associateId) ?? [];
    // A punch still open counts to now.
    list.push({ ...e, clockOutAt: e.clockOutAt ?? now, site: e.location });
    worked.set(e.associateId, list);
  }

  let alerts = 0;
  for (const associateId of candidates) {
    if (stamped.has(associateId)) continue;
    const rem = remaining.get(associateId)!;
    // The week as planned, split as the paycheck will split it.
    const split = splitHours(rules, [...(worked.get(associateId) ?? []), ...rem.planned]);
    const total = sumHours(split.entries);
    const otHours = total.overtimeHours + total.doubleTimeHours;
    if (otHours <= 1e-9) continue;
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
    const billRate = env.DEFAULT_ASSOCIATE_BILL_RATE > 0 ? env.DEFAULT_ASSOCIATE_BILL_RATE : null;
    const billed = billRate ? payFor({ regularHours: 0, overtimeHours: total.overtimeHours, doubleTimeHours: total.doubleTimeHours }, billRate, split) : 0;
    const cost = billRate ? ` (≈ $${billed.toFixed(0)} billed at ${multLabel(split, total.doubleTimeHours)})` : '';
    const notice = {
      subject: `Overtime ahead — ${associate.firstName} ${associate.lastName}`,
      body: `${associate.firstName} ${associate.lastName} is on track for ~${otHours.toFixed(1)}h of overtime this week if their remaining shifts run as scheduled${cost}. Trim or reassign a shift now to avoid it.`,
      category: 'ot_radar',
      // Their week, scrolled to their row — where the trimming happens.
      linkUrl: associateWeekLink({ associateId, clientId: rem.clientId, week: weekStart }),
    };
    void notifyAllAdmins(notice);
    // Supervisors get the hours, never the billed cost — money is withheld
    // from store-bound roles (owner decision 2026-09-17).
    void notifyClientSupervisors(rem.clientId, {
      ...notice,
      body: notice.body.replace(cost, ''),
    });
    alerts++;
  }
  return alerts;
}

export const SHIFT_REMINDER_JOB = 'shiftReminder';

/** On by default (SHIFT_REMINDER_INTERVAL_SECONDS=1800); listed on the jobs panel either way. */
export function startShiftReminderCron(): void {
  armJob({
    name: SHIFT_REMINDER_JOB,
    label: 'Shift reminders (day before, confirm asks, no-shows)',
    intervalSeconds: env.SHIFT_REMINDER_INTERVAL_SECONDS,
    run: tenantJob(SHIFT_REMINDER_JOB, runShiftReminderSweep),
    note: 'SHIFT_REMINDER_INTERVAL_SECONDS; each shift is reminded once (Shift.reminderSentAt).',
  });
}

export function stopShiftReminderCron(): void {
  stopJob(SHIFT_REMINDER_JOB);
}
