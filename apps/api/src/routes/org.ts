import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AssociateOrgAssignmentInputSchema,
  AssociateProfilePatchInputSchema,
  CostCenterInputSchema,
  CostCenterListResponseSchema,
  DepartmentInputSchema,
  DepartmentListResponseSchema,
  JobProfileInputSchema,
  JobProfileListResponseSchema,
  type AssociateOrgListResponse,
  type CostCenter,
  type Department,
  type JobProfile,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { asOf, recordChange } from '../lib/associateHistory.js';
import { enqueueAudit } from '../lib/audit.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';

export const orgRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

function audit(
  req: Request,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): void {
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action,
      entityType,
      entityId,
      metadata: {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ...metadata,
      },
    },
    `org.${action}`
  );
}

// ----- Departments --------------------------------------------------------

orgRouter.get('/departments', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const where = {
    deletedAt: null,
    ...(clientId ? { clientId } : {}),
  };
  const rows = await prisma.department.findMany({
    where,
    orderBy: [{ name: 'asc' }],
  });
  const counts = await prisma.associate.groupBy({
    by: ['departmentId'],
    where: {
      deletedAt: null,
      departmentId: { in: rows.map((r) => r.id) },
    },
    _count: { _all: true },
  });
  const countByDept = new Map<string, number>(
    counts
      .filter((c): c is typeof c & { departmentId: string } => !!c.departmentId)
      .map((c) => [c.departmentId, c._count._all]),
  );
  const departments: Department[] = rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    parentId: r.parentId,
    name: r.name,
    code: r.code,
    description: r.description,
    associateCount: countByDept.get(r.id) ?? 0,
  }));
  const body = DepartmentListResponseSchema.parse({ departments });
  res.json(body);
});

orgRouter.post('/departments', MANAGE, async (req: Request, res: Response) => {
  const input = DepartmentInputSchema.parse(req.body);
  // parentId, if given, must belong to the same client.
  if (input.parentId) {
    const parent = await prisma.department.findUnique({
      where: { id: input.parentId },
    });
    if (!parent || parent.clientId !== input.clientId) {
      throw new HttpError(400, 'parent_invalid', 'Parent department mismatched.');
    }
  }
  const created = await prisma.department.create({
    data: {
      clientId: input.clientId,
      parentId: input.parentId ?? null,
      name: input.name,
      code: input.code ?? null,
      description: input.description ?? null,
    },
  });
  await audit(req, 'department.create', 'Department', created.id, {
    name: created.name,
    clientId: created.clientId,
  });
  res.status(201).json({
    id: created.id,
    clientId: created.clientId,
    parentId: created.parentId,
    name: created.name,
    code: created.code,
    description: created.description,
    associateCount: 0,
  });
});

orgRouter.put('/departments/:id', MANAGE, async (req: Request, res: Response) => {
  const id = req.params.id;
  const input = DepartmentInputSchema.partial({ clientId: true }).parse(req.body);
  const existing = await prisma.department.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Department not found.');
  }
  if (input.parentId === id) {
    throw new HttpError(400, 'parent_invalid', 'Department cannot be its own parent.');
  }
  const updated = await prisma.department.update({
    where: { id },
    data: {
      parentId: input.parentId === undefined ? undefined : input.parentId,
      name: input.name ?? undefined,
      code: input.code === undefined ? undefined : input.code,
      description: input.description === undefined ? undefined : input.description,
    },
  });
  await audit(req, 'department.update', 'Department', id, {});
  res.json({
    id: updated.id,
    clientId: updated.clientId,
    parentId: updated.parentId,
    name: updated.name,
    code: updated.code,
    description: updated.description,
    associateCount: 0,
  });
});

orgRouter.delete(
  '/departments/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Department not found.');
    }
    await prisma.department.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Detach existing associates (Prisma's onDelete: SetNull doesn't fire on
    // soft-delete, so we set FK to null explicitly).
    await prisma.associate.updateMany({
      where: { departmentId: id },
      data: { departmentId: null },
    });
    await audit(req, 'department.delete', 'Department', id, {});
    res.status(204).end();
  },
);

// ----- Cost centers -------------------------------------------------------

orgRouter.get('/cost-centers', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const where = {
    deletedAt: null,
    ...(clientId ? { clientId } : {}),
  };
  const rows = await prisma.costCenter.findMany({
    where,
    orderBy: [{ code: 'asc' }],
  });
  const counts = await prisma.associate.groupBy({
    by: ['costCenterId'],
    where: {
      deletedAt: null,
      costCenterId: { in: rows.map((r) => r.id) },
    },
    _count: { _all: true },
  });
  const countByCc = new Map<string, number>(
    counts
      .filter((c): c is typeof c & { costCenterId: string } => !!c.costCenterId)
      .map((c) => [c.costCenterId, c._count._all]),
  );
  const costCenters: CostCenter[] = rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    code: r.code,
    name: r.name,
    description: r.description,
    associateCount: countByCc.get(r.id) ?? 0,
  }));
  const body = CostCenterListResponseSchema.parse({ costCenters });
  res.json(body);
});

orgRouter.post('/cost-centers', MANAGE, async (req: Request, res: Response) => {
  const input = CostCenterInputSchema.parse(req.body);
  const dup = await prisma.costCenter.findFirst({
    where: { clientId: input.clientId, code: input.code, deletedAt: null },
  });
  if (dup) {
    throw new HttpError(409, 'duplicate_code', 'Cost-center code already in use.');
  }
  const created = await prisma.costCenter.create({
    data: {
      clientId: input.clientId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
    },
  });
  await audit(req, 'cost_center.create', 'CostCenter', created.id, {});
  res.status(201).json({
    id: created.id,
    clientId: created.clientId,
    code: created.code,
    name: created.name,
    description: created.description,
    associateCount: 0,
  });
});

orgRouter.put('/cost-centers/:id', MANAGE, async (req: Request, res: Response) => {
  const id = req.params.id;
  const input = CostCenterInputSchema.partial({ clientId: true }).parse(req.body);
  const existing = await prisma.costCenter.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Cost center not found.');
  }
  const updated = await prisma.costCenter.update({
    where: { id },
    data: {
      code: input.code ?? undefined,
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
    },
  });
  await audit(req, 'cost_center.update', 'CostCenter', id, {});
  res.json({
    id: updated.id,
    clientId: updated.clientId,
    code: updated.code,
    name: updated.name,
    description: updated.description,
    associateCount: 0,
  });
});

orgRouter.delete(
  '/cost-centers/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.costCenter.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Cost center not found.');
    }
    await prisma.costCenter.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await prisma.associate.updateMany({
      where: { costCenterId: id },
      data: { costCenterId: null },
    });
    await audit(req, 'cost_center.delete', 'CostCenter', id, {});
    res.status(204).end();
  },
);

// ----- Job profiles -------------------------------------------------------

orgRouter.get('/job-profiles', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const where = {
    deletedAt: null,
    ...(clientId ? { clientId } : {}),
  };
  const rows = await prisma.jobProfile.findMany({
    where,
    orderBy: [{ family: 'asc' }, { level: 'asc' }, { title: 'asc' }],
  });
  const counts = await prisma.associate.groupBy({
    by: ['jobProfileId'],
    where: {
      deletedAt: null,
      jobProfileId: { in: rows.map((r) => r.id) },
    },
    _count: { _all: true },
  });
  const countByJp = new Map<string, number>(
    counts
      .filter((c): c is typeof c & { jobProfileId: string } => !!c.jobProfileId)
      .map((c) => [c.jobProfileId, c._count._all]),
  );
  const jobProfiles: JobProfile[] = rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    code: r.code,
    title: r.title,
    family: r.family,
    level: r.level,
    isExempt: r.isExempt,
    description: r.description,
    associateCount: countByJp.get(r.id) ?? 0,
  }));
  const body = JobProfileListResponseSchema.parse({ jobProfiles });
  res.json(body);
});

orgRouter.post('/job-profiles', MANAGE, async (req: Request, res: Response) => {
  const input = JobProfileInputSchema.parse(req.body);
  const dup = await prisma.jobProfile.findFirst({
    where: { clientId: input.clientId, code: input.code, deletedAt: null },
  });
  if (dup) {
    throw new HttpError(409, 'duplicate_code', 'Job-profile code already in use.');
  }
  const created = await prisma.jobProfile.create({
    data: {
      clientId: input.clientId,
      code: input.code,
      title: input.title,
      family: input.family ?? null,
      level: input.level ?? null,
      isExempt: input.isExempt ?? false,
      description: input.description ?? null,
    },
  });
  await audit(req, 'job_profile.create', 'JobProfile', created.id, {});
  res.status(201).json({
    id: created.id,
    clientId: created.clientId,
    code: created.code,
    title: created.title,
    family: created.family,
    level: created.level,
    isExempt: created.isExempt,
    description: created.description,
    associateCount: 0,
  });
});

orgRouter.put('/job-profiles/:id', MANAGE, async (req: Request, res: Response) => {
  const id = req.params.id;
  const input = JobProfileInputSchema.partial({ clientId: true }).parse(req.body);
  const existing = await prisma.jobProfile.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Job profile not found.');
  }
  const updated = await prisma.jobProfile.update({
    where: { id },
    data: {
      code: input.code ?? undefined,
      title: input.title ?? undefined,
      family: input.family === undefined ? undefined : input.family,
      level: input.level === undefined ? undefined : input.level,
      isExempt: input.isExempt ?? undefined,
      description: input.description === undefined ? undefined : input.description,
    },
  });
  await audit(req, 'job_profile.update', 'JobProfile', id, {});
  res.json({
    id: updated.id,
    clientId: updated.clientId,
    code: updated.code,
    title: updated.title,
    family: updated.family,
    level: updated.level,
    isExempt: updated.isExempt,
    description: updated.description,
    associateCount: 0,
  });
});

orgRouter.delete(
  '/job-profiles/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const existing = await prisma.jobProfile.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Job profile not found.');
    }
    await prisma.jobProfile.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await prisma.associate.updateMany({
      where: { jobProfileId: id },
      data: { jobProfileId: null },
    });
    await audit(req, 'job_profile.delete', 'JobProfile', id, {});
    res.status(204).end();
  },
);

// ----- Associate-side org assignment + listing -----------------------------

orgRouter.get('/associates', VIEW, async (req: Request, res: Response) => {
  const clientId =
    typeof req.query.clientId === 'string' ? req.query.clientId : undefined;
  const rows = await prisma.associate.findMany({
    where: {
      deletedAt: null,
      ...(clientId
        ? {
            applications: {
              some: { clientId, deletedAt: null },
            },
          }
        : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      photoS3Key: true,
      photoUpdatedAt: true,
      managerId: true,
      manager: { select: { firstName: true, lastName: true } },
      departmentId: true,
      department: { select: { name: true } },
      costCenterId: true,
      costCenter: { select: { code: true } },
      jobProfileId: true,
      jobProfile: { select: { title: true } },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  const body: AssociateOrgListResponse = {
    associates: rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      managerId: r.managerId,
      managerName: r.manager
        ? `${r.manager.firstName} ${r.manager.lastName}`.trim()
        : null,
      departmentId: r.departmentId,
      departmentName: r.department?.name ?? null,
      costCenterId: r.costCenterId,
      costCenterCode: r.costCenter?.code ?? null,
      jobProfileId: r.jobProfileId,
      jobProfileTitle: r.jobProfile?.title ?? null,
      photoUrl: profilePhotoUrlFor({
        id: r.id,
        photoS3Key: r.photoS3Key,
        photoUpdatedAt: r.photoUpdatedAt,
      }),
    })),
  };
  res.json(body);
});

orgRouter.put(
  '/associates/:id/org',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const input = AssociateOrgAssignmentInputSchema.parse(req.body);
    const existing = await prisma.associate.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    if (input.managerId === id) {
      throw new HttpError(
        400,
        'self_manager',
        'An associate cannot manage themselves.',
      );
    }
    if (input.managerId) {
      // Defensive cycle guard: walk up the proposed manager's chain and
      // reject if we hit `id`. Pure read loop, bounded by chain depth.
      let cursor: string | null = input.managerId;
      const visited = new Set<string>();
      while (cursor) {
        if (cursor === id) {
          throw new HttpError(
            400,
            'manager_cycle',
            'Manager assignment would create a cycle.',
          );
        }
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const next: { managerId: string | null } | null =
          await prisma.associate.findUnique({
            where: { id: cursor },
            select: { managerId: true },
          });
        cursor = next?.managerId ?? null;
      }
    }
    const updated = await prisma.associate.update({
      where: { id },
      data: {
        managerId: input.managerId === undefined ? undefined : input.managerId,
        departmentId:
          input.departmentId === undefined ? undefined : input.departmentId,
        costCenterId:
          input.costCenterId === undefined ? undefined : input.costCenterId,
        jobProfileId:
          input.jobProfileId === undefined ? undefined : input.jobProfileId,
      },
    });
    // Phase 77 — record into AssociateHistory if anything actually changed.
    // Helper is idempotent: if the snapshot matches the current row it's a
    // no-op, so we can call it unconditionally on every PUT.
    await recordChange(prisma, {
      associateId: id,
      managerId: updated.managerId,
      departmentId: updated.departmentId,
      costCenterId: updated.costCenterId,
      jobProfileId: updated.jobProfileId,
      state: updated.state,
      hourlyRate: null,
      reason: 'org_assign',
      actorUserId: req.user!.id,
    });
    await audit(req, 'associate.org_assign', 'Associate', id, {
      managerId: updated.managerId,
      departmentId: updated.departmentId,
      costCenterId: updated.costCenterId,
      jobProfileId: updated.jobProfileId,
    });
    res.json({
      id: updated.id,
      managerId: updated.managerId,
      departmentId: updated.departmentId,
      costCenterId: updated.costCenterId,
      jobProfileId: updated.jobProfileId,
    });
  },
);

// ----- Effective-dated history -------------------------------------------

orgRouter.get(
  '/associates/:id/history',
  VIEW,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const rows = await prisma.associateHistory.findMany({
      where: { associateId: id },
      orderBy: { effectiveFrom: 'desc' },
      include: {
        actor: { select: { email: true } },
      },
    });
    res.json({
      history: rows.map((r) => ({
        id: r.id,
        effectiveFrom: r.effectiveFrom.toISOString(),
        effectiveTo: r.effectiveTo?.toISOString() ?? null,
        managerId: r.managerId,
        departmentId: r.departmentId,
        costCenterId: r.costCenterId,
        jobProfileId: r.jobProfileId,
        state: r.state,
        hourlyRate: r.hourlyRate?.toString() ?? null,
        reason: r.reason,
        actorEmail: r.actor?.email ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

orgRouter.get(
  '/associates/:id/as-of',
  VIEW,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const whenStr =
      typeof req.query.when === 'string' ? req.query.when : undefined;
    const when = whenStr ? new Date(whenStr) : new Date();
    if (Number.isNaN(when.getTime())) {
      throw new HttpError(400, 'invalid_when', 'Invalid `when` timestamp.');
    }
    const snapshot = await asOf(prisma, id, when);
    if (!snapshot) {
      res.json({ snapshot: null, when: when.toISOString() });
      return;
    }
    res.json({
      when: when.toISOString(),
      snapshot: {
        managerId: snapshot.managerId,
        departmentId: snapshot.departmentId,
        costCenterId: snapshot.costCenterId,
        jobProfileId: snapshot.jobProfileId,
        state: snapshot.state,
        hourlyRate: snapshot.hourlyRate?.toString() ?? null,
      },
    });
  },
);

// ----- HR-side profile patch ---------------------------------------------
// Lets HR fix plain associate fields (today: phone) directly from the
// People directory drawer without bouncing the associate back through
// onboarding's PROFILE_INFO task. Address fields stay out of scope —
// those need to come from the associate themselves so the I-9 / W-4
// chain stays clean.
orgRouter.patch(
  '/associates/:id',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const input = AssociateProfilePatchInputSchema.parse(req.body);
    const existing = await prisma.associate.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    const updated = await prisma.associate.update({
      where: { id },
      data: {
        phone: input.phone === undefined ? undefined : input.phone,
      },
      select: { id: true, phone: true },
    });
    audit(req, 'associate.profile_patch', 'Associate', id, {
      phoneChanged: input.phone !== undefined,
    });
    res.json(updated);
  },
);
