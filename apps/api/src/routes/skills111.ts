import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 111 — Skills & competencies.
 *
 * Two surfaces:
 *   - Catalog management (HR adds the skill master list).
 *   - Per-associate skill claims with proficiency level.
 *
 * Search: GET /skills/search?q=python returns associates ordered by
 * proficiency, optionally filtered to a minimum level. The killer
 * staffing query — "find me everyone who knows Python at advanced+".
 */

export const skills111Router = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'] as const;

const LEVEL_RANK: Record<typeof LEVELS[number], number> = {
  BEGINNER: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
  EXPERT: 4,
};

// ----- Catalog ----------------------------------------------------------

skills111Router.get('/skills', VIEW, async (req, res) => {
  const q = z.string().max(200).optional().parse(req.query.q);
  const rows = await prisma.skill.findMany({
    where: q
      ? { name: { contains: q, mode: 'insensitive' } }
      : undefined,
    include: { _count: { select: { associateSkills: true } } },
    orderBy: { name: 'asc' },
    take: 200,
  });
  res.json({
    skills: rows.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      associateCount: s._count.associateSkills,
    })),
  });
});

skills111Router.post('/skills', MANAGE, async (req, res) => {
  const input = z
    .object({
      name: z.string().min(1).max(120),
      category: z.string().max(60).optional().nullable(),
    })
    .parse(req.body);
  try {
    const created = await prisma.skill.create({
      data: { name: input.name.trim(), category: input.category ?? null },
    });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new HttpError(409, 'name_taken', 'A skill with that name already exists.');
    }
    throw err;
  }
});

skills111Router.delete('/skills/:id', MANAGE, async (req, res) => {
  await prisma.skill.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Associate skills -------------------------------------------------

const ClaimSchema = z.object({
  associateId: z.string().uuid(),
  skillId: z.string().uuid(),
  level: z.enum(LEVELS),
  yearsExperience: z.number().int().min(0).max(60).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

skills111Router.post('/associate-skills', MANAGE, async (req, res) => {
  const input = ClaimSchema.parse(req.body);
  // Upsert so re-claiming bumps the level/notes without dup rows.
  const row = await prisma.associateSkill.upsert({
    where: {
      associateId_skillId: {
        associateId: input.associateId,
        skillId: input.skillId,
      },
    },
    create: {
      associateId: input.associateId,
      skillId: input.skillId,
      level: input.level,
      yearsExperience: input.yearsExperience ?? null,
      notes: input.notes ?? null,
    },
    update: {
      level: input.level,
      yearsExperience: input.yearsExperience ?? null,
      notes: input.notes ?? null,
      // Reset verification — a level change needs re-verification.
      verifiedById: null,
      verifiedAt: null,
    },
  });
  res.status(201).json({ id: row.id });
});

skills111Router.post(
  '/associate-skills/:id/verify',
  MANAGE,
  async (req, res) => {
    await prisma.associateSkill.update({
      where: { id: req.params.id },
      data: {
        verifiedById: req.user!.id,
        verifiedAt: new Date(),
      },
    });
    res.json({ ok: true });
  },
);

skills111Router.delete('/associate-skills/:id', MANAGE, async (req, res) => {
  await prisma.associateSkill.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

skills111Router.get('/associate-skills', VIEW, async (req, res) => {
  const associateId = z
    .string()
    .uuid()
    .optional()
    .parse(req.query.associateId);
  if (!associateId) {
    throw new HttpError(400, 'associate_required', 'associateId is required.');
  }
  const rows = await prisma.associateSkill.findMany({
    where: { associateId },
    include: {
      skill: { select: { id: true, name: true, category: true } },
      verifiedBy: { select: { email: true } },
    },
    orderBy: [{ level: 'desc' }, { skill: { name: 'asc' } }],
  });
  res.json({
    skills: rows.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillName: r.skill.name,
      category: r.skill.category,
      level: r.level,
      yearsExperience: r.yearsExperience,
      notes: r.notes,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      verifiedByEmail: r.verifiedBy?.email ?? null,
    })),
  });
});

// ----- Search -----------------------------------------------------------

skills111Router.get('/skills/search', VIEW, async (req, res) => {
  const q = z.string().min(1).parse(req.query.q ?? '');
  const minLevel = z.enum(LEVELS).optional().parse(req.query.minLevel);
  const minRank = minLevel ? LEVEL_RANK[minLevel] : 1;
  const matches = await prisma.skill.findMany({
    where: { name: { contains: q, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 5,
  });
  if (matches.length === 0) {
    res.json({ skills: [], associates: [] });
    return;
  }
  const skillIds = matches.map((s) => s.id);
  const claims = await prisma.associateSkill.findMany({
    where: {
      skillId: { in: skillIds },
      // Filter by min level via raw rank — Prisma can't compare enums
      // directly, so we filter in JS after. The cardinality is small.
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true, deletedAt: true },
      },
      skill: { select: { name: true } },
    },
    orderBy: { level: 'desc' },
    take: 200,
  });
  const filtered = claims.filter(
    (c) =>
      c.associate.deletedAt === null &&
      LEVEL_RANK[c.level as typeof LEVELS[number]] >= minRank,
  );
  res.json({
    skills: matches,
    associates: filtered.map((c) => ({
      associateId: c.associate.id,
      name: `${c.associate.firstName} ${c.associate.lastName}`,
      email: c.associate.email,
      skillName: c.skill.name,
      level: c.level,
      yearsExperience: c.yearsExperience,
      verified: c.verifiedAt !== null,
    })),
  });
});
