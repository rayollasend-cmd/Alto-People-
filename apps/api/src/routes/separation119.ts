import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 119 — Separations + exit interviews.
 *
 * Reuses onboarding caps for symmetry — the same audience that hires people
 * processes their leave. The state machine is one-way: PLANNED → IN_PROGRESS
 * → COMPLETE.
 */

export const separation119Router = Router();

// Separations + exit-interview content are org-wide HR data —
// gate reads on view:hr-admin so associates with view:onboarding
// can't enumerate every termination across the company.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:onboarding');

const REASON = z.enum([
  'VOLUNTARY_OTHER_OPPORTUNITY',
  'VOLUNTARY_PERSONAL',
  'VOLUNTARY_RELOCATION',
  'VOLUNTARY_RETIREMENT',
  'INVOLUNTARY_PERFORMANCE',
  'INVOLUNTARY_LAYOFF',
  'INVOLUNTARY_MISCONDUCT',
  'END_OF_CONTRACT',
  'DECEASED',
  'OTHER',
]);

// ----- List ----------------------------------------------------------------

separation119Router.get('/separations', VIEW, async (req, res) => {
  const status = z
    .enum(['PLANNED', 'IN_PROGRESS', 'COMPLETE'])
    .optional()
    .parse(req.query.status);
  const reason = REASON.optional().parse(req.query.reason);

  const rows = await prisma.separation.findMany({
    take: 100,
    where: {
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      initiatedBy: { select: { email: true } },
      completedBy: { select: { email: true } },
    },
    orderBy: { lastDayWorked: 'desc' },
  });
  res.json({
    separations: rows.map((s) => ({
      id: s.id,
      associateId: s.associateId,
      associateName: `${s.associate.firstName} ${s.associate.lastName}`,
      associateEmail: s.associate.email,
      reason: s.reason,
      status: s.status,
      noticeDate: s.noticeDate?.toISOString().slice(0, 10) ?? null,
      lastDayWorked: s.lastDayWorked.toISOString().slice(0, 10),
      finalPaycheckDate: s.finalPaycheckDate?.toISOString().slice(0, 10) ?? null,
      rating: s.rating,
      reasonNotes: s.reasonNotes,
      feedbackPositive: s.feedbackPositive,
      feedbackImprovement: s.feedbackImprovement,
      wouldRecommend: s.wouldRecommend,
      wouldReturn: s.wouldReturn,
      exitInterviewCompletedAt:
        s.exitInterviewCompletedAt?.toISOString() ?? null,
      initiatedByEmail: s.initiatedBy?.email ?? null,
      completedByEmail: s.completedBy?.email ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Summary -------------------------------------------------------------

separation119Router.get('/separations/summary', VIEW, async (req, res) => {
  const days = z.coerce.number().int().min(1).max(730).default(90).parse(
    req.query.days,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  const [planned, inProgress, completedRecent, byReason, exitInterviewCompleted] =
    await Promise.all([
      prisma.separation.count({ where: { status: 'PLANNED' } }),
      prisma.separation.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.separation.count({
        where: { status: 'COMPLETE', completedAt: { gte: cutoff } },
      }),
      prisma.separation.groupBy({
        by: ['reason'],
        where: { lastDayWorked: { gte: cutoff } },
        _count: { _all: true },
      }),
      prisma.separation.count({
        where: {
          lastDayWorked: { gte: cutoff },
          exitInterviewCompletedAt: { not: null },
        },
      }),
    ]);

  const reasons: Record<string, number> = {};
  for (const r of byReason) reasons[r.reason] = r._count._all;

  // Average exit-interview rating across the window.
  const ratingAvg = await prisma.separation.aggregate({
    where: {
      lastDayWorked: { gte: cutoff },
      rating: { not: null },
    },
    _avg: { rating: true },
  });

  res.json({
    days,
    planned,
    inProgress,
    completedInWindow: completedRecent,
    exitInterviewCompletedInWindow: exitInterviewCompleted,
    averageRating: ratingAvg._avg.rating
      ? Math.round(ratingAvg._avg.rating * 10) / 10
      : null,
    byReason: reasons,
  });
});

// ----- Initiate ------------------------------------------------------------

const InitiateInputSchema = z.object({
  associateId: z.string().uuid(),
  reason: REASON,
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  lastDayWorked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  finalPaycheckDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

separation119Router.post('/separations', MANAGE, async (req, res) => {
  const input = InitiateInputSchema.parse(req.body);
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  try {
    const created = await prisma.separation.create({
      data: {
        associateId: input.associateId,
        reason: input.reason,
        noticeDate: input.noticeDate ? new Date(input.noticeDate) : null,
        lastDayWorked: new Date(input.lastDayWorked),
        finalPaycheckDate: input.finalPaycheckDate
          ? new Date(input.finalPaycheckDate)
          : null,
        initiatedById: req.user!.id,
      },
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
        'already_separating',
        'Associate already has an in-flight separation. Complete it first.',
      );
    }
    throw err;
  }
});

// ----- Advance status ------------------------------------------------------

separation119Router.post(
  '/separations/:id/advance',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.separation.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Separation not found.');
    }
    if (existing.status === 'COMPLETE') {
      throw new HttpError(409, 'already_complete', 'Already complete.');
    }
    const next: 'IN_PROGRESS' | 'COMPLETE' =
      existing.status === 'PLANNED' ? 'IN_PROGRESS' : 'COMPLETE';
    await prisma.separation.update({
      where: { id },
      data: {
        status: next,
        ...(next === 'COMPLETE'
          ? { completedAt: new Date(), completedById: req.user!.id }
          : {}),
      },
    });
    res.json({ ok: true, status: next });
  },
);

// ----- Exit interview ------------------------------------------------------

const ExitInterviewInputSchema = z.object({
  rating: z.number().int().min(1).max(10).optional().nullable(),
  reasonNotes: z.string().max(2000).optional().nullable(),
  feedbackPositive: z.string().max(2000).optional().nullable(),
  feedbackImprovement: z.string().max(2000).optional().nullable(),
  wouldRecommend: z.boolean().optional().nullable(),
  wouldReturn: z.boolean().optional().nullable(),
});

separation119Router.post(
  '/separations/:id/exit-interview',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = ExitInterviewInputSchema.parse(req.body);
    const existing = await prisma.separation.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Separation not found.');
    }
    await prisma.separation.update({
      where: { id },
      data: {
        rating: input.rating ?? null,
        reasonNotes: input.reasonNotes ?? null,
        feedbackPositive: input.feedbackPositive ?? null,
        feedbackImprovement: input.feedbackImprovement ?? null,
        wouldRecommend: input.wouldRecommend ?? null,
        wouldReturn: input.wouldReturn ?? null,
        exitInterviewCompletedAt: new Date(),
        exitInterviewByUserId: req.user!.id,
      },
    });
    res.json({ ok: true });
  },
);
