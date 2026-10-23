import { Router, type Request } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { LeaveStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBlobStore, tenantBlobKey } from '../lib/blobStore.js';
import { notifyAssociate } from '../lib/notify.js';
import { assertAssociateInScope, scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { safeContentDisposition, sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { fmtDay } from '../lib/claimsPdf.js';
import {
  STATE_PROGRAMS,
  certificationRequired,
  employerNameFor,
  fmlaBalance,
  fmlaEligibility,
  isJobProtected,
  leaveSettings,
  noticePdf,
  programByCode,
  protectedLeaveNow,
  releaseShiftsForLeave,
  type FmlaEligibility,
} from '../lib/leaveOfAbsence.js';

/**
 * Leave of absence (lib/leaveOfAbsence).
 *
 *   /leave/*      HR's desk — manage:leave. Cases, notices, decisions,
 *                 intermittent usage, return to work, settings. Medical
 *                 documents are readable here only, and every read is
 *                 audited.
 *   /me/leave/*   the worker's own requests and certification uploads.
 *   /leave/people/:id/status   the job-protection flag on a person record.
 */

export const leaveRouter = Router();

const MANAGE = requireCapability('manage:leave');
const VIEW_ORG = requireCapability('view:org');
const DAY_MS = 86_400_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Upload a PDF or a photo (PNG, JPEG or WebP).'));
      return;
    }
    cb(null, true);
  },
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const today = () => day(new Date().toISOString().slice(0, 10));

const CaseInput = z.object({
  type: z.enum(['FMLA', 'STATE_PFML', 'MILITARY_USERRA', 'ADA_ACCOMMODATION', 'PERSONAL', 'COMPANY']),
  reason: z.enum(['OWN_HEALTH', 'FAMILY_CARE', 'BONDING', 'PREGNANCY', 'MILITARY_EXIGENCY', 'MILITARY_CAREGIVER', 'MILITARY_SERVICE', 'ACCOMMODATION', 'OTHER']),
  stateProgram: z.string().max(20).nullable().optional(),
  schedule: z.enum(['CONTINUOUS', 'INTERMITTENT', 'REDUCED']).default('CONTINUOUS'),
  startDate: dateOnly,
  endDate: dateOnly.nullable().optional(),
  intermittentPattern: z.string().trim().max(300).nullable().optional(),
  reducedHoursPerWeek: z.number().min(0).max(80).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

function validateCase(input: z.infer<typeof CaseInput>) {
  if (input.endDate && input.endDate < input.startDate) throw new HttpError(400, 'invalid_dates', 'The end date is before the start date.');
  if (input.type === 'STATE_PFML' && !programByCode(input.stateProgram)) throw new HttpError(400, 'program_required', 'Pick the state program for state paid leave.');
}

const CASE_INCLUDE = {
  associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true, state: true } },
  documents: { select: { id: true, kind: true, filename: true, mimeType: true, size: true, createdAt: true, uploadedById: true } },
  usage: { orderBy: { date: 'desc' as const }, select: { id: true, date: true, hours: true, shiftId: true, note: true, createdAt: true } },
} satisfies Prisma.LeaveCaseInclude;

type CaseRow = Prisma.LeaveCaseGetPayload<{ include: typeof CASE_INCLUDE }>;

/** What a case still needs, in order — the "next step" HR sees. */
function nextStep(c: CaseRow, now: Date): { key: string; label: string; dueAt: string | null; overdue: boolean } | null {
  const due = (d: Date | null) => (d ? { dueAt: fmtDay(d), overdue: d.getTime() < now.getTime() - DAY_MS } : { dueAt: null, overdue: false });
  switch (c.status) {
    case 'REQUESTED': {
      // The eligibility notice is owed within 5 business days of the request (≈ 7 calendar days).
      return { key: 'notice', label: 'Send the eligibility notice', ...due(new Date(c.createdAt.getTime() + 7 * DAY_MS)) };
    }
    case 'PENDING_CERTIFICATION':
      return c.certificationReceivedAt
        ? { key: 'decide', label: 'Review the certification and decide', ...due(new Date(c.certificationReceivedAt.getTime() + 5 * DAY_MS)) }
        : { key: 'certification', label: 'Certification due from the employee', ...due(c.certificationDueAt) };
    case 'APPROVED': {
      if (c.fitnessForDutyRequired && !c.fitnessForDutyReceivedAt && c.expectedReturnDate) return { key: 'fitness', label: 'Fitness-for-duty certification before return', ...due(c.expectedReturnDate) };
      const back = c.expectedReturnDate ?? c.endDate;
      return back ? { key: 'return', label: 'Confirm the return to work', ...due(back) } : null;
    }
    case 'RETURNED':
      return { key: 'close', label: 'Close the case', dueAt: null, overdue: false };
    default:
      return null;
  }
}

function view(c: CaseRow, now = new Date()) {
  const program = programByCode(c.stateProgram);
  return {
    id: c.id,
    associateId: c.associateId,
    associateName: `${c.associate.firstName} ${c.associate.lastName}`,
    type: c.type,
    reason: c.reason,
    stateProgram: c.stateProgram,
    stateProgramName: program?.name ?? null,
    schedule: c.schedule,
    startDate: fmtDay(c.startDate),
    endDate: c.endDate ? fmtDay(c.endDate) : null,
    intermittentPattern: c.intermittentPattern,
    reducedHoursPerWeek: c.reducedHoursPerWeek === null ? null : Number(c.reducedHoursPerWeek),
    status: c.status,
    requestedBySelf: c.requestedBySelf,
    eligibility: (c.eligibility as FmlaEligibility | null) ?? null,
    noticeSentAt: c.noticeSentAt?.toISOString() ?? null,
    designationSentAt: c.designationSentAt?.toISOString() ?? null,
    designatedFmla: c.designatedFmla,
    certificationRequired: certificationRequired(c),
    certificationDueAt: c.certificationDueAt ? fmtDay(c.certificationDueAt) : null,
    certificationReceivedAt: c.certificationReceivedAt?.toISOString() ?? null,
    decidedAt: c.decidedAt?.toISOString() ?? null,
    decisionNote: c.decisionNote,
    fitnessForDutyRequired: c.fitnessForDutyRequired,
    fitnessForDutyReceivedAt: c.fitnessForDutyReceivedAt?.toISOString() ?? null,
    expectedReturnDate: c.expectedReturnDate ? fmtDay(c.expectedReturnDate) : null,
    actualReturnDate: c.actualReturnDate ? fmtDay(c.actualReturnDate) : null,
    benefitsNote: c.benefitsNote,
    shiftsReleased: c.shiftsReleased,
    jobProtected: isJobProtected(c) && ['PENDING_CERTIFICATION', 'APPROVED'].includes(c.status),
    notes: c.notes,
    documents: c.documents.map((d) => ({ id: d.id, kind: d.kind, filename: d.filename, mimeType: d.mimeType, size: d.size, createdAt: d.createdAt.toISOString() })),
    usage: c.usage.map((u) => ({ id: u.id, date: fmtDay(u.date), hours: Number(u.hours), shiftId: u.shiftId, note: u.note })),
    usedHours: c.usage.reduce((t, u) => t + Number(u.hours), 0),
    next: nextStep(c, now),
    createdAt: c.createdAt.toISOString(),
  };
}

/** A case HR may act on: in their tenant and inside their reach. */
async function loadCase(req: Request, id: string): Promise<CaseRow> {
  const c = await prisma.leaveCase.findFirst({
    where: { id, tenantId: tenantIdForWrite(), associate: scopeActiveAssociates(req.user!, { former: true }) },
    include: CASE_INCLUDE,
  });
  if (!c) throw new HttpError(404, 'leave_not_found', 'Leave case not found.');
  return c;
}

async function snapshotEligibility(associateId: string, type: string, startDate: Date): Promise<FmlaEligibility | null> {
  if (type !== 'FMLA') return null;
  return fmlaEligibility(associateId, startDate);
}

/* ===== Programs & settings ================================================ */

leaveRouter.get('/leave/programs', (_req, res) => {
  res.json({ programs: STATE_PROGRAMS });
});

leaveRouter.get('/leave/settings', MANAGE, async (_req, res) => {
  const s = await leaveSettings();
  res.json({
    fmlaYearMethod: s.fmlaYearMethod,
    fmlaFixedYearStart: s.fmlaFixedYearStart,
    fmlaCoveredEmployer: s.fmlaCoveredEmployer,
    worksiteAttestation: s.worksiteAttestation,
    suiImpactFactor: Number(s.suiImpactFactor),
    uiResponseDays: s.uiResponseDays,
    froiDeadlineDays: s.froiDeadlineDays,
  });
});

const SettingsInput = z.object({
  fmlaYearMethod: z.enum(['ROLLING_BACKWARD', 'ROLLING_FORWARD', 'CALENDAR', 'FIXED']).optional(),
  fmlaFixedYearStart: z.string().regex(/^\d{2}-\d{2}$/).nullable().optional(),
  fmlaCoveredEmployer: z.boolean().optional(),
  worksiteAttestation: z.record(z.string(), z.boolean()).optional(),
});

leaveRouter.put('/leave/settings', MANAGE, async (req, res) => {
  const input = SettingsInput.parse(req.body ?? {});
  if (input.fmlaYearMethod === 'FIXED' && !input.fmlaFixedYearStart) throw new HttpError(400, 'fixed_start_required', 'A fixed leave year needs its start (MM-DD).');
  const s = await leaveSettings();
  await prisma.leaveSettings.update({ where: { id: s.id }, data: { ...input, updatedById: req.user!.id } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.settings_updated', entityType: 'LeaveSettings', entityId: s.id, metadata: input }, 'leave');
  res.json({ ok: true });
});

/* ===== HR desk ============================================================== */

/**
 * The four desk tiles, each one definition: the summary counts with it and
 * the case list filters by it (F500 G2: the tiles are the filter), so a
 * tile's number and the rows it shows always agree.
 */
type LeaveLens = 'on-leave' | 'notices' | 'certs-due' | 'returning';
function lensWhere(lens: LeaveLens, t: Date): Prisma.LeaveCaseWhereInput {
  const week = new Date(t.getTime() + 7 * DAY_MS);
  switch (lens) {
    case 'on-leave':
      return { status: 'APPROVED', startDate: { lte: t }, OR: [{ endDate: null }, { endDate: { gte: t } }] };
    case 'notices':
      return { status: 'REQUESTED' };
    case 'certs-due':
      return { status: 'PENDING_CERTIFICATION', certificationReceivedAt: null, certificationDueAt: { lte: week } };
    case 'returning':
      return { status: 'APPROVED', actualReturnDate: null, OR: [{ expectedReturnDate: { lte: week } }, { expectedReturnDate: null, endDate: { lte: week } }] };
  }
}

leaveRouter.get('/leave/summary', MANAGE, async (req, res) => {
  const now = new Date();
  const t = today();
  const base: Prisma.LeaveCaseWhereInput = { tenantId: tenantIdForWrite(), associate: scopeActiveAssociates(req.user!, { former: true }) };
  const lens = (l: LeaveLens) => prisma.leaveCase.count({ where: scopeWhere<Prisma.LeaveCaseWhereInput>(base, lensWhere(l, t)) });
  const [open, onLeave, certDue, noticeOwed, returning] = await Promise.all([
    prisma.leaveCase.count({ where: { ...base, status: { in: ['REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED'] } } }),
    lens('on-leave'),
    lens('certs-due'),
    lens('notices'),
    lens('returning'),
  ]);
  res.json({ open, onLeave, certificationsDueThisWeek: certDue, noticesOwed: noticeOwed, returningThisWeek: returning, asOf: now.toISOString() });
});

const ListQuery = z.object({
  status: z
    .enum(['open', 'all', 'REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED', 'DENIED', 'RETURNED', 'CLOSED', 'CANCELLED', 'on-leave', 'notices', 'certs-due', 'returning'])
    .default('open'),
  type: z.enum(['FMLA', 'STATE_PFML', 'MILITARY_USERRA', 'ADA_ACCOMMODATION', 'PERSONAL', 'COMPANY']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

leaveRouter.get('/leave/cases', MANAGE, async (req, res) => {
  const q = ListQuery.parse(req.query);
  const statusFilter: Prisma.LeaveCaseWhereInput =
    q.status === 'open'
      ? { status: { in: ['REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED', 'RETURNED'] } }
      : q.status === 'all'
        ? {}
        : q.status === 'on-leave' || q.status === 'notices' || q.status === 'certs-due' || q.status === 'returning'
          ? lensWhere(q.status, today())
          : { status: q.status as LeaveStatus };
  const where = scopeWhere<Prisma.LeaveCaseWhereInput>(
    { tenantId: tenantIdForWrite() },
    { associate: scopeActiveAssociates(req.user!, { former: true }) },
    statusFilter,
    q.type ? { type: q.type } : null,
    q.q ? { associate: { OR: [{ firstName: { contains: q.q, mode: 'insensitive' } }, { lastName: { contains: q.q, mode: 'insensitive' } }] } } : null,
  );
  const PAGE = 50;
  const [rows, total] = await Promise.all([
    prisma.leaveCase.findMany({ where, include: CASE_INCLUDE, orderBy: [{ startDate: 'desc' }], skip: (q.page - 1) * PAGE, take: PAGE }),
    prisma.leaveCase.count({ where }),
  ]);
  const now = new Date();
  // Most urgent first: overdue next steps, then by due date.
  const cases = rows.map((r) => view(r, now)).sort((a, b) => {
    const ao = a.next?.overdue ? 0 : 1;
    const bo = b.next?.overdue ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (a.next?.dueAt ?? '9999').localeCompare(b.next?.dueAt ?? '9999');
  });
  res.json({ cases, total, page: q.page, pageSize: PAGE, hasMore: q.page * PAGE < total });
});

leaveRouter.get('/leave/eligibility/:associateId', MANAGE, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const start = req.query.startDate ? day(dateOnly.parse(req.query.startDate)) : today();
  const eligibility = await fmlaEligibility(associateId, start);
  const balance = await fmlaBalance(associateId, start);
  res.json({ eligibility, balance });
});

leaveRouter.get('/leave/cases/:id', MANAGE, async (req, res) => {
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  const balance = c.type === 'FMLA' ? await fmlaBalance(c.associateId, new Date(), prisma, { militaryCaregiver: c.reason === 'MILITARY_CAREGIVER' }) : null;
  res.json({ case: view(c), balance });
});

leaveRouter.post('/leave/cases', MANAGE, async (req, res) => {
  const input = CaseInput.extend({ associateId: z.string().uuid() }).parse(req.body ?? {});
  validateCase(input);
  await assertAssociateInScope(prisma, req.user!, input.associateId, { former: false });
  const start = day(input.startDate);
  const eligibility = await snapshotEligibility(input.associateId, input.type, start);
  const created = await prisma.leaveCase.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId: input.associateId,
      type: input.type,
      reason: input.reason,
      stateProgram: input.type === 'STATE_PFML' ? input.stateProgram ?? null : null,
      schedule: input.schedule,
      startDate: start,
      endDate: input.endDate ? day(input.endDate) : null,
      expectedReturnDate: input.endDate ? new Date(day(input.endDate).getTime() + DAY_MS) : null,
      intermittentPattern: input.intermittentPattern ?? null,
      reducedHoursPerWeek: input.reducedHoursPerWeek ?? null,
      notes: input.notes ?? null,
      requestedById: req.user!.id,
      eligibility: (eligibility ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    include: CASE_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.case_opened', entityType: 'LeaveCase', entityId: created.id, metadata: { associateId: input.associateId, type: input.type, schedule: input.schedule } }, 'leave');
  res.status(201).json({ case: view(created) });
});

/** Send the eligibility & rights notice (WH-381 content); start the certification clock. */
leaveRouter.post('/leave/cases/:id/notice', MANAGE, async (req, res) => {
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  if (c.status !== 'REQUESTED' && c.status !== 'PENDING_CERTIFICATION') throw new HttpError(409, 'not_open', 'The notice goes out before a decision.');
  const needsCert = certificationRequired(c);
  const updated = await prisma.leaveCase.update({
    where: { id: c.id },
    data: {
      noticeSentAt: new Date(),
      status: needsCert ? 'PENDING_CERTIFICATION' : c.status,
      certificationDueAt: needsCert ? c.certificationDueAt ?? new Date(today().getTime() + 15 * DAY_MS) : null,
    },
    include: CASE_INCLUDE,
  });
  void notifyAssociate(c.associateId, {
    subject: 'Your leave request: next steps',
    body: needsCert
      ? `We received your leave request. Please return your certification by ${fmtDay(updated.certificationDueAt)}. Your notice explains your rights.`
      : 'We received your leave request. Your notice explains your rights; we’ll be in touch with a decision.',
    category: 'hr',
    linkUrl: '/leave',
    emailFallback: true,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.notice_sent', entityType: 'LeaveCase', entityId: c.id, metadata: { kind: 'eligibility' } }, 'leave');
  res.json({ case: view(updated) });
});

const DecideInput = z.object({
  decision: z.enum(['APPROVE', 'DENY']),
  designatedFmla: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
  fitnessForDutyRequired: z.boolean().optional(),
  benefitsNote: z.string().trim().max(1000).optional(),
  expectedReturnDate: dateOnly.nullable().optional(),
});

leaveRouter.post('/leave/cases/:id/decide', MANAGE, async (req, res) => {
  const input = DecideInput.parse(req.body ?? {});
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  if (c.status !== 'REQUESTED' && c.status !== 'PENDING_CERTIFICATION') throw new HttpError(409, 'already_decided', 'This case has already been decided.');
  if (input.decision === 'DENY' && !input.note) throw new HttpError(400, 'reason_required', 'Say why the leave is denied — it goes on the designation notice.');
  const approve = input.decision === 'APPROVE';
  const updated = await prisma.leaveCase.update({
    where: { id: c.id },
    data: {
      status: approve ? 'APPROVED' : 'DENIED',
      decidedAt: new Date(),
      decidedById: req.user!.id,
      decisionNote: input.note ?? null,
      designationSentAt: new Date(),
      // FMLA protection follows eligibility unless HR says otherwise on purpose.
      designatedFmla: c.type === 'FMLA' ? (input.designatedFmla ?? (approve && ((c.eligibility as FmlaEligibility | null)?.eligible ?? true))) : null,
      fitnessForDutyRequired: input.fitnessForDutyRequired ?? (c.reason === 'OWN_HEALTH' && c.schedule === 'CONTINUOUS'),
      benefitsNote: input.benefitsNote ?? c.benefitsNote,
      expectedReturnDate: input.expectedReturnDate ? day(input.expectedReturnDate) : c.expectedReturnDate,
    },
    include: CASE_INCLUDE,
  });
  let released = 0;
  if (approve) {
    released = await releaseShiftsForLeave(prisma, updated, `${c.associate.firstName} ${c.associate.lastName}`);
    if (released) await prisma.leaveCase.update({ where: { id: c.id }, data: { shiftsReleased: released } });
  }
  void notifyAssociate(c.associateId, {
    subject: approve ? 'Your leave is approved' : 'Your leave request was not approved',
    body: approve
      ? `Your leave from ${fmtDay(c.startDate)} is approved${updated.fitnessForDutyRequired ? '. Before you return, we need a fitness-for-duty note from your provider' : ''}. Your designation notice has the details.`
      : `Your leave request was not approved: ${input.note}. Your designation notice has the details; talk to HR if you have questions.`,
    category: 'hr',
    linkUrl: '/leave',
    emailFallback: true,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: approve ? 'leave.approved' : 'leave.denied', entityType: 'LeaveCase', entityId: c.id, metadata: { designatedFmla: updated.designatedFmla, shiftsReleased: released } }, 'leave');
  res.json({ case: view({ ...updated, shiftsReleased: released || updated.shiftsReleased }) });
});

const UsageInput = z.object({ date: dateOnly, hours: z.number().positive().max(24), shiftId: z.string().uuid().nullable().optional(), note: z.string().trim().max(500).nullable().optional() });

/** Intermittent / reduced-schedule time, logged one absence at a time. */
leaveRouter.post('/leave/cases/:id/usage', MANAGE, async (req, res) => {
  const input = UsageInput.parse(req.body ?? {});
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  if (c.status !== 'APPROVED') throw new HttpError(409, 'not_approved', 'Log usage against approved leave.');
  if (c.schedule === 'CONTINUOUS') throw new HttpError(409, 'continuous', 'Continuous leave counts itself — usage is for intermittent or reduced schedules.');
  const d = day(input.date);
  if (d < c.startDate || (c.endDate && d > c.endDate)) throw new HttpError(400, 'outside_leave', 'That date is outside the approved leave.');
  if (input.shiftId) {
    const shift = await prisma.shift.findFirst({ where: { id: input.shiftId, tenantId: tenantIdForWrite(), assignedAssociateId: c.associateId }, select: { id: true } });
    if (!shift) throw new HttpError(404, 'shift_not_found', 'That shift isn’t theirs.');
  }
  await prisma.leaveUsage.create({ data: { tenantId: tenantIdForWrite(), leaveCaseId: c.id, date: d, hours: input.hours, shiftId: input.shiftId ?? null, note: input.note ?? null, createdById: req.user!.id } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.usage_logged', entityType: 'LeaveCase', entityId: c.id, metadata: { date: input.date, hours: input.hours } }, 'leave');
  res.status(201).json({ case: view(await loadCase(req, c.id)) });
});

leaveRouter.post('/leave/cases/:id/return', MANAGE, async (req, res) => {
  const input = z.object({ actualReturnDate: dateOnly, overrideReason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  if (c.status !== 'APPROVED') throw new HttpError(409, 'not_on_leave', 'Only approved leave can end in a return to work.');
  if (c.fitnessForDutyRequired && !c.fitnessForDutyReceivedAt && !input.overrideReason) {
    throw new HttpError(409, 'fitness_for_duty_missing', 'The fitness-for-duty certification hasn’t arrived. Upload it, or record why they may return without it.');
  }
  const updated = await prisma.leaveCase.update({
    where: { id: c.id },
    data: { status: 'RETURNED', actualReturnDate: day(input.actualReturnDate), notes: input.overrideReason ? [c.notes, `Returned without fitness-for-duty: ${input.overrideReason}`].filter(Boolean).join('\n') : c.notes },
    include: CASE_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.returned', entityType: 'LeaveCase', entityId: c.id, metadata: { actualReturnDate: input.actualReturnDate, override: !!input.overrideReason } }, 'leave');
  res.json({ case: view(updated) });
});

for (const [path, to, from] of [
  ['close', 'CLOSED', ['RETURNED', 'DENIED', 'APPROVED']],
  ['cancel', 'CANCELLED', ['REQUESTED', 'PENDING_CERTIFICATION']],
] as const) {
  leaveRouter.post(`/leave/cases/:id/${path}`, MANAGE, async (req, res) => {
    const c = await loadCase(req, z.string().uuid().parse(req.params.id));
    if (!(from as readonly string[]).includes(c.status)) throw new HttpError(409, 'wrong_status', path === 'close' ? 'Close a case once it has ended.' : 'Only an undecided request can be cancelled.');
    const updated = await prisma.leaveCase.update({ where: { id: c.id }, data: { status: to }, include: CASE_INCLUDE });
    enqueueAudit({ actorUserId: req.user!.id, action: `leave.${path}`, entityType: 'LeaveCase', entityId: c.id, metadata: {} }, 'leave');
    res.json({ case: view(updated) });
  });
}

/** Notice PDFs — HR's copy. The worker reads theirs at /me/leave/:id/notices/:kind. */
leaveRouter.get('/leave/cases/:id/notices/:kind', MANAGE, async (req, res) => {
  const kind = z.enum(['eligibility', 'designation']).parse(req.params.kind);
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  await sendNotice(res, kind, c);
});

async function sendNotice(res: import('express').Response, kind: 'eligibility' | 'designation', c: CaseRow) {
  if (kind === 'designation' && !c.designationSentAt) throw new HttpError(409, 'not_decided', 'The designation notice exists once the leave is decided.');
  const [employerName, balance] = await Promise.all([
    employerNameFor(prisma, c.associateId),
    c.type === 'FMLA' ? fmlaBalance(c.associateId, new Date(), prisma, { militaryCaregiver: c.reason === 'MILITARY_CAREGIVER' }) : Promise.resolve(null),
  ]);
  const pdf = await noticePdf(kind, c, { employerName, eligibility: (c.eligibility as FmlaEligibility | null) ?? null, balance });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition(`${kind === 'eligibility' ? 'eligibility-notice' : 'designation-notice'}-${fmtDay(c.startDate)}.pdf`, true));
  res.send(pdf);
}

/* ===== Documents (medical — leave admins only) =============================== */

async function storeDocument(req: Request, c: { id: string }, kind: 'MEDICAL_CERTIFICATION' | 'FITNESS_FOR_DUTY' | 'MILITARY_ORDERS' | 'OTHER') {
  if (!req.file) throw new HttpError(400, 'file_required', 'Attach the document.');
  const magic = verifyFileMagic(req.file.buffer, req.file.mimetype);
  if (magic) throw new HttpError(400, 'invalid_file_contents', magic);
  const clean = sanitizeUploadFilename(req.file.originalname);
  const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
  const key = tenantBlobKey(`leave/${randomUUID()}-${sha}${extname(clean).toLowerCase()}`);
  await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
  const doc = await prisma.leaveDocument.create({
    data: { tenantId: tenantIdForWrite(), leaveCaseId: c.id, kind, storageKey: key, filename: clean, mimeType: req.file.mimetype, size: req.file.size, uploadedById: req.user!.id },
  });
  const now = new Date();
  if (kind === 'MEDICAL_CERTIFICATION' || kind === 'MILITARY_ORDERS') await prisma.leaveCase.update({ where: { id: c.id }, data: { certificationReceivedAt: now } });
  if (kind === 'FITNESS_FOR_DUTY') await prisma.leaveCase.update({ where: { id: c.id }, data: { fitnessForDutyReceivedAt: now } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.document_uploaded', entityType: 'LeaveCase', entityId: c.id, metadata: { documentId: doc.id, kind } }, 'leave');
  return doc;
}

const DocKind = z.enum(['MEDICAL_CERTIFICATION', 'FITNESS_FOR_DUTY', 'MILITARY_ORDERS', 'OTHER']);

leaveRouter.post('/leave/cases/:id/documents', MANAGE, upload.single('file'), async (req, res) => {
  const c = await loadCase(req, z.string().uuid().parse(req.params.id));
  const doc = await storeDocument(req, c, DocKind.parse(req.body?.kind));
  res.status(201).json({ id: doc.id, case: view(await loadCase(req, c.id)) });
});

leaveRouter.get('/leave/documents/:docId', MANAGE, async (req, res) => {
  const doc = await prisma.leaveDocument.findFirst({
    where: { id: z.string().uuid().parse(req.params.docId), tenantId: tenantIdForWrite(), leaveCase: { associate: scopeActiveAssociates(req.user!, { former: true }) } },
  });
  if (!doc) throw new HttpError(404, 'document_not_found', 'Document not found.');
  const buf = await getBlobStore().get(doc.storageKey);
  if (!buf) throw new HttpError(404, 'document_missing', 'The file is missing from storage.');
  // Medical information: every read leaves a trace.
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.document_read', entityType: 'LeaveDocument', entityId: doc.id, metadata: { leaveCaseId: doc.leaveCaseId, kind: doc.kind } }, 'leave');
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', safeContentDisposition(doc.filename, false));
  res.send(buf);
});

/* ===== The worker's own =================================================== */

async function ownCase(req: Request, id: string): Promise<CaseRow> {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_person_record', 'Your account isn’t linked to a person record.');
  const c = await prisma.leaveCase.findFirst({ where: { id, associateId, tenantId: tenantIdForWrite() }, include: CASE_INCLUDE });
  if (!c) throw new HttpError(404, 'leave_not_found', 'Leave request not found.');
  return c;
}

/** What the worker sees of a case: never HR's notes or other people's uploads. */
function ownView(c: CaseRow, viewerUserId: string) {
  const v = view(c);
  return {
    id: v.id,
    type: v.type,
    reason: v.reason,
    stateProgramName: v.stateProgramName,
    schedule: v.schedule,
    startDate: v.startDate,
    endDate: v.endDate,
    status: v.status,
    certificationRequired: v.certificationRequired,
    certificationDueAt: v.certificationDueAt,
    certificationReceived: !!v.certificationReceivedAt,
    fitnessForDutyRequired: v.fitnessForDutyRequired,
    fitnessForDutyReceived: !!v.fitnessForDutyReceivedAt,
    noticeAvailable: !!v.noticeSentAt,
    designationAvailable: !!v.designationSentAt,
    decisionNote: v.status === 'DENIED' ? v.decisionNote : null,
    expectedReturnDate: v.expectedReturnDate,
    jobProtected: v.jobProtected,
    // Their own uploads only — never a document HR attached.
    documents: c.documents.filter((d) => d.uploadedById === viewerUserId).map((d) => ({ id: d.id, kind: d.kind, filename: d.filename, createdAt: d.createdAt.toISOString() })),
    createdAt: v.createdAt,
  };
}

leaveRouter.get('/me/leave', async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) {
    res.json({ cases: [], linked: false });
    return;
  }
  const rows = await prisma.leaveCase.findMany({ where: { associateId, tenantId: tenantIdForWrite() }, include: CASE_INCLUDE, orderBy: { startDate: 'desc' }, take: 50 });
  res.json({ cases: rows.map((r) => ownView(r, req.user!.id)), linked: true });
});

leaveRouter.post('/me/leave', async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_person_record', 'Your account isn’t linked to a person record.');
  const input = CaseInput.parse(req.body ?? {});
  validateCase(input);
  const start = day(input.startDate);
  const eligibility = await snapshotEligibility(associateId, input.type, start);
  const created = await prisma.leaveCase.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId,
      type: input.type,
      reason: input.reason,
      stateProgram: input.type === 'STATE_PFML' ? input.stateProgram ?? null : null,
      schedule: input.schedule,
      startDate: start,
      endDate: input.endDate ? day(input.endDate) : null,
      expectedReturnDate: input.endDate ? new Date(day(input.endDate).getTime() + DAY_MS) : null,
      intermittentPattern: input.intermittentPattern ?? null,
      notes: input.notes ?? null,
      requestedById: req.user!.id,
      requestedBySelf: true,
      eligibility: (eligibility ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    include: CASE_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'leave.requested', entityType: 'LeaveCase', entityId: created.id, metadata: { type: input.type, schedule: input.schedule } }, 'leave');
  res.status(201).json({ case: ownView(created, req.user!.id) });
});

leaveRouter.post('/me/leave/:id/documents', upload.single('file'), async (req, res) => {
  const c = await ownCase(req, z.string().uuid().parse(req.params.id));
  const kind = DocKind.parse(req.body?.kind ?? 'MEDICAL_CERTIFICATION');
  const doc = await storeDocument(req, c, kind);
  res.status(201).json({ id: doc.id, case: ownView(await ownCase(req, c.id), req.user!.id) });
});

leaveRouter.get('/me/leave/:id/notices/:kind', async (req, res) => {
  const kind = z.enum(['eligibility', 'designation']).parse(req.params.kind);
  const c = await ownCase(req, z.string().uuid().parse(req.params.id));
  if (kind === 'eligibility' && !c.noticeSentAt) throw new HttpError(409, 'not_sent', 'HR hasn’t sent this notice yet.');
  await sendNotice(res, kind, c);
});

/* ===== The person record =================================================== */

leaveRouter.get('/leave/people/:associateId/status', VIEW_ORG, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  res.json({ protectedLeave: await protectedLeaveNow(prisma, associateId) });
});
