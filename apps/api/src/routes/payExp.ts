import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  loadDailyPayPolicy,
  policyView,
  requestDailyPayChange,
  runDailyPay,
  setDailyPayEnrollment,
} from '../lib/dailyPay.js';
import { listManualChecks, recordManualCheck, recordThirdPartySickPay, voidManualCheck, voidThirdPartySickPay } from '../lib/manualChecks.js';
import { buildPayPreview, confirmPayPreview, flagPayPreview, payPreviewStats, resolvePayPreviewFlags } from '../lib/payPreview.js';
import { scopeAssociates, scopePayrollItems, scopePayrollRuns, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { estimateW4, w4EstimatorContext } from '../lib/w4Estimator.js';
import type { Prisma } from '@prisma/client';

/**
 * PAYEXP: daily pay, manual checks, third-party sick pay, "check my pay
 * before payday", and the W-4 estimator. The pay math lives in the libs;
 * these are the doors.
 */

export const payExpRouter = Router();

const PROCESS = requireCapability('process:payroll');
const Id = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;

function ownAssociate(req: Request): string {
  const id = req.user?.associateId;
  if (!id) throw new HttpError(403, 'no_associate_record', 'Only a worker has their own pay.');
  return id;
}

/* ---- Daily pay (Finance) ---------------------------------------------------------- */

payExpRouter.get('/payroll/daily-pay', requireAuth, PROCESS, async (req, res) => {
  const user = req.user!;
  const tenantId = tenantIdForWrite();
  const policy = await loadDailyPayPolicy(prisma);
  const [enrollments, dailySchedulePeople, recent] = await Promise.all([
    prisma.dailyPayEnrollment.findMany({
      where: { tenantId, endedAt: null, associate: scopeWhere<Prisma.AssociateWhereInput>({ deletedAt: null }, scopeAssociates(user)) },
      select: { associateId: true, enrolledAt: true, associate: { select: { firstName: true, lastName: true } } },
      orderBy: { enrolledAt: 'desc' },
      take: 500,
    }),
    prisma.associate.count({ where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId, deletedAt: null, payrollSchedule: { frequency: 'DAILY' } }, scopeAssociates(user)) }),
    prisma.payrollItem.findMany({
      where: scopeWhere<Prisma.PayrollItemWhereInput>({ tenantId, payrollRun: { kind: 'DAILY' } }, scopePayrollItems(user)),
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        associateId: true,
        grossPay: true,
        netPay: true,
        status: true,
        failureReason: true,
        postTaxDeductions: true,
        createdAt: true,
        payrollRun: { select: { id: true, periodStart: true } },
        associate: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);
  const enrollmentCount = await prisma.dailyPayEnrollment.count({ where: { tenantId, endedAt: null, associate: scopeWhere<Prisma.AssociateWhereInput>({ deletedAt: null }, scopeAssociates(user)) } });
  res.json({
    policy: policyView(policy),
    enrolled: enrollments.map((e) => ({ associateId: e.associateId, name: `${e.associate.firstName} ${e.associate.lastName}`, enrolledAt: e.enrolledAt.toISOString() })),
    enrolledCount: enrollmentCount,
    truncated: enrollmentCount > enrollments.length,
    dailySchedulePeople,
    recent: recent.map((i) => ({
      itemId: i.id,
      runId: i.payrollRun.id,
      associateId: i.associateId,
      name: `${i.associate.firstName} ${i.associate.lastName}`,
      workDate: i.payrollRun.periodStart.toISOString().slice(0, 10),
      gross: Number(i.grossPay),
      net: Number(i.netPay),
      status: i.status,
      reason: i.failureReason,
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

const PolicyBody = z.object({
  enable: z.boolean(),
  timing: z.enum(['SAME_DAY', 'NEXT_DAY']).optional(),
  eligibility: z.enum(['ENROLLED', 'EVERYONE']).optional(),
  feeCents: z.number().int().min(0).max(2_000).optional(),
  dailyCapCents: z.number().int().min(100).max(500_000).optional(),
});

/** Turning it off is immediate; turning it on or changing it waits for a second person. */
payExpRouter.put('/payroll/daily-pay/policy', requireAuth, PROCESS, async (req, res) => {
  const body = PolicyBody.parse(req.body ?? {});
  const out = await requestDailyPayChange(prisma, {
    actorUserId: req.user!.id,
    enable: body.enable,
    settings: { timing: body.timing, eligibility: body.eligibility, feeCents: body.feeCents, dailyCapCents: body.dailyCapCents },
  });
  res.status(out.applied ? 200 : 202).json({ ...out, pending: !out.applied });
});

payExpRouter.post('/payroll/daily-pay/enroll', requireAuth, PROCESS, async (req, res) => {
  const body = z.object({ associateId: Id, enrolled: z.boolean() }).parse(req.body ?? {});
  const a = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: body.associateId, deletedAt: null }, scopeAssociates(req.user!)), select: { id: true } });
  if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  await setDailyPayEnrollment(prisma, { associateId: a.id, enrolled: body.enrolled, actorUserId: req.user!.id });
  res.json({ ok: true });
});

/** Run tonight's settlement now (the timer does this on its own each night). */
payExpRouter.post('/payroll/daily-pay/run', requireAuth, PROCESS, async (req, res) => {
  const out = await runDailyPay({ actorUserId: req.user!.id });
  res.json(out);
});

/* ---- Daily pay (the worker) -------------------------------------------------------- */

payExpRouter.get('/me/daily-pay', requireAuth, async (req, res) => {
  const associateId = ownAssociate(req);
  const [policy, enrollment, schedule] = await Promise.all([
    loadDailyPayPolicy(prisma),
    prisma.dailyPayEnrollment.findUnique({ where: { associateId } }),
    prisma.associate.findUnique({ where: { id: associateId }, select: { payrollSchedule: { select: { frequency: true } } } }),
  ]);
  const view = policyView(policy);
  const onDailySchedule = schedule?.payrollSchedule?.frequency === 'DAILY';
  res.json({
    active: view.status === 'ACTIVE',
    timing: view.timing,
    feeCents: view.feeCents,
    enrolled: onDailySchedule || (!!enrollment && !enrollment.endedAt),
    onDailySchedule,
    canOptIn: view.status === 'ACTIVE' && view.eligibility === 'EVERYONE' && !onDailySchedule,
  });
});

payExpRouter.post('/me/daily-pay', requireAuth, async (req, res) => {
  const associateId = ownAssociate(req);
  const body = z.object({ enrolled: z.boolean() }).parse(req.body ?? {});
  const view = policyView(await loadDailyPayPolicy(prisma));
  if (body.enrolled && (view.status !== 'ACTIVE' || view.eligibility !== 'EVERYONE')) {
    throw new HttpError(409, 'not_open', 'Daily pay isn’t open to sign up for here. Ask payroll.');
  }
  await setDailyPayEnrollment(prisma, { associateId, enrolled: body.enrolled, actorUserId: req.user!.id });
  res.json({ ok: true });
});

/* ---- Manual checks and third-party sick pay (Finance) -------------------------------- */

payExpRouter.get('/payroll/manual-checks', requireAuth, PROCESS, async (req, res) => {
  const user = req.user!;
  const checks = await listManualChecks(prisma, scopeWhere<Prisma.PayrollItemWhereInput>({ tenantId: tenantIdForWrite() }, scopePayrollItems(user)));
  const sickPay = await prisma.thirdPartySickPay.findMany({
    where: { tenantId: tenantIdForWrite(), associate: scopeAssociates(user) },
    orderBy: { payDate: 'desc' },
    take: 200,
    include: { associate: { select: { firstName: true, lastName: true } } },
  });
  res.json({
    checks,
    sickPay: sickPay.map((s) => ({
      id: s.id,
      associateId: s.associateId,
      associateName: `${s.associate.firstName} ${s.associate.lastName}`,
      payerName: s.payerName,
      payDate: s.payDate.toISOString().slice(0, 10),
      grossAmount: Number(s.grossAmount),
      nontaxableAmount: Number(s.nontaxableAmount),
      federalWithheld: Number(s.federalWithheld),
      socialSecurityWithheld: Number(s.socialSecurityWithheld),
      medicareWithheld: Number(s.medicareWithheld),
      stateWithheld: Number(s.stateWithheld),
      employerTaxesBy: s.employerTaxesBy,
      w2ReportedBy: s.w2ReportedBy,
      voided: !!s.voidedAt,
    })),
  });
});

const Money = z.number().min(0).max(1_000_000);
const ManualBody = z.object({
  associateId: Id,
  checkNumber: z.string().trim().min(1).max(20),
  payDate: Day,
  periodStart: Day.optional().nullable(),
  periodEnd: Day.optional().nullable(),
  earningKind: z.enum(['REGULAR', 'OVERTIME', 'BONUS', 'COMMISSION', 'HOLIDAY', 'SICK', 'VACATION']).optional(),
  hours: z.number().min(0).max(1_000).optional().nullable(),
  gross: z.number().positive().max(1_000_000),
  preTaxDeductions: Money.optional(),
  preTaxRetirement: Money.optional(),
  federal: Money,
  socialSecurity: Money,
  medicare: Money,
  state: Money,
  local: Money.optional(),
  postTaxDeductions: Money.optional(),
  net: Money,
  memo: z.string().max(300).optional().nullable(),
  replacesItemId: Id.optional().nullable(),
});

payExpRouter.post('/payroll/manual-checks', requireAuth, PROCESS, async (req, res) => {
  const b = ManualBody.parse(req.body ?? {});
  const a = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: b.associateId }, scopeAssociates(req.user!)), select: { id: true } });
  if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  const out = await recordManualCheck(prisma, {
    ...b,
    payDate: asDate(b.payDate),
    periodStart: b.periodStart ? asDate(b.periodStart) : null,
    periodEnd: b.periodEnd ? asDate(b.periodEnd) : null,
    actorUserId: req.user!.id,
  });
  res.status(201).json(out);
});

payExpRouter.post('/payroll/manual-checks/:runId/void', requireAuth, PROCESS, async (req, res) => {
  const runId = Id.parse(req.params.runId);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body ?? {});
  const run = await prisma.payrollRun.findFirst({ where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: runId, kind: 'MANUAL' }, scopePayrollRuns(req.user!)), select: { id: true } });
  if (!run) throw new HttpError(404, 'check_not_found', 'Manual check not found');
  await voidManualCheck(prisma, { runId: run.id, reason, actorUserId: req.user!.id });
  res.json({ ok: true });
});

const SickBody = z.object({
  associateId: Id,
  payerName: z.string().trim().min(2).max(200),
  payDate: Day,
  grossAmount: z.number().positive().max(1_000_000),
  nontaxableAmount: Money.optional(),
  federalWithheld: Money.optional(),
  socialSecurityWithheld: Money.optional(),
  medicareWithheld: Money.optional(),
  stateWithheld: Money.optional(),
  employerTaxesBy: z.enum(['EMPLOYER', 'INSURER']),
  w2ReportedBy: z.enum(['EMPLOYER', 'INSURER']),
  notes: z.string().max(500).optional().nullable(),
});

payExpRouter.post('/payroll/sick-pay', requireAuth, PROCESS, async (req, res) => {
  const b = SickBody.parse(req.body ?? {});
  const a = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: b.associateId }, scopeAssociates(req.user!)), select: { id: true } });
  if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  const out = await recordThirdPartySickPay(prisma, { ...b, payDate: asDate(b.payDate), actorUserId: req.user!.id });
  res.status(201).json({ id: out.row.id, employerTaxes: out.employerTaxes });
});

payExpRouter.post('/payroll/sick-pay/:id/void', requireAuth, PROCESS, async (req, res) => {
  const id = Id.parse(req.params.id);
  const row = await prisma.thirdPartySickPay.findFirst({ where: { id, associate: scopeAssociates(req.user!) }, select: { id: true } });
  if (!row) throw new HttpError(404, 'sick_pay_not_found', 'Sick pay record not found');
  await voidThirdPartySickPay(prisma, { id: row.id, actorUserId: req.user!.id });
  res.json({ ok: true });
});

/* ---- "Check my pay before payday" ------------------------------------------------------ */

payExpRouter.get('/me/pay-preview', requireAuth, async (req, res) => {
  res.json(await buildPayPreview(prisma, ownAssociate(req)));
});

payExpRouter.post('/me/pay-preview/confirm', requireAuth, async (req, res) => {
  res.json(await confirmPayPreview(prisma, ownAssociate(req), req.user!.id));
});

const FlagBody = z.object({
  line: z.string().min(1).max(80),
  kind: z.enum(['HOURS', 'MISSING_DAY', 'RATE', 'TAX', 'DEDUCTION', 'OTHER']),
  note: z.string().trim().min(3).max(1000),
  timeEntryId: Id.optional().nullable(),
  proposedClockIn: z.string().datetime().optional().nullable(),
  proposedClockOut: z.string().datetime().optional().nullable(),
});

payExpRouter.post('/me/pay-preview/flag', requireAuth, async (req, res) => {
  const body = FlagBody.parse(req.body ?? {});
  const out = await flagPayPreview(
    prisma,
    { associateId: ownAssociate(req), userId: req.user!.id, ip: req.ip ?? null, ua: req.get('user-agent') ?? null },
    { ...body, language: (req.user as { language?: string | null }).language ?? null },
  );
  res.status(201).json(out);
});

/** Payroll: the confirmation rate and open flags for one run's pay date. */
payExpRouter.get('/payroll/pay-checks', requireAuth, PROCESS, async (req, res) => {
  const runId = Id.parse(req.query.run);
  const run = await prisma.payrollRun.findFirst({ where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: runId, tenantId: tenantIdForWrite() }, scopePayrollRuns(req.user!)), select: { id: true, periodStart: true, periodEnd: true, kind: true } });
  if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
  const items = await prisma.payrollItem.findMany({
    where: scopeWhere<Prisma.PayrollItemWhereInput>({ payrollRunId: run.id, status: { not: 'VOIDED' } }, scopePayrollItems(req.user!)),
    select: { associateId: true, associate: { select: { firstName: true, lastName: true } } },
  });
  const stats = await payPreviewStats(prisma, { associateIds: items.map((i) => i.associateId), periodStart: run.periodStart, periodEnd: run.periodEnd });
  const names = new Map(items.map((i) => [i.associateId, `${i.associate.firstName} ${i.associate.lastName}`]));
  res.json({
    run: { id: run.id, periodStart: run.periodStart.toISOString().slice(0, 10), periodEnd: run.periodEnd.toISOString().slice(0, 10) },
    people: stats.people,
    confirmed: stats.confirmed,
    flagged: stats.flagged,
    openFlags: stats.openFlags,
    unanswered: stats.unanswered,
    confirmationRate: round2(stats.confirmationRate),
    open: stats.open.map((o) => ({ associateId: o.associateId, name: names.get(o.associateId) ?? '—', flags: o.flags })),
  });
});

payExpRouter.post('/payroll/pay-checks/resolve', requireAuth, PROCESS, async (req, res) => {
  const body = z.object({ runId: Id, associateId: Id }).parse(req.body ?? {});
  const run = await prisma.payrollRun.findFirst({ where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: body.runId }, scopePayrollRuns(req.user!)), select: { periodStart: true, periodEnd: true } });
  if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
  const a = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: body.associateId }, scopeAssociates(req.user!)), select: { id: true } });
  if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found');
  await resolvePayPreviewFlags(prisma, { associateId: a.id, periodStart: run.periodStart, periodEnd: run.periodEnd, actorUserId: req.user!.id });
  res.json({ ok: true });
});

/* ---- W-4 estimator (the worker) ---------------------------------------------------------- */

payExpRouter.get('/me/w4-estimator', requireAuth, async (req, res) => {
  res.json(await w4EstimatorContext(prisma, ownAssociate(req)));
});

const EstimateBody = z.object({
  filingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD']),
  payFrequency: z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY']),
  payPerPeriod: z.number().min(0).max(1_000_000),
  periodsRemaining: z.number().int().min(0).max(60),
  ytdWages: z.number().min(0).max(10_000_000),
  ytdFederalWithheld: z.number().min(0).max(10_000_000),
  otherJobsAnnual: z.number().min(0).max(10_000_000).optional(),
  otherJobsWithheldAnnual: z.number().min(0).max(10_000_000).optional(),
  otherIncome: z.number().min(0).max(10_000_000).optional(),
  deductionsAboveStandard: z.number().min(0).max(10_000_000).optional(),
  childrenUnder17: z.number().int().min(0).max(20).optional(),
  otherDependents: z.number().int().min(0).max(20).optional(),
});

payExpRouter.post('/me/w4-estimator', requireAuth, async (req, res) => {
  const associateId = ownAssociate(req);
  const body = EstimateBody.parse(req.body ?? {});
  const ctx = await w4EstimatorContext(prisma, associateId);
  res.json(estimateW4({ ...body, current: ctx.current ? { filingStatus: ctx.current.filingStatus, dependentsAmount: ctx.current.dependentsAmount, otherIncome: ctx.current.otherIncome, deductions: ctx.current.deductions, extraWithholding: ctx.current.extraWithholding } : null }));
});
