import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 84 — Performance: Goals/OKRs, 1:1s, Kudos, PIPs, 360 reviews.
 *
 * These endpoints sit alongside the existing /performance routes (which
 * handle annual PerformanceReview from Phase 47). Mounted at /performance
 * with distinct path prefixes to avoid collisions.
 */

export const performance84Router = Router();

// Org-wide goals/PIPs/360s reads are gated on view:hr-admin so associates
// with view:performance can't enumerate every goal across the company.
// (Self-service "my goals" should hit /me/* routes, not these.)
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:performance');

// ----- Goals --------------------------------------------------------------

const GoalCreateSchema = z.object({
  associateId: z.string().uuid(),
  kind: z.enum(['GOAL', 'OBJECTIVE']).optional(),
  title: z.string().min(1).max(250),
  description: z.string().max(4000).optional().nullable(),
  parentGoalId: z.string().uuid().nullable().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const GoalUpdateSchema = z.object({
  title: z.string().min(1).max(250).optional(),
  description: z.string().max(4000).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'AT_RISK', 'COMPLETED', 'CANCELLED']).optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
});

performance84Router.get('/goals', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const rows = await prisma.goal.findMany({
    take: 500,
    where: { deletedAt: null, ...(associateId ? { associateId } : {}) },
    include: { keyResults: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    goals: rows.map((g) => ({
      id: g.id,
      associateId: g.associateId,
      kind: g.kind,
      title: g.title,
      description: g.description,
      parentGoalId: g.parentGoalId,
      periodStart: g.periodStart.toISOString().slice(0, 10),
      periodEnd: g.periodEnd.toISOString().slice(0, 10),
      status: g.status,
      progressPct: g.progressPct,
      keyResults: g.keyResults.map((k) => ({
        id: k.id,
        title: k.title,
        targetValue: k.targetValue?.toFixed(2) ?? null,
        currentValue: k.currentValue.toFixed(2),
        unit: k.unit,
        progressPct: k.progressPct,
      })),
    })),
  });
});

performance84Router.post('/goals', VIEW, async (req, res) => {
  const input = GoalCreateSchema.parse(req.body);
  if (input.periodEnd < input.periodStart) {
    throw new HttpError(400, 'invalid_period', 'periodEnd must be after periodStart');
  }
  const created = await prisma.goal.create({
    data: {
      associateId: input.associateId,
      kind: input.kind ?? 'GOAL',
      title: input.title,
      description: input.description ?? null,
      parentGoalId: input.parentGoalId ?? null,
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

performance84Router.put('/goals/:id', VIEW, async (req, res) => {
  const id = req.params.id;
  const input = GoalUpdateSchema.parse(req.body);
  const existing = await prisma.goal.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    throw new HttpError(404, 'not_found', 'Goal not found.');
  }
  await prisma.goal.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      status: input.status ?? undefined,
      progressPct: input.progressPct ?? undefined,
    },
  });
  res.json({ ok: true });
});

performance84Router.delete('/goals/:id', VIEW, async (req, res) => {
  const id = req.params.id;
  await prisma.goal.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

const KeyResultCreateSchema = z.object({
  title: z.string().min(1).max(250),
  targetValue: z.number().optional().nullable(),
  unit: z.string().max(40).optional().nullable(),
});

const KeyResultUpdateSchema = z.object({
  title: z.string().min(1).max(250).optional(),
  currentValue: z.number().optional(),
  progressPct: z.number().int().min(0).max(100).optional(),
});

performance84Router.post('/goals/:id/key-results', VIEW, async (req, res) => {
  const goalId = req.params.id;
  const input = KeyResultCreateSchema.parse(req.body);
  const created = await prisma.keyResult.create({
    data: {
      goalId,
      title: input.title,
      targetValue:
        input.targetValue !== undefined && input.targetValue !== null
          ? new Prisma.Decimal(input.targetValue)
          : null,
      unit: input.unit ?? null,
    },
  });
  res.status(201).json({ id: created.id });
});

performance84Router.put('/key-results/:id', VIEW, async (req, res) => {
  const id = req.params.id;
  const input = KeyResultUpdateSchema.parse(req.body);
  await prisma.keyResult.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      currentValue:
        input.currentValue !== undefined ? new Prisma.Decimal(input.currentValue) : undefined,
      progressPct: input.progressPct ?? undefined,
    },
  });
  res.json({ ok: true });
});

// ----- 1:1 ----------------------------------------------------------------

const OneOnOneCreateSchema = z.object({
  associateId: z.string().uuid(),
  managerUserId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  agenda: z.string().max(4000).optional().nullable(),
});

const OneOnOneUpdateSchema = z.object({
  agenda: z.string().max(4000).nullable().optional(),
  managerNotes: z.string().max(4000).nullable().optional(),
  associateNotes: z.string().max(4000).nullable().optional(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']).optional(),
});

performance84Router.get('/one-on-ones', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const rows = await prisma.oneOnOne.findMany({
    where: associateId ? { associateId } : {},
    orderBy: { scheduledFor: 'desc' },
    take: 100,
  });
  res.json({
    meetings: rows.map((m) => ({
      id: m.id,
      associateId: m.associateId,
      managerUserId: m.managerUserId,
      scheduledFor: m.scheduledFor.toISOString(),
      completedAt: m.completedAt?.toISOString() ?? null,
      agenda: m.agenda,
      managerNotes: m.managerNotes,
      associateNotes: m.associateNotes,
      status: m.status,
    })),
  });
});

performance84Router.post('/one-on-ones', VIEW, async (req, res) => {
  const input = OneOnOneCreateSchema.parse(req.body);
  const created = await prisma.oneOnOne.create({
    data: {
      associateId: input.associateId,
      managerUserId: input.managerUserId,
      scheduledFor: new Date(input.scheduledFor),
      agenda: input.agenda ?? null,
    },
  });
  res.status(201).json({ id: created.id });
});

performance84Router.put('/one-on-ones/:id', VIEW, async (req, res) => {
  const id = req.params.id;
  const input = OneOnOneUpdateSchema.parse(req.body);
  const completed = input.status === 'COMPLETED';
  await prisma.oneOnOne.update({
    where: { id },
    data: {
      agenda: input.agenda === undefined ? undefined : input.agenda,
      managerNotes: input.managerNotes === undefined ? undefined : input.managerNotes,
      associateNotes: input.associateNotes === undefined ? undefined : input.associateNotes,
      status: input.status ?? undefined,
      completedAt: completed ? new Date() : undefined,
    },
  });
  res.json({ ok: true });
});

// ----- Kudos --------------------------------------------------------------

const KudoCreateSchema = z.object({
  toAssociateId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  tags: z.array(z.string().max(40)).max(10).optional(),
  isPublic: z.boolean().optional(),
});

performance84Router.get('/kudos', VIEW, async (req, res) => {
  const toAssociateId = z.string().uuid().optional().parse(req.query.toAssociateId);
  const onlyPublic = req.query.onlyPublic === '1';
  const rows = await prisma.kudo.findMany({
    where: {
      ...(toAssociateId ? { toAssociateId } : {}),
      ...(onlyPublic ? { isPublic: true } : {}),
    },
    include: {
      fromUser: { select: { email: true } },
      toAssociate: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({
    kudos: rows.map((k) => ({
      id: k.id,
      fromUserEmail: k.fromUser.email,
      toAssociateName: `${k.toAssociate.firstName} ${k.toAssociate.lastName}`,
      message: k.message,
      tags: k.tags,
      isPublic: k.isPublic,
      createdAt: k.createdAt.toISOString(),
    })),
  });
});

performance84Router.post('/kudos', async (req, res) => {
  // Anyone authenticated can give a kudo.
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
  const input = KudoCreateSchema.parse(req.body);
  const created = await prisma.kudo.create({
    data: {
      fromUserId: req.user.id,
      toAssociateId: input.toAssociateId,
      message: input.message,
      tags: input.tags ?? [],
      isPublic: input.isPublic ?? true,
    },
  });
  res.status(201).json({ id: created.id });
});

// ----- PIP ----------------------------------------------------------------

const PipCreateSchema = z.object({
  associateId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().min(1).max(4000),
  expectations: z.string().min(1).max(8000),
  supportPlan: z.string().max(8000).optional().nullable(),
  // Optional pointer back to the goal that prompted this PIP. Set when
  // the PIP is created via the "Start PIP from goal" flow so the
  // performance timeline can render the chain.
  sourceGoalId: z.string().uuid().optional(),
});

const PipUpdateSchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'PASSED', 'FAILED', 'CANCELLED']).optional(),
  outcomeNote: z.string().max(4000).nullable().optional(),
  expectations: z.string().max(8000).optional(),
  supportPlan: z.string().max(8000).nullable().optional(),
});

performance84Router.get('/pips', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const rows = await prisma.pip.findMany({
    where: associateId ? { associateId } : {},
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({
    pips: rows.map((p) => ({
      id: p.id,
      associateId: p.associateId,
      managerUserId: p.managerUserId,
      sourceGoalId: p.sourceGoalId,
      startDate: p.startDate.toISOString().slice(0, 10),
      endDate: p.endDate.toISOString().slice(0, 10),
      reason: p.reason,
      expectations: p.expectations,
      supportPlan: p.supportPlan,
      status: p.status,
      outcomeNote: p.outcomeNote,
      decidedAt: p.decidedAt?.toISOString() ?? null,
    })),
  });
});

performance84Router.post('/pips', MANAGE, async (req, res) => {
  const input = PipCreateSchema.parse(req.body);
  if (input.endDate < input.startDate) {
    throw new HttpError(400, 'invalid_period', 'endDate must be after startDate');
  }
  // If a sourceGoalId was supplied, confirm it belongs to this associate
  // before persisting. Defence-in-depth: even though only managers can call
  // this endpoint, a typo or copy-paste could otherwise stitch a PIP to an
  // unrelated person's goal and pollute their timeline.
  if (input.sourceGoalId) {
    const goal = await prisma.goal.findFirst({
      where: { id: input.sourceGoalId, associateId: input.associateId, deletedAt: null },
      select: { id: true },
    });
    if (!goal) {
      throw new HttpError(
        400,
        'goal_mismatch',
        'sourceGoalId does not belong to this associate.',
      );
    }
  }
  const created = await prisma.pip.create({
    data: {
      associateId: input.associateId,
      managerUserId: req.user!.id,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      reason: input.reason,
      expectations: input.expectations,
      supportPlan: input.supportPlan ?? null,
      sourceGoalId: input.sourceGoalId ?? null,
    },
  });
  res.status(201).json({ id: created.id });
});

// "Start PIP from goal" prefill helper. Returns a suggested PIP payload
// based on the goal — the caller then displays a form pre-filled with
// this data and POSTs to /pips with sourceGoalId set. The endpoint
// deliberately does NOT create the PIP; we want the manager to review and
// commit explicitly.
performance84Router.get('/pips/prefill-from-goal/:goalId', MANAGE, async (req, res) => {
  const goalId = z.string().uuid().parse(req.params.goalId);
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, deletedAt: null },
  });
  if (!goal) throw new HttpError(404, 'not_found', 'Goal not found.');
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 60); // standard 60-day PIP window
  res.json({
    associateId: goal.associateId,
    sourceGoalId: goal.id,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    reason: `At-risk goal: "${goal.title}". ${goal.description ?? ''}`.trim().slice(0, 4000),
    expectations: `Restore "${goal.title}" to on-track status. Current progress: ${goal.progressPct}%. Target: 100% by ${goal.periodEnd.toISOString().slice(0, 10)}.`.slice(0, 8000),
    supportPlan: null,
  });
});

performance84Router.put('/pips/:id', MANAGE, async (req, res) => {
  const id = req.params.id;
  const input = PipUpdateSchema.parse(req.body);
  const decided =
    input.status === 'PASSED' || input.status === 'FAILED' || input.status === 'CANCELLED';
  await prisma.pip.update({
    where: { id },
    data: {
      status: input.status ?? undefined,
      outcomeNote: input.outcomeNote === undefined ? undefined : input.outcomeNote,
      expectations: input.expectations ?? undefined,
      supportPlan: input.supportPlan === undefined ? undefined : input.supportPlan,
      decidedAt: decided ? new Date() : undefined,
    },
  });
  res.json({ ok: true });
});

// ----- 360 reviews --------------------------------------------------------

const Review360CreateSchema = z.object({
  subjectAssociateId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const FeedbackCreateSchema = z.object({
  isAnonymous: z.boolean().optional(),
  strengths: z.string().max(4000).optional().nullable(),
  improvements: z.string().max(4000).optional().nullable(),
  rating: z.number().int().min(1).max(5).optional().nullable(),
});

performance84Router.get('/reviews360', VIEW, async (req, res) => {
  const subjectAssociateId = z.string().uuid().optional().parse(req.query.subjectAssociateId);
  const rows = await prisma.review360.findMany({
    where: subjectAssociateId ? { subjectAssociateId } : {},
    include: { _count: { select: { feedback: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({
    reviews: rows.map((r) => ({
      id: r.id,
      subjectAssociateId: r.subjectAssociateId,
      requestedById: r.requestedById,
      periodStart: r.periodStart.toISOString().slice(0, 10),
      periodEnd: r.periodEnd.toISOString().slice(0, 10),
      status: r.status,
      feedbackCount: r._count.feedback,
    })),
  });
});

performance84Router.post('/reviews360', MANAGE, async (req, res) => {
  const input = Review360CreateSchema.parse(req.body);
  if (input.periodEnd < input.periodStart) {
    throw new HttpError(400, 'invalid_period', 'periodEnd must be after periodStart');
  }
  const created = await prisma.review360.create({
    data: {
      subjectAssociateId: input.subjectAssociateId,
      requestedById: req.user!.id,
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
    },
  });
  res.status(201).json({ id: created.id });
});

/**
 * Submit a single feedback row. Open to any authenticated user — gating
 * (was the user actually invited?) is enforced at the workflow layer in a
 * follow-up. Fully-anonymous feedback drops fromUserId entirely so even DB
 * forensics can't trace it back.
 */
performance84Router.post('/reviews360/:id/feedback', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
  const reviewId = req.params.id;
  const input = FeedbackCreateSchema.parse(req.body);
  const review = await prisma.review360.findUnique({ where: { id: reviewId } });
  if (!review) throw new HttpError(404, 'not_found', 'Review not found.');
  if (review.status !== 'COLLECTING') {
    throw new HttpError(400, 'wrong_state', 'Review is closed.');
  }
  await prisma.review360Feedback.create({
    data: {
      reviewId,
      fromUserId: input.isAnonymous ? null : req.user.id,
      isAnonymous: input.isAnonymous ?? false,
      strengths: input.strengths ?? null,
      improvements: input.improvements ?? null,
      rating: input.rating ?? null,
    },
  });
  res.status(201).json({ ok: true });
});

performance84Router.get('/reviews360/:id/aggregate', VIEW, async (req, res) => {
  const reviewId = req.params.id;
  const review = await prisma.review360.findUnique({ where: { id: reviewId } });
  if (!review) throw new HttpError(404, 'not_found', 'Review not found.');
  const feedback = await prisma.review360Feedback.findMany({
    take: 500,
    where: { reviewId },
    orderBy: { submittedAt: 'desc' },
  });
  const ratings = feedback.map((f) => f.rating).filter((r): r is number => r !== null);
  const avg =
    ratings.length === 0 ? null : ratings.reduce((a, b) => a + b, 0) / ratings.length;
  res.json({
    count: feedback.length,
    averageRating: avg,
    entries: feedback.map((f) => ({
      id: f.id,
      isAnonymous: f.isAnonymous,
      strengths: f.strengths,
      improvements: f.improvements,
      rating: f.rating,
      submittedAt: f.submittedAt.toISOString(),
    })),
  });
});

performance84Router.put('/reviews360/:id/close', MANAGE, async (req, res) => {
  const id = req.params.id;
  await prisma.review360.update({
    where: { id },
    data: { status: 'COMPLETED' },
  });
  res.json({ ok: true });
});

// ----- Performance timeline ----------------------------------------------
//
// Single endpoint that returns one associate's goals, PIPs, and annual
// reviews together in chronological order. The Goal → PIP → Review chain
// is exposed via the `parentId` field so the UI can render the
// relationship as a tree or breadcrumb.
//
// Mounted under VIEW (view:hr-admin) for HR-side rendering; the
// manager-scoped /team/:associateId/timeline variant lives elsewhere
// when we wire it.

interface TimelineEntry {
  kind: 'GOAL' | 'PIP' | 'REVIEW';
  id: string;
  title: string;
  status: string;
  date: string;
  parentId: string | null;
  parentKind: 'GOAL' | 'PIP' | null;
  link: string;
  meta?: Record<string, unknown>;
}

performance84Router.get('/timeline', VIEW, async (req, res) => {
  const associateId = z.string().uuid().parse(req.query.associateId);
  const [goals, pips, reviews] = await Promise.all([
    prisma.goal.findMany({
      where: { associateId, deletedAt: null },
      orderBy: { periodStart: 'asc' },
    }),
    prisma.pip.findMany({
      where: { associateId },
      orderBy: { startDate: 'asc' },
    }),
    prisma.performanceReview.findMany({
      where: { associateId },
      orderBy: { periodStart: 'asc' },
    }),
  ]);
  const entries: TimelineEntry[] = [];
  for (const g of goals) {
    entries.push({
      kind: 'GOAL',
      id: g.id,
      title: g.title,
      status: g.status,
      date: g.periodStart.toISOString().slice(0, 10),
      parentId: g.parentGoalId,
      parentKind: g.parentGoalId ? 'GOAL' : null,
      link: `/performance?goalId=${g.id}`,
      meta: { progressPct: g.progressPct, periodEnd: g.periodEnd.toISOString().slice(0, 10) },
    });
  }
  for (const p of pips) {
    entries.push({
      kind: 'PIP',
      id: p.id,
      title: p.reason.slice(0, 80),
      status: p.status,
      date: p.startDate.toISOString().slice(0, 10),
      parentId: p.sourceGoalId,
      parentKind: p.sourceGoalId ? 'GOAL' : null,
      link: `/performance?pipId=${p.id}`,
      meta: { endDate: p.endDate.toISOString().slice(0, 10), outcomeNote: p.outcomeNote },
    });
  }
  for (const r of reviews) {
    entries.push({
      kind: 'REVIEW',
      id: r.id,
      title: r.summary.slice(0, 80),
      status: r.status,
      date: r.periodStart.toISOString().slice(0, 10),
      parentId: r.sourcePipId,
      parentKind: r.sourcePipId ? 'PIP' : null,
      link: `/performance?reviewId=${r.id}`,
      meta: { rating: r.overallRating, periodEnd: r.periodEnd.toISOString().slice(0, 10) },
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  res.json({ entries });
});

// "Start review from PIP" prefill helper. Same shape as the goal→PIP
// counterpart: returns a suggested PerformanceReview payload built from a
// PIP's outcome. Caller posts the result (with sourcePipId) to
// /performance/reviews.
performance84Router.get('/reviews/prefill-from-pip/:pipId', MANAGE, async (req, res) => {
  const pipId = z.string().uuid().parse(req.params.pipId);
  const pip = await prisma.pip.findUnique({ where: { id: pipId } });
  if (!pip) throw new HttpError(404, 'not_found', 'PIP not found.');
  if (pip.status !== 'PASSED' && pip.status !== 'FAILED') {
    throw new HttpError(
      400,
      'pip_open',
      'Can only build a review from a closed (PASSED/FAILED) PIP.',
    );
  }
  res.json({
    associateId: pip.associateId,
    sourcePipId: pip.id,
    periodStart: pip.startDate.toISOString().slice(0, 10),
    periodEnd: pip.endDate.toISOString().slice(0, 10),
    overallRating: pip.status === 'PASSED' ? 3 : 2,
    summary: `Performance review following ${pip.status === 'PASSED' ? 'successful' : 'unsuccessful'} PIP completion.`,
    strengths: null,
    improvements: pip.expectations,
    goals: pip.outcomeNote ?? null,
  });
});
