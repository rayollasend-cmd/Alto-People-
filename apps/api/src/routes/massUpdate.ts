import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { EMPLOYED_WHERE } from '../lib/activeDefinition.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Mass update (HR pack 2026-10).
 *
 *   Filter people → preview exactly who changes and from what → apply as one
 *   batch, one audit row, and an undo that holds for 24 hours. Fields: site
 *   (the open assignment moves), department, manager, pay schedule. Each
 *   person's "before" is kept on the batch so undo restores it exactly.
 *
 *   POST /people/mass-update/preview   { filter, changes } → the rows that would change
 *   POST /people/mass-update           { filter, changes } → { batchId, affected }
 *   GET  /people/mass-update/batches
 *   POST /people/mass-update/:id/undo
 */

export const massUpdateRouter = Router();

const MANAGE = requireCapability('manage:org');
const UNDO_WINDOW_MS = 24 * 3_600_000;

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
}

function whereFor(f: Filter): Prisma.AssociateWhereInput {
  return {
    tenantId: tenantIdForWrite(),
    ...(f.includeSeparated ? { deletedAt: null, erasedAt: null } : EMPLOYED_WHERE),
    ...(f.associateIds?.length ? { id: { in: f.associateIds } } : {}),
    ...(f.departmentIds?.length ? { departmentId: { in: f.departmentIds } } : {}),
    ...(f.managerIds?.length ? { managerId: { in: f.managerIds } } : {}),
    ...(f.payrollScheduleIds?.length ? { payrollScheduleId: { in: f.payrollScheduleIds } } : {}),
    ...(f.siteIds?.length ? { assignments: { some: { endedAt: null, locationId: { in: f.siteIds } } } } : {}),
    ...(f.clientIds?.length ? { applications: { some: { deletedAt: null, status: 'APPROVED', clientId: { in: f.clientIds } } } } : {}),
  };
}

async function snapshot(f: Filter): Promise<Before[]> {
  const rows = await prisma.associate.findMany({
    where: whereFor(f),
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
      assignments: { where: { endedAt: null }, take: 1, orderBy: { startedAt: 'desc' }, select: { locationId: true, location: { select: { name: true } } } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 2000,
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
  }));
}

/** The names the changes point at — refused when any id is not this tenant's. */
async function resolveChanges(c: Changes) {
  const out: { siteName?: string | null; departmentName?: string | null; managerName?: string | null; payrollScheduleName?: string | null } = {};
  if (c.siteId !== undefined) {
    if (c.siteId === null) throw new HttpError(400, 'site_required', 'A site is required: people are moved, not unassigned, by a mass update.');
    const s = await prisma.site.findUnique({ where: { id: c.siteId }, select: { name: true } });
    if (!s) throw new HttpError(404, 'site_not_found', 'Site not found.');
    out.siteName = s.name;
  }
  if (c.departmentId !== undefined) {
    if (c.departmentId === null) out.departmentName = null;
    else {
      const d = await prisma.department.findUnique({ where: { id: c.departmentId }, select: { name: true } });
      if (!d) throw new HttpError(404, 'department_not_found', 'Department not found.');
      out.departmentName = d.name;
    }
  }
  if (c.managerId !== undefined) {
    if (c.managerId === null) out.managerName = null;
    else {
      const m = await prisma.associate.findUnique({ where: { id: c.managerId }, select: { firstName: true, lastName: true, deletedAt: true } });
      if (!m || m.deletedAt) throw new HttpError(404, 'manager_not_found', 'Manager not found.');
      out.managerName = `${m.firstName} ${m.lastName}`.trim();
    }
  }
  if (c.payrollScheduleId !== undefined) {
    if (c.payrollScheduleId === null) out.payrollScheduleName = null;
    else {
      const p = await prisma.payrollSchedule.findUnique({ where: { id: c.payrollScheduleId }, select: { name: true } });
      if (!p) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found.');
      out.payrollScheduleName = p.name;
    }
  }
  return out;
}

function changesFor(b: Before, c: Changes): Array<{ field: string; from: string | null; to: string | null }> {
  const diffs: Array<{ field: string; from: string | null; to: string | null }> = [];
  if (c.siteId !== undefined && c.siteId !== b.siteId) diffs.push({ field: 'site', from: b.siteName, to: null });
  if (c.departmentId !== undefined && c.departmentId !== b.departmentId) diffs.push({ field: 'department', from: b.departmentName, to: null });
  if (c.managerId !== undefined && c.managerId !== b.managerId) diffs.push({ field: 'manager', from: b.managerName, to: null });
  if (c.payrollScheduleId !== undefined && c.payrollScheduleId !== b.payrollScheduleId) diffs.push({ field: 'paySchedule', from: b.payrollScheduleName, to: null });
  return diffs;
}

const BodySchema = z.object({ filter: FilterSchema, changes: ChangesSchema });

massUpdateRouter.post('/people/mass-update/preview', MANAGE, async (req, res) => {
  const { filter, changes } = BodySchema.parse(req.body);
  const names = await resolveChanges(changes);
  const before = await snapshot(filter);
  const to = (field: string) =>
    field === 'site' ? names.siteName ?? null : field === 'department' ? names.departmentName ?? null : field === 'manager' ? names.managerName ?? null : names.payrollScheduleName ?? null;
  const rows = before
    .map((b) => ({ associateId: b.associateId, name: b.name, changes: changesFor(b, changes).map((d) => ({ ...d, to: to(d.field) })) }))
    .filter((r) => r.changes.length > 0);
  res.json({ matched: before.length, willChange: rows.length, rows: rows.slice(0, 500) });
});

/** Apply one person's changes inside a transaction; the site moves the open assignment as of today. */
async function applyOne(tx: Prisma.TransactionClient, b: Before, c: Changes, today: Date, userId: string | null) {
  const data: Prisma.AssociateUncheckedUpdateInput = {};
  if (c.departmentId !== undefined && c.departmentId !== b.departmentId) data.departmentId = c.departmentId;
  if (c.managerId !== undefined && c.managerId !== b.managerId) data.managerId = c.managerId;
  if (c.payrollScheduleId !== undefined && c.payrollScheduleId !== b.payrollScheduleId) data.payrollScheduleId = c.payrollScheduleId;
  if (Object.keys(data).length) await tx.associate.update({ where: { id: b.associateId }, data });
  if (c.siteId !== undefined && c.siteId !== null && c.siteId !== b.siteId) {
    await tx.associateAssignment.updateMany({ where: { associateId: b.associateId, endedAt: null }, data: { endedAt: today } });
    await tx.associateAssignment.create({ data: { associateId: b.associateId, locationId: c.siteId, startedAt: today } });
    void userId;
  }
}

massUpdateRouter.post('/people/mass-update', MANAGE, async (req, res) => {
  const { filter, changes } = BodySchema.parse(req.body);
  const names = await resolveChanges(changes);
  const before = (await snapshot(filter)).filter((b) => changesFor(b, changes).length > 0);
  if (before.length === 0) throw new HttpError(400, 'nothing_to_change', 'No one matched with a different value.');
  if (changes.managerId && before.some((b) => b.associateId === changes.managerId)) {
    throw new HttpError(400, 'self_manager', 'A person cannot be made their own manager.');
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
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'people.mass_update', entityType: 'MassUpdateBatch', entityId: batch.id, metadata: { affected: before.length, changes: { ...changes, ...names }, associateIds: before.map((b) => b.associateId) } },
    'people.mass_update',
  );
  res.status(201).json({ batchId: batch.id, affected: before.length, undoUntil: new Date(batch.appliedAt.getTime() + UNDO_WINDOW_MS).toISOString() });
});

massUpdateRouter.get('/people/mass-update/batches', MANAGE, async (_req, res) => {
  const rows = await prisma.massUpdateBatch.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { appliedAt: 'desc' }, take: 50 });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
  const emailBy = new Map(actors.map((a) => [a.id, a.email]));
  const now = Date.now();
  res.json({
    batches: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorUserId ? emailBy.get(r.actorUserId) ?? null : null,
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
  if (batch.undoneAt) throw new HttpError(409, 'already_undone', 'This batch was already undone.');
  if (Date.now() - batch.appliedAt.getTime() >= UNDO_WINDOW_MS) throw new HttpError(409, 'undo_window_closed', 'The 24-hour undo window has closed.');
  const before = batch.affected as unknown as Before[];
  const changes = batch.changes as unknown as Changes;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await prisma.$transaction(async (tx) => {
    for (const b of before) {
      const data: Prisma.AssociateUncheckedUpdateInput = {};
      if (changes.departmentId !== undefined) data.departmentId = b.departmentId;
      if (changes.managerId !== undefined) data.managerId = b.managerId;
      if (changes.payrollScheduleId !== undefined) data.payrollScheduleId = b.payrollScheduleId;
      if (Object.keys(data).length) await tx.associate.update({ where: { id: b.associateId }, data });
      if (changes.siteId !== undefined && changes.siteId !== null && changes.siteId !== b.siteId) {
        await tx.associateAssignment.updateMany({ where: { associateId: b.associateId, endedAt: null, locationId: changes.siteId }, data: { endedAt: today } });
        if (b.siteId) await tx.associateAssignment.create({ data: { associateId: b.associateId, locationId: b.siteId, startedAt: today } });
      }
    }
    await tx.massUpdateBatch.update({ where: { id }, data: { undoneAt: new Date(), undoneById: req.user!.id } });
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'people.mass_update_undone', entityType: 'MassUpdateBatch', entityId: id, metadata: { affected: before.length } }, 'people.mass_update_undone');
  res.json({ ok: true, restored: before.length });
});
