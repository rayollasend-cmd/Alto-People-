import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Prisma, TaxAgencyKind } from '@prisma/client';
import { UPLOAD_MAX_BYTES, hasCapability, rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { assertBulkPiiExporter } from '../lib/bulkPiiExport.js';
import { getBlobStore } from '../lib/blobStore.js';
import { filingMode, withProvider } from '../lib/embeddedPayroll/index.js';
import { isDepositFrequency, quarterLabel } from '../lib/payrollTaxCalendar.js';
import {
  KIND_LABEL,
  NO_INCOME_TAX_STATES,
  STATE_NAMES,
  agencyNameFor,
  cancelPayment,
  createPayment,
  markPaymentPaid,
  rebuildLiabilities,
  refreshProviderPayments,
  registrationsNeeded,
  submitPaymentToProvider,
} from '../lib/payrollTaxLedger.js';
import { RETURN_KINDS, RETURN_LABEL, agencyKindFor, amendReturn, generateReturn, reconcile, returnCsv, returnDueDate, type ReturnKind } from '../lib/payrollTaxReturns.js';
import { isClientBoundedRole, isInternallyScoped } from '../lib/scope.js';
import { personVariances, yearEndReconciliation, type PersonMetric } from '../lib/yearEndReconciliation.js';
import { yearEndWorkbook } from '../lib/yearEndWorkbook.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { safeContentDisposition, sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';

/**
 * /payroll-taxes — the payroll-tax desk (mounted behind process:payroll).
 *
 * Liabilities every disbursed run posted, deposits and their due dates,
 * returns by quarter, reconciliation, agency accounts, the register-in-a-
 * new-state checklist and agency notices. Payroll taxes are owed by the
 * whole employer, so the desk is for whole-tenant reach only: a caller
 * narrowed to sites, regions or a client is refused rather than shown a
 * company-wide liability.
 */
export const payrollTaxesRouter = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const AGENCY_KINDS = ['FEDERAL_WITHHOLDING', 'FEDERAL_UNEMPLOYMENT', 'STATE_WITHHOLDING', 'STATE_UNEMPLOYMENT', 'LOCAL'] as const;
const PERIOD = z.string().regex(/^\d{4}(-Q[1-4])?$/, 'Give a quarter like 2026-Q4 or a year like 2026.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-15.');

type H = (req: Request, res: Response) => Promise<void>;
const h = (fn: H) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

payrollTaxesRouter.use((req, _res, next) => {
  const user = req.user!;
  if (isClientBoundedRole(user) || isInternallyScoped(user)) {
    next(new HttpError(403, 'whole_company_only', 'Payroll taxes cover the whole company. Your access is limited to some sites, so ask a payroll admin with full access.'));
    return;
  }
  next();
});

const agencyLabel = (kind: TaxAgencyKind, jurisdiction: string) => agencyNameFor(kind, jurisdiction);

function liabilityView(l: Prisma.TaxLiabilityGetPayload<{ include: { payrollRun: { select: { periodStart: true; periodEnd: true } } } }>) {
  return {
    id: l.id,
    kind: l.kind,
    kindLabel: KIND_LABEL[l.kind],
    jurisdiction: l.jurisdiction,
    agency: agencyLabel(l.kind, l.jurisdiction),
    accountId: l.accountId,
    payrollRunId: l.payrollRunId,
    payPeriod: l.payrollRun ? `${ymd(l.payrollRun.periodStart)} – ${ymd(l.payrollRun.periodEnd)}` : null,
    periodLabel: l.periodLabel,
    liabilityDate: ymd(l.liabilityDate),
    dueDate: ymd(l.dueDate),
    amount: Number(l.amount),
    breakdown: l.breakdown,
    status: l.status,
    paymentId: l.paymentId,
  };
}

function paymentView(p: Prisma.TaxPaymentGetPayload<object>) {
  return {
    id: p.id,
    kind: p.kind,
    kindLabel: KIND_LABEL[p.kind],
    jurisdiction: p.jurisdiction,
    agency: agencyLabel(p.kind, p.jurisdiction),
    accountId: p.accountId,
    periodLabel: p.periodLabel,
    amount: Number(p.amount),
    dueDate: ymd(p.dueDate),
    method: p.method,
    status: p.status,
    providerRef: p.providerRef,
    confirmationNumber: p.confirmationNumber,
    submittedAt: p.submittedAt?.toISOString() ?? null,
    paidAt: p.paidAt?.toISOString() ?? null,
    late: !!p.paidAt && ymd(p.paidAt)! > ymd(p.dueDate)!,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
  };
}

function returnView(r: Prisma.TaxReturnGetPayload<object>, opts: { rows?: boolean } = {}) {
  const data = r.data as { totals?: Record<string, number>; rows?: Array<Record<string, unknown>>; notes?: string[]; delta?: Record<string, number> };
  return {
    id: r.id,
    kind: r.kind,
    label: RETURN_LABEL[r.kind as ReturnKind] ?? r.kind,
    jurisdiction: r.jurisdiction,
    agency: agencyLabel(agencyKindFor(r.kind as ReturnKind), r.jurisdiction),
    periodLabel: r.periodLabel,
    periodStart: ymd(r.periodStart),
    periodEnd: ymd(r.periodEnd),
    dueDate: ymd(r.dueDate),
    status: r.status,
    method: r.method,
    providerRef: r.providerRef,
    confirmationNumber: r.confirmationNumber,
    filedAt: r.filedAt?.toISOString() ?? null,
    rejectionReason: r.rejectionReason,
    amendsId: r.amendsId,
    totals: data.totals ?? {},
    delta: data.delta ?? null,
    notes: data.notes ?? [],
    rowCount: (data.rows ?? []).length,
    // Per-person rows go out without the full SSN: the CSV export is the only place it appears.
    rows: opts.rows ? (data.rows ?? []).map(({ ssn: _ssn, ...rest }) => rest) : undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

const LIAB_INCLUDE = { payrollRun: { select: { periodStart: true, periodEnd: true } } } as const;

/* ----- Overview ------------------------------------------------------------------ */

/** The returns a quarter needs, from what payroll posted in it. */
async function expectedReturns(periodLabel: string): Promise<Array<{ kind: ReturnKind; jurisdiction: string }>> {
  const tenantId = tenantIdForWrite();
  const groups = await prisma.taxLiability.groupBy({ by: ['kind', 'jurisdiction'], where: { tenantId, periodLabel, status: { not: 'VOID' } } });
  const out: Array<{ kind: ReturnKind; jurisdiction: string }> = [];
  for (const g of groups) {
    if (g.kind === 'FEDERAL_WITHHOLDING') out.push({ kind: 'F941', jurisdiction: 'US' });
    else if (g.kind === 'STATE_WITHHOLDING' && !NO_INCOME_TAX_STATES.has(g.jurisdiction)) out.push({ kind: 'STATE_WH_QUARTERLY', jurisdiction: g.jurisdiction });
    else if (g.kind === 'STATE_UNEMPLOYMENT') out.push({ kind: 'SUI_WAGE_REPORT', jurisdiction: g.jurisdiction });
    else if (g.kind === 'LOCAL') out.push({ kind: 'LOCAL_QUARTERLY', jurisdiction: g.jurisdiction });
  }
  // A state disability / paid-leave program withheld in the quarter files its own report.
  const q = /^(\d{4})-Q([1-4])$/.exec(periodLabel);
  if (q) {
    const from = new Date(Date.UTC(Number(q[1]), (Number(q[2]) - 1) * 3, 1));
    const to = new Date(Date.UTC(Number(q[1]), Number(q[2]) * 3, 1));
    const programs = await prisma.payrollItemTaxLine.findMany({
      where: { tenantId, kind: 'STATE_PROGRAM', payrollItem: { status: 'DISBURSED', payrollRun: { disbursedAt: { gte: from, lt: to } } } },
      select: { workState: true, code: true },
      distinct: ['workState', 'code'],
    });
    for (const st of new Set(programs.map((p) => (p.workState ?? p.code.slice(0, 2)).toUpperCase()))) out.push({ kind: 'STATE_PROGRAM_REPORT', jurisdiction: st });
  }
  if (periodLabel.endsWith('-Q4')) {
    const year = periodLabel.slice(0, 4);
    const annual = await prisma.taxLiability.groupBy({ by: ['kind', 'jurisdiction'], where: { tenantId, periodLabel: { startsWith: year }, kind: { in: ['FEDERAL_UNEMPLOYMENT', 'STATE_WITHHOLDING'] }, status: { not: 'VOID' } } });
    for (const g of annual) {
      if (g.kind === 'FEDERAL_UNEMPLOYMENT') out.push({ kind: 'F940', jurisdiction: 'US' });
      else if (!NO_INCOME_TAX_STATES.has(g.jurisdiction)) out.push({ kind: 'STATE_WH_ANNUAL', jurisdiction: g.jurisdiction });
    }
  }
  const order = (k: string) => RETURN_KINDS.indexOf(k as ReturnKind);
  return out.sort((a, b) => order(a.kind) - order(b.kind) || a.jurisdiction.localeCompare(b.jurisdiction));
}

async function returnsChecklist(periodLabel: string) {
  const expected = await expectedReturns(periodLabel);
  const year = periodLabel.slice(0, 4);
  const existing = await prisma.taxReturn.findMany({ where: { tenantId: tenantIdForWrite(), periodLabel: { in: [periodLabel, year] }, status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'desc' } });
  return expected.map((e) => {
    const label = e.kind === 'F940' || e.kind === 'STATE_WH_ANNUAL' ? year : periodLabel;
    const r = existing.find((x) => x.kind === e.kind && x.jurisdiction === e.jurisdiction && x.periodLabel === label);
    return {
      kind: e.kind,
      label: RETURN_LABEL[e.kind],
      jurisdiction: e.jurisdiction,
      agency: agencyLabel(agencyKindFor(e.kind), e.jurisdiction),
      periodLabel: label,
      dueDate: ymd(returnDueDate(e.kind, label)),
      returnId: r?.id ?? null,
      status: r?.status ?? 'NOT_STARTED',
    };
  });
}

payrollTaxesRouter.get(
  '/overview',
  h(async (_req, res) => {
    const tenantId = tenantIdForWrite();
    const now = today();
    const in14 = new Date(now.getTime() + 14 * 86_400_000);
    const mode = await filingMode();
    const open = await prisma.taxLiability.findMany({ where: { tenantId, status: { in: ['OPEN', 'SCHEDULED'] } }, orderBy: { dueDate: 'asc' }, take: 2000 });
    // Group what is owed by agency and due date: one line per deposit to make.
    const lines = new Map<string, { kind: TaxAgencyKind; jurisdiction: string; agency: string; dueDate: string; amount: number; liabilities: number; scheduled: number; accountId: string | null }>();
    for (const l of open) {
      const key = `${l.kind}|${l.jurisdiction}|${ymd(l.dueDate)}`;
      const line = lines.get(key) ?? { kind: l.kind, jurisdiction: l.jurisdiction, agency: agencyLabel(l.kind, l.jurisdiction), dueDate: ymd(l.dueDate)!, amount: 0, liabilities: 0, scheduled: 0, accountId: l.accountId };
      line.amount = round2(line.amount + Number(l.amount));
      line.liabilities += 1;
      if (l.status === 'SCHEDULED') line.scheduled += 1;
      lines.set(key, line);
    }
    const all = [...lines.values()];
    const overdue = all.filter((l) => l.dueDate < ymd(now)!);
    const dueSoon = all.filter((l) => l.dueDate >= ymd(now)! && l.dueDate <= ymd(in14)!);
    const currentQuarter = quarterLabel(now);
    const prevQuarter = quarterLabel(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)));
    const [registrations, openNotices, noticesDue, failedPayments] = await Promise.all([
      registrationsNeeded(prisma),
      prisma.agencyNotice.count({ where: { tenantId, status: { not: 'RESOLVED' } } }),
      prisma.agencyNotice.findMany({ where: { tenantId, status: { not: 'RESOLVED' }, responseDueAt: { not: null } }, orderBy: { responseDueAt: 'asc' }, take: 5, select: { id: true, agencyName: true, noticeType: true, responseDueAt: true, amountDue: true } }),
      prisma.taxPayment.count({ where: { tenantId, status: 'FAILED' } }),
    ]);
    res.json({
      today: ymd(now),
      filing: {
        mode: mode.mode,
        providerLabel: mode.providerLabel,
        penaltyGuarantee: mode.penaltyGuarantee,
        environment: mode.environment,
      },
      totals: {
        owedOpen: round2(all.reduce((a, l) => a + l.amount, 0)),
        overdue: round2(overdue.reduce((a, l) => a + l.amount, 0)),
        dueSoon: round2(dueSoon.reduce((a, l) => a + l.amount, 0)),
        failedPayments,
        openNotices,
      },
      overdue,
      dueSoon,
      upcoming: all.filter((l) => l.dueDate > ymd(in14)!).slice(0, 10),
      returns: { previous: { periodLabel: prevQuarter, items: await returnsChecklist(prevQuarter) }, current: { periodLabel: currentQuarter, items: await returnsChecklist(currentQuarter) } },
      registrations,
      noticesDue: noticesDue.map((n) => ({ id: n.id, agencyName: n.agencyName, noticeType: n.noticeType, responseDueAt: ymd(n.responseDueAt), amountDue: n.amountDue === null ? null : Number(n.amountDue) })),
    });
  }),
);

/* ----- Agencies (the drill-down) ------------------------------------------------- */

payrollTaxesRouter.get(
  '/agencies',
  h(async (_req, res) => {
    const tenantId = tenantIdForWrite();
    const [accounts, sums] = await Promise.all([
      prisma.taxAgencyAccount.findMany({ where: { tenantId }, orderBy: [{ kind: 'asc' }, { jurisdiction: 'asc' }] }),
      prisma.taxLiability.groupBy({ by: ['kind', 'jurisdiction', 'status'], where: { tenantId, status: { not: 'VOID' } }, _sum: { amount: true }, _min: { dueDate: true } }),
    ]);
    const map = new Map<string, { kind: TaxAgencyKind; jurisdiction: string; agency: string; accountStatus: string | null; accountNumber: string | null; depositFrequency: string | null; open: number; paid: number; nextDue: string | null }>();
    const key = (k: string, j: string) => `${k}|${j}`;
    for (const a of accounts) {
      if (a.status === 'CLOSED') continue;
      map.set(key(a.kind, a.jurisdiction), { kind: a.kind, jurisdiction: a.jurisdiction, agency: a.agencyName, accountStatus: a.status, accountNumber: a.accountNumber, depositFrequency: a.depositFrequency, open: 0, paid: 0, nextDue: null });
    }
    for (const s of sums) {
      const k = key(s.kind, s.jurisdiction);
      const row = map.get(k) ?? { kind: s.kind, jurisdiction: s.jurisdiction, agency: agencyLabel(s.kind, s.jurisdiction), accountStatus: null, accountNumber: null, depositFrequency: null, open: 0, paid: 0, nextDue: null };
      const amt = Number(s._sum.amount ?? 0);
      if (s.status === 'PAID') row.paid = round2(row.paid + amt);
      else {
        row.open = round2(row.open + amt);
        const d = ymd(s._min.dueDate);
        if (d && (!row.nextDue || d < row.nextDue)) row.nextDue = d;
      }
      map.set(k, row);
    }
    res.json({ agencies: [...map.values()].sort((a, b) => AGENCY_KINDS.indexOf(a.kind) - AGENCY_KINDS.indexOf(b.kind) || a.jurisdiction.localeCompare(b.jurisdiction)) });
  }),
);

payrollTaxesRouter.get(
  '/agencies/:kind/:jurisdiction',
  h(async (req, res) => {
    const kind = z.enum(AGENCY_KINDS).parse(req.params.kind);
    const jurisdiction = z.string().min(2).max(80).parse(req.params.jurisdiction);
    const tenantId = tenantIdForWrite();
    const returnKinds = RETURN_KINDS.filter((k) => agencyKindFor(k) === kind);
    const [accounts, liabilities, payments, returns, notices] = await Promise.all([
      prisma.taxAgencyAccount.findMany({ where: { tenantId, kind, jurisdiction }, orderBy: { createdAt: 'asc' } }),
      prisma.taxLiability.findMany({ where: { tenantId, kind, jurisdiction }, include: LIAB_INCLUDE, orderBy: { dueDate: 'desc' }, take: 300 }),
      prisma.taxPayment.findMany({ where: { tenantId, kind, jurisdiction }, orderBy: { dueDate: 'desc' }, take: 200 }),
      prisma.taxReturn.findMany({ where: { tenantId, jurisdiction, kind: { in: returnKinds } }, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }], take: 100 }),
      prisma.agencyNotice.findMany({ where: { tenantId, OR: [{ account: { is: { kind, jurisdiction } } }, { jurisdiction }] }, orderBy: { noticeDate: 'desc' }, take: 50 }),
    ]);
    if (!accounts.length && !liabilities.length) throw new HttpError(404, 'agency_not_found', 'Nothing is set up or owed for that agency.');
    res.json({
      kind,
      kindLabel: KIND_LABEL[kind],
      jurisdiction,
      agency: accounts[0]?.agencyName ?? agencyLabel(kind, jurisdiction),
      accounts: accounts.map(accountView),
      liabilities: liabilities.map(liabilityView),
      payments: payments.map(paymentView),
      returns: returns.map((r) => returnView(r)),
      notices: notices.map(noticeListView),
    });
  }),
);

/* ----- Liabilities --------------------------------------------------------------- */

payrollTaxesRouter.get(
  '/liabilities',
  h(async (req, res) => {
    const q = z
      .object({ status: z.enum(['OPEN', 'SCHEDULED', 'PAID', 'VOID']).optional(), kind: z.enum(AGENCY_KINDS).optional(), jurisdiction: z.string().max(80).optional(), period: PERIOD.optional() })
      .parse(req.query);
    const rows = await prisma.taxLiability.findMany({
      where: { tenantId: tenantIdForWrite(), status: q.status, kind: q.kind, jurisdiction: q.jurisdiction, ...(q.period ? { periodLabel: q.period.includes('Q') ? q.period : { startsWith: q.period } } : {}) },
      include: LIAB_INCLUDE,
      orderBy: [{ dueDate: 'asc' }, { kind: 'asc' }],
      take: 1000,
    });
    res.json({ liabilities: rows.map(liabilityView) });
  }),
);

payrollTaxesRouter.post(
  '/liabilities/rebuild',
  h(async (req, res) => {
    const body = z.object({ from: DATE, to: DATE }).parse(req.body);
    const from = new Date(`${body.from}T00:00:00Z`);
    const to = new Date(new Date(`${body.to}T00:00:00Z`).getTime() + 86_400_000);
    if (to <= from) throw new HttpError(400, 'bad_range', 'The end date comes before the start.');
    if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new HttpError(400, 'range_too_long', 'Rebuild a year or less at a time.');
    const r = await rebuildLiabilities(prisma, from, to);
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.liabilities_rebuilt', entityType: 'TaxLiability', entityId: `${body.from}..${body.to}`, metadata: { ...body, ...r } }, 'payrollTaxes');
    res.json(r);
  }),
);

/* ----- Payments ------------------------------------------------------------------ */

payrollTaxesRouter.get(
  '/payments',
  h(async (req, res) => {
    const q = z.object({ status: z.enum(['SCHEDULED', 'SUBMITTED', 'PAID', 'FAILED', 'CANCELLED']).optional() }).parse(req.query);
    const rows = await prisma.taxPayment.findMany({ where: { tenantId: tenantIdForWrite(), status: q.status }, orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }], take: 500 });
    res.json({ payments: rows.map(paymentView) });
  }),
);

payrollTaxesRouter.post(
  '/payments',
  h(async (req, res) => {
    const body = z.object({ liabilityIds: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body);
    const r = await createPayment(prisma, { id: req.user!.id, role: req.user!.role }, body.liabilityIds);
    res.status(r.pending ? 202 : 201).json({ payment: paymentView(r.payment), pending: r.pending });
  }),
);

payrollTaxesRouter.post(
  '/payments/refresh',
  h(async (_req, res) => {
    res.json({ changed: await refreshProviderPayments(prisma) });
  }),
);

payrollTaxesRouter.post(
  '/payments/:id/mark-paid',
  h(async (req, res) => {
    const body = z.object({ confirmationNumber: z.string().trim().min(3, 'Enter the confirmation number the agency gave you.').max(80), paidOn: DATE.optional().nullable() }).parse(req.body);
    if (body.paidOn && body.paidOn > ymd(today())!) throw new HttpError(400, 'future_date', 'The payment date can’t be in the future.');
    const p = await markPaymentPaid(prisma, req.params.id!, body, req.user!.id);
    res.json({ payment: paymentView(p) });
  }),
);

payrollTaxesRouter.post(
  '/payments/:id/retry',
  h(async (req, res) => {
    const p = await prisma.taxPayment.findFirst({ where: { id: req.params.id!, tenantId: tenantIdForWrite() } });
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    if (p.status !== 'FAILED' || p.method !== 'PROVIDER') throw new HttpError(409, 'not_retryable', 'Only a failed provider payment can be sent again.');
    await prisma.taxPayment.update({ where: { id: p.id }, data: { status: 'SCHEDULED', failureReason: null } });
    res.json({ payment: paymentView(await submitPaymentToProvider(prisma, p.id, req.user!.id)) });
  }),
);

payrollTaxesRouter.post(
  '/payments/:id/cancel',
  h(async (req, res) => {
    res.json({ payment: paymentView(await cancelPayment(prisma, req.params.id!, req.user!.id)) });
  }),
);

/** The worksheet to pay from on EFTPS or the state's site: who, what form, which period, how much, what makes it up. */
payrollTaxesRouter.get(
  '/payments/:id/worksheet.csv',
  h(async (req, res) => {
    const tenantId = tenantIdForWrite();
    const p = await prisma.taxPayment.findFirst({ where: { id: req.params.id!, tenantId }, include: { account: true, liabilities: { include: LIAB_INCLUDE, orderBy: { liabilityDate: 'asc' } } } });
    if (!p) throw new HttpError(404, 'payment_not_found', 'Payment not found.');
    const profile = await prisma.submitterProfile.findFirst({ where: { tenantId } });
    const ein = p.account?.employerOrgId ? ((await prisma.employerOrganization.findFirst({ where: { id: p.account.employerOrgId, tenantId }, select: { ein: true } }))?.ein ?? profile?.ein) : profile?.ein;
    const taxForm = p.kind === 'FEDERAL_WITHHOLDING' ? '941' : p.kind === 'FEDERAL_UNEMPLOYMENT' ? '940' : KIND_LABEL[p.kind];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      p.kind.startsWith('FEDERAL') ? '# EFTPS: pay as a business tax payment (Form, tax period, amount). CONFIRM format if you batch-upload.' : '# Pay on the agency’s site with the account number below. CONFIRM format if the agency takes a file.',
      'agency,account_number,ein,tax_form,tax_period,due_date,amount',
      [agencyLabel(p.kind, p.jurisdiction), p.account?.accountNumber ?? '', ein ?? '', taxForm, p.periodLabel, ymd(p.dueDate), Number(p.amount).toFixed(2)].map(esc).join(','),
      '',
      'payday,pay_period,amount,breakdown',
      ...p.liabilities.map((l) => [ymd(l.liabilityDate), l.payrollRun ? `${ymd(l.payrollRun.periodStart)} – ${ymd(l.payrollRun.periodEnd)}` : '', Number(l.amount).toFixed(2), Object.entries((l.breakdown ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join('; ')].map(esc).join(',')),
    ];
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.worksheet_exported', entityType: 'TaxPayment', entityId: p.id, metadata: {} }, 'payrollTaxes');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', safeContentDisposition(`tax-payment-${p.jurisdiction}-${p.periodLabel}.csv`, false));
    res.send(lines.join('\n') + '\n');
  }),
);

/* ----- Returns ------------------------------------------------------------------- */

payrollTaxesRouter.get(
  '/returns',
  h(async (req, res) => {
    const q = z.object({ period: PERIOD.optional() }).parse(req.query);
    const period = q.period ?? quarterLabel(new Date(Date.UTC(today().getUTCFullYear(), today().getUTCMonth() - 3, 1)));
    const year = period.slice(0, 4);
    const rows = await prisma.taxReturn.findMany({ where: { tenantId: tenantIdForWrite(), periodLabel: { in: [period, year] } }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }], take: 300 });
    res.json({ periodLabel: period, checklist: period.includes('Q') ? await returnsChecklist(period) : [], returns: rows.map((r) => returnView(r)) });
  }),
);

payrollTaxesRouter.post(
  '/returns/generate',
  h(async (req, res) => {
    const body = z.object({ kind: z.enum(RETURN_KINDS), jurisdiction: z.string().trim().min(2).max(80), periodLabel: PERIOD }).parse(req.body);
    const jurisdiction = body.kind === 'F941' || body.kind === 'F940' ? 'US' : body.kind === 'LOCAL_QUARTERLY' ? body.jurisdiction : body.jurisdiction.toUpperCase();
    if (body.kind !== 'LOCAL_QUARTERLY' && jurisdiction !== 'US' && !STATE_NAMES[jurisdiction]) throw new HttpError(400, 'bad_state', 'Pick a state.');
    const g = await generateReturn(prisma, body.kind, jurisdiction, body.periodLabel);
    const tenantId = tenantIdForWrite();
    const account = await prisma.taxAgencyAccount.findFirst({ where: { tenantId, kind: agencyKindFor(body.kind), jurisdiction, status: { not: 'CLOSED' } }, orderBy: { createdAt: 'asc' } });
    const created = await prisma.$transaction(async (tx) => {
      // A fresh draft replaces the older drafts for the same return.
      await tx.taxReturn.updateMany({ where: { tenantId, kind: body.kind, jurisdiction, periodLabel: body.periodLabel, status: 'DRAFT' }, data: { status: 'SUPERSEDED' } });
      return tx.taxReturn.create({
        data: { tenantId, accountId: account?.id ?? null, kind: body.kind, jurisdiction, periodLabel: body.periodLabel, periodStart: g.periodStart, periodEnd: g.periodEnd, dueDate: g.dueDate, data: { totals: g.totals, rows: g.rows, notes: g.notes } as Prisma.InputJsonValue, createdById: req.user!.id },
      });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.return_generated', entityType: 'TaxReturn', entityId: created.id, metadata: { kind: body.kind, jurisdiction, periodLabel: body.periodLabel } }, 'payrollTaxes');
    res.status(201).json({ return: returnView(created, { rows: true }) });
  }),
);

async function loadReturn(id: string) {
  const r = await prisma.taxReturn.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!r) throw new HttpError(404, 'return_not_found', 'Return not found.');
  return r;
}

payrollTaxesRouter.get(
  '/returns/:id',
  h(async (req, res) => {
    const r = await loadReturn(req.params.id!);
    const amendments = await prisma.taxReturn.findMany({ where: { tenantId: tenantIdForWrite(), amendsId: r.id }, orderBy: { createdAt: 'desc' } });
    res.json({ return: returnView(r, { rows: true }), amendments: amendments.map((a) => returnView(a)) });
  }),
);

payrollTaxesRouter.get(
  '/returns/:id/export.csv',
  h(async (req, res) => {
    const r = await loadReturn(req.params.id!);
    const withSsn = req.query.ssn === '1';
    let authority: string | null = null;
    if (withSsn) {
      // Full SSNs for every person on the report: a named exporter's job.
      if (!hasCapability(req.user!.role, 'export:payroll-pii')) throw new HttpError(403, 'forbidden', 'Exporting SSNs needs payroll PII export access.');
      authority = assertBulkPiiExporter(req);
    }
    enqueueAudit({ actorUserId: req.user!.id, action: withSsn ? 'payroll_tax.return_exported_with_ssn' : 'payroll_tax.return_exported', entityType: 'TaxReturn', entityId: r.id, metadata: { kind: r.kind, jurisdiction: r.jurisdiction, periodLabel: r.periodLabel, authority } }, 'payrollTaxes');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', safeContentDisposition(`${r.kind.toLowerCase()}-${r.jurisdiction.replace(/[^A-Za-z0-9]+/g, '-')}-${r.periodLabel}.csv`, false));
    res.send(returnCsv(r, withSsn));
  }),
);

payrollTaxesRouter.post(
  '/returns/:id/file',
  h(async (req, res) => {
    const body = z.object({ method: z.enum(['PROVIDER', 'MANUAL']), confirmationNumber: z.string().trim().max(80).optional() }).parse(req.body);
    const r = await loadReturn(req.params.id!);
    if (r.status !== 'DRAFT' && r.status !== 'REJECTED') throw new HttpError(409, 'not_draft', 'This return has already been sent.');
    let updated;
    if (body.method === 'MANUAL') {
      if (!body.confirmationNumber || body.confirmationNumber.length < 3) throw new HttpError(400, 'confirmation_required', 'Enter the confirmation number the agency gave you.');
      updated = await prisma.taxReturn.update({ where: { id: r.id }, data: { status: 'FILED', method: 'MANUAL', confirmationNumber: body.confirmationNumber, filedAt: new Date(), filedById: req.user!.id, rejectionReason: null } });
    } else {
      const mode = await filingMode();
      if (mode.mode !== 'PROVIDER') throw new HttpError(409, 'no_provider', 'No payroll tax provider is connected. File it yourself and record the confirmation.');
      const totals = ((r.data as { totals?: Record<string, number> }).totals ?? {}) as Record<string, number>;
      const remote = await withProvider('tax.return', (adapter, ctx) =>
        adapter.submitReturn(ctx, { idempotencyKey: `alto-return-${r.id}`, kind: r.kind, jurisdiction: r.jurisdiction, periodLabel: r.periodLabel, totals }),
      );
      const status = remote.status === 'ACCEPTED' ? 'ACCEPTED' : remote.status === 'REJECTED' || remote.status === 'FAILED' ? 'REJECTED' : remote.status === 'FILED' ? 'FILED' : 'SUBMITTED';
      updated = await prisma.taxReturn.update({
        where: { id: r.id },
        data: { status, method: 'PROVIDER', providerRef: remote.providerRef || null, confirmationNumber: remote.confirmationNumber, filedAt: status === 'REJECTED' ? null : new Date(), filedById: req.user!.id, rejectionReason: status === 'REJECTED' ? (remote.message ?? 'The provider rejected the return.').slice(0, 500) : null },
      });
    }
    if (r.amendsId && (updated.status === 'FILED' || updated.status === 'ACCEPTED')) {
      // The amendment now stands for the period; the original stays for the record.
      enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.amendment_filed', entityType: 'TaxReturn', entityId: r.id, metadata: { amends: r.amendsId } }, 'payrollTaxes');
    }
    // Filing supersedes any other draft of the same return.
    await prisma.taxReturn.updateMany({ where: { tenantId: tenantIdForWrite(), kind: r.kind, jurisdiction: r.jurisdiction, periodLabel: r.periodLabel, status: 'DRAFT', id: { not: r.id } }, data: { status: 'SUPERSEDED' } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.return_filed', entityType: 'TaxReturn', entityId: r.id, metadata: { method: body.method, status: updated.status, confirmationNumber: updated.confirmationNumber } }, 'payrollTaxes');
    res.json({ return: returnView(updated, { rows: true }) });
  }),
);

payrollTaxesRouter.post(
  '/returns/:id/outcome',
  h(async (req, res) => {
    const body = z.object({ outcome: z.enum(['ACCEPTED', 'REJECTED']), reason: z.string().trim().max(500).optional() }).parse(req.body);
    const r = await loadReturn(req.params.id!);
    if (r.status !== 'SUBMITTED' && r.status !== 'FILED') throw new HttpError(409, 'not_sent', 'Record the agency’s answer after the return is sent.');
    if (body.outcome === 'REJECTED' && !body.reason) throw new HttpError(400, 'reason_required', 'Say why the agency rejected it.');
    const updated = await prisma.taxReturn.update({ where: { id: r.id }, data: { status: body.outcome, rejectionReason: body.outcome === 'REJECTED' ? body.reason! : null } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.return_outcome', entityType: 'TaxReturn', entityId: r.id, metadata: body }, 'payrollTaxes');
    res.json({ return: returnView(updated, { rows: true }) });
  }),
);

payrollTaxesRouter.post(
  '/returns/:id/amend',
  h(async (req, res) => {
    const a = await amendReturn(prisma, req.params.id!);
    const original = await loadReturn(req.params.id!);
    const created = await prisma.taxReturn.create({
      data: {
        tenantId: tenantIdForWrite(),
        accountId: original.accountId,
        kind: a.kind,
        jurisdiction: a.jurisdiction,
        periodLabel: a.periodLabel,
        periodStart: a.periodStart,
        periodEnd: a.periodEnd,
        dueDate: a.dueDate,
        data: { totals: a.totals, rows: a.rows, notes: a.notes, delta: a.delta, original: (original.data as { totals?: unknown }).totals ?? {} } as Prisma.InputJsonValue,
        amendsId: original.id,
        createdById: req.user!.id,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.amendment_drafted', entityType: 'TaxReturn', entityId: created.id, metadata: { amends: original.id, delta: a.delta } }, 'payrollTaxes');
    res.status(201).json({ return: returnView(created, { rows: true }) });
  }),
);

/* ----- Reconciliation ------------------------------------------------------------ */

payrollTaxesRouter.get(
  '/reconciliation',
  h(async (req, res) => {
    const q = z.object({ period: z.string().regex(/^\d{4}-Q[1-4]$/).optional() }).parse(req.query);
    const period = q.period ?? quarterLabel(today());
    const lines = await reconcile(prisma, period);
    res.json({ periodLabel: period, lines, clean: lines.every((l) => l.flags.length === 0) });
  }),
);

/* ----- Agency accounts and registrations ----------------------------------------- */

function accountView(a: Prisma.TaxAgencyAccountGetPayload<object>) {
  return {
    id: a.id,
    employerOrgId: a.employerOrgId,
    kind: a.kind,
    kindLabel: KIND_LABEL[a.kind],
    jurisdiction: a.jurisdiction,
    agencyName: a.agencyName,
    accountNumber: a.accountNumber,
    depositFrequency: a.depositFrequency,
    dueDayOfMonth: a.dueDayOfMonth,
    rate: a.rate === null ? null : Number(a.rate),
    rateYear: a.rateYear,
    wageBase: a.wageBase === null ? null : Number(a.wageBase),
    status: a.status,
    effectiveFrom: ymd(a.effectiveFrom),
    effectiveTo: ymd(a.effectiveTo),
    notes: a.notes,
  };
}

const accountBody = z.object({
  employerOrgId: z.string().uuid().nullable().optional(),
  kind: z.enum(AGENCY_KINDS),
  jurisdiction: z.string().trim().min(2).max(80),
  agencyName: z.string().trim().min(2).max(160).optional(),
  accountNumber: z.string().trim().max(60).nullable().optional(),
  depositFrequency: z.string().refine(isDepositFrequency, 'Pick a deposit schedule.').optional(),
  dueDayOfMonth: z.number().int().min(1).max(28).optional(),
  rate: z.number().min(0).max(0.2).nullable().optional(),
  rateYear: z.number().int().min(2000).max(2100).nullable().optional(),
  wageBase: z.number().min(0).max(1_000_000).nullable().optional(),
  status: z.enum(['ACTIVE', 'PENDING_REGISTRATION', 'CLOSED']).optional(),
  effectiveFrom: DATE.nullable().optional(),
  effectiveTo: DATE.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

const toDate = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00Z`));

payrollTaxesRouter.get(
  '/accounts',
  h(async (_req, res) => {
    const rows = await prisma.taxAgencyAccount.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ status: 'asc' }, { kind: 'asc' }, { jurisdiction: 'asc' }] });
    res.json({ accounts: rows.map(accountView) });
  }),
);

payrollTaxesRouter.post(
  '/accounts',
  h(async (req, res) => {
    const b = accountBody.parse(req.body);
    const tenantId = tenantIdForWrite();
    const jurisdiction = b.kind.startsWith('FEDERAL') ? 'US' : b.kind === 'LOCAL' ? b.jurisdiction : b.jurisdiction.toUpperCase();
    if (b.employerOrgId) {
      const org = await prisma.employerOrganization.findFirst({ where: { id: b.employerOrgId, tenantId }, select: { id: true } });
      if (!org) throw new HttpError(404, 'employer_not_found', 'Employer not found.');
    }
    const clash = await prisma.taxAgencyAccount.findFirst({ where: { tenantId, kind: b.kind, jurisdiction, employerOrgId: b.employerOrgId ?? null, status: { not: 'CLOSED' } } });
    if (clash) throw new HttpError(409, 'account_exists', `There is already a ${KIND_LABEL[b.kind].toLowerCase()} account for ${jurisdiction}. Edit that one.`);
    const created = await prisma.taxAgencyAccount.create({
      data: {
        tenantId,
        employerOrgId: b.employerOrgId ?? null,
        kind: b.kind,
        jurisdiction,
        agencyName: b.agencyName ?? agencyNameFor(b.kind, jurisdiction),
        accountNumber: b.accountNumber ?? null,
        depositFrequency: b.depositFrequency ?? 'MONTHLY',
        dueDayOfMonth: b.dueDayOfMonth ?? 15,
        rate: b.rate ?? null,
        rateYear: b.rateYear ?? null,
        wageBase: b.wageBase ?? null,
        status: b.status ?? (b.accountNumber ? 'ACTIVE' : 'PENDING_REGISTRATION'),
        effectiveFrom: toDate(b.effectiveFrom) ?? null,
        effectiveTo: toDate(b.effectiveTo) ?? null,
        notes: b.notes ?? null,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.account_created', entityType: 'TaxAgencyAccount', entityId: created.id, metadata: { kind: b.kind, jurisdiction } }, 'payrollTaxes');
    res.status(201).json({ account: accountView(created) });
  }),
);

payrollTaxesRouter.patch(
  '/accounts/:id',
  h(async (req, res) => {
    const b = accountBody.partial().omit({ kind: true, jurisdiction: true, employerOrgId: true }).parse(req.body);
    const tenantId = tenantIdForWrite();
    const a = await prisma.taxAgencyAccount.findFirst({ where: { id: req.params.id!, tenantId } });
    if (!a) throw new HttpError(404, 'account_not_found', 'Account not found.');
    const nextNumber = b.accountNumber === undefined ? a.accountNumber : b.accountNumber;
    // Entering the agency's account number completes the registration.
    const status = b.status ?? (a.status === 'PENDING_REGISTRATION' && nextNumber ? 'ACTIVE' : a.status);
    const updated = await prisma.taxAgencyAccount.update({
      where: { id: a.id },
      data: {
        agencyName: b.agencyName,
        accountNumber: b.accountNumber,
        depositFrequency: b.depositFrequency,
        dueDayOfMonth: b.dueDayOfMonth,
        rate: b.rate,
        rateYear: b.rateYear,
        wageBase: b.wageBase,
        status,
        effectiveFrom: toDate(b.effectiveFrom),
        effectiveTo: toDate(b.effectiveTo),
        notes: b.notes,
      },
    });
    const changed = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.account_updated', entityType: 'TaxAgencyAccount', entityId: a.id, metadata: { changed, statusFrom: a.status, statusTo: status } }, 'payrollTaxes');
    res.json({ account: accountView(updated) });
  }),
);

payrollTaxesRouter.get(
  '/registrations',
  h(async (_req, res) => {
    res.json({ registrations: await registrationsNeeded(prisma) });
  }),
);

/* ----- Agency notices ------------------------------------------------------------ */

const NOTICE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!NOTICE_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'invalid_mime', 'Upload the notice as a PDF or a photo (PNG or JPEG).'));
      return;
    }
    cb(null, true);
  },
});

interface NoticeEvent {
  at: string;
  by: string | null;
  what: string;
}

function noticeListView(n: Prisma.AgencyNoticeGetPayload<object>) {
  return {
    id: n.id,
    accountId: n.accountId,
    agencyName: n.agencyName,
    jurisdiction: n.jurisdiction,
    noticeType: n.noticeType,
    noticeNumber: n.noticeNumber,
    noticeDate: ymd(n.noticeDate),
    periodLabel: n.periodLabel,
    amountDue: n.amountDue === null ? null : Number(n.amountDue),
    responseDueAt: ymd(n.responseDueAt),
    status: n.status,
    assignedToId: n.assignedToId,
    hasFile: !!n.fileKey,
    fileName: n.fileName,
    penaltyAmount: n.penaltyAmount === null ? null : Number(n.penaltyAmount),
    abatedAmount: n.abatedAmount === null ? null : Number(n.abatedAmount),
  };
}

async function noticeDetail(n: Prisma.AgencyNoticeGetPayload<object>) {
  const tenantId = tenantIdForWrite();
  const events = (Array.isArray(n.events) ? n.events : []) as unknown as NoticeEvent[];
  const userIds = [...new Set([n.assignedToId, ...events.map((e) => e.by)].filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds }, tenantId }, select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } }) : [];
  const nameOf = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email) : null;
  };
  // The ledger evidence a response leans on: what was owed and paid to that agency for the period.
  let evidence: { liabilities: number; paid: number; payments: Array<ReturnType<typeof paymentView>> } | null = null;
  if (n.periodLabel) {
    const acct = n.accountId ? await prisma.taxAgencyAccount.findFirst({ where: { id: n.accountId, tenantId } }) : null;
    const where = acct ? { tenantId, kind: acct.kind, jurisdiction: acct.jurisdiction } : n.jurisdiction ? { tenantId, jurisdiction: n.jurisdiction } : null;
    if (where) {
      const periodWhere = n.periodLabel.includes('Q') ? n.periodLabel : { startsWith: n.periodLabel };
      const [liab, pays] = await Promise.all([
        prisma.taxLiability.findMany({ where: { ...where, periodLabel: periodWhere, status: { not: 'VOID' } }, select: { amount: true, status: true } }),
        prisma.taxPayment.findMany({ where: { ...where, periodLabel: { startsWith: n.periodLabel.slice(0, 4) }, status: 'PAID' }, orderBy: { paidAt: 'asc' }, take: 50 }),
      ]);
      evidence = {
        liabilities: round2(liab.reduce((a, l) => a + Number(l.amount), 0)),
        paid: round2(liab.filter((l) => l.status === 'PAID').reduce((a, l) => a + Number(l.amount), 0)),
        payments: pays.map(paymentView),
      };
    }
  }
  return {
    ...noticeListView(n),
    assignedToName: nameOf(n.assignedToId),
    summary: n.summary,
    response: n.response,
    respondedAt: n.respondedAt?.toISOString() ?? null,
    resolution: n.resolution,
    resolvedAt: n.resolvedAt?.toISOString() ?? null,
    events: events.map((e) => ({ ...e, byName: nameOf(e.by) })),
    evidence,
    createdAt: n.createdAt.toISOString(),
  };
}

payrollTaxesRouter.get(
  '/notices',
  h(async (req, res) => {
    const q = z.object({ status: z.enum(['NEW', 'IN_REVIEW', 'RESPONDED', 'RESOLVED', 'ACTIVE']).optional() }).parse(req.query);
    const status = q.status === 'ACTIVE' ? { not: 'RESOLVED' as const } : q.status;
    const rows = await prisma.agencyNotice.findMany({ where: { tenantId: tenantIdForWrite(), status }, orderBy: [{ status: 'asc' }, { responseDueAt: { sort: 'asc', nulls: 'last' } }, { noticeDate: 'desc' }], take: 300 });
    const tenantId = tenantIdForWrite();
    const all = await prisma.agencyNotice.findMany({ where: { tenantId }, select: { status: true, amountDue: true, penaltyAmount: true, abatedAmount: true, responseDueAt: true } });
    const now = ymd(today())!;
    res.json({
      notices: rows.map(noticeListView),
      dashboard: {
        open: all.filter((n) => n.status !== 'RESOLVED').length,
        overdueResponses: all.filter((n) => n.status !== 'RESOLVED' && n.status !== 'RESPONDED' && n.responseDueAt && ymd(n.responseDueAt)! < now).length,
        amountInDispute: round2(all.filter((n) => n.status !== 'RESOLVED').reduce((a, n) => a + Number(n.amountDue ?? 0), 0)),
        penalties: round2(all.reduce((a, n) => a + Number(n.penaltyAmount ?? 0), 0)),
        abated: round2(all.reduce((a, n) => a + Number(n.abatedAmount ?? 0), 0)),
      },
    });
  }),
);

const noticeCreate = z.object({
  accountId: z.string().uuid().optional().nullable(),
  agencyName: z.string().trim().min(2, 'Name the agency that sent it.').max(160),
  jurisdiction: z.string().trim().max(80).optional().nullable(),
  noticeType: z.string().trim().min(2, 'Say what kind of notice it is.').max(80),
  noticeNumber: z.string().trim().max(60).optional().nullable(),
  noticeDate: DATE,
  periodLabel: PERIOD.optional().nullable(),
  amountDue: z.coerce.number().min(0).max(100_000_000).optional().nullable(),
  responseDueAt: DATE.optional().nullable(),
  assignedToId: z.string().uuid().optional().nullable(),
  summary: z.string().trim().max(2000).optional().nullable(),
});

/** Blank multipart fields arrive as "": read them as absent. */
function blankToNull(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body ?? {}).map(([k, v]) => [k, v === '' ? null : v]));
}

async function assertAssignee(id: string | null | undefined) {
  if (!id) return;
  const u = await prisma.user.findFirst({ where: { id, tenantId: tenantIdForWrite(), status: 'ACTIVE' }, select: { role: true } });
  if (!u || !hasCapability(u.role, 'process:payroll')) throw new HttpError(400, 'bad_assignee', 'Assign it to someone who runs payroll.');
}

payrollTaxesRouter.post(
  '/notices',
  upload.single('file'),
  h(async (req, res) => {
    const b = noticeCreate.parse(blankToNull(req.body as Record<string, unknown>));
    const tenantId = tenantIdForWrite();
    if (b.accountId) {
      const a = await prisma.taxAgencyAccount.findFirst({ where: { id: b.accountId, tenantId }, select: { id: true } });
      if (!a) throw new HttpError(404, 'account_not_found', 'Agency account not found.');
    }
    await assertAssignee(b.assignedToId);
    let file: { key: string; name: string; type: string } | null = null;
    if (req.file) {
      const magic = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magic) throw new HttpError(400, 'file_mismatch', magic);
      const name = sanitizeUploadFilename(req.file.originalname);
      const key = `agency-notices/${tenantId ?? 'default'}/${Date.now()}-${name}`;
      await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
      file = { key, name, type: req.file.mimetype };
    }
    const created = await prisma.agencyNotice.create({
      data: {
        tenantId,
        accountId: b.accountId ?? null,
        agencyName: b.agencyName,
        jurisdiction: b.jurisdiction ?? null,
        noticeType: b.noticeType,
        noticeNumber: b.noticeNumber ?? null,
        noticeDate: new Date(`${b.noticeDate}T00:00:00Z`),
        periodLabel: b.periodLabel ?? null,
        amountDue: b.amountDue ?? null,
        responseDueAt: b.responseDueAt ? new Date(`${b.responseDueAt}T00:00:00Z`) : null,
        assignedToId: b.assignedToId ?? null,
        summary: b.summary ?? null,
        fileKey: file?.key ?? null,
        fileName: file?.name ?? null,
        contentType: file?.type ?? null,
        events: [{ at: new Date().toISOString(), by: req.user!.id, what: 'Logged the notice' }] as unknown as Prisma.InputJsonValue,
        createdById: req.user!.id,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.notice_logged', entityType: 'AgencyNotice', entityId: created.id, metadata: { agencyName: b.agencyName, noticeType: b.noticeType } }, 'payrollTaxes');
    res.status(201).json({ notice: await noticeDetail(created) });
  }),
);

payrollTaxesRouter.get(
  '/notices/:id',
  h(async (req, res) => {
    const n = await prisma.agencyNotice.findFirst({ where: { id: req.params.id!, tenantId: tenantIdForWrite() } });
    if (!n) throw new HttpError(404, 'notice_not_found', 'Notice not found.');
    res.json({ notice: await noticeDetail(n) });
  }),
);

const noticePatch = z.object({
  status: z.enum(['NEW', 'IN_REVIEW', 'RESPONDED', 'RESOLVED']).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  responseDueAt: DATE.nullable().optional(),
  response: z.string().trim().max(4000).nullable().optional(),
  resolution: z.string().trim().max(2000).nullable().optional(),
  penaltyAmount: z.number().min(0).max(100_000_000).nullable().optional(),
  abatedAmount: z.number().min(0).max(100_000_000).nullable().optional(),
  amountDue: z.number().min(0).max(100_000_000).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

payrollTaxesRouter.patch(
  '/notices/:id',
  h(async (req, res) => {
    const b = noticePatch.parse(req.body);
    const n = await prisma.agencyNotice.findFirst({ where: { id: req.params.id!, tenantId: tenantIdForWrite() } });
    if (!n) throw new HttpError(404, 'notice_not_found', 'Notice not found.');
    await assertAssignee(b.assignedToId);
    if (b.status === 'RESPONDED' && !(b.response ?? n.response)) throw new HttpError(400, 'response_required', 'Write down what you sent the agency before marking it responded.');
    if (b.status === 'RESOLVED' && !(b.resolution ?? n.resolution)) throw new HttpError(400, 'resolution_required', 'Say how it was resolved.');
    const abated = b.abatedAmount === undefined ? n.abatedAmount : b.abatedAmount;
    const penalty = b.penaltyAmount === undefined ? n.penaltyAmount : b.penaltyAmount;
    if (abated !== null && penalty !== null && Number(abated) > Number(penalty)) throw new HttpError(400, 'abated_over_penalty', 'The abated amount can’t be more than the penalty.');
    const now = new Date();
    const events = [...((Array.isArray(n.events) ? n.events : []) as unknown as NoticeEvent[])];
    const push = (what: string) => events.push({ at: now.toISOString(), by: req.user!.id, what });
    const STATUS_WORDS = { NEW: 'Reopened', IN_REVIEW: 'Started review', RESPONDED: 'Responded to the agency', RESOLVED: 'Resolved' } as const;
    if (b.status && b.status !== n.status) push(STATUS_WORDS[b.status]);
    if (b.assignedToId !== undefined && b.assignedToId !== n.assignedToId) push(b.assignedToId ? 'Assigned' : 'Unassigned');
    if (b.penaltyAmount !== undefined && b.penaltyAmount !== (n.penaltyAmount === null ? null : Number(n.penaltyAmount))) push(`Penalty set to $${(b.penaltyAmount ?? 0).toFixed(2)}`);
    if (b.abatedAmount !== undefined && b.abatedAmount !== (n.abatedAmount === null ? null : Number(n.abatedAmount))) push(`Abatement recorded: $${(b.abatedAmount ?? 0).toFixed(2)}`);
    if (b.note) push(`Note: ${b.note}`);
    const updated = await prisma.agencyNotice.update({
      where: { id: n.id },
      data: {
        status: b.status,
        assignedToId: b.assignedToId,
        responseDueAt: toDate(b.responseDueAt),
        response: b.response,
        resolution: b.resolution,
        penaltyAmount: b.penaltyAmount,
        abatedAmount: b.abatedAmount,
        amountDue: b.amountDue,
        respondedAt: b.status === 'RESPONDED' && n.status !== 'RESPONDED' ? now : undefined,
        resolvedAt: b.status === 'RESOLVED' ? (n.resolvedAt ?? now) : b.status ? null : undefined,
        events: events as unknown as Prisma.InputJsonValue,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll_tax.notice_updated', entityType: 'AgencyNotice', entityId: n.id, metadata: { status: updated.status } }, 'payrollTaxes');
    res.json({ notice: await noticeDetail(updated) });
  }),
);

payrollTaxesRouter.get(
  '/notices/:id/file',
  h(async (req, res) => {
    const n = await prisma.agencyNotice.findFirst({ where: { id: req.params.id!, tenantId: tenantIdForWrite() } });
    if (!n || !n.fileKey) throw new HttpError(404, 'file_not_found', 'No file is attached to this notice.');
    const stream = await getBlobStore().getStream(n.fileKey);
    if (!stream) throw new HttpError(410, 'file_missing', 'The notice file is no longer available. Upload it again.');
    res.setHeader('Content-Type', n.contentType ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', safeContentDisposition(n.fileName ?? 'notice', n.contentType === 'application/pdf'));
    stream.pipe(res);
  }),
);

/** Who a notice can be assigned to: active people who run payroll. */
payrollTaxesRouter.get(
  '/assignees',
  h(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', role: { in: rolesWithCapability('process:payroll') } },
      select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
      orderBy: { email: 'asc' },
      take: 200,
    });
    res.json({ assignees: users.map((u) => ({ id: u.id, name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email })) });
  }),
);

/* ----- Year-end reconciliation (lib/yearEndReconciliation) ------------------------- */

const yearParam = (raw: string) => {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'bad_year', 'Give a four-digit tax year.');
  return y;
};
const METRIC = z.union([z.enum(['box1', 'box2', 'box3', 'box4', 'box5', 'box6']), z.string().regex(/^(state|stateTax):[A-Z]{2}$/)]);

/** GET /payroll-taxes/year-end/:year — paychecks vs 941s vs deposits vs W-2s, by tax and jurisdiction, with the pre-filing checklist. */
payrollTaxesRouter.get('/year-end/:year', h(async (req, res) => {
  res.json(await yearEndReconciliation(prisma, yearParam(req.params.year!)));
}));

/** GET /payroll-taxes/year-end/:year/people?metric=box1 — the people behind a variance. */
payrollTaxesRouter.get('/year-end/:year/people', h(async (req, res) => {
  const metric = METRIC.parse(req.query.metric) as PersonMetric;
  res.json({ metric, people: await personVariances(prisma, yearParam(req.params.year!), metric) });
}));

/** GET /payroll-taxes/year-end/:year/export.xlsx — the reconciliation as a workbook. */
payrollTaxesRouter.get('/year-end/:year/export.xlsx', h(async (req, res) => {
  const year = yearParam(req.params.year!);
  const recon = await yearEndReconciliation(prisma, year);
  const people = await personVariances(prisma, year, 'box1');
  const brand = await prisma.orgSetting.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { orgName: true } });
  const buf = await yearEndWorkbook(recon, people, brand?.orgName ?? 'Payroll');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="year-end-reconciliation-${year}.xlsx"`);
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'payroll_tax.year_end_exported', entityType: 'TaxYear', entityId: String(year), metadata: { variances: recon.summary.variances } }, 'payrollTaxes.yearEnd');
  res.send(buf);
}));
