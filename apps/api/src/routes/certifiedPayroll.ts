import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertAssociateInScope, assertSiteInScope, internalSites, scopeWhere } from '../lib/scope.js';
import { defaultEmployerOrg } from '../lib/employment.js';
import { buildEcprXml, computeCertifiedWeek, endedWeeks, weekBounds, weekEndingFor, type CertifiedWeek } from '../lib/certifiedPayroll.js';
import { hashWh347, renderWh347Pdf } from '../lib/wh347Pdf.js';
import type { SessionUser } from '../types/express.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * Certified payroll desk: public-works projects, their wage determination
 * rates, the workers on them, and each week's WH-347 with its signed
 * Statement of Compliance (and the California eCPR XML).
 *
 * Mounted at /certified-payroll behind process:payroll. A site-bound
 * office account sees only projects at its sites.
 */
export const certifiedPayrollRouter = Router();

const DAY = 86_400_000;
/** Project, rate, worker and week-ending dates are @db.Date columns: their UTC date is the day. */
const ymd = dateColumnKey;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const money = z.coerce.number().min(0).max(9999);

function projectScope(user: SessionUser): Prisma.PrevailingWageProjectWhereInput {
  const sites = internalSites(user);
  return scopeWhere<Prisma.PrevailingWageProjectWhereInput>({ tenantId: tenantIdForWrite() }, sites && { site: { is: sites } });
}

async function loadProject(req: Request, id: string) {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new HttpError(404, 'not_found', 'Project not found.');
  const project = await prisma.prevailingWageProject.findFirst({
    where: scopeWhere<Prisma.PrevailingWageProjectWhereInput>(projectScope(req.user!), { id: parsed.data }),
    include: {
      rates: { orderBy: [{ classification: 'asc' }, { effectiveFrom: 'desc' }] },
      workers: { orderBy: { startedOn: 'asc' } },
      site: { select: { id: true, name: true, timezone: true } },
    },
  });
  if (!project) throw new HttpError(404, 'not_found', 'Project not found.');
  return project;
}

function parseWeek(project: { weekEndsOn: number }, weekEnding: string): string {
  try {
    weekBounds(weekEnding, project.weekEndsOn);
  } catch (e) {
    const code = e instanceof Error ? e.message : 'bad_week';
    throw new HttpError(400, code === 'week_end_day' ? 'week_end_day' : 'bad_week', code === 'week_end_day' ? "That date isn't the last day of this project's reporting week." : 'Use a week-ending date as YYYY-MM-DD.');
  }
  return weekEnding;
}

/* ----- Projects -------------------------------------------------------------- */

certifiedPayrollRouter.get('/projects', async (req, res, next) => {
  try {
    const projects = await prisma.prevailingWageProject.findMany({
      where: projectScope(req.user!),
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        site: { select: { id: true, name: true } },
        reports: { select: { weekEnding: true, status: true } },
        _count: { select: { workers: true } },
      },
    });
    const now = new Date();
    res.json({
      projects: projects.map((p) => {
        const byWeek = new Map(p.reports.map((r) => [ymd(r.weekEnding), r.status]));
        const weeks = p.status === 'ACTIVE' || p.status === 'CLOSED' ? endedWeeks(p, now) : [];
        const due = weeks.filter((w) => byWeek.get(w) !== 'SUBMITTED');
        return {
          id: p.id,
          name: p.name,
          contractNumber: p.contractNumber,
          agency: p.agency,
          wageDeterminationNumber: p.wageDeterminationNumber,
          state: p.state,
          status: p.status,
          site: p.site,
          workers: p._count.workers,
          weeksDue: due.length,
          oldestDue: due[0] ?? null,
          unsigned: due.filter((w) => !byWeek.has(w) || byWeek.get(w) === 'DRAFT').length,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

const ProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
  contractNumber: z.string().trim().max(80).nullish(),
  agency: z.string().trim().max(200).nullish(),
  awardingBody: z.string().trim().max(200).nullish(),
  wageDeterminationNumber: z.string().trim().max(80).nullish(),
  dirProjectId: z.string().trim().max(40).nullish(),
  siteId: z.string().uuid().nullish(),
  addressLine1: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(80).nullish(),
  county: z.string().trim().max(80).nullish(),
  state: z.string().trim().length(2).toUpperCase().nullish(),
  zip: z.string().trim().max(10).nullish(),
  startDate: dateOnly,
  endDate: dateOnly.nullish(),
  weekEndsOn: z.number().int().min(0).max(6).optional(),
  fringeMode: z.enum(['CASH', 'PLAN', 'MIXED']).optional(),
  payrollOfficerName: z.string().trim().max(120).nullish(),
  payrollOfficerTitle: z.string().trim().max(120).nullish(),
});

function projectData(input: Partial<z.infer<typeof ProjectInput>>) {
  const { startDate, endDate, ...rest } = input;
  return {
    ...rest,
    ...(startDate !== undefined ? { startDate: new Date(`${startDate}T00:00:00Z`) } : {}),
    ...(endDate !== undefined ? { endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null } : {}),
  };
}

certifiedPayrollRouter.post('/projects', async (req, res, next) => {
  try {
    const input = ProjectInput.parse(req.body);
    if (input.siteId) await assertSiteInScope(prisma, req.user!, input.siteId);
    if (input.endDate && input.endDate < input.startDate) throw new HttpError(400, 'bad_dates', 'The end date is before the start date.');
    const project = await prisma.prevailingWageProject.create({
      data: { ...projectData(input), name: input.name, startDate: new Date(`${input.startDate}T00:00:00Z`), tenantId: tenantIdForWrite(), createdById: req.user!.id },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.project_created', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { name: project.name } }, 'certified_payroll.project_created');
    res.status(201).json({ id: project.id });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.get('/projects/:id', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const [reports, people] = await Promise.all([
      prisma.certifiedPayrollReport.findMany({
        where: { tenantId: tenantIdForWrite(), projectId: project.id },
        orderBy: { weekEnding: 'desc' },
        select: { id: true, weekEnding: true, payrollNumber: true, isFinal: true, status: true, signatureName: true, signedAt: true, submittedAt: true, submittedTo: true, confirmation: true, snapshot: true },
      }),
      prisma.associate.findMany({ where: { id: { in: project.workers.map((w) => w.associateId) } }, select: { id: true, firstName: true, lastName: true } }),
    ]);
    // Gross paid on the project to date, as the signed WH-347s report it (each signed week's frozen totals).
    const signedReports = reports.filter((r) => r.status === 'SIGNED' || r.status === 'SUBMITTED');
    const grossReported = Math.round(signedReports.reduce((a, r) => a + Number((r.snapshot as { totals?: { grossThisProject?: number } } | null)?.totals?.grossThisProject ?? 0), 0) * 100) / 100;
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const byWeek = new Map(reports.map((r) => [ymd(r.weekEnding), r]));
    const weeks = endedWeeks(project)
      .reverse()
      .map((we) => {
        const r = byWeek.get(we);
        return { weekEnding: we, status: r?.status ?? 'OPEN', payrollNumber: r?.payrollNumber ?? null, signedAt: r?.signedAt ?? null, submittedAt: r?.submittedAt ?? null };
      });
    res.json({
      project: {
        ...project,
        startDate: ymd(project.startDate),
        endDate: project.endDate ? ymd(project.endDate) : null,
        rates: project.rates.map((r) => ({
          id: r.id,
          classification: r.classification,
          baseRate: Number(r.baseRate),
          fringeRate: Number(r.fringeRate),
          apprenticesPerJourneyman: r.apprenticesPerJourneyman != null ? Number(r.apprenticesPerJourneyman) : null,
          effectiveFrom: ymd(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? ymd(r.effectiveTo) : null,
        })),
        workers: project.workers.map((w) => ({
          id: w.id,
          associateId: w.associateId,
          name: nameOf.get(w.associateId) ?? 'Unknown',
          classification: w.classification,
          isApprentice: w.isApprentice,
          apprenticeRegistration: w.apprenticeRegistration,
          apprenticeLevelPercent: w.apprenticeLevelPercent != null ? Number(w.apprenticeLevelPercent) : null,
          startedOn: ymd(w.startedOn),
          endedOn: w.endedOn ? ymd(w.endedOn) : null,
        })),
      },
      weeks,
      reports: reports.map(({ snapshot: _snapshot, ...r }) => r),
      totals: { grossReported, weeksReported: signedReports.length },
    });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.patch('/projects/:id', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const input = ProjectInput.partial().extend({ status: z.enum(['ACTIVE', 'CLOSED', 'ARCHIVED']).optional() }).parse(req.body);
    if (input.siteId) await assertSiteInScope(prisma, req.user!, input.siteId);
    await prisma.prevailingWageProject.update({ where: { id: project.id }, data: projectData(input) });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.project_updated', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { fields: Object.keys(input) } }, 'certified_payroll.project_updated');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- Wage determination rates (effective-dated) ---------------------------- */

const RateInput = z.object({
  classification: z.string().trim().min(1).max(120),
  baseRate: money,
  fringeRate: money.default(0),
  apprenticesPerJourneyman: z.coerce.number().min(0).max(20).nullish(),
  effectiveFrom: dateOnly,
});

certifiedPayrollRouter.post('/projects/:id/rates', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const input = RateInput.parse(req.body);
    const from = new Date(`${input.effectiveFrom}T00:00:00Z`);
    const rate = await prisma.$transaction(async (tx) => {
      const clash = await tx.prevailingWageRate.findFirst({ where: { projectId: project.id, classification: input.classification, effectiveFrom: from } });
      if (clash) throw new HttpError(409, 'rate_exists', 'This classification already has a rate starting that day. Change that rate instead.');
      // The rate it replaces ends the day before; a later rate bounds this one.
      const prior = await tx.prevailingWageRate.findFirst({
        where: { projectId: project.id, classification: input.classification, effectiveFrom: { lt: from }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (prior) await tx.prevailingWageRate.update({ where: { id: prior.id }, data: { effectiveTo: new Date(from.getTime() - DAY) } });
      const next = await tx.prevailingWageRate.findFirst({
        where: { projectId: project.id, classification: input.classification, effectiveFrom: { gt: from } },
        orderBy: { effectiveFrom: 'asc' },
      });
      return tx.prevailingWageRate.create({
        data: {
          tenantId: tenantIdForWrite(),
          projectId: project.id,
          classification: input.classification,
          baseRate: input.baseRate,
          fringeRate: input.fringeRate,
          apprenticesPerJourneyman: input.apprenticesPerJourneyman ?? null,
          effectiveFrom: from,
          effectiveTo: next ? new Date(next.effectiveFrom.getTime() - DAY) : null,
        },
      });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.rate_added', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { classification: input.classification, baseRate: input.baseRate, fringeRate: input.fringeRate, effectiveFrom: input.effectiveFrom } }, 'certified_payroll.rate_added');
    res.status(201).json({ id: rate.id });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.delete('/projects/:id/rates/:rateId', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const rate = project.rates.find((r) => r.id === req.params.rateId);
    if (!rate) throw new HttpError(404, 'not_found', 'Rate not found.');
    await prisma.$transaction(async (tx) => {
      await tx.prevailingWageRate.delete({ where: { id: rate.id } });
      // The rate before it runs on to where this one ended.
      const prior = await tx.prevailingWageRate.findFirst({
        where: { projectId: project.id, classification: rate.classification, effectiveFrom: { lt: rate.effectiveFrom } },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (prior) await tx.prevailingWageRate.update({ where: { id: prior.id }, data: { effectiveTo: rate.effectiveTo } });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.rate_removed', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { classification: rate.classification, effectiveFrom: ymd(rate.effectiveFrom) } }, 'certified_payroll.rate_removed');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- Workers ----------------------------------------------------------------- */

const WorkerInput = z.object({
  associateId: z.string().uuid(),
  classification: z.string().trim().min(1).max(120),
  isApprentice: z.boolean().default(false),
  apprenticeRegistration: z.string().trim().max(80).nullish(),
  apprenticeLevelPercent: z.coerce.number().min(1).max(100).nullish(),
  startedOn: dateOnly,
  endedOn: dateOnly.nullish(),
});

certifiedPayrollRouter.post('/projects/:id/workers', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const input = WorkerInput.parse(req.body);
    await assertAssociateInScope(prisma, req.user!, input.associateId);
    if (input.isApprentice && !input.apprenticeLevelPercent) {
      throw new HttpError(400, 'apprentice_level', "Enter the apprentice's percentage of the journeyworker rate from their registered program.");
    }
    const open = project.workers.find((w) => w.associateId === input.associateId && !w.endedOn);
    if (open) throw new HttpError(409, 'already_on_project', 'This person is already on the project. End their current classification first.');
    const w = await prisma.prevailingWageWorker.create({
      data: {
        tenantId: tenantIdForWrite(),
        projectId: project.id,
        associateId: input.associateId,
        classification: input.classification,
        isApprentice: input.isApprentice,
        apprenticeRegistration: input.isApprentice ? (input.apprenticeRegistration ?? null) : null,
        apprenticeLevelPercent: input.isApprentice ? (input.apprenticeLevelPercent ?? null) : null,
        startedOn: new Date(`${input.startedOn}T00:00:00Z`),
        endedOn: input.endedOn ? new Date(`${input.endedOn}T00:00:00Z`) : null,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.worker_added', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { associateId: input.associateId, classification: input.classification, isApprentice: input.isApprentice } }, 'certified_payroll.worker_added');
    res.status(201).json({ id: w.id });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.patch('/projects/:id/workers/:workerId', async (req, res, next) => {
  try {
    const project = await loadProject(req, req.params.id!);
    const worker = project.workers.find((w) => w.id === req.params.workerId);
    if (!worker) throw new HttpError(404, 'not_found', 'Worker not found.');
    const input = z.object({ endedOn: dateOnly.nullable().optional(), apprenticeRegistration: z.string().trim().max(80).nullish(), apprenticeLevelPercent: z.coerce.number().min(1).max(100).nullish() }).parse(req.body);
    await prisma.prevailingWageWorker.update({
      where: { id: worker.id },
      data: {
        ...(input.endedOn !== undefined ? { endedOn: input.endedOn ? new Date(`${input.endedOn}T00:00:00Z`) : null } : {}),
        ...(input.apprenticeRegistration !== undefined ? { apprenticeRegistration: input.apprenticeRegistration } : {}),
        ...(input.apprenticeLevelPercent !== undefined ? { apprenticeLevelPercent: input.apprenticeLevelPercent } : {}),
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.worker_updated', entityType: 'PrevailingWageProject', entityId: project.id, metadata: { workerId: worker.id, fields: Object.keys(input) } }, 'certified_payroll.worker_updated');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- Time tags: time worked on a project away from its site ------------------- */

certifiedPayrollRouter.post('/time-tags', async (req, res, next) => {
  try {
    const input = z.object({ timeEntryId: z.string().uuid(), projectId: z.string().uuid(), classification: z.string().trim().max(120).nullish() }).parse(req.body);
    const project = await loadProject(req, input.projectId);
    const entry = await prisma.timeEntry.findFirst({ where: { id: input.timeEntryId, tenantId: tenantIdForWrite() }, select: { id: true, associateId: true } });
    if (!entry) throw new HttpError(404, 'not_found', 'Time entry not found.');
    await assertAssociateInScope(prisma, req.user!, entry.associateId);
    if (!project.workers.some((w) => w.associateId === entry.associateId)) {
      throw new HttpError(409, 'not_on_project', 'Add this person to the project before tagging their time to it.');
    }
    await prisma.prevailingWageTimeTag.upsert({
      where: { timeEntryId: entry.id },
      create: { tenantId: tenantIdForWrite(), timeEntryId: entry.id, projectId: project.id, classification: input.classification ?? null, createdById: req.user!.id },
      update: { projectId: project.id, classification: input.classification ?? null, createdById: req.user!.id },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.time_tagged', entityType: 'TimeEntry', entityId: entry.id, metadata: { projectId: project.id } }, 'certified_payroll.time_tagged');
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.delete('/time-tags/:timeEntryId', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.timeEntryId);
    const tag = await prisma.prevailingWageTimeTag.findFirst({ where: { timeEntryId: id, tenantId: tenantIdForWrite() } });
    if (!tag) throw new HttpError(404, 'not_found', 'No project tag on that time entry.');
    await loadProject(req, tag.projectId);
    await prisma.prevailingWageTimeTag.delete({ where: { id: tag.id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.time_untagged', entityType: 'TimeEntry', entityId: id, metadata: { projectId: tag.projectId } }, 'certified_payroll.time_untagged');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----- Weeks ------------------------------------------------------------------- */

async function weekFor(req: Request) {
  const project = await loadProject(req, req.params.id!);
  const weekEnding = parseWeek(project, String(req.params.weekEnding));
  const report = await prisma.certifiedPayrollReport.findFirst({ where: { tenantId: tenantIdForWrite(), projectId: project.id, weekEnding: new Date(`${weekEnding}T00:00:00Z`) } });
  // A signed week is the record as signed; an open one is computed live.
  const week = report && report.status !== 'DRAFT' && report.snapshot ? (report.snapshot as unknown as CertifiedWeek) : await computeCertifiedWeek(prisma, project, weekEnding);
  return { project, weekEnding, report, week };
}

/**
 * WH-347 payroll numbers start at 1 with the project's first week and run
 * one a week (a week without work still gets its number and a
 * "no work performed" submission).
 */
function payrollNumberFor(project: { startDate: Date; weekEndsOn: number }, weekEnding: Date): number {
  const first = new Date(`${weekEndingFor(project.startDate, project.weekEndsOn)}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((weekEnding.getTime() - first) / (7 * DAY)) + 1);
}

certifiedPayrollRouter.get('/projects/:id/weeks/:weekEnding', async (req, res, next) => {
  try {
    const { project, weekEnding, report, week } = await weekFor(req);
    res.json({
      project: { id: project.id, name: project.name, state: project.state, fringeMode: project.fringeMode, payrollOfficerName: project.payrollOfficerName, payrollOfficerTitle: project.payrollOfficerTitle },
      weekEnding,
      report: report
        ? { status: report.status, payrollNumber: report.payrollNumber, isFinal: report.isFinal, fringeStatement: report.fringeStatement, exceptionsText: report.exceptionsText, signatureName: report.signatureName, signerTitle: report.signerTitle, signedAt: report.signedAt, submittedAt: report.submittedAt, submittedTo: report.submittedTo, confirmation: report.confirmation, pdfHash: report.pdfHash }
        : null,
      payrollNumber: report?.payrollNumber ?? payrollNumberFor(project, new Date(`${weekEnding}T00:00:00Z`)),
      week,
      ecprAvailable: project.state === 'CA',
    });
  } catch (err) {
    next(err);
  }
});

const SignInput = z.object({
  signatureName: z.string().trim().min(2).max(120),
  signerTitle: z.string().trim().min(1).max(120),
  fringeStatement: z.enum(['PLANS', 'CASH', 'MIXED']),
  exceptionsText: z.string().trim().max(2000).nullish(),
  isFinal: z.boolean().default(false),
  /** The signer's affirmation of the Statement of Compliance. */
  attest: z.literal(true),
});

async function wh347For(project: Awaited<ReturnType<typeof loadProject>>, week: CertifiedWeek, payrollNumber: number, isFinal: boolean, statement: Parameters<typeof renderWh347Pdf>[0]['statement']) {
  const employer = await defaultEmployerOrg(prisma);
  return renderWh347Pdf({
    employer: { legalName: employer.legalName, addressLine1: employer.addressLine1, city: employer.city, state: employer.state, zip: employer.zip },
    project: { name: project.name, contractNumber: project.contractNumber, addressLine1: project.addressLine1, city: project.city, state: project.state },
    payrollNumber,
    isFinal,
    week,
    statement,
  });
}

certifiedPayrollRouter.post('/projects/:id/weeks/:weekEnding/sign', async (req, res, next) => {
  try {
    const input = SignInput.parse(req.body);
    const project = await loadProject(req, req.params.id!);
    const weekEnding = parseWeek(project, String(req.params.weekEnding));
    if (weekEnding >= orgDateKey(new Date())) throw new HttpError(409, 'week_not_over', "This week hasn't ended yet.");
    const weekDate = new Date(`${weekEnding}T00:00:00Z`);
    const existing = await prisma.certifiedPayrollReport.findFirst({ where: { tenantId: tenantIdForWrite(), projectId: project.id, weekEnding: weekDate } });
    if (existing && existing.status !== 'DRAFT') throw new HttpError(409, 'already_signed', 'This week is already signed.');
    const week = await computeCertifiedWeek(prisma, project, weekEnding);
    // The Statement of Compliance says every worker got at least the
    // prevailing rate: it can't be signed over a known shortfall.
    const blocking = week.exceptions.filter((e) => e.kind === 'BELOW_PREVAILING' || e.kind === 'NO_RATE' || e.kind === 'UNPAID');
    if (blocking.length > 0) {
      throw new HttpError(409, 'week_has_exceptions', 'Fix these before signing: ' + blocking.map((e) => e.message).join(' '), { exceptions: blocking });
    }
    const payrollNumber = existing?.payrollNumber ?? payrollNumberFor(project, weekDate);
    const signedAt = new Date();
    const pdf = await wh347For(project, week, payrollNumber, input.isFinal, { signatureName: input.signatureName, signerTitle: input.signerTitle, signedAt, fringeStatement: input.fringeStatement, exceptionsText: input.exceptionsText ?? null });
    const pdfHash = hashWh347(pdf);
    const data = {
      status: 'SIGNED',
      payrollNumber,
      isFinal: input.isFinal,
      snapshot: week as unknown as Prisma.InputJsonValue,
      fringeStatement: input.fringeStatement,
      exceptionsText: input.exceptionsText ?? null,
      signatureName: input.signatureName,
      signerTitle: input.signerTitle,
      signedById: req.user!.id,
      signedAt,
      signedIp: (req.ip ?? '').slice(0, 64) || null,
      pdfHash,
    };
    const report = existing
      ? await prisma.certifiedPayrollReport.update({ where: { id: existing.id }, data })
      : await prisma.certifiedPayrollReport.create({ data: { ...data, tenantId: tenantIdForWrite(), projectId: project.id, weekEnding: weekDate } });
    await recordCriticalAudit(
      { actorUserId: req.user!.id, action: 'certified_payroll.week_signed', entityType: 'CertifiedPayrollReport', entityId: report.id, metadata: { projectId: project.id, weekEnding, payrollNumber, pdfHash, signatureName: input.signatureName, workers: week.rows.length } },
      'certified_payroll.week_signed',
    );
    res.json({ status: report.status, payrollNumber, pdfHash, signedAt });
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.get('/projects/:id/weeks/:weekEnding/wh347.pdf', async (req, res, next) => {
  try {
    const { project, weekEnding, report, week } = await weekFor(req);
    const payrollNumber = report?.payrollNumber ?? payrollNumberFor(project, new Date(`${weekEnding}T00:00:00Z`));
    const signed = report && report.status !== 'DRAFT';
    const pdf = await wh347For(project, week, payrollNumber, report?.isFinal ?? false, {
      signatureName: signed ? report.signatureName : null,
      signerTitle: signed ? report.signerTitle : null,
      signedAt: signed ? report.signedAt : null,
      fringeStatement: signed ? (report.fringeStatement as 'PLANS' | 'CASH' | 'MIXED' | null) : null,
      exceptionsText: signed ? report.exceptionsText : null,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="WH-347-${weekEnding}-${payrollNumber}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.get('/projects/:id/weeks/:weekEnding/ecpr.xml', async (req, res, next) => {
  try {
    const { project, weekEnding, report, week } = await weekFor(req);
    if (project.state !== 'CA') throw new HttpError(409, 'not_california', 'The eCPR XML is for California projects. Use the WH-347 PDF.');
    if (!report || report.status === 'DRAFT') throw new HttpError(409, 'not_signed', 'Sign the Statement of Compliance first.');
    const employer = await defaultEmployerOrg(prisma);
    const xml = buildEcprXml({ employer, project, week, payrollNumber: report.payrollNumber, isFinal: report.isFinal });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="eCPR-${weekEnding}-${report.payrollNumber}.xml"`);
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

certifiedPayrollRouter.post('/projects/:id/weeks/:weekEnding/submitted', async (req, res, next) => {
  try {
    const input = z.object({ submittedTo: z.string().trim().min(1).max(200), confirmation: z.string().trim().max(120).nullish() }).parse(req.body);
    const project = await loadProject(req, req.params.id!);
    const weekEnding = parseWeek(project, String(req.params.weekEnding));
    const report = await prisma.certifiedPayrollReport.findFirst({ where: { tenantId: tenantIdForWrite(), projectId: project.id, weekEnding: new Date(`${weekEnding}T00:00:00Z`) } });
    if (!report || report.status === 'DRAFT') throw new HttpError(409, 'not_signed', 'Sign the Statement of Compliance before marking it submitted.');
    if (report.status === 'SUBMITTED') throw new HttpError(409, 'already_submitted', 'This week is already marked submitted.');
    await prisma.certifiedPayrollReport.update({ where: { id: report.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), submittedTo: input.submittedTo, confirmation: input.confirmation ?? null } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'certified_payroll.week_submitted', entityType: 'CertifiedPayrollReport', entityId: report.id, metadata: { projectId: project.id, weekEnding, submittedTo: input.submittedTo } }, 'certified_payroll.week_submitted');
    res.json({ status: 'SUBMITTED' });
  } catch (err) {
    next(err);
  }
});
