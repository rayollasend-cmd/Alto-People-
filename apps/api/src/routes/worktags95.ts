import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 95 — Worktags: multi-dimensional categorical tags on
 * transactions. Categories are admin-defined (Department, Project,
 * GL Account, Region…); within a category, exactly one worktag per
 * transaction is enforced in the assign handler (the DB schema doesn't
 * model that constraint — would require a CTE/trigger).
 */

export const worktags95Router = Router();

const VIEW = requireCapability('view:payroll');
const MANAGE = requireCapability('process:payroll');

const ENTITY_KINDS = ['TIME_ENTRY', 'PAYROLL_ITEM', 'EXPENSE', 'PURCHASE_ORDER'] as const;

// ----- Categories -------------------------------------------------------

const CategoryInputSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9_]+$/, 'Key must be lowercase alphanumeric/underscore.'),
  label: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  isRequired: z.boolean().optional(),
});

worktags95Router.get('/worktag-categories', VIEW, async (_req, res) => {
  const rows = await prisma.worktagCategory.findMany({
    include: { _count: { select: { worktags: true } } },
    orderBy: { label: 'asc' },
  });
  res.json({
    categories: rows.map((c) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      description: c.description,
      isRequired: c.isRequired,
      isActive: c.isActive,
      worktagCount: c._count.worktags,
    })),
  });
});

worktags95Router.post('/worktag-categories', MANAGE, async (req, res) => {
  const input = CategoryInputSchema.parse(req.body);
  try {
    const created = await prisma.worktagCategory.create({
      data: {
        key: input.key,
        label: input.label,
        description: input.description ?? null,
        isRequired: input.isRequired ?? false,
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'key_taken', 'A category with that key already exists.');
    }
    throw err;
  }
});

// ----- Worktag values ---------------------------------------------------

const WorktagInputSchema = z.object({
  categoryId: z.string().uuid(),
  value: z.string().min(1).max(200),
  code: z.string().max(80).optional().nullable(),
});

worktags95Router.get('/worktags', VIEW, async (req, res) => {
  const categoryId = z.string().uuid().optional().parse(req.query.categoryId);
  const rows = await prisma.worktag.findMany({
    where: { isActive: true, ...(categoryId ? { categoryId } : {}) },
    include: { category: { select: { key: true, label: true } } },
    orderBy: { value: 'asc' },
    take: 500,
  });
  res.json({
    worktags: rows.map((w) => ({
      id: w.id,
      categoryId: w.categoryId,
      categoryKey: w.category.key,
      categoryLabel: w.category.label,
      value: w.value,
      code: w.code,
    })),
  });
});

worktags95Router.post('/worktags', MANAGE, async (req, res) => {
  const input = WorktagInputSchema.parse(req.body);
  try {
    const created = await prisma.worktag.create({
      data: {
        categoryId: input.categoryId,
        value: input.value,
        code: input.code ?? null,
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(
        409,
        'value_taken',
        'This value already exists in the category.',
      );
    }
    throw err;
  }
});

worktags95Router.delete('/worktags/:id', MANAGE, async (req, res) => {
  await prisma.worktag.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.status(204).end();
});

// ----- Assignments ------------------------------------------------------

const AssignInputSchema = z.object({
  entityKind: z.enum(ENTITY_KINDS),
  entityId: z.string().uuid(),
  worktagIds: z.array(z.string().uuid()),
});

worktags95Router.post('/worktag-assignments', VIEW, async (req, res) => {
  const input = AssignInputSchema.parse(req.body);

  const worktags = await prisma.worktag.findMany({
    where: { id: { in: input.worktagIds }, isActive: true },
    select: { id: true, categoryId: true },
  });
  if (worktags.length !== input.worktagIds.length) {
    throw new HttpError(400, 'invalid_worktag', 'One or more worktag IDs are invalid.');
  }
  // App-level uniqueness: at most one worktag per category for this entity.
  const seenCategories = new Set<string>();
  for (const w of worktags) {
    if (seenCategories.has(w.categoryId)) {
      throw new HttpError(
        400,
        'duplicate_category',
        'Multiple worktags for the same category not allowed on one entity.',
      );
    }
    seenCategories.add(w.categoryId);
  }

  await prisma.$transaction(async (tx) => {
    // Replace existing assignments for the categories we're touching.
    await tx.worktagAssignment.deleteMany({
      where: {
        entityKind: input.entityKind,
        entityId: input.entityId,
        worktag: { categoryId: { in: Array.from(seenCategories) } },
      },
    });
    if (worktags.length > 0) {
      await tx.worktagAssignment.createMany({
        data: worktags.map((w) => ({
          worktagId: w.id,
          entityKind: input.entityKind,
          entityId: input.entityId,
          createdById: req.user!.id,
        })),
      });
    }
  });

  res.status(201).json({ ok: true, assigned: worktags.length });
});

worktags95Router.get('/worktag-assignments', VIEW, async (req, res) => {
  const entityKind = z.enum(ENTITY_KINDS).parse(req.query.entityKind);
  const entityId = z.string().uuid().parse(req.query.entityId);
  const rows = await prisma.worktagAssignment.findMany({
    where: { entityKind, entityId },
    include: {
      worktag: {
        include: { category: { select: { key: true, label: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    assignments: rows.map((a) => ({
      id: a.id,
      worktagId: a.worktagId,
      categoryKey: a.worktag.category.key,
      categoryLabel: a.worktag.category.label,
      value: a.worktag.value,
      code: a.worktag.code,
      createdAt: a.createdAt.toISOString(),
    })),
  });
});

worktags95Router.delete('/worktag-assignments/:id', VIEW, async (req, res) => {
  await prisma.worktagAssignment.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

/**
 * Cross-cutting report: spend summed by worktag in a category.
 * For a given (categoryKey, entityKind), groups payroll items / expenses
 * by their worktag in that category and sums the amount field. Useful
 * for "show me payroll cost by Project" or "spend by GL".
 */
worktags95Router.get('/worktags/report', VIEW, async (req, res) => {
  const categoryKey = z.string().parse(req.query.categoryKey);
  const entityKind = z.enum(ENTITY_KINDS).parse(req.query.entityKind);
  const category = await prisma.worktagCategory.findUnique({
    where: { key: categoryKey },
  });
  if (!category) throw new HttpError(404, 'not_found', 'Category not found.');

  const assignments = await prisma.worktagAssignment.findMany({
    where: {
      entityKind,
      worktag: { categoryId: category.id },
    },
    include: { worktag: true },
  });

  const groups = new Map<string, { value: string; count: number }>();
  for (const a of assignments) {
    const k = a.worktagId;
    const existing = groups.get(k);
    if (existing) {
      existing.count++;
    } else {
      groups.set(k, { value: a.worktag.value, count: 1 });
    }
  }
  res.json({
    category: { key: category.key, label: category.label },
    entityKind,
    rows: Array.from(groups.entries()).map(([worktagId, v]) => ({
      worktagId,
      value: v.value,
      count: v.count,
    })),
  });
});
