import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 85 — Qualifications + open-shift marketplace.
 *
 * /qualifications
 *   GET    catalog (filterable by clientId; null clientId = global)
 *   POST   create (manage:scheduling)
 *   PUT    /:id update
 *   DELETE /:id soft-delete
 *
 * /qualifications/associates/:associateId
 *   GET    list a single associate's quals
 *   POST   grant a qual to an associate
 *   DELETE /:assocQualId remove
 *
 * /shifts/:shiftId/qualifications
 *   GET    list required quals
 *   POST   add a requirement
 *   DELETE /:reqId remove
 *
 * /shifts/open
 *   GET    OPEN shifts the requesting associate is qualified for
 *
 * /shifts/:shiftId/claim
 *   POST   create a claim (associate self-service)
 *   PUT    /:claimId  approve / reject / withdraw (status from body)
 */

export const qualificationsRouter = Router();

const VIEW_SCHED = requireCapability('view:scheduling');
const MANAGE_SCHED = requireCapability('manage:scheduling');

// ----- Qualification catalog --------------------------------------------

const QualInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  isCert: z.boolean().optional(),
});

qualificationsRouter.get('/qualifications', VIEW_SCHED, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.qualification.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      ...(clientId
        ? { OR: [{ clientId }, { clientId: null }] }
        : {}),
    },
    orderBy: [{ clientId: 'asc' }, { name: 'asc' }],
  });
  res.json({ qualifications: rows });
});

qualificationsRouter.post(
  '/qualifications',
  MANAGE_SCHED,
  async (req, res) => {
    const input = QualInputSchema.parse(req.body);
    const created = await prisma.qualification.create({
      data: {
        clientId: input.clientId ?? null,
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        isCert: input.isCert ?? false,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

qualificationsRouter.put(
  '/qualifications/:id',
  MANAGE_SCHED,
  async (req, res) => {
    const id = req.params.id;
    const input = QualInputSchema.partial().parse(req.body);
    await prisma.qualification.update({
      where: { id },
      data: {
        code: input.code ?? undefined,
        name: input.name ?? undefined,
        description: input.description === undefined ? undefined : input.description,
        isCert: input.isCert ?? undefined,
      },
    });
    res.json({ ok: true });
  },
);

qualificationsRouter.delete(
  '/qualifications/:id',
  MANAGE_SCHED,
  async (req, res) => {
    const id = req.params.id;
    await prisma.qualification.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  },
);

// ----- AssociateQualification --------------------------------------------

const AssocQualInputSchema = z.object({
  qualificationId: z.string().uuid(),
  acquiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  evidenceKey: z.string().max(500).optional().nullable(),
});

qualificationsRouter.get(
  '/qualifications/associates/:associateId',
  VIEW_SCHED,
  async (req, res) => {
    const associateId = req.params.associateId;
    const rows = await prisma.associateQualification.findMany({
      take: 500,
      where: { associateId, deletedAt: null },
      include: { qualification: true },
    });
    res.json({
      qualifications: rows.map((r) => ({
        id: r.id,
        qualificationId: r.qualificationId,
        code: r.qualification.code,
        name: r.qualification.name,
        isCert: r.qualification.isCert,
        acquiredAt: r.acquiredAt?.toISOString().slice(0, 10) ?? null,
        expiresAt: r.expiresAt?.toISOString().slice(0, 10) ?? null,
        evidenceKey: r.evidenceKey,
      })),
    });
  },
);

qualificationsRouter.post(
  '/qualifications/associates/:associateId',
  MANAGE_SCHED,
  async (req, res) => {
    const associateId = req.params.associateId;
    const input = AssocQualInputSchema.parse(req.body);
    // Upsert: if a soft-deleted row exists, reuse it; if a live row exists, update it.
    const existing = await prisma.associateQualification.findFirst({
      where: { associateId, qualificationId: input.qualificationId },
    });
    if (existing) {
      await prisma.associateQualification.update({
        where: { id: existing.id },
        data: {
          acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          evidenceKey: input.evidenceKey ?? null,
          deletedAt: null,
        },
      });
      res.json({ id: existing.id });
      return;
    }
    const created = await prisma.associateQualification.create({
      data: {
        associateId,
        qualificationId: input.qualificationId,
        acquiredAt: input.acquiredAt ? new Date(input.acquiredAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        evidenceKey: input.evidenceKey ?? null,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

qualificationsRouter.delete(
  '/qualifications/associates/:associateId/:assocQualId',
  MANAGE_SCHED,
  async (req, res) => {
    const { associateId, assocQualId } = req.params;
    const existing = await prisma.associateQualification.findUnique({
      where: { id: assocQualId },
    });
    if (!existing || existing.associateId !== associateId) {
      throw new HttpError(404, 'not_found', 'Not found.');
    }
    await prisma.associateQualification.update({
      where: { id: assocQualId },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  },
);

// ----- Shift requirements ------------------------------------------------

qualificationsRouter.get(
  '/shifts/:shiftId/qualifications',
  VIEW_SCHED,
  async (req, res) => {
    const shiftId = req.params.shiftId;
    const rows = await prisma.shiftQualificationRequirement.findMany({
      take: 500,
      where: { shiftId },
      include: { qualification: true },
    });
    res.json({
      requirements: rows.map((r) => ({
        id: r.id,
        qualificationId: r.qualificationId,
        code: r.qualification.code,
        name: r.qualification.name,
      })),
    });
  },
);

qualificationsRouter.post(
  '/shifts/:shiftId/qualifications',
  MANAGE_SCHED,
  async (req, res) => {
    const shiftId = req.params.shiftId;
    const input = z.object({ qualificationId: z.string().uuid() }).parse(req.body);
    const created = await prisma.shiftQualificationRequirement.create({
      data: { shiftId, qualificationId: input.qualificationId },
    });
    res.status(201).json({ id: created.id });
  },
);

qualificationsRouter.delete(
  '/shifts/:shiftId/qualifications/:reqId',
  MANAGE_SCHED,
  async (req, res) => {
    const { shiftId, reqId } = req.params;
    const existing = await prisma.shiftQualificationRequirement.findUnique({
      where: { id: reqId },
    });
    if (!existing || existing.shiftId !== shiftId) {
      throw new HttpError(404, 'not_found', 'Not found.');
    }
    await prisma.shiftQualificationRequirement.delete({ where: { id: reqId } });
    res.status(204).end();
  },
);

// ----- Open-shift marketplace --------------------------------------------

/**
 * List OPEN shifts the requesting associate is qualified to claim. Filters
 * by status=OPEN AND every required qual on the shift exists (and isn't
 * expired) on the associate.
 */
qualificationsRouter.get(
  '/shifts/open',
  VIEW_SCHED,
  async (req, res) => {
    if (!req.user?.associateId) {
      throw new HttpError(403, 'no_associate_link', 'Open-shift list is for associates only.');
    }
    const associateId = req.user.associateId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Fetch live (unexpired) quals once.
    const myQuals = await prisma.associateQualification.findMany({
      take: 500,
      where: {
        associateId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gte: today } }],
      },
      select: { qualificationId: true },
    });
    const myQualIds = new Set(myQuals.map((q) => q.qualificationId));

    // OPEN, future shifts at any client the associate has visibility into.
    const openShifts = await prisma.shift.findMany({
      where: {
        status: 'OPEN',
        startsAt: { gte: new Date() },
      },
      include: {
        qualReqs: { include: { qualification: true } },
        client: { select: { id: true, name: true } },
        claims: { where: { status: 'PENDING', associateId } },
      },
      orderBy: { startsAt: 'asc' },
      take: 200,
    });

    const eligible = openShifts.filter((s) =>
      s.qualReqs.every((req) => myQualIds.has(req.qualificationId)),
    );

    res.json({
      shifts: eligible.map((s) => ({
        id: s.id,
        clientId: s.client.id,
        clientName: s.client.name,
        position: s.position,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        location: s.location,
        payRate: s.payRate?.toFixed(2) ?? null,
        requirements: s.qualReqs.map((r) => ({
          id: r.qualificationId,
          code: r.qualification.code,
          name: r.qualification.name,
        })),
        myPendingClaim: s.claims[0]?.id ?? null,
      })),
    });
  },
);

qualificationsRouter.post(
  '/shifts/:shiftId/claim',
  VIEW_SCHED,
  async (req, res) => {
    if (!req.user?.associateId) {
      throw new HttpError(403, 'no_associate_link', 'Claim is for associates only.');
    }
    const associateId = req.user.associateId;
    const shiftId = req.params.shiftId;
    const shift = await prisma.shift.findUnique({
      where: { id: shiftId },
      include: { qualReqs: true },
    });
    if (!shift) throw new HttpError(404, 'not_found', 'Shift not found.');
    if (shift.status !== 'OPEN') {
      throw new HttpError(400, 'not_open', 'Shift is not open.');
    }

    // Verify qualifications.
    if (shift.qualReqs.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const myQuals = await prisma.associateQualification.findMany({
        take: 500,
        where: {
          associateId,
          deletedAt: null,
          qualificationId: { in: shift.qualReqs.map((r) => r.qualificationId) },
          OR: [{ expiresAt: null }, { expiresAt: { gte: today } }],
        },
        select: { qualificationId: true },
      });
      const have = new Set(myQuals.map((q) => q.qualificationId));
      const missing = shift.qualReqs.filter((r) => !have.has(r.qualificationId));
      if (missing.length > 0) {
        throw new HttpError(
          403,
          'unqualified',
          `Missing required qualifications: ${missing
            .map((m) => m.qualificationId)
            .join(', ')}.`,
        );
      }
    }

    // One PENDING per (associate, shift) is enforced by the partial unique.
    const created = await prisma.openShiftClaim.create({
      data: { shiftId, associateId },
    });
    res.status(201).json({ id: created.id });
  },
);

qualificationsRouter.put(
  '/shifts/:shiftId/claims/:claimId',
  VIEW_SCHED,
  async (req, res) => {
    const { shiftId, claimId } = req.params;
    const input = z
      .object({
        status: z.enum(['APPROVED', 'REJECTED', 'WITHDRAWN']),
        decisionNote: z.string().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const claim = await prisma.openShiftClaim.findUnique({
      where: { id: claimId },
    });
    if (!claim || claim.shiftId !== shiftId) {
      throw new HttpError(404, 'not_found', 'Claim not found.');
    }

    // Associate can WITHDRAW their own; only managers can APPROVE / REJECT.
    if (input.status === 'WITHDRAWN') {
      if (req.user?.associateId !== claim.associateId) {
        throw new HttpError(403, 'forbidden', 'Only the claimer can withdraw.');
      }
    } else {
      // APPROVE / REJECT requires manage:scheduling.
      const can = req.user?.role
        ? ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'EXECUTIVE_CHAIRMAN'].includes(
            req.user.role,
          )
        : false;
      if (!can) {
        throw new HttpError(403, 'forbidden', 'Manager approval required.');
      }
    }

    if (claim.status !== 'PENDING') {
      throw new HttpError(400, 'wrong_state', 'Claim is not pending.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.openShiftClaim.update({
        where: { id: claimId },
        data: {
          status: input.status,
          decidedById: req.user!.id,
          decidedAt: new Date(),
          decisionNote: input.decisionNote ?? null,
        },
      });
      if (input.status === 'APPROVED') {
        // Assign the shift; auto-reject any other pending claims on this shift.
        await tx.shift.update({
          where: { id: shiftId },
          data: {
            assignedAssociateId: claim.associateId,
            assignedAt: new Date(),
            status: 'ASSIGNED',
          },
        });
        await tx.openShiftClaim.updateMany({
          where: { shiftId, status: 'PENDING', id: { not: claimId } },
          data: {
            status: 'REJECTED',
            decisionNote: 'Shift was awarded to another claimant.',
            decidedAt: new Date(),
          },
        });
      }
    });

    res.json({ ok: true });
  },
);

/**
 * Manager-side queue: every PENDING claim across the manager's scope.
 */
qualificationsRouter.get(
  '/shifts/claims/pending',
  MANAGE_SCHED,
  async (_req, res) => {
    const rows = await prisma.openShiftClaim.findMany({
      where: { status: 'PENDING' },
      include: {
        associate: { select: { firstName: true, lastName: true } },
        shift: {
          select: {
            id: true,
            position: true,
            startsAt: true,
            endsAt: true,
            client: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json({
      claims: rows.map((c) => ({
        id: c.id,
        shiftId: c.shiftId,
        associateId: c.associateId,
        associateName: `${c.associate.firstName} ${c.associate.lastName}`,
        position: c.shift.position,
        clientName: c.shift.client.name,
        startsAt: c.shift.startsAt.toISOString(),
        endsAt: c.shift.endsAt.toISOString(),
        createdAt: c.createdAt.toISOString(),
      })),
    });
  },
);
