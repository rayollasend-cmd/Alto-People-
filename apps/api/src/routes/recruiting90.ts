import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

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
      clientId: input.clientId ?? null,
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
  const created = await prisma.interview.create({
    data: {
      candidateId: input.candidateId,
      kitId: input.kitId ?? null,
      interviewerUserId: input.interviewerUserId ?? null,
      scheduledFor: new Date(input.scheduledFor),
    },
  });
  res.status(201).json({ id: created.id });
});

recruiting90Router.post('/interviews/:id/score', MANAGE, async (req, res) => {
  const input = InterviewScoreSchema.parse(req.body);
  await prisma.interview.update({
    where: { id: req.params.id },
    data: {
      scorecard: (input.scorecard ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      rating: input.rating ?? null,
      completedAt: new Date(),
    },
  });
  res.json({ ok: true });
});

recruiting90Router.delete('/interviews/:id', MANAGE, async (req, res) => {
  await prisma.interview.delete({ where: { id: req.params.id } });
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
  });
  res.status(201).json({ id: created.id });
});

recruiting90Router.post('/offers/:id/send', MANAGE, async (req, res) => {
  const o = await prisma.offer.findUnique({ where: { id: req.params.id } });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status !== 'DRAFT') {
    throw new HttpError(409, 'invalid_state', `Cannot send offer in ${o.status} state.`);
  }
  await prisma.offer.update({
    where: { id: o.id },
    data: { status: 'SENT', sentAt: new Date() },
  });
  res.json({ ok: true });
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
  await prisma.offer.update({
    where: { id: o.id },
    data: { status: decision, decidedAt: new Date() },
  });
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

recruiting90Router.post('/referrals', async (req, res) => {
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
  res.json({ ok: true });
});

recruiting90Router.post('/job-postings/:id/close', MANAGE, async (req, res) => {
  await prisma.jobPosting.update({
    where: { id: req.params.id },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  res.json({ ok: true });
});

recruiting90Router.delete('/job-postings/:id', MANAGE, async (req, res) => {
  await prisma.jobPosting.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Careers (PUBLIC — no auth required) -------------------------------

const CareersApplySchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  phone: z.string().max(40).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

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

recruiting90Router.post('/careers/:slug/apply', async (req, res) => {
  const input = CareersApplySchema.parse(req.body);
  const posting = await prisma.jobPosting.findUnique({
    where: { slug: req.params.slug },
  });
  if (!posting || posting.status !== 'OPEN') {
    throw new HttpError(404, 'not_found', 'Posting not found.');
  }
  const email = input.email.trim().toLowerCase();
  // Reuse an existing candidate row by email if one exists; otherwise
  // create. Either way, the application surfaces in /candidates for HR.
  const existing = await prisma.candidate.findUnique({ where: { email } });
  if (existing) {
    res.status(200).json({ id: existing.id, alreadyApplied: true });
    return;
  }
  const created = await prisma.candidate.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      phone: input.phone ?? null,
      position: posting.title,
      source: 'CAREERS_PAGE',
      notes: input.notes ?? null,
      stage: 'APPLIED',
    },
  });
  res.status(201).json({ id: created.id, alreadyApplied: false });
});
