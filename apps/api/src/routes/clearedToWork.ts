import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  ClearedListResponseSchema,
  type ClearedException,
  type ClearedOverride,
  type ClearedRow,
  type ClearedShift,
  type WorkBlocker,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { scopeAssociates } from '../lib/scope.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { countWorkforce, readWorkforce, workforceFromQuery } from '../lib/complianceWorkforce.js';
import { peopleStandings } from '../lib/peopleStatus.js';
import { fmtDay, fmtDayInZone } from '../lib/humanDates.js';
import { companyWorkweek, orgDateKey } from '../lib/timeAnomalies.js';
import {
  authorizationFactsFor,
  blockersForShift,
  clearanceFactsFor,
  evaluateClearance,
  shiftDays,
  type AuthorizationFacts,
} from '../lib/workAuthorization.js';
import type { SessionUser } from '../types/express.js';

/**
 * CLEARED TO WORK (owner, 2026-11-03) — GET /compliance/cleared?workforce=
 *
 * One row per person in the chosen group (default: the current workforce),
 * in the caller's reach: Cleared / Needs attention / Not cleared, with the
 * I-9, E-Verify, work authorization, J-1 program, background check and drug
 * test each as done / due / missing / not required (lib/workAuthorization).
 *
 * Above the table, the exceptions queue: what stops people working first —
 * a blocker, and anyone still SCHEDULED on or after the day their right to
 * work ends — then the warnings and the deadlines ahead, by date. Each item
 * links to the tab that fixes it. Below it, the scheduling overrides of the
 * last 90 days (audit rows `work_authorization.override`).
 *
 * The Inbox's "Scheduled but not cleared to work" count reads
 * scheduledNotCleared() below: the same people the tab's "Scheduled after
 * authorization ends" filter shows on the current workforce.
 *
 * Mounted at /compliance/cleared behind view:compliance (app.ts).
 */
export const clearedToWorkRouter = Router();

const DAY_MS = 86_400_000;
const OVERRIDE_WINDOW_DAYS = 90;

/** Assigned shifts that haven't ended (and weren't cancelled or completed). */
function upcomingWhere(ids: string[], now: Date): Prisma.ShiftWhereInput {
  return { assignedAssociateId: { in: ids }, status: { notIn: ['CANCELLED', 'COMPLETED'] }, endsAt: { gt: now } };
}

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

function toShift(s: ShiftRow): ClearedShift {
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    timezone: s.locationRel?.timezone ?? companyWorkweek().timezone,
    position: s.position,
    place: s.locationRel?.name ?? s.client?.name ?? null,
  };
}

async function upcomingShiftsOf(ids: string[], now: Date): Promise<Map<string, ShiftRow[]>> {
  const out = new Map<string, ShiftRow[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.shift.findMany({ where: upcomingWhere(ids, now), select: SHIFT_SELECT, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] });
  for (const s of rows) {
    const id = s.assignedAssociateId!;
    (out.get(id) ?? out.set(id, []).get(id)!).push(s);
  }
  return out;
}

/** The person's upcoming shifts that fall on a day they may not work, with what blocks the first. */
function shiftsPastClearance(f: AuthorizationFacts, shifts: ShiftRow[], now: Date): { shifts: ShiftRow[]; blockers: WorkBlocker[] } {
  let first: WorkBlocker[] = [];
  const out: ShiftRow[] = [];
  for (const s of shifts) {
    const b = blockersForShift(f, { startsAt: s.startsAt, endsAt: s.endsAt, timezone: s.locationRel?.timezone }, now, 'hr');
    if (b.length === 0) continue;
    if (out.length === 0) first = b;
    out.push(s);
  }
  return { shifts: out, blockers: first };
}

/** People who could ever be blocked: an expiring authorization, a J-1, or a final nonconfirmation. */
const MAY_BE_BLOCKED: Prisma.AssociateWhereInput = {
  OR: [
    { i9Verification: { is: { OR: [{ citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: { not: null } }, { eVerifyStatus: 'FINAL_NONCONFIRMATION' }] } } },
    { j1Profile: { isNot: null } },
    { programs: { some: { type: 'J1_SWT', closedAt: null } } },
  ],
};

/**
 * The Inbox count: people in the current workforce, in the caller's reach,
 * with an assigned shift ahead on or after the day their right to work ends.
 */
export async function scheduledNotCleared(user: SessionUser, now: Date = new Date()): Promise<{ count: number; firstDay: string | null; names: string[] }> {
  const tenantId = tenantIdForWrite();
  const candidates = await prisma.associate.findMany({
    where: { AND: [{ tenantId, deletedAt: null }, scopeAssociates(user), MAY_BE_BLOCKED, { assignedShifts: { some: { status: { notIn: ['CANCELLED', 'COMPLETED'] }, endsAt: { gt: now } } } }] },
    select: { id: true },
  });
  const ids = candidates.map((c) => c.id);
  if (ids.length === 0) return { count: 0, firstDay: null, names: [] };
  const standings = await peopleStandings({ tenantId, associateIds: ids }, now);
  const current = ids.filter((id) => {
    const s = standings.people.get(id)?.status;
    return s === 'ACTIVE' || s === 'PLACED_NOT_ACTIVE' || s === 'NOT_PLACED';
  });
  const [facts, shifts] = await Promise.all([authorizationFactsFor(prisma, current), upcomingShiftsOf(current, now)]);
  let count = 0;
  let firstDay: string | null = null;
  const names: string[] = [];
  for (const id of current) {
    const f = facts.get(id);
    if (!f) continue;
    const past = shiftsPastClearance(f, shifts.get(id) ?? [], now);
    if (past.shifts.length === 0) continue;
    count += 1;
    names.push(f.name);
    const s = past.shifts[0]!;
    const day = shiftDays({ startsAt: s.startsAt, endsAt: s.endsAt, timezone: s.locationRel?.timezone }).first;
    if (!firstDay || day < firstDay) firstDay = day;
  }
  return { count, firstDay, names };
}

function shiftWords(s: ShiftRow): string {
  const tz = s.locationRel?.timezone ?? companyWorkweek().timezone;
  const place = s.locationRel?.name ?? s.client?.name;
  return `${fmtDayInZone(s.startsAt, tz, { weekday: true })} (${s.position}${place ? ` at ${place}` : ''})`;
}

const SEVERITY_RANK = { blocker: 0, scheduled: 0, warning: 1, upcoming: 1 } as const;

clearedToWorkRouter.get('/', async (req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const workforce = workforceFromQuery(req.query);
    const now = new Date();
    const today = orgDateKey(now);
    const [people, reading] = await Promise.all([
      prisma.associate.findMany({
        where: { AND: [{ tenantId, deletedAt: null }, scopeAssociates(req.user!)] },
        select: { id: true, firstName: true, lastName: true, email: true, photoS3Key: true, photoUpdatedAt: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      }),
      readWorkforce(tenantId, now),
    ]);
    const workforceCounts = countWorkforce(people.map((p) => p.id), reading);
    const shown = people.filter((p) => reading.includes(p.id, workforce));
    const ids = shown.map((p) => p.id);
    const [facts, shifts] = await Promise.all([clearanceFactsFor(prisma, tenantId, ids), upcomingShiftsOf(ids, now)]);

    const rows: ClearedRow[] = [];
    const exceptions: ClearedException[] = [];
    for (const p of shown) {
      const f = facts.get(p.id);
      if (!f) continue;
      const c = evaluateClearance(f, today, today);
      const mine = shifts.get(p.id) ?? [];
      const past = shiftsPastClearance(f, mine, now);
      const name = f.name;
      rows.push({
        associateId: p.id,
        associateName: name,
        associateEmail: p.email,
        associatePhotoUrl: profilePhotoUrlFor(p),
        workStatus: reading.statusOf(p.id),
        standing: c.standing,
        ...c.cells,
        blockers: c.blockers,
        warnings: c.warnings,
        upcoming: c.upcoming,
        nextShift: mine[0] ? toShift(mine[0]) : null,
        scheduledAfterBlock: past.shifts.map(toShift),
      });
      for (const b of c.blockers) {
        exceptions.push({ associateId: p.id, associateName: name, severity: 'blocker', kind: b.kind, date: b.endsOn, message: b.message, fixLink: b.fixLink, shift: null });
      }
      if (past.shifts.length) {
        const first = past.shifts[0]!;
        const b = past.blockers[0]!;
        const what =
          b.kind === 'WORK_AUTH_ENDED'
            ? `their work authorization ${b.endsOn! < today ? 'ended' : 'ends'} on ${fmtDay(b.endsOn, { year: true })}`
            : b.kind === 'J1_PROGRAM_ENDED'
              ? `their J-1 program ${b.endsOn! < today ? 'ended' : 'ends'} on ${fmtDay(b.endsOn, { year: true })}`
              : 'E-Verify returned a final nonconfirmation';
        const more = past.shifts.length > 1 ? ` and ${past.shifts.length - 1} more shift${past.shifts.length === 2 ? '' : 's'}` : '';
        exceptions.push({
          associateId: p.id,
          associateName: name,
          severity: 'scheduled',
          kind: 'SCHEDULED_AFTER_BLOCK',
          date: shiftDays({ startsAt: first.startsAt, endsAt: first.endsAt, timezone: first.locationRel?.timezone }).first,
          message: `${name} is scheduled ${shiftWords(first)}${more}, but ${what}. Move the shift to someone else, or fix the record first.`,
          fixLink: b.fixLink,
          shift: toShift(first),
        });
      }
      for (const w of c.warnings) exceptions.push({ associateId: p.id, associateName: name, severity: 'warning', kind: w.kind, date: w.dueBy, message: w.message, fixLink: w.fixLink, shift: null });
      for (const w of c.upcoming) exceptions.push({ associateId: p.id, associateName: name, severity: 'upcoming', kind: w.kind, date: w.dueBy, message: w.message, fixLink: w.fixLink, shift: null });
    }
    // Blockers (and shifts booked past them) first, then the rest; each by date, undated last.
    exceptions.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99') ||
        a.associateName.localeCompare(b.associateName),
    );

    // Assign-anyway decisions of the last 90 days, for people in reach.
    const inReach = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const audits = await prisma.auditLog.findMany({
      where: { tenantId, action: 'work_authorization.override', createdAt: { gte: new Date(now.getTime() - OVERRIDE_WINDOW_DAYS * DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, createdAt: true, entityId: true, metadata: true, actorUser: { select: { displayName: true, email: true } } },
    });
    const overrides: ClearedOverride[] = [];
    for (const a of audits) {
      const m = (a.metadata ?? {}) as { associateId?: string; reason?: string; shiftId?: string; blockers?: Array<{ kind?: string }> };
      if (!m.associateId || !inReach.has(m.associateId)) continue;
      overrides.push({
        id: a.id,
        at: a.createdAt.toISOString(),
        actorName: a.actorUser?.displayName ?? a.actorUser?.email ?? null,
        associateId: m.associateId,
        associateName: inReach.get(m.associateId) ?? null,
        shiftId: m.shiftId ?? a.entityId,
        blockerKind: m.blockers?.[0]?.kind ?? null,
        reason: m.reason ?? '',
      });
    }

    res.json(ClearedListResponseSchema.parse({ asOf: today, rows, exceptions, overrides, workforce, workforceCounts }));
  } catch (err) {
    next(err);
  }
});
