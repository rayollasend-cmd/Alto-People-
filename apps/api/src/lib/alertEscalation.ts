import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { armJob, stopJob } from './jobs.js';
import { notifyAllAdmins, notifyClientSupervisors } from './notify.js';
import { tenantJob } from './tenantJobs.js';

/**
 * THE STORE'S SUPERVISOR FIRST, THE OFFICE AFTER 30 MINUTES (owner, 2026-11-02).
 *
 *   A possible no-show (15 minutes past the start, no punch) and projected
 *   overtime used to reach HR, Ops and the workforce manager — every one of
 *   them emailed — and the store's supervisors, all at once. In 14 days that
 *   was 1,590 no-show emails to 15 people, up to 36 a day for one of them,
 *   and 1% of the bell copies were ever opened. The one person who can walk
 *   the floor is the store's supervisor; the office only needs to hear when
 *   nobody there picked it up.
 *
 *   alertFloorFirst tells the supervisors of that store. When the store has
 *   none for it, the office hears at once, exactly as before. Otherwise an
 *   AlertEscalation row waits 30 minutes, and the sweep below then
 *     - closes it quietly when it is settled: a supervisor it was addressed
 *       to opened the bell row, or (a no-show) the person clocked in, the
 *       shift was reassigned, cancelled or closed, or the absence is on
 *       record (a call-out, an attendance event);
 *     - otherwise tells the office once, the same words and link, with one
 *       line saying nobody on the floor picked it up.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AlertKind = 'no_show' | 'ot_radar';

/** How long the store's supervisors have before the office hears. */
export const ESCALATE_AFTER_MS = 30 * 60_000;
/** The line the office's copy carries. */
export const ESCALATION_LINE = 'No supervisor has picked this up in 30 minutes.';
const SWEEP_SECONDS = 5 * 60;
// Bound one sweep, like the no-show sweep; the next one drains the rest.
const SWEEP_CAP = 200;
// The no-show sweep's own lookback: an alert twelve hours old is history,
// not something the office can still fix, so a sweep coming back after
// downtime does not wake anyone for it.
const STALE_MS = 12 * 3_600_000;
// Rows are bookkeeping; a month is plenty to answer "who was told when".
const KEEP_MS = 30 * 24 * 3_600_000;

export interface FloorNotice {
  subject: string;
  body: string;
  category: string;
  linkUrl: string;
}

/**
 * Tell the store's supervisors; when the store has none for it, tell the
 * office now. Answers who heard. `notice` is the office's copy (sent now, or
 * kept for the escalation); `supervisorBody` replaces its body for the floor
 * when the two differ (overtime: the hours, never the billed cost).
 */
export async function alertFloorFirst(
  db: Db,
  input: {
    kind: AlertKind;
    clientId: string | null;
    notice: FloorNotice;
    supervisorBody?: string;
    /** As notifyClientSupervisors takes them: the shift window, and who it is about. */
    at?: { locationId: string | null; startsAt: Date } | null;
    aboutAssociateId?: string | null;
    shiftId?: string | null;
    associateId?: string | null;
    weekKey?: string | null;
    now?: Date;
  },
): Promise<'supervisors' | 'office'> {
  const now = input.now ?? new Date();
  const told = await notifyClientSupervisors(input.clientId, {
    ...input.notice,
    ...(input.supervisorBody !== undefined ? { body: input.supervisorBody } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.aboutAssociateId !== undefined ? { aboutAssociateId: input.aboutAssociateId } : {}),
  });
  if (told.length === 0) {
    // Nobody leads that store (or the roster could not be read): the office
    // hears at once, as it always did. Fire-and-forget — the helper never
    // rejects, and the caller's job is its claim stamp, not the delivery.
    void notifyAllAdmins(input.notice);
    return 'office';
  }
  await db.alertEscalation.create({
    data: {
      kind: input.kind,
      shiftId: input.shiftId ?? null,
      associateId: input.associateId ?? null,
      weekKey: input.weekKey ?? null,
      category: input.notice.category,
      linkUrl: input.notice.linkUrl,
      subject: input.notice.subject,
      body: input.notice.body,
      notifiedUserIds: told,
      notifiedAt: now,
      escalateAt: new Date(now.getTime() + ESCALATE_AFTER_MS),
    },
  });
  return 'supervisors';
}

/**
 * Each associate's punches that cover any moment from `since` on: open, or
 * clocked out at or after it. The no-show sweep's "is anyone actually
 * working?" probe — someone who punched in early, or on an entry an admin
 * keyed, is at work though the matcher never linked the punch to the shift.
 * The escalation asks the same question again 30 minutes later.
 */
export async function punchesSince(
  db: Db,
  associateIds: readonly string[],
  since: Date,
  now: Date,
): Promise<Map<string, { clockOutAt: Date | null }[]>> {
  const out = new Map<string, { clockOutAt: Date | null }[]>();
  if (associateIds.length === 0) return out;
  const entries = await db.timeEntry.findMany({
    where: {
      associateId: { in: [...associateIds] },
      clockInAt: { lte: now },
      OR: [{ clockOutAt: null }, { clockOutAt: { gte: since } }],
    },
    select: { associateId: true, clockOutAt: true },
  });
  for (const e of entries) {
    const arr = out.get(e.associateId) ?? [];
    arr.push({ clockOutAt: e.clockOutAt });
    out.set(e.associateId, arr);
  }
  return out;
}

/** True when one of these punches covers the shift's start or later. */
export function workingSince(punches: readonly { clockOutAt: Date | null }[] | undefined, startsAt: Date): boolean {
  return (punches ?? []).some((e) => e.clockOutAt === null || e.clockOutAt >= startsAt);
}

type EscalationRow = {
  id: string;
  kind: string;
  shiftId: string | null;
  associateId: string | null;
  category: string;
  linkUrl: string | null;
  notifiedUserIds: string[];
  notifiedAt: Date;
};

/** The rows a supervisor they were addressed to has opened: the bell copy, read since it went out. */
async function readByTheFloor(db: Db, rows: readonly EscalationRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (rows.length === 0) return out;
  const earliest = rows.reduce((min, r) => (r.notifiedAt < min ? r.notifiedAt : min), rows[0]!.notifiedAt);
  const reads = await db.notification.findMany({
    where: {
      channel: 'IN_APP',
      recipientUserId: { in: [...new Set(rows.flatMap((r) => r.notifiedUserIds))] },
      category: { in: [...new Set(rows.map((r) => r.category))] },
      readAt: { not: null },
      // sentAt, not createdAt: it carries the same clock as notifiedAt.
      sentAt: { gte: earliest },
    },
    select: { recipientUserId: true, category: true, linkUrl: true, sentAt: true },
  });
  for (const r of rows) {
    const hit = reads.some(
      (n) =>
        n.category === r.category &&
        n.linkUrl === r.linkUrl &&
        n.recipientUserId !== null &&
        r.notifiedUserIds.includes(n.recipientUserId) &&
        n.sentAt !== null &&
        n.sentAt >= r.notifiedAt,
    );
    if (hit) out.add(r.id);
  }
  return out;
}

/**
 * Of these no-show rows, the ones whose associate is still missing — the
 * no-show sweep's own test, asked again: the shift is still ASSIGNED to the
 * same person, no punch is linked to it and none of theirs covers it, and
 * nobody has put the absence on record (a confirmed call-out, an attendance
 * event for the shift).
 */
async function stillMissing(db: Db, rows: readonly EscalationRow[], now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(rows.flatMap((r) => (r.shiftId ? [r.shiftId] : [])))];
  if (ids.length === 0) return out;
  const [shifts, attendance, callOuts] = await Promise.all([
    db.shift.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, assignedAssociateId: true, startsAt: true, _count: { select: { timeEntries: true } } },
    }),
    db.attendanceEvent.findMany({ where: { shiftId: { in: ids } }, select: { shiftId: true } }),
    db.callOut.findMany({ where: { shiftId: { in: ids }, status: 'CONFIRMED' }, select: { shiftId: true } }),
  ]);
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const onRecord = new Set([...attendance.map((a) => a.shiftId), ...callOuts.map((c) => c.shiftId)]);
  const earliest = shifts.reduce((min, s) => (s.startsAt < min ? s.startsAt : min), now);
  const punches = await punchesSince(db, [...new Set(rows.flatMap((r) => (r.associateId ? [r.associateId] : [])))], earliest, now);
  for (const r of rows) {
    const s = r.shiftId ? byId.get(r.shiftId) : undefined;
    if (!s || !r.associateId) continue;
    if (s.status !== 'ASSIGNED' || s.assignedAssociateId !== r.associateId) continue; // reassigned, cancelled or closed
    if (s._count.timeEntries > 0) continue; // a punch linked to the shift
    if (workingSince(punches.get(r.associateId), s.startsAt)) continue; // at work, unlinked
    if (onRecord.has(s.id)) continue; // somebody recorded the absence
    out.add(r.id);
  }
  return out;
}

export interface AlertEscalationSweepResult {
  /** Rows the office was told about this sweep. */
  escalated: number;
  /** Rows settled on the floor, closed without a notice. */
  resolved: number;
  /** Rows past their 30 days, removed. */
  removed: number;
}

/** Every five minutes per tenant: escalate what is due and still open, close what was settled. */
export async function runAlertEscalationSweep(
  db: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<AlertEscalationSweepResult> {
  const due = await db.alertEscalation.findMany({
    where: {
      escalatedAt: null,
      resolvedAt: null,
      escalateAt: { lte: now, gte: new Date(now.getTime() - STALE_MS) },
    },
    orderBy: { escalateAt: 'asc' },
    take: SWEEP_CAP,
  });
  const read = await readByTheFloor(db, due);
  const missing = await stillMissing(db, due.filter((r) => r.kind === 'no_show' && !read.has(r.id)), now);

  let escalated = 0;
  let resolved = 0;
  for (const row of due) {
    const settled = read.has(row.id) || (row.kind === 'no_show' && !missing.has(row.id));
    // Claim before acting (count 0 = another sweep got here first), so each
    // row escalates at most once.
    const claim = await db.alertEscalation.updateMany({
      where: { id: row.id, escalatedAt: null, resolvedAt: null },
      data: settled ? { resolvedAt: now } : { escalatedAt: now },
    });
    if (claim.count === 0) continue;
    if (settled) {
      resolved += 1;
      continue;
    }
    void notifyAllAdmins({
      subject: row.subject,
      body: `${row.body}\n\n${ESCALATION_LINE}`,
      category: row.category,
      ...(row.linkUrl ? { linkUrl: row.linkUrl } : {}),
    });
    escalated += 1;
  }

  const removed = await db.alertEscalation.deleteMany({ where: { notifiedAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
  return { escalated, resolved, removed: removed.count };
}

export const ALERT_ESCALATION_JOB = 'alertEscalation';

/** Every five minutes, per tenant. Listed on the Scheduled jobs panel. */
export function startAlertEscalationCron(): void {
  armJob({
    name: ALERT_ESCALATION_JOB,
    label: 'Floor alerts to the office (unanswered after 30 minutes)',
    intervalSeconds: SWEEP_SECONDS,
    run: tenantJob(ALERT_ESCALATION_JOB, runAlertEscalationSweep),
    note: "Possible no-shows and overtime go to the store's supervisors first; still open and unread 30 minutes on, to HR and Ops once.",
  });
}

export function stopAlertEscalationCron(): void {
  stopJob(ALERT_ESCALATION_JOB);
}
