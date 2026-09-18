import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { DEFAULT_TIMEZONE } from './timezone.js';

/**
 * Which open shifts an associate may pick up — ONE rule for every surface:
 * the Open shifts page (/shifts/open), My schedule's open-shift section
 * (/scheduling/me/open-shifts), the earnings card's "up to ~$X more", and
 * both claim endpoints. The two lists used to disagree: the Open shifts
 * page listed every OPEN shift at every client in the org — unpublished
 * ones included, pay rates and all — filtered only by qualifications, and
 * its claim endpoint took a claim at a client the associate had never
 * worked for.
 *
 *   - OPEN, unassigned, published, starts in the future
 *   - at a client where they're placed: an APPROVED application, or an
 *     open store assignment
 *   - every required qualification held and unexpired
 *   - not overlapping a shift of their own, not on a day they're off
 *     (approved time off, an availability exception) — in the shift's
 *     store timezone
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Clients where the associate is placed. */
export async function placedClientIds(associateId: string, db: Db = prisma): Promise<string[]> {
  const [apps, assignments] = await Promise.all([
    db.application.findMany({
      where: { associateId, status: 'APPROVED', deletedAt: null },
      select: { clientId: true },
    }),
    db.associateAssignment.findMany({
      where: { associateId, endedAt: null },
      select: { location: { select: { clientId: true } } },
    }),
  ]);
  return [...new Set([...apps.map((a) => a.clientId), ...assignments.map((a) => a.location.clientId)])];
}

/** "YYYY-MM-DD" of an instant in `tz` — shifts vs day-granular records. */
function dayKeyInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function liveQualIds(associateId: string, db: Db): Promise<Set<string>> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = await db.associateQualification.findMany({
    take: 500,
    where: { associateId, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gte: today } }] },
    select: { qualificationId: true },
  });
  return new Set(rows.map((q) => q.qualificationId));
}

/** The open shifts the associate may pick up, soonest first (≤ 200). */
export async function eligibleOpenShifts(
  associateId: string,
  opts: { before?: Date; shiftIds?: string[]; db?: Db } = {},
): Promise<Array<{ id: string; startsAt: Date; endsAt: Date }>> {
  const db = opts.db ?? prisma;
  const clientIds = await placedClientIds(associateId, db);
  if (clientIds.length === 0) return [];
  const now = new Date();
  const [rows, quals] = await Promise.all([
    db.shift.findMany({
      where: {
        clientId: { in: clientIds },
        status: 'OPEN',
        assignedAssociateId: null,
        publishedAt: { not: null },
        startsAt: { gt: now, ...(opts.before ? { lt: opts.before } : {}) },
        ...(opts.shiftIds ? { id: { in: opts.shiftIds } } : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: 200,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        locationRel: { select: { timezone: true } },
        qualReqs: { select: { qualificationId: true } },
      },
    }),
    liveQualIds(associateId, db),
  ]);
  const qualified = rows.filter((s) => s.qualReqs.every((r) => quals.has(r.qualificationId)));
  if (qualified.length === 0) return [];

  // Their own schedule and days off across the whole window — one batch,
  // then in-memory filtering (a per-shift query here was a 100-query N+1).
  const horizon = new Date(Math.max(...qualified.map((s) => s.endsAt.getTime())));
  const dayBefore = new Date(now.getTime() - 24 * 3_600_000);
  const [mine, ptoRows, exceptionRows] = await Promise.all([
    db.shift.findMany({
      where: { assignedAssociateId: associateId, status: { notIn: ['CANCELLED'] }, endsAt: { gt: now } },
      select: { startsAt: true, endsAt: true },
    }),
    db.timeOffRequest.findMany({
      where: { associateId, status: 'APPROVED', startDate: { lte: horizon }, endDate: { gte: dayBefore } },
      select: { startDate: true, endDate: true },
    }),
    db.availabilityException.findMany({
      where: { associateId, date: { gte: dayBefore, lte: horizon } },
      select: { date: true },
    }),
  ]);
  const dayOfRow = (d: Date) => d.toISOString().slice(0, 10);
  return qualified
    .filter((s) => {
      if (mine.some((m) => m.startsAt < s.endsAt && m.endsAt > s.startsAt)) return false;
      const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
      const startKey = dayKeyInZone(s.startsAt, tz);
      const endKey = dayKeyInZone(s.endsAt, tz);
      if (ptoRows.some((r) => dayOfRow(r.startDate) <= endKey && dayOfRow(r.endDate) >= startKey)) return false;
      return !exceptionRows.some((x) => {
        const k = dayOfRow(x.date);
        return k >= startKey && k <= endKey;
      });
    })
    .map((s) => ({ id: s.id, startsAt: s.startsAt, endsAt: s.endsAt }));
}

/**
 * The claim-time check, with the reason when it fails — so a claim can
 * never land on a shift the list wouldn't have shown.
 */
export async function assertCanClaimOpenShift(associateId: string, shiftId: string, db: Db = prisma): Promise<void> {
  const shift = await db.shift.findFirst({
    where: {
      id: shiftId,
      status: 'OPEN',
      assignedAssociateId: null,
      publishedAt: { not: null },
      startsAt: { gt: new Date() },
    },
    select: {
      id: true,
      clientId: true,
      startsAt: true,
      endsAt: true,
      locationRel: { select: { timezone: true } },
      qualReqs: { select: { qualificationId: true, qualification: { select: { name: true } } } },
    },
  });
  if (!shift) throw new HttpError(404, 'shift_not_available', 'This shift is no longer open');
  if (!(await placedClientIds(associateId, db)).includes(shift.clientId)) {
    throw new HttpError(403, 'not_placed_at_client', 'You are not placed at this client');
  }
  const quals = await liveQualIds(associateId, db);
  const missing = shift.qualReqs.filter((r) => !quals.has(r.qualificationId));
  if (missing.length > 0) {
    throw new HttpError(
      403,
      'unqualified',
      `Missing required qualifications: ${missing.map((m) => m.qualification.name).join(', ')}.`,
    );
  }
  if ((await eligibleOpenShifts(associateId, { shiftIds: [shift.id], db })).length > 0) return;
  // Placed and qualified, but the list still leaves it out: their own
  // schedule, or a day they're off. Say which.
  const clash = await db.shift.findFirst({
    where: {
      assignedAssociateId: associateId,
      status: { notIn: ['CANCELLED'] },
      startsAt: { lt: shift.endsAt },
      endsAt: { gt: shift.startsAt },
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, 'overlaps_your_schedule', 'This shift overlaps one of yours');
  throw new HttpError(409, 'day_unavailable', 'You have time off or a day off then');
}
