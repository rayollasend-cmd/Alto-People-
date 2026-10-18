import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { notifyAssociate } from './notify.js';
import { splitWeeklyOvertime } from './payroll.js';
import { startOfWeekForSite } from './timeAnomalies.js';
import { assignWithinRules } from './shiftAssign.js';
import { orgSettingIdFor } from './branding.js';

/**
 * Overtime, offered fairly.
 *
 *   When an open shift would put someone into overtime, the people it
 *   would cost the least overtime — and who have worked the least overtime
 *   lately — are asked first. Everyone who can take it without overtime
 *   comes before anyone who'd go over. With the organization's switch on,
 *   an offer that jumps the line needs a reason, and the people passed over
 *   are recorded as skipped with that reason. No seniority lists.
 *
 *   "Lately" is the last four workweeks of approved time.
 */

type Db = PrismaClient;
const HOUR = 3_600_000;
const WEEKS = 4;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RotationCandidate {
  associateId: string;
  name: string;
  /** Scheduled hours already in the shift's workweek. */
  weekHours: number;
  /** Overtime hours this shift would add for them (0 = none). */
  wouldAddOvertimeHours: number;
  /** Overtime hours worked over the last four workweeks. */
  recentOvertimeHours: number;
  rank: number;
  offer: { id: string; status: string; offeredAt: string; respondedAt: string | null; note: string | null } | null;
}

type ShiftRow = { id: string; clientId: string | null; locationId: string | null; startsAt: Date; endsAt: Date; status: string; assignedAssociateId: string | null; locationRel: { timezone: string | null } | null };

async function loadShift(db: Db, tenantId: string, shiftId: string, scope: Prisma.ShiftWhereInput): Promise<ShiftRow> {
  const shift = await db.shift.findFirst({ where: { AND: [{ id: shiftId, tenantId }, scope] }, select: { id: true, clientId: true, locationId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true, locationRel: { select: { timezone: true } } } });
  if (!shift) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
  return shift;
}

/** Everyone who could take the shift, ranked fewest-overtime-first. */
export async function rankForShift(db: Db, tenantId: string, shiftId: string, scope: Prisma.ShiftWhereInput): Promise<{ shift: ShiftRow; candidates: RotationCandidate[]; enabled: boolean }> {
  const shift = await loadShift(db, tenantId, shiftId, scope);
  const tz = shift.locationRel?.timezone ?? null;
  const hours = (shift.endsAt.getTime() - shift.startsAt.getTime()) / HOUR;
  const weekStart = startOfWeekForSite(shift.startsAt, tz);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
  // Placed at the shift's store, or claiming it.
  const [placed, claims, setting] = await Promise.all([
    shift.locationId ? db.associateAssignment.findMany({ where: { locationId: shift.locationId, endedAt: null }, select: { associateId: true } }) : Promise.resolve([]),
    db.openShiftClaim.findMany({ where: { shiftId: shift.id }, select: { associateId: true } }).catch(() => [] as Array<{ associateId: string }>),
    db.orgSetting.findFirst({ where: { OR: [{ tenantId }, { id: orgSettingIdFor(tenantId) }] }, select: { otEqualization: true } }),
  ]);
  const ids = [...new Set([...placed.map((p) => p.associateId), ...claims.map((c) => c.associateId)])];
  const people = await db.associate.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null, deactivatedAt: null }, select: { id: true, firstName: true, lastName: true } });
  if (!people.length) return { shift, candidates: [], enabled: setting?.otEqualization ?? false };
  const pid = people.map((p) => p.id);
  const since = new Date(weekStart.getTime() - WEEKS * 7 * 86_400_000);
  const [weekShifts, recent, offers] = await Promise.all([
    db.shift.findMany({ where: { assignedAssociateId: { in: pid }, status: { in: ['ASSIGNED', 'COMPLETED'] }, startsAt: { gte: weekStart, lt: weekEnd }, id: { not: shift.id } }, select: { assignedAssociateId: true, startsAt: true, endsAt: true } }),
    db.timeEntry.findMany({ where: { associateId: { in: pid }, status: 'APPROVED', clockInAt: { gte: since, lt: weekStart } }, select: { associateId: true, status: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } }, location: { select: { timezone: true } } } }),
    db.overtimeOffer.findMany({ where: { shiftId: shift.id }, orderBy: { offeredAt: 'desc' } }),
  ]);
  // Overlapping a shift they already have: not a candidate.
  const busy = new Set(weekShifts.filter((s) => s.startsAt < shift.endsAt && s.endsAt > shift.startsAt).map((s) => s.assignedAssociateId!));
  const candidates = people
    .filter((p) => !busy.has(p.id))
    .map((p) => {
      const weekHours = round2(weekShifts.filter((s) => s.assignedAssociateId === p.id).reduce((a, s) => a + (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR, 0));
      const wouldAdd = round2(Math.max(0, weekHours + hours - 40) - Math.max(0, weekHours - 40));
      const mine = recent.filter((e) => e.associateId === p.id);
      const recentOvertimeHours = mine.length ? splitWeeklyOvertime(mine.map((e) => ({ ...e, location: e.location?.timezone ? { timezone: e.location.timezone } : null }))).overtimeHours : 0;
      const o = offers.find((x) => x.associateId === p.id) ?? null;
      return {
        associateId: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        weekHours,
        wouldAddOvertimeHours: wouldAdd,
        recentOvertimeHours,
        rank: 0,
        offer: o ? { id: o.id, status: o.status, offeredAt: o.offeredAt.toISOString(), respondedAt: o.respondedAt?.toISOString() ?? null, note: o.note } : null,
      };
    })
    .sort((a, b) => Number(a.wouldAddOvertimeHours > 0) - Number(b.wouldAddOvertimeHours > 0) || a.recentOvertimeHours - b.recentOvertimeHours || a.wouldAddOvertimeHours - b.wouldAddOvertimeHours || a.name.localeCompare(b.name));
  candidates.forEach((c, i) => (c.rank = i + 1));
  return { shift, candidates, enabled: setting?.otEqualization ?? false };
}

const DONE = new Set(['DECLINED', 'EXPIRED', 'SKIPPED']);

/** Offer the shift to one person, in turn — or out of turn with a reason the record keeps. */
export async function offerOvertime(db: Db, ctx: { tenantId: string; actorUserId: string; scope: Prisma.ShiftWhereInput }, input: { shiftId: string; associateId: string; overrideReason?: string | null }) {
  const { shift, candidates, enabled } = await rankForShift(db, ctx.tenantId, input.shiftId, ctx.scope);
  if (shift.status !== 'OPEN' || shift.assignedAssociateId) throw new HttpError(409, 'shift_not_open', 'This shift is already filled.');
  const me = candidates.find((c) => c.associateId === input.associateId);
  if (!me) throw new HttpError(400, 'not_a_candidate', 'They can’t take this shift (not placed at the store, or already working then).');
  if (me.offer && me.offer.status === 'OFFERED') throw new HttpError(409, 'already_offered', 'They already have this offer.');
  // Ahead of them in line, and not yet asked or answered.
  const ahead = me.wouldAddOvertimeHours > 0 ? candidates.filter((c) => c.rank < me.rank && c.wouldAddOvertimeHours > 0 && !(c.offer && DONE.has(c.offer.status))) : [];
  const nonOtWaiting = me.wouldAddOvertimeHours > 0 ? candidates.filter((c) => c.wouldAddOvertimeHours === 0 && !(c.offer && DONE.has(c.offer.status))) : [];
  const jumped = [...nonOtWaiting, ...ahead];
  const reason = input.overrideReason?.trim();
  if (enabled && jumped.length > 0 && (!reason || reason.length < 3)) {
    throw new HttpError(409, 'out_of_turn', `Overtime is offered fewest-overtime-first. Offer it to ${jumped.slice(0, 3).map((c) => c.name).join(', ')}${jumped.length > 3 ? ` and ${jumped.length - 3} more` : ''} first, or give a reason for skipping them.`, { ahead: jumped.map((c) => ({ associateId: c.associateId, name: c.name })) });
  }
  await db.$transaction(async (tx) => {
    for (const c of enabled && reason ? jumped : []) {
      await tx.overtimeOffer.create({ data: { tenantId: ctx.tenantId, shiftId: shift.id, associateId: c.associateId, rank: c.rank, overtimeHoursInPeriod: c.recentOvertimeHours, wouldAddOvertimeHours: c.wouldAddOvertimeHours, status: 'SKIPPED', offeredById: ctx.actorUserId, note: reason!.slice(0, 500) } });
    }
    await tx.overtimeOffer.create({ data: { tenantId: ctx.tenantId, shiftId: shift.id, associateId: me.associateId, rank: me.rank, overtimeHoursInPeriod: me.recentOvertimeHours, wouldAddOvertimeHours: me.wouldAddOvertimeHours, status: 'OFFERED', offeredById: ctx.actorUserId, note: reason?.slice(0, 500) ?? null } });
  });
  enqueueAudit({ actorUserId: ctx.actorUserId, clientId: shift.clientId, action: 'scheduling.ot_offered', entityType: 'Shift', entityId: shift.id, metadata: { associateId: me.associateId, rank: me.rank, wouldAddOvertimeHours: me.wouldAddOvertimeHours, skipped: enabled && reason ? jumped.map((c) => c.associateId) : [], reason: reason ?? null } }, 'overtimeRotation');
  void notifyAssociate(me.associateId, { subject: 'Extra hours offered to you', body: `A shift is open${me.wouldAddOvertimeHours > 0 ? ` — it would be ${me.wouldAddOvertimeHours} h of overtime` : ''}. Open the app to take it or pass.`, category: 'scheduling', linkUrl: '/time-attendance?tab=offers' });
  return rankForShift(db, ctx.tenantId, input.shiftId, ctx.scope);
}

/** The answer to an offer (the worker's own, or recorded by their manager). Accepting assigns the shift. */
export async function respondToOffer(db: Db, ctx: { tenantId: string; actorUserId: string; asWorker: string | null }, offerId: string, status: 'ACCEPTED' | 'DECLINED') {
  const offer = await db.overtimeOffer.findFirst({ where: { id: offerId, tenantId: ctx.tenantId, ...(ctx.asWorker ? { associateId: ctx.asWorker } : {}) } });
  if (!offer) throw new HttpError(404, 'offer_not_found', 'Offer not found.');
  if (offer.status !== 'OFFERED') throw new HttpError(409, 'offer_closed', 'This offer was already answered.');
  if (status === 'ACCEPTED') {
    const shift = await db.shift.findFirst({ where: { id: offer.shiftId }, select: { id: true, clientId: true, startsAt: true, endsAt: true, status: true, assignedAssociateId: true, locationRel: { select: { timezone: true } } } });
    if (!shift || shift.status !== 'OPEN' || shift.assignedAssociateId) {
      await db.overtimeOffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED', respondedAt: new Date() } });
      throw new HttpError(409, 'shift_taken', 'Someone else took this shift first.');
    }
    const associate = await db.associate.findUniqueOrThrow({ where: { id: offer.associateId }, select: { id: true, firstName: true, lastName: true, deactivatedAt: true, separatedAt: true } });
    await assignWithinRules(db, shift, associate, { actorUserId: ctx.actorUserId, via: 'overtime_offer' });
    // Everyone else still holding this offer: it's gone.
    await db.overtimeOffer.updateMany({ where: { shiftId: offer.shiftId, status: 'OFFERED', id: { not: offer.id } }, data: { status: 'EXPIRED', respondedAt: new Date() } });
  }
  const row = await db.overtimeOffer.update({ where: { id: offer.id }, data: { status, respondedAt: new Date() } });
  enqueueAudit({ actorUserId: ctx.actorUserId, clientId: null, action: `scheduling.ot_offer_${status.toLowerCase()}`, entityType: 'OvertimeOffer', entityId: row.id, metadata: { shiftId: row.shiftId, associateId: row.associateId, byWorker: !!ctx.asWorker } }, 'overtimeRotation');
  return row;
}

/** Who has worked how much overtime, and how offers went, over recent weeks. */
export async function equalizationReport(db: Db, tenantId: string, associateScope: Prisma.AssociateWhereInput, weeks = WEEKS) {
  const since = new Date(Date.now() - weeks * 7 * 86_400_000);
  const entries = await db.timeEntry.findMany({
    where: { status: 'APPROVED', clockInAt: { gte: since }, associate: { AND: [{ tenantId, deletedAt: null, deactivatedAt: null }, associateScope] } },
    select: { associateId: true, status: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } }, location: { select: { timezone: true } }, associate: { select: { firstName: true, lastName: true } } },
    take: 50_000,
  });
  const offers = await db.overtimeOffer.groupBy({ by: ['associateId', 'status'], where: { tenantId, offeredAt: { gte: since } }, _count: { _all: true } });
  const byPerson = new Map<string, { name: string; list: typeof entries }>();
  for (const e of entries) {
    const row = byPerson.get(e.associateId) ?? { name: `${e.associate.firstName} ${e.associate.lastName}`.trim(), list: [] as typeof entries };
    row.list.push(e);
    byPerson.set(e.associateId, row);
  }
  const rows = [...byPerson.entries()].map(([associateId, v]) => {
    const split = splitWeeklyOvertime(v.list.map((e) => ({ ...e, location: e.location?.timezone ? { timezone: e.location.timezone } : null })));
    const count = (s: string) => offers.find((o) => o.associateId === associateId && o.status === s)?._count._all ?? 0;
    return { associateId, name: v.name, overtimeHours: split.overtimeHours, regularHours: split.regularHours, offered: count('OFFERED') + count('ACCEPTED') + count('DECLINED') + count('EXPIRED'), accepted: count('ACCEPTED'), declined: count('DECLINED'), skipped: count('SKIPPED') };
  });
  rows.sort((a, b) => b.overtimeHours - a.overtimeHours || a.name.localeCompare(b.name));
  const ot = rows.map((r) => r.overtimeHours);
  const avg = ot.length ? round2(ot.reduce((a, b) => a + b, 0) / ot.length) : 0;
  return { weeks, since: since.toISOString().slice(0, 10), averageOvertimeHours: avg, spread: ot.length ? round2(Math.max(...ot) - Math.min(...ot)) : 0, people: rows, truncated: entries.length >= 50_000 };
}
