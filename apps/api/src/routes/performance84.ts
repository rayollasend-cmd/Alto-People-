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

const VIEW = requireCapability('view:performance');
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
  const created = await prisma.pip.create({
    data: {
      associateId: input.associateId,
      managerUserId: req.user!.id,
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      reason: input.reason,
      expectations: input.expectations,
      supportPlan: input.supportPlan ?? null,
    },
  });
  res.status(201).json({ id: created.id });
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
