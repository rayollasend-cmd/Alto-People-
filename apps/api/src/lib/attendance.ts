import type { Prisma, PrismaClient, Shift } from '@prisma/client';
import { ROLE_CAPABILITIES, type Role } from '@alto-people/shared';
import { emitLiveEvent } from './liveEvents.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Attendance points — rolling 90-day reliability score.
 *
 * Events are written automatically by two existing signal sources (the
 * kiosk clock-out path and the no-show sweep) and scored at READ time
 * against the window, so there is no decay job to run or get wrong.
 * Excusals keep the record but zero its points. Crossing a policy
 * threshold notifies the client's supervisors + org time admins with the
 * suggested disciplinary step — it never auto-issues discipline.
 */

export const ATTENDANCE_WINDOW_DAYS = 90;
/** Punch-in later than this after the linked shift start counts as late. */
export const LATE_GRACE_MS = 7 * 60_000;
/** Punch-out earlier than this before the linked shift end counts as early. */
export const EARLY_OUT_MS = 30 * 60_000;

export const ATTENDANCE_POINTS: Record<string, number> = {
  LATE: 0.5,
  EARLY_OUT: 0.5,
  CALL_OUT: 1.0,
  NO_CALL_NO_SHOW: 2.0,
};

/** Highest-first so the first crossed threshold is the one that fires. */
export const ATTENDANCE_THRESHOLDS: Array<{ score: number; step: string }> = [
  { score: 9, step: 'termination review' },
  { score: 7, step: 'final warning' },
  { score: 5, step: 'written warning' },
  { score: 3, step: 'verbal warning' },
];

const TIME_ADMIN_ROLES = (
  Object.entries(ROLE_CAPABILITIES) as Array<[Role, ReadonlySet<string>]>
)
  .filter(([role, caps]) => caps.has('manage:time') && role !== 'SHIFT_SUPERVISOR')
  .map(([role]) => role);

export function windowStart(asOf = new Date()): Date {
  return new Date(asOf.getTime() - ATTENDANCE_WINDOW_DAYS * 24 * 3_600_000);
}

/** Sum of unexcused points inside the rolling window. */
export async function attendanceScore(
  db: Db,
  associateId: string,
  asOf = new Date(),
): Promise<number> {
  const agg = await db.attendanceEvent.aggregate({
    where: {
      associateId,
      excusedAt: null,
      occurredOn: { gte: windowStart(asOf) },
    },
    _sum: { points: true },
  });
  return Number(agg._sum.points ?? 0);
}

/**
 * Threshold check: fires when the score CROSSED a policy line with this
 * event (before < line ≤ after), so an already-over associate doesn't
 * re-alert on every 0.5. Notification only — a human issues discipline.
 */
async function notifyIfThresholdCrossed(
  db: Db,
  opts: {
    associateId: string;
    associateName: string;
    clientId: string | null;
    scoreBefore: number;
    scoreAfter: number;
  },
): Promise<void> {
  const crossed = ATTENDANCE_THRESHOLDS.find(
    (t) => opts.scoreBefore < t.score && opts.scoreAfter >= t.score,
  );
  if (!crossed) return;
  const recipients = await db.user.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        ...(opts.clientId
          ? [{ role: 'SHIFT_SUPERVISOR' as const, clientId: opts.clientId }]
          : []),
        { role: { in: TIME_ADMIN_ROLES } },
      ],
    },
    select: { id: true },
  });
  if (recipients.length === 0) return;
  const now = new Date();
  await db.notification.createMany({
    data: recipients.map((u) => ({
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      recipientUserId: u.id,
      subject: `Attendance threshold: ${opts.associateName}`,
      body: `${opts.associateName} is at ${opts.scoreAfter} attendance points (rolling 90 days) — policy calls for a ${crossed.step}. Review their attendance record and issue the step if warranted.`,
      category: 'attendance',
      linkUrl: '/time-attendance',
      sentAt: now,
    })),
  });
  for (const u of recipients) emitLiveEvent(u.id, 'notification');
}

async function createEvent(
  db: Db,
  data: {
    associateId: string;
    shiftId: string | null;
    clientId: string | null;
    kind: 'LATE' | 'EARLY_OUT' | 'CALL_OUT' | 'NO_CALL_NO_SHOW';
    occurredOn: Date;
    note?: string;
    associateName: string;
  },
): Promise<void> {
  const scoreBefore = await attendanceScore(db, data.associateId);
  try {
    await db.attendanceEvent.create({
      data: {
        associateId: data.associateId,
        shiftId: data.shiftId,
        clientId: data.clientId,
        kind: data.kind,
        points: ATTENDANCE_POINTS[data.kind],
        occurredOn: data.occurredOn,
        note: data.note ?? null,
      },
    });
  } catch {
    // Unique (shiftId, kind) — a concurrent sweep or replayed clock-out
    // already recorded this signal. Idempotent by design.
    return;
  }
  await notifyIfThresholdCrossed(db, {
    associateId: data.associateId,
    associateName: data.associateName,
    clientId: data.clientId,
    scoreBefore,
    scoreAfter: scoreBefore + ATTENDANCE_POINTS[data.kind],
  });
}

/**
 * Clock-out hook: writes LATE / EARLY_OUT against the entry's linked
 * shift. Fire-and-forget from the punch path — never fails a clock-out.
 */
export async function recordAttendanceForEntry(
  db: Db,
  timeEntryId: string,
): Promise<void> {
  try {
    const entry = await db.timeEntry.findUnique({
      where: { id: timeEntryId },
      select: {
        associateId: true,
        clientId: true,
        clockInAt: true,
        clockOutAt: true,
        shiftId: true,
        shift: { select: { startsAt: true, endsAt: true } },
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    if (!entry?.shift || !entry.shiftId || !entry.clockOutAt) return;
    // They worked it. If an earlier sweep filed a no-call no-show against
    // this shift, that claim is now disproven — withdraw it before writing
    // LATE, so the same shift is never counted as both.
    await withdrawNoShowForShift(db, entry.shiftId);
    const name = `${entry.associate.firstName} ${entry.associate.lastName}`;
    if (entry.clockInAt.getTime() > entry.shift.startsAt.getTime() + LATE_GRACE_MS) {
      const min = Math.round(
        (entry.clockInAt.getTime() - entry.shift.startsAt.getTime()) / 60_000,
      );
      await createEvent(db, {
        associateId: entry.associateId,
        shiftId: entry.shiftId,
        clientId: entry.clientId,
        kind: 'LATE',
        occurredOn: entry.shift.startsAt,
        note: `${min} min after shift start`,
        associateName: name,
      });
    }
    if (entry.clockOutAt.getTime() < entry.shift.endsAt.getTime() - EARLY_OUT_MS) {
      const min = Math.round(
        (entry.shift.endsAt.getTime() - entry.clockOutAt.getTime()) / 60_000,
      );
      await createEvent(db, {
        associateId: entry.associateId,
        shiftId: entry.shiftId,
        clientId: entry.clientId,
        kind: 'EARLY_OUT',
        occurredOn: entry.shift.startsAt,
        note: `left ${min} min before shift end`,
        associateName: name,
      });
    }
  } catch (err) {
    console.warn(
      '[attendance] clock-out hook failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Withdraw a machine-written no-call no-show that the punch record
 * contradicts.
 *
 * A no-show is a claim about a person: they were rostered and never came.
 * The sweep can only ever infer it from the absence of a punch at one
 * moment in time, and punches arrive late for ordinary reasons — the
 * associate badged in after the grace window, the kiosk synced later, an
 * admin keyed the timesheet that evening, or the punch never linked to
 * the shift at all. When the evidence shows up, the claim has to go.
 *
 * Only `source: 'AUTO'` rows are withdrawn. An event a human recorded by
 * hand is a judgment, not an inference, and stands until a human clears
 * it. Deleted rather than excused: "excused" says they missed the shift
 * and were forgiven, which is the same false statement about someone who
 * was on the floor, and the 2.0 points have to come off their score.
 *
 * Never throws — every caller is on a punch path that must not fail.
 */
export async function withdrawNoShowForShift(
  db: Db,
  shiftId: string,
): Promise<number> {
  try {
    const { count } = await db.attendanceEvent.deleteMany({
      where: { shiftId, kind: 'NO_CALL_NO_SHOW', source: 'AUTO' },
    });
    if (count > 0) {
      console.log(
        '[attendance] withdrew no-call no-show — punch evidence arrived',
        JSON.stringify({ shiftId, events: count }),
      );
    }
    return count;
  } catch (err) {
    console.warn(
      '[attendance] no-show withdrawal failed:',
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/** How far back the withdrawal pass re-examines machine-written no-shows. */
const WITHDRAW_LOOKBACK_DAYS = 7;

/**
 * Sweep backstop: re-examine recent AUTO no-call no-shows and withdraw the
 * ones the punch record now contradicts.
 *
 * The record pass already waits for a shift to end, so this catches the
 * evidence that lands afterwards — a timesheet keyed the next morning, a
 * kiosk that syncs a day late, a punch an admin re-pointed at the right
 * shift. Bounded per sweep; returns how many were withdrawn.
 */
export async function withdrawContradictedNoShows(
  db: Db,
  now: Date = new Date(),
  limit = 500,
): Promise<number> {
  const since = new Date(now.getTime() - WITHDRAW_LOOKBACK_DAYS * 86_400_000);
  const events = await db.attendanceEvent.findMany({
    where: {
      kind: 'NO_CALL_NO_SHOW',
      source: 'AUTO',
      occurredOn: { gte: since },
      shiftId: { not: null },
    },
    select: { id: true, associateId: true, shiftId: true },
    take: limit,
  });
  if (events.length === 0) return 0;

  const shifts = await db.shift.findMany({
    where: { id: { in: events.map((e) => e.shiftId!) } },
    select: { id: true, startsAt: true, endsAt: true },
  });
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const entries = await db.timeEntry.findMany({
    where: {
      associateId: { in: [...new Set(events.map((e) => e.associateId))] },
      clockInAt: { gte: since },
    },
    select: { associateId: true, clockInAt: true, clockOutAt: true },
    take: 5000,
  });
  const byAssociate = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byAssociate.get(e.associateId) ?? [];
    arr.push(e);
    byAssociate.set(e.associateId, arr);
  }

  const contradicted = events
    .filter((ev) => {
      const shift = shiftById.get(ev.shiftId!);
      if (!shift) return false;
      return (byAssociate.get(ev.associateId) ?? []).some(
        (t) =>
          t.clockInAt < shift.endsAt &&
          (t.clockOutAt === null || t.clockOutAt > shift.startsAt),
      );
    })
    .map((ev) => ev.id);
  if (contradicted.length === 0) return 0;

  const { count } = await db.attendanceEvent.deleteMany({
    where: { id: { in: contradicted } },
  });
  if (count > 0) {
    console.log(
      '[attendance] withdrew no-call no-shows contradicted by punches',
      JSON.stringify({ events: count }),
    );
  }
  return count;
}

/**
 * No-show sweep hook. An APPROVED time-off request covering the day means
 * the miss is excused entirely (no event). Any other request covering the
 * day (a same-day PENDING call-out) downgrades it to CALL_OUT. Silence is
 * a no-call no-show.
 *
 * Called only once a shift has ENDED with no punch anywhere near it — the
 * 15-minute supervisor alert is a separate pass in shiftReminder.ts.
 */
export async function recordNoShowAttendance(
  db: Db,
  shift: Pick<Shift, 'id' | 'clientId' | 'startsAt'> & {
    assignedAssociateId: string;
  },
): Promise<void> {
  try {
    const day = new Date(shift.startsAt);
    const requests = await db.timeOffRequest.findMany({
      where: {
        associateId: shift.assignedAssociateId,
        startDate: { lte: day },
        endDate: { gte: day },
        status: { in: ['PENDING', 'APPROVED'] },
      },
      select: { status: true },
      take: 5,
    });
    if (requests.some((r) => r.status === 'APPROVED')) return; // excused
    const associate = await db.associate.findUnique({
      where: { id: shift.assignedAssociateId },
      select: { firstName: true, lastName: true },
    });
    if (!associate) return;
    await createEvent(db, {
      associateId: shift.assignedAssociateId,
      shiftId: shift.id,
      clientId: shift.clientId,
      kind: requests.length > 0 ? 'CALL_OUT' : 'NO_CALL_NO_SHOW',
      occurredOn: shift.startsAt,
      associateName: `${associate.firstName} ${associate.lastName}`,
    });
  } catch (err) {
    console.warn(
      '[attendance] no-show hook failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
