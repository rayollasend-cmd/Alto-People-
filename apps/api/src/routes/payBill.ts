import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { requireModule } from '../lib/tenantProfile.js';
import { isInternallyScoped, scopeClients, scopePayrollRuns, scopeTimeEntries, scopeWhere } from '../lib/scope.js';
import { orgDateKey, startOfWeekUTC } from '../lib/timeAnomalies.js';
import { reconcilePayPeriod, runningPayrollCost, unbilledGapCached } from '../lib/payBillRecon.js';
import { billedNotPaid } from '../lib/payBillGaps.js';
import { normalizeRules, onPayrollFinalized, PREMIUM_KEYS, readyAdjustments, termsFor } from '../lib/payBillLink.js';
import { clientSalesTaxRate, totalsWithTax, type StatementSnapshot } from '../lib/clientStatement.js';
import { runPayrollPrep } from '../lib/payrollAgent.js';

/**
 * The pay ↔ bill desk (BEYOND): reconciliation and margin per paycheck, the
 * billing adjustments payroll produced, each client's billing terms, and
 * this week's running payroll cost per store.
 *
 * Billing is a staffing firm's matter: everything except the running cost
 * sits behind the clientPortal module (a hotel or direct employer has no
 * clients to bill). Margin and reconciliation are company-wide, so an
 * account narrowed to some stores is refused rather than shown a partial
 * margin that reads as the whole.
 */
export const payBillRouter = Router();

type SessionUser = NonNullable<Request['user']>;

const FINANCE_READ = requireAnyCapability('process:payroll', 'view:executive');
const FINANCE_WRITE = requireCapability('process:payroll');
const BILLING = requireModule('clientPortal');

// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column or a company-midnight anchor (west of UTC that is the same date); today is orgDateKey.
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

function companyWide(user: SessionUser): void {
  if (isInternallyScoped(user)) {
    throw new HttpError(403, 'company_wide', 'Margin and reconciliation are company-wide; your account is limited to some stores.');
  }
}

async function clientInReach(user: SessionUser, clientId: string) {
  const client = await prisma.client.findFirst({
    where: scopeWhere<Prisma.ClientWhereInput>({ id: clientId, tenantId: tenantIdForWrite() }, scopeClients(user)),
    select: { id: true, name: true },
  });
  if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
  return client;
}

/** GET /pay-bill/periods — the pay periods with finalized pay, newest first (the period picker). */
payBillRouter.get('/periods', BILLING, FINANCE_READ, async (req, res, next) => {
  try {
    companyWide(req.user!);
    const runs = await prisma.payrollRun.findMany({
      where: scopeWhere<Prisma.PayrollRunWhereInput>({ tenantId: tenantIdForWrite(), status: { in: ['FINALIZED', 'DISBURSED'] } }, scopePayrollRuns(req.user!)),
      select: { periodStart: true, periodEnd: true },
      orderBy: { periodStart: 'desc' },
      take: 200,
    });
    const seen = new Map<string, { periodStart: string; periodEnd: string; runs: number }>();
    for (const r of runs) {
      const k = `${ymd(r.periodStart)}:${ymd(r.periodEnd)}`;
      const row = seen.get(k) ?? { periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd), runs: 0 };
      row.runs += 1;
      seen.set(k, row);
    }
    // The periods holding billable pay on no statement, oldest first — the same figure (and cache) as the
    // Inbox and sidebar badge, so the page opens where the badge's money is (deep audit MONEY-2).
    const gap = await unbilledGapCached(prisma, `${tenantIdForWrite()}:${req.user!.role}`, { AND: [{ tenantId: tenantIdForWrite() }, scopePayrollRuns(req.user!)] }).catch(() => null);
    res.json({ periods: [...seen.values()].slice(0, 26), gapPeriods: gap?.periods ?? [] });
  } catch (err) {
    next(err);
  }
});

/** GET /pay-bill/reconciliation?periodStart&periodEnd[&clientId] — paid vs billed, margin per paycheck, unbilled pay with reasons. */
payBillRouter.get('/reconciliation', BILLING, FINANCE_READ, async (req, res, next) => {
  try {
    const user = req.user!;
    companyWide(user);
    const q = z.object({ periodStart: DateStr, periodEnd: DateStr, clientId: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) throw new HttpError(400, 'invalid_period', 'periodStart and periodEnd must be YYYY-MM-DD.');
    if (q.data.clientId) await clientInReach(user, q.data.clientId);
    const report = await reconcilePayPeriod(prisma, {
      periodStart: dateOnly(q.data.periodStart),
      periodEnd: dateOnly(q.data.periodEnd),
      clientId: q.data.clientId ?? null,
      runWhere: scopeWhere<Prisma.PayrollRunWhereInput>({ tenantId: tenantIdForWrite() }, scopePayrollRuns(user)),
    });
    if (q.data.clientId) {
      report.paychecks = report.paychecks.filter((p) => p.clientId === q.data.clientId);
      report.unbilled = report.unbilled.filter((u) => u.clientId === q.data.clientId);
    }
    // The other direction (finance walk 11): hours a final statement billed that no paystub paid.
    const billed = await billedNotPaid(prisma, {
      periodStart: dateOnly(q.data.periodStart),
      periodEnd: dateOnly(q.data.periodEnd),
      clientId: q.data.clientId ?? null,
      runWhere: scopeWhere<Prisma.PayrollRunWhereInput>({ tenantId: tenantIdForWrite() }, scopePayrollRuns(user)),
    });
    res.json({ ...report, billedNotPaid: billed.rows, billedNotPaidHours: billed.hours });
  } catch (err) {
    next(err);
  }
});

/** GET /pay-bill/adjustments?status — premium, retro and reversal lines payroll produced for client bills. */
payBillRouter.get('/adjustments', BILLING, FINANCE_READ, async (req, res, next) => {
  try {
    const user = req.user!;
    const status = z.enum(['READY', 'PENDING_REVIEW', 'BILLED', 'VOID']).optional().safeParse(req.query.status || undefined);
    if (!status.success) throw new HttpError(400, 'invalid_status', 'Unknown status.');
    const rows = await prisma.billingAdjustment.findMany({
      where: scopeWhere<Prisma.BillingAdjustmentWhereInput>(
        { tenantId: tenantIdForWrite() },
        status.data ? { status: status.data } : null,
        { client: { is: scopeClients(user) } },
      ),
      include: { client: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const statementIds = [...new Set(rows.flatMap((r) => [...r.originalStatementIds, ...(r.billedStatementId ? [r.billedStatementId] : [])]))];
    const statements = statementIds.length
      ? await prisma.clientStatement.findMany({ where: { id: { in: statementIds }, tenantId: tenantIdForWrite() }, select: { id: true, number: true, status: true } })
      : [];
    const st = new Map(statements.map((s) => [s.id, s]));
    res.json({
      adjustments: rows.map((r) => ({
        id: r.id,
        clientId: r.clientId,
        clientName: r.client.name,
        kind: r.kind,
        status: r.status,
        ruleKey: r.ruleKey,
        label: r.label,
        basis: r.basis,
        hours: Number(r.hours),
        payAmount: Number(r.payAmount),
        amount: Number(r.amount),
        workFrom: r.workFrom ? ymd(r.workFrom) : null,
        workTo: r.workTo ? ymd(r.workTo) : null,
        associateId: r.associateId,
        payrollRunId: r.payrollRunId,
        approvalId: r.approvalId,
        reason: r.reason,
        originalStatements: r.originalStatementIds.map((id) => ({ id, number: st.get(id)?.number ?? null })),
        billedStatement: r.billedStatementId ? { id: r.billedStatementId, number: st.get(r.billedStatementId)?.number ?? null } : null,
        createdAt: r.createdAt.toISOString(),
      })),
      truncated: rows.length === 300,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /pay-bill/clients/:id/adjustment-statement — bill the client's ready
 * adjustments now, on a statement of their own (the hours' period is
 * already closed). A one-day DRAFT dated today carrying only adjustments;
 * finalizing it claims them like any statement.
 */
payBillRouter.post('/clients/:id/adjustment-statement', BILLING, FINANCE_WRITE, async (req, res, next) => {
  try {
    const user = req.user!;
    const client = await clientInReach(user, req.params.id);
    const adjustments = await readyAdjustments(prisma, client.id);
    if (!adjustments.length) throw new HttpError(409, 'nothing_ready', `Nothing is waiting to be billed to ${client.name}.`);
    // The company's day, not UTC's (after 8 PM Eastern UTC is tomorrow).
    const today = dateOnly(orgDateKey(new Date()));
    const existing = await prisma.clientStatement.findUnique({ where: { clientId_periodStart_periodEnd: { clientId: client.id, periodStart: today, periodEnd: today } } });
    if (existing && (existing.status === 'FINAL' || !(existing.snapshot as unknown as StatementSnapshot).adjustmentsOnly)) {
      throw new HttpError(409, 'period_taken', 'A statement for today already exists — the adjustments ride on it.');
    }
    const total = Math.round(adjustments.reduce((s, a) => s + a.amount, 0) * 100) / 100;
    const snapshot: StatementSnapshot = {
      clientName: client.name,
      periodStart: ymd(today),
      periodEnd: ymd(today),
      generatedAt: new Date().toISOString(),
      adjustmentsOnly: true,
      lines: [],
      stores: [],
      adjustments,
      totals: { hours: 0, regularHours: 0, otHours: 0, ...totalsWithTax({ hoursAmount: 0, adjustmentsAmount: total, salesTaxRatePct: await clientSalesTaxRate(prisma, client.id) }) },
      sla: { publishedShifts: 0, assignedShifts: 0, fillRatePct: null, punctualPct: null, noShows: 0, pendingEntries: 0 },
    };
    const row = existing
      ? await prisma.clientStatement.update({ where: { id: existing.id }, data: { snapshot: snapshot as unknown as Prisma.InputJsonValue } })
      : await prisma.clientStatement.create({ data: { clientId: client.id, periodStart: today, periodEnd: today, snapshot: snapshot as unknown as Prisma.InputJsonValue } });
    enqueueAudit({ actorUserId: user.id, clientId: client.id, action: 'billing.adjustment_statement_drafted', entityType: 'ClientStatement', entityId: row.id, metadata: { adjustments: adjustments.length, amount: total } }, 'payBill');
    res.status(existing ? 200 : 201).json({ statementId: row.id, clientId: client.id, amount: snapshot.totals.amount, adjustments: adjustments.length });
  } catch (err) {
    next(err);
  }
});

/** GET /pay-bill/clients — every client in reach with the billing terms in force today. */
payBillRouter.get('/clients', BILLING, FINANCE_READ, async (req, res, next) => {
  try {
    const clients = await prisma.client.findMany({
      where: scopeWhere<Prisma.ClientWhereInput>({ tenantId: tenantIdForWrite() }, scopeClients(req.user!)),
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const terms = await Promise.all(clients.map((c) => termsFor(prisma, c.id)));
    res.json({ clients: clients.map((c, i) => ({ id: c.id, name: c.name, terms: terms[i] })), truncated: clients.length === 500 });
  } catch (err) {
    next(err);
  }
});

/** GET /pay-bill/clients/:id/terms — the terms in force today and every dated version. */
payBillRouter.get('/clients/:id/terms', BILLING, FINANCE_READ, async (req, res, next) => {
  try {
    const client = await clientInReach(req.user!, req.params.id);
    const [current, history] = await Promise.all([
      termsFor(prisma, client.id),
      prisma.clientBillingTerms.findMany({ where: { clientId: client.id, tenantId: tenantIdForWrite() }, orderBy: { effectiveFrom: 'desc' }, take: 50 }),
    ]);
    res.json({
      client,
      current,
      history: history.map((h) => ({
        id: h.id,
        effectiveFrom: ymd(h.effectiveFrom),
        retroRebill: h.retroRebill,
        overtimeBilling: h.overtimeBilling,
        premiumRules: normalizeRules(h.premiumRules),
        defaultMarkupPct: h.defaultMarkupPct == null ? null : Number(h.defaultMarkupPct),
        notes: h.notes,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const RuleSchema = z.object({ mode: z.enum(['NOT_BILLABLE', 'AT_COST', 'BILL_MARKUP']), markupPct: z.number().min(0).max(500).nullable().optional() });
const TermsInputSchema = z.object({
  effectiveFrom: DateStr,
  retroRebill: z.enum(['AUTO', 'REVIEW', 'NEVER']),
  overtimeBilling: z.enum(['MULTIPLIED', 'STRAIGHT']),
  premiumRules: z.object(Object.fromEntries(PREMIUM_KEYS.map((k) => [k, RuleSchema])) as Record<(typeof PREMIUM_KEYS)[number], typeof RuleSchema>),
  defaultMarkupPct: z.number().min(0).max(500).nullable(),
  notes: z.string().max(1000).nullable().optional(),
});

/** PUT /pay-bill/clients/:id/terms — Finance sets the contract's billing terms from a date (same date = correct that version). */
payBillRouter.put('/clients/:id/terms', BILLING, FINANCE_WRITE, async (req, res, next) => {
  try {
    const user = req.user!;
    const client = await clientInReach(user, req.params.id);
    const parsed = TermsInputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid billing terms', parsed.error.flatten());
    const d = parsed.data;
    const effectiveFrom = dateOnly(d.effectiveFrom);
    const before = await prisma.clientBillingTerms.findUnique({ where: { clientId_effectiveFrom: { clientId: client.id, effectiveFrom } } });
    const data = {
      retroRebill: d.retroRebill,
      overtimeBilling: d.overtimeBilling,
      premiumRules: normalizeRules(d.premiumRules) as unknown as Prisma.InputJsonValue,
      defaultMarkupPct: d.defaultMarkupPct,
      notes: d.notes ?? null,
      updatedById: user.id,
    };
    const row = before
      ? await prisma.clientBillingTerms.update({ where: { id: before.id }, data })
      : await prisma.clientBillingTerms.create({ data: { ...data, tenantId: tenantIdForWrite(), clientId: client.id, effectiveFrom } });
    enqueueAudit(
      {
        actorUserId: user.id,
        clientId: client.id,
        action: before ? 'billing.terms_corrected' : 'billing.terms_set',
        entityType: 'ClientBillingTerms',
        entityId: row.id,
        metadata: { effectiveFrom: d.effectiveFrom, before: before ? { retroRebill: before.retroRebill, overtimeBilling: before.overtimeBilling, premiumRules: before.premiumRules, defaultMarkupPct: before.defaultMarkupPct == null ? null : Number(before.defaultMarkupPct) } : null, after: { retroRebill: d.retroRebill, overtimeBilling: d.overtimeBilling, premiumRules: data.premiumRules, defaultMarkupPct: d.defaultMarkupPct } } as Prisma.InputJsonValue,
      },
      'payBill',
    );
    res.status(before ? 200 : 201).json({ current: await termsFor(prisma, client.id) });
  } catch (err) {
    next(err);
  }
});

/** POST /pay-bill/runs/:id/link — bill a finalized run's premiums and retro pay again (idempotent; for runs finalized before the contract was set). */
payBillRouter.post('/runs/:id/link', BILLING, FINANCE_WRITE, async (req, res, next) => {
  try {
    const user = req.user!;
    const run = await prisma.payrollRun.findFirst({
      where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: req.params.id, tenantId: tenantIdForWrite() }, scopePayrollRuns(user)),
      select: { id: true, status: true },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    if (run.status !== 'FINALIZED' && run.status !== 'DISBURSED') throw new HttpError(409, 'not_final', 'Only a finalized run is billed.');
    res.json(await onPayrollFinalized(prisma, run.id, user.id));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /pay-bill/running-cost — this org week's payroll cost so far, per
 * store, inside the caller's reach. Works without client billing (a hotel's
 * own stores) — it is payroll cost, not a bill.
 */
payBillRouter.get('/running-cost', requireAnyCapability('process:payroll', 'view:executive'), async (req, res, next) => {
  try {
    const user = req.user!;
    const weekStart = startOfWeekUTC(new Date());
    const result = await runningPayrollCost(prisma, scopeWhere<Prisma.TimeEntryWhereInput>({ tenantId: tenantIdForWrite() }, scopeTimeEntries(user)), weekStart);
    res.json({ weekStart: ymd(weekStart), weekEnd: ymd(new Date(weekStart.getTime() + 6 * 86_400_000)), ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /pay-bill/payroll-agent/run — run the Payroll agent now over the
 * draft runs (or one run): a proposed fix per exception, each waiting on a
 * person. Payroll's own surface, not billing: no clientPortal gate.
 */
payBillRouter.post('/payroll-agent/run', FINANCE_WRITE, async (req, res, next) => {
  try {
    const runId = z.string().uuid().optional().safeParse(req.body?.runId ?? undefined);
    if (!runId.success) throw new HttpError(400, 'invalid_run', 'runId must be a payroll run id.');
    if (runId.data) {
      const run = await prisma.payrollRun.findFirst({
        where: scopeWhere<Prisma.PayrollRunWhereInput>({ id: runId.data, tenantId: tenantIdForWrite() }, scopePayrollRuns(req.user!)),
        select: { id: true },
      });
      if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    }
    res.json(await runPayrollPrep(prisma, { runId: runId.data }));
  } catch (err) {
    next(err);
  }
});
