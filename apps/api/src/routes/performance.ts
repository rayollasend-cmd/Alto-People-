import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  PerformanceReviewCreateInputSchema,
  PerformanceReviewListResponseSchema,
  PerformanceReviewUpdateInputSchema,
  type PerformanceReview,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { recordComplianceEvent } from '../lib/audit.js';

export const performanceRouter = Router();

const MANAGE = requireCapability('manage:performance');

type RawReview = Prisma.PerformanceReviewGetPayload<{
  include: {
    associate: { select: { firstName: true; lastName: true } };
    reviewer: { select: { email: true } };
  };
}>;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toReview(row: RawReview): PerformanceReview {
  return {
    id: row.id,
    associateId: row.associateId,
    associateName: `${row.associate.firstName} ${row.associate.lastName}`,
    reviewerUserId: row.reviewerUserId,
    reviewerEmail: row.reviewer?.email ?? null,
    periodStart: ymd(row.periodStart),
    periodEnd: ymd(row.periodEnd),
    overallRating: row.overallRating,
    summary: row.summary,
    strengths: row.strengths,
    improvements: row.improvements,
    goals: row.goals,
    status: row.status,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const REVIEW_INCLUDE = {
  associate: { select: { firstName: true, lastName: true } },
  reviewer: { select: { email: true } },
} as const;

/* ===== HR (manage:performance) ========================================== */

performanceRouter.get('/reviews', MANAGE, async (req, res, next) => {
  try {
    const status = req.query.status?.toString();
    const associateId = req.query.associateId?.toString();
    const where: Prisma.PerformanceReviewWhereInput = {
      ...(status ? { status: status as Prisma.PerformanceReviewWhereInput['status'] } : {}),
      ...(associateId ? { associateId } : {}),
    };
    const rows = await prisma.performanceReview.findMany({
      where,
      orderBy: [{ status: 'asc' }, { periodEnd: 'desc' }],
      take: 200,
      include: REVIEW_INCLUDE,
    });
    res.json(
      PerformanceReviewListResponseSchema.parse({ reviews: rows.map(toReview) })
    );
  } catch (err) {
    next(err);
  }
});

performanceRouter.post('/reviews', MANAGE, async (req, res, next) => {
  try {
    const parsed = PerformanceReviewCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    const associate = await prisma.associate.findFirst({
      where: { id: i.associateId, deletedAt: null },
    });
    if (!associate) throw new HttpError(404, 'associate_not_found', 'Associate not found');

    const created = await prisma.performanceReview.create({
      data: {
        associateId: i.associateId,
        reviewerUserId: req.user!.id,
        periodStart: new Date(`${i.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${i.periodEnd}T00:00:00.000Z`),
        overallRating: i.overallRating,
        summary: i.summary,
        strengths: i.strengths ?? null,
        improvements: i.improvements ?? null,
        goals: i.goals ?? null,
        status: 'DRAFT',
      },
      include: REVIEW_INCLUDE,
    });

    await recordComplianceEvent({
      actorUserId: req.user!.id,
      // Reusing the compliance-event recorder; the entityType union is broad
      // enough that adding a 4th value is overkill for v1.
      action: 'performance.review_created',
      entityType: 'I9Verification',  // placeholder — extend ComplianceEventContext later
      entityId: created.id,
      associateId: created.associateId,
      metadata: { rating: created.overallRating, period: i.periodStart + '-' + i.periodEnd },
      req,
    });

    res.status(201).json(toReview(created));
  } catch (err) {
    next(err);
  }
});

performanceRouter.patch('/reviews/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = PerformanceReviewUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.performanceReview.findFirst({
      where: { id: req.params.id },
    });
    if (!existing) throw new HttpError(404, 'review_not_found', 'Review not found');
    if (existing.status !== 'DRAFT') {
      throw new HttpError(409, 'not_draft', 'Only DRAFT reviews can be edited');
    }

    const i = parsed.data;
    const data: Prisma.PerformanceReviewUpdateInput = {};
    if (i.overallRating !== undefined) data.overallRating = i.overallRating;
    if (i.summary !== undefined) data.summary = i.summary;
    if (i.strengths !== undefined) data.strengths = i.strengths;
    if (i.improvements !== undefined) data.improvements = i.improvements;
    if (i.goals !== undefined) data.goals = i.goals;

    const updated = await prisma.performanceReview.update({
      where: { id: existing.id },
      data,
      include: REVIEW_INCLUDE,
    });
    res.json(toReview(updated));
  } catch (err) {
    next(err);
  }
});

performanceRouter.post('/reviews/:id/submit', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.performanceReview.findFirst({
      where: { id: req.params.id },
    });
    if (!existing) throw new HttpError(404, 'review_not_found', 'Review not found');
    if (existing.status !== 'DRAFT') {
      throw new HttpError(409, 'not_draft', 'Only DRAFT reviews can be submitted');
    }
    const updated = await prisma.performanceReview.update({
      where: { id: existing.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
      include: REVIEW_INCLUDE,
    });
    res.json(toReview(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Associate (/me) ================================================== */

performanceRouter.get('/me/reviews', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      res.json({ reviews: [] });
      return;
    }
    // Associates only see SUBMITTED + ACKNOWLEDGED — never DRAFT.
    const rows = await prisma.performanceReview.findMany({
      where: {
        associateId: user.associateId,
        status: { in: ['SUBMITTED', 'ACKNOWLEDGED'] },
      },
      orderBy: { periodEnd: 'desc' },
      take: 50,
      include: REVIEW_INCLUDE,
    });
    res.json(
      PerformanceReviewListResponseSchema.parse({ reviews: rows.map(toReview) })
    );
  } catch (err) {
    next(err);
  }
});

performanceRouter.post('/me/reviews/:id/acknowledge', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Forbidden');
    }
    const existing = await prisma.performanceReview.findFirst({
      where: { id: req.params.id, associateId: user.associateId },
    });
    if (!existing) {
      // 404 not 403 — don't leak whether the id exists for another associate.
      throw new HttpError(404, 'review_not_found', 'Review not found');
    }
    if (existing.status === 'DRAFT') {
      // Should be unreachable since /me only lists SUBMITTED/ACKNOWLEDGED,
      // but defense-in-depth: never leak DRAFT content.
      throw new HttpError(404, 'review_not_found', 'Review not found');
    }
    if (existing.status === 'ACKNOWLEDGED') {
      const refreshed = await prisma.performanceReview.findUniqueOrThrow({
        where: { id: existing.id },
        include: REVIEW_INCLUDE,
      });
      res.json(toReview(refreshed));
      return;
    }
    const updated = await prisma.performanceReview.update({
      where: { id: existing.id },
      data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() },
      include: REVIEW_INCLUDE,
    });
    res.json(toReview(updated));
  } catch (err) {
    next(err);
  }
});
