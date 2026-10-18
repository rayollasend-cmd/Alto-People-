import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { decryptString, encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertBulkPiiExporter } from '../lib/bulkPiiExport.js';
import { isInternallyScoped, scopeAssociatesIncludingFormer, scopeWhere } from '../lib/scope.js';
import { autoEnrollProblems, mustAutoEnroll, parseMatchFormula, setDeferralRate, syncPlanElections, trueUp } from '../lib/retirement.js';
import { adapterFor, contributionTotals, RECORDKEEPERS, type CensusRow, type ContributionRow, type RecordkeeperId } from '../lib/recordkeepers.js';
import { deliverFile, DeliveryError, describeConnection, openConnection, sealConnection, type Transport } from '../lib/fileDelivery.js';
import type { SessionUser } from '../types/express.js';

/**
 * 401(k) plans per employer of record, the people in them, and the files
 * that go to the recordkeeper (contributions per pay date, census, the
 * year-end true-up) — plus the deferral changes that come back.
 *
 * Gate: process:payroll. Downloading a file (full SSNs for every
 * participant) is a bulk PII export: export:payroll-pii and a named
 * exporter. Site-bound users read the elections of people in their reach
 * and cannot change plans or send files.
 */
export const retirementRouter = Router();
const PROCESS = requireCapability('process:payroll');
const EXPORT_PII = requireCapability('export:payroll-pii');

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

function audit(req: Request, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}): void {
  enqueueAudit({ actorUserId: req.user!.id, action, entityType, entityId, metadata: metadata as Prisma.InputJsonObject }, 'retirement');
}

function refuseNarrowed(user: SessionUser): void {
  if (isInternallyScoped(user)) throw new HttpError(403, 'company_wide', 'Retirement plans cover the whole company; ask a payroll lead without a site limit.');
}

async function planOr404(id: string) {
  const plan = await prisma.retirementPlan.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!plan) throw new HttpError(404, 'not_found', 'That plan was not found.');
  return plan;
}

/** Each person's current rate, read from the one election: their enrollment in the plan's 401(k) benefits plan. */
async function ratesFor(plan: { benefitsPlanId: string | null }, associateIds: string[]): Promise<Map<string, { pre: number; roth: number; flatCents: number | null }>> {
  const out = new Map<string, { pre: number; roth: number; flatCents: number | null }>();
  if (!plan.benefitsPlanId || !associateIds.length) return out;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const rows = await prisma.benefitsEnrollment.findMany({
    where: { planId: plan.benefitsPlanId, associateId: { in: associateIds }, effectiveDate: { lte: today }, OR: [{ terminationDate: null }, { terminationDate: { gte: today } }] },
    orderBy: { effectiveDate: 'desc' },
  });
  for (const r of rows) {
    if (out.has(r.associateId)) continue;
    const pct = r.electedPercent != null || r.rothPercent != null;
    out.set(r.associateId, {
      pre: pct && !r.rothElection ? Number(r.electedPercent ?? 0) : 0,
      roth: pct ? Number(r.rothPercent ?? 0) + (r.rothElection ? Number(r.electedPercent ?? 0) : 0) : 0,
      flatCents: pct ? null : r.electedAmountCentsPerPeriod,
    });
  }
  return out;
}

function shapePlan(p: Prisma.RetirementPlanGetPayload<object>, extra: { employerName: string | null; counts?: Record<string, number> }) {
  return {
    id: p.id,
    name: p.name,
    planNumber: p.planNumber,
    employerId: p.employerId,
    employerName: extra.employerName,
    benefitsPlanId: p.benefitsPlanId,
    recordkeeper: p.recordkeeper,
    recordkeeperLabel: RECORDKEEPERS[p.recordkeeper as RecordkeeperId]?.label ?? p.recordkeeper,
    transport: RECORDKEEPERS[p.recordkeeper as RecordkeeperId]?.transport ?? 'DOWNLOAD',
    connection: describeConnection(p.connectionEnc),
    status: p.status,
    establishedOn: ymd(p.establishedOn),
    eligibilityMinAge: p.eligibilityMinAge,
    eligibilityServiceDays: p.eligibilityServiceDays,
    entryTiming: p.entryTiming,
    autoEnroll: p.autoEnroll,
    autoEnrollPercent: Number(p.autoEnrollPercent),
    autoEscalatePercent: Number(p.autoEscalatePercent),
    autoEscalateMax: Number(p.autoEscalateMax),
    optOutDays: p.optOutDays,
    matchFormula: parseMatchFormula(p.matchFormula),
    safeHarbor: p.safeHarbor,
    rothEnabled: p.rothEnabled,
    catchUpEnabled: p.catchUpEnabled,
    mustAutoEnroll: mustAutoEnroll(p),
    counts: extra.counts ?? {},
  };
}

/* ----- plans ----------------------------------------------------------- */

retirementRouter.get('/retirement/plans', PROCESS, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [plans, employers, counts] = await Promise.all([
    prisma.retirementPlan.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
    prisma.employerOrganization.findMany({ where: { tenantId }, select: { id: true, legalName: true, isDefault: true }, orderBy: [{ isDefault: 'desc' }, { legalName: 'asc' }] }),
    prisma.retirementElection.groupBy({ by: ['planId', 'status'], where: { tenantId }, _count: true }),
  ]);
  const benefitsPlans = await prisma.benefitsPlan.findMany({ where: { tenantId, kind: { in: ['RETIREMENT_401K', 'RETIREMENT_403B'] }, isActive: true }, select: { id: true, name: true, client: { select: { name: true } } }, orderBy: { name: 'asc' } });
  const names = new Map(employers.map((e) => [e.id, e.legalName]));
  res.json({
    plans: plans.map((p) => {
      const c: Record<string, number> = {};
      for (const row of counts.filter((x) => x.planId === p.id)) c[row.status] = row._count;
      return shapePlan(p, { employerName: p.employerId ? (names.get(p.employerId) ?? null) : null, counts: c });
    }),
    employers: employers.map((e) => ({ id: e.id, name: e.legalName, isDefault: e.isDefault })),
    recordkeepers: Object.values(RECORDKEEPERS).map((a) => ({ id: a.id, label: a.label, transport: a.transport })),
    benefitsPlans: benefitsPlans.map((b) => ({ id: b.id, name: b.client?.name ? `${b.name} · ${b.client.name}` : b.name })),
  });
});

const Tier = z.object({ upToPercent: z.number().positive().max(100), matchPercent: z.number().min(0).max(200) });
const PlanSchema = z.object({
  name: z.string().trim().min(2).max(120),
  planNumber: z.string().max(40).nullable().optional(),
  employerId: z.string().uuid().nullable().optional(),
  benefitsPlanId: z.string().uuid(),
  recordkeeper: z.enum(['GUIDELINE', 'VESTWELL', 'EMPOWER_SFTP', 'GENERIC_SFTP']),
  status: z.enum(['ACTIVE', 'FROZEN', 'TERMINATED']).optional(),
  establishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  eligibilityMinAge: z.number().int().min(0).max(21),
  eligibilityServiceDays: z.number().int().min(0).max(365),
  entryTiming: z.enum(['IMMEDIATE', 'MONTHLY', 'QUARTERLY']),
  autoEnroll: z.boolean(),
  autoEnrollPercent: z.number().min(0).max(15),
  autoEscalatePercent: z.number().min(0).max(5),
  autoEscalateMax: z.number().min(0).max(15),
  optOutDays: z.number().int().min(0).max(90),
  matchFormula: z.array(Tier).max(5),
  safeHarbor: z.enum(['NONE', 'BASIC', 'ENHANCED', 'NONELECTIVE_3']),
  rothEnabled: z.boolean(),
  catchUpEnabled: z.boolean(),
});

function planData(input: z.infer<typeof PlanSchema>) {
  const establishedOn = input.establishedOn ? new Date(`${input.establishedOn}T00:00:00Z`) : null;
  const problems = autoEnrollProblems({ establishedOn, autoEnroll: input.autoEnroll, autoEnrollPercent: input.autoEnrollPercent, autoEscalatePercent: input.autoEscalatePercent, autoEscalateMax: input.autoEscalateMax });
  if (input.safeHarbor !== 'NONE' && input.matchFormula.length) problems.push('A safe harbor plan uses the safe harbor formula; clear the match tiers.');
  if (problems.length) throw new HttpError(400, 'plan_rules', problems.join(' '), { problems });
  return {
    name: input.name,
    planNumber: input.planNumber ?? null,
    employerId: input.employerId ?? null,
    benefitsPlanId: input.benefitsPlanId,
    recordkeeper: input.recordkeeper,
    ...(input.status ? { status: input.status } : {}),
    establishedOn,
    eligibilityMinAge: input.eligibilityMinAge,
    eligibilityServiceDays: input.eligibilityServiceDays,
    entryTiming: input.entryTiming,
    autoEnroll: input.autoEnroll,
    autoEnrollPercent: input.autoEnrollPercent,
    autoEscalatePercent: input.autoEscalatePercent,
    autoEscalateMax: input.autoEscalateMax,
    optOutDays: input.optOutDays,
    matchFormula: input.matchFormula as unknown as Prisma.InputJsonArray,
    safeHarbor: input.safeHarbor,
    rothEnabled: input.rothEnabled,
    catchUpEnabled: input.catchUpEnabled,
  };
}

/** The 401(k) benefits plan whose enrollments hold the elections. */
async function assertBenefitsPlan(id: string) {
  const bp = await prisma.benefitsPlan.findFirst({ where: { id, tenantId: tenantIdForWrite(), kind: { in: ['RETIREMENT_401K', 'RETIREMENT_403B'] } } });
  if (!bp) throw new HttpError(400, 'benefits_plan', 'Choose the 401(k) plan on the Benefits page that holds people’s elections.');
}

async function assertEmployer(employerId: string | null | undefined) {
  if (!employerId) return;
  const e = await prisma.employerOrganization.findFirst({ where: { id: employerId, tenantId: tenantIdForWrite() } });
  if (!e) throw new HttpError(404, 'not_found', 'That employer of record was not found.');
}

retirementRouter.post('/retirement/plans', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const input = PlanSchema.parse(req.body ?? {});
  await assertEmployer(input.employerId);
  await assertBenefitsPlan(input.benefitsPlanId);
  const plan = await prisma.retirementPlan.create({ data: { ...planData(input), tenantId: tenantIdForWrite(), createdById: req.user!.id } });
  audit(req, 'retirement.plan_created', 'RetirementPlan', plan.id, { name: plan.name, recordkeeper: plan.recordkeeper });
  res.status(201).json({ plan: shapePlan(plan, { employerName: null }) });
});

retirementRouter.put('/retirement/plans/:id', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const input = PlanSchema.parse(req.body ?? {});
  await assertEmployer(input.employerId);
  await assertBenefitsPlan(input.benefitsPlanId);
  const updated = await prisma.retirementPlan.update({ where: { id: plan.id }, data: planData(input) });
  audit(req, 'retirement.plan_updated', 'RetirementPlan', plan.id, { name: updated.name });
  res.json({ plan: shapePlan(updated, { employerName: null }) });
});

retirementRouter.put('/retirement/plans/:id/connection', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const input = z
    .object({
      baseUrl: z.string().url().startsWith('https://').optional(),
      apiKey: z.string().max(500).optional(),
      host: z.string().max(200).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().max(120).optional(),
      password: z.string().max(500).optional(),
      privateKey: z.string().max(10_000).optional(),
      remoteDir: z.string().max(300).optional(),
    })
    .parse(req.body ?? {});
  // Secrets left blank keep what is stored.
  const prev = openConnection(plan.connectionEnc);
  const next = { ...prev, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')) };
  const updated = await prisma.retirementPlan.update({ where: { id: plan.id }, data: { connectionEnc: sealConnection(next) } });
  audit(req, 'retirement.connection_saved', 'RetirementPlan', plan.id, { host: next.host ?? null, baseUrl: next.baseUrl ?? null });
  res.json({ connection: describeConnection(updated.connectionEnc) });
});

retirementRouter.post('/retirement/plans/:id/sync', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const result = await syncPlanElections(prisma, plan.id);
  audit(req, 'retirement.eligibility_synced', 'RetirementPlan', plan.id, result);
  res.json(result);
});

/* ----- elections and loans --------------------------------------------- */

retirementRouter.get('/retirement/plans/:id/elections', PROCESS, async (req, res) => {
  const plan = await planOr404(String(req.params.id));
  const rows = await prisma.retirementElection.findMany({
    where: scopeWhere<Prisma.RetirementElectionWhereInput>({ planId: plan.id, tenantId: tenantIdForWrite() }, { associate: scopeAssociatesIncludingFormer(req.user!) }),
    include: { associate: { select: { firstName: true, lastName: true, hireDate: true } } },
    orderBy: [{ status: 'asc' }, { associate: { lastName: 'asc' } }],
  });
  const loans = await prisma.retirementLoan.findMany({ where: { planId: plan.id, tenantId: tenantIdForWrite(), associateId: { in: rows.map((r) => r.associateId) } }, orderBy: { startDate: 'desc' } });
  const rates = await ratesFor(plan, rows.map((r) => r.associateId));
  res.json({
    elections: rows.map((e) => ({
      id: e.id,
      associateId: e.associateId,
      name: `${e.associate.firstName} ${e.associate.lastName}`,
      hireDate: ymd(e.associate.hireDate),
      status: e.status,
      preTaxPercent: rates.get(e.associateId)?.pre ?? 0,
      rothPercent: rates.get(e.associateId)?.roth ?? 0,
      flatAmountPerPay: rates.get(e.associateId)?.flatCents != null ? rates.get(e.associateId)!.flatCents! / 100 : null,
      eligibleOn: ymd(e.eligibleOn),
      enrolledOn: ymd(e.enrolledOn),
      optOutDeadline: ymd(e.optOutDeadline),
      nextEscalationOn: ymd(e.nextEscalationOn),
      source: e.source,
      updatedAt: e.updatedAt.toISOString(),
    })),
    loans: loans.map((l) => ({ id: l.id, associateId: l.associateId, loanNumber: l.loanNumber, perPayAmount: Number(l.perPayAmount), startDate: ymd(l.startDate), endDate: ymd(l.endDate), balance: l.balance == null ? null : Number(l.balance), status: l.status })),
  });
});

retirementRouter.post('/retirement/elections/:id', PROCESS, async (req, res) => {
  const input = z
    .object({
      status: z.enum(['ENROLLED', 'OPTED_OUT']),
      preTaxPercent: z.number().min(0).max(100),
      rothPercent: z.number().min(0).max(100),
    })
    .parse(req.body ?? {});
  const e = await prisma.retirementElection.findFirst({
    where: scopeWhere<Prisma.RetirementElectionWhereInput>({ id: String(req.params.id), tenantId: tenantIdForWrite() }, { associate: scopeAssociatesIncludingFormer(req.user!) }),
    include: { plan: true },
  });
  if (!e) throw new HttpError(404, 'not_found', 'That election was not found.');
  if (e.status === 'NOT_ELIGIBLE') throw new HttpError(409, 'not_eligible', 'This person is not eligible for the plan yet.');
  if (input.rothPercent > 0 && !e.plan.rothEnabled) throw new HttpError(400, 'no_roth', 'This plan does not offer Roth deferrals.');
  if (input.preTaxPercent + input.rothPercent > 100) throw new HttpError(400, 'over_100', 'Deferrals cannot be more than 100% of pay.');
  if (!e.plan.benefitsPlanId) throw new HttpError(409, 'no_benefits_plan', 'Link this plan to its 401(k) benefits plan in Plan setup first.');
  const optOut = input.status === 'OPTED_OUT';
  const before = (await ratesFor(e.plan, [e.associateId])).get(e.associateId) ?? null;
  const updated = await prisma.$transaction(async (tx) => {
    await setDeferralRate(tx, e.plan, e.associateId, { preTaxPercent: input.preTaxPercent, rothPercent: input.rothPercent, optOut });
    return tx.retirementElection.update({
      where: { id: e.id },
      data: { status: input.status, enrolledOn: optOut ? e.enrolledOn : (e.enrolledOn ?? new Date()), nextEscalationOn: optOut ? null : e.nextEscalationOn, source: 'HR' },
    });
  });
  audit(req, 'retirement.election_changed', 'RetirementElection', e.id, { associateId: e.associateId, from: { status: e.status, ...before }, to: input });
  res.json({ id: updated.id, status: updated.status });
});

const LoanSchema = z.object({
  associateId: z.string().uuid(),
  loanNumber: z.string().trim().min(1).max(40),
  perPayAmount: z.number().positive().max(10_000),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  balance: z.number().min(0).max(100_000).nullable().optional(),
});

retirementRouter.post('/retirement/plans/:id/loans', PROCESS, async (req, res) => {
  const plan = await planOr404(String(req.params.id));
  const input = LoanSchema.parse(req.body ?? {});
  const person = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: input.associateId, tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(req.user!)) });
  if (!person) throw new HttpError(404, 'not_found', 'That person was not found.');
  try {
    const loan = await prisma.retirementLoan.create({
      data: {
        tenantId: tenantIdForWrite(),
        planId: plan.id,
        associateId: input.associateId,
        loanNumber: input.loanNumber,
        perPayAmount: input.perPayAmount,
        startDate: new Date(`${input.startDate}T00:00:00Z`),
        endDate: input.endDate ? new Date(`${input.endDate}T00:00:00Z`) : null,
        balance: input.balance ?? null,
      },
    });
    audit(req, 'retirement.loan_added', 'RetirementLoan', loan.id, { associateId: input.associateId, loanNumber: input.loanNumber, perPayAmount: input.perPayAmount });
    res.status(201).json({ id: loan.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new HttpError(409, 'duplicate_loan', 'That loan number is already on this plan.');
    throw err;
  }
});

retirementRouter.post('/retirement/loans/:id/status', PROCESS, async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACTIVE', 'PAID_OFF', 'DEFAULTED', 'SUSPENDED']) }).parse(req.body ?? {});
  const loan = await prisma.retirementLoan.findFirst({
    where: scopeWhere<Prisma.RetirementLoanWhereInput>({ id: String(req.params.id), tenantId: tenantIdForWrite() }, { associate: scopeAssociatesIncludingFormer(req.user!) }),
  });
  if (!loan) throw new HttpError(404, 'not_found', 'That loan was not found.');
  await prisma.retirementLoan.update({ where: { id: loan.id }, data: { status, ...(status !== 'ACTIVE' ? { endDate: loan.endDate ?? new Date() } : {}) } });
  audit(req, 'retirement.loan_status', 'RetirementLoan', loan.id, { status });
  res.json({ ok: true });
});

/* ----- pay dates and files --------------------------------------------- */

retirementRouter.get('/retirement/plans/:id/pay-dates', PROCESS, async (req, res) => {
  const plan = await planOr404(String(req.params.id));
  const rows = await prisma.retirementContribution.groupBy({
    by: ['payDate'],
    where: { planId: plan.id, tenantId: tenantIdForWrite() },
    _sum: { preTax: true, roth: true, catchUpPreTax: true, catchUpRoth: true, employerMatch: true, safeHarbor: true },
    _count: true,
    orderBy: { payDate: 'desc' },
    take: 60,
  });
  const files = await prisma.retirementFile.findMany({ where: { planId: plan.id, kind: 'CONTRIBUTION' }, select: { payDate: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
  res.json({
    payDates: rows.map((r) => {
      const d = ymd(r.payDate)!;
      const file = files.find((f) => ymd(f.payDate) === d);
      const s = r._sum;
      return {
        payDate: d,
        people: r._count,
        employee: r2(Number(s.preTax ?? 0) + Number(s.roth ?? 0) + Number(s.catchUpPreTax ?? 0) + Number(s.catchUpRoth ?? 0)),
        employer: r2(Number(s.employerMatch ?? 0) + Number(s.safeHarbor ?? 0)),
        fileStatus: file?.status ?? null,
      };
    }),
  });
});

async function ssnMap(associateIds: string[]): Promise<Map<string, string>> {
  const rows = await prisma.w4Submission.findMany({ where: { associateId: { in: associateIds } }, select: { associateId: true, ssnEncrypted: true } });
  const out = new Map<string, string>();
  for (const r of rows) if (r.ssnEncrypted) out.set(r.associateId, decryptString(r.ssnEncrypted));
  return out;
}

function missingSsn(names: string[]): never {
  throw new HttpError(409, 'ssn_missing', `The recordkeeper needs a full SSN for ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. Collect their W-4 first.`, { names });
}

async function saveFile(req: Request, planId: string, kind: string, format: string, content: string, rowCount: number, totals: Record<string, unknown>, extra: { payDate?: string | null; payrollRunId?: string | null } = {}) {
  const file = await prisma.retirementFile.create({
    data: {
      tenantId: tenantIdForWrite(),
      planId,
      kind,
      format,
      content: encryptString(content).toString('base64'),
      rowCount,
      totals: totals as Prisma.InputJsonObject,
      payDate: extra.payDate ? new Date(`${extra.payDate}T00:00:00Z`) : null,
      payrollRunId: extra.payrollRunId ?? null,
      createdById: req.user!.id,
    },
  });
  audit(req, `retirement.file_${kind.toLowerCase()}`, 'RetirementFile', file.id, { planId, rowCount, ...totals });
  return file;
}

function shapeFile(f: Prisma.RetirementFileGetPayload<object>) {
  return { id: f.id, kind: f.kind, format: f.format, payDate: ymd(f.payDate), rowCount: f.rowCount, totals: f.totals, status: f.status, error: f.error, sentAt: f.sentAt?.toISOString() ?? null, createdAt: f.createdAt.toISOString() };
}

retirementRouter.post('/retirement/plans/:id/files/contributions', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const { payDate } = z.object({ payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body ?? {});
  const contributions = await prisma.retirementContribution.findMany({
    where: { planId: plan.id, tenantId: tenantIdForWrite(), payDate: new Date(`${payDate}T00:00:00Z`) },
    include: { associate: { select: { id: true, firstName: true, lastName: true, dob: true, hireDate: true, separatedAt: true } } },
  });
  if (!contributions.length) throw new HttpError(404, 'nothing_to_send', 'No contributions were withheld on that pay date.');
  const items = await prisma.payrollItem.findMany({ where: { id: { in: contributions.map((c) => c.payrollItemId).filter((x): x is string => !!x) } }, select: { id: true, hoursWorked: true, grossPay: true } });
  const itemById = new Map(items.map((i) => [i.id, i]));
  const ssns = await ssnMap(contributions.map((c) => c.associateId));
  const missing = contributions.filter((c) => !ssns.has(c.associateId)).map((c) => `${c.associate.firstName} ${c.associate.lastName}`);
  if (missing.length) missingSsn(missing);
  const rows: ContributionRow[] = contributions.map((c) => {
    const item = c.payrollItemId ? itemById.get(c.payrollItemId) : undefined;
    return {
      ssn: ssns.get(c.associateId)!,
      employeeId: c.associateId,
      firstName: c.associate.firstName,
      lastName: c.associate.lastName,
      dob: ymd(c.associate.dob),
      hireDate: ymd(c.associate.hireDate),
      termDate: ymd(c.associate.separatedAt),
      payDate,
      grossPay: item ? Number(item.grossPay) : Number(c.eligibleComp),
      planComp: Number(c.eligibleComp),
      hours: item ? Number(item.hoursWorked) : null,
      preTax: Number(c.preTax),
      roth: Number(c.roth),
      catchUpPreTax: Number(c.catchUpPreTax),
      catchUpRoth: Number(c.catchUpRoth),
      employerMatch: Number(c.employerMatch),
      safeHarbor: Number(c.safeHarbor),
      loans: (c.loanRepayments as Array<{ loanNumber: string; amount: number }>) ?? [],
    };
  });
  const adapter = adapterFor(plan.recordkeeper);
  const content = adapter.contributionFile(plan.planNumber, payDate, rows);
  const file = await saveFile(req, plan.id, 'CONTRIBUTION', adapter.id, content, rows.length, contributionTotals(rows), { payDate });
  await prisma.retirementContribution.updateMany({ where: { id: { in: contributions.map((c) => c.id) } }, data: { fileId: file.id } });
  res.status(201).json({ file: shapeFile(file) });
});

retirementRouter.post('/retirement/plans/:id/files/census', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const asOf = new Date().toISOString().slice(0, 10);
  const yearStart = new Date(`${asOf.slice(0, 4)}-01-01T00:00:00Z`);
  const elections = await prisma.retirementElection.findMany({
    where: { planId: plan.id, tenantId: tenantIdForWrite() },
    include: { associate: { select: { id: true, firstName: true, lastName: true, dob: true, hireDate: true, separatedAt: true, email: true, addressLine1: true, city: true, state: true, zip: true } } },
  });
  if (!elections.length) throw new HttpError(404, 'nothing_to_send', 'No one is in this plan yet; bring eligibility up to date first.');
  const ids = elections.map((e) => e.associateId);
  const rates = await ratesFor(plan, ids);
  const ytd = await prisma.payrollItem.groupBy({
    by: ['associateId'],
    where: { associateId: { in: ids }, payrollRun: { periodEnd: { gte: yearStart }, status: { in: ['FINALIZED', 'DISBURSED'] } } },
    _sum: { grossPay: true, hoursWorked: true },
  });
  const ytdBy = new Map(ytd.map((y) => [y.associateId, y._sum]));
  const ssns = await ssnMap(ids);
  const missing = elections.filter((e) => !ssns.has(e.associateId)).map((e) => `${e.associate.firstName} ${e.associate.lastName}`);
  if (missing.length) missingSsn(missing);
  const rows: CensusRow[] = elections.map((e) => ({
    ssn: ssns.get(e.associateId)!,
    employeeId: e.associateId,
    firstName: e.associate.firstName,
    lastName: e.associate.lastName,
    dob: ymd(e.associate.dob),
    hireDate: ymd(e.associate.hireDate),
    termDate: ymd(e.associate.separatedAt),
    email: e.associate.email,
    addressLine1: e.associate.addressLine1,
    city: e.associate.city,
    state: e.associate.state,
    zip: e.associate.zip,
    ytdComp: Number(ytdBy.get(e.associateId)?.grossPay ?? 0),
    ytdHours: Number(ytdBy.get(e.associateId)?.hoursWorked ?? 0),
    electionStatus: e.status,
    preTaxPercent: rates.get(e.associateId)?.pre ?? 0,
    rothPercent: rates.get(e.associateId)?.roth ?? 0,
  }));
  const adapter = adapterFor(plan.recordkeeper);
  const content = adapter.censusFile(plan.planNumber, asOf, rows);
  const file = await saveFile(req, plan.id, 'CENSUS', adapter.id, content, rows.length, { people: rows.length, asOf });
  res.status(201).json({ file: shapeFile(file) });
});

retirementRouter.post('/retirement/plans/:id/files/true-up', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const { year } = z.object({ year: z.number().int().min(2020).max(2100) }).parse(req.body ?? {});
  const sums = await prisma.retirementContribution.groupBy({
    by: ['associateId'],
    where: { planId: plan.id, tenantId: tenantIdForWrite(), payDate: { gte: new Date(`${year}-01-01T00:00:00Z`), lt: new Date(`${year + 1}-01-01T00:00:00Z`) } },
    _sum: { eligibleComp: true, preTax: true, roth: true, employerMatch: true, safeHarbor: true },
  });
  const owed = sums
    .map((s) => ({
      associateId: s.associateId,
      comp: Number(s._sum.eligibleComp ?? 0),
      amount: trueUp(plan, {
        comp: Number(s._sum.eligibleComp ?? 0),
        deferralExCatchUp: Number(s._sum.preTax ?? 0) + Number(s._sum.roth ?? 0),
        matchPaid: Number(s._sum.employerMatch ?? 0),
        safeHarborPaid: Number(s._sum.safeHarbor ?? 0),
      }),
    }))
    .filter((o) => o.amount > 0);
  if (!owed.length) {
    res.json({ file: null, owed: [], message: `No one is owed a true-up for ${year}.` });
    return;
  }
  const people = await prisma.associate.findMany({ where: { id: { in: owed.map((o) => o.associateId) } }, select: { id: true, firstName: true, lastName: true, dob: true, hireDate: true, separatedAt: true } });
  const byId = new Map(people.map((p) => [p.id, p]));
  const ssns = await ssnMap(owed.map((o) => o.associateId));
  const missing = owed.filter((o) => !ssns.has(o.associateId)).map((o) => `${byId.get(o.associateId)?.firstName ?? ''} ${byId.get(o.associateId)?.lastName ?? ''}`.trim());
  if (missing.length) missingSsn(missing);
  const payDate = `${year}-12-31`;
  const rows: ContributionRow[] = owed.map((o) => {
    const p = byId.get(o.associateId)!;
    return {
      ssn: ssns.get(o.associateId)!, employeeId: o.associateId, firstName: p.firstName, lastName: p.lastName,
      dob: ymd(p.dob), hireDate: ymd(p.hireDate), termDate: ymd(p.separatedAt), payDate,
      grossPay: 0, planComp: 0, hours: null, preTax: 0, roth: 0, catchUpPreTax: 0, catchUpRoth: 0,
      employerMatch: o.amount, safeHarbor: 0, loans: [],
    };
  });
  const adapter = adapterFor(plan.recordkeeper);
  const content = adapter.contributionFile(plan.planNumber, payDate, rows);
  const file = await saveFile(req, plan.id, 'TRUE_UP', adapter.id, content, rows.length, { year, people: rows.length, employer: r2(owed.reduce((s, o) => s + o.amount, 0)) }, { payDate });
  res.status(201).json({ file: shapeFile(file), owed: owed.map((o) => ({ associateId: o.associateId, name: `${byId.get(o.associateId)!.firstName} ${byId.get(o.associateId)!.lastName}`, amount: o.amount })) });
});

retirementRouter.get('/retirement/plans/:id/files', PROCESS, async (req, res) => {
  const plan = await planOr404(String(req.params.id));
  const files = await prisma.retirementFile.findMany({ where: { planId: plan.id, tenantId: tenantIdForWrite() }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ files: files.map(shapeFile), truncated: files.length === 200 });
});

async function fileOr404(id: string) {
  const f = await prisma.retirementFile.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: { plan: true } });
  if (!f) throw new HttpError(404, 'not_found', 'That file was not found.');
  return f;
}

retirementRouter.get('/retirement/files/:id/download', EXPORT_PII, async (req, res) => {
  const authority = assertBulkPiiExporter(req);
  const f = await fileOr404(String(req.params.id));
  const adapter = adapterFor(f.plan.recordkeeper);
  audit(req, 'retirement.file_downloaded', 'RetirementFile', f.id, { kind: f.kind, rowCount: f.rowCount, authority });
  res.setHeader('Content-Type', adapter.extension === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${f.kind.toLowerCase()}-${ymd(f.payDate) ?? ymd(f.createdAt)}.${adapter.extension}"`);
  res.send(decryptString(Buffer.from(f.content, 'base64')));
});

retirementRouter.post('/retirement/files/:id/send', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const f = await fileOr404(String(req.params.id));
  if (f.status === 'SENT') throw new HttpError(409, 'already_sent', 'This file was already sent.');
  const adapter = adapterFor(f.plan.recordkeeper);
  const name = `${f.plan.planNumber ?? 'plan'}-${f.kind.toLowerCase()}-${ymd(f.payDate) ?? ymd(f.createdAt)}.${adapter.extension}`;
  try {
    const { reference } = await deliverFile(adapter.transport as Transport, openConnection(f.plan.connectionEnc), name, decryptString(Buffer.from(f.content, 'base64')), adapter.extension === 'csv' ? 'text/csv' : 'text/plain');
    const updated = await prisma.retirementFile.update({ where: { id: f.id }, data: { status: 'SENT', sentAt: new Date(), error: null } });
    audit(req, 'retirement.file_sent', 'RetirementFile', f.id, { reference });
    res.json({ file: shapeFile(updated), reference });
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    const updated = await prisma.retirementFile.update({ where: { id: f.id }, data: { status: 'FAILED', error: err.message.slice(0, 1000) } });
    audit(req, 'retirement.file_send_failed', 'RetirementFile', f.id, { error: err.message });
    res.status(502).json({ file: shapeFile(updated), error: { code: 'delivery_failed', message: err.message } });
  }
});

/* ----- deferral changes from the recordkeeper -------------------------- */

retirementRouter.post('/retirement/plans/:id/deferral-changes', PROCESS, async (req, res) => {
  refuseNarrowed(req.user!);
  const plan = await planOr404(String(req.params.id));
  const { content } = z.object({ content: z.string().min(5).max(5_000_000) }).parse(req.body ?? {});
  if (!plan.benefitsPlanId) throw new HttpError(409, 'no_benefits_plan', 'Link this plan to its 401(k) benefits plan in Plan setup first.');
  const changes = adapterFor(plan.recordkeeper).parseDeferralChanges(content);
  if (!changes.length) throw new HttpError(400, 'no_changes', 'The file has no deferral changes we can read. It needs an SSN or employee ID and the new rates.');
  const elections = await prisma.retirementElection.findMany({ where: { planId: plan.id, tenantId: tenantIdForWrite() }, select: { id: true, associateId: true, status: true, enrolledOn: true } });
  const byAssociate = new Map(elections.map((e) => [e.associateId, e]));
  const ssns = await ssnMap(elections.map((e) => e.associateId));
  const bySsn = new Map([...ssns.entries()].map(([id, ssn]) => [ssn, id]));
  let applied = 0;
  const unmatched: string[] = [];
  const skipped: string[] = [];
  for (const c of changes) {
    const associateId = (c.ssn ? bySsn.get(c.ssn) : undefined) ?? (c.employeeId && byAssociate.has(c.employeeId) ? c.employeeId : undefined);
    const label = c.ssn ? `SSN ending ${c.ssn.slice(-4)}` : (c.employeeId ?? 'a row with no ID');
    if (!associateId) {
      unmatched.push(label);
      continue;
    }
    const e = byAssociate.get(associateId)!;
    if (e.status === 'NOT_ELIGIBLE') {
      skipped.push(`${label}: not eligible yet`);
      continue;
    }
    const optOut = c.optOut || (c.preTaxPercent === 0 && c.rothPercent === 0);
    const effective = c.effectiveDate && c.effectiveDate > new Date().toISOString().slice(0, 10) ? new Date(`${c.effectiveDate}T00:00:00Z`) : new Date();
    await prisma.$transaction(async (tx) => {
      await setDeferralRate(tx, plan, associateId, { preTaxPercent: c.preTaxPercent, rothPercent: c.rothPercent, optOut }, effective);
      await tx.retirementElection.update({
        where: { id: e.id },
        data: { status: optOut ? 'OPTED_OUT' : 'ENROLLED', enrolledOn: optOut ? e.enrolledOn : (e.enrolledOn ?? effective), nextEscalationOn: null, source: 'RECORDKEEPER' },
      });
    });
    applied += 1;
  }
  audit(req, 'retirement.deferral_changes_applied', 'RetirementPlan', plan.id, { applied, unmatched: unmatched.length, skipped: skipped.length });
  res.json({ applied, unmatched, skipped });
});
