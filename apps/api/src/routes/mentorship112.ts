import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 112 — Mentorship matching.
 *
 * Three flows:
 *   - Browse / propose: HR creates a Mentorship in PROPOSED state.
 *   - Lifecycle: mentor/mentee accept (-> ACTIVE), complete, decline.
 *   - Suggestions: given a mentee + a target skill, propose mentors
 *     who hold that skill at ADVANCED+ and aren't already paired.
 */

export const mentorship112Router = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const STATUS = ['PROPOSED', 'ACTIVE', 'COMPLETED', 'DECLINED', 'CANCELLED'] as const;

mentorship112Router.get('/mentorships', VIEW, async (req, res) => {
  const status = z.enum(STATUS).optional().parse(req.query.status);
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const rows = await prisma.mentorship.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(associateId
        ? {
            OR: [
              { mentorAssociateId: associateId },
              { menteeAssociateId: associateId },
            ],
          }
        : {}),
    },
    include: {
      mentor: { select: { firstName: true, lastName: true } },
      mentee: { select: { firstName: true, lastName: true } },
      focusSkill: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    mentorships: rows.map((m) => ({
      id: m.id,
      mentorAssociateId: m.mentorAssociateId,
      mentorName: `${m.mentor.firstName} ${m.mentor.lastName}`,
      menteeAssociateId: m.menteeAssociateId,
      menteeName: `${m.mentee.firstName} ${m.mentee.lastName}`,
      focusSkillName: m.focusSkill?.name ?? null,
      goals: m.goals,
      status: m.status,
      startedAt: m.startedAt?.toISOString() ?? null,
      endedAt: m.endedAt?.toISOString() ?? null,
      endedReason: m.endedReason,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

const ProposeSchema = z.object({
  mentorAssociateId: z.string().uuid(),
  menteeAssociateId: z.string().uuid(),
  focusSkillId: z.string().uuid().optional().nullable(),
  goals: z.string().max(2000).optional().nullable(),
});

mentorship112Router.post('/mentorships', MANAGE, async (req, res) => {
  const input = ProposeSchema.parse(req.body);
  if (input.mentorAssociateId === input.menteeAssociateId) {
    throw new HttpError(400, 'self_pairing', 'Mentor and mentee must be different people.');
  }
  const created = await prisma.mentorship.create({
    data: {
      mentorAssociateId: input.mentorAssociateId,
      menteeAssociateId: input.menteeAssociateId,
      focusSkillId: input.focusSkillId ?? null,
      goals: input.goals ?? null,
      proposedById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

const TransitionSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED', 'DECLINED', 'CANCELLED']),
  endedReason: z.string().max(2000).optional(),
});

mentorship112Router.post(
  '/mentorships/:id/transition',
  MANAGE,
  async (req, res) => {
    const input = TransitionSchema.parse(req.body);
    const m = await prisma.mentorship.findUnique({
      where: { id: req.params.id },
      select: { status: true },
    });
    if (!m) throw new HttpError(404, 'not_found', 'Mentorship not found.');
    // Forward-only transitions: PROPOSED -> ACTIVE / DECLINED;
    // ACTIVE -> COMPLETED / CANCELLED. Reject backward moves.
    const valid: Record<string, string[]> = {
      PROPOSED: ['ACTIVE', 'DECLINED', 'CANCELLED'],
      ACTIVE: ['COMPLETED', 'CANCELLED'],
    };
    if (!valid[m.status]?.includes(input.status)) {
      throw new HttpError(
        409,
        'invalid_transition',
        `Cannot move from ${m.status} to ${input.status}.`,
      );
    }
    await prisma.mentorship.update({
      where: { id: req.params.id },
      data: {
        status: input.status,
        startedAt: input.status === 'ACTIVE' ? new Date() : undefined,
        endedAt:
          input.status === 'COMPLETED' ||
          input.status === 'CANCELLED' ||
          input.status === 'DECLINED'
            ? new Date()
            : undefined,
        endedReason: input.endedReason ?? null,
      },
    });
    res.json({ ok: true });
  },
);

// Suggestion: given a target skill, return candidate mentors (associates
// holding that skill at ADVANCED+ who aren't already pairing the mentee).
const SuggestSchema = z.object({
  menteeAssociateId: z.string().uuid(),
  skillId: z.string().uuid(),
});

mentorship112Router.post('/mentorships/suggest', VIEW, async (req, res) => {
  const input = SuggestSchema.parse(req.body);
  const candidates = await prisma.associateSkill.findMany({
    where: {
      skillId: input.skillId,
      level: { in: ['ADVANCED', 'EXPERT'] },
      associate: { deletedAt: null },
      associateId: { not: input.menteeAssociateId },
    },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          // Exclude associates already in an active mentorship with this mentee.
          mentorshipsAsMentor: {
            where: {
              menteeAssociateId: input.menteeAssociateId,
              status: { in: ['PROPOSED', 'ACTIVE'] },
            },
            select: { id: true },
          },
        },
      },
    },
    orderBy: { level: 'desc' },
    take: 50,
  });
  const filtered = candidates.filter(
    (c) => c.associate.mentorshipsAsMentor.length === 0,
  );
  res.json({
    candidates: filtered.map((c) => ({
      associateId: c.associate.id,
      name: `${c.associate.firstName} ${c.associate.lastName}`,
      email: c.associate.email,
      level: c.level,
      yearsExperience: c.yearsExperience,
      verified: c.verifiedAt !== null,
    })),
  });
});
