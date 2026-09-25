import { Router } from 'express';
import { Prisma, type CandidateStage } from '@prisma/client';
import {
  CandidateAdvanceInputSchema,
  CandidateCreateInputSchema,
  CandidateEventListResponseSchema,
  CandidateHireInputSchema,
  CandidateListResponseSchema,
  CandidateNoteInputSchema,
  CandidateUpdateInputSchema,
  RecruitingSummarySchema,
  hasCapability,
  type Candidate,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { auditRecruiting, recordCandidateEvent } from '../lib/candidateEvents.js';
import {
  DEFAULT_TIMEZONE,
  addDaysInZone,
  localDateKey,
  zonedWallTimeToUtcInstant,
} from '../lib/timezone.js';
import { inviteOneApplicant } from './onboarding.js';

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
    resumeUrl: row.resumeUrl,
    linkedinUrl: row.linkedinUrl,
    hiredAssociateId: row.hiredAssociateId,
    hiredClientId: row.hiredClientId,
    hiredAt: row.hiredAt ? row.hiredAt.toISOString() : null,
    rejectedReason: row.rejectedReason,
    withdrawnReason: row.withdrawnReason,
    stageChangedAt: row.stageChangedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function findLive(id: string): Promise<RawCandidate> {
  const row = await prisma.candidate.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
  return row;
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

/* ===== The recruiter's dashboard ======================================== */

const OPEN_STAGES: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
/** A week in one stage is where an hourly candidate usually goes cold. */
const STUCK_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

recruitingRouter.get('/summary', async (_req, res, next) => {
  try {
    const now = new Date();
    const tz = DEFAULT_TIMEZONE;
    const [y, m, d] = localDateKey(now, tz).split('-').map(Number) as [number, number, number];
    const startOfToday = zonedWallTimeToUtcInstant(y, m, d, 0, tz);
    const startOfTomorrow = addDaysInZone(startOfToday, 1, tz);
    const startOfMonth = zonedWallTimeToUtcInstant(y, m, 1, 0, tz);
    const liveCandidate = { candidate: { deletedAt: null } };

    const [open, today, next7, unscored, offersAwaitingReply, hires] = await Promise.all([
      prisma.candidate.findMany({
        where: { deletedAt: null, stage: { in: OPEN_STAGES } },
        select: { id: true, firstName: true, lastName: true, position: true, stage: true, stageChangedAt: true },
        orderBy: { stageChangedAt: 'asc' },
      }),
      prisma.interview.findMany({
        where: { ...liveCandidate, scheduledFor: { gte: startOfToday, lt: startOfTomorrow } },
        include: { candidate: { select: { firstName: true, lastName: true } } },
        orderBy: { scheduledFor: 'asc' },
        take: 20,
      }),
      prisma.interview.count({
        where: { ...liveCandidate, completedAt: null, scheduledFor: { gte: now, lt: new Date(now.getTime() + 7 * DAY_MS) } },
      }),
      prisma.interview.count({ where: { ...liveCandidate, completedAt: null, scheduledFor: { lt: now } } }),
      prisma.offer.count({ where: { status: 'SENT', candidate: { deletedAt: null } } }),
      prisma.candidate.findMany({
        where: { deletedAt: null, stage: 'HIRED', hiredAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
        select: { createdAt: true, hiredAt: true },
      }),
    ]);

    const daysIn = (at: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
    const byStage = { APPLIED: 0, SCREENING: 0, INTERVIEW: 0, OFFER: 0 };
    for (const c of open) byStage[c.stage as keyof typeof byStage] += 1;
    const stuck = open.filter((c) => daysIn(c.stageChangedAt) >= STUCK_AFTER_DAYS);

    const daysToHire = hires
      .map((h) => (h.hiredAt!.getTime() - h.createdAt.getTime()) / DAY_MS)
      .sort((a, b) => a - b);
    const mid = Math.floor(daysToHire.length / 2);
    const medianDaysToHire =
      daysToHire.length === 0
        ? null
        : Math.round(
            (daysToHire.length % 2 ? daysToHire[mid]! : (daysToHire[mid - 1]! + daysToHire[mid]!) / 2) * 10,
          ) / 10;

    res.json(
      RecruitingSummarySchema.parse({
        byStage,
        stuckAfterDays: STUCK_AFTER_DAYS,
        stuckCount: stuck.length,
        stuck: stuck.slice(0, 5).map((c) => ({
          id: c.id,
          name: `${c.firstName} ${c.lastName}`,
          position: c.position,
          stage: c.stage,
          daysInStage: daysIn(c.stageChangedAt),
        })),
        interviewsToday: today.map((i) => ({
          id: i.id,
          candidateId: i.candidateId,
          candidateName: `${i.candidate.firstName} ${i.candidate.lastName}`,
          scheduledFor: i.scheduledFor.toISOString(),
        })),
        interviewsNext7Days: next7,
        unscoredInterviews: unscored,
        offersAwaitingReply,
        hiredThisMonth: hires.filter((h) => h.hiredAt! >= startOfMonth).length,
        medianDaysToHire,
      }),
    );
  } catch (err) {
    next(err);
  }
});

recruitingRouter.get('/candidates/:id', async (req, res, next) => {
  try {
    res.json(toCandidate(await findLive(req.params.id)));
  } catch (err) {
    next(err);
  }
});

/* ===== The timeline ===================================================== */

recruitingRouter.get('/candidates/:id/events', async (req, res, next) => {
  try {
    const candidate = await findLive(req.params.id);
    const rows = await prisma.candidateEvent.findMany({
      where: { candidateId: candidate.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        actor: {
          select: { email: true, associate: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    res.json(
      CandidateEventListResponseSchema.parse({
        events: rows.map((e) => ({
          id: e.id,
          kind: e.kind,
          fromStage: e.fromStage,
          toStage: e.toStage,
          body: e.body,
          actorName: e.actor
            ? e.actor.associate
              ? `${e.actor.associate.firstName} ${e.actor.associate.lastName}`
              : e.actor.email
            : null,
          createdAt: e.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

recruitingRouter.post('/candidates/:id/notes', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateNoteInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const candidate = await findLive(req.params.id);
    await recordCandidateEvent(prisma, {
      candidateId: candidate.id,
      kind: 'NOTE',
      actorUserId: req.user!.id,
      body: parsed.data.body,
    });
    auditRecruiting(req, 'note_added', 'Candidate', candidate.id);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ===== Writes ============================================================ */

recruitingRouter.post('/candidates', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;
    const email = i.email.trim().toLowerCase();

    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.candidate.create({
          data: {
            firstName: i.firstName,
            lastName: i.lastName,
            email,
            phone: i.phone ?? null,
            position: i.position ?? null,
            source: i.source ?? null,
            notes: i.notes ?? null,
            resumeUrl: i.resumeUrl ?? null,
            linkedinUrl: i.linkedinUrl ?? null,
            stage: 'APPLIED',
          },
        });
        await recordCandidateEvent(tx, {
          candidateId: row.id,
          kind: 'CREATED',
          actorUserId: req.user!.id,
          toStage: 'APPLIED',
          body: row.source,
        });
        return row;
      });
      auditRecruiting(req, 'candidate_created', 'Candidate', created.id, { source: created.source });
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

const EDITABLE = ['firstName', 'lastName', 'phone', 'position', 'source', 'notes'] as const;
const FIELD_LABEL: Record<(typeof EDITABLE)[number], string> = {
  firstName: 'first name',
  lastName: 'last name',
  phone: 'phone',
  position: 'position',
  source: 'source',
  notes: 'notes',
};

recruitingRouter.patch('/candidates/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await findLive(req.params.id);

    const i = parsed.data;
    const data: Prisma.CandidateUpdateInput = {};
    const changed: (typeof EDITABLE)[number][] = [];
    for (const f of EDITABLE) {
      if (i[f] === undefined || i[f] === existing[f]) continue;
      (data as Record<string, unknown>)[f] = i[f];
      changed.push(f);
    }
    if (changed.length === 0) {
      res.json(toCandidate(existing));
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({ where: { id: existing.id }, data });
      await recordCandidateEvent(tx, {
        candidateId: row.id,
        kind: 'EDITED',
        actorUserId: req.user!.id,
        body: `Updated ${changed.map((f) => FIELD_LABEL[f]).join(', ')}`,
        metadata: { fields: changed },
      });
      return row;
    });
    auditRecruiting(req, 'candidate_updated', 'Candidate', updated.id, { fields: changed });
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
    const existing = await findLive(req.params.id);
    if (existing.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Cannot change stage of a HIRED candidate');
    }

    const i = parsed.data;
    const moved = i.stage !== existing.stage;
    const reason = i.rejectedReason ?? i.withdrawnReason ?? null;
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.candidate.update({
        where: { id: existing.id },
        data: {
          stage: i.stage,
          // Only a real move restarts the clock — re-saving a reason on the
          // same stage must not make a stuck candidate look fresh.
          ...(moved ? { stageChangedAt: new Date() } : {}),
          ...(i.rejectedReason !== undefined ? { rejectedReason: i.rejectedReason } : {}),
          ...(i.withdrawnReason !== undefined ? { withdrawnReason: i.withdrawnReason } : {}),
        },
      });
      if (moved) {
        await recordCandidateEvent(tx, {
          candidateId: row.id,
          kind: 'STAGE_CHANGED',
          actorUserId: req.user!.id,
          fromStage: existing.stage,
          toStage: i.stage,
          body: reason,
        });
      }
      return row;
    });
    if (moved) {
      auditRecruiting(req, 'stage_changed', 'Candidate', updated.id, {
        from: existing.stage,
        to: i.stage,
        ...(reason ? { reason } : {}),
      });
    }
    res.json(toCandidate(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * Hire = invite to onboarding.
 *
 * This used to create a bare Associate and, only if the caller happened to
 * send a client and template (the UI never did), a DRAFT application with
 * no invite, no user, no site and no start date. HR then re-typed the
 * candidate into the New Application dialog. Now it runs the same invite
 * the onboarding team uses — associate, invited user, checklist, token,
 * email — from the candidate's own details, and closes the candidate out.
 *
 * The accepted offer's pay becomes their starting rate, when the person
 * hiring may set pay at all (manage:comp). Without it the hire still goes
 * through and the response says the rate wasn't recorded.
 */
recruitingRouter.post('/candidates/:id/hire', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateHireInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;

    const candidate = await findLive(req.params.id);
    if (candidate.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Candidate already hired');
    }
    if (candidate.stage === 'REJECTED' || candidate.stage === 'WITHDRAWN') {
      throw new HttpError(409, 'invalid_stage', 'Cannot hire a rejected/withdrawn candidate');
    }

    const offer = input.offerId
      ? await prisma.offer.findFirst({ where: { id: input.offerId, candidateId: candidate.id } })
      : null;
    if (input.offerId && !offer) throw new HttpError(404, 'offer_not_found', 'Offer not found');
    if (offer && offer.status !== 'ACCEPTED') {
      throw new HttpError(409, 'offer_not_accepted', 'Only an accepted offer can set their starting pay.');
    }

    const invite = await inviteOneApplicant(req.user!.id, req, {
      associateFirstName: candidate.firstName,
      associateLastName: candidate.lastName,
      associateEmail: candidate.email,
      clientId: input.clientId,
      templateId: input.templateId,
      ...(input.locationId ? { locationId: input.locationId } : {}),
      ...(input.position ? { position: input.position } : {}),
      ...(input.startDate ? { startDate: input.startDate } : {}),
      ...(input.employmentType ? { employmentType: input.employmentType } : {}),
      ...(input.hireRole ? { hireRole: input.hireRole } : {}),
    });

    const pay =
      offer && (offer.hourlyRate ?? offer.salary)
        ? {
            payType: offer.hourlyRate ? ('HOURLY' as const) : ('SALARY' as const),
            amount: (offer.hourlyRate ?? offer.salary)!,
          }
        : null;
    const payRecorded = pay !== null && hasCapability(req.user!.role, 'manage:comp');
    const effectiveFrom = input.startDate
      ? new Date(input.startDate)
      : (offer?.startDate ?? new Date());

    const hired = await prisma.$transaction(async (tx) => {
      // The invite only carries a name and email; the phone the candidate
      // gave is the one number HR already has for them.
      if (candidate.phone) {
        await tx.associate.updateMany({
          where: { id: invite.associateId, phone: null },
          data: { phone: candidate.phone },
        });
      }
      if (payRecorded && pay) {
        await tx.compensationRecord.updateMany({
          where: { associateId: invite.associateId, effectiveTo: null },
          data: { effectiveTo: effectiveFrom },
        });
        await tx.compensationRecord.create({
          data: {
            associateId: invite.associateId,
            effectiveFrom,
            payType: pay.payType,
            amount: pay.amount,
            currency: offer!.currency,
            reason: 'HIRE',
            notes: `From accepted offer: ${offer!.jobTitle}`,
            actorUserId: req.user!.id,
          },
        });
      }
      const row = await tx.candidate.update({
        where: { id: candidate.id },
        data: {
          stage: 'HIRED',
          stageChangedAt: new Date(),
          hiredAssociateId: invite.associateId,
          hiredClientId: input.clientId,
          hiredAt: new Date(),
        },
      });
      await recordCandidateEvent(tx, {
        candidateId: row.id,
        kind: 'HIRED',
        actorUserId: req.user!.id,
        fromStage: candidate.stage,
        toStage: 'HIRED',
        body: 'Invited to onboarding',
        metadata: { applicationId: invite.applicationId, clientId: input.clientId, offerId: offer?.id ?? null, payRecorded },
      });
      return row;
    }, { timeout: 30_000 });

    auditRecruiting(req, 'candidate_hired', 'Candidate', hired.id, {
      applicationId: invite.applicationId,
      associateId: invite.associateId,
      clientId: input.clientId,
      offerId: offer?.id ?? null,
      payRecorded,
    });
    res.json({
      ...toCandidate(hired),
      applicationId: invite.applicationId,
      inviteUrl: invite.inviteUrl,
      payRecorded,
    });
  } catch (err) {
    next(err);
  }
});

recruitingRouter.delete('/candidates/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await findLive(req.params.id);
    if (existing.stage === 'HIRED') {
      throw new HttpError(409, 'already_hired', 'Cannot delete a HIRED candidate');
    }
    await prisma.candidate.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    auditRecruiting(req, 'candidate_deleted', 'Candidate', existing.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
