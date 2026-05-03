import { Router } from 'express';
import { z } from 'zod';
import { ROLE_LABELS } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAssociate, notifyManager } from '../lib/notify.js';
import {
  probationAssociateTemplate,
  probationManagerTemplate,
} from '../lib/emailTemplates.js';

/**
 * Phase 116 — Probation period tracking.
 *
 * Reuses view:onboarding / manage:onboarding caps. Probation is the natural
 * extension of onboarding — same audience that owns the new-hire pipeline
 * makes the pass/extend/fail call.
 *
 * State machine: ACTIVE → PASSED | FAILED is terminal. EXTENDED closes the
 * current row and opens a new ACTIVE row with a later endDate. The partial
 * unique index on associateId WHERE status='ACTIVE' guarantees we never
 * have two open probations for the same person.
 */

export const probation116Router = Router();

// Probation lists are org-wide HR data — gate on view:hr-admin
// so associates with view:onboarding (their own application page)
// can't enumerate every probation period.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:onboarding');

// ----- Start a probation period --------------------------------------------

const StartInputSchema = z.object({
  associateId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

probation116Router.post('/probations', MANAGE, async (req, res) => {
  const input = StartInputSchema.parse(req.body);
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  if (input.endDate <= input.startDate) {
    throw new HttpError(
      400,
      'invalid_dates',
      'End date must be after start date.',
    );
  }
  try {
    const created = await prisma.probationPeriod.create({
      data: {
        associateId: input.associateId,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        createdById: req.user!.id,
      },
    });
    const actor = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        email: true,
        role: true,
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    const actorName = actor?.associate
      ? `${actor.associate.firstName} ${actor.associate.lastName}`
      : actor?.email ?? 'HR';
    const actorRole = actor?.role ? ROLE_LABELS[actor.role] : 'HR Administrator';
    const durationDays = Math.max(
      1,
      Math.round(
        (new Date(input.endDate).getTime() - new Date(input.startDate).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    );
    const assocTpl = probationAssociateTemplate({
      firstName: associate.firstName,
      startDate: input.startDate,
      endDate: input.endDate,
      durationDays,
      actor: { name: actorName, role: actorRole },
    });
    void notifyAssociate(input.associateId, {
      subject: assocTpl.subject,
      body: assocTpl.text,
      html: assocTpl.html,
      category: 'probation',
    });
    const mgrTpl = probationManagerTemplate({
      associateName: `${associate.firstName} ${associate.lastName}`,
      startDate: input.startDate,
      endDate: input.endDate,
      actor: { name: actorName, role: actorRole },
    });
    void notifyManager(input.associateId, {
      subject: mgrTpl.subject,
      body: mgrTpl.text,
      html: mgrTpl.html,
      category: 'probation',
    });
    res.status(201).json({ id: created.id });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'already_active',
        'Associate already has an active probation. Decide it first.',
      );
    }
    throw err;
  }
});

// ----- List + filter -------------------------------------------------------

probation116Router.get('/probations', VIEW, async (req, res) => {
  const status = z
    .enum(['ACTIVE', 'PASSED', 'EXTENDED', 'FAILED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.probationPeriod.findMany({
    where: status ? { status } : {},
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          jobProfile: { select: { title: true } },
        },
      },
      decidedBy: { select: { id: true, email: true } },
    },
    orderBy: { endDate: 'asc' },
  });
  res.json({
    probations: rows.map((p) => ({
      id: p.id,
      associateId: p.associateId,
      associateName: `${p.associate.firstName} ${p.associate.lastName}`,
      associateEmail: p.associate.email,
      currentTitle: p.associate.jobProfile?.title ?? null,
      startDate: p.startDate.toISOString().slice(0, 10),
      endDate: p.endDate.toISOString().slice(0, 10),
      status: p.status,
      decision: p.decision,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      decidedByEmail: p.decidedBy?.email ?? null,
    })),
  });
});

// ----- "Ending soon" feed --------------------------------------------------

probation116Router.get('/probations/ending-soon', VIEW, async (req, res) => {
  const days = z.coerce.number().int().min(1).max(180).default(14).parse(
    req.query.days,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() + days);

  const rows = await prisma.probationPeriod.findMany({
    where: {
      status: 'ACTIVE',
      endDate: { lte: cutoff },
    },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          managerId: true,
          manager: { select: { firstName: true, lastName: true } },
          jobProfile: { select: { title: true } },
        },
      },
    },
    orderBy: { endDate: 'asc' },
  });
  res.json({
    days,
    probations: rows.map((p) => {
      const daysUntil = Math.round(
        (p.endDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      return {
        id: p.id,
        associateId: p.associateId,
        associateName: `${p.associate.firstName} ${p.associate.lastName}`,
        currentTitle: p.associate.jobProfile?.title ?? null,
        managerName: p.associate.manager
          ? `${p.associate.manager.firstName} ${p.associate.manager.lastName}`
          : null,
        endDate: p.endDate.toISOString().slice(0, 10),
        daysUntil,
        overdue: daysUntil < 0,
      };
    }),
  });
});

// ----- Decide (pass / fail) ------------------------------------------------

const DecideInputSchema = z.object({
  decision: z.enum(['PASSED', 'FAILED']),
  notes: z.string().max(2000).optional().nullable(),
});

probation116Router.post(
  '/probations/:id/decide',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = DecideInputSchema.parse(req.body);
    const existing = await prisma.probationPeriod.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Probation not found.');
    }
    if (existing.status !== 'ACTIVE') {
      throw new HttpError(
        409,
        'already_decided',
        `Probation is ${existing.status}, cannot decide again.`,
      );
    }
    await prisma.probationPeriod.update({
      where: { id },
      data: {
        status: input.decision,
        decision: input.notes ?? null,
        decidedById: req.user!.id,
        decidedAt: new Date(),
      },
    });
    res.json({ ok: true });
  },
);

// ----- Extend (close active, open new) -------------------------------------

const ExtendInputSchema = z.object({
  newEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).optional().nullable(),
});

probation116Router.post(
  '/probations/:id/extend',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = ExtendInputSchema.parse(req.body);
    const existing = await prisma.probationPeriod.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Probation not found.');
    }
    if (existing.status !== 'ACTIVE') {
      throw new HttpError(
        409,
        'not_active',
        `Probation is ${existing.status}, cannot extend.`,
      );
    }
    const newEnd = new Date(input.newEndDate);
    if (newEnd <= existing.endDate) {
      throw new HttpError(
        400,
        'must_extend_forward',
        'New end date must be after the current end date.',
      );
    }
    const created = await prisma.$transaction(async (tx) => {
      await tx.probationPeriod.update({
        where: { id },
        data: {
          status: 'EXTENDED',
          decision: input.notes ?? null,
          decidedById: req.user!.id,
          decidedAt: new Date(),
        },
      });
      return tx.probationPeriod.create({
        data: {
          associateId: existing.associateId,
          startDate: existing.startDate,
          endDate: newEnd,
          status: 'ACTIVE',
          createdById: req.user!.id,
        },
      });
    });
    res.status(201).json({ id: created.id });
  },
);

// ----- Summary -------------------------------------------------------------

probation116Router.get('/probations/summary', VIEW, async (_req, res) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff14 = new Date(today);
  cutoff14.setUTCDate(cutoff14.getUTCDate() + 14);
  const cutoff90Back = new Date(today);
  cutoff90Back.setUTCDate(cutoff90Back.getUTCDate() - 90);

  const [active, endingSoon, overdue, passedRecent, failedRecent] =
    await Promise.all([
      prisma.probationPeriod.count({ where: { status: 'ACTIVE' } }),
      prisma.probationPeriod.count({
        where: {
          status: 'ACTIVE',
          endDate: { gte: today, lte: cutoff14 },
        },
      }),
      prisma.probationPeriod.count({
        where: { status: 'ACTIVE', endDate: { lt: today } },
      }),
      prisma.probationPeriod.count({
        where: { status: 'PASSED', decidedAt: { gte: cutoff90Back } },
      }),
      prisma.probationPeriod.count({
        where: { status: 'FAILED', decidedAt: { gte: cutoff90Back } },
      }),
    ]);

  res.json({
    active,
    endingSoon,
    overdue,
    passedLast90Days: passedRecent,
    failedLast90Days: failedRecent,
  });
});
