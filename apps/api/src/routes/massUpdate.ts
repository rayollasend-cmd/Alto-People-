import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { EMPLOYED_WHERE } from '../lib/activeDefinition.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertSiteInScope, isInternallyScoped, scopeAssociates, scopeWhere } from '../lib/scope.js';
import { profileMoveChanges } from '../lib/jobProfileMove.js';
import { userDisplayName } from '../lib/clientProspects.js';
import { loadWorld, periodStartOnOrAfter, ruleInForce, scheduleMembershipFor, todayYmd } from '../lib/payScheduleMembership.js';
import { can } from '@alto-people/shared';
import { assignPeople } from './paySchedules.js';
import type { SessionUser } from '../types/express.js';

/**
 * Mass update (HR pack 2026-10).
 *
 *   Filter people → preview exactly who changes and from what → apply as one
 *   batch, one audit row, and an undo that holds for 24 hours. Fields: site
 *   (the open assignment moves), department, manager, pay schedule, cost
 *   center and job profile. Each person's "before" is kept on the batch so
 *   undo restores it exactly. A job profile that changes someone's overtime
 *   exemption, comp class or tipped code is a promotion (a second person
 *   decides it), so a batch that would do that for anyone is refused.
 *
 *   A pay schedule move is a payroll change (process:payroll) and goes
 *   through the membership engine — an INDIVIDUAL rule from a date, never a
 *   write to Associate.payrollScheduleId (only a mirror; the sweep would put
 *   it back). Someone already on a schedule moves at the new schedule's next
 *   period start; someone on none starts today. Undo ends those rules.
 *
 *   POST /people/mass-update/preview   { filter, changes } → the rows that would change
 *   POST /people/mass-update           { filter, changes } → { batchId, affected }
 *   GET  /people/mass-update/batches
 *   POST /people/mass-update/:id/undo
 */

export const massUpdateRouter = Router();

const MANAGE = requireCapability('manage:org');
const UNDO_WINDOW_MS = 24 * 3_600_000;
/** One batch changes at most this many people; past it the caller is asked to narrow the filter. */
const BATCH_CAP = 2000;

const FilterSchema = z.object({
  siteIds: z.array(z.string().uuid()).max(100).optional(),
  departmentIds: z.array(z.string().uuid()).max(100).optional(),
  managerIds: z.array(z.string().uuid()).max(100).optional(),
  payrollScheduleIds: z.array(z.string().uuid()).max(50).optional(),
  clientIds: z.array(z.string().uuid()).max(50).optional(),
  associateIds: z.array(z.string().uuid()).max(500).optional(),
  /** Default: employed people only. */
  includeSeparated: z.boolean().default(false),
});

const ChangesSchema = z
  .object({
    siteId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    managerId: z.string().uuid().nullable().optional(),
    payrollScheduleId: z.string().uuid().nullable().optional(),
    costCenterId: z.string().uuid().nullable().optional(),
    jobProfileId: z.string().uuid().nullable().optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: 'Pick at least one field to change.' });

type Filter = z.infer<typeof FilterSchema>;
type Changes = z.infer<typeof ChangesSchema>;

interface Before {
  associateId: string;
  name: string;
  siteId: string | null;
  siteName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  managerId: string | null;
  managerName: string | null;
  payrollScheduleId: string | null;
  payrollScheduleName: string | null;
  /** Older batches (before cost center and job profile could change) don't carry these. */
  costCenterId?: string | null;
  costCenterName?: string | null;
  jobProfileId?: string | null;
  jobProfileName?: string | null;
  /** Pay schedule moves: the day the batch's rule started, and whether they had their own (INDIVIDUAL) rule before. */
  payrollScheduleFrom?: string;
  payrollScheduleOwnRule?: boolean;
}

function payrollOnly(user: SessionUser, c: Changes): void {
  if (c.payrollScheduleId !== undefined && !can(user, 'process:payroll')) {
    throw new HttpError(403, 'payroll_only', 'Moving people to another pay schedule is a payroll change — someone with payroll access makes it.');
  }
}

/** 'Nov 7' — the day a pay schedule move starts, said in words. */
const dayWords = (ymd: string) => new Date(`${ymd}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * The day each person's pay schedule move starts: the new schedule's next
 * period start for anyone already on a schedule; today for someone on none
 * (and for "let the rules decide"). The engine's own rule (assignPeople's
 * defaultStartFor), for many people at once.
 */
async function payScheduleStarts(ids: string[], scheduleId: string | null): Promise<Map<string, string>> {
  const today = todayYmd();
  const out = new Map<string, string>(ids.map((id) => [id, today]));
  if (!scheduleId || ids.length === 0) return out;
  const target = await prisma.payrollSchedule.findFirst({ where: { id: scheduleId, tenantId: tenantIdForWrite() }, include: { versions: true } });
  if (!target) return out;
  const next = periodStartOnOrAfter(target, today);
  const members = await scheduleMembershipFor(prisma, ids, today);
  for (const id of ids) if (members.get(id)) out.set(id, next);
  return out;
}

/** Run assignPeople once per (schedule, start day) group. */
async function assignInGroups(user: SessionUser, moves: Array<{ associateId: string; scheduleId: string | null; from: string }>): Promise<void> {
  const groups = new Map<string, { scheduleId: string | null; from: string; ids: string[] }>();
  for (const m of moves) {
    const key = `${m.scheduleId ?? 'rules'}|${m.from}`;
    const g = groups.get(key) ?? { scheduleId: m.scheduleId, from: m.from, ids: [] };
    g.ids.push(m.associateId);
    groups.set(key, g);
  }
  for (const g of groups.values()) await assignPeople(user, g.ids, g.scheduleId, g.from);
}

/** Who the filter names, inside the caller's tenant and reach (AND, so no filter can overwrite the scope). */
function whereFor(f: Filter, user: SessionUser): Prisma.AssociateWhereInput {
  return scopeWhere<Prisma.AssociateWhereInput>(
    { tenantId: tenantIdForWrite() },
    f.includeSeparated ? { deletedAt: null, erasedAt: null } : EMPLOYED_WHERE,
    scopeAssociates(user),
    !!f.associateIds?.length && { id: { in: f.associateIds } },
    !!f.departmentIds?.length && { departmentId: { in: f.departmentIds } },
    !!f.managerIds?.length && { managerId: { in: f.managerIds } },
    !!f.payrollScheduleIds?.length && { payrollScheduleId: { in: f.payrollScheduleIds } },
    !!f.siteIds?.length && { assignments: { some: { endedAt: null, locationId: { in: f.siteIds } } } },
    !!f.clientIds?.length && { applications: { some: { deletedAt: null, status: 'APPROVED', clientId: { in: f.clientIds } } } },
  );
}

/** Everyone the filter matches — refused, with the real count, when past the batch cap. */
async function snapshot(f: Filter, user: SessionUser): Promise<Before[]> {
  const where = whereFor(f, user);
  const matched = await prisma.associate.count({ where });
  if (matched > BATCH_CAP) {
    throw new HttpError(400, 'too_many', `${matched.toLocaleString()} people match — one batch changes at most ${BATCH_CAP.toLocaleString()}. Narrow the filter (a site, a department) and run it in parts.`, { matched, cap: BATCH_CAP });
  }
  const rows = await prisma.associate.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      departmentId: true,
      department: { select: { name: true } },
      managerId: true,
      manager: { select: { firstName: true, lastName: true } },
      payrollScheduleId: true,
      payrollSchedule: { select: { name: true } },
      costCenterId: true,
      costCenter: { select: { code: true, name: true } },
      jobProfileId: true,
      jobProfile: { select: { title: true } },
      assignments: { where: { endedAt: null }, take: 1, orderBy: { startedAt: 'desc' }, select: { locationId: true, location: { select: { name: true } } } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: BATCH_CAP,
  });
  return rows.map((a) => ({
    associateId: a.id,
    name: `${a.firstName} ${a.lastName}`.trim(),
    siteId: a.assignments[0]?.locationId ?? null,
    siteName: a.assignments[0]?.location.name ?? null,
    departmentId: a.departmentId,
    departmentName: a.department?.name ?? null,
    managerId: a.managerId,
    managerName: a.manager ? `${a.manager.firstName} ${a.manager.lastName}`.trim() : null,
    payrollScheduleId: a.payrollScheduleId,
    payrollScheduleName: a.payrollSchedule?.name ?? null,
    costCenterId: a.costCenterId,
    costCenterName: a.costCenter ? `${a.costCenter.code} · ${a.costCenter.name}` : null,
    jobProfileId: a.jobProfileId,
    jobProfileName: a.jobProfile?.title ?? null,
  }));
}

/**
 * The names the changes point at — refused when any id is not this
 * tenant's, a site is outside the caller's reach, or the manager is gone,
 * out of reach, or would close a loop over the people being moved.
 */
async function resolveChanges(c: Changes, user: SessionUser, movingIds: string[] = []) {
  const tenantId = tenantIdForWrite();
  const out: { siteName?: string | null; departmentName?: string | null; managerName?: string | null; payrollScheduleName?: string | null; costCenterName?: string | null; jobProfileName?: string | null } = {};
  if (c.siteId !== undefined) {
    if (c.siteId === null) throw new HttpError(400, 'site_required', 'A site is required: people are moved, not unassigned, by a mass update.');
    const s = await prisma.site.findFirst({ where: { id: c.siteId, tenantId, deletedAt: null }, select: { name: true } });
    if (!s) throw new HttpError(404, 'site_not_found', 'Site not found.');
    await assertSiteInScope(prisma, user, c.siteId);
    out.siteName = s.name;
  }
  if (c.departmentId !== undefined) {
    if (c.departmentId === null) out.departmentName = null;
    else {
      const d = await prisma.department.findFirst({ where: { id: c.departmentId, tenantId }, select: { name: true } });
      if (!d) throw new HttpError(404, 'department_not_found', 'Department not found.');
      out.departmentName = d.name;
    }
  }
  if (c.managerId !== undefined) {
    if (c.managerId === null) out.managerName = null;
    else {
      // An active person, in this tenant and the caller's reach.
      const m = await prisma.associate.findFirst({
        where: scopeWhere<Prisma.AssociateWhereInput>({ id: c.managerId, tenantId, deletedAt: null, deactivatedAt: null }, scopeAssociates(user)),
        select: { firstName: true, lastName: true },
      });
      if (!m) throw new HttpError(404, 'manager_not_found', 'Manager not found — they must be active and within your reach.');
      // A loop: the new manager already reports (at any depth) to someone being moved under them.
      const moving = new Set(movingIds);
      let cursor: string | null = c.managerId;
      for (let i = 0; i < 100 && cursor; i++) {
        const up: { managerId: string | null } | null = await prisma.associate.findUnique({ where: { id: cursor }, select: { managerId: true } });
        cursor = up?.managerId ?? null;
        if (cursor && moving.has(cursor)) {
          throw new HttpError(409, 'manager_cycle', `${m.firstName} ${m.lastName} reports to someone in this batch — that would make a loop.`);
        }
      }
      out.managerName = `${m.firstName} ${m.lastName}`.trim();
    }
  }
  if (c.payrollScheduleId !== undefined) {
    if (c.payrollScheduleId === null) out.payrollScheduleName = null;
    else {
      const p = await prisma.payrollSchedule.findFirst({ where: { id: c.payrollScheduleId, tenantId }, select: { name: true } });
      if (!p) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found.');
      out.payrollScheduleName = p.name;
    }
  }
  if (c.costCenterId !== undefined) {
    if (c.costCenterId === null) out.costCenterName = null;
    else {
      const cc = await prisma.costCenter.findFirst({ where: { id: c.costCenterId, tenantId, deletedAt: null }, select: { code: true, name: true } });
      if (!cc) throw new HttpError(404, 'cost_center_not_found', 'Cost center not found.');
      out.costCenterName = `${cc.code} · ${cc.name}`;
    }
  }
  if (c.jobProfileId !== undefined) {
    if (c.jobProfileId === null) out.jobProfileName = null;
    else {
      const jp = await prisma.jobProfile.findFirst({ where: { id: c.jobProfileId, tenantId, deletedAt: null }, select: { title: true } });
      if (!jp) throw new HttpError(404, 'job_profile_not_found', 'Job profile not found.');
      out.jobProfileName = jp.title;
    }
  }
  return out;
}

/**
 * A job profile move that changes overtime exemption, comp class or tipped
 * code is a promotion, and a promotion already waiting sets the profile when
 * it is decided: either way not a mass edit. Refused, naming who.
 */
async function assertProfileMovesAllowed(before: Before[], c: Changes): Promise<void> {
  if (c.jobProfileId === undefined) return;
  const moving = before.filter((b) => (b.jobProfileId ?? null) !== c.jobProfileId);
  if (moving.length === 0) return;
  const ids = [...new Set([c.jobProfileId, ...moving.map((b) => b.jobProfileId ?? null)].filter((x): x is string => !!x))];
  const profiles = await prisma.jobProfile.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, isExempt: true, wcClassCode: true, tippedOccupationCode: true } });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const to = c.jobProfileId ? byId.get(c.jobProfileId) ?? null : null;
  const pending = new Set(
    (await prisma.promotion.findMany({ where: { associateId: { in: moving.map((b) => b.associateId) }, status: 'PENDING' }, select: { associateId: true } })).map((p) => p.associateId),
  );
  const blocked = moving.filter((b) => pending.has(b.associateId) || profileMoveChanges(b.jobProfileId ? byId.get(b.jobProfileId) ?? null : null, to).length > 0);
  if (blocked.length === 0) return;
  const names = blocked.slice(0, 3).map((b) => b.name).join(', ') + (blocked.length > 3 ? ` and ${blocked.length - 3} more` : '');
  throw new HttpError(
    409,
    'job_profile_needs_approval',
    `${to ? `“${to.title}”` : 'Removing the job profile'} needs a promotion for ${names}: it changes their overtime exemption, comp class or tipped code, or a promotion is already waiting. Send those as promotions, or leave them out.`,
    { blocked: blocked.map((b) => b.associateId) },
  );
}

function changesFor(b: Before, c: Changes): Array<{ field: string; from: string | null; to: string | null }> {
  const diffs: Array<{ field: string; from: string | null; to: string | null }> = [];
  if (c.siteId !== undefined && c.siteId !== b.siteId) diffs.push({ field: 'site', from: b.siteName, to: null });
  if (c.departmentId !== undefined && c.departmentId !== b.departmentId) diffs.push({ field: 'department', from: b.departmentName, to: null });
  if (c.managerId !== undefined && c.managerId !== b.managerId) diffs.push({ field: 'manager', from: b.managerName, to: null });
  if (c.payrollScheduleId !== undefined && c.payrollScheduleId !== b.payrollScheduleId) diffs.push({ field: 'paySchedule', from: b.payrollScheduleName, to: null });
  if (c.costCenterId !== undefined && c.costCenterId !== (b.costCenterId ?? null)) diffs.push({ field: 'costCenter', from: b.costCenterName ?? null, to: null });
  if (c.jobProfileId !== undefined && c.jobProfileId !== (b.jobProfileId ?? null)) diffs.push({ field: 'jobProfile', from: b.jobProfileName ?? null, to: null });
  return diffs;
}

const BodySchema = z.object({ filter: FilterSchema, changes: ChangesSchema });

massUpdateRouter.post('/people/mass-update/preview', MANAGE, async (req, res) => {
  const { filter, changes } = BodySchema.parse(req.body);
  payrollOnly(req.user!, changes);
  const before = await snapshot(filter, req.user!);
  const names = await resolveChanges(changes, req.user!, before.map((b) => b.associateId));
  await assertProfileMovesAllowed(before, changes);
  const NAMED: Record<string, string | null | undefined> = {
    site: names.siteName,
    department: names.departmentName,
    manager: names.managerName,
    paySchedule: names.payrollScheduleName,
    costCenter: names.costCenterName,
    jobProfile: names.jobProfileName,
  };
  const to = (field: string) => NAMED[field] ?? null;
  const starts =
    changes.payrollScheduleId !== undefined
      ? await payScheduleStarts(before.filter((b) => b.payrollScheduleId !== changes.payrollScheduleId).map((b) => b.associateId), changes.payrollScheduleId)
      : new Map<string, string>();
  // A pay schedule move says when it starts ("Weekly from Nov 7"); "let the rules decide" says so.
  const toFor = (b: Before, field: string) => {
    if (field !== 'paySchedule') return to(field);
    const from = starts.get(b.associateId);
    const name = to(field) ?? 'Whatever the rules decide';
    return from ? `${name} from ${dayWords(from)}` : name;
  };
  const rows = before
    .map((b) => ({ associateId: b.associateId, name: b.name, changes: changesFor(b, changes).map((d) => ({ ...d, to: toFor(b, d.field) })) }))
    .filter((r) => r.changes.length > 0);
  res.json({ matched: before.length, willChange: rows.length, rows: rows.slice(0, 500) });
});

/** Apply one person's changes inside a transaction; the site moves the open assignment as of today. */
async function applyOne(tx: Prisma.TransactionClient, b: Before, c: Changes, today: Date, userId: string | null) {
  const data: Prisma.AssociateUncheckedUpdateInput = {};
  if (c.departmentId !== undefined && c.departmentId !== b.departmentId) data.departmentId = c.departmentId;
  if (c.managerId !== undefined && c.managerId !== b.managerId) data.managerId = c.managerId;
  // Pay schedule: never here — the engine moves it after the batch (see assignInGroups).
  if (c.costCenterId !== undefined && c.costCenterId !== (b.costCenterId ?? null)) data.costCenterId = c.costCenterId;
  if (c.jobProfileId !== undefined && c.jobProfileId !== (b.jobProfileId ?? null)) data.jobProfileId = c.jobProfileId;
  if (Object.keys(data).length) await tx.associate.update({ where: { id: b.associateId }, data });
  if (c.siteId !== undefined && c.siteId !== null && c.siteId !== b.siteId) {
    await tx.associateAssignment.updateMany({ where: { associateId: b.associateId, endedAt: null }, data: { endedAt: today } });
    await tx.associateAssignment.create({ data: { associateId: b.associateId, locationId: c.siteId, startedAt: today } });
    void userId;
  }
}

massUpdateRouter.post('/people/mass-update', MANAGE, async (req, res) => {
  const { filter, changes } = BodySchema.parse(req.body);
  payrollOnly(req.user!, changes);
  const before = (await snapshot(filter, req.user!)).filter((b) => changesFor(b, changes).length > 0);
  const names = await resolveChanges(changes, req.user!, before.map((b) => b.associateId));
  if (before.length === 0) throw new HttpError(400, 'nothing_to_change', 'No one matched with a different value.');
  await assertProfileMovesAllowed(before, changes);
  if (changes.managerId && before.some((b) => b.associateId === changes.managerId)) {
    throw new HttpError(400, 'self_manager', 'A person cannot be made their own manager.');
  }
  // Pay schedule moves: when each starts, and who had their own rule before (so undo can put it back).
  const scheduleMoves = changes.payrollScheduleId !== undefined ? before.filter((b) => b.payrollScheduleId !== changes.payrollScheduleId) : [];
  if (scheduleMoves.length) {
    const starts = await payScheduleStarts(scheduleMoves.map((b) => b.associateId), changes.payrollScheduleId ?? null);
    const todayKey = todayYmd();
    const ownRule = new Set((await loadWorld(prisma)).rules.filter((r) => r.kind === 'INDIVIDUAL' && r.associateId && ruleInForce(r, todayKey)).map((r) => r.associateId!));
    for (const b of scheduleMoves) {
      b.payrollScheduleFrom = starts.get(b.associateId) ?? todayKey;
      b.payrollScheduleOwnRule = ownRule.has(b.associateId);
    }
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const batch = await prisma.$transaction(async (tx) => {
    for (const b of before) await applyOne(tx, b, changes, today, req.user!.id);
    return tx.massUpdateBatch.create({
      data: {
        actorUserId: req.user!.id,
        filter: filter as Prisma.InputJsonValue,
        changes: { ...changes, ...names } as Prisma.InputJsonValue,
        affected: before as unknown as Prisma.InputJsonValue,
        affectedCount: before.length,
      },
    });
  });
  if (scheduleMoves.length) {
    await assignInGroups(req.user!, scheduleMoves.map((b) => ({ associateId: b.associateId, scheduleId: changes.payrollScheduleId ?? null, from: b.payrollScheduleFrom! })));
  }
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'people.mass_update', entityType: 'MassUpdateBatch', entityId: batch.id, metadata: { affected: before.length, changes: { ...changes, ...names }, associateIds: before.map((b) => b.associateId) } },
    'people.mass_update',
  );
  res.status(201).json({ batchId: batch.id, affected: before.length, undoUntil: new Date(batch.appliedAt.getTime() + UNDO_WINDOW_MS).toISOString() });
});

massUpdateRouter.get('/people/mass-update/batches', MANAGE, async (_req, res) => {
  const rows = await prisma.massUpdateBatch.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { appliedAt: 'desc' }, take: 50 });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } })
    : [];
  const emailBy = new Map(actors.map((a) => [a.id, a.email]));
  // Say who by name, not by email (the email stays for the tooltip).
  const nameBy = new Map(actors.map((a) => [a.id, userDisplayName(a)]));
  const now = Date.now();
  res.json({
    batches: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorUserId ? emailBy.get(r.actorUserId) ?? null : null,
      actorName: r.actorUserId ? nameBy.get(r.actorUserId) ?? null : null,
      changes: r.changes,
      affectedCount: r.affectedCount,
      appliedAt: r.appliedAt.toISOString(),
      undoneAt: r.undoneAt?.toISOString() ?? null,
      canUndo: !r.undoneAt && now - r.appliedAt.getTime() < UNDO_WINDOW_MS,
    })),
  });
});

massUpdateRouter.post('/people/mass-update/:id/undo', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const batch = await prisma.massUpdateBatch.findUnique({ where: { id } });
  if (!batch || batch.tenantId !== tenantIdForWrite()) throw new HttpError(404, 'not_found', 'Batch not found.');
  // A site/region-bound account undoes only its own batches (another's may reach past its sites).
  if (isInternallyScoped(req.user!) && batch.actorUserId !== req.user!.id) throw new HttpError(404, 'not_found', 'Batch not found.');
  if (batch.undoneAt) throw new HttpError(409, 'already_undone', 'This batch was already undone.');
  if (Date.now() - batch.appliedAt.getTime() >= UNDO_WINDOW_MS) throw new HttpError(409, 'undo_window_closed', 'The 24-hour undo window has closed.');
  const before = batch.affected as unknown as Before[];
  const changes = batch.changes as unknown as Changes;
  payrollOnly(req.user!, changes);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await prisma.$transaction(async (tx) => {
    for (const b of before) {
      const data: Prisma.AssociateUncheckedUpdateInput = {};
      if (changes.departmentId !== undefined) data.departmentId = b.departmentId;
      if (changes.managerId !== undefined) data.managerId = b.managerId;
      if (changes.costCenterId !== undefined && b.costCenterId !== undefined) data.costCenterId = b.costCenterId;
      if (changes.jobProfileId !== undefined && b.jobProfileId !== undefined) data.jobProfileId = b.jobProfileId;
      if (Object.keys(data).length) await tx.associate.update({ where: { id: b.associateId }, data });
      if (changes.siteId !== undefined && changes.siteId !== null && changes.siteId !== b.siteId) {
        await tx.associateAssignment.updateMany({ where: { associateId: b.associateId, endedAt: null, locationId: changes.siteId }, data: { endedAt: today } });
        if (b.siteId) await tx.associateAssignment.create({ data: { associateId: b.associateId, locationId: b.siteId, startedAt: today } });
      }
    }
    await tx.massUpdateBatch.update({ where: { id }, data: { undoneAt: new Date(), undoneById: req.user!.id } });
  });
  // Pay schedule: end the batch's rules through the engine. Someone who had
  // their own rule gets it back from the same day; anyone else goes back to
  // what the rules decide.
  if (changes.payrollScheduleId !== undefined) {
    const todayKey = todayYmd();
    const moved = before.filter((b) => b.payrollScheduleId !== changes.payrollScheduleId);
    await assignInGroups(
      req.user!,
      moved.map((b) => {
        const from = b.payrollScheduleFrom && b.payrollScheduleFrom > todayKey ? b.payrollScheduleFrom : todayKey;
        return { associateId: b.associateId, scheduleId: b.payrollScheduleOwnRule && b.payrollScheduleId ? b.payrollScheduleId : null, from };
      }),
    );
  }
  enqueueAudit({ actorUserId: req.user!.id, action: 'people.mass_update_undone', entityType: 'MassUpdateBatch', entityId: id, metadata: { affected: before.length } }, 'people.mass_update_undone');
  res.json({ ok: true, restored: before.length });
});
