import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 126 — Career ladders.
 *
 * Read open to authenticated associates (everyone should see the ladder
 * to plan their career). Write/manage gated by manage:performance — same
 * audience that owns competency catalogs.
 */

export const career126Router = Router();

const MANAGE = requireCapability('manage:performance');

const SKILL_LEVEL = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']);

// ----- List ladders --------------------------------------------------------

career126Router.get('/career-ladders', requireAuth, async (_req, res) => {
  const rows = await prisma.careerLadder.findMany({
    take: 1000,
    where: { archivedAt: null },
    include: {
      _count: { select: { levels: true } },
      client: { select: { name: true } },
    },
    orderBy: [{ family: 'asc' }, { name: 'asc' }],
  });
  res.json({
    ladders: rows.map((l) => ({
      id: l.id,
      name: l.name,
      family: l.family,
      description: l.description,
      clientName: l.client?.name ?? null,
      levelCount: l._count.levels,
    })),
  });
});

// ----- Ladder detail (with levels + skills) --------------------------------

career126Router.get('/career-ladders/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const ladder = await prisma.careerLadder.findUnique({
    where: { id },
    include: {
      client: { select: { name: true } },
      levels: {
        orderBy: { rank: 'asc' },
        include: {
          jobProfile: { select: { title: true, code: true } },
          skills: {
            include: { skill: { select: { name: true, category: true } } },
          },
        },
      },
    },
  });
  if (!ladder) {
    throw new HttpError(404, 'not_found', 'Ladder not found.');
  }
  res.json({
    id: ladder.id,
    name: ladder.name,
    family: ladder.family,
    description: ladder.description,
    clientName: ladder.client?.name ?? null,
    levels: ladder.levels.map((lv) => ({
      id: lv.id,
      rank: lv.rank,
      title: lv.title,
      description: lv.description,
      jobProfileId: lv.jobProfileId,
      jobProfileTitle: lv.jobProfile?.title ?? null,
      jobProfileCode: lv.jobProfile?.code ?? null,
      skills: lv.skills.map((s) => ({
        id: s.id,
        skillId: s.skillId,
        skillName: s.skill.name,
        skillCategory: s.skill.category,
        minLevel: s.minLevel,
      })),
    })),
  });
});

// ----- Create ladder -------------------------------------------------------

const CreateLadderInputSchema = z.object({
  clientId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(200),
  family: z.string().max(120).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
});

career126Router.post('/career-ladders', MANAGE, async (req, res) => {
  const input = CreateLadderInputSchema.parse(req.body);
  const created = await prisma.careerLadder.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      family: input.family ?? null,
      description: input.description ?? null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

// ----- Add level -----------------------------------------------------------

const AddLevelInputSchema = z.object({
  rank: z.number().int().min(1).max(20),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  jobProfileId: z.string().uuid().optional().nullable(),
});

career126Router.post(
  '/career-ladders/:id/levels',
  MANAGE,
  async (req, res) => {
    const ladderId = z.string().uuid().parse(req.params.id);
    const input = AddLevelInputSchema.parse(req.body);
    const ladder = await prisma.careerLadder.findUnique({
      where: { id: ladderId },
    });
    if (!ladder) {
      throw new HttpError(404, 'ladder_not_found', 'Ladder not found.');
    }
    try {
      const created = await prisma.careerLevel.create({
        data: {
          ladderId,
          rank: input.rank,
          title: input.title,
          description: input.description ?? null,
          jobProfileId: input.jobProfileId ?? null,
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
        throw new HttpError(409, 'rank_taken', `Rank ${input.rank} is already used in this ladder.`);
      }
      throw err;
    }
  },
);

// ----- Update level --------------------------------------------------------

const UpdateLevelInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional().nullable(),
  jobProfileId: z.string().uuid().optional().nullable(),
});

career126Router.patch('/career-levels/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = UpdateLevelInputSchema.parse(req.body);
  const level = await prisma.careerLevel.findUnique({ where: { id } });
  if (!level) {
    throw new HttpError(404, 'not_found', 'Level not found.');
  }
  await prisma.careerLevel.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.jobProfileId !== undefined ? { jobProfileId: input.jobProfileId } : {}),
    },
  });
  res.json({ ok: true });
});

career126Router.delete('/career-levels/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const level = await prisma.careerLevel.findUnique({ where: { id } });
  if (!level) {
    throw new HttpError(404, 'not_found', 'Level not found.');
  }
  await prisma.careerLevel.delete({ where: { id } });
  res.status(204).end();
});

// ----- Add / remove skill requirements -------------------------------------

const AddSkillInputSchema = z.object({
  skillId: z.string().uuid(),
  minLevel: SKILL_LEVEL,
});

career126Router.post(
  '/career-levels/:id/skills',
  MANAGE,
  async (req, res) => {
    const levelId = z.string().uuid().parse(req.params.id);
    const input = AddSkillInputSchema.parse(req.body);
    const level = await prisma.careerLevel.findUnique({
      where: { id: levelId },
    });
    if (!level) {
      throw new HttpError(404, 'level_not_found', 'Level not found.');
    }
    try {
      const created = await prisma.careerLevelSkill.create({
        data: {
          levelId,
          skillId: input.skillId,
          minLevel: input.minLevel,
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
          'skill_already_required',
          'That skill is already a requirement for this level.',
        );
      }
      throw err;
    }
  },
);

career126Router.delete(
  '/career-level-skills/:id',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const r = await prisma.careerLevelSkill.findUnique({ where: { id } });
    if (!r) {
      throw new HttpError(404, 'not_found', 'Requirement not found.');
    }
    await prisma.careerLevelSkill.delete({ where: { id } });
    res.status(204).end();
  },
);

// ----- Archive ladder ------------------------------------------------------

career126Router.post(
  '/career-ladders/:id/archive',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const ladder = await prisma.careerLadder.findUnique({ where: { id } });
    if (!ladder) {
      throw new HttpError(404, 'not_found', 'Ladder not found.');
    }
    await prisma.careerLadder.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    res.json({ ok: true });
  },
);
