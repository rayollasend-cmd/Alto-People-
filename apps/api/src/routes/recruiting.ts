import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type CandidateStage } from '@prisma/client';
import {
  CandidateAdvanceInputSchema,
  CandidateCreateInputSchema,
  CandidateEventListResponseSchema,
  CandidateHireInputSchema,
  CandidateListResponseSchema,
  CandidateNoteInputSchema,
  CandidateUpdateInputSchema,
  CandidateBoardResponseSchema,
  CandidateFiltersSchema,
  RecruitingAnalyticsSchema,
  RecruitingSourceSpendInputSchema,
  RecruitingSummarySchema,
  hasCapability,
  type Candidate,
  type CandidateFilters,
  type CandidateSort,
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
import { getBlobStore } from '../lib/blobStore.js';
import { notifyUser } from '../lib/notify.js';
import { computeRecruitingAnalytics, sourceKey } from '../lib/recruitingAnalytics.js';

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
    jobPostingId: row.jobPostingId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A posting a candidate can be tied to: one that exists. */
async function assertPosting(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const p = await prisma.jobPosting.findUnique({ where: { id }, select: { id: true } });
  if (!p) throw new HttpError(404, 'posting_not_found', 'That job posting does not exist.');
}

async function findLive(id: string): Promise<RawCandidate> {
  const row = await prisma.candidate.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
  return row;
}

/* ===== Search, paging and the board ====================================== */

const OPEN_STAGES: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
/** A week in one stage is where an hourly candidate usually goes cold. */
const STUCK_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;

const STAGES_ALL: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'WITHDRAWN', 'REJECTED'];
const TERMINAL: ReadonlySet<CandidateStage> = new Set(['HIRED', 'WITHDRAWN', 'REJECTED']);

/**
 * The where-clause for the candidate list's filters. Search is every word
 * against name, email, phone and position — "kim cashier" finds Kim Phan
 * the cashier — case-insensitive.
 */
function candidateWhere(f: CandidateFilters, now = new Date()): Prisma.CandidateWhereInput {
  const and: Prisma.CandidateWhereInput[] = [{ deletedAt: null }];
  const words = (f.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
  for (const w of words) {
    const has = { contains: w, mode: 'insensitive' as const };
    and.push({ OR: [{ firstName: has }, { lastName: has }, { email: has }, { phone: has }, { position: has }] });
  }
  if (f.stage) {
    const stages = f.stage.split(',').filter((s): s is CandidateStage => (STAGES_ALL as string[]).includes(s));
    if (stages.length) and.push({ stage: { in: stages } });
  }
  if (f.source) {
    and.push(
      f.source === 'none'
        ? { OR: [{ source: null }, { source: '' }] }
        : { source: { equals: f.source.trim(), mode: 'insensitive' } },
    );
  }
  if (f.jobPostingId) and.push({ jobPostingId: f.jobPostingId });
  if (f.stuck) {
    and.push({ stage: { in: OPEN_STAGES }, stageChangedAt: { lt: new Date(now.getTime() - STUCK_AFTER_DAYS * DAY_MS) } });
  }
  return { AND: and };
}

function candidateOrder(sort: CandidateSort | undefined): Prisma.CandidateOrderByWithRelationInput[] {
  switch (sort) {
    case 'oldest':
      return [{ createdAt: 'asc' }, { id: 'asc' }];
    case 'name':
      return [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }];
    // Longest in their current stage first — who's going cold.
    case 'waiting':
      return [{ stageChangedAt: 'asc' }, { id: 'asc' }];
    case 'moved':
      return [{ stageChangedAt: 'desc' }, { id: 'asc' }];
    default:
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

function pageParam(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/**
 * GET /recruiting/candidates — filtered, sorted and paged on the server.
 * It used to return the newest 200 and let the page filter those, so
 * past 200 candidates people silently fell off the board and the counts.
 */
recruitingRouter.get('/candidates', async (req, res, next) => {
  try {
    const f = CandidateFiltersSchema.parse(req.query);
    const limit = Math.max(1, pageParam(req.query.limit, 50, 200));
    const offset = pageParam(req.query.offset, 0, 1_000_000);
    const where = candidateWhere(f);
    const [rows, total] = await Promise.all([
      prisma.candidate.findMany({ where, orderBy: candidateOrder(f.sort), skip: offset, take: limit }),
      prisma.candidate.count({ where }),
    ]);
    res.json(CandidateListResponseSchema.parse({ candidates: rows.map(toCandidate), total, offset, limit }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /recruiting/candidates/board — every stage's count under the same
 * filters, and the first page of each column. A column's next page is
 * the list endpoint with `stage=` and an offset. Outcomes (hired,
 * rejected, withdrawn) come most recent first; open stages follow `sort`.
 */
recruitingRouter.get('/candidates/board', async (req, res, next) => {
  try {
    const f = CandidateFiltersSchema.parse(req.query);
    const perStage = Math.max(1, pageParam(req.query.perStage, 25, 100));
    const base = candidateWhere({ ...f, stage: undefined });
    const counts = await prisma.candidate.groupBy({ by: ['stage'], where: base, _count: { _all: true } });
    const totalOf = new Map(counts.map((c) => [c.stage, c._count._all]));
    const columns = await Promise.all(
      STAGES_ALL.map(async (stage) => {
        const total = totalOf.get(stage) ?? 0;
        const rows = total
          ? await prisma.candidate.findMany({
              where: { AND: [base, { stage }] },
              orderBy: TERMINAL.has(stage) ? [{ stageChangedAt: 'desc' }, { id: 'asc' }] : candidateOrder(f.sort),
              take: perStage,
            })
          : [];
        return { stage, total, candidates: rows.map(toCandidate) };
      }),
    );
    res.json(CandidateBoardResponseSchema.parse({ columns }));
  } catch (err) {
    next(err);
  }
});

/* ===== The recruiter's dashboard ======================================== */


recruitingRouter.get('/summary', async (_req, res, next) => {
  try {
    const now = new Date();
    const tz = DEFAULT_TIMEZONE;
    const [y, m, d] = localDateKey(now, tz).split('-').map(Number) as [number, number, number];
    const startOfToday = zonedWallTimeToUtcInstant(y, m, d, 0, tz);
    const startOfTomorrow = addDaysInZone(startOfToday, 1, tz);
    const startOfMonth = zonedWallTimeToUtcInstant(y, m, 1, 0, tz);
    const liveCandidate = { candidate: { deletedAt: null } };

    const [open, today, next7, unscored, offersAwaitingReply, offersAwaitingApproval, hires] = await Promise.all([
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
      prisma.offer.count({ where: { status: 'PENDING_APPROVAL', candidate: { deletedAt: null } } }),
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
        offersAwaitingApproval,
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

/* ===== Analytics ========================================================= */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /recruiting/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD — the recruiting
 * dashboard. Both days inclusive, in the org's time zone; defaults to the
 * last 90 days. See lib/recruitingAnalytics for what each number means.
 */
recruitingRouter.get('/analytics', async (req, res, next) => {
  try {
    const tz = DEFAULT_TIMEZONE;
    const today = localDateKey(new Date(), tz);
    const toKey = typeof req.query.to === 'string' && YMD.test(req.query.to) ? req.query.to : today;
    const [ty, tm, td] = toKey.split('-').map(Number) as [number, number, number];
    const to = addDaysInZone(zonedWallTimeToUtcInstant(ty, tm, td, 0, tz), 1, tz);
    const fromKey =
      typeof req.query.from === 'string' && YMD.test(req.query.from)
        ? req.query.from
        : localDateKey(addDaysInZone(to, -90, tz), tz);
    const [fy, fm, fd] = fromKey.split('-').map(Number) as [number, number, number];
    const from = zonedWallTimeToUtcInstant(fy, fm, fd, 0, tz);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new HttpError(400, 'invalid_range', 'The range must start on or before the day it ends.');
    }
    if (to.getTime() - from.getTime() > 731 * DAY_MS) {
      throw new HttpError(400, 'range_too_long', 'Pick two years or less.');
    }
    const body = await computeRecruitingAnalytics({ from, to, fromKey, toKey });
    res.json(RecruitingAnalyticsSchema.parse(body));
  } catch (err) {
    next(err);
  }
});

/**
 * What each source cost, month by month — job-board fees, sponsored posts,
 * agency invoices, referral bonuses. Cost per hire by source divides this
 * by the hires that source brought in.
 */
recruitingRouter.get('/source-spend', async (_req, res, next) => {
  try {
    const rows = await prisma.recruitingSourceSpend.findMany({
      orderBy: [{ month: 'desc' }, { source: 'asc' }],
      take: 500,
      include: { updatedBy: { select: { email: true } } },
    });
    res.json({
      spend: rows.map((r) => ({
        id: r.id,
        source: r.source,
        month: r.month.toISOString().slice(0, 7),
        amount: Number(r.amount),
        note: r.note,
        updatedByEmail: r.updatedBy?.email ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** One amount per source per month: saving the same month again replaces it. */
recruitingRouter.put('/source-spend', MANAGE, async (req, res, next) => {
  try {
    const input = RecruitingSourceSpendInputSchema.parse(req.body);
    const source = sourceKey(input.source)!;
    const month = new Date(`${input.month}-01T00:00:00.000Z`);
    const row = await prisma.recruitingSourceSpend.upsert({
      where: { source_month: { source, month } },
      create: { source, month, amount: input.amount, note: input.note || null, updatedById: req.user!.id },
      update: { amount: input.amount, note: input.note || null, updatedById: req.user!.id },
    });
    auditRecruiting(req, 'source_spend_saved', 'RecruitingSourceSpend', row.id, {
      source,
      month: input.month,
      amount: input.amount,
    });
    res.json({ id: row.id });
  } catch (err) {
    next(err);
  }
});

recruitingRouter.delete('/source-spend/:id', MANAGE, async (req, res, next) => {
  try {
    const row = await prisma.recruitingSourceSpend.findUnique({ where: { id: req.params.id } });
    if (!row) throw new HttpError(404, 'not_found', 'Not found');
    await prisma.recruitingSourceSpend.delete({ where: { id: row.id } });
    auditRecruiting(req, 'source_spend_deleted', 'RecruitingSourceSpend', row.id, {
      source: row.source,
      month: row.month.toISOString().slice(0, 7),
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Client review ===================================================== */

/**
 * Put a candidate in front of a client — optionally for one store — with
 * a pitch, for the client to approve or pass on from their portal. This
 * used to happen by phone, and nothing of it reached the candidate's
 * record. The client sees the name, the position, the pitch and Alto's
 * interview recommendations — never the candidate's contact details.
 */
const SubmitInputSchema = z.object({
  clientId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  pitch: z.string().trim().max(2000).optional(),
});

function submittalView(s: Prisma.CandidateSubmittalGetPayload<{
  include: {
    client: { select: { name: true } };
    location: { select: { name: true } };
    submittedBy: { select: { email: true } };
    decidedBy: { select: { email: true } };
  };
}>) {
  return {
    id: s.id,
    clientId: s.clientId,
    clientName: s.client.name,
    locationName: s.location?.name ?? null,
    pitch: s.pitch,
    status: s.status,
    feedback: s.feedback,
    submittedByEmail: s.submittedBy?.email ?? null,
    decidedByEmail: s.decidedBy?.email ?? null,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

const SUBMITTAL_INCLUDE = {
  client: { select: { name: true } },
  location: { select: { name: true } },
  submittedBy: { select: { email: true } },
  decidedBy: { select: { email: true } },
} as const;

recruitingRouter.get('/candidates/:id/submittals', async (req, res, next) => {
  try {
    const candidate = await findLive(req.params.id);
    const rows = await prisma.candidateSubmittal.findMany({
      where: { candidateId: candidate.id },
      include: SUBMITTAL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    res.json({ submittals: rows.map(submittalView) });
  } catch (err) {
    next(err);
  }
});

recruitingRouter.post('/candidates/:id/submittals', MANAGE, async (req, res, next) => {
  try {
    const input = SubmitInputSchema.parse(req.body);
    const candidate = await findLive(req.params.id);
    if (candidate.stage === 'HIRED' || candidate.stage === 'REJECTED' || candidate.stage === 'WITHDRAWN') {
      throw new HttpError(409, 'invalid_stage', 'Only a candidate still in the pipeline can be put forward.');
    }
    const client = await prisma.client.findFirst({ where: { id: input.clientId, deletedAt: null }, select: { id: true, name: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    if (input.locationId) {
      const loc = await prisma.location.findFirst({ where: { id: input.locationId, clientId: client.id, deletedAt: null } });
      if (!loc) throw new HttpError(404, 'location_not_found', 'That store is not one of this client’s.');
    }
    const waiting = await prisma.candidateSubmittal.findFirst({
      where: { candidateId: candidate.id, clientId: client.id, status: 'PENDING' },
    });
    if (waiting) throw new HttpError(409, 'already_submitted', `${client.name} already has ${candidate.firstName} to review.`);

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.candidateSubmittal.create({
        data: {
          candidateId: candidate.id,
          clientId: client.id,
          locationId: input.locationId ?? null,
          pitch: input.pitch || null,
          submittedById: req.user!.id,
        },
        include: SUBMITTAL_INCLUDE,
      });
      await recordCandidateEvent(tx, {
        candidateId: candidate.id,
        kind: 'SUBMITTED_TO_CLIENT',
        actorUserId: req.user!.id,
        body: row.location ? `${client.name} · ${row.location.name}` : client.name,
        metadata: { submittalId: row.id },
      });
      return row;
    });
    auditRecruiting(req, 'submitted_to_client', 'CandidateSubmittal', created.id, {
      candidateId: candidate.id,
      clientId: client.id,
    });
    // The client's people who'd make the call: their whole-client accounts,
    // and the store's own when it's for one store.
    const reviewers = await prisma.user.findMany({
      where: {
        role: 'CLIENT_PORTAL',
        clientId: client.id,
        status: 'ACTIVE',
        deletedAt: null,
        ...(input.locationId ? { OR: [{ locationId: null }, { locationId: input.locationId }] } : {}),
      },
      select: { id: true },
    });
    for (const u of reviewers) {
      void notifyUser(u.id, {
        subject: 'A candidate to review',
        body: `${candidate.firstName} ${candidate.lastName}${candidate.position ? ` (${candidate.position})` : ''} — approve or pass in your portal.`,
        category: 'recruiting',
        linkUrl: '/portal/candidates',
      }).catch(() => undefined);
    }
    res.status(201).json(submittalView(created));
  } catch (err) {
    next(err);
  }
});

recruitingRouter.post('/submittals/:id/withdraw', MANAGE, async (req, res, next) => {
  try {
    const s = await prisma.candidateSubmittal.findUnique({ where: { id: req.params.id } });
    if (!s) throw new HttpError(404, 'not_found', 'Not found');
    if (s.status !== 'PENDING') throw new HttpError(409, 'invalid_state', 'The client has already answered.');
    await prisma.candidateSubmittal.update({ where: { id: s.id }, data: { status: 'WITHDRAWN' } });
    auditRecruiting(req, 'submittal_withdrawn', 'CandidateSubmittal', s.id, { candidateId: s.candidateId });
    res.json({ ok: true });
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
    await assertPosting(i.jobPostingId);

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
            jobPostingId: i.jobPostingId ?? null,
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

const EDITABLE = ['firstName', 'lastName', 'phone', 'position', 'source', 'notes', 'jobPostingId'] as const;
const FIELD_LABEL: Record<(typeof EDITABLE)[number], string> = {
  firstName: 'first name',
  lastName: 'last name',
  phone: 'phone',
  position: 'position',
  source: 'source',
  notes: 'notes',
  jobPostingId: 'job posting',
};

recruitingRouter.patch('/candidates/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = CandidateUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await findLive(req.params.id);

    const i = parsed.data;
    await assertPosting(i.jobPostingId);
    const data: Prisma.CandidateUncheckedUpdateInput = {};
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
    // The letter they signed goes in their file with the rest of their
    // hiring paperwork.
    const signedLetter = offer?.signedPdfKey ? await getBlobStore().get(offer.signedPdfKey) : null;
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
      if (signedLetter && offer?.signedPdfKey) {
        await tx.documentRecord.create({
          data: {
            associateId: invite.associateId,
            clientId: input.clientId,
            kind: 'OFFER_LETTER',
            s3Key: offer.signedPdfKey,
            filename: `offer-letter-${offer.jobTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-signed.pdf`,
            mimeType: 'application/pdf',
            size: signedLetter.byteLength,
            // Signed by the candidate through their own link, and hashed.
            status: 'VERIFIED',
            verifiedById: req.user!.id,
            verifiedAt: new Date(),
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
