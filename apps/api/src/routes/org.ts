import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  AssociateOrgAssignmentInputSchema,
  AssociateProfilePatchInputSchema,
  AssociateTransferInputSchema,
  CostCenterInputSchema,
  CostCenterListResponseSchema,
  DepartmentInputSchema,
  DepartmentListResponseSchema,
  JobProfileInputSchema,
  JobProfileListResponseSchema,
  type AssociateOrgListResponse,
  type AssociateTransferResponse,
  type CostCenter,
  type Department,
  type JobProfile,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { asOf, recordChange } from '../lib/associateHistory.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { decryptString } from '../lib/crypto.js';
import { z } from 'zod';
import { hasCapability } from '@alto-people/shared';

export const orgRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
// Anyone who can run payroll can read masked direct-deposit info; the
// full-number reveal is gated below. HR_ADMINISTRATOR + FINANCE_ACCOUNTANT
// + the FULL_ADMIN role family all carry process:payroll, which matches
// the "Owner + Payroll admin + HR admin" audience the product owner
// chose for this surface.
const PAYROLL_OR_HR = requireCapability('process:payroll');

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
    take: 1000,
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
    take: 1000,
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
    take: 1000,
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
    take: 1000,
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
      take: 500,
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

// ----- Direct-deposit reveal --------------------------------------------
//
// Two endpoints for payment-issue auditing:
//
//   GET  /associates/:id/payout-method          → masked summary
//   POST /associates/:id/payout-method/reveal   → full routing + account
//
// The full-reveal endpoint requires a written reason, is audit-logged
// with the reason + IP + UA, and returns the plaintext numbers exactly
// once per call (no caching). The masked GET is fine for the general
// payroll/HR audience; reveal is also gated on process:payroll but
// the audit trail + required reason are the actual safeguards.

const RevealReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(8, 'Reason must be at least 8 characters.')
    .max(500),
});

async function loadPrimaryPayoutMethod(associateId: string) {
  const associate = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { id: true, deletedAt: true, firstName: true, lastName: true },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'not_found', 'Associate not found.');
  }
  const payout = await prisma.payoutMethod.findFirst({
    where: { associateId, isPrimary: true },
  });
  return { associate, payout };
}

orgRouter.get(
  '/associates/:id/payout-method',
  PAYROLL_OR_HR,
  async (req: Request, res: Response) => {
    const { payout } = await loadPrimaryPayoutMethod(req.params.id);
    if (!payout) {
      res.json({ hasPayoutMethod: false });
      return;
    }
    let routingMasked: string | null = null;
    let accountLast4: string | null = null;
    try {
      if (payout.routingNumberEnc) {
        // Routing is stored as plain UTF-8 (per the comment in the
        // onboarding POST handler) — decode, mask all but last 4.
        const r = payout.routingNumberEnc.toString('utf8');
        routingMasked = `•••••${r.slice(-4)}`;
      }
      if (payout.accountNumberEnc) {
        const a = decryptString(payout.accountNumberEnc);
        accountLast4 = a.slice(-4);
      }
    } catch {
      routingMasked = null;
      accountLast4 = null;
    }
    res.json({
      hasPayoutMethod: true,
      type: payout.type,
      accountType: payout.accountType,
      routingMasked,
      accountLast4,
      branchCardId: payout.branchCardId,
      verifiedAt: payout.verifiedAt?.toISOString() ?? null,
      updatedAt: payout.updatedAt?.toISOString() ?? null,
    });
  },
);

orgRouter.post(
  '/associates/:id/payout-method/reveal',
  PAYROLL_OR_HR,
  async (req: Request, res: Response) => {
    // Belt-and-braces: also require process:payroll explicitly here so
    // the middleware change can't accidentally widen exposure. The
    // capability constant could be inlined; the redundant check is
    // cheap insurance for a sensitive endpoint.
    if (!hasCapability(req.user!.role, 'process:payroll')) {
      throw new HttpError(403, 'forbidden', 'Missing capability: process:payroll');
    }

    const { reason } = RevealReasonSchema.parse(req.body);
    const { associate, payout } = await loadPrimaryPayoutMethod(req.params.id);

    if (!payout) {
      throw new HttpError(
        404,
        'no_payout_method',
        'This associate has no direct-deposit method on file.',
      );
    }

    let routingNumber: string | null = null;
    let accountNumber: string | null = null;
    try {
      if (payout.routingNumberEnc) {
        routingNumber = payout.routingNumberEnc.toString('utf8');
      }
      if (payout.accountNumberEnc) {
        accountNumber = decryptString(payout.accountNumberEnc);
      }
    } catch (err) {
      // Decryption failure usually means PAYOUT_ENCRYPTION_KEY rotated
      // after the row was stored. Surface a 500 with a specific code so
      // ops knows to roll the key forward instead of seeing "null".
      throw new HttpError(
        500,
        'decrypt_failed',
        'Could not decrypt the stored account number — the encryption key may have rotated since this method was saved. Have the associate re-enter their direct deposit.',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }

    // AuditLog: who, when, why, from where. Every reveal lands a row
    // visible at /audit so the trail is the actual control on this
    // power, not just the capability gate. Critical: we MUST persist the
    // audit row before responding with the decrypted account number — a
    // missing reveal is the difference between "audited disclosure" and
    // "data exfiltration without a paper trail". If Postgres fails here,
    // the caller gets a 500 and never sees the cleartext.
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        action: 'associate.payout_method_revealed',
        entityType: 'PayoutMethod',
        entityId: payout.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          associateId: associate.id,
          reason,
        },
      },
      'org.associate.payout_method_revealed',
    );

    res.json({
      type: payout.type,
      accountType: payout.accountType,
      routingNumber,
      accountNumber,
      branchCardId: payout.branchCardId,
      verifiedAt: payout.verifiedAt?.toISOString() ?? null,
      updatedAt: payout.updatedAt?.toISOString() ?? null,
    });
  },
);

// ----- SSN / TIN reveal ---------------------------------------------------
//
// Mirrors the direct-deposit reveal above, byte for byte in posture:
//
//   GET  /associates/:id/ssn          → masked summary (last 4 only)
//   POST /associates/:id/ssn/reveal   → full number, exactly once
//
// The onboarding packet deliberately redacts the SSN; this is the audited
// path for the legitimate cases (I-9/E-Verify corrections, state filings,
// background-check disputes). Same safeguards as banking: written reason,
// critical audit row persisted BEFORE the plaintext leaves the server,
// IP + UA recorded, no caching.
//
// Source order: a W-2 employee's SSN lives on their W-4 submission
// (W4Submission.ssnEncrypted); a 1099 contractor's SSN/EIN lives on the
// associate (tinEncrypted). Both decrypt with the same AES-GCM helper.

async function loadSsnSource(associateId: string) {
  const associate = await prisma.associate.findUnique({
    where: { id: associateId },
    select: {
      id: true,
      deletedAt: true,
      firstName: true,
      lastName: true,
      ssnLast4: true,
      employmentType: true,
      tinEncrypted: true,
      w4Submission: { select: { ssnEncrypted: true } },
    },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'not_found', 'Associate not found.');
  }
  const cipher =
    associate.w4Submission?.ssnEncrypted ?? associate.tinEncrypted ?? null;
  const source: 'W4' | 'TIN' | null = associate.w4Submission?.ssnEncrypted
    ? 'W4'
    : associate.tinEncrypted
      ? 'TIN'
      : null;
  return { associate, cipher, source };
}

function formatTaxId(digits: string, kind: 'SSN' | 'EIN'): string {
  const d = digits.replace(/\D/g, '');
  if (d.length !== 9) return digits; // unexpected shape — return as stored
  return kind === 'EIN'
    ? `${d.slice(0, 2)}-${d.slice(2)}`
    : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

orgRouter.get(
  '/associates/:id/ssn',
  PAYROLL_OR_HR,
  async (req: Request, res: Response) => {
    const { associate, cipher, source } = await loadSsnSource(req.params.id);
    res.json({
      hasSsn: cipher !== null,
      ssnLast4: associate.ssnLast4,
      source,
    });
  },
);

orgRouter.post(
  '/associates/:id/ssn/reveal',
  PAYROLL_OR_HR,
  async (req: Request, res: Response) => {
    // Same belt-and-braces double check as the payout reveal.
    if (!hasCapability(req.user!.role, 'process:payroll')) {
      throw new HttpError(403, 'forbidden', 'Missing capability: process:payroll');
    }

    const { reason } = RevealReasonSchema.parse(req.body);
    const { associate, cipher, source } = await loadSsnSource(req.params.id);

    if (!cipher) {
      throw new HttpError(
        404,
        'no_ssn',
        'This associate has no SSN/TIN on file — it is collected on the W-4 (W-2 employees) or as a TIN (1099 contractors) during onboarding.',
      );
    }

    let plaintext: string;
    try {
      plaintext = decryptString(cipher);
    } catch (err) {
      throw new HttpError(
        500,
        'decrypt_failed',
        'Could not decrypt the stored number — the encryption key may have rotated since it was saved. Have the associate resubmit their W-4.',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    const kind: 'SSN' | 'EIN' =
      source === 'TIN' && associate.employmentType === 'CONTRACTOR_1099_BUSINESS'
        ? 'EIN'
        : 'SSN';

    // Audit row MUST land before the plaintext leaves — a missing row is
    // the difference between an audited disclosure and silent exfiltration.
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        action: 'associate.ssn_revealed',
        entityType: 'Associate',
        entityId: associate.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          source,
          kind,
          reason,
        },
      },
      'org.associate.ssn_revealed',
    );

    res.json({
      kind,
      source,
      number: formatTaxId(plaintext, kind),
    });
  },
);

// ----- Phase 131 — transfer to a new Location ----------------------------
//
// Closes the associate's open AssociateAssignment (sets endedAt = the
// requested startedAt) and opens a new one at the target Location.
// First-time placement (no open row yet) just opens a row.
//
// v1 enforces intra-client transfers only: the target Location must
// belong to the associate's current client. Current client = the
// client of the open assignment's Location, falling back to the
// client of the most-recent APPROVED Application. Cross-client moves
// require a new Application (different feature).
orgRouter.post(
  '/associates/:id/transfer',
  MANAGE,
  async (req: Request, res: Response) => {
    const id = req.params.id;
    const input = AssociateTransferInputSchema.parse(req.body);
    const associate = await prisma.associate.findUnique({ where: { id } });
    if (!associate || associate.deletedAt) {
      throw new HttpError(404, 'not_found', 'Associate not found.');
    }
    const target = await prisma.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, clientId: true, name: true, deletedAt: true, isActive: true },
    });
    if (!target || target.deletedAt || !target.isActive) {
      throw new HttpError(404, 'location_not_found', 'Target location not found.');
    }
    const open = await prisma.associateAssignment.findFirst({
      where: { associateId: id, endedAt: null },
      select: { id: true, location: { select: { clientId: true } } },
    });
    let expectedClientId = open?.location.clientId ?? null;
    if (expectedClientId === null) {
      const latestApproved = await prisma.application.findFirst({
        where: { associateId: id, status: 'APPROVED', deletedAt: null },
        orderBy: { invitedAt: 'desc' },
        select: { clientId: true },
      });
      expectedClientId = latestApproved?.clientId ?? null;
    }
    if (expectedClientId !== null && expectedClientId !== target.clientId) {
      throw new HttpError(
        400,
        'cross_client_transfer',
        'Target location belongs to a different client. Cross-client transfers require a new application.',
      );
    }
    const startedAt = new Date(input.startedAt + 'T00:00:00Z');
    if (Number.isNaN(startedAt.getTime())) {
      throw new HttpError(400, 'invalid_started_at', 'Invalid startedAt date.');
    }
    const created = await prisma.$transaction(async (tx) => {
      if (open) {
        await tx.associateAssignment.update({
          where: { id: open.id },
          data: { endedAt: startedAt },
        });
      }
      return tx.associateAssignment.create({
        data: {
          associateId: id,
          locationId: target.id,
          startedAt,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          notedById: req.user!.id,
        },
        select: { id: true, associateId: true, locationId: true, startedAt: true },
      });
    });
    audit(req, 'associate.transfer', 'Associate', id, {
      fromAssignmentId: open?.id ?? null,
      toLocationId: target.id,
      startedAt: input.startedAt,
    });
    const response: AssociateTransferResponse = {
      id: created.id,
      associateId: created.associateId,
      locationId: created.locationId,
      locationName: target.name,
      startedAt: created.startedAt.toISOString().slice(0, 10),
    };
    res.status(201).json(response);
  },
);
