import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 94 — Learning Management System (LMS).
 *
 * Courses are authored by HR, broken into modules (video / reading /
 * quiz / external link / policy ack), and assigned to associates.
 * Required courses with validityDays auto-expire — the worker re-flags
 * them as EXPIRED, kicking off a re-enrollment cycle.
 */

export const lms94Router = Router();

const VIEW = requireCapability('view:compliance');
const MANAGE = requireCapability('manage:compliance');

// ----- Courses ----------------------------------------------------------

const CourseInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  isRequired: z.boolean().optional(),
  validityDays: z.number().int().positive().nullable().optional(),
});

const ModuleInputSchema = z.object({
  kind: z.enum(['VIDEO', 'READING', 'QUIZ', 'EXTERNAL_LINK', 'POLICY_ACK']),
  title: z.string().min(1).max(200),
  content: z.record(z.string(), z.unknown()).default({}),
  order: z.number().int().nonnegative().default(0),
});

lms94Router.get('/courses', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const status = z
    .enum(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.course.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      _count: { select: { modules: true, enrollments: true } },
    },
    orderBy: { title: 'asc' },
  });
  res.json({
    courses: rows.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      title: c.title,
      description: c.description,
      isRequired: c.isRequired,
      validityDays: c.validityDays,
      status: c.status,
      moduleCount: c._count.modules,
      enrollmentCount: c._count.enrollments,
      createdAt: c.createdAt.toISOString(),
    })),
  });
});

lms94Router.post('/courses', MANAGE, async (req, res) => {
  const input = CourseInputSchema.parse(req.body);
  const created = await prisma.course.create({
    data: {
      clientId: input.clientId ?? null,
      title: input.title,
      description: input.description ?? null,
      isRequired: input.isRequired ?? false,
      validityDays: input.validityDays ?? null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

lms94Router.post('/courses/:id/publish', MANAGE, async (req, res) => {
  await prisma.course.update({
    where: { id: req.params.id },
    data: { status: 'PUBLISHED' },
  });
  res.json({ ok: true });
});

lms94Router.post('/courses/:id/archive', MANAGE, async (req, res) => {
  await prisma.course.update({
    where: { id: req.params.id },
    data: { status: 'ARCHIVED' },
  });
  res.json({ ok: true });
});

lms94Router.delete('/courses/:id', MANAGE, async (req, res) => {
  await prisma.course.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Modules ----------------------------------------------------------

lms94Router.get('/courses/:id/modules', VIEW, async (req, res) => {
  const rows = await prisma.courseModule.findMany({
    take: 500,
    where: { courseId: req.params.id },
    orderBy: { order: 'asc' },
  });
  res.json({
    modules: rows.map((m) => ({
      id: m.id,
      kind: m.kind,
      title: m.title,
      content: m.content,
      order: m.order,
    })),
  });
});

lms94Router.post('/courses/:id/modules', MANAGE, async (req, res) => {
  const input = ModuleInputSchema.parse(req.body);
  const created = await prisma.courseModule.create({
    data: {
      courseId: req.params.id,
      kind: input.kind,
      title: input.title,
      content: input.content as Prisma.InputJsonValue,
      order: input.order,
    },
  });
  res.status(201).json({ id: created.id });
});

lms94Router.delete('/modules/:id', MANAGE, async (req, res) => {
  await prisma.courseModule.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Enrollments ------------------------------------------------------

const EnrollInputSchema = z.object({
  associateIds: z.array(z.string().uuid()).min(1),
});

lms94Router.post('/courses/:id/enroll', MANAGE, async (req, res) => {
  const courseId = req.params.id;
  const input = EnrollInputSchema.parse(req.body);
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.deletedAt) {
    throw new HttpError(404, 'not_found', 'Course not found.');
  }
  if (course.status !== 'PUBLISHED') {
    throw new HttpError(409, 'not_published', 'Cannot enroll into an unpublished course.');
  }

  let created = 0;
  let skipped = 0;
  for (const associateId of input.associateIds) {
    try {
      await prisma.courseEnrollment.create({
        data: {
          courseId,
          associateId,
          assignedById: req.user!.id,
        },
      });
      created++;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Already actively enrolled — partial unique index hit.
        skipped++;
        continue;
      }
      throw err;
    }
  }
  res.status(201).json({ created, skipped });
});

lms94Router.get('/enrollments', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const courseId = z.string().uuid().optional().parse(req.query.courseId);
  const status = z
    .enum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'WAIVED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.courseEnrollment.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(courseId ? { courseId } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      course: { select: { title: true, validityDays: true } },
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { assignedAt: 'desc' },
    take: 500,
  });
  res.json({
    enrollments: rows.map((e) => ({
      id: e.id,
      courseId: e.courseId,
      courseTitle: e.course.title,
      associateId: e.associateId,
      associateName: `${e.associate.firstName} ${e.associate.lastName}`,
      status: e.status,
      completedAt: e.completedAt?.toISOString() ?? null,
      expiresAt: e.expiresAt?.toISOString() ?? null,
      score: e.score?.toString() ?? null,
      assignedAt: e.assignedAt.toISOString(),
    })),
  });
});

lms94Router.post('/enrollments/:id/complete', VIEW, async (req, res) => {
  const score = z.number().min(0).max(100).optional().nullable().parse(req.body?.score);
  const e = await prisma.courseEnrollment.findUnique({
    where: { id: req.params.id },
    include: { course: true },
  });
  if (!e) throw new HttpError(404, 'not_found', 'Enrollment not found.');
  if (e.status === 'COMPLETED' || e.status === 'WAIVED') {
    throw new HttpError(409, 'already_done', `Enrollment already ${e.status}.`);
  }

  const completedAt = new Date();
  const expiresAt = e.course.validityDays
    ? new Date(completedAt.getTime() + e.course.validityDays * 24 * 3600 * 1000)
    : null;

  await prisma.courseEnrollment.update({
    where: { id: e.id },
    data: {
      status: 'COMPLETED',
      completedAt,
      expiresAt,
      score: score ?? null,
    },
  });
  res.json({ ok: true, expiresAt: expiresAt?.toISOString() ?? null });
});

lms94Router.post('/enrollments/:id/waive', MANAGE, async (req, res) => {
  await prisma.courseEnrollment.update({
    where: { id: req.params.id },
    data: { status: 'WAIVED' },
  });
  res.json({ ok: true });
});

/**
 * Compliance dashboard: enrollments expiring in the next N days.
 */
lms94Router.get('/lms/expiring', VIEW, async (req, res) => {
  const days = z
    .preprocess((v) => (v ? Number(v) : 30), z.number().int().min(1).max(365))
    .parse(req.query.days);
  const cutoff = new Date(Date.now() + days * 24 * 3600 * 1000);
  const rows = await prisma.courseEnrollment.findMany({
    take: 500,
    where: {
      status: 'COMPLETED',
      expiresAt: { not: null, lte: cutoff },
    },
    include: {
      course: { select: { title: true, isRequired: true } },
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { expiresAt: 'asc' },
  });
  res.json({
    expiring: rows.map((e) => ({
      id: e.id,
      courseTitle: e.course.title,
      isRequired: e.course.isRequired,
      associateName: `${e.associate.firstName} ${e.associate.lastName}`,
      expiresAt: e.expiresAt!.toISOString(),
      daysLeft: Math.ceil(
        (e.expiresAt!.getTime() - Date.now()) / (24 * 3600 * 1000),
      ),
    })),
  });
});
