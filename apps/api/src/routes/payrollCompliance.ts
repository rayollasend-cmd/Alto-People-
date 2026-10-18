import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { assertBulkPiiExporter } from '../lib/bulkPiiExport.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertAssociateInScope, isInternallyScoped, scopeAssociates, scopeWhere } from '../lib/scope.js';
import { LIMITS, limitsFor } from '../lib/contributionLimits.js';
import { loadDeferralContexts, rothCatchUpStatus } from '../lib/retirementDeferrals.js';
import { ELEMENT_LABEL, WAGE_STATEMENT_RULES } from '../lib/wageStatementRules.js';
import {
  acknowledgePayNotice,
  FORM_TITLE,
  issuePayNotice,
  NOTICE_RULES,
  noticeLines,
  renderPayNoticePdf,
  UNSIGNED_AFTER_DAYS,
  type NoticeFacts,
  type NoticeForm,
  type NoticeLanguage,
} from '../lib/payNotices.js';
import {
  buildNewHireRecords,
  deadlineDays,
  markSubmitted,
  newHireCsv,
  providerForState,
  syncRecentHires,
} from '../lib/newHireReporting.js';
import { notifyAssociate } from '../lib/notify.js';

/**
 * Pay compliance (2026): the limits and the Roth catch-up rule, state pay
 * notices and their acknowledgments, state new-hire reporting, and the
 * wage-statement rules the pre-run checks apply.
 *
 *   GET  /pay-compliance/limits?year
 *   GET  /pay-compliance/roth-catch-up?year            people with a 401(k)/403(b)
 *   GET  /pay-compliance/people/:id/roth-catch-up?year  the person record's line
 *   GET  /pay-compliance/wage-statement-rules
 *   GET  /pay-compliance/pay-notices?status=SENT|ACKNOWLEDGED
 *   POST /pay-compliance/pay-notices {associateId}       issue (or re-issue) now
 *   POST /pay-compliance/pay-notices/:id/remind
 *   GET  /pay-compliance/pay-notices/:id/pdf
 *   GET  /me/pay-notices · /me/pay-notices/:id · /me/pay-notices/:id/pdf
 *   POST /me/pay-notices/:id/acknowledge {signedName}
 *   GET  /pay-compliance/new-hire-reports?status=DUE|SUBMITTED
 *   GET  /pay-compliance/new-hire-settings · PUT {multistateState}
 *   GET  /pay-compliance/new-hire-reports/file.csv?state=XX   SSNs: export:payroll-pii
 *   POST /pay-compliance/new-hire-reports/submit {reportIds, confirmation?}
 *   POST /pay-compliance/new-hire-reports/file {state}        through a filing service
 *
 * Every list is the tenant's and inside the caller's reach (lib/scope).
 */
export const payrollComplianceRouter = Router();

const PROCESS = requireCapability('process:payroll');
const EXPORT_PII = requireCapability('export:payroll-pii');
const DAY_MS = 86_400_000;

const YearQuery = z.object({ year: z.coerce.number().int().min(2020).max(2100).optional() });
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

// ----- Limits and Roth catch-up --------------------------------------------

payrollComplianceRouter.get('/pay-compliance/limits', requireAuth, PROCESS, (req, res) => {
  const { year } = YearQuery.parse(req.query);
  const y = year ?? new Date().getUTCFullYear();
  res.json({ limits: limitsFor(y), knownYears: Object.keys(LIMITS).map(Number) });
});

async function rothRows(user: NonNullable<Request['user']>, year: number, associateId?: string) {
  const tenantId = tenantIdForWrite();
  const enrollments = await prisma.benefitsEnrollment.findMany({
    where: {
      tenantId,
      plan: { kind: { in: ['RETIREMENT_401K', 'RETIREMENT_403B'] } },
      effectiveDate: { lte: new Date(Date.UTC(year, 11, 31)) },
      OR: [{ terminationDate: null }, { terminationDate: { gte: new Date(Date.UTC(year, 0, 1)) } }],
      associate: scopeWhere<Prisma.AssociateWhereInput>({ deletedAt: null }, scopeAssociates(user), associateId ? { id: associateId } : null),
    },
    select: {
      associateId: true,
      rothElection: true,
      electedAmountCentsPerPeriod: true,
      plan: { select: { name: true, kind: true, allowsDeemedRoth: true } },
      associate: { select: { firstName: true, lastName: true, dob: true } },
    },
    orderBy: [{ associate: { lastName: 'asc' } }],
  });
  const asOf = year === new Date().getUTCFullYear() ? new Date() : new Date(Date.UTC(year, 11, 31));
  const contexts = await loadDeferralContexts(prisma, [...new Set(enrollments.map((e) => e.associateId))], asOf);
  const limits = limitsFor(year);
  const showDollars = !isInternallyScoped(user);
  return enrollments.map((e) => {
    const ctx = contexts.get(e.associateId);
    const prior = ctx?.priorYearFicaWages ?? 0;
    const s = rothCatchUpStatus({ dob: e.associate.dob, priorYearFicaWages: prior, year, rothElection: e.rothElection, allowsDeemedRoth: e.plan.allowsDeemedRoth });
    const ytd = ctx ? ctx.ytd.pre401k + ctx.ytd.pre403b + ctx.ytd.roth401k + ctx.ytd.roth403b : 0;
    return {
      associateId: e.associateId,
      name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
      plan: e.plan.name,
      planKind: e.plan.kind,
      rothElection: e.rothElection,
      planAllowsDeemedRoth: e.plan.allowsDeemedRoth,
      age: s.age,
      status: s.status,
      higherEarner: s.highEarner,
      catchUpAllowance: s.catchUpAllowance,
      priorYearFicaWages: showDollars ? Math.round(prior * 100) / 100 : null,
      threshold: limits.rothCatchUpWageThreshold,
      ytdDeferred: showDollars ? Math.round(ytd * 100) / 100 : null,
      annualLimit: limits.deferral402g + s.catchUpAllowance,
    };
  });
}

payrollComplianceRouter.get('/pay-compliance/roth-catch-up', requireAuth, PROCESS, async (req, res) => {
  const { year } = YearQuery.parse(req.query);
  const y = year ?? new Date().getUTCFullYear();
  res.json({ year: y, limits: limitsFor(y), people: await rothRows(req.user!, y) });
});

payrollComplianceRouter.get('/pay-compliance/people/:id/roth-catch-up', requireAuth, PROCESS, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await assertAssociateInScope(prisma, req.user!, id);
  const { year } = YearQuery.parse(req.query);
  const y = year ?? new Date().getUTCFullYear();
  res.json({ year: y, plans: await rothRows(req.user!, y, id) });
});

payrollComplianceRouter.get('/pay-compliance/wage-statement-rules', requireAuth, PROCESS, (_req, res) => {
  res.json({
    rules: Object.values(WAGE_STATEMENT_RULES).map((r) => ({ state: r.state, citation: r.citation, elements: r.elements.map((e) => ({ key: e, label: ELEMENT_LABEL[e] })) })),
    noticeRules: Object.values(NOTICE_RULES),
  });
});

// ----- Pay notices ----------------------------------------------------------

function noticeView(n: {
  id: string;
  associateId: string;
  state: string;
  form: string;
  trigger: string;
  language: string;
  status: string;
  sentAt: Date;
  acknowledgedAt: Date | null;
  signedName: string | null;
  facts: Prisma.JsonValue;
  associate?: { firstName: string; lastName: string } | null;
}) {
  const facts = n.facts as unknown as NoticeFacts;
  return {
    id: n.id,
    associateId: n.associateId,
    name: n.associate ? `${n.associate.firstName} ${n.associate.lastName}`.trim() : facts.employee?.name ?? '',
    state: n.state,
    form: n.form,
    formTitle: FORM_TITLE[n.form as NoticeForm] ?? n.form,
    trigger: n.trigger,
    language: n.language,
    status: n.status,
    sentAt: n.sentAt.toISOString(),
    acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
    signedName: n.signedName,
    overdue: n.status === 'SENT' && n.sentAt.getTime() < Date.now() - UNSIGNED_AFTER_DAYS * DAY_MS,
    missing: facts.missing ?? [],
    untranslatedLanguage: facts.untranslatedLanguage ?? null,
  };
}

const NoticeListQuery = z.object({ status: z.enum(['SENT', 'ACKNOWLEDGED']).optional() });

payrollComplianceRouter.get('/pay-compliance/pay-notices', requireAuth, PROCESS, async (req, res) => {
  const { status } = NoticeListQuery.parse(req.query);
  const rows = await prisma.wagePayNotice.findMany({
    where: scopeWhere<Prisma.WagePayNoticeWhereInput>({ tenantId: tenantIdForWrite() }, status ? { status } : null, { associate: scopeAssociates(req.user!) }),
    include: { associate: { select: { firstName: true, lastName: true } } },
    orderBy: [{ status: 'desc' }, { sentAt: 'asc' }],
    take: 1000,
  });
  res.json({ notices: rows.map(noticeView), truncated: rows.length === 1000 });
});

payrollComplianceRouter.post('/pay-compliance/pay-notices', requireAuth, PROCESS, async (req, res) => {
  const { associateId } = z.object({ associateId: z.string().uuid() }).parse(req.body);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const notice = await issuePayNotice(prisma, { associateId, trigger: 'MANUAL', actorUserId: req.user!.id });
  if (!notice) throw new HttpError(422, 'no_notice_rule', 'No pay notice applies: the work state has no notice rule, the job is exempt where the rule covers non-exempt only, or there is no pay rate on file.');
  enqueueAudit({ actorUserId: req.user!.id, action: 'pay_notice.issued', entityType: 'WagePayNotice', entityId: notice.id, metadata: { associateId, form: notice.form, state: notice.state } }, 'payNotices');
  res.status(201).json({ notice: noticeView(notice) });
});

async function noticeInReach(req: Request, id: string) {
  const n = await prisma.wagePayNotice.findFirst({
    where: scopeWhere<Prisma.WagePayNoticeWhereInput>({ id, tenantId: tenantIdForWrite() }, { associate: scopeAssociates(req.user!) }),
    include: { associate: { select: { firstName: true, lastName: true } } },
  });
  if (!n) throw new HttpError(404, 'notice_not_found', 'No such pay notice.');
  return n;
}

payrollComplianceRouter.post('/pay-compliance/pay-notices/:id/remind', requireAuth, PROCESS, async (req, res) => {
  const n = await noticeInReach(req, z.string().uuid().parse(req.params.id));
  if (n.status !== 'SENT') throw new HttpError(409, 'already_signed', 'This notice is already signed.');
  await notifyAssociate(n.associateId, {
    subject: 'Reminder: please sign your pay notice',
    body: `${n.state} law requires a signed notice of your pay rate and payday.`,
    category: 'compensation',
    linkUrl: `/me/pay-notices/${n.id}`,
    emailFallback: true,
  });
  res.json({ ok: true });
});

function sendPdf(res: import('express').Response, buf: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}

payrollComplianceRouter.get('/pay-compliance/pay-notices/:id/pdf', requireAuth, PROCESS, async (req, res) => {
  const n = await noticeInReach(req, z.string().uuid().parse(req.params.id));
  sendPdf(res, await renderPayNoticePdf(n), `pay-notice-${n.form}-${n.id.slice(0, 8)}.pdf`);
});

// The worker's own.
async function ownNotice(req: Request, id: string) {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'not_an_associate', 'Only employees have pay notices.');
  const n = await prisma.wagePayNotice.findFirst({ where: { id, associateId } });
  if (!n) throw new HttpError(404, 'notice_not_found', 'No such pay notice.');
  return n;
}

payrollComplianceRouter.get('/me/pay-notices', requireAuth, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) return res.json({ notices: [] });
  const rows = await prisma.wagePayNotice.findMany({ where: { associateId }, orderBy: { sentAt: 'desc' }, take: 100 });
  res.json({ notices: rows.map(noticeView) });
});

payrollComplianceRouter.get('/me/pay-notices/:id', requireAuth, async (req, res) => {
  const n = await ownNotice(req, z.string().uuid().parse(req.params.id));
  const facts = n.facts as unknown as NoticeFacts;
  const langs: NoticeLanguage[] = n.language !== 'en' ? [n.language as NoticeLanguage, 'en'] : ['en'];
  res.json({ notice: noticeView(n), sections: langs.map((l) => ({ language: l, lines: noticeLines(facts, l) })) });
});

payrollComplianceRouter.get('/me/pay-notices/:id/pdf', requireAuth, async (req, res) => {
  const n = await ownNotice(req, z.string().uuid().parse(req.params.id));
  sendPdf(res, await renderPayNoticePdf(n), `pay-notice-${n.id.slice(0, 8)}.pdf`);
});

payrollComplianceRouter.post('/me/pay-notices/:id/acknowledge', requireAuth, async (req, res) => {
  const n = await ownNotice(req, z.string().uuid().parse(req.params.id));
  const { signedName } = z.object({ signedName: z.string().trim().min(2).max(200) }).parse(req.body);
  if (n.status === 'ACKNOWLEDGED') return res.json({ notice: noticeView(n) });
  const signed = await acknowledgePayNotice(prisma, n, { signedName, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
  enqueueAudit({ actorUserId: req.user!.id, action: 'pay_notice.acknowledged', entityType: 'WagePayNotice', entityId: n.id, metadata: { form: n.form, documentHash: signed.documentHash } }, 'payNotices');
  res.json({ notice: noticeView(signed) });
});

// ----- New-hire reporting ---------------------------------------------------

const ReportListQuery = z.object({ status: z.enum(['DUE', 'SUBMITTED']).optional() });

payrollComplianceRouter.get('/pay-compliance/new-hire-reports', requireAuth, PROCESS, async (req, res) => {
  const { status } = ReportListQuery.parse(req.query);
  const tenantId = tenantIdForWrite();
  await syncRecentHires(prisma, tenantId);
  const rows = await prisma.newHireReport.findMany({
    where: scopeWhere<Prisma.NewHireReportWhereInput>({ tenantId }, status ? { status } : null, { associate: scopeAssociates(req.user!) }),
    include: { associate: { select: { firstName: true, lastName: true } } },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    take: 1000,
  });
  const today = new Date(new Date().toISOString().slice(0, 10));
  const { blocked } = await buildNewHireRecords(prisma, rows.filter((r) => r.status === 'DUE'));
  const blockedBy = new Map(blocked.map((b) => [b.reportId, b.reasons]));
  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      state: r.state,
      hireDate: ymd(r.hireDate),
      dueDate: ymd(r.dueDate),
      deadlineDays: deadlineDays(r.state).days,
      confirmDeadlineWithState: deadlineDays(r.state).confirmWithState,
      status: r.status,
      overdue: r.status === 'DUE' && r.dueDate < today,
      method: r.method,
      confirmation: r.confirmation,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      blockedBy: blockedBy.get(r.id) ?? [],
      filingService: providerForState(r.state)?.label ?? null,
    })),
    truncated: rows.length === 1000,
  });
});

payrollComplianceRouter.get('/pay-compliance/new-hire-settings', requireAuth, PROCESS, async (_req, res) => {
  const s = await prisma.orgSetting.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { newHireMultistateState: true } });
  res.json({ multistateState: s?.newHireMultistateState ?? null });
});

payrollComplianceRouter.put('/pay-compliance/new-hire-settings', requireAuth, requireCapability('manage:org'), async (req, res) => {
  const { multistateState } = z.object({ multistateState: z.string().trim().length(2).toUpperCase().nullable() }).parse(req.body);
  const tenantId = tenantIdForWrite();
  const s = await prisma.orgSetting.findFirst({ where: { tenantId }, select: { id: true, newHireMultistateState: true } });
  if (!s) throw new HttpError(409, 'no_org_settings', 'Organization settings are not set up yet.');
  await prisma.orgSetting.update({ where: { id: s.id }, data: { newHireMultistateState: multistateState } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'new_hire.multistate_changed', entityType: 'OrgSetting', entityId: s.id, metadata: { from: s.newHireMultistateState, to: multistateState } }, 'newHire');
  res.json({ multistateState });
});

async function dueReports(req: Request, state: string, ids?: string[]) {
  return prisma.newHireReport.findMany({
    where: scopeWhere<Prisma.NewHireReportWhereInput>({ tenantId: tenantIdForWrite(), state, status: 'DUE' }, ids ? { id: { in: ids } } : null, { associate: scopeAssociates(req.user!) }),
    orderBy: { dueDate: 'asc' },
  });
}

const StateQuery = z.object({ state: z.string().trim().length(2).toUpperCase(), ids: z.string().optional() });

payrollComplianceRouter.get('/pay-compliance/new-hire-reports/file.csv', requireAuth, EXPORT_PII, async (req, res) => {
  const exportAuthority = assertBulkPiiExporter(req);
  const q = StateQuery.parse(req.query);
  const ids = q.ids ? q.ids.split(',').filter((s) => /^[0-9a-f-]{36}$/i.test(s)) : undefined;
  const reports = await dueReports(req, q.state, ids);
  const { records, blocked } = await buildNewHireRecords(prisma, reports);
  if (records.length === 0) throw new HttpError(404, 'nothing_to_report', blocked.length ? 'Every due report is missing data — see the reasons beside each hire.' : 'Nothing due for this state.');
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.new_hire_report_exported', entityType: 'NewHireReport', entityId: req.user!.id, metadata: { state: q.state, rowCount: records.length, reportIds: records.map((r) => r.reportId), exportAuthority } },
    'payroll.new_hire_report_exported',
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="new-hire-${q.state}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Report-Ids', records.map((r) => r.reportId).join(','));
  res.send(newHireCsv(records));
});

payrollComplianceRouter.post('/pay-compliance/new-hire-reports/submit', requireAuth, PROCESS, async (req, res) => {
  const { reportIds, confirmation } = z.object({ reportIds: z.array(z.string().uuid()).min(1).max(1000), confirmation: z.string().trim().max(120).nullable().optional() }).parse(req.body);
  const inReach = await prisma.newHireReport.findMany({
    where: scopeWhere<Prisma.NewHireReportWhereInput>({ tenantId: tenantIdForWrite(), id: { in: reportIds } }, { associate: scopeAssociates(req.user!) }),
    select: { id: true },
  });
  const marked = await markSubmitted(prisma, inReach.map((r) => r.id), { method: 'MANUAL', confirmation: confirmation ?? null, userId: req.user!.id });
  enqueueAudit({ actorUserId: req.user!.id, action: 'new_hire.marked_submitted', entityType: 'NewHireReport', entityId: req.user!.id, metadata: { count: marked, reportIds: inReach.map((r) => r.id), confirmation: confirmation ?? null } }, 'newHire');
  res.json({ marked });
});

payrollComplianceRouter.post('/pay-compliance/new-hire-reports/file', requireAuth, EXPORT_PII, async (req, res) => {
  const exportAuthority = assertBulkPiiExporter(req);
  const { state } = z.object({ state: z.string().trim().length(2).toUpperCase() }).parse(req.body);
  const provider = providerForState(state);
  if (!provider) throw new HttpError(409, 'no_filing_service', `No filing service is connected for ${state}. Download the file, upload it to the state portal and mark it submitted.`);
  const reports = await dueReports(req, state);
  const { records, blocked } = await buildNewHireRecords(prisma, reports);
  if (records.length === 0) throw new HttpError(404, 'nothing_to_report', 'Nothing ready to file for this state.');
  const { confirmation } = await provider.submit(state, records);
  const marked = await markSubmitted(prisma, records.map((r) => r.reportId), { method: 'PROVIDER', confirmation, userId: req.user!.id });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, action: 'payroll.new_hire_report_filed', entityType: 'NewHireReport', entityId: req.user!.id, metadata: { state, provider: provider.key, confirmation, rowCount: marked, exportAuthority } },
    'payroll.new_hire_report_filed',
  );
  res.json({ filed: marked, confirmation, blocked: blocked.length });
});

// ----- Inbox counts ---------------------------------------------------------

/** HR: notices unsigned past the grace period, inside the caller's reach. */
export function unsignedPayNoticesCount(user: NonNullable<Request['user']>): Promise<number> {
  return prisma.wagePayNotice.count({
    where: scopeWhere<Prisma.WagePayNoticeWhereInput>(
      { tenantId: tenantIdForWrite(), status: 'SENT', sentAt: { lt: new Date(Date.now() - UNSIGNED_AFTER_DAYS * DAY_MS) } },
      { associate: scopeAssociates(user) },
    ),
  });
}

/** Payroll: new-hire reports due within five days or late. */
export function newHireReportsDueCount(user: NonNullable<Request['user']>): Promise<number> {
  return prisma.newHireReport.count({
    where: scopeWhere<Prisma.NewHireReportWhereInput>(
      { tenantId: tenantIdForWrite(), status: 'DUE', dueDate: { lte: new Date(Date.now() + 5 * DAY_MS) } },
      { associate: scopeAssociates(user) },
    ),
  });
}

/** The worker: their notices waiting for a signature. */
export function myPayNoticesToSign(associateId: string): Promise<number> {
  return prisma.wagePayNotice.count({ where: { associateId, status: 'SENT' } });
}
