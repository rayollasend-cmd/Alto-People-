import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CareersApplyInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { send } from '../lib/notifications.js';
import { auditRecruiting, recordCandidateEvent } from '../lib/candidateEvents.js';
import {
  careersApplyEmailLimiter,
  careersApplyIpLimiter,
} from '../middleware/rateLimit.js';

/**
 * Phase 90 — Recruiting extras: interview kits + scheduled interviews,
 * offer letters, employee referrals, public careers page.
 *
 * The careers endpoint (/careers, /careers/:slug, /careers/:slug/apply)
 * is intentionally PUBLIC — anyone can browse open postings and submit
 * an application without authentication. Apply creates a Candidate row
 * tied to the posting via `position`.
 */

export const recruiting90Router = Router();

const VIEW = requireCapability('view:recruiting');
const MANAGE = requireCapability('manage:recruiting');

// ----- Interview Kits ----------------------------------------------------

const InterviewKitInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1),
        kind: z.enum(['BEHAVIORAL', 'TECHNICAL', 'CULTURAL', 'GENERAL']).optional(),
        hint: z.string().optional().nullable(),
      }),
    )
    .default([]),
});

recruiting90Router.get('/interview-kits', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.interviewKit.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : {}),
    },
    orderBy: { name: 'asc' },
  });
  res.json({
    kits: rows.map((k) => ({
      id: k.id,
      clientId: k.clientId,
      name: k.name,
      description: k.description,
      questions: k.questions,
      updatedAt: k.updatedAt.toISOString(),
    })),
  });
});

recruiting90Router.post('/interview-kits', MANAGE, async (req, res) => {
  const input = InterviewKitInputSchema.parse(req.body);
  const created = await prisma.interviewKit.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      description: input.description ?? null,
      questions: input.questions as Prisma.InputJsonValue,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

recruiting90Router.put('/interview-kits/:id', MANAGE, async (req, res) => {
  const input = InterviewKitInputSchema.parse(req.body);
  await prisma.interviewKit.update({
    where: { id: req.params.id },
    data: {
      // Absent means "leave the client scope alone" — the web's update
      // payload doesn't carry clientId, so `?? null` was silently
      // detaching a client-scoped kit on every edit. Explicit null still
      // clears.
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      name: input.name,
      description: input.description ?? null,
      questions: input.questions as Prisma.InputJsonValue,
    },
  });
  res.json({ ok: true });
});

recruiting90Router.delete('/interview-kits/:id', MANAGE, async (req, res) => {
  await prisma.interviewKit.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Interviews --------------------------------------------------------

const InterviewInputSchema = z.object({
  candidateId: z.string().uuid(),
  kitId: z.string().uuid().nullable().optional(),
  interviewerUserId: z.string().uuid().nullable().optional(),
  scheduledFor: z.string().datetime(),
});

const InterviewScoreSchema = z.object({
  scorecard: z.unknown(),
  rating: z.number().int().min(-2).max(2).nullable().optional(),
});

/** The -2..2 recommendation scale, as the timeline says it. */
const RATING_LABEL: Record<number, string> = {
  [-2]: 'Strong no',
  [-1]: 'No',
  0: 'Neutral',
  1: 'Yes',
  2: 'Strong yes',
};

/**
 * Interview events carry the instant, not a formatted time. The server's
 * zone (Eastern) is not every reader's — a 10:00 interview booked from a
 * Central-time store read "11:00 AM" on its own timeline — so the viewer's
 * screen formats it.
 */
const when = (d: Date) => d.toISOString();

recruiting90Router.get('/interviews', VIEW, async (req, res) => {
  const candidateId = z.string().uuid().optional().parse(req.query.candidateId);
  const rows = await prisma.interview.findMany({
    where: { ...(candidateId ? { candidateId } : {}) },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true } },
      kit: { select: { id: true, name: true } },
      interviewer: { select: { id: true, email: true } },
    },
    orderBy: { scheduledFor: 'desc' },
    take: 200,
  });
  res.json({
    interviews: rows.map((i) => ({
      id: i.id,
      candidateId: i.candidateId,
      candidateName: `${i.candidate.firstName} ${i.candidate.lastName}`,
      kitId: i.kitId,
      kitName: i.kit?.name ?? null,
      interviewerUserId: i.interviewerUserId,
      interviewerEmail: i.interviewer?.email ?? null,
      scheduledFor: i.scheduledFor.toISOString(),
      completedAt: i.completedAt?.toISOString() ?? null,
      rating: i.rating,
      scorecard: i.scorecard,
    })),
  });
});

recruiting90Router.post('/interviews', MANAGE, async (req, res) => {
  const input = InterviewInputSchema.parse(req.body);
  const candidate = await prisma.candidate.findFirst({
    where: { id: input.candidateId, deletedAt: null },
  });
  if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found.');
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.interview.create({
      data: {
        candidateId: input.candidateId,
        kitId: input.kitId ?? null,
        interviewerUserId: input.interviewerUserId ?? null,
        scheduledFor: new Date(input.scheduledFor),
      },
    });
    await recordCandidateEvent(tx, {
      candidateId: row.candidateId,
      kind: 'INTERVIEW_SCHEDULED',
      actorUserId: req.user!.id,
      body: when(row.scheduledFor),
      metadata: { interviewId: row.id },
    });
    return row;
  });
  auditRecruiting(req, 'interview_scheduled', 'Interview', created.id, {
    candidateId: created.candidateId,
    scheduledFor: created.scheduledFor.toISOString(),
  });
  res.status(201).json({ id: created.id });
});

recruiting90Router.post('/interviews/:id/score', MANAGE, async (req, res) => {
  const input = InterviewScoreSchema.parse(req.body);
  const existing = await prisma.interview.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'not_found', 'Interview not found.');
  const rating = input.rating ?? null;
  await prisma.$transaction(async (tx) => {
    await tx.interview.update({
      where: { id: existing.id },
      data: {
        scorecard: (input.scorecard ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        rating,
        completedAt: new Date(),
      },
    });
    await recordCandidateEvent(tx, {
      candidateId: existing.candidateId,
      kind: 'INTERVIEW_SCORED',
      actorUserId: req.user!.id,
      body: rating === null ? 'Scored, no recommendation' : `Recommendation: ${RATING_LABEL[rating]}`,
      metadata: { interviewId: existing.id, rating },
    });
  });
  auditRecruiting(req, 'interview_scored', 'Interview', existing.id, {
    candidateId: existing.candidateId,
    rating,
  });
  res.json({ ok: true });
});

recruiting90Router.delete('/interviews/:id', MANAGE, async (req, res) => {
  const existing = await prisma.interview.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new HttpError(404, 'not_found', 'Interview not found.');
  await prisma.$transaction(async (tx) => {
    await tx.interview.delete({ where: { id: existing.id } });
    await recordCandidateEvent(tx, {
      candidateId: existing.candidateId,
      kind: 'INTERVIEW_CANCELLED',
      actorUserId: req.user!.id,
      body: when(existing.scheduledFor),
    });
  });
  auditRecruiting(req, 'interview_cancelled', 'Interview', existing.id, {
    candidateId: existing.candidateId,
  });
  res.status(204).end();
});

// ----- Offers ------------------------------------------------------------

const OfferInputSchema = z
  .object({
    candidateId: z.string().uuid(),
    clientId: z.string().uuid(),
    jobTitle: z.string().min(1).max(200),
    startDate: z.string(),
    salary: z.number().nonnegative().optional().nullable(),
    hourlyRate: z.number().nonnegative().optional().nullable(),
    currency: z.string().length(3).optional(),
    letterBody: z.string().max(200000).optional().nullable(),
    templateRenderId: z.string().uuid().optional().nullable(),
    expiresAt: z.string().datetime().optional().nullable(),
  })
  .refine((v) => v.salary != null || v.hourlyRate != null, {
    message: 'Either salary or hourlyRate must be provided.',
  });

recruiting90Router.get('/offers', VIEW, async (req, res) => {
  const candidateId = z.string().uuid().optional().parse(req.query.candidateId);
  const status = z
    .enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.offer.findMany({
    where: {
      ...(candidateId ? { candidateId } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    offers: rows.map((o) => ({
      id: o.id,
      candidateId: o.candidateId,
      candidateName: `${o.candidate.firstName} ${o.candidate.lastName}`,
      clientId: o.clientId,
      clientName: o.client.name,
      jobTitle: o.jobTitle,
      startDate: o.startDate.toISOString().slice(0, 10),
      salary: o.salary?.toString() ?? null,
      hourlyRate: o.hourlyRate?.toString() ?? null,
      currency: o.currency,
      letterBody: o.letterBody,
      status: o.status,
      sentAt: o.sentAt?.toISOString() ?? null,
      decidedAt: o.decidedAt?.toISOString() ?? null,
      expiresAt: o.expiresAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
    })),
  });
});

recruiting90Router.post('/offers', MANAGE, async (req, res) => {
  const input = OfferInputSchema.parse(req.body);
  const candidate = await prisma.candidate.findFirst({
    where: { id: input.candidateId, deletedAt: null },
  });
  if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found.');
  const created = await prisma.offer.create({
    data: {
      candidateId: input.candidateId,
      clientId: input.clientId,
      jobTitle: input.jobTitle,
      startDate: new Date(input.startDate),
      salary: input.salary ?? null,
      hourlyRate: input.hourlyRate ?? null,
      currency: input.currency ?? 'USD',
      letterBody: input.letterBody ?? null,
      templateRenderId: input.templateRenderId ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: req.user!.id,
      status: 'DRAFT',
    },
    include: { client: { select: { name: true } } },
  });
  await recordCandidateEvent(prisma, {
    candidateId: created.candidateId,
    kind: 'OFFER_CREATED',
    actorUserId: req.user!.id,
    body: `${created.jobTitle} · ${created.client.name}`,
    metadata: { offerId: created.id },
  });
  auditRecruiting(req, 'offer_created', 'Offer', created.id, { candidateId: created.candidateId });
  res.status(201).json({ id: created.id });
});

recruiting90Router.post('/offers/:id/send', MANAGE, async (req, res) => {
  const o = await prisma.offer.findUnique({
    where: { id: req.params.id },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status !== 'DRAFT') {
    throw new HttpError(409, 'invalid_state', `Cannot send offer in ${o.status} state.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_SENT',
      actorUserId: req.user!.id,
      body: o.jobTitle,
      metadata: { offerId: o.id },
    });
  });
  auditRecruiting(req, 'offer_sent', 'Offer', o.id, { candidateId: o.candidateId });

  // Actually email the candidate the offer. Candidates are usually not
  // Users yet, so this is a raw email — fire-and-forget after the write.
  // If there is no reachable email, the flip still happened; the `emailed`
  // flag lets the UI toast "Marked sent — no candidate email on file."
  const candidateEmail = o.candidate.email?.trim() || null;
  if (candidateEmail) {
    const pay =
      o.salary != null
        ? `${o.currency} ${o.salary.toString()} per year`
        : o.hourlyRate != null
          ? `${o.currency} ${o.hourlyRate.toString()} per hour`
          : 'to be discussed';
    void send({
      channel: 'EMAIL',
      category: 'offer_letter',
      recipient: { userId: null, phone: null, email: candidateEmail },
      subject: 'Your offer from Alto People',
      body: [
        `Hi ${o.candidate.firstName},`,
        '',
        `We are pleased to extend you an offer for the position of ${o.jobTitle}.`,
        '',
        `Start date: ${o.startDate.toISOString().slice(0, 10)}`,
        `Compensation: ${pay}`,
        ...(o.letterBody ? ['', o.letterBody] : []),
        '',
        'Please reply to this email with any questions.',
      ].join('\n'),
    }).catch(() => {
      /* fire-and-forget — the offer is already SENT */
    });
  }
  res.json({ ok: true, emailed: candidateEmail !== null });
});

recruiting90Router.post('/offers/:id/decision', MANAGE, async (req, res) => {
  const decision = z
    .enum(['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'])
    .parse(req.body?.decision);
  const o = await prisma.offer.findUnique({ where: { id: req.params.id } });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status !== 'SENT' && o.status !== 'DRAFT') {
    throw new HttpError(409, 'invalid_state', `Offer already ${o.status}.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: decision, decidedAt: new Date() },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_DECIDED',
      actorUserId: req.user!.id,
      body: `${decision.charAt(0)}${decision.slice(1).toLowerCase()}: ${o.jobTitle}`,
      metadata: { offerId: o.id, decision },
    });
  });
  auditRecruiting(req, 'offer_decided', 'Offer', o.id, { candidateId: o.candidateId, decision });
  res.json({ ok: true });
});

// ----- Referrals ---------------------------------------------------------

const ReferralInputSchema = z.object({
  candidateName: z.string().min(1).max(200),
  candidateEmail: z.string().email(),
  candidatePhone: z.string().max(40).optional().nullable(),
  position: z.string().max(200).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  bonusAmount: z.number().nonnegative().optional().nullable(),
  bonusCurrency: z.string().length(3).optional(),
});

recruiting90Router.get('/referrals', VIEW, async (req, res) => {
  // Associates see their own; HR/Ops see all.
  const isManager = req.user!.role !== 'ASSOCIATE' && req.user!.role !== 'CLIENT_PORTAL';
  const where: Prisma.ReferralWhereInput = isManager
    ? {}
    : { referrerUserId: req.user!.id };
  const rows = await prisma.referral.findMany({
    where,
    include: {
      referrer: { select: { id: true, email: true } },
      candidate: { select: { id: true, stage: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    referrals: rows.map((r) => ({
      id: r.id,
      referrerUserId: r.referrerUserId,
      referrerEmail: r.referrer.email,
      candidateId: r.candidateId,
      candidateName: r.candidateName,
      candidateEmail: r.candidateEmail,
      candidatePhone: r.candidatePhone,
      position: r.position,
      notes: r.notes,
      status: r.status,
      bonusAmount: r.bonusAmount?.toString() ?? null,
      bonusCurrency: r.bonusCurrency,
      bonusPaidAt: r.bonusPaidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// Explicit requireAuth — this router also serves PUBLIC /careers routes,
// so auth belongs per-handler rather than on the router.
recruiting90Router.post('/referrals', requireAuth, async (req, res) => {
  // Any authenticated user with view:dashboard can submit a referral.
  const input = ReferralInputSchema.parse(req.body);
  const created = await prisma.referral.create({
    data: {
      referrerUserId: req.user!.id,
      candidateName: input.candidateName,
      candidateEmail: input.candidateEmail.toLowerCase(),
      candidatePhone: input.candidatePhone ?? null,
      position: input.position ?? null,
      notes: input.notes ?? null,
      bonusAmount: input.bonusAmount ?? null,
      bonusCurrency: input.bonusCurrency ?? 'USD',
    },
  });
  res.status(201).json({ id: created.id });
});

recruiting90Router.post('/referrals/:id/status', MANAGE, async (req, res) => {
  const status = z
    .enum(['OPEN', 'INTERVIEWING', 'HIRED', 'REJECTED'])
    .parse(req.body?.status);
  await prisma.referral.update({
    where: { id: req.params.id },
    data: { status },
  });
  res.json({ ok: true });
});

recruiting90Router.post('/referrals/:id/bonus-paid', MANAGE, async (req, res) => {
  await prisma.referral.update({
    where: { id: req.params.id },
    data: { bonusPaidAt: new Date() },
  });
  res.json({ ok: true });
});

/**
 * Promote a referral into the recruiting funnel: create a Candidate from
 * the referral's stored contact info (source 'referral') and link it back
 * via referral.candidateId. Idempotent — an already-converted referral
 * returns its existing candidateId, and an existing candidate with the
 * same email is linked rather than duplicated (email is unique).
 */
recruiting90Router.post('/referrals/:id/convert', MANAGE, async (req, res) => {
  const referral = await prisma.referral.findUnique({
    where: { id: req.params.id },
  });
  if (!referral) throw new HttpError(404, 'not_found', 'Referral not found.');
  if (referral.candidateId) {
    res.json({ candidateId: referral.candidateId });
    return;
  }
  const email = referral.candidateEmail.trim().toLowerCase();
  let candidate = await prisma.candidate.findUnique({ where: { email } });
  if (!candidate) {
    const parts = referral.candidateName.trim().split(/\s+/);
    candidate = await prisma.candidate.create({
      data: {
        firstName: parts[0] ?? referral.candidateName,
        lastName: parts.slice(1).join(' '),
        email,
        phone: referral.candidatePhone,
        position: referral.position,
        source: 'referral',
        notes: referral.notes,
        stage: 'APPLIED',
      },
    });
  }
  await prisma.referral.update({
    where: { id: referral.id },
    data: { candidateId: candidate.id },
  });
  res.status(201).json({ candidateId: candidate.id });
});

// ----- Job Postings (admin) ----------------------------------------------

const JobPostingInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(50000),
  location: z.string().max(200).optional().nullable(),
  minSalary: z.number().nonnegative().optional().nullable(),
  maxSalary: z.number().nonnegative().optional().nullable(),
  currency: z.string().length(3).optional(),
  slug: z
    .string()
    .min(2)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase, alphanumeric + hyphens.'),
});

recruiting90Router.get('/job-postings', VIEW, async (_req, res) => {
  const rows = await prisma.jobPosting.findMany({
    where: {},
    include: { client: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    postings: rows.map((p) => ({
      id: p.id,
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
      title: p.title,
      description: p.description,
      location: p.location,
      minSalary: p.minSalary?.toString() ?? null,
      maxSalary: p.maxSalary?.toString() ?? null,
      currency: p.currency,
      slug: p.slug,
      status: p.status,
      openedAt: p.openedAt?.toISOString() ?? null,
      closedAt: p.closedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

recruiting90Router.post('/job-postings', MANAGE, async (req, res) => {
  const input = JobPostingInputSchema.parse(req.body);
  try {
    const created = await prisma.jobPosting.create({
      data: {
        clientId: input.clientId ?? null,
        title: input.title,
        description: input.description,
        location: input.location ?? null,
        minSalary: input.minSalary ?? null,
        maxSalary: input.maxSalary ?? null,
        currency: input.currency ?? 'USD',
        slug: input.slug,
        status: 'DRAFT',
        createdById: req.user!.id,
      },
    });
    auditRecruiting(req, 'posting_created', 'JobPosting', created.id, { slug: created.slug });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, 'slug_taken', 'A posting with that slug already exists.');
    }
    throw err;
  }
});

recruiting90Router.post('/job-postings/:id/open', MANAGE, async (req, res) => {
  await prisma.jobPosting.update({
    where: { id: req.params.id },
    data: { status: 'OPEN', openedAt: new Date(), closedAt: null },
  });
  auditRecruiting(req, 'posting_opened', 'JobPosting', req.params.id);
  res.json({ ok: true });
});

recruiting90Router.post('/job-postings/:id/close', MANAGE, async (req, res) => {
  await prisma.jobPosting.update({
    where: { id: req.params.id },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  auditRecruiting(req, 'posting_closed', 'JobPosting', req.params.id);
  res.json({ ok: true });
});

recruiting90Router.delete('/job-postings/:id', MANAGE, async (req, res) => {
  await prisma.jobPosting.delete({ where: { id: req.params.id } });
  auditRecruiting(req, 'posting_deleted', 'JobPosting', req.params.id);
  res.status(204).end();
});

// ----- Careers (PUBLIC — no auth required) -------------------------------

recruiting90Router.get('/careers', async (_req, res) => {
  const rows = await prisma.jobPosting.findMany({
    where: { status: 'OPEN' },
    include: { client: { select: { name: true } } },
    orderBy: { openedAt: 'desc' },
    take: 100,
  });
  res.json({
    postings: rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      location: p.location,
      clientName: p.client?.name ?? null,
      minSalary: p.minSalary?.toString() ?? null,
      maxSalary: p.maxSalary?.toString() ?? null,
      currency: p.currency,
      openedAt: p.openedAt?.toISOString() ?? null,
    })),
  });
});

recruiting90Router.get('/careers/:slug', async (req, res) => {
  const p = await prisma.jobPosting.findUnique({
    where: { slug: req.params.slug },
    include: { client: { select: { name: true } } },
  });
  if (!p || p.status !== 'OPEN') {
    throw new HttpError(404, 'not_found', 'Posting not found.');
  }
  res.json({
    slug: p.slug,
    title: p.title,
    description: p.description,
    location: p.location,
    clientName: p.client?.name ?? null,
    minSalary: p.minSalary?.toString() ?? null,
    maxSalary: p.maxSalary?.toString() ?? null,
    currency: p.currency,
    openedAt: p.openedAt?.toISOString() ?? null,
  });
});

recruiting90Router.post(
  '/careers/:slug/apply',
  careersApplyIpLimiter,
  careersApplyEmailLimiter,
  async (req, res) => {
    const input = CareersApplyInputSchema.parse(req.body);

    // Honeypot: bots auto-fill every input. Real users never see this
    // field. Returning a 201-shaped success keeps the bot from realizing
    // it was caught — but we never persist anything.
    if (input.website && input.website.trim().length > 0) {
      res.status(201).json({ id: 'honeypot', alreadyApplied: false });
      return;
    }

    const posting = await prisma.jobPosting.findUnique({
      where: { slug: req.params.slug },
    });
    if (!posting || posting.status !== 'OPEN') {
      throw new HttpError(404, 'not_found', 'Posting not found.');
    }
    const email = input.email.trim().toLowerCase();

    // One candidate per email. Someone already on file who applies again
    // (often to a different posting) used to be dropped without a trace;
    // now the application lands on their timeline where a recruiter sees
    // it. Nothing on their record is overwritten.
    const existing = await prisma.candidate.findUnique({ where: { email } });
    if (existing) {
      if (!existing.deletedAt) {
        await recordCandidateEvent(prisma, {
          candidateId: existing.id,
          kind: 'APPLIED_AGAIN',
          actorUserId: null,
          body: posting.title,
          metadata: { postingSlug: posting.slug },
        });
      }
      confirmApplication(email, input.firstName, posting.title);
      res.status(200).json({ id: existing.id, alreadyApplied: true });
      return;
    }
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.candidate.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email,
          phone: input.phone ?? null,
          position: posting.title,
          source: input.source?.trim() || 'careers-page',
          notes: input.notes ?? null,
          resumeUrl: input.resumeUrl ?? null,
          linkedinUrl: input.linkedinUrl ?? null,
          stage: 'APPLIED',
        },
      });
      await recordCandidateEvent(tx, {
        candidateId: row.id,
        kind: 'CREATED',
        actorUserId: null,
        toStage: 'APPLIED',
        body: `Applied on the careers page: ${posting.title}`,
        metadata: { postingSlug: posting.slug },
      });
      return row;
    });
    confirmApplication(email, input.firstName, posting.title);
    res.status(201).json({ id: created.id, alreadyApplied: false });
  },
);

/**
 * "We got it." Applicants heard nothing after pressing Apply — no email,
 * no reference, no idea whether it worked — which on an hourly job is the
 * moment they go apply somewhere else. Fire-and-forget: the application
 * is already saved, so a mail hiccup must not turn it into an error.
 */
function confirmApplication(email: string, firstName: string, title: string): void {
  void send({
    channel: 'EMAIL',
    category: 'careers_application',
    recipient: { userId: null, phone: null, email },
    subject: `We received your application: ${title}`,
    body: [
      `Hi ${firstName},`,
      '',
      `Thanks for applying for ${title} with Alto. Your application is in, and a recruiter will review it and contact you by email or phone about next steps.`,
      '',
      'You do not need to apply again. If you have questions, reply to this email.',
      '',
      '— The Alto recruiting team',
    ].join('\n'),
  }).catch(() => {
    /* fire-and-forget — the application is already saved */
  });
}
