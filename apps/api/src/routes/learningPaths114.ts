import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 114 — Learning paths.
 *
 * Path is the ordered track. LearningPathStep ties Courses to the
 * track in `order` slots (unique per path). Enrollment status is
 * derived from the underlying CourseEnrollments — we update it
 * whenever the path is queried for an associate.
 *
 * Capability gating reuses the existing LMS caps. We don't introduce
 * new capabilities for paths.
 */

export const learningPaths114Router = Router();

const VIEW = requireCapability('view:compliance');
const MANAGE = requireCapability('manage:compliance');

// ----- Path management ------------------------------------------------

const PathInputSchema = z.object({
  clientId: z.string().uuid().optional().nullable(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  isRequired: z.boolean().default(false),
});

learningPaths114Router.post('/learning-paths', MANAGE, async (req, res) => {
  const input = PathInputSchema.parse(req.body);
  const created = await prisma.learningPath.create({
    data: {
      clientId: input.clientId ?? null,
      title: input.title,
      description: input.description ?? null,
      isRequired: input.isRequired,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

learningPaths114Router.get('/learning-paths', VIEW, async (req, res) => {
  const status = z
    .enum(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.learningPath.findMany({
    where: {
      deletedAt: null,
      ...(status ? { status } : {}),
    },
    include: {
      _count: { select: { steps: true, enrollments: true } },
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    paths: rows.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
      status: p.status,
      isRequired: p.isRequired,
      stepCount: p._count.steps,
      enrollmentCount: p._count.enrollments,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

learningPaths114Router.get('/learning-paths/:id', VIEW, async (req, res) => {
  const path = await prisma.learningPath.findUnique({
    where: { id: req.params.id },
    include: {
      steps: {
        include: { course: { select: { id: true, title: true, isRequired: true } } },
        orderBy: { order: 'asc' },
      },
    },
  });
  if (!path || path.deletedAt) {
    throw new HttpError(404, 'not_found', 'Learning path not found.');
  }
  res.json({
    id: path.id,
    title: path.title,
    description: path.description,
    status: path.status,
    isRequired: path.isRequired,
    steps: path.steps.map((s) => ({
      id: s.id,
      order: s.order,
      courseId: s.course.id,
      courseTitle: s.course.title,
      courseIsRequired: s.course.isRequired,
    })),
  });
});

learningPaths114Router.put('/learning-paths/:id', MANAGE, async (req, res) => {
  const input = PathInputSchema.partial().parse(req.body);
  const status = z
    .enum(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    .optional()
    .parse(req.body?.status);
  await prisma.learningPath.update({
    where: { id: req.params.id },
    data: {
      ...(input.title != null ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
      ...(status ? { status } : {}),
    },
  });
  res.json({ ok: true });
});

learningPaths114Router.delete('/learning-paths/:id', MANAGE, async (req, res) => {
  await prisma.learningPath.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Step management ------------------------------------------------

const StepInputSchema = z.object({
  pathId: z.string().uuid(),
  courseId: z.string().uuid(),
});

learningPaths114Router.post('/learning-path-steps', MANAGE, async (req, res) => {
  const input = StepInputSchema.parse(req.body);
  // Append at the end — find the current max order.
  const last = await prisma.learningPathStep.findFirst({
    where: { pathId: input.pathId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });
  const nextOrder = (last?.order ?? -1) + 1;
  try {
    const step = await prisma.learningPathStep.create({
      data: {
        pathId: input.pathId,
        courseId: input.courseId,
        order: nextOrder,
      },
    });
    res.status(201).json({ id: step.id, order: step.order });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'course_already_in_path',
        'That course is already part of this path.',
      );
    }
    throw err;
  }
});

learningPaths114Router.delete(
  '/learning-path-steps/:id',
  MANAGE,
  async (req, res) => {
    await prisma.learningPathStep.delete({ where: { id: req.params.id } });
    res.status(204).end();
  },
);

// Reorder: accepts the full ordered list of step IDs and rewrites
// `order` in one transaction. Two-phase write to avoid colliding with
// the (pathId, order) unique index.
const ReorderSchema = z.object({
  pathId: z.string().uuid(),
  stepIds: z.array(z.string().uuid()).min(1),
});

learningPaths114Router.post(
  '/learning-paths/:id/reorder',
  MANAGE,
  async (req, res) => {
    const input = ReorderSchema.parse({ ...req.body, pathId: req.params.id });
    await prisma.$transaction(async (tx) => {
      // Push everyone to negative orders first to dodge the unique index.
      await tx.learningPathStep.updateMany({
        where: { pathId: input.pathId },
        data: { order: -1 },
      });
      for (let i = 0; i < input.stepIds.length; i++) {
        await tx.learningPathStep.update({
          where: { id: input.stepIds[i] },
          data: { order: i },
        });
      }
    });
    res.json({ ok: true });
  },
);

// ----- Enrollment + status -------------------------------------------

const EnrollSchema = z.object({
  pathId: z.string().uuid(),
  associateId: z.string().uuid(),
});

learningPaths114Router.post(
  '/learning-path-enrollments',
  MANAGE,
  async (req, res) => {
    const input = EnrollSchema.parse(req.body);
    // Upsert so re-assigning the same path is a no-op (or revives WITHDRAWN).
    const enrollment = await prisma.learningPathEnrollment.upsert({
      where: {
        pathId_associateId: {
          pathId: input.pathId,
          associateId: input.associateId,
        },
      },
      create: {
        pathId: input.pathId,
        associateId: input.associateId,
      },
      update: {
        status: 'ASSIGNED',
        completedAt: null,
      },
    });
    // Auto-create CourseEnrollment for any step the associate doesn't
    // already have. Idempotent — skip-duplicates dodges the existing
    // associate+course unique.
    const steps = await prisma.learningPathStep.findMany({
      where: { pathId: input.pathId },
      select: { courseId: true },
    });
    if (steps.length > 0) {
      await prisma.courseEnrollment.createMany({
        data: steps.map((s) => ({
          courseId: s.courseId,
          associateId: input.associateId,
        })),
        skipDuplicates: true,
      });
    }
    res.status(201).json({ id: enrollment.id });
  },
);

learningPaths114Router.delete(
  '/learning-path-enrollments/:id',
  MANAGE,
  async (req, res) => {
    await prisma.learningPathEnrollment.update({
      where: { id: req.params.id },
      data: { status: 'WITHDRAWN' },
    });
    res.status(204).end();
  },
);

// List enrollments for a path. WITHDRAWN entries are excluded so the count
// in the parent table matches the count rendered here.
learningPaths114Router.get(
  '/learning-paths/:id/enrollments',
  VIEW,
  async (req, res) => {
    const enrollments = await prisma.learningPathEnrollment.findMany({
      where: { pathId: req.params.id, status: { not: 'WITHDRAWN' } },
      include: {
        associate: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });
    res.json({
      enrollments: enrollments.map((e) => ({
        id: e.id,
        associateId: e.associateId,
        associateName: `${e.associate.firstName} ${e.associate.lastName}`,
        associateEmail: e.associate.email,
        status: e.status,
        assignedAt: e.assignedAt.toISOString(),
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
    });
  },
);

learningPaths114Router.get(
  '/learning-paths/:id/status',
  VIEW,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.query.associateId);
    const path = await prisma.learningPath.findUnique({
      where: { id: req.params.id },
      include: {
        steps: {
          include: { course: { select: { id: true, title: true } } },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!path) throw new HttpError(404, 'not_found', 'Learning path not found.');
    const courseIds = path.steps.map((s) => s.courseId);
    const enrollments = await prisma.courseEnrollment.findMany({
      where: {
        associateId,
        courseId: { in: courseIds },
      },
      select: { courseId: true, status: true, completedAt: true },
    });
    const byCourse = new Map(enrollments.map((e) => [e.courseId, e]));
    const stepStatus = path.steps.map((s) => {
      const e = byCourse.get(s.courseId);
      return {
        courseId: s.courseId,
        courseTitle: s.course.title,
        order: s.order,
        status: e?.status ?? 'NOT_ASSIGNED',
        completedAt: e?.completedAt?.toISOString() ?? null,
      };
    });
    const nextStep = stepStatus.find(
      (s) => s.status !== 'COMPLETED' && s.status !== 'WAIVED',
    );
    const allComplete =
      stepStatus.length > 0 &&
      stepStatus.every(
        (s) => s.status === 'COMPLETED' || s.status === 'WAIVED',
      );
    // Sync the path enrollment to reflect derived state.
    await prisma.learningPathEnrollment.updateMany({
      where: { pathId: path.id, associateId, status: { not: 'WITHDRAWN' } },
      data: {
        status: allComplete ? 'COMPLETED' : nextStep ? 'IN_PROGRESS' : 'ASSIGNED',
        completedAt: allComplete ? new Date() : null,
      },
    });
    res.json({
      pathId: path.id,
      title: path.title,
      stepStatus,
      nextStep,
      allComplete,
    });
  },
);

// Self-service: the current user's path enrollments + status.
learningPaths114Router.get('/my/learning-paths', requireAuth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { associateId: true },
  });
  if (!me?.associateId) {
    res.json({ paths: [] });
    return;
  }
  const enrollments = await prisma.learningPathEnrollment.findMany({
    where: {
      associateId: me.associateId,
      status: { not: 'WITHDRAWN' },
      path: { deletedAt: null, status: 'PUBLISHED' },
    },
    include: {
      path: {
        select: {
          id: true,
          title: true,
          description: true,
          _count: { select: { steps: true } },
        },
      },
    },
  });
  res.json({
    paths: enrollments.map((e) => ({
      enrollmentId: e.id,
      pathId: e.path.id,
      title: e.path.title,
      description: e.path.description,
      stepCount: e.path._count.steps,
      status: e.status,
      assignedAt: e.assignedAt.toISOString(),
      completedAt: e.completedAt?.toISOString() ?? null,
    })),
  });
});
