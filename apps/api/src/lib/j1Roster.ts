import type { Prisma } from '@prisma/client';
import type { ClearedShift, J1ListResponse, J1Profile } from '@alto-people/shared';
import { prisma } from '../db.js';
import { countWorkforce, readWorkforce, workforceFromQuery, type WorkforceReading } from './complianceWorkforce.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import { scopeAssociates } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { companyWorkweek, orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from './timezone.js';
import { daysBetweenKeys, j1WindowsFor, shiftDays, type J1Window } from './workAuthorization.js';
import type { SessionUser } from '../types/express.js';

/**
 * The J-1 tab's list (GET /compliance/j1), cleared-to-work edition
 * (owner, 2026-11-03). Three J-1s were past their program end and two of
 * them were on upcoming shifts, and nothing on this list said so:
 *
 *   - who: the compliance groups (lib/complianceWorkforce; default the
 *     current workforce), with each group's count and the row's status
 *   - the program end is the one the scheduling block reads
 *     (lib/workAuthorization j1WindowsFor): the later of this profile and an
 *     open J-1 Program record, with the DS-2019's end and the grace end
 *   - daysUntilEnd counts calendar days on the company's clock, so the last
 *     program day reads 0 (it read −1 from noon on: a rounded-down instant)
 *   - the next assigned shift, the first one after the program end
 *     ("Scheduled after program end") and the latest punch after it
 *     ("Worked after program end")
 */

/** No silent cap: J-1 rosters are dozens; this only guards a runaway. */
const J1_LIST_MAX = 5000;

export const J1_INCLUDE = {
  associate: { select: { firstName: true, lastName: true, email: true, photoS3Key: true, photoUpdatedAt: true } },
} as const;

export type RawJ1 = Prisma.J1ProfileGetPayload<{ include: typeof J1_INCLUDE }>;

const SHIFT_SELECT = {
  id: true,
  assignedAssociateId: true,
  startsAt: true,
  endsAt: true,
  position: true,
  client: { select: { name: true } },
  locationRel: { select: { name: true, timezone: true } },
} as const;
type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof SHIFT_SELECT }>;

const toShift = (s: ShiftRow): ClearedShift => ({
  id: s.id,
  startsAt: s.startsAt.toISOString(),
  endsAt: s.endsAt.toISOString(),
  timezone: s.locationRel?.timezone ?? companyWorkweek().timezone,
  position: s.position,
  place: s.locationRel?.name ?? s.client?.name ?? null,
});

/** The rows as the tab shows them: the effective program window, shifts and punches after it. */
export async function j1ProfilesView(rows: RawJ1[], opts: { now?: Date; reading?: WorkforceReading | null } = {}): Promise<J1Profile[]> {
  if (rows.length === 0) return [];
  const now = opts.now ?? new Date();
  const today = orgDateKey(now);
  const ids = rows.map((r) => r.associateId);
  const windows = await j1WindowsFor(prisma, ids);
  const windowOf = (r: RawJ1): J1Window =>
    windows.get(r.associateId) ?? {
      endsOn: dateColumnKey(r.programEndDate),
      startsOn: dateColumnKey(r.programStartDate),
      source: 'profile',
      programId: null,
      ds2019ExpiresOn: null,
      graceEndsOn: addDaysToKey(dateColumnKey(r.programEndDate), 30),
    };
  const tz = companyWorkweek().timezone;
  const [shifts, punches] = await Promise.all([
    prisma.shift.findMany({
      where: { assignedAssociateId: { in: ids }, status: { notIn: ['CANCELLED', 'COMPLETED'] }, endsAt: { gt: now } },
      select: SHIFT_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    }),
    // The latest punch after each person's program end (a day after it, on the company's clock).
    prisma.timeEntry.findMany({
      where: {
        status: { not: 'REJECTED' },
        OR: rows.map((r) => ({ associateId: r.associateId, clockInAt: { gte: utcInstantOfLocalMidnight(addDaysToKey(windowOf(r).endsOn, 1), tz) } })),
      },
      select: { associateId: true, clockInAt: true },
      orderBy: { clockInAt: 'desc' },
      distinct: ['associateId'],
    }),
  ]);
  const shiftsOf = new Map<string, ShiftRow[]>();
  for (const s of shifts) (shiftsOf.get(s.assignedAssociateId!) ?? shiftsOf.set(s.assignedAssociateId!, []).get(s.assignedAssociateId!)!).push(s);
  const workedAfter = new Map(punches.map((p) => [p.associateId, orgDateKey(p.clockInAt)]));
  return rows.map((row) => {
    const w = windowOf(row);
    const mine = shiftsOf.get(row.associateId) ?? [];
    const after = mine.find((s) => shiftDays({ startsAt: s.startsAt, endsAt: s.endsAt, timezone: s.locationRel?.timezone }).last > w.endsOn);
    return {
      id: row.id,
      associateId: row.associateId,
      associateName: `${row.associate.firstName} ${row.associate.lastName}`,
      associateEmail: row.associate.email,
      associatePhotoUrl: profilePhotoUrlFor({ id: row.associateId, ...row.associate }),
      programStartDate: w.startsOn,
      programEndDate: w.endsOn,
      ds2019Number: row.ds2019Number,
      sponsorAgency: row.sponsorAgency,
      visaNumber: row.visaNumber,
      sevisId: row.sevisId,
      country: row.country,
      daysUntilEnd: daysBetweenKeys(today, w.endsOn),
      ...(opts.reading ? { workStatus: opts.reading.statusOf(row.associateId) } : {}),
      programEndSource: w.source,
      ds2019ExpiresOn: w.ds2019ExpiresOn,
      graceEndsOn: w.graceEndsOn,
      nextShift: mine[0] ? toShift(mine[0]) : null,
      scheduledAfterEnd: after ? toShift(after) : null,
      workedAfterEndOn: workedAfter.get(row.associateId) ?? null,
    };
  });
}

/** GET /compliance/j1?workforce=&expiringWithin= — the caller's reach, one group, every group's count. */
export async function j1Roster(user: SessionUser, query: Record<string, unknown>, now: Date = new Date()): Promise<J1ListResponse> {
  const tenantId = tenantIdForWrite();
  const workforce = workforceFromQuery(query);
  const [fetched, reading] = await Promise.all([
    prisma.j1Profile.findMany({
      where: { AND: [{ tenantId }, { associate: { AND: [{ deletedAt: null }, scopeAssociates(user)] } }] },
      orderBy: [{ programEndDate: 'asc' }, { id: 'asc' }],
      take: J1_LIST_MAX + 1,
      include: J1_INCLUDE,
    }),
    readWorkforce(tenantId, now),
  ]);
  const truncated = fetched.length > J1_LIST_MAX;
  const inReach = truncated ? fetched.slice(0, J1_LIST_MAX) : fetched;
  const workforceCounts = countWorkforce(inReach.map((r) => r.associateId), reading);
  let profiles = await j1ProfilesView(inReach.filter((r) => reading.includes(r.associateId, workforce)), { now, reading });
  const within = Number.parseInt(String(query.expiringWithin ?? ''), 10);
  if (Number.isFinite(within)) profiles = profiles.filter((p) => p.daysUntilEnd <= within);
  profiles.sort((a, b) => a.programEndDate.localeCompare(b.programEndDate) || a.id.localeCompare(b.id));
  return { profiles, truncated, workforce, workforceCounts };
}
