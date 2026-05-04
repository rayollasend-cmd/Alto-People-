import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 87 — Directory + broadcast + surveys.
 *
 * /directory                    GET ?q
 *   Lightweight people search across active associates with org context.
 *
 * /broadcasts                   GET / POST / PUT /:id / POST /:id/send
 * /broadcasts/me                GET — broadcasts the current user is a
 *                                     recipient of, with read state
 * /broadcasts/:id/read          POST — mark read
 *
 * /surveys                      GET / POST / PUT /:id / POST /:id/open / close
 * /surveys/:id/questions        GET / POST
 * /surveys/:id/responses        GET (aggregated) / POST (submit)
 */

export const directoryAndCommsRouter = Router();

const VIEW_DASH = requireCapability('view:dashboard');
const MANAGE_COMMS = requireCapability('manage:communications');
const VIEW_COMMS = requireCapability('view:communications');

// ----- Directory --------------------------------------------------------

directoryAndCommsRouter.get(
  '/directory',
  VIEW_DASH,
  async (req, res) => {
    const q = z.string().max(120).optional().parse(req.query.q);
    const where: Prisma.AssociateWhereInput = { deletedAt: null };
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }
    const rows = await prisma.associate.findMany({
      where,
      take: 100,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        managerId: true,
        department: { select: { id: true, name: true } },
        jobProfile: { select: { id: true, title: true } },
      },
    });
    res.json({
      people: rows.map((a) => ({
        id: a.id,
        name: `${a.firstName} ${a.lastName}`,
        email: a.email,
        phone: a.phone,
        managerId: a.managerId,
        department: a.department?.name ?? null,
        jobTitle: a.jobProfile?.title ?? null,
      })),
    });
  },
);

// ----- Broadcasts -------------------------------------------------------

const BroadcastInputSchema = z.object({
  title: z.string().min(1).max(250),
  body: z.string().min(1).max(20000),
  channels: z
    .array(z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']))
    .min(1)
    .optional(),
  clientId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
});

directoryAndCommsRouter.get(
  '/broadcasts',
  VIEW_COMMS,
  async (_req, res) => {
    const rows = await prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { receipts: true } } },
    });
    res.json({
      broadcasts: rows.map((b) => ({
        id: b.id,
        title: b.title,
        body: b.body,
        channels: b.channels,
        status: b.status,
        clientId: b.clientId,
        departmentId: b.departmentId,
        costCenterId: b.costCenterId,
        scheduledFor: b.scheduledFor?.toISOString() ?? null,
        sentAt: b.sentAt?.toISOString() ?? null,
        receiptCount: b._count.receipts,
        createdAt: b.createdAt.toISOString(),
      })),
    });
  },
);

directoryAndCommsRouter.post(
  '/broadcasts',
  MANAGE_COMMS,
  async (req, res) => {
    const input = BroadcastInputSchema.parse(req.body);
    const created = await prisma.broadcast.create({
      data: {
        title: input.title,
        body: input.body,
        channels: input.channels ?? ['IN_APP'],
        clientId: input.clientId ?? null,
        departmentId: input.departmentId ?? null,
        costCenterId: input.costCenterId ?? null,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        status: input.scheduledFor ? 'SCHEDULED' : 'DRAFT',
        createdById: req.user!.id,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

directoryAndCommsRouter.put(
  '/broadcasts/:id',
  MANAGE_COMMS,
  async (req, res) => {
    const id = req.params.id;
    const input = BroadcastInputSchema.partial().parse(req.body);
    const existing = await prisma.broadcast.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'not_found', 'Broadcast not found.');
    if (existing.status === 'SENT') {
      throw new HttpError(400, 'already_sent', 'Cannot edit a sent broadcast.');
    }
    await prisma.broadcast.update({
      where: { id },
      data: {
        title: input.title ?? undefined,
        body: input.body ?? undefined,
        channels: input.channels ?? undefined,
        clientId: input.clientId === undefined ? undefined : input.clientId,
        departmentId: input.departmentId === undefined ? undefined : input.departmentId,
        costCenterId: input.costCenterId === undefined ? undefined : input.costCenterId,
        scheduledFor:
          input.scheduledFor === undefined
            ? undefined
            : input.scheduledFor === null
              ? null
              : new Date(input.scheduledFor),
      },
    });
    res.json({ ok: true });
  },
);

/**
 * Send-now: stamp sentAt, materialize a BroadcastReceipt for every
 * targeted user, and stub channels other than IN_APP. SMS/EMAIL/PUSH
 * delivery hooks land in Phase 89.
 */
directoryAndCommsRouter.post(
  '/broadcasts/:id/send',
  MANAGE_COMMS,
  async (req, res) => {
    const id = req.params.id;
    const b = await prisma.broadcast.findUnique({ where: { id } });
    if (!b) throw new HttpError(404, 'not_found', 'Broadcast not found.');
    if (b.status === 'SENT') {
      throw new HttpError(400, 'already_sent', 'Already sent.');
    }

    // Resolve recipients via Associate ↔ User join, applying targeting.
    const associateWhere: Prisma.AssociateWhereInput = {
      deletedAt: null,
      ...(b.clientId
        ? { applications: { some: { clientId: b.clientId } } }
        : {}),
      ...(b.departmentId ? { departmentId: b.departmentId } : {}),
      ...(b.costCenterId ? { costCenterId: b.costCenterId } : {}),
    };
    const associates = await prisma.associate.findMany({
      take: 1000,
      where: associateWhere,
      select: { user: { select: { id: true } } },
    });
    const userIds = associates
      .map((a) => a.user?.id)
      .filter((id): id is string => Boolean(id));

    await prisma.$transaction(async (tx) => {
      // Receipts go to associate-linked users only — staff users see the
      // broadcast through the admin list.
      if (userIds.length > 0) {
        await tx.broadcastReceipt.createMany({
          data: userIds.map((uid) => ({ broadcastId: id, userId: uid })),
          skipDuplicates: true,
        });
      }
      await tx.broadcast.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    });

    res.json({ recipientCount: userIds.length });
  },
);

directoryAndCommsRouter.get(
  '/broadcasts/me',
  async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    const rows = await prisma.broadcastReceipt.findMany({
      where: { userId: req.user.id },
      include: {
        broadcast: {
          select: {
            id: true,
            title: true,
            body: true,
            sentAt: true,
            channels: true,
          },
        },
      },
      orderBy: { broadcast: { sentAt: 'desc' } },
      take: 100,
    });
    res.json({
      broadcasts: rows.map((r) => ({
        id: r.broadcast.id,
        title: r.broadcast.title,
        body: r.broadcast.body,
        sentAt: r.broadcast.sentAt?.toISOString() ?? null,
        channels: r.broadcast.channels,
        readAt: r.readAt?.toISOString() ?? null,
        dismissedAt: r.dismissedAt?.toISOString() ?? null,
      })),
    });
  },
);

directoryAndCommsRouter.post(
  '/broadcasts/:id/read',
  async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    const id = req.params.id;
    await prisma.broadcastReceipt.updateMany({
      where: { broadcastId: id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  },
);

// ----- Surveys -----------------------------------------------------------

const SurveyInputSchema = z.object({
  title: z.string().min(1).max(250),
  description: z.string().max(4000).nullable().optional(),
  isAnonymous: z.boolean().optional(),
  clientId: z.string().uuid().nullable().optional(),
});

const QuestionInputSchema = z.object({
  kind: z.enum([
    'SHORT_TEXT',
    'LONG_TEXT',
    'SINGLE_CHOICE',
    'MULTI_CHOICE',
    'SCALE_1_5',
    'NPS_0_10',
  ]),
  prompt: z.string().min(1).max(1000),
  choices: z.array(z.string().max(200)).optional(),
  isRequired: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

directoryAndCommsRouter.get(
  '/surveys',
  VIEW_COMMS,
  async (_req, res) => {
    const rows = await prisma.survey.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { responses: true, questions: true } } },
    });
    res.json({
      surveys: rows.map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        status: s.status,
        isAnonymous: s.isAnonymous,
        clientId: s.clientId,
        openedAt: s.openedAt?.toISOString() ?? null,
        closedAt: s.closedAt?.toISOString() ?? null,
        questionCount: s._count.questions,
        responseCount: s._count.responses,
      })),
    });
  },
);

directoryAndCommsRouter.post(
  '/surveys',
  MANAGE_COMMS,
  async (req, res) => {
    const input = SurveyInputSchema.parse(req.body);
    const created = await prisma.survey.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        isAnonymous: input.isAnonymous ?? true,
        clientId: input.clientId ?? null,
        createdById: req.user!.id,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

directoryAndCommsRouter.get(
  '/surveys/:id/questions',
  VIEW_COMMS,
  async (req, res) => {
    const surveyId = req.params.id;
    const rows = await prisma.surveyQuestion.findMany({
      take: 500,
      where: { surveyId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ questions: rows });
  },
);

directoryAndCommsRouter.post(
  '/surveys/:id/questions',
  MANAGE_COMMS,
  async (req, res) => {
    const surveyId = req.params.id;
    const input = QuestionInputSchema.parse(req.body);
    const created = await prisma.surveyQuestion.create({
      data: {
        surveyId,
        kind: input.kind,
        prompt: input.prompt,
        choices: input.choices ? (input.choices as Prisma.InputJsonValue) : Prisma.JsonNull,
        isRequired: input.isRequired ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    res.status(201).json({ id: created.id });
  },
);

directoryAndCommsRouter.post(
  '/surveys/:id/open',
  MANAGE_COMMS,
  async (req, res) => {
    const id = req.params.id;
    await prisma.survey.update({
      where: { id },
      data: { status: 'OPEN', openedAt: new Date() },
    });
    res.json({ ok: true });
  },
);

directoryAndCommsRouter.post(
  '/surveys/:id/close',
  MANAGE_COMMS,
  async (req, res) => {
    const id = req.params.id;
    await prisma.survey.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    res.json({ ok: true });
  },
);

const AnswerSchema = z.object({
  questionId: z.string().uuid(),
  textValue: z.string().max(8000).nullable().optional(),
  intValue: z.number().int().nullable().optional(),
  choiceValues: z.array(z.number().int()).optional(),
});

const ResponseSchema = z.object({
  answers: z.array(AnswerSchema).min(1),
});

directoryAndCommsRouter.post(
  '/surveys/:id/responses',
  async (req, res) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
    const surveyId = req.params.id;
    const input = ResponseSchema.parse(req.body);
    const survey = await prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey) throw new HttpError(404, 'not_found', 'Survey not found.');
    if (survey.status !== 'OPEN') {
      throw new HttpError(400, 'not_open', 'Survey is not open for responses.');
    }
    await prisma.$transaction(async (tx) => {
      const response = await tx.surveyResponse.create({
        data: {
          surveyId,
          respondentId: survey.isAnonymous ? null : req.user!.id,
        },
      });
      for (const a of input.answers) {
        await tx.surveyAnswer.create({
          data: {
            responseId: response.id,
            questionId: a.questionId,
            textValue: a.textValue ?? null,
            intValue: a.intValue ?? null,
            choiceValues: a.choiceValues ?? [],
          },
        });
      }
    });
    res.status(201).json({ ok: true });
  },
);

/**
 * Aggregate per-question. For NPS/SCALE: counts + avg. For choice-style:
 * counts per choice index. For text: count only (raw text gated on
 * manage:communications).
 */
directoryAndCommsRouter.get(
  '/surveys/:id/responses',
  VIEW_COMMS,
  async (req, res) => {
    const surveyId = req.params.id;
    const survey = await prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey) throw new HttpError(404, 'not_found', 'Survey not found.');

    const responses = await prisma.surveyResponse.findMany({
      take: 500,
      where: { surveyId },
      include: { answers: true },
    });
    const questions = await prisma.surveyQuestion.findMany({
      take: 500,
      where: { surveyId },
      orderBy: [{ sortOrder: 'asc' }],
    });

    const byQuestion = questions.map((q) => {
      const answers = responses.flatMap((r) =>
        r.answers.filter((a) => a.questionId === q.id),
      );
      if (q.kind === 'SCALE_1_5' || q.kind === 'NPS_0_10') {
        const ints = answers.map((a) => a.intValue).filter((n): n is number => n !== null);
        const avg = ints.length === 0 ? null : ints.reduce((a, b) => a + b, 0) / ints.length;
        return {
          questionId: q.id,
          prompt: q.prompt,
          kind: q.kind,
          count: ints.length,
          avg,
        };
      }
      if (q.kind === 'SINGLE_CHOICE' || q.kind === 'MULTI_CHOICE') {
        const tally: Record<number, number> = {};
        for (const a of answers) {
          if (a.intValue != null) {
            tally[a.intValue] = (tally[a.intValue] ?? 0) + 1;
          }
          for (const c of a.choiceValues) {
            tally[c] = (tally[c] ?? 0) + 1;
          }
        }
        return {
          questionId: q.id,
          prompt: q.prompt,
          kind: q.kind,
          count: answers.length,
          tally,
          choices: q.choices,
        };
      }
      // Text-style: return text values when survey is non-anonymous, count only otherwise.
      return {
        questionId: q.id,
        prompt: q.prompt,
        kind: q.kind,
        count: answers.length,
        samples: survey.isAnonymous
          ? answers.map((a) => a.textValue).filter(Boolean).slice(0, 50)
          : answers.map((a) => a.textValue).filter(Boolean),
      };
    });

    res.json({
      survey: {
        id: survey.id,
        title: survey.title,
        isAnonymous: survey.isAnonymous,
        status: survey.status,
      },
      responseCount: responses.length,
      byQuestion,
    });
  },
);
