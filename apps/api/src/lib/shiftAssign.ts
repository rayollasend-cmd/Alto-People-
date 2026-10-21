import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { DEFAULT_TIMEZONE, formatDateInZone, formatTimeInZone } from './timezone.js';
import { assertClientAllowed } from './programRules.js';
import { emitShiftEvent } from './webhookEvents.js';

/**
 * The rules a shift assignment obeys, in one place (agent families step 1).
 *
 *   A supervisor assigning from the schedule (POST /scheduling/shifts/:id/assign)
 *   and the Workforce agent carrying out an approved fill go through the same
 *   checks: the person still works here, the H-2B petition's client, approved
 *   time off and declared days off, no overlapping shift, and the rest gap.
 *   These helpers moved here from routes/scheduling.ts unchanged.
 */

type Db = Prisma.TransactionClient | PrismaClient;

/** Refuse to put someone who no longer works here on a shift. */
export function assertEmployed(a: {
  firstName: string;
  lastName: string;
  deactivatedAt: Date | null;
  separatedAt: Date | null;
}): void {
  if (a.deactivatedAt || a.separatedAt) {
    throw new HttpError(
      409,
      'associate_inactive',
      `${a.firstName} ${a.lastName} is ${a.separatedAt ? 'separated' : 'deactivated'} — reactivate them before scheduling.`,
    );
  }
}

/** The conflicting shift itself, with enough context to NAME it in an
 *  error. "Already has an overlapping shift" was undiagnosable in the
 *  two honest collision cases: an overnight shift that renders under the
 *  PREVIOUS day's column, and a shift at another client that a bounded
 *  supervisor cannot see at all. */
export async function findOverlapExcluding(
  tx: Db,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftIds: string[],
) {
  return tx.shift.findFirst({
    where: {
      id: { notIn: excludeShiftIds },
      assignedAssociateId: associateId,
      status: { notIn: ['CANCELLED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      position: true,
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });
}

/** Minimum rest between consecutive shifts before we make the manager
 *  confirm — the "clopen" guard. Advisory: overridable, never a wall. */
export const REST_GAP_MIN_HOURS = 10;

/**
 * Nearest non-overlapping neighbor shift that would leave this associate
 * under REST_GAP_MIN_HOURS of rest against [startsAt, endsAt]. Overlaps
 * are the hard check's job (findOverlapExcluding); this catches the
 * close-at-11pm-open-at-6am pattern that overlap math waves through.
 */
export async function findRestGapViolation(
  tx: Db,
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  excludeShiftIds: string[],
): Promise<{ gapHours: number; clash: Parameters<typeof describeClash>[0] } | null> {
  const restMs = REST_GAP_MIN_HOURS * 60 * 60 * 1000;
  const neighbor = await tx.shift.findFirst({
    where: {
      id: { notIn: excludeShiftIds },
      assignedAssociateId: associateId,
      status: { notIn: ['CANCELLED'] },
      OR: [
        // Ends within the rest window before this shift starts…
        { endsAt: { gt: new Date(startsAt.getTime() - restMs), lte: startsAt } },
        // …or starts within the rest window after it ends.
        { startsAt: { gte: endsAt, lt: new Date(endsAt.getTime() + restMs) } },
      ],
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      position: true,
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });
  if (!neighbor) return null;
  const gapMs =
    neighbor.endsAt <= startsAt
      ? startsAt.getTime() - neighbor.endsAt.getTime()
      : neighbor.startsAt.getTime() - endsAt.getTime();
  return { gapHours: Math.round((gapMs / 3_600_000) * 10) / 10, clash: neighbor };
}

/** Human-readable identity of a conflicting shift, on the site's clock. */
export function describeClash(clash: {
  startsAt: Date;
  endsAt: Date;
  status: string;
  position: string;
  client: { name: string } | null;
  locationRel: { timezone: string | null } | null;
}): string {
  const tz = clash.locationRel?.timezone ?? DEFAULT_TIMEZONE;
  const overnight = formatDateInZone(clash.startsAt, tz) !== formatDateInZone(clash.endsAt, tz);
  return `${clash.position}${clash.client ? ` at ${clash.client.name}` : ''}, ${formatDateInZone(clash.startsAt, tz)} ${formatTimeInZone(clash.startsAt, tz)} – ${formatTimeInZone(clash.endsAt, tz)}${overnight ? ' (overnight — it runs into the next day)' : ''}${clash.status === 'DRAFT' ? ' [unpublished draft]' : ''}`;
}

/** "YYYY-MM-DD" of an instant as seen in `tz` — for comparing a shift's
 *  window against day-granular records (time off, availability exceptions). */
export function dayKeyInZone(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Which of `associateIds` can't work [startsAt, endsAt) because an APPROVED
 * time-off request or a one-off availability exception covers a store-local
 * day the window touches. Day-granular records live as UTC-midnight dates,
 * so both sides compare as calendar days in the SHIFT's zone.
 */
export async function blockedForWindow(
  associateIds: string[],
  startsAt: Date,
  endsAt: Date,
  tz: string,
  // Pass the transaction client to make check+write atomic (assignment
  // paths); defaults to the pool for advisory reads.
  db: Db = defaultPrisma,
): Promise<Set<string>> {
  if (associateIds.length === 0) return new Set();
  const startDay = new Date(`${dayKeyInZone(startsAt, tz)}T00:00:00Z`);
  const endDay = new Date(`${dayKeyInZone(endsAt, tz)}T00:00:00Z`);
  const [pto, exceptions] = await Promise.all([
    db.timeOffRequest.findMany({
      where: {
        associateId: { in: associateIds },
        status: 'APPROVED',
        startDate: { lte: endDay },
        endDate: { gte: startDay },
      },
      select: { associateId: true },
    }),
    db.availabilityException.findMany({
      where: {
        associateId: { in: associateIds },
        date: { gte: startDay, lte: endDay },
      },
      select: { associateId: true },
    }),
  ]);
  return new Set([
    ...pto.map((r) => r.associateId),
    ...exceptions.map((r) => r.associateId),
  ]);
}
const ASSIGN_INCLUDE = {
  client: { select: { name: true } },
  assignedAssociate: { select: { firstName: true, lastName: true } },
  locationRel: { select: { id: true, name: true, timezone: true } },
} as const;

export type AssignedShift = Prisma.ShiftGetPayload<{ include: typeof ASSIGN_INCLUDE }>;

/**
 * Assign `associate` to `shift` within the rules, atomically: the
 * unavailability, double-booking and rest-gap checks and the write share
 * one transaction so two assigners cannot collide. Throws the same
 * HttpErrors the schedule's assign route always has. Recording the event
 * and notifying are the caller's (who did it differs).
 */
export async function assignWithinRules(
  db: PrismaClient,
  shift: { id: string; clientId: string | null; startsAt: Date; endsAt: Date; locationRel: { timezone: string | null } | null },
  associate: { id: string; firstName: string; lastName: string; deactivatedAt: Date | null; separatedAt: Date | null },
  opts: { actorUserId: string | null; via: string; overrideUnavailability?: boolean; overrideRestGap?: boolean; expectUnassigned?: boolean },
): Promise<AssignedShift> {
  assertEmployed(associate);
  // An H-2B worker may only be scheduled at the client on their petition.
  // The H-2B rule names a client; a client-less shift (a direct employer) is the employer itself, step 4 moves the rule to the employer of record.
  if (shift.clientId) await assertClientAllowed(db, associate, shift.clientId, { actorUserId: opts.actorUserId, via: opts.via, shiftId: shift.id });

  // Conflict + unavailability checks + write in one transaction so two
  // managers can't assign the same associate to overlapping shifts at
  // the same instant, and a day-off/PTO approved between check and write
  // can't be steamrolled (July review: the unavailability check used to
  // run outside the transaction).
  const assigned = await db.$transaction(async (tx) => {
    // Approved time off and one-off days off BLOCK assignment by
    // default — an associate declaring a day unavailable means exactly
    // that. Admins can push through with overrideUnavailability
    // (audited by the caller); an explicit per-assignment decision, never silent.
    if (!opts.overrideUnavailability) {
      const blocked = await blockedForWindow([associate.id], shift.startsAt, shift.endsAt, shift.locationRel?.timezone ?? DEFAULT_TIMEZONE, tx);
      if (blocked.size > 0) {
        throw new HttpError(409, 'associate_unavailable', `${associate.firstName} ${associate.lastName} has approved time off or a declared day off covering this shift.`);
      }
    }
    // Name the conflict: the two honest collision cases — an overnight
    // shift living under the PREVIOUS day's column, and a shift at a
    // client this caller can't see — were undiagnosable from a bare
    // "already has an overlapping shift".
    const clash = await findOverlapExcluding(tx, associate.id, shift.startsAt, shift.endsAt, [shift.id]);
    if (clash) {
      throw new HttpError(409, 'associate_double_booked', `${associate.firstName} ${associate.lastName} already has an overlapping shift: ${describeClash(clash)}.`);
    }
    // Fatigue guard: a legal-but-brutal turnaround (close then open on
    // <10h rest) needs an explicit manager confirm, not a silent save.
    if (!opts.overrideRestGap) {
      const rest = await findRestGapViolation(tx, associate.id, shift.startsAt, shift.endsAt, [shift.id]);
      if (rest) {
        throw new HttpError(409, 'rest_gap', `${associate.firstName} ${associate.lastName} would get only ${rest.gapHours}h rest next to ${describeClash(rest.clash)}.`);
      }
    }
    if (opts.expectUnassigned) {
      // Guarded write: a pick made from a list that may be a minute old
      // must not silently replace whoever filled the shift since — the
      // first person was already told it's theirs.
      const claim = await tx.shift.updateMany({
        where: { id: shift.id, assignedAssociateId: null, status: { in: ['OPEN', 'DRAFT', 'ASSIGNED'] } },
        data: { assignedAssociateId: associate.id, assignedAt: new Date(), status: 'ASSIGNED' },
      });
      if (claim.count === 0) {
        throw new HttpError(409, 'shift_taken', 'Someone filled this shift a moment ago — refresh to see who.');
      }
      return tx.shift.findUniqueOrThrow({ where: { id: shift.id }, include: ASSIGN_INCLUDE });
    }
    return tx.shift.update({
      where: { id: shift.id },
      data: { assignedAssociateId: associate.id, assignedAt: new Date(), status: 'ASSIGNED' },
      include: ASSIGN_INCLUDE,
    });
  });
  // Brief 2-4: shift.changed for every assign, wherever it came from (app, /v1, agents).
  emitShiftEvent(assigned.id, 'assigned');
  return assigned;
}

/**
 * The suggested-people ranking of GET /scheduling/shifts/:id/auto-fill,
 * shared with the Workforce agent's pick: availability matched, no
 * conflict, room before 40 hours; approved time off sinks to the bottom.
 */
export function autoFillScore(f: { matchesAvailability: boolean; noConflict: boolean; wouldExceed40: boolean; onApprovedTimeOff: boolean }): number {
  let score = 0;
  if (f.matchesAvailability) score += 0.5;
  if (f.noConflict) score += 0.3;
  if (!f.wouldExceed40) score += 0.2;
  // PTO is a deliberate plan — force these to the bottom of the list
  // regardless of availability or weekly hours.
  if (f.onApprovedTimeOff) score = 0;
  return score;
}
