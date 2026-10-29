import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { attendanceScore, ATTENDANCE_WINDOW_DAYS, windowStart } from '../lib/attendance.js';
import { internalSites, isClientBoundedRole, scopeActiveAssociates, scopeQualifications, scopeShifts, scopeWhere } from '../lib/scope.js';
import { shiftTimezone } from '../lib/shiftZone.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import type { SessionUser } from '../types/express.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * The crew card (FLOOR-17, 2026-10-29) — one person the caller runs the
 * floor with, read-only: how to reach them, when they can work, what
 * they're certified for, how reliable they've been, their next shifts and
 * who to call in an emergency.
 *
 * Built for the shift supervisor, who leads a client's crew but holds no
 * view:org — the full record (/people/:id) answers her "You don't have
 * access", so at the moment she's deciding who to call she had nothing.
 * Gated on message:crew (the field leads who reach their crew); the
 * person must be inside the caller's reach (scopeActiveAssociates: a
 * client-bound supervisor resolves only her client's roster) or it 404s,
 * revealing nothing.
 *
 * Never on this card: pay, compensation, tax, bank, SSN, address, date of
 * birth, time-off reasons, documents. Those stay on the record, behind
 * view:org and the pay capabilities.
 */

export const crewRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_ID = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 86_400_000;
/** A credential expiring within this many days reads "expiring". */
const EXPIRING_DAYS = 30;

/** The sites the caller may name — a client-bound lead sees her client's stores, never another client's. */
function siteReach(user: SessionUser): Prisma.SiteWhereInput {
  if (isClientBoundedRole(user)) {
    if (user.clientId) return { clientId: user.clientId };
    if (user.locationId) return { id: user.locationId };
    return { id: NO_ID };
  }
  return internalSites(user) ?? {};
}

/** A DATE column (stored as UTC midnight) as the calendar day it names — not a "today". */
const dateKey = (d: Date | null | undefined) => (d ? dateColumnKey(d) : null);

crewRouter.get('/:associateId', requireCapability('message:crew'), async (req, res, next) => {
  try {
    const user = req.user!;
    const id = String(req.params.associateId ?? '');
    if (!UUID_RE.test(id)) throw new HttpError(404, 'not_found', 'Not found.');
    const tenantId = tenantIdForWrite();

    const person = await prisma.associate.findFirst({
      where: { AND: [{ id }, scopeActiveAssociates(user)] },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        hireDate: true,
        photoS3Key: true,
        user: { select: { id: true, status: true } },
      },
    });
    if (!person) throw new HttpError(404, 'not_found', 'Not found.');

    const now = new Date();
    const today = orgDateKey(now);
    const todayDate = new Date(`${today}T00:00:00Z`);
    const in30 = new Date(todayDate.getTime() + 30 * DAY_MS);
    const since = windowStart(now);

    const [sites, emergency, weekly, exceptions, timeOff, creds, events, points, upcoming, recent, onClock] = await Promise.all([
      prisma.associateAssignment.findMany({
        where: { tenantId, associateId: id, endedAt: null, location: { is: siteReach(user) } },
        select: { location: { select: { id: true, name: true, timezone: true } } },
        orderBy: { startedAt: 'asc' },
        take: 20,
      }),
      prisma.emergencyContact.findMany({
        where: { tenantId, associateId: id, deletedAt: null },
        select: { name: true, relation: true, phone: true, isPrimary: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        take: 2,
      }),
      prisma.associateAvailability.findMany({
        where: { tenantId, associateId: id },
        select: { dayOfWeek: true, startMinute: true, endMinute: true },
        orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
        take: 100,
      }),
      prisma.availabilityException.findMany({
        where: { tenantId, associateId: id, date: { gte: todayDate, lt: in30 } },
        select: { date: true },
        orderBy: { date: 'asc' },
        take: 30,
      }),
      // Approved time off ahead — the dates only, never the reason.
      prisma.timeOffRequest.findMany({
        where: { tenantId, associateId: id, status: 'APPROVED', endDate: { gte: todayDate }, startDate: { lt: in30 } },
        select: { startDate: true, endDate: true },
        orderBy: { startDate: 'asc' },
        take: 10,
      }),
      prisma.associateQualification.findMany({
        where: { tenantId, associateId: id, deletedAt: null, qualification: { is: scopeWhere<Prisma.QualificationWhereInput>({ deletedAt: null }, scopeQualifications(user)) } },
        select: { id: true, acquiredAt: true, expiresAt: true, qualification: { select: { name: true, isCert: true } } },
        take: 100,
      }),
      prisma.attendanceEvent.findMany({
        where: { tenantId, associateId: id, occurredOn: { gte: since } },
        select: { id: true, kind: true, occurredOn: true, excusedAt: true, points: true },
        orderBy: { occurredOn: 'desc' },
        take: 50,
      }),
      attendanceScore(prisma, id, now),
      prisma.shift.findMany({
        where: scopeWhere<Prisma.ShiftWhereInput>(
          { tenantId, assignedAssociateId: id, status: { in: ['ASSIGNED', 'COMPLETED'] }, publishedAt: { not: null }, endsAt: { gt: now } },
          scopeShifts(user),
        ),
        select: { id: true, startsAt: true, endsAt: true, position: true, locationRel: { select: { name: true, timezone: true } } },
        orderBy: { startsAt: 'asc' },
        take: 3,
      }),
      prisma.shift.findFirst({
        where: scopeWhere<Prisma.ShiftWhereInput>(
          { tenantId, assignedAssociateId: id, status: { in: ['ASSIGNED', 'COMPLETED'] }, publishedAt: { not: null }, endsAt: { lte: now } },
          scopeShifts(user),
        ),
        select: { position: true },
        orderBy: { startsAt: 'desc' },
      }),
      prisma.timeEntry.findFirst({
        where: { tenantId, associateId: id, status: 'ACTIVE' },
        select: { clockInAt: true, location: { select: { timezone: true } } },
        orderBy: { clockInAt: 'desc' },
      }),
    ]);

    const count = (kind: string) => events.filter((e) => e.kind === kind && !e.excusedAt).length;
    const credentials = creds
      .map((c) => {
        const expires = c.expiresAt;
        const status: 'valid' | 'expiring' | 'expired' = !expires
          ? 'valid'
          : expires.getTime() < todayDate.getTime()
            ? 'expired'
            : expires.getTime() < todayDate.getTime() + EXPIRING_DAYS * DAY_MS
              ? 'expiring'
              : 'valid';
        return { id: c.id, name: c.qualification.name, isCert: c.qualification.isCert, acquiredOn: dateKey(c.acquiredAt), expiresOn: dateKey(expires), status };
      })
      // Expired first, then expiring, then by name — what needs her eye on top.
      .sort((a, b) => {
        const rank = { expired: 0, expiring: 1, valid: 2 } as const;
        return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
      });
    const primary = emergency[0] ?? null;

    res.json({
      id: person.id,
      firstName: person.firstName,
      lastName: person.lastName,
      name: `${person.firstName} ${person.lastName}`.trim(),
      hasPhoto: !!person.photoS3Key,
      position: upcoming[0]?.position ?? recent?.position ?? null,
      hireDate: dateKey(person.hireDate),
      contact: {
        phone: person.phone ?? null,
        email: person.email,
        // The in-app thread: only with someone who can sign in.
        messageUserId: person.user && person.user.status === 'ACTIVE' ? person.user.id : null,
      },
      sites: sites.map((s) => ({ id: s.location.id, name: s.location.name, timezone: shiftTimezone(s.location) })),
      onClock: onClock ? { since: onClock.clockInAt.toISOString(), timezone: shiftTimezone(onClock.location) } : null,
      nextShifts: upcoming.map((s) => ({
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        position: s.position,
        siteName: s.locationRel?.name ?? null,
        timezone: shiftTimezone(s.locationRel),
      })),
      availability: {
        weekly: weekly.map((w) => ({ dayOfWeek: w.dayOfWeek, startMinute: w.startMinute, endMinute: w.endMinute })),
        unavailableDates: exceptions.map((e) => dateKey(e.date)!),
        timeOff: timeOff.map((t) => ({ from: dateKey(t.startDate)!, to: dateKey(t.endDate)! })),
      },
      credentials,
      attendance: {
        points,
        windowDays: ATTENDANCE_WINDOW_DAYS,
        late: count('LATE'),
        earlyOut: count('EARLY_OUT'),
        callOuts: count('CALL_OUT'),
        noShows: count('NO_CALL_NO_SHOW'),
        recent: events.slice(0, 5).map((e) => ({ id: e.id, kind: e.kind, on: dateKey(e.occurredOn)!, excused: !!e.excusedAt })),
      },
      emergencyContact: primary ? { name: primary.name, relation: primary.relation, phone: primary.phone } : null,
      today,
    });
  } catch (err) {
    next(err);
  }
});
