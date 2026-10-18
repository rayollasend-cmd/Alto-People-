import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, WotcStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAnyCapability, requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertCanModifyApplication, scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import { markTaskDoneByKind } from '../lib/checklist.js';
import {
  WOTC_GROUPS,
  WOTC_QUESTIONS,
  ageOn,
  creditFor,
  filingDeadline,
  firstYearProgress,
  maxCredit,
  statusAfterAnswers,
  targetGroupsFor,
  zipDesignation,
  type WotcAnswers,
} from '../lib/wotc.js';
import { render8850Pdf } from '../lib/wotc8850Pdf.js';
import { csvCell } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';

/**
 * WOTC (TAXCOMP 2026-10).
 *
 *   applicant  GET|POST /wotc/applications/:id       the screening questions
 *              (the onboarding task) — answered, or declined, and signed
 *   HR         GET  /wotc/summary                     the dashboard numbers
 *              GET  /wotc/screenings                  the tracker
 *              GET  /wotc/screenings/:id              one screening, answers included
 *              PATCH /wotc/screenings/:id/employer    the employer's section
 *              POST /wotc/screenings/:id/submitted    filed with the state agency
 *              POST /wotc/screenings/:id/outcome      certified or denied
 *              GET  /wotc/screenings/:id/8850.pdf     the form, filled
 *              GET  /wotc/export.csv                  ETA 9061 data, per state
 *              GET|PUT /wotc/settings                 screening on or off
 *              GET|PUT /wotc/zips                     empowerment zones / rural renewal counties
 */

export const wotcRouter = Router();

const HR = requireAnyCapability('process:payroll', 'manage:onboarding');
const DAY = 86_400_000;
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const answersOf = (v: Prisma.JsonValue | null): WotcAnswers => (v && typeof v === 'object' && !Array.isArray(v) ? (v as WotcAnswers) : {});

/* ----- The applicant ------------------------------------------------------ */

wotcRouter.get('/wotc/applications/:id', requireAuth, async (req, res) => {
  const app = await assertCanModifyApplication(prisma, req.user!, req.params.id);
  const screening = await prisma.wotcScreening.findUnique({ where: { applicationId: app.id } });
  res.json({
    questions: WOTC_QUESTIONS,
    screening: screening
      ? {
          status: screening.status,
          answers: answersOf(screening.answers),
          signedName: screening.applicantSignedName,
          signedAt: screening.applicantSignedAt?.toISOString() ?? null,
        }
      : null,
  });
});

const Answer = z.enum(['yes', 'no', 'unsure']);
const ApplicantInput = z.discriminatedUnion('declined', [
  z.object({ declined: z.literal(true), signedName: z.string().trim().min(2).max(200) }),
  z.object({
    declined: z.literal(false),
    signedName: z.string().trim().min(2).max(200),
    answers: z.object(Object.fromEntries(WOTC_QUESTIONS.map((q) => [q, Answer.optional()])) as Record<(typeof WOTC_QUESTIONS)[number], z.ZodOptional<typeof Answer>>),
  }),
]);

wotcRouter.post('/wotc/applications/:id', requireAuth, async (req, res) => {
  const app = await assertCanModifyApplication(prisma, req.user!, req.params.id, { write: true });
  const input = ApplicantInput.parse(req.body ?? {});
  const associate = await prisma.associate.findUniqueOrThrow({ where: { id: app.associateId }, select: { dob: true, zip: true, hireDate: true } });
  const startDate = app.startDate ?? associate.hireDate ?? null;
  const answers: WotcAnswers = input.declined ? {} : input.answers;
  const groups = input.declined
    ? []
    : targetGroupsFor(answers, {
        age: ageOn(associate.dob, startDate ?? new Date()),
        zipDesignation: await zipDesignation(prisma, associate.zip),
        startDate,
      });
  const status = statusAfterAnswers(input.declined, groups);
  const data = {
    status,
    answers: answers as Prisma.InputJsonValue,
    targetGroups: groups,
    applicantSignedName: input.signedName,
    applicantSignedAt: new Date(),
    applicantIp: req.ip ?? null,
    startDate,
    hireDate: associate.hireDate ?? null,
    position: app.position ?? null,
  };
  const screening = await prisma.$transaction(async (tx) => {
    const row = await tx.wotcScreening.upsert({
      where: { applicationId: app.id },
      create: { tenantId: tenantIdForWrite(), associateId: app.associateId, applicationId: app.id, ...data },
      update: data,
    });
    const checklist = await tx.onboardingChecklist.findUnique({ where: { applicationId: app.id }, select: { id: true } });
    if (checklist) await markTaskDoneByKind(tx, checklist.id, 'WOTC_SCREENING');
    return row;
  });
  // Never the answers — they are sensitive (assistance, convictions).
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'wotc.applicant_signed', entityType: 'WotcScreening', entityId: screening.id, metadata: { associateId: app.associateId, status, declined: input.declined } },
    'wotc.applicant',
  );
  res.json({ status, signedAt: screening.applicantSignedAt?.toISOString() ?? null });
});

/* ----- HR ------------------------------------------------------------------ */

const screeningInclude = {
  associate: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      assignments: {
        where: { endedAt: null },
        take: 1,
        orderBy: { startedAt: 'desc' as const },
        select: { location: { select: { id: true, name: true, client: { select: { id: true, name: true } } } } },
      },
    },
  },
} satisfies Prisma.WotcScreeningInclude;

type ScreeningRow = Prisma.WotcScreeningGetPayload<{ include: typeof screeningInclude }>;

function view(s: ScreeningRow, progress: { hours: number; wages: number } | undefined, now: Date) {
  const deadline = filingDeadline(s.startDate);
  const place = s.associate.assignments[0]?.location ?? null;
  const group = s.certifiedGroup ?? s.targetGroups[0] ?? null;
  const est = creditFor(s.status === 'DENIED' ? null : group, progress?.hours ?? 0, progress?.wages ?? 0);
  const signedAfterOffer = !!(s.offerDate && s.applicantSignedAt && ymd(s.applicantSignedAt)! > ymd(s.offerDate)!);
  return {
    id: s.id,
    associateId: s.associateId,
    name: `${s.associate.firstName} ${s.associate.lastName}`,
    clientId: place?.client?.id ?? null,
    clientName: place?.client?.name ?? null,
    siteId: place?.id ?? null,
    siteName: place?.name ?? null,
    status: s.status,
    targetGroups: s.targetGroups.map((g) => ({ code: g, label: WOTC_GROUPS[g]?.label ?? g, maxCredit: maxCredit(g) })),
    signedAt: s.applicantSignedAt?.toISOString() ?? null,
    offerDate: ymd(s.offerDate),
    hireDate: ymd(s.hireDate),
    startDate: ymd(s.startDate),
    startingWage: s.startingWage !== null ? Number(s.startingWage) : null,
    position: s.position,
    filingState: s.filingState,
    employerComplete: !!s.employerCompletedAt,
    deadline: ymd(deadline),
    daysLeft: deadline && !s.submittedAt ? Math.ceil((deadline.getTime() - now.getTime()) / DAY) : null,
    submittedAt: s.submittedAt?.toISOString() ?? null,
    submissionRef: s.submissionRef,
    filedOnTime: s.submittedAt && deadline ? s.submittedAt.getTime() <= deadline.getTime() + DAY - 1 : null,
    certifiedAt: s.certifiedAt?.toISOString() ?? null,
    certifiedGroup: s.certifiedGroup,
    denialReason: s.denialReason,
    signedAfterOffer,
    hours: progress?.hours ?? 0,
    wages: progress?.wages ?? 0,
    creditRate: est.rate,
    estimatedCredit: est.credit,
    potentialCredit: group ? maxCredit(group) : 0,
  };
}

async function loadScreenings(req: { user?: SessionUser | undefined; query: Record<string, unknown> }, extra: Prisma.WotcScreeningWhereInput = {}) {
  const clientId = typeof req.query.clientId === 'string' && req.query.clientId ? req.query.clientId : null;
  const rows = await prisma.wotcScreening.findMany({
    where: scopeWhere<Prisma.WotcScreeningWhereInput>(
      { tenantId: tenantIdForWrite() },
      { associate: scopeActiveAssociates(req.user!, { former: true }) },
      clientId ? { associate: { assignments: { some: { endedAt: null, location: { clientId } } } } } : {},
      extra,
    ),
    include: screeningInclude,
    orderBy: [{ createdAt: 'desc' }],
    take: 2_001,
  });
  const truncated = rows.length > 2_000;
  const list = rows.slice(0, 2_000);
  const startBy = new Map(list.filter((s) => s.startDate).map((s) => [s.associateId, s.startDate!]));
  const progress = await firstYearProgress(prisma, [...startBy.keys()], startBy);
  const now = new Date();
  return { screenings: list.map((s) => view(s, progress.get(s.associateId), now)), truncated };
}

wotcRouter.get('/wotc/summary', HR, async (req, res) => {
  const { screenings, truncated } = await loadScreenings(req);
  const eligible = screenings.filter((s) => ['LIKELY_ELIGIBLE', 'SUBMITTED', 'CERTIFIED'].includes(s.status));
  const toFile = screenings.filter((s) => s.status === 'LIKELY_ELIGIBLE');
  const byPlace = new Map<string, { clientName: string | null; siteName: string | null; screened: number; eligible: number; certified: number; estimatedCredit: number }>();
  for (const s of screenings) {
    const key = `${s.clientId ?? '-'}|${s.siteId ?? '-'}`;
    const row = byPlace.get(key) ?? { clientName: s.clientName, siteName: s.siteName, screened: 0, eligible: 0, certified: 0, estimatedCredit: 0 };
    row.screened += 1;
    if (eligible.includes(s)) row.eligible += 1;
    if (s.status === 'CERTIFIED') {
      row.certified += 1;
      row.estimatedCredit += s.estimatedCredit;
    }
    byPlace.set(key, row);
  }
  const submitted = screenings.filter((s) => s.submittedAt);
  res.json({
    truncated,
    screened: screenings.filter((s) => s.status !== 'NOT_STARTED').length,
    declined: screenings.filter((s) => s.status === 'DECLINED').length,
    eligible: eligible.length,
    toFile: toFile.length,
    overdue: toFile.filter((s) => s.daysLeft !== null && s.daysLeft < 0).length,
    dueThisWeek: toFile.filter((s) => s.daysLeft !== null && s.daysLeft >= 0 && s.daysLeft <= 7).length,
    submitted: submitted.length,
    filedOnTime: submitted.filter((s) => s.filedOnTime).length,
    certified: screenings.filter((s) => s.status === 'CERTIFIED').length,
    denied: screenings.filter((s) => s.status === 'DENIED').length,
    estimatedCredit: Math.round(screenings.filter((s) => s.status === 'CERTIFIED').reduce((n, s) => n + s.estimatedCredit, 0) * 100) / 100,
    pipelineCredit: Math.round(eligible.filter((s) => s.status !== 'CERTIFIED').reduce((n, s) => n + s.potentialCredit, 0) * 100) / 100,
    byPlace: [...byPlace.values()].sort((a, b) => b.estimatedCredit - a.estimatedCredit || b.eligible - a.eligible),
  });
});

const StatusFilter = z.enum(['NOT_STARTED', 'DECLINED', 'NOT_ELIGIBLE', 'LIKELY_ELIGIBLE', 'SUBMITTED', 'CERTIFIED', 'DENIED']);

wotcRouter.get('/wotc/screenings', HR, async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? StatusFilter.parse(req.query.status) : null;
  res.json(await loadScreenings(req, status ? { status } : {}));
});

async function screeningInScope(req: { user?: SessionUser | undefined }, id: string) {
  const row = await prisma.wotcScreening.findFirst({
    where: scopeWhere<Prisma.WotcScreeningWhereInput>({ id, tenantId: tenantIdForWrite() }, { associate: scopeActiveAssociates(req.user!, { former: true }) }),
    include: screeningInclude,
  });
  if (!row) throw new HttpError(404, 'not_found', 'Screening not found.');
  return row;
}

async function oneView(req: { user?: SessionUser | undefined }, id: string) {
  const row = await screeningInScope(req, id);
  const progress = row.startDate ? (await firstYearProgress(prisma, [row.associateId], new Map([[row.associateId, row.startDate]]))).get(row.associateId) : undefined;
  return { row, view: view(row, progress, new Date()) };
}

wotcRouter.get('/wotc/screenings/:id', HR, async (req, res) => {
  const { row, view: v } = await oneView(req, z.string().uuid().parse(req.params.id));
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.screening_viewed', entityType: 'WotcScreening', entityId: row.id, metadata: { associateId: row.associateId } }, 'wotc.view');
  res.json({ screening: { ...v, answers: answersOf(row.answers), questions: WOTC_QUESTIONS } });
});

const EmployerInput = z.object({
  offerDate: z.string().date().nullable().optional(),
  hireDate: z.string().date().nullable().optional(),
  startDate: z.string().date().nullable().optional(),
  startingWage: z.number().min(0).max(1_000).nullable().optional(),
  position: z.string().trim().max(120).nullable().optional(),
  filingState: z.string().length(2).transform((s) => s.toUpperCase()).nullable().optional(),
});
const day = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00.000Z`));

wotcRouter.patch('/wotc/screenings/:id/employer', HR, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await screeningInScope(req, id);
  const input = EmployerInput.parse(req.body ?? {});
  const merged = {
    offerDate: day(input.offerDate) ?? (input.offerDate === null ? null : row.offerDate),
    hireDate: day(input.hireDate) ?? (input.hireDate === null ? null : row.hireDate),
    startDate: day(input.startDate) ?? (input.startDate === null ? null : row.startDate),
    startingWage: input.startingWage !== undefined ? input.startingWage : row.startingWage !== null ? Number(row.startingWage) : null,
    position: input.position !== undefined ? input.position : row.position,
    filingState: input.filingState !== undefined ? input.filingState : row.filingState,
  };
  const complete = !!(merged.offerDate && merged.hireDate && merged.startDate && merged.startingWage !== null && merged.position && merged.filingState);
  await prisma.wotcScreening.update({
    where: { id },
    data: {
      ...merged,
      employerCompletedAt: complete ? (row.employerCompletedAt ?? new Date()) : null,
      employerCompletedBy: complete ? (row.employerCompletedBy ?? req.user!.id) : null,
    },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.employer_section_saved', entityType: 'WotcScreening', entityId: id, metadata: { complete } }, 'wotc.employer');
  res.json({ screening: (await oneView(req, id)).view });
});

wotcRouter.post('/wotc/screenings/:id/submitted', HR, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await screeningInScope(req, id);
  const input = z.object({ submittedOn: z.string().date().optional(), reference: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
  if (row.status !== 'LIKELY_ELIGIBLE' && row.status !== 'SUBMITTED') throw new HttpError(409, 'not_eligible', 'Only a screening that points to a target group is filed.');
  if (!row.employerCompletedAt) throw new HttpError(409, 'employer_incomplete', 'Complete the employer’s section first — offer, hire and start dates, wage, position and filing state.');
  const submittedAt = input.submittedOn ? new Date(`${input.submittedOn}T12:00:00.000Z`) : new Date();
  await prisma.wotcScreening.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt, submittedBy: req.user!.id, submissionRef: input.reference } });
  await recordCriticalAudit({ actorUserId: req.user!.id, action: 'wotc.submitted', entityType: 'WotcScreening', entityId: id, metadata: { reference: input.reference, submittedAt: submittedAt.toISOString() } }, 'wotc.submitted');
  res.json({ screening: (await oneView(req, id)).view });
});

wotcRouter.post('/wotc/screenings/:id/outcome', HR, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await screeningInScope(req, id);
  const input = z
    .discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('CERTIFIED'), group: z.string().refine((g) => g in WOTC_GROUPS, 'Pick the certified target group.') }),
      z.object({ outcome: z.literal('DENIED'), reason: z.string().trim().min(3).max(500) }),
    ])
    .parse(req.body ?? {});
  if (row.status !== 'SUBMITTED' && row.status !== 'CERTIFIED' && row.status !== 'DENIED') throw new HttpError(409, 'not_submitted', 'Record the outcome after the forms are filed.');
  const data: Prisma.WotcScreeningUpdateInput =
    input.outcome === 'CERTIFIED'
      ? { status: 'CERTIFIED', certifiedAt: new Date(), certifiedGroup: input.group, deniedAt: null, denialReason: null }
      : { status: 'DENIED', deniedAt: new Date(), denialReason: input.reason, certifiedAt: null, certifiedGroup: null };
  await prisma.wotcScreening.update({ where: { id }, data });
  await recordCriticalAudit({ actorUserId: req.user!.id, action: `wotc.${input.outcome.toLowerCase()}`, entityType: 'WotcScreening', entityId: id, metadata: input }, 'wotc.outcome');
  res.json({ screening: (await oneView(req, id)).view });
});

wotcRouter.get('/wotc/screenings/:id/8850.pdf', HR, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const row = await screeningInScope(req, id);
  const [a, employer] = await Promise.all([
    prisma.associate.findUniqueOrThrow({ where: { id: row.associateId }, select: { firstName: true, lastName: true, ssnLast4: true, addressLine1: true, city: true, state: true, zip: true, dob: true, phone: true } }),
    prisma.employerOrganization.findFirst({ where: { tenantId: tenantIdForWrite(), isDefault: true }, select: { legalName: true, ein: true, city: true, state: true, zip: true } }),
  ]);
  const pdf = await render8850Pdf({
    applicant: { name: `${a.firstName} ${a.lastName}`, ssnLast4: a.ssnLast4, addressLine1: a.addressLine1, city: a.city, state: a.state, zip: a.zip, dob: ymd(a.dob), phone: a.phone },
    answers: answersOf(row.answers),
    declined: row.status === 'DECLINED',
    signedName: row.applicantSignedName,
    signedAt: row.applicantSignedAt?.toISOString() ?? null,
    employer: { name: employer?.legalName ?? 'Employer', ein: employer?.ein ?? null, addressLine1: null, city: employer?.city ?? null, state: employer?.state ?? null, zip: employer?.zip ?? null, phone: null },
    offerDate: ymd(row.offerDate),
    hireDate: ymd(row.hireDate),
    startDate: ymd(row.startDate),
    startingWage: row.startingWage !== null ? Number(row.startingWage) : null,
    position: row.position,
    targetGroups: row.targetGroups.map((g) => WOTC_GROUPS[g]?.label ?? g),
    generatedAt: (row.applicantSignedAt ?? row.createdAt).toISOString(),
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.form_downloaded', entityType: 'WotcScreening', entityId: id, metadata: { form: '8850' } }, 'wotc.pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="8850-${a.lastName}-${a.firstName}.pdf"`);
  res.send(pdf);
});

/** ETA Form 9061 data for every screening ready to file in one state — the rows a state portal's bulk upload or a WOTC partner asks for. */
wotcRouter.get('/wotc/export.csv', HR, async (req, res) => {
  const state = z.string().length(2).transform((s) => s.toUpperCase()).optional().parse(req.query.state || undefined);
  const rows = await prisma.wotcScreening.findMany({
    where: scopeWhere<Prisma.WotcScreeningWhereInput>(
      { tenantId: tenantIdForWrite(), status: 'LIKELY_ELIGIBLE', employerCompletedAt: { not: null } },
      state ? { filingState: state } : {},
      { associate: scopeActiveAssociates(req.user!, { former: true }) },
    ),
    include: { associate: { select: { firstName: true, lastName: true, ssnLast4: true, dob: true, addressLine1: true, city: true, state: true, zip: true } } },
    orderBy: { startDate: 'asc' },
  });
  const header = ['Last name', 'First name', 'SSN last 4', 'Date of birth', 'Street', 'City', 'State', 'ZIP', 'Gave information', 'Offered', 'Hired', 'Started', 'Starting wage', 'Position', 'Filing state', 'Deadline', 'Target groups'];
  const lines = rows.map((r) => [
    r.associate.lastName, r.associate.firstName, r.associate.ssnLast4 ?? '', ymd(r.associate.dob) ?? '', r.associate.addressLine1 ?? '', r.associate.city ?? '', r.associate.state ?? '', r.associate.zip ?? '',
    ymd(r.applicantSignedAt) ?? '', ymd(r.offerDate) ?? '', ymd(r.hireDate) ?? '', ymd(r.startDate) ?? '', r.startingWage !== null ? Number(r.startingWage).toFixed(2) : '', r.position ?? '', r.filingState ?? '',
    ymd(filingDeadline(r.startDate)) ?? '', r.targetGroups.map((g) => WOTC_GROUPS[g]?.label ?? g).join('; '),
  ]);
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.exported', entityType: 'WotcScreening', entityId: state ?? 'ALL', metadata: { state: state ?? null, rows: rows.length } }, 'wotc.export');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="wotc-9061-${state ?? 'all'}.csv"`);
  res.send([header, ...lines].map((l) => l.map((c) => csvCell(String(c))).join(',')).join('\n'));
});

/* ----- Settings and designated ZIPs --------------------------------------- */

wotcRouter.get('/wotc/settings', HR, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [row, zips] = await Promise.all([
    prisma.wotcSettings.findUnique({ where: { tenantId } }),
    prisma.wotcDesignatedZip.count({ where: { tenantId } }),
  ]);
  res.json({ enabled: row?.enabled ?? false, designatedZips: zips });
});

wotcRouter.put('/wotc/settings', HR, async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  await prisma.wotcSettings.upsert({ where: { tenantId }, create: { tenantId, enabled, updatedById: req.user!.id }, update: { enabled, updatedById: req.user!.id } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.settings_changed', entityType: 'WotcSettings', entityId: tenantId, metadata: { enabled } }, 'wotc.settings');
  res.json({ enabled });
});

wotcRouter.get('/wotc/zips', HR, async (_req, res) => {
  const rows = await prisma.wotcDesignatedZip.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { zip: 'asc' }, select: { zip: true, kind: true } });
  res.json({ zips: rows });
});

wotcRouter.put('/wotc/zips', HR, async (req, res) => {
  const { zips } = z
    .object({ zips: z.array(z.object({ zip: z.string().regex(/^\d{5}$/), kind: z.enum(['EZ', 'RRC']) })).max(50_000) })
    .parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const unique = [...new Map(zips.map((z2) => [z2.zip, z2])).values()];
  await prisma.$transaction([
    prisma.wotcDesignatedZip.deleteMany({ where: { tenantId } }),
    prisma.wotcDesignatedZip.createMany({ data: unique.map((z2) => ({ tenantId, zip: z2.zip, kind: z2.kind })) }),
  ]);
  enqueueAudit({ actorUserId: req.user!.id, action: 'wotc.zips_replaced', entityType: 'WotcDesignatedZip', entityId: tenantId, metadata: { count: unique.length } }, 'wotc.zips');
  res.json({ count: unique.length });
});

/** For the Inbox: screenings ready to file whose state deadline is within a week or past. */
export async function wotcFilingsDue(user: SessionUser): Promise<number> {
  const rows = await prisma.wotcScreening.findMany({
    where: scopeWhere<Prisma.WotcScreeningWhereInput>({ tenantId: tenantIdForWrite(), status: 'LIKELY_ELIGIBLE' as WotcStatus }, { associate: scopeActiveAssociates(user, { former: true }) }),
    select: { startDate: true },
  });
  const soon = Date.now() + 7 * DAY;
  return rows.filter((r) => {
    const d = filingDeadline(r.startDate);
    return !d || d.getTime() <= soon;
  }).length;
}
