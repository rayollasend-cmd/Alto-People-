import type { Prisma, PrismaClient } from '@prisma/client';
import { benchFor } from './scope.js';
import { blockedForWindow } from './shiftAssign.js';
import { deliveryPrefsFor, deferralFor } from './notificationDelivery.js';
import { notifyUser } from './notify.js';
import { shiftTimezone } from './shiftZone.js';
import { formatDateInZone, formatTimeInZone, zonedDayOfWeek, zonedMinutes } from './timezone.js';

/**
 * Open-shift invitations (role walk, ops 11): who on a shift's bench was
 * asked, how often, and who said no.
 *
 *   - The bench sweep (lib/shiftAutofill) records each first send.
 *   - Rebroadcast re-sends to everyone still eligible who has not declined:
 *     placed there, qualified, no overlapping shift, not on approved time
 *     off or a declared day off, and — when they keep availability on file —
 *     free in that window by their own availability. Nobody is asked twice
 *     inside REBROADCAST_GAP_MS, so a double tap is not a second buzz.
 *   - Quiet hours are the person's own: the bell row lands now, the email
 *     and push wait for the morning (lib/notify → holdIfDeferred). The
 *     result counts those as `held` so the manager is not told "sent" for
 *     a phone that will stay silent until 7.
 *   - "Not for me" on the associate's open-shift card records a decline;
 *     a declined person is never re-asked for that shift.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const INVITE_CATEGORY = 'shift_autofill';
/** A person is not re-sent the same shift within this window. */
export const REBROADCAST_GAP_MS = 30 * 60_000;

export interface InviteCounts {
  shiftId: string;
  /** People asked at least once. */
  sent: number;
  /** People who said "Not for me". */
  declined: number;
  lastSentAt: string | null;
}

export interface RebroadcastResult {
  shiftId: string;
  /** Invitations that went out now (bell, plus email/push unless held). */
  sent: number;
  /** Of `sent`, people inside their quiet hours: the bell now, email and push in the morning. */
  held: number;
  skipped: {
    declined: number;
    timeOff: number;
    unavailable: number;
    unqualified: number;
    recent: number;
  };
  /** Everyone on the bench who could have been asked before the rules above. */
  benchSize: number;
  counts: InviteCounts;
}

export interface InviteShift {
  id: string;
  clientId: string | null;
  locationId: string | null;
  position: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  client: { name: string } | null;
  locationRel: { name: string; timezone: string | null } | null;
}

/** The shift's own clock: its site's zone, else the company's. */
export function inviteZone(shift: Pick<InviteShift, 'locationRel'>): string {
  return shiftTimezone(shift.locationRel);
}

/** The invitation's words, on the store's clock. */
export function inviteMessage(shift: InviteShift, opts: { again?: boolean } = {}): { subject: string; body: string; linkUrl: string } {
  const tz = inviteZone(shift);
  const where = shift.client?.name ?? shift.locationRel?.name ?? shift.location ?? '';
  const when = `${formatDateInZone(shift.startsAt, tz)}, ${formatTimeInZone(shift.startsAt, tz)}–${formatTimeInZone(shift.endsAt, tz)}`;
  return {
    subject: `${opts.again ? 'Still open' : 'Open shift'}: ${shift.position}${where ? ` at ${where}` : ''}`,
    body: `${when}${shift.location ? ` · ${shift.location}` : ''}. First come, first served — tap to claim it.`,
    linkUrl: `/marketplace?shift=${shift.id}`,
  };
}

/** Record one send per person (first send, or another one). */
export async function recordInvites(db: Db, shiftId: string, associateIds: readonly string[], now: Date = new Date()): Promise<void> {
  for (const associateId of associateIds) {
    await db.openShiftInvite.upsert({
      where: { shiftId_associateId: { shiftId, associateId } },
      create: { shiftId, associateId, firstSentAt: now, lastSentAt: now, sendCount: 1 },
      update: { lastSentAt: now, sendCount: { increment: 1 } },
    });
  }
}

/** Sent / declined per shift, for the managers' Open shifts tab. */
export async function inviteCountsFor(db: Db, shiftIds: readonly string[]): Promise<Map<string, InviteCounts>> {
  const out = new Map<string, InviteCounts>();
  for (const id of shiftIds) out.set(id, { shiftId: id, sent: 0, declined: 0, lastSentAt: null });
  if (shiftIds.length === 0) return out;
  const rows = await db.openShiftInvite.findMany({
    where: { shiftId: { in: [...shiftIds] } },
    select: { shiftId: true, sendCount: true, declinedAt: true, lastSentAt: true },
  });
  for (const r of rows) {
    const c = out.get(r.shiftId)!;
    if (r.sendCount > 0) c.sent += 1;
    if (r.declinedAt) c.declined += 1;
    if (r.lastSentAt && (!c.lastSentAt || r.lastSentAt.toISOString() > c.lastSentAt)) c.lastSentAt = r.lastSentAt.toISOString();
  }
  return out;
}

/** True when an availability window on file covers the shift, in the store's zone. */
export function windowCovers(
  windows: ReadonlyArray<{ dayOfWeek: number; startMinute: number; endMinute: number }>,
  shift: { startsAt: Date; endsAt: Date },
  tz: string,
): boolean {
  const dow = zonedDayOfWeek(shift.startsAt, tz);
  const startMin = zonedMinutes(shift.startsAt, tz);
  const endMin = zonedMinutes(shift.endsAt, tz);
  // An overnight shift runs to the end of its first day at least.
  const needEnd = endMin > startMin ? endMin : 1439;
  return windows.some((w) => w.dayOfWeek === dow && w.startMinute <= startMin && w.endMinute >= needEnd);
}

/**
 * Re-send an open shift to its eligible bench. The caller has already
 * checked who may do this and that the shift is in their reach; this
 * refuses a shift that is not open, published and in the future.
 */
export async function rebroadcastOpenShift(
  db: PrismaClient,
  shiftId: string,
  opts: { now?: Date } = {},
): Promise<RebroadcastResult | { refused: 'not_open' | 'started' | 'no_bench' }> {
  const now = opts.now ?? new Date();
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      position: true,
      startsAt: true,
      endsAt: true,
      location: true,
      status: true,
      publishedAt: true,
      assignedAssociateId: true,
      client: { select: { name: true } },
      locationRel: { select: { name: true, timezone: true } },
      qualReqs: { select: { qualificationId: true } },
    },
  });
  if (!shift || shift.status !== 'OPEN' || shift.assignedAssociateId || !shift.publishedAt) return { refused: 'not_open' };
  if (shift.startsAt.getTime() <= now.getTime()) return { refused: 'started' };
  const bench = benchFor(shift);
  if (!bench) return { refused: 'no_bench' };
  const tz = inviteZone(shift);

  // The bench: placed there, a portal login, not already working an overlapping shift.
  const people = await db.associate.findMany({
    where: {
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      AND: [bench],
      user: { is: { role: 'ASSOCIATE', status: 'ACTIVE', deletedAt: null } },
      assignedShifts: { none: { status: { notIn: ['CANCELLED'] }, startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } } },
    },
    select: {
      id: true,
      user: { select: { id: true } },
      availability: { select: { dayOfWeek: true, startMinute: true, endMinute: true } },
    },
    take: 200,
  });
  const ids = people.map((p) => p.id);
  const skipped = { declined: 0, timeOff: 0, unavailable: 0, unqualified: 0, recent: 0 };

  const [existing, blocked, quals] = await Promise.all([
    db.openShiftInvite.findMany({ where: { shiftId: shift.id, associateId: { in: ids } }, select: { associateId: true, declinedAt: true, lastSentAt: true } }),
    blockedForWindow(ids, shift.startsAt, shift.endsAt, tz, db),
    shift.qualReqs.length
      ? db.associateQualification.findMany({
          where: {
            associateId: { in: ids },
            qualificationId: { in: shift.qualReqs.map((q) => q.qualificationId) },
            deletedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
          },
          select: { associateId: true, qualificationId: true },
        })
      : Promise.resolve([]),
  ]);
  const inviteOf = new Map(existing.map((e) => [e.associateId, e]));
  const held = new Map<string, Set<string>>();
  for (const q of quals) held.set(q.associateId, (held.get(q.associateId) ?? new Set()).add(q.qualificationId));

  const toAsk: Array<{ associateId: string; userId: string }> = [];
  for (const p of people) {
    if (!p.user) continue;
    const inv = inviteOf.get(p.id);
    if (inv?.declinedAt) {
      skipped.declined += 1;
      continue;
    }
    if (shift.qualReqs.some((q) => !held.get(p.id)?.has(q.qualificationId))) {
      skipped.unqualified += 1;
      continue;
    }
    if (blocked.has(p.id)) {
      skipped.timeOff += 1;
      continue;
    }
    // Availability on file is the person's own word about when they work;
    // nothing on file is not a "no".
    if (p.availability.length > 0 && !windowCovers(p.availability, shift, tz)) {
      skipped.unavailable += 1;
      continue;
    }
    if (inv?.lastSentAt && now.getTime() - inv.lastSentAt.getTime() < REBROADCAST_GAP_MS) {
      skipped.recent += 1;
      continue;
    }
    toAsk.push({ associateId: p.id, userId: p.user.id });
  }

  const message = inviteMessage(shift, { again: true });
  let heldCount = 0;
  for (const person of toAsk) {
    const prefs = await deliveryPrefsFor(person.userId, db as PrismaClient);
    if (deferralFor(prefs, 'PUSH', { category: INVITE_CATEGORY }, now)?.reason === 'QUIET_HOURS') heldCount += 1;
    await notifyUser(person.userId, { ...message, category: INVITE_CATEGORY });
  }
  await recordInvites(db, shift.id, toAsk.map((p) => p.associateId), now);
  const counts = (await inviteCountsFor(db, [shift.id])).get(shift.id)!;
  return { shiftId: shift.id, sent: toAsk.length, held: heldCount, skipped, benchSize: people.length, counts };
}

/** "Not for me": the associate passes on an open shift. Idempotent. */
export async function declineOpenShift(db: Db, shiftId: string, associateId: string, now: Date = new Date()): Promise<void> {
  await db.openShiftInvite.upsert({
    where: { shiftId_associateId: { shiftId, associateId } },
    create: { shiftId, associateId, declinedAt: now },
    update: { declinedAt: now },
  });
}

/** Undo a "Not for me". */
export async function undoDeclineOpenShift(db: Db, shiftId: string, associateId: string): Promise<void> {
  await db.openShiftInvite.updateMany({ where: { shiftId, associateId }, data: { declinedAt: null } });
}

/** The shifts this associate has passed on, of the given ones. */
export async function declinedShiftIds(db: Db, associateId: string, shiftIds: readonly string[]): Promise<Set<string>> {
  if (shiftIds.length === 0) return new Set();
  const rows = await db.openShiftInvite.findMany({
    where: { associateId, shiftId: { in: [...shiftIds] }, declinedAt: { not: null } },
    select: { shiftId: true },
  });
  return new Set(rows.map((r) => r.shiftId));
}

