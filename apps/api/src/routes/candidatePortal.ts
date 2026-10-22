import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { signedLinkIpLimiter } from '../middleware/rateLimit.js';
import { generateInviteToken, hashToken } from '../lib/inviteToken.js';
import { auditRecruiting, recordCandidateEvent } from '../lib/candidateEvents.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { mintUserCalendarToken } from '../lib/calendarFeed.js';
import { publicBaseUrl, renderBrandedEmail } from '../lib/emailLayout.js';
import { send } from '../lib/notifications.js';
import { ADMIN_EMAIL_HIRING, notifyAllAdmins, notifyUser } from '../lib/notify.js';
import { getBlobStore } from '../lib/blobStore.js';
import { safeContentDisposition, sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { inviteWhen } from '../lib/interviewInvites.js';
import { enqueueAudit } from '../lib/audit.js';
import { saveEeoSelfId } from '../lib/hiringCompliance.js';
import { EeoSelfIdInputSchema } from '@alto-people/shared';

/**
 * The candidate's own page, and the recruiter's calendar feed.
 *
 * A candidate used to hear from us by email and nothing else: where they
 * stood, when the interview was, which papers to bring — all in a thread
 * they had to scroll back through. Now every email and text carries one
 * private link to a page that says their stage, their next interview (and
 * lets them say "I'll be there"), and the documents we asked for, which
 * they upload right there. No login: the link is the key, it is rotated on
 * every send, and it lapses after thirty days.
 *
 * The recruiter's half: a document request on the candidate's record, the
 * review of what came back, and an iCal feed URL any calendar subscribes
 * to — every interview, kept current, beside the invites each one emails.
 */

export const candidatePortalRouter = Router();

const VIEW = requireCapability('view:recruiting');
const MANAGE = requireCapability('manage:recruiting');

const PORTAL_LINK_DAYS = 30;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
type DocStatus = 'REQUESTED' | 'UPLOADED' | 'ACCEPTED' | 'REJECTED';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!UPLOAD_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Upload a PDF or a photo (JPEG, PNG or WebP).'));
      return;
    }
    cb(null, true);
  },
});

/** What the candidate's page says about their stage — their words, not the pipeline's. */
const STAGE_WORDS: Record<string, { label: string; detail: string }> = {
  APPLIED: { label: 'Application received', detail: 'A recruiter is reviewing it and will be in touch.' },
  SCREENING: { label: 'Under review', detail: 'We are looking at your application now.' },
  INTERVIEW: { label: 'Interview stage', detail: 'Your interview details are below.' },
  OFFER: { label: 'Offer stage', detail: 'Watch your email for your offer letter.' },
  HIRED: { label: 'Hired', detail: 'Welcome aboard — your onboarding invite is on its way.' },
  REJECTED: { label: 'Not selected this time', detail: 'Thank you for applying. We keep your application on file.' },
  WITHDRAWN: { label: 'Application withdrawn', detail: 'Apply again any time a role suits you.' },
};

const candidateHref = (id: string) => `/recruiting?candidateId=${id}`;

/* ===== The link ============================================================ */

interface LinkCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  position: string | null;
}

/**
 * Mint a fresh link for the candidate, store its hash, and send it by email
 * and — when they left a number — by text. Returns the URL for the caller,
 * which the UI shows only when email isn't configured.
 */
async function sendPortalLink(
  c: LinkCandidate,
  actorUserId: string | null,
  reason: 'invite' | 'document',
  documentLabel?: string,
): Promise<{ url: string; emailed: boolean; texted: boolean; textReason: string | null; expiresAt: Date }> {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + PORTAL_LINK_DAYS * 86_400_000);
  await prisma.$transaction(async (tx) => {
    await tx.candidate.update({
      where: { id: c.id },
      data: { portalTokenHash: token.hash, portalTokenExpiresAt: expiresAt },
    });
    await recordCandidateEvent(tx, {
      candidateId: c.id,
      kind: 'PORTAL_LINK_SENT',
      actorUserId,
      body: reason === 'document' ? `Document requested: ${documentLabel ?? ''}` : null,
    });
  });
  const url = `${publicBaseUrl()}/candidate/${token.raw}`;
  const branding = await ensureBrandingLoaded(prisma);
  const heading =
    reason === 'document'
      ? `We need a document from you${documentLabel ? `: ${documentLabel}` : ''}`
      : 'Your application page';
  const email = renderBrandedEmail({
    subject: reason === 'document' ? `${branding.orgName}: a document we need from you` : `${branding.orgName}: your application page`,
    preheader: reason === 'document' ? 'Upload it in a minute from your phone.' : 'Where you stand, your interview, and what we need from you.',
    greeting: `Hi ${c.firstName},`,
    heading,
    paragraphs:
      reason === 'document'
        ? [
            `To move your application${c.position ? ` for ${c.position}` : ''} along we need one more thing from you. Open your page and upload it — a photo from your phone is fine.`,
          ]
        : [
            `Everything about your application${c.position ? ` for ${c.position}` : ''} is on one page: where you stand, your next interview, and anything we need from you.`,
          ],
    cta: { label: 'Open my page', url },
    after: [`The link is yours alone and works for ${PORTAL_LINK_DAYS} days.`],
  });
  let emailed = false;
  let texted = false;
  const to = c.email.trim();
  if (to) {
    emailed = true;
    void send({
      channel: 'EMAIL',
      category: 'candidate_portal',
      recipient: { userId: null, phone: null, email: to },
      subject: email.subject,
      body: email.text,
      html: email.html,
    }).catch(() => {
      /* fire-and-forget — the link is already saved */
    });
  }
  // The text is awaited so the answer tells the truth: `texted` is true
  // only when the provider took it. With no SMS provider the row is
  // recorded NOT_CONFIGURED and the panel says the link went by email only.
  let textReason: string | null = null;
  if (c.phone?.trim()) {
    try {
      await send({
        channel: 'SMS',
        category: 'candidate_portal',
        recipient: { userId: null, phone: c.phone.trim(), email: null },
        subject: null,
        body:
          reason === 'document'
            ? `${branding.orgName}: we need a document from you${documentLabel ? ` (${documentLabel})` : ''}. Upload it here: ${url}`
            : `${branding.orgName}: your application page — your stage, interview and documents: ${url}`,
      });
      texted = true;
    } catch (err) {
      textReason = err instanceof Error ? err.message : 'The text could not be sent.';
    }
  }
  return { url, emailed, texted, textReason, expiresAt };
}

async function liveCandidate(id: string) {
  const c = await prisma.candidate.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, position: true, portalTokenExpiresAt: true },
  });
  if (!c) throw new HttpError(404, 'not_found', 'Candidate not found.');
  return c;
}

/** POST /recruiting/candidates/:id/portal-link — a fresh link, sent. */
candidatePortalRouter.post('/recruiting/candidates/:id/portal-link', requireAuth, MANAGE, async (req, res) => {
  const c = await liveCandidate(req.params.id);
  const sent = await sendPortalLink(c, req.user!.id, 'invite');
  auditRecruiting(req, 'portal_link_sent', 'Candidate', c.id, { emailed: sent.emailed, texted: sent.texted });
  res.json({
    ok: true,
    emailed: sent.emailed,
    texted: sent.texted,
    textReason: sent.textReason,
    expiresAt: sent.expiresAt.toISOString(),
    ...(env.RESEND_API_KEY ? {} : { link: sent.url }),
  });
});

/* ===== Document requests (the recruiter's side) ============================ */

function docOut(d: {
  id: string;
  candidateId: string;
  label: string;
  note: string | null;
  status: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: Date | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: d.id,
    candidateId: d.candidateId,
    label: d.label,
    note: d.note,
    status: d.status as DocStatus,
    fileName: d.fileName,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    uploadedAt: d.uploadedAt?.toISOString() ?? null,
    reviewNote: d.reviewNote,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

candidatePortalRouter.get('/recruiting/candidates/:id/document-requests', requireAuth, VIEW, async (req, res) => {
  const c = await liveCandidate(req.params.id);
  const rows = await prisma.candidateDocumentRequest.findMany({
    where: { candidateId: c.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    portal: {
      linkActive: !!c.portalTokenExpiresAt && c.portalTokenExpiresAt.getTime() > Date.now(),
      expiresAt: c.portalTokenExpiresAt?.toISOString() ?? null,
    },
    requests: rows.map(docOut),
  });
});

const DocRequestSchema = z.object({
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).nullable().optional(),
  /** Send the candidate a fresh link saying what we need. Default on. */
  notify: z.boolean().optional(),
});

candidatePortalRouter.post('/recruiting/candidates/:id/document-requests', requireAuth, MANAGE, async (req, res) => {
  const input = DocRequestSchema.parse(req.body);
  const c = await liveCandidate(req.params.id);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.candidateDocumentRequest.create({
      data: { candidateId: c.id, label: input.label, note: input.note ?? null, requestedById: req.user!.id },
    });
    await recordCandidateEvent(tx, {
      candidateId: c.id,
      kind: 'DOCUMENT_REQUESTED',
      actorUserId: req.user!.id,
      body: input.label,
      metadata: { requestId: created.id },
    });
    return created;
  });
  auditRecruiting(req, 'document_requested', 'Candidate', c.id, { requestId: row.id, label: input.label });
  let sent: Awaited<ReturnType<typeof sendPortalLink>> | null = null;
  if (input.notify !== false) sent = await sendPortalLink(c, req.user!.id, 'document', input.label);
  res.status(201).json({
    request: docOut(row),
    emailed: sent?.emailed ?? false,
    texted: sent?.texted ?? false,
    textReason: sent?.textReason ?? null,
    ...(sent && !env.RESEND_API_KEY ? { link: sent.url } : {}),
  });
});

const ReviewSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  note: z.string().trim().max(500).nullable().optional(),
});

candidatePortalRouter.post('/recruiting/document-requests/:id/review', requireAuth, MANAGE, async (req, res) => {
  const input = ReviewSchema.parse(req.body);
  const existing = await prisma.candidateDocumentRequest.findFirst({
    where: { id: req.params.id, candidate: { deletedAt: null } },
    include: { candidate: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, position: true } } },
  });
  if (!existing) throw new HttpError(404, 'not_found', 'Document request not found.');
  if (existing.status !== 'UPLOADED') {
    throw new HttpError(409, 'nothing_to_review', 'Nothing has been uploaded for this request yet.');
  }
  const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.candidateDocumentRequest.update({
      where: { id: existing.id },
      data: { status, reviewNote: input.note ?? null, reviewedAt: new Date(), reviewedById: req.user!.id },
    });
    await recordCandidateEvent(tx, {
      candidateId: existing.candidateId,
      kind: 'DOCUMENT_REVIEWED',
      actorUserId: req.user!.id,
      body: `${existing.label}: ${status === 'ACCEPTED' ? 'accepted' : 'needs another upload'}${input.note ? ` — ${input.note}` : ''}`,
      metadata: { requestId: existing.id, status },
    });
    return updated;
  });
  auditRecruiting(req, 'document_reviewed', 'Candidate', existing.candidateId, { requestId: existing.id, status });
  // A rejection asks the candidate again, with the reason, on a fresh link.
  if (status === 'REJECTED') {
    await sendPortalLink(existing.candidate, req.user!.id, 'document', existing.label);
  }
  res.json({ request: docOut(row) });
});

candidatePortalRouter.get('/recruiting/document-requests/:id/file', requireAuth, VIEW, async (req, res) => {
  const row = await prisma.candidateDocumentRequest.findFirst({
    where: { id: req.params.id, candidate: { deletedAt: null } },
  });
  if (!row || !row.s3Key) throw new HttpError(404, 'not_found', 'No file on this request.');
  const stream = await getBlobStore().getStream(row.s3Key);
  if (!stream) throw new HttpError(404, 'file_missing', 'The file is no longer in storage.');
  res.setHeader('Content-Type', row.contentType ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', safeContentDisposition(row.fileName ?? 'document', true));
  res.setHeader('Cache-Control', 'private, no-store');
  stream.pipe(res);
});

/* ===== The recruiter's calendar feed ======================================= */

function feedUrls(userId: string, version: number) {
  const url = `${publicBaseUrl()}/api/calendar/v1/user/${userId}/${mintUserCalendarToken(userId, version)}.ics`;
  return { url, webcalUrl: url.replace(/^https?:\/\//, 'webcal://') };
}

candidatePortalRouter.get('/recruiting/me/calendar-url', requireAuth, VIEW, async (req, res) => {
  const feed = await prisma.userCalendarFeed.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id },
    update: {},
    select: { version: true },
  });
  res.json(feedUrls(req.user!.id, feed.version));
});

/** A leaked URL: bump the version so only the new one verifies. */
candidatePortalRouter.post('/recruiting/me/calendar-url/rotate', requireAuth, VIEW, async (req, res) => {
  const feed = await prisma.userCalendarFeed.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id, version: 2 },
    update: { version: { increment: 1 } },
    select: { version: true },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'recruiting.calendar_feed_rotated',
      entityType: 'User',
      entityId: req.user!.id,
      metadata: { version: feed.version },
    },
    'recruiting.calendar_feed_rotated',
  );
  res.json(feedUrls(req.user!.id, feed.version));
});

/* ===== The candidate's page (public, signed link) ========================== */

async function candidateByToken(raw: string) {
  if (!raw || raw.length > 128) throw new HttpError(404, 'not_found', 'This link is not valid.');
  const c = await prisma.candidate.findFirst({
    where: { portalTokenHash: hashToken(raw), deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      position: true,
      stage: true,
      portalTokenExpiresAt: true,
      jobPosting: { select: { title: true, slug: true } },
    },
  });
  if (!c || !c.portalTokenExpiresAt || c.portalTokenExpiresAt.getTime() < Date.now()) {
    throw new HttpError(404, 'link_expired', 'This link has expired. Ask your recruiter for a new one.');
  }
  return c;
}

candidatePortalRouter.get('/candidate-portal/:token', signedLinkIpLimiter, async (req, res) => {
  const c = await candidateByToken(req.params.token);
  const [interviews, docs, branding] = await Promise.all([
    prisma.interview.findMany({
      where: { candidateId: c.id, completedAt: null, scheduledFor: { gte: new Date(Date.now() - 3_600_000) } },
      orderBy: { scheduledFor: 'asc' },
      take: 5,
      include: { interviewer: { select: { associate: { select: { firstName: true, lastName: true } } } } },
    }),
    prisma.candidateDocumentRequest.findMany({ where: { candidateId: c.id }, orderBy: { createdAt: 'asc' } }),
    ensureBrandingLoaded(prisma),
  ]);
  // Only whether they answered the voluntary EEO form — never the answers.
  const eeoAnswered = (await prisma.eeoSelfIdentification.count({ where: { candidateId: c.id } })) > 0;
  void prisma.candidate.update({ where: { id: c.id }, data: { portalLastSeenAt: new Date() } }).catch(() => undefined);
  const words = STAGE_WORDS[c.stage] ?? STAGE_WORDS.APPLIED!;
  res.json({
    orgName: branding.orgName,
    firstName: c.firstName,
    position: c.position ?? c.jobPosting?.title ?? null,
    postingSlug: c.jobPosting?.slug ?? null,
    stage: c.stage,
    stageLabel: words.label,
    stageDetail: words.detail,
    expiresAt: c.portalTokenExpiresAt!.toISOString(),
    eeoAnswered,
    interviews: interviews.map((i) => ({
      id: i.id,
      scheduledFor: i.scheduledFor.toISOString(),
      when: inviteWhen(i.scheduledFor),
      durationMinutes: i.durationMinutes,
      location: i.location,
      interviewerName: i.interviewer?.associate ? `${i.interviewer.associate.firstName} ${i.interviewer.associate.lastName}` : null,
      confirmedAt: i.candidateConfirmedAt?.toISOString() ?? null,
    })),
    documents: docs.map((d) => ({
      id: d.id,
      label: d.label,
      note: d.note,
      status: d.status,
      fileName: d.fileName,
      uploadedAt: d.uploadedAt?.toISOString() ?? null,
      reviewNote: d.status === 'REJECTED' ? d.reviewNote : null,
    })),
  });
});

candidatePortalRouter.post('/candidate-portal/:token/interviews/:id/confirm', signedLinkIpLimiter, async (req, res) => {
  const c = await candidateByToken(req.params.token);
  const iv = await prisma.interview.findFirst({ where: { id: req.params.id, candidateId: c.id, completedAt: null } });
  if (!iv) throw new HttpError(404, 'not_found', 'Interview not found.');
  if (!iv.candidateConfirmedAt) {
    await prisma.$transaction(async (tx) => {
      await tx.interview.update({ where: { id: iv.id }, data: { candidateConfirmedAt: new Date() } });
      await recordCandidateEvent(tx, {
        candidateId: c.id,
        kind: 'INTERVIEW_CONFIRMED',
        actorUserId: null,
        body: iv.scheduledFor.toISOString(),
        metadata: { interviewId: iv.id },
      });
    });
    if (iv.interviewerUserId) {
      void notifyUser(iv.interviewerUserId, {
        subject: `${c.firstName} ${c.lastName} confirmed their interview`,
        body: `${inviteWhen(iv.scheduledFor)}${iv.location ? ` · ${iv.location}` : ''}`,
        category: 'recruiting',
        linkUrl: candidateHref(c.id),
        quiet: true,
      });
    }
  }
  res.json({ ok: true, confirmedAt: (iv.candidateConfirmedAt ?? new Date()).toISOString() });
});

/**
 * The applicant's voluntary EEO self-identification (audit 2026-10-21 #14).
 * Stored apart from the candidate; no recruiter screen reads it back — only
 * the aggregate report under /compliance does. Answering is optional, and
 * "I'd rather not say" for the whole form keeps no answers.
 */
candidatePortalRouter.post('/candidate-portal/:token/eeo', signedLinkIpLimiter, async (req, res) => {
  const c = await candidateByToken(req.params.token);
  const input = EeoSelfIdInputSchema.parse(req.body ?? {});
  await saveEeoSelfId(prisma, { candidateId: c.id }, input);
  res.json({ ok: true });
});

candidatePortalRouter.post(
  '/candidate-portal/:token/documents/:id',
  signedLinkIpLimiter,
  upload.single('file'),
  async (req: Request, res) => {
    const c = await candidateByToken(req.params.token);
    const row = await prisma.candidateDocumentRequest.findFirst({ where: { id: req.params.id, candidateId: c.id } });
    if (!row) throw new HttpError(404, 'not_found', 'Document request not found.');
    if (row.status === 'ACCEPTED') throw new HttpError(409, 'already_accepted', 'This document has already been accepted.');
    const file = req.file;
    if (!file) throw new HttpError(400, 'no_file', 'Attach a file.');
    const magic = verifyFileMagic(file.buffer, file.mimetype);
    if (magic) throw new HttpError(400, 'invalid_file', magic);
    const fileName = sanitizeUploadFilename(file.originalname);
    const key = `candidate-docs/${c.id}/${row.id}-${Date.now()}-${fileName}`;
    await getBlobStore().put(key, file.buffer, file.mimetype);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.candidateDocumentRequest.update({
        where: { id: row.id },
        data: {
          status: 'UPLOADED',
          s3Key: key,
          fileName,
          contentType: file.mimetype,
          sizeBytes: file.size,
          uploadedAt: new Date(),
          reviewNote: null,
          reviewedAt: null,
          reviewedById: null,
        },
      });
      await recordCandidateEvent(tx, {
        candidateId: c.id,
        kind: 'DOCUMENT_UPLOADED',
        actorUserId: null,
        body: row.label,
        metadata: { requestId: row.id, fileName },
      });
      return u;
    });
    void notifyAllAdmins({
      subject: `${c.firstName} ${c.lastName} uploaded ${row.label}`,
      body: `Review it on their record.`,
      category: 'documents',
      linkUrl: candidateHref(c.id),
      emailRoles: ADMIN_EMAIL_HIRING,
    });
    res.status(201).json({ ok: true, status: updated.status, fileName, uploadedAt: updated.uploadedAt?.toISOString() ?? null });
  },
);
