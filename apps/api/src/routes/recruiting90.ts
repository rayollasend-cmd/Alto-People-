import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CareersApplyInputSchema, InterviewScorecardSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { send } from '../lib/notifications.js';
import { notifyUser } from '../lib/notify.js';
import { getBlobStore } from '../lib/blobStore.js';
import { env } from '../config/env.js';
import { renderTemplateTokens, resolveOfferTemplate } from '../lib/offerLetters.js';
import {
  DEFAULT_OFFER_DAYS,
  checkBand,
  hashAcceptToken,
  letterDate,
  mintAcceptToken,
  offerLetterContext,
  offerPay,
  renderSignedOffer,
} from '../lib/candidateOffers.js';
import { auditRecruiting, recordCandidateEvent } from '../lib/candidateEvents.js';
import { sendInterviewInvites, type InviteContext } from '../lib/interviewInvites.js';
import { boardKey, buildJobFeed } from '../lib/jobFeed.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import {
  careersApplyEmailLimiter,
  careersApplyIpLimiter,
  offerLetterIpLimiter,
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
  durationMinutes: z.number().int().min(5).max(480).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  /** Email the calendar invite to the candidate and interviewer. */
  notify: z.boolean().optional(),
});

const InterviewUpdateSchema = z.object({
  scheduledFor: z.string().datetime().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  location: z.string().trim().max(300).nullable().optional(),
  interviewerUserId: z.string().uuid().nullable().optional(),
  notify: z.boolean().optional(),
});

const InterviewScoreSchema = z.object({
  // Structured: every kit question rated on one scale, plus a summary.
  scorecard: InterviewScorecardSchema.nullable().optional(),
  rating: z.number().int().min(-2).max(2).nullable().optional(),
});

/** Everything an invite needs about one interview, with the person
 *  scheduling it as organizer. Null when the candidate is gone. */
async function inviteContextFor(
  interviewId: string,
  organizer: { email: string; firstName: string | null; lastName: string | null },
): Promise<InviteContext | null> {
  const iv = await prisma.interview.findUnique({
    where: { id: interviewId },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true, position: true, deletedAt: true } },
      interviewer: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!iv || iv.candidate.deletedAt) return null;
  const nameOf = (u: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    associate?: { firstName: string; lastName: string } | null;
  }) =>
    u.associate
      ? `${u.associate.firstName} ${u.associate.lastName}`
      : [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
  return {
    interview: iv,
    candidate: {
      name: `${iv.candidate.firstName} ${iv.candidate.lastName}`,
      email: iv.candidate.email,
      position: iv.candidate.position,
    },
    interviewer: iv.interviewer ? { name: nameOf(iv.interviewer), email: iv.interviewer.email } : null,
    organizer: { name: nameOf(organizer), email: organizer.email },
  };
}

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
      durationMinutes: i.durationMinutes,
      location: i.location,
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
        durationMinutes: input.durationMinutes ?? 30,
        location: input.location || null,
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
  let invited = { candidate: false, interviewer: false };
  if (input.notify !== false) {
    const ctx = await inviteContextFor(created.id, req.user!);
    if (ctx) invited = sendInterviewInvites(ctx, 'REQUEST');
  }
  res.status(201).json({ id: created.id, invited });
});

/**
 * Reschedule — a new time, length, place or interviewer. SEQUENCE goes up
 * so calendars replace the invite they hold; a changed interviewer gets a
 * cancellation for the slot they no longer have.
 */
recruiting90Router.patch('/interviews/:id', MANAGE, async (req, res) => {
  const input = InterviewUpdateSchema.parse(req.body);
  const existing = await prisma.interview.findUnique({
    where: { id: req.params.id },
    include: { candidate: { select: { deletedAt: true } } },
  });
  if (!existing || existing.candidate.deletedAt) throw new HttpError(404, 'not_found', 'Interview not found.');
  if (existing.completedAt) {
    throw new HttpError(409, 'already_scored', 'This interview has been scored; schedule a new one instead.');
  }
  const before = await inviteContextFor(existing.id, req.user!);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.interview.update({
      where: { id: existing.id },
      data: {
        ...(input.scheduledFor ? { scheduledFor: new Date(input.scheduledFor) } : {}),
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.location !== undefined ? { location: input.location || null } : {}),
        ...(input.interviewerUserId !== undefined ? { interviewerUserId: input.interviewerUserId } : {}),
        inviteSequence: { increment: 1 },
      },
    });
    await recordCandidateEvent(tx, {
      candidateId: row.candidateId,
      kind: 'INTERVIEW_RESCHEDULED',
      actorUserId: req.user!.id,
      body: when(row.scheduledFor),
      metadata: { interviewId: row.id, from: existing.scheduledFor.toISOString() },
    });
    return row;
  });
  auditRecruiting(req, 'interview_rescheduled', 'Interview', updated.id, {
    candidateId: updated.candidateId,
    from: existing.scheduledFor.toISOString(),
    to: updated.scheduledFor.toISOString(),
  });
  let invited = { candidate: false, interviewer: false };
  if (input.notify !== false) {
    const ctx = await inviteContextFor(updated.id, req.user!);
    if (ctx) invited = sendInterviewInvites(ctx, 'REQUEST', { rescheduled: true });
    // The interviewer who was swapped out: their slot is gone.
    if (
      before?.interviewer &&
      updated.interviewerUserId !== existing.interviewerUserId
    ) {
      sendInterviewInvites(
        { ...before, interview: { ...before.interview, inviteSequence: updated.inviteSequence } },
        'CANCEL',
        { only: 'interviewer' },
      );
    }
  }
  res.json({ ok: true, invited });
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
  // Read before the row goes: the cancellation needs who was invited.
  const ctx = existing.completedAt ? null : await inviteContextFor(existing.id, req.user!);
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
  // Take it back out of the calendars it went into. Only for one that
  // hadn't happened — clearing a scored interview's record isn't news.
  if (ctx && existing.scheduledFor.getTime() > Date.now()) {
    sendInterviewInvites(
      { ...ctx, interview: { ...ctx.interview, inviteSequence: ctx.interview.inviteSequence + 1 } },
      'CANCEL',
    );
  }
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

const OFFER_STATUSES = ['PENDING_APPROVAL', 'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;

/** HR admins hear about offers held for approval. */
async function notifyOfferApprovers(subject: string, body: string, exceptUserId: string | null) {
  const approvers = await prisma.user.findMany({
    where: { role: 'HR_ADMINISTRATOR', status: 'ACTIVE', deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { id: true },
  });
  await Promise.all(
    approvers.map((u) =>
      notifyUser(u.id, { subject, body, category: 'recruiting', linkUrl: '/recruiting/extras?tab=offers' }),
    ),
  );
}

recruiting90Router.get('/offers', VIEW, async (req, res) => {
  const candidateId = z.string().uuid().optional().parse(req.query.candidateId);
  const status = z.enum(OFFER_STATUSES).optional().parse(req.query.status);
  const rows = await prisma.offer.findMany({
    where: {
      ...(candidateId ? { candidateId } : {}),
      ...(status ? { status } : {}),
    },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { id: true, name: true } },
      approvedBy: { select: { email: true } },
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
      createdById: o.createdById,
      approvalNote: o.approvalNote,
      approvedByEmail: o.approvedBy?.email ?? null,
      approvedAt: o.approvedAt?.toISOString() ?? null,
      approvalDeclinedReason: o.approvalDeclinedReason,
      signedName: o.signedName,
      signedAt: o.signedAt?.toISOString() ?? null,
      hasSignedPdf: o.signedPdfKey !== null,
      declineReason: o.declineReason,
    })),
  });
});

/** The published offer-letter templates a recruiter can write from. */
recruiting90Router.get('/offers/letter-templates', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.documentTemplate.findMany({
    where: {
      kind: 'OFFER_LETTER',
      deletedAt: null,
      currentVersionId: { not: null },
      ...(clientId ? { OR: [{ clientId }, { clientId: null }] } : {}),
    },
    include: { client: { select: { name: true } } },
    orderBy: [{ clientId: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
    take: 100,
  });
  res.json({
    templates: rows.map((t) => ({ id: t.id, name: t.name, clientName: t.client?.name ?? null })),
  });
});

const LetterPreviewSchema = z.object({
  candidateId: z.string().uuid(),
  clientId: z.string().uuid(),
  jobTitle: z.string().min(1).max(200),
  startDate: z.string(),
  salary: z.number().nonnegative().optional().nullable(),
  hourlyRate: z.number().nonnegative().optional().nullable(),
  currency: z.string().length(3).optional(),
  /** A specific template; else the client's own, else the global one. */
  templateId: z.string().uuid().optional(),
});

/**
 * Write the letter from a template: the candidate, the job, the pay and
 * the client merged in, ready to edit before it's saved. Unresolved
 * tokens are named rather than left as silent blanks.
 */
recruiting90Router.post('/offers/letter-preview', MANAGE, async (req, res) => {
  const input = LetterPreviewSchema.parse(req.body);
  const [candidate, client] = await Promise.all([
    prisma.candidate.findFirst({ where: { id: input.candidateId, deletedAt: null } }),
    prisma.client.findFirst({ where: { id: input.clientId, deletedAt: null }, select: { name: true } }),
  ]);
  if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found.');
  if (!client) throw new HttpError(404, 'not_found', 'Client not found.');
  let picked: { templateId: string; name: string; body: string } | null = null;
  if (input.templateId) {
    const t = await prisma.documentTemplate.findFirst({
      where: { id: input.templateId, kind: 'OFFER_LETTER', deletedAt: null },
      include: { currentVersion: true },
    });
    if (!t?.currentVersion) throw new HttpError(404, 'not_found', 'That template has no published version.');
    picked = { templateId: t.id, name: t.name, body: t.currentVersion.body };
  } else {
    const r = await resolveOfferTemplate(input.clientId);
    if (r) picked = { templateId: r.template.id, name: r.template.name, body: r.version.body };
  }
  if (!picked) {
    throw new HttpError(404, 'no_template', 'No offer-letter template is published for this client yet.');
  }
  const { text, unresolvedTokens } = renderTemplateTokens(
    picked.body,
    offerLetterContext({
      candidate,
      offer: {
        jobTitle: input.jobTitle,
        startDate: new Date(input.startDate),
        hourlyRate: input.hourlyRate ?? null,
        salary: input.salary ?? null,
        currency: input.currency ?? 'USD',
      },
      clientName: client.name,
    }),
  );
  res.json({ templateId: picked.templateId, templateName: picked.name, body: text, unresolvedTokens });
});

recruiting90Router.post('/offers', MANAGE, async (req, res) => {
  const input = OfferInputSchema.parse(req.body);
  const candidate = await prisma.candidate.findFirst({
    where: { id: input.candidateId, deletedAt: null },
  });
  if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found.');
  const currency = input.currency ?? 'USD';
  // Pay outside the client's band for this job waits for someone else's
  // approval before it can go to the candidate.
  const band = await checkBand({
    clientId: input.clientId,
    jobTitle: input.jobTitle,
    payType: input.hourlyRate != null ? 'HOURLY' : 'SALARY',
    amount: Number(input.hourlyRate ?? input.salary),
    currency,
  });
  const created = await prisma.offer.create({
    data: {
      candidateId: input.candidateId,
      clientId: input.clientId,
      jobTitle: input.jobTitle,
      startDate: new Date(input.startDate),
      salary: input.salary ?? null,
      hourlyRate: input.hourlyRate ?? null,
      currency,
      letterBody: input.letterBody ?? null,
      templateRenderId: input.templateRenderId ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: req.user!.id,
      status: band.outsideNote ? 'PENDING_APPROVAL' : 'DRAFT',
      approvalNote: band.outsideNote,
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
  if (band.outsideNote) {
    await recordCandidateEvent(prisma, {
      candidateId: created.candidateId,
      kind: 'OFFER_APPROVAL_REQUESTED',
      actorUserId: req.user!.id,
      body: band.outsideNote,
      metadata: { offerId: created.id },
    });
    void notifyOfferApprovers(
      'An offer needs your approval',
      `${candidate.firstName} ${candidate.lastName} — ${created.jobTitle} at ${created.client.name}. ${band.outsideNote}`,
      req.user!.id,
    ).catch(() => undefined);
  }
  auditRecruiting(req, 'offer_created', 'Offer', created.id, {
    candidateId: created.candidateId,
    ...(band.outsideNote ? { needsApproval: band.outsideNote } : {}),
  });
  res.status(201).json({ id: created.id, status: created.status, approvalNote: created.approvalNote });
});

/**
 * Approve or decline an offer held for its pay. Maker-checker: whoever
 * drafted it can't wave it through themselves, and the decision is
 * someone's with the right to set pay (manage:comp).
 */
const APPROVE = requireCapability('manage:comp');

async function heldOffer(id: string, approverId: string) {
  const o = await prisma.offer.findUnique({
    where: { id },
    include: { candidate: { select: { firstName: true, lastName: true } } },
  });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status !== 'PENDING_APPROVAL') {
    throw new HttpError(409, 'invalid_state', `This offer isn't waiting for approval (it's ${o.status}).`);
  }
  if (o.createdById === approverId) {
    throw new HttpError(409, 'own_offer', 'Someone other than whoever drafted an offer has to approve it.');
  }
  return o;
}

recruiting90Router.post('/offers/:id/approve', MANAGE, APPROVE, async (req, res) => {
  const o = await heldOffer(req.params.id, req.user!.id);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: 'DRAFT', approvedById: req.user!.id, approvedAt: new Date() },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_APPROVED',
      actorUserId: req.user!.id,
      body: o.jobTitle,
      metadata: { offerId: o.id },
    });
  });
  auditRecruiting(req, 'offer_approved', 'Offer', o.id, { candidateId: o.candidateId, note: o.approvalNote });
  if (o.createdById) {
    void notifyUser(o.createdById, {
      subject: 'Offer approved',
      body: `${o.candidate.firstName} ${o.candidate.lastName}'s offer for ${o.jobTitle} is approved — it can be sent.`,
      category: 'recruiting',
      linkUrl: '/recruiting/extras?tab=offers',
    }).catch(() => undefined);
  }
  res.json({ ok: true });
});

recruiting90Router.post('/offers/:id/decline-approval', MANAGE, APPROVE, async (req, res) => {
  const reason = z.string().trim().min(1).max(500).parse(req.body?.reason);
  const o = await heldOffer(req.params.id, req.user!.id);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: 'WITHDRAWN', decidedAt: new Date(), approvalDeclinedReason: reason },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_APPROVAL_DECLINED',
      actorUserId: req.user!.id,
      body: reason,
      metadata: { offerId: o.id },
    });
  });
  auditRecruiting(req, 'offer_approval_declined', 'Offer', o.id, { candidateId: o.candidateId, reason });
  if (o.createdById) {
    void notifyUser(o.createdById, {
      subject: 'Offer not approved',
      body: `${o.candidate.firstName} ${o.candidate.lastName}'s offer for ${o.jobTitle} was declined: ${reason}`,
      category: 'recruiting',
      linkUrl: '/recruiting/extras?tab=offers',
    }).catch(() => undefined);
  }
  res.json({ ok: true });
});

recruiting90Router.post('/offers/:id/send', MANAGE, async (req, res) => {
  const o = await prisma.offer.findUnique({
    where: { id: req.params.id },
    include: {
      candidate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { name: true } },
    },
  });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status === 'PENDING_APPROVAL') {
    throw new HttpError(409, 'needs_approval', 'This offer needs approval before it can be sent.');
  }
  if (o.status !== 'DRAFT') {
    throw new HttpError(409, 'invalid_state', `Cannot send offer in ${o.status} state.`);
  }
  // The candidate's private link to read and sign it. Only the hash is
  // kept; an offer with no expiry of its own gets a default one.
  const token = mintAcceptToken();
  const expiresAt = o.expiresAt ?? new Date(Date.now() + DEFAULT_OFFER_DAYS * 86_400_000);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: 'SENT', sentAt: new Date(), acceptTokenHash: token.hash, expiresAt },
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

  // Candidates are usually not Users yet, so this is a raw email —
  // fire-and-forget after the write. If there is no reachable email, the
  // flip still happened; `emailed` lets the UI say so.
  const candidateEmail = o.candidate.email?.trim() || null;
  const link = `${env.APP_BASE_URL}/offer/${token.raw}`;
  if (candidateEmail) {
    void send({
      channel: 'EMAIL',
      category: 'offer_letter',
      recipient: { userId: null, phone: null, email: candidateEmail },
      subject: `Your offer from Alto: ${o.jobTitle}`,
      body: [
        `Hi ${o.candidate.firstName},`,
        '',
        `We are pleased to offer you the position of ${o.jobTitle}${o.client ? ` at ${o.client.name}` : ''}.`,
        '',
        `Start date: ${letterDate(o.startDate)}`,
        `Pay: ${offerPay(o)}`,
        '',
        `Read your offer letter and accept it by signing online:`,
        link,
        '',
        `The link is yours alone and works until ${letterDate(new Date(expiresAt.toISOString().slice(0, 10)))}.`,
        'Questions? Reply to this email.',
      ].join('\n'),
    }).catch(() => {
      /* fire-and-forget — the offer is already SENT */
    });
  }
  res.json({ ok: true, emailed: candidateEmail !== null, ...(env.RESEND_API_KEY ? {} : { link }) });
});

recruiting90Router.post('/offers/:id/decision', MANAGE, async (req, res) => {
  const decision = z
    .enum(['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'])
    .parse(req.body?.decision);
  const o = await prisma.offer.findUnique({ where: { id: req.params.id } });
  if (!o) throw new HttpError(404, 'not_found', 'Offer not found.');
  if (o.status !== 'SENT' && o.status !== 'DRAFT' && o.status !== 'PENDING_APPROVAL') {
    throw new HttpError(409, 'invalid_state', `Offer already ${o.status}.`);
  }
  // Recording a yes on the candidate's behalf is still possible (a verbal
  // acceptance) — but not for pay nobody has approved.
  if (o.status === 'PENDING_APPROVAL' && decision === 'ACCEPTED') {
    throw new HttpError(409, 'needs_approval', 'This offer needs approval before it can be accepted.');
  }
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      // A decided offer's link stops working.
      data: { status: decision, decidedAt: new Date(), acceptTokenHash: null },
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

/** The signed offer letter, for the candidate's file. */
recruiting90Router.get('/offers/:id/signed.pdf', VIEW, async (req, res) => {
  const o = await prisma.offer.findUnique({
    where: { id: req.params.id },
    include: { candidate: { select: { lastName: true } } },
  });
  if (!o?.signedPdfKey) throw new HttpError(404, 'not_found', 'No signed letter for this offer.');
  const pdf = await getBlobStore().get(o.signedPdfKey);
  if (!pdf) throw new HttpError(404, 'not_found', 'The signed letter could not be found.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="offer-${o.candidate.lastName.toLowerCase()}-signed.pdf"`);
  res.send(pdf);
});

// ----- The candidate's offer link (PUBLIC — the token is the key) --------

/** The offer behind a link, if the link is real. An offer past its expiry
 *  is marked expired the first time its link is opened after. */
async function offerByToken(raw: string) {
  const o = await prisma.offer.findUnique({
    where: { acceptTokenHash: hashAcceptToken(raw) },
    include: {
      candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
      client: { select: { name: true } },
    },
  });
  if (!o) throw new HttpError(404, 'not_found', 'This offer link is not valid.');
  if (o.status === 'SENT' && o.expiresAt && o.expiresAt.getTime() < Date.now()) {
    await prisma.offer.update({ where: { id: o.id }, data: { status: 'EXPIRED', decidedAt: new Date() } });
    return { ...o, status: 'EXPIRED' as const };
  }
  return o;
}

recruiting90Router.get('/offer-letters/:token', offerLetterIpLimiter, async (req, res) => {
  const o = await offerByToken(req.params.token);
  res.json({
    candidateFirstName: o.candidate.firstName,
    candidateName: `${o.candidate.firstName} ${o.candidate.lastName}`,
    jobTitle: o.jobTitle,
    clientName: o.client.name,
    startDate: letterDate(o.startDate),
    pay: offerPay(o),
    letterBody: o.letterBody,
    status: o.status,
    expiresAt: o.expiresAt?.toISOString() ?? null,
    signedName: o.signedName,
    signedAt: o.signedAt?.toISOString() ?? null,
  });
});

const AcceptOfferSchema = z.object({
  typedName: z.string().trim().min(2).max(120),
  agree: z.literal(true),
});

/**
 * The candidate accepts by signing: their typed name, the time, their IP
 * and browser go into a signed PDF of the letter (the in-house e-sign
 * renderer), hashed and kept. The link stops working once used.
 */
recruiting90Router.post('/offer-letters/:token/accept', offerLetterIpLimiter, async (req, res) => {
  const input = AcceptOfferSchema.parse(req.body);
  const o = await offerByToken(req.params.token);
  if (o.status !== 'SENT') {
    throw new HttpError(409, 'not_open', o.status === 'EXPIRED' ? 'This offer has expired.' : `This offer is already ${o.status.toLowerCase()}.`);
  }
  const signedAt = new Date();
  const candidateName = `${o.candidate.firstName} ${o.candidate.lastName}`;
  const letter = [
    o.letterBody?.trim() ||
      `We are pleased to offer you the position of ${o.jobTitle} at ${o.client.name}.`,
    '',
    `Position: ${o.jobTitle}`,
    `Client: ${o.client.name}`,
    `Start date: ${letterDate(o.startDate)}`,
    `Pay: ${offerPay(o)}`,
  ].join('\n');
  const signed = await renderSignedOffer({
    offerId: o.id,
    title: `Offer letter — ${o.jobTitle}`,
    body: letter,
    signer: { fullName: candidateName, email: o.candidate.email },
    typedName: input.typedName,
    signedAt,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent']?.toString() ?? null,
  });
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: {
        status: 'ACCEPTED',
        decidedAt: signedAt,
        signedName: input.typedName,
        signedAt,
        signedIp: req.ip ?? null,
        signedUserAgent: req.headers['user-agent']?.toString().slice(0, 500) ?? null,
        signedPdfKey: signed.key,
        signedPdfHash: signed.hash,
        acceptTokenHash: null,
      },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_DECIDED',
      actorUserId: null,
      body: `Accepted: ${o.jobTitle} — e-signed by ${input.typedName}`,
      metadata: { offerId: o.id, decision: 'ACCEPTED', pdfHash: signed.hash },
    });
  });
  auditRecruiting(req, 'offer_signed', 'Offer', o.id, {
    candidateId: o.candidateId,
    typedName: input.typedName,
    pdfHash: signed.hash,
  });
  // Their copy of what they signed — the link retires once used, so the
  // email is how they keep it.
  void send({
    channel: 'EMAIL',
    category: 'offer_letter',
    recipient: { userId: null, phone: null, email: o.candidate.email },
    subject: `Your signed offer: ${o.jobTitle}`,
    body: [
      `Hi ${o.candidate.firstName},`,
      '',
      `Thank you for accepting the ${o.jobTitle} position. Your signed offer letter is attached for your records.`,
      '',
      "Next, you'll get an email to set up your account and complete your onboarding paperwork.",
    ].join('\n'),
    attachments: [{ filename: 'offer-letter-signed.pdf', content: signed.pdf, contentType: 'application/pdf' }],
  }).catch(() => {
    /* fire-and-forget — the signature is already recorded */
  });
  if (o.createdById) {
    void notifyUser(o.createdById, {
      subject: 'Offer accepted and signed',
      body: `${candidateName} signed the offer for ${o.jobTitle}. They're ready to hire.`,
      category: 'recruiting',
      linkUrl: `/recruiting?candidateId=${o.candidateId}`,
    }).catch(() => undefined);
  }
  res.json({ ok: true, signedAt: signedAt.toISOString() });
});

recruiting90Router.post('/offer-letters/:token/decline', offerLetterIpLimiter, async (req, res) => {
  const reason = z.string().trim().max(500).optional().parse(req.body?.reason) || null;
  const o = await offerByToken(req.params.token);
  if (o.status !== 'SENT') {
    throw new HttpError(409, 'not_open', `This offer is already ${o.status.toLowerCase()}.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({
      where: { id: o.id },
      data: { status: 'DECLINED', decidedAt: new Date(), declineReason: reason, acceptTokenHash: null },
    });
    await recordCandidateEvent(tx, {
      candidateId: o.candidateId,
      kind: 'OFFER_DECIDED',
      actorUserId: null,
      body: `Declined: ${o.jobTitle}${reason ? ` — "${reason}"` : ''}`,
      metadata: { offerId: o.id, decision: 'DECLINED' },
    });
  });
  auditRecruiting(req, 'offer_declined_by_candidate', 'Offer', o.id, { candidateId: o.candidateId });
  if (o.createdById) {
    void notifyUser(o.createdById, {
      subject: 'Offer declined',
      body: `${o.candidate.firstName} ${o.candidate.lastName} declined the offer for ${o.jobTitle}${reason ? `: ${reason}` : '.'}`,
      category: 'recruiting',
      linkUrl: `/recruiting?candidateId=${o.candidateId}`,
    }).catch(() => undefined);
  }
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
  /** How many people the client asked for. */
  openings: z.number().int().min(1).max(500).optional(),
  schedule: z.enum(['FULL_TIME', 'PART_TIME', 'TEMPORARY', 'SEASONAL']).nullable().optional(),
  payUnit: z.enum(['HOUR', 'YEAR']).nullable().optional(),
  /** In the job-board feeds while open. Default on. */
  syndicate: z.boolean().optional(),
  slug: z
    .string()
    .min(2)
    .max(200)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase, alphanumeric + hyphens.'),
});

recruiting90Router.get('/job-postings', VIEW, async (_req, res) => {
  const rows = await prisma.jobPosting.findMany({
    where: {},
    include: {
      client: { select: { id: true, name: true } },
      _count: { select: { candidates: { where: { deletedAt: null, stage: 'HIRED' } } } },
    },
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
      openings: p.openings,
      /** Hired against this posting so far. */
      hired: p._count.candidates,
      schedule: p.schedule,
      payUnit: p.payUnit,
      syndicate: p.syndicate,
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
        openings: input.openings ?? 1,
        schedule: input.schedule ?? null,
        payUnit: input.payUnit ?? null,
        syndicate: input.syndicate ?? true,
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

/**
 * The parts of a posting that change after it's up: the headcount (a
 * client adds two more), and whether job boards carry it.
 */
recruiting90Router.patch('/job-postings/:id', MANAGE, async (req, res) => {
  const input = z
    .object({
      openings: z.number().int().min(1).max(500).optional(),
      syndicate: z.boolean().optional(),
      schedule: z.enum(['FULL_TIME', 'PART_TIME', 'TEMPORARY', 'SEASONAL']).nullable().optional(),
      payUnit: z.enum(['HOUR', 'YEAR']).nullable().optional(),
    })
    .parse(req.body);
  const found = await prisma.jobPosting.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!found) throw new HttpError(404, 'not_found', 'Posting not found.');
  await prisma.jobPosting.update({ where: { id: found.id }, data: input });
  auditRecruiting(req, 'posting_updated', 'JobPosting', found.id, input);
  res.json({ ok: true });
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
      schedule: p.schedule,
      payUnit: p.payUnit,
    })),
  });
});

/**
 * GET /careers/feed.xml?board=indeed — the open postings as a job-board
 * feed (Indeed's XML, which most boards and aggregators read). Public, like
 * the careers page it points to. A posting switched out of syndication
 * stays on the careers page but leaves every feed.
 */
recruiting90Router.get('/careers/feed.xml', async (req, res) => {
  const board = boardKey(req.query.board);
  const [postings, branding] = await Promise.all([
    prisma.jobPosting.findMany({
      where: { status: 'OPEN', syndicate: true },
      orderBy: { openedAt: 'desc' },
      take: 1000,
    }),
    ensureBrandingLoaded(prisma),
  ]);
  res
    .type('application/xml; charset=utf-8')
    .set('Cache-Control', 'public, max-age=900')
    .send(buildJobFeed({ postings, board, orgName: branding.orgName, baseUrl: env.APP_BASE_URL }));
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
    // For the page's Google for Jobs structured data.
    schedule: p.schedule,
    payUnit: p.payUnit,
    orgName: (await ensureBrandingLoaded(prisma)).orgName,
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
        // Tie them to this posting if nothing ties them to one yet.
        if (!existing.jobPostingId) {
          await prisma.candidate.update({ where: { id: existing.id }, data: { jobPostingId: posting.id } });
        }
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
          jobPostingId: posting.id,
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
