import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 109 — Anonymous pulse surveys.
 *
 * Anonymity model: PulseResponse has no FK to the responder. Instead
 * we store HMAC-SHA256(userId + ':' + surveyId, PULSE_HASH_SECRET) as
 * responderHash, with a unique constraint on (surveyId, responderHash).
 * That gives us:
 *   - duplicate-submission detection (same user, same survey)
 *   - anonymity even from a DB admin: without the secret, you can't
 *     map a known user to their responses
 *
 * Audience filtering is enforced at write time: a user whose
 * department doesn't match a BY_DEPARTMENT survey gets 403 if they
 * try to submit, and the survey doesn't appear in their /my/open list.
 */

export const pulseSurveysRouter = Router();

const VIEW_ADMIN = requireCapability('manage:org');
const ANY_USER = requireAuth;

function pulseSecret(): string {
  return env.PULSE_HASH_SECRET ?? env.PAYOUT_ENCRYPTION_KEY;
}

function responderHash(userId: string, surveyId: string): Buffer {
  return createHmac('sha256', pulseSecret())
    .update(`${userId}:${surveyId}`)
    .digest();
}

const SurveyInputSchema = z.object({
  question: z.string().min(5).max(500),
  scale: z.enum(['SCORE_1_5', 'YES_NO']),
  audience: z.enum(['ALL', 'BY_DEPARTMENT', 'BY_CLIENT']).default('ALL'),
  audienceDepartmentId: z.string().uuid().optional().nullable(),
  audienceClientId: z.string().uuid().optional().nullable(),
  /** Hours from now until the survey closes. */
  openHours: z.number().int().positive().max(24 * 30).default(72),
});

// ----- Admin -------------------------------------------------------------

pulseSurveysRouter.post('/pulse-surveys', VIEW_ADMIN, async (req, res) => {
  const input = SurveyInputSchema.parse(req.body);
  if (input.audience === 'BY_DEPARTMENT' && !input.audienceDepartmentId) {
    throw new HttpError(400, 'audience_required', 'Department required.');
  }
  if (input.audience === 'BY_CLIENT' && !input.audienceClientId) {
    throw new HttpError(400, 'audience_required', 'Client required.');
  }
  const openUntil = new Date(Date.now() + input.openHours * 3_600_000);
  const created = await prisma.pulseSurvey.create({
    data: {
      question: input.question,
      scale: input.scale,
      audience: input.audience,
      audienceDepartmentId:
        input.audience === 'BY_DEPARTMENT' ? input.audienceDepartmentId! : null,
      audienceClientId:
        input.audience === 'BY_CLIENT' ? input.audienceClientId! : null,
      openUntil,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

pulseSurveysRouter.get('/pulse-surveys', VIEW_ADMIN, async (_req, res) => {
  const rows = await prisma.pulseSurvey.findMany({
    include: {
      _count: { select: { responses: true } },
      audienceDepartment: { select: { name: true } },
      audienceClient: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    surveys: rows.map((s) => ({
      id: s.id,
      question: s.question,
      scale: s.scale,
      audience: s.audience,
      audienceLabel:
        s.audience === 'BY_DEPARTMENT'
          ? s.audienceDepartment?.name ?? null
          : s.audience === 'BY_CLIENT'
            ? s.audienceClient?.name ?? null
            : 'Everyone',
      openFrom: s.openFrom.toISOString(),
      openUntil: s.openUntil.toISOString(),
      isOpen: s.openUntil.getTime() > Date.now() && s.openFrom.getTime() <= Date.now(),
      responseCount: s._count.responses,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

pulseSurveysRouter.get(
  '/pulse-surveys/:id/results',
  VIEW_ADMIN,
  async (req, res) => {
    const survey = await prisma.pulseSurvey.findUnique({
      where: { id: req.params.id },
    });
    if (!survey) throw new HttpError(404, 'not_found', 'Survey not found.');
    const responses = await prisma.pulseResponse.findMany({
      where: { surveyId: survey.id },
      select: { scoreValue: true, comment: true, submittedAt: true },
      orderBy: { submittedAt: 'desc' },
    });
    // Distribution: 1..5 for SCORE_1_5; 0/1 for YES_NO.
    const buckets: Record<string, number> = {};
    if (survey.scale === 'SCORE_1_5') {
      for (let i = 1; i <= 5; i++) buckets[String(i)] = 0;
    } else {
      buckets['YES'] = 0;
      buckets['NO'] = 0;
    }
    for (const r of responses) {
      if (survey.scale === 'SCORE_1_5') {
        const k = String(Math.max(1, Math.min(5, r.scoreValue)));
        buckets[k] = (buckets[k] ?? 0) + 1;
      } else {
        const k = r.scoreValue === 1 ? 'YES' : 'NO';
        buckets[k]++;
      }
    }
    const avg =
      survey.scale === 'SCORE_1_5' && responses.length > 0
        ? responses.reduce((s, r) => s + r.scoreValue, 0) / responses.length
        : null;
    // Comments are surfaced verbatim — they're already anonymous (no
    // responder linkage), but HR should know to redact PII before
    // sharing externally. We don't try to auto-redact here.
    res.json({
      survey: {
        id: survey.id,
        question: survey.question,
        scale: survey.scale,
        openUntil: survey.openUntil.toISOString(),
      },
      responseCount: responses.length,
      average: avg !== null ? Math.round(avg * 100) / 100 : null,
      distribution: buckets,
      comments: responses
        .filter((r) => r.comment && r.comment.trim().length > 0)
        .map((r) => ({
          comment: r.comment!,
          submittedAt: r.submittedAt.toISOString(),
        })),
    });
  },
);

pulseSurveysRouter.delete('/pulse-surveys/:id', VIEW_ADMIN, async (req, res) => {
  await prisma.pulseSurvey.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Self-service: open surveys for the current user -------------------

pulseSurveysRouter.get('/my/pulse-surveys', ANY_USER, async (req, res) => {
  // Resolve the user's audience attributes once.
  const me = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      clientId: true,
      associate: { select: { departmentId: true } },
    },
  });
  const myDeptId = me?.associate?.departmentId ?? null;
  const myClientId = me?.clientId ?? null;
  const now = new Date();
  const open = await prisma.pulseSurvey.findMany({
    where: {
      openFrom: { lte: now },
      openUntil: { gte: now },
      OR: [
        { audience: 'ALL' },
        ...(myDeptId
          ? [{ audience: 'BY_DEPARTMENT' as const, audienceDepartmentId: myDeptId }]
          : []),
        ...(myClientId
          ? [{ audience: 'BY_CLIENT' as const, audienceClientId: myClientId }]
          : []),
      ],
    },
    orderBy: { openFrom: 'desc' },
  });
  // Filter out surveys the user has already answered.
  const hashes = open.map((s) => responderHash(req.user!.id, s.id));
  const answered = await prisma.pulseResponse.findMany({
    where: {
      surveyId: { in: open.map((s) => s.id) },
      responderHash: { in: hashes },
    },
    select: { surveyId: true, responderHash: true },
  });
  const answeredKeys = new Set(
    answered.map((a) => `${a.surveyId}:${a.responderHash.toString('hex')}`),
  );
  const todo = open.filter(
    (s, i) =>
      !answeredKeys.has(`${s.id}:${hashes[i].toString('hex')}`),
  );
  res.json({
    surveys: todo.map((s) => ({
      id: s.id,
      question: s.question,
      scale: s.scale,
      openUntil: s.openUntil.toISOString(),
    })),
  });
});

const SubmitSchema = z.object({
  scoreValue: z.number().int().min(0).max(5),
  comment: z.string().max(2000).optional().nullable(),
});

pulseSurveysRouter.post(
  '/my/pulse-surveys/:id/respond',
  ANY_USER,
  async (req, res) => {
    const input = SubmitSchema.parse(req.body);
    const survey = await prisma.pulseSurvey.findUnique({
      where: { id: req.params.id },
    });
    if (!survey) throw new HttpError(404, 'not_found', 'Survey not found.');
    const now = new Date();
    if (survey.openFrom > now || survey.openUntil < now) {
      throw new HttpError(409, 'closed', 'This survey is not currently open.');
    }
    if (survey.scale === 'SCORE_1_5' && (input.scoreValue < 1 || input.scoreValue > 5)) {
      throw new HttpError(400, 'invalid_score', 'Score must be 1-5.');
    }
    if (survey.scale === 'YES_NO' && input.scoreValue !== 0 && input.scoreValue !== 1) {
      throw new HttpError(400, 'invalid_score', 'Answer must be 0 (no) or 1 (yes).');
    }
    // Audience check — refuse submissions from users not in the audience.
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        clientId: true,
        associate: { select: { departmentId: true } },
      },
    });
    if (
      survey.audience === 'BY_DEPARTMENT' &&
      me?.associate?.departmentId !== survey.audienceDepartmentId
    ) {
      throw new HttpError(403, 'not_in_audience', 'This survey is not for you.');
    }
    if (
      survey.audience === 'BY_CLIENT' &&
      me?.clientId !== survey.audienceClientId
    ) {
      throw new HttpError(403, 'not_in_audience', 'This survey is not for you.');
    }
    try {
      await prisma.pulseResponse.create({
        data: {
          surveyId: survey.id,
          responderHash: responderHash(req.user!.id, survey.id),
          scoreValue: input.scoreValue,
          comment: input.comment ?? null,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new HttpError(
          409,
          'already_responded',
          'You\'ve already answered this survey. Each person can answer once.',
        );
      }
      throw err;
    }
    res.status(201).json({ ok: true });
  },
);
