import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  PerformanceReviewCreateInputSchema,
  PerformanceReviewListResponseSchema,
  PerformanceReviewUpdateInputSchema,
  type PerformanceReview,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeAssociatesIncludingFormer, scopeWhere } from '../lib/scope.js';
import { enqueueAudit, recordComplianceEvent } from '../lib/audit.js';
import { notifyAssociate, notifyUser } from '../lib/notify.js';

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
    sourcePipId: row.sourcePipId,
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

    // If a sourcePipId is supplied, verify it belongs to this associate
    // before persisting — same defence-in-depth posture as the
    // PIP/sourceGoalId path in performance84.ts.
    if (i.sourcePipId) {
      const pip = await prisma.pip.findFirst({
        where: { id: i.sourcePipId, associateId: i.associateId },
        select: { id: true },
      });
      if (!pip) {
        throw new HttpError(
          400,
          'pip_mismatch',
          'sourcePipId does not belong to this associate.',
        );
      }
    }

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
        sourcePipId: i.sourcePipId ?? null,
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
    // Fire-and-forget: the review is shared regardless of inbox delivery.
    void notifyAssociate(updated.associateId, {
      subject: 'Your performance review is ready',
      body: `Your review for ${ymd(updated.periodStart)} – ${ymd(updated.periodEnd)} has been shared with you.`,
      category: 'performance',
      linkUrl: '/performance',
      emailFallback: true,
    });
    res.json(toReview(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Calibration (manage:performance) ================================= */

/**
 * Before reviews go out, HR lays every reviewer's ratings side by side: the
 * spread of 1–5 overall and per reviewer, and who rates well above or below
 * everyone else. A draft's rating can then be moved — by someone other than
 * the reviewer who wrote it — with a reason, and the reviewer's own rating
 * stays on the record beside it.
 */
const CalibrationQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** A reviewer whose average sits this far from everyone's is called out. */
const LEAN_THRESHOLD = 0.75;

/**
 * GET /performance/review-context?associateId&from&to — what a reviewer
 * writes from, in one read: the person's goals and their progress, kudos in
 * the period, the 1:1 notes, attendance (late, no-shows, call-outs, early
 * outs — excused ones left out) and their last review. The composer shows it
 * beside the form so a rating rests on the record, not on memory.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
performanceRouter.get('/review-context', MANAGE, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.query.associateId);
    const fromQ = req.query.from?.toString();
    const toQ = req.query.to?.toString();
    if ((fromQ && !DAY_RE.test(fromQ)) || (toQ && !DAY_RE.test(toQ))) {
      throw new HttpError(400, 'invalid_period', '`from`/`to` must be YYYY-MM-DD');
    }
    const to = toQ ? new Date(`${toQ}T23:59:59.999Z`) : new Date();
    const from = fromQ ? new Date(`${fromQ}T00:00:00Z`) : new Date(to.getTime() - 90 * 86_400_000);
    // Only someone in the reviewer's reach: everything below hangs off this read.
    const person = await prisma.associate.findFirst({
      where: scopeWhere<Prisma.AssociateWhereInput>({ id: associateId, deletedAt: null }, scopeAssociatesIncludingFormer(req.user!)),
      select: { id: true, firstName: true, lastName: true },
    });
    if (!person) throw new HttpError(404, 'not_found', 'Associate not found');
    const [goals, kudos, meetings, events, lastReview] = await Promise.all([
      prisma.goal.findMany({
        where: { associateId, deletedAt: null, status: { not: 'CANCELLED' } },
        orderBy: { periodEnd: 'desc' },
        take: 20,
        select: { id: true, title: true, status: true, progressPct: true, periodStart: true, periodEnd: true },
      }),
      prisma.kudo.findMany({
        where: { toAssociateId: associateId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, message: true, createdAt: true, fromUser: { select: { email: true } } },
      }),
      prisma.oneOnOne.findMany({
        where: { associateId, status: 'COMPLETED', scheduledFor: { gte: from, lte: to } },
        orderBy: { scheduledFor: 'desc' },
        take: 12,
        select: { id: true, scheduledFor: true, managerNotes: true, agenda: true, actionItems: { select: { text: true, doneAt: true } } },
      }),
      prisma.attendanceEvent.findMany({
        where: { associateId, excusedAt: null, occurredOn: { gte: from, lte: to } },
        select: { kind: true },
      }),
      prisma.performanceReview.findFirst({
        where: { associateId, status: { not: 'DRAFT' } },
        orderBy: { periodEnd: 'desc' },
        select: { id: true, periodStart: true, periodEnd: true, overallRating: true, summary: true },
      }),
    ]);
    const count = (k: string) => events.filter((e) => e.kind === k).length;
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    res.json({
      associate: { id: person.id, name: `${person.firstName} ${person.lastName}` },
      from: ymd(from),
      to: ymd(to),
      goals: goals.map((g) => ({ id: g.id, title: g.title, status: g.status, progressPct: g.progressPct, periodEnd: ymd(g.periodEnd) })),
      kudos: kudos.map((k) => ({ id: k.id, message: k.message, from: k.fromUser.email, at: k.createdAt.toISOString() })),
      oneOnOnes: meetings.map((m) => ({
        id: m.id,
        at: m.scheduledFor.toISOString(),
        notes: m.managerNotes,
        agenda: m.agenda,
        itemsDone: m.actionItems.filter((i) => i.doneAt).length,
        itemsOpen: m.actionItems.filter((i) => !i.doneAt).length,
      })),
      attendance: { late: count('LATE'), noCallNoShow: count('NO_CALL_NO_SHOW'), callOut: count('CALL_OUT'), earlyOut: count('EARLY_OUT') },
      lastReview: lastReview
        ? { id: lastReview.id, periodStart: ymd(lastReview.periodStart), periodEnd: ymd(lastReview.periodEnd), overallRating: lastReview.overallRating, summary: lastReview.summary }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

performanceRouter.get('/calibration', MANAGE, async (req, res, next) => {
  try {
    const q = CalibrationQuery.parse(req.query);
    const where: Prisma.PerformanceReviewWhereInput = {
      ...(q.from ? { periodEnd: { gte: new Date(`${q.from}T00:00:00Z`) } } : {}),
      ...(q.to ? { periodStart: { lte: new Date(`${q.to}T00:00:00Z`) } } : {}),
    };
    const rows = await prisma.performanceReview.findMany({
      where,
      orderBy: [{ periodEnd: 'desc' }],
      take: 1000,
      include: {
        ...REVIEW_INCLUDE,
        reviewer: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
        calibratedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
      },
    });
    const nameOf = (u: { email: string; associate: { firstName: string; lastName: string } | null } | null) =>
      u ? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email) : null;
    const dist = (ratings: number[]) => [1, 2, 3, 4, 5].map((r) => ratings.filter((x) => x === r).length);
    const mean = (ratings: number[]) =>
      ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null;

    const all = rows.map((r) => r.overallRating);
    const orgMean = mean(all);
    const byReviewer = new Map<string, { reviewerUserId: string | null; name: string; ratings: number[] }>();
    for (const r of rows) {
      const key = r.reviewerUserId ?? 'none';
      const entry = byReviewer.get(key) ?? { reviewerUserId: r.reviewerUserId, name: nameOf(r.reviewer) ?? 'No reviewer', ratings: [] };
      entry.ratings.push(r.overallRating);
      byReviewer.set(key, entry);
    }
    const reviewers = [...byReviewer.values()]
      .map((e) => {
        const m = mean(e.ratings);
        const delta = m !== null && orgMean !== null ? Math.round((m - orgMean) * 100) / 100 : 0;
        return {
          reviewerUserId: e.reviewerUserId,
          name: e.name,
          count: e.ratings.length,
          mean: m,
          distribution: dist(e.ratings),
          // Only a reviewer with enough reviews to read a pattern into is called out.
          lean: e.ratings.length >= 3 && Math.abs(delta) >= LEAN_THRESHOLD ? (delta > 0 ? ('generous' as const) : ('strict' as const)) : null,
          delta,
        };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    res.json({
      total: rows.length,
      mean: orgMean,
      distribution: dist(all),
      reviewers,
      reviews: rows.map((r) => ({
        id: r.id,
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`,
        reviewerUserId: r.reviewerUserId,
        reviewerName: nameOf(r.reviewer),
        periodStart: ymd(r.periodStart),
        periodEnd: ymd(r.periodEnd),
        status: r.status,
        overallRating: r.overallRating,
        originalRating: r.originalRating,
        calibrationNote: r.calibrationNote,
        calibratedByName: nameOf(r.calibratedBy),
        calibratedAt: r.calibratedAt ? r.calibratedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const CalibrateBody = z.object({
  rating: z.number().int().min(1).max(5),
  note: z.string().trim().min(3).max(1000),
});

performanceRouter.post('/reviews/:id/calibrate', MANAGE, async (req, res, next) => {
  try {
    const body = CalibrateBody.safeParse(req.body);
    if (!body.success) {
      throw new HttpError(400, 'invalid_body', 'A rating from 1 to 5 and a reason are required.', body.error.flatten());
    }
    const existing = await prisma.performanceReview.findFirst({ where: { id: req.params.id } });
    if (!existing) throw new HttpError(404, 'review_not_found', 'Review not found');
    if (existing.status !== 'DRAFT') {
      throw new HttpError(409, 'not_draft', 'Only a review that has not been shared can be calibrated.');
    }
    if (existing.reviewerUserId && existing.reviewerUserId === req.user!.id) {
      throw new HttpError(403, 'own_review', 'Someone other than the reviewer calibrates a review.');
    }
    const updated = await prisma.performanceReview.update({
      where: { id: existing.id },
      data: {
        overallRating: body.data.rating,
        // The reviewer's own rating is kept the first time it moves.
        originalRating: existing.originalRating ?? existing.overallRating,
        calibrationNote: body.data.note,
        calibratedById: req.user!.id,
        calibratedAt: new Date(),
      },
      include: REVIEW_INCLUDE,
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'performance.review.calibrated',
        entityType: 'PerformanceReview',
        entityId: existing.id,
        metadata: {
          associateId: existing.associateId,
          from: existing.overallRating,
          to: body.data.rating,
          reviewerRating: existing.originalRating ?? existing.overallRating,
          note: body.data.note,
        },
      },
      'performance.calibrate',
    );
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
    // Close the loop for the reviewer (fire-and-forget). reviewerUserId is
    // nullable in the model, so skip when no reviewer is recorded.
    if (updated.reviewerUserId) {
      void notifyUser(updated.reviewerUserId, {
        subject: 'Review acknowledged',
        body: `${updated.associate.firstName} ${updated.associate.lastName} acknowledged their performance review for ${ymd(updated.periodStart)} – ${ymd(updated.periodEnd)}.`,
        category: 'performance',
        linkUrl: '/performance',
      });
    }
    res.json(toReview(updated));
  } catch (err) {
    next(err);
  }
});
