import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  CandidateAdvanceInputSchema,
  CandidateCreateInputSchema,
  CandidateHireInputSchema,
  CandidateListResponseSchema,
  CandidateUpdateInputSchema,
  type Candidate,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

export const recruitingRouter = Router();

const MANAGE = requireCapability('manage:recruiting');

type RawCandidate = Prisma.CandidateGetPayload<object>;

function toCandidate(row: RawCandidate): Candidate {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    position: row.position,
    source: row.source,
    stage: row.stage,
    notes: row.notes,
    hiredAssociateId: row.hiredAssociateId,
    hiredClientId: row.hiredClientId,
    hiredAt: row.hiredAt ? row.hiredAt.toISOString() : null,
    rejectedReason: row.rejectedReason,
    withdrawnReason: row.withdrawnReason,
    createdAt: row.createdAt.toISOString(),
  };
}

recruitingRouter.get('/candidates', async (req, res, next) => {
  try {
    const stage = req.query.stage?.toString();
    const where: Prisma.CandidateWhereInput = {
      deletedAt: null,
      ...(stage ? { stage: stage as Prisma.CandidateWhereInput['stage'] } : {}),
    };
    const rows = await prisma.candidate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json(
      CandidateListResponseSchema.parse({ candidates: rows.map(toCandidate) })
    );
  } catch (err) {
    next(err);
  }
});

recruitingRouter.get('/candidates/:id', async (req, res, next) => {
  try {
    const row = await prisma.candidate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!row) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
    res.json(toCandidate(row));
  } catch (err) {
    next(err);
  }
});

recruitingRouter.post('/candidates', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    const email = i.email.trim().toLowerCase();

    try {
      const created = await prisma.candidate.create({
        data: {
          firstName: i.firstName,
          lastName: i.lastName,
          email,
          phone: i.phone ?? null,
          position: i.position ?? null,
          source: i.source ?? null,
          notes: i.notes ?? null,
          stage: 'APPLIED',
        },
      });
      res.status(201).json(toCandidate(created));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'candidate_email_exists', 'A candidate with this email already exists');
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

recruitingRouter.patch('/candidates/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.candidate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');

    const i = parsed.data;
    const data: Prisma.CandidateUpdateInput = {};
    if (i.firstName !== undefined) data.firstName = i.firstName;
    if (i.lastName !== undefined) data.lastName = i.lastName;
    if (i.phone !== undefined) data.phone = i.phone;
    if (i.position !== undefined) data.position = i.position;
    if (i.source !== undefined) data.source = i.source;
    if (i.notes !== undefined) data.notes = i.notes;

    const updated = await prisma.candidate.update({
      where: { id: existing.id },
      data,
    });
    res.json(toCandidate(updated));
  } catch (err) {
    next(err);
  }
});

recruitingRouter.post('/candidates/:id/advance', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateAdvanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.candidate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
    if (existing.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Cannot change stage of a HIRED candidate');
    }

    const i = parsed.data;
    const updated = await prisma.candidate.update({
      where: { id: existing.id },
      data: {
        stage: i.stage,
        ...(i.rejectedReason !== undefined ? { rejectedReason: i.rejectedReason } : {}),
        ...(i.withdrawnReason !== undefined ? { withdrawnReason: i.withdrawnReason } : {}),
      },
    });
    res.json(toCandidate(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Convert a candidate to an Associate. Optionally creates an Application
 * for the given clientId + template — completing the recruiting →
 * onboarding handoff that's been the missing link until this phase.
 */
recruitingRouter.post('/candidates/:id/hire', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateHireInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { clientId, templateId } = parsed.data;

    const candidate = await prisma.candidate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!candidate) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
    if (candidate.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Candidate already hired');
    }
    if (candidate.stage === 'REJECTED' || candidate.stage === 'WITHDRAWN') {
      throw new HttpError(409, 'invalid_stage', 'Cannot hire a rejected/withdrawn candidate');
    }

    const result = await prisma.$transaction(async (tx) => {
      // Reuse an existing Associate by email if one exists.
      let associate = await tx.associate.findUnique({ where: { email: candidate.email } });
      if (!associate) {
        associate = await tx.associate.create({
          data: {
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            email: candidate.email,
            phone: candidate.phone,
          },
        });
      }

      let applicationId: string | null = null;
      if (clientId && templateId) {
        const [client, template] = await Promise.all([
          tx.client.findFirst({ where: { id: clientId, deletedAt: null } }),
          tx.onboardingTemplate.findUnique({
            where: { id: templateId },
            include: { tasks: { orderBy: { order: 'asc' } } },
          }),
        ]);
        if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
        if (!template) throw new HttpError(404, 'template_not_found', 'Template not found');

        const application = await tx.application.create({
          data: {
            associateId: associate.id,
            clientId: client.id,
            onboardingTrack: template.track,
            status: 'DRAFT',
            position: candidate.position,
            checklist: {
              create: {
                tasks: {
                  create: template.tasks.map((t) => ({
                    kind: t.kind,
                    title: t.title,
                    description: t.description,
                    order: t.order,
                  })),
                },
              },
            },
          },
        });
        applicationId = application.id;
      }

      const updated = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          stage: 'HIRED',
          hiredAssociateId: associate.id,
          hiredClientId: clientId ?? null,
          hiredAt: new Date(),
        },
      });

      return { candidate: updated, applicationId, associateId: associate.id };
    }, { timeout: 30_000 });

    res.json({ ...toCandidate(result.candidate), applicationId: result.applicationId });
  } catch (err) {
    next(err);
  }
});

recruitingRouter.delete('/candidates/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.candidate.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
    if (existing.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Cannot delete a HIRED candidate');
    }
    await prisma.candidate.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
