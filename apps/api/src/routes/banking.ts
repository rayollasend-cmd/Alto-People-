import { Router } from 'express';
import { z } from 'zod';
import type { AchFile, EmployerBankAccount, PayrollBankingProfile, PayrollFunding } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { enqueueAudit } from '../lib/audit.js';
import { encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { isClientBoundedRole, isInternallyScoped, scopePayrollRuns } from '../lib/scope.js';
import { createApprovalRequest, pendingResponse } from '../lib/approvalRequests.js';
import { activeConnection } from '../lib/providers/connections.js';
import { balancedOffsetGap, bankingProfile, fileContent, originationGaps, ownAccount as drawnOnOwnAccount, usesOurAch } from '../lib/banking/ach.js';
import { computeFunding, loadTenantHolidays, payDateFor, recordWire, submitFunding } from '../lib/banking/funding.js';
import { applyAchReturn, applyNoc, confirmMicroDeposits, markFileUploaded, sendDuePrenotes, startAccountVerification } from '../lib/banking/directDeposit.js';
import { accrueDepositsForRun } from '../lib/taxDeposits.js';
import { postLiabilitiesForRun } from '../lib/payrollTaxLedger.js';
import { accrueRemittancesForRun } from '../lib/garnishmentRemittance.js';
import { recordPayrollEvent } from '../lib/audit.js';
import { payrollCalendar } from '../lib/banking/calendar.js';
import { achTimeline, SAME_DAY_WINDOWS, type AchSpeed } from '../lib/banking/holidays.js';
import { isValidRouting, parseReturnFile } from '../lib/banking/nacha.js';

/**
 * Payroll banking (Pay & finance → Payroll banking).
 *
 *   GET  /payroll-banking/summary                 profile, gaps, bank connection, accounts, runs to fund
 *   PUT  /payroll-banking/profile                 rail, speed, ACH identifiers, KYB, limits (raising a limit waits for a second person)
 *   POST /payroll-banking/accounts                add an operating account (unverified)
 *   POST /payroll-banking/accounts/:id/verify     send micro-deposits or a prenote
 *   POST /payroll-banking/accounts/:id/confirm    the two micro-deposit amounts
 *   POST /payroll-banking/accounts/:id/funding    pull payroll from this (verified) account
 *   DELETE /payroll-banking/accounts/:id          disable an account
 *   GET  /payroll-banking/runs/:runId/funding     the run's funding (or a preview)
 *   POST /payroll-banking/runs/:runId/funding     pull it (202 when over a limit)
 *   POST /payroll-banking/runs/:runId/wire        a wire expected / received instead
 *   GET  /payroll-banking/files                   NACHA file history
 *   GET  /payroll-banking/files/:id/download      the file (audited)
 *   POST /payroll-banking/files/:id/uploaded      own-account mode: the file reached the bank; its paychecks read paid
 *   GET  /payroll-banking/entries                 returns and notifications of change
 *   POST /payroll-banking/returns                 upload the bank's return file (in-house mode)
 *   POST /payroll-banking/prenotes                send due prenotes now
 *   GET  /payroll-banking/deposits                employee accounts and their prenote state
 *   GET  /payroll-banking/calendar?year=          the payroll calendar
 *   POST /payroll-banking/holidays                a day the bank is closed (or open)
 *   DELETE /payroll-banking/holidays/:id
 *
 * Reading needs view:payroll (at mount); every change needs process:payroll.
 */
export const bankingRouter = Router();
const PROCESS = requireCapability('process:payroll');

// The company's bank, its money and every employee's deposit: whole-company only.
bankingRouter.use((req, _res, next) => {
  const user = req.user!;
  if (isClientBoundedRole(user) || isInternallyScoped(user)) {
    next(new HttpError(403, 'whole_company_only', 'Payroll banking covers the whole company. Your access is limited to some sites, so ask a payroll admin with full access.'));
    return;
  }
  next();
});

const money = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function profileView(p: PayrollBankingProfile) {
  return {
    id: p.id,
    bankRail: p.bankRail,
    achSpeed: p.achSpeed,
    settlement: p.settlement,
    fileFormat: p.fileFormat,
    submitCutoffEt: p.submitCutoffEt,
    companyName: p.companyName,
    companyId: p.companyId,
    companyEntryDescription: p.companyEntryDescription,
    immediateDestination: p.immediateDestination,
    immediateDestinationName: p.immediateDestinationName,
    immediateOrigin: p.immediateOrigin,
    immediateOriginName: p.immediateOriginName,
    originatingDfi: p.originatingDfi,
    kybStatus: p.kybStatus,
    kybCheckedAt: p.kybCheckedAt?.toISOString() ?? null,
    kybNote: p.kybNote,
    perRunLimitCents: p.perRunLimitCents == null ? null : Number(p.perRunLimitCents),
    perDayLimitCents: p.perDayLimitCents == null ? null : Number(p.perDayLimitCents),
    requirePrenote: p.requirePrenote,
    collectTaxes: p.collectTaxes,
    collectGarnishments: p.collectGarnishments,
    fundingAccountId: p.fundingAccountId,
    gaps: [...originationGaps(p), ...balancedOffsetGap(p)],
  };
}

function accountView(a: EmployerBankAccount) {
  return {
    id: a.id,
    label: a.label,
    bankName: a.bankName,
    routingNumber: a.routingNumber,
    accountLast4: a.accountLast4,
    accountType: a.accountType,
    status: a.status,
    microDepositSentAt: a.microDepositSentAt?.toISOString() ?? null,
    attemptsLeft: Math.max(0, 5 - a.microDepositAttempts),
    verifiedAt: a.verifiedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function fundingView(f: PayrollFunding) {
  return {
    id: f.id,
    payrollRunId: f.payrollRunId,
    status: f.status,
    amountCents: Number(f.amountCents),
    breakdown: f.breakdown,
    payDate: f.payDate.toISOString().slice(0, 10),
    debitEffectiveDate: f.debitEffectiveDate.toISOString().slice(0, 10),
    fundingDeadline: f.fundingDeadline.toISOString(),
    achSpeed: f.achSpeed,
    bankAccountId: f.bankAccountId,
    approvalRequestId: f.approvalRequestId,
    submittedAt: f.submittedAt?.toISOString() ?? null,
    settledAt: f.settledAt?.toISOString() ?? null,
    returnCode: f.returnCode,
    returnReason: f.returnReason,
    returnedAt: f.returnedAt?.toISOString() ?? null,
    note: f.note,
  };
}

function fileView(f: AchFile & { _count?: { entries: number } }, returns = 0) {
  return {
    id: f.id,
    purpose: f.purpose,
    provider: f.provider,
    status: f.status,
    effectiveDate: f.effectiveDate.toISOString().slice(0, 10),
    sameDay: f.sameDay,
    entryCount: f.entryCount,
    totalDebitCents: Number(f.totalDebitCents),
    totalCreditCents: Number(f.totalCreditCents),
    payrollRunId: f.payrollRunId,
    createdAt: f.createdAt.toISOString(),
    submittedAt: f.submittedAt?.toISOString() ?? null,
    error: f.error,
    returns,
    // In-house and not yet marked: a person still has to carry it to the bank.
    uploadable: f.provider === 'IN_HOUSE' && (f.status === 'CREATED' || f.status === 'DOWNLOADED'),
  };
}

/** A run the caller can reach, or 404. */
async function reachableRun(req: Parameters<typeof scopePayrollRuns>[0], runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, ...scopePayrollRuns(req) }, select: { id: true, status: true, periodStart: true, periodEnd: true, clientId: true } });
  if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
  return run;
}

/** What a run needs, without writing anything. */
async function fundingPreview(profile: PayrollBankingProfile, runId: string) {
  await loadTenantHolidays(prisma);
  const { amountCents, breakdown } = await computeFunding(prisma, runId, profile);
  const payDate = await payDateFor(prisma, runId);
  const t = achTimeline(payDate, profile.achSpeed as AchSpeed, profile.submitCutoffEt);
  return {
    id: null,
    payrollRunId: runId,
    status: 'NOT_STARTED',
    amountCents,
    breakdown,
    payDate,
    debitEffectiveDate: t.debitEffectiveDate,
    fundingDeadline: t.fundingDeadline.toISOString(),
    achSpeed: profile.achSpeed,
    bankAccountId: profile.fundingAccountId,
    approvalRequestId: null,
    submittedAt: null,
    settledAt: null,
    returnCode: null,
    returnReason: null,
    returnedAt: null,
    note: null,
  };
}

bankingRouter.get('/summary', async (req, res, next) => {
  try {
    const profile = await bankingProfile(prisma);
    const conn = await activeConnection('ORIGINATION');
    const accounts = await prisma.employerBankAccount.findMany({ where: { tenantId: tenantIdForWrite(), status: { not: 'DISABLED' } }, orderBy: { createdAt: 'asc' }, take: 50 });
    // Runs approved for pay but not yet paid, with what each needs.
    const runs = await prisma.payrollRun.findMany({
      where: { ...scopePayrollRuns(req.user!), status: 'FINALIZED' },
      orderBy: { periodEnd: 'asc' },
      take: 12,
      select: { id: true, periodStart: true, periodEnd: true, clientId: true, client: { select: { name: true } } },
    });
    const fundings = await prisma.payrollFunding.findMany({ where: { payrollRunId: { in: runs.map((r) => r.id) } } });
    const byRun = new Map(fundings.map((f) => [f.payrollRunId, f]));
    // Drawn on the company's own account there is nothing to fund: the files tab carries the runs.
    const runViews = usesOurAch(profile) && !drawnOnOwnAccount(profile)
      ? await Promise.all(
          runs.map(async (r) => ({
            runId: r.id,
            periodStart: r.periodStart.toISOString().slice(0, 10),
            periodEnd: r.periodEnd.toISOString().slice(0, 10),
            clientName: r.client?.name ?? null,
            funding: byRun.has(r.id) ? fundingView(byRun.get(r.id)!) : await fundingPreview(profile, r.id),
          })),
        )
      : [];
    const openReturns = await prisma.achEntry.count({ where: { tenantId: tenantIdForWrite(), status: 'RETURNED', returnedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } });
    res.json({
      profile: profileView(profile),
      connection: conn ? { id: conn.id, provider: conn.provider, environment: conn.environment, name: conn.name } : null,
      accounts: accounts.map(accountView),
      runs: runViews,
      openReturns,
      sameDayWindows: SAME_DAY_WINDOWS,
    });
  } catch (err) {
    next(err);
  }
});

const DIGITS = (n: number) => z.string().trim().regex(new RegExp(`^\\d{${n}}$`));
const ProfileInput = z.object({
  bankRail: z.enum(['PLATFORM', 'ACH', 'BRANCH', 'WISE', 'CHECK']).optional(),
  achSpeed: z.enum(['SAME_DAY', 'NEXT_DAY', 'TWO_DAY']).optional(),
  settlement: z.enum(['PREFUND', 'OWN_ACCOUNT']).optional(),
  fileFormat: z.enum(['UNBALANCED', 'BALANCED']).optional(),
  submitCutoffEt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  companyName: z.string().trim().min(1).max(16).nullable().optional(),
  companyId: z.string().trim().length(10).nullable().optional(),
  companyEntryDescription: z.string().trim().min(1).max(10).optional(),
  immediateDestination: DIGITS(9).nullable().optional(),
  immediateDestinationName: z.string().trim().max(23).nullable().optional(),
  immediateOrigin: z.string().trim().min(9).max(10).nullable().optional(),
  immediateOriginName: z.string().trim().max(23).nullable().optional(),
  originatingDfi: DIGITS(8).nullable().optional(),
  kybStatus: z.enum(['NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED']).optional(),
  kybNote: z.string().trim().max(500).nullable().optional(),
  perRunLimitCents: z.number().int().positive().nullable().optional(),
  perDayLimitCents: z.number().int().positive().nullable().optional(),
  requirePrenote: z.boolean().optional(),
  collectTaxes: z.boolean().optional(),
  collectGarnishments: z.boolean().optional(),
});

bankingRouter.put('/profile', PROCESS, async (req, res, next) => {
  try {
    const input = ProfileInput.parse(req.body);
    if (input.immediateDestination && !isValidRouting(input.immediateDestination)) throw new HttpError(400, 'invalid_routing', `${input.immediateDestination} isn’t a valid routing number.`);
    const profile = await bankingProfile(prisma);
    const { perRunLimitCents, perDayLimitCents, ...rest } = input;
    // A higher (or no) limit is a two-person decision; a lower one applies now.
    const looser = (next: number | null | undefined, cur: bigint | null) => next !== undefined && (next === null ? cur !== null : cur !== null && next > Number(cur));
    const runLooser = looser(perRunLimitCents, profile.perRunLimitCents);
    const dayLooser = looser(perDayLimitCents, profile.perDayLimitCents);
    const data: Record<string, unknown> = { ...rest };
    if (rest.kybStatus && rest.kybStatus !== profile.kybStatus) data.kybCheckedAt = new Date();
    if (perRunLimitCents !== undefined && !runLooser) data.perRunLimitCents = perRunLimitCents == null ? null : BigInt(perRunLimitCents);
    if (perDayLimitCents !== undefined && !dayLooser) data.perDayLimitCents = perDayLimitCents == null ? null : BigInt(perDayLimitCents);
    const updated = await prisma.payrollBankingProfile.update({ where: { id: profile.id }, data });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.banking_profile_updated', entityType: 'PayrollBankingProfile', entityId: profile.id, metadata: { fields: Object.keys(data) } }, 'banking');
    if (runLooser || dayLooser) {
      const proposed = {
        profileId: profile.id,
        perRunLimitCents: runLooser ? (perRunLimitCents ?? null) : updated.perRunLimitCents == null ? null : Number(updated.perRunLimitCents),
        perDayLimitCents: dayLooser ? (perDayLimitCents ?? null) : updated.perDayLimitCents == null ? null : Number(updated.perDayLimitCents),
      };
      const describe = (c: number | null) => (c == null ? 'no limit' : money(c));
      const approval = await createApprovalRequest(prisma, {
        kind: 'PAYROLL_FUNDING_LIMIT',
        subjectType: 'PayrollBankingProfile',
        subjectId: profile.id,
        title: `Raise payroll funding limits — per run ${describe(proposed.perRunLimitCents)}, per day ${describe(proposed.perDayLimitCents)}`,
        summary: 'Higher limits let larger payrolls be pulled without a second person.',
        proposed: { profileLimits: proposed },
        before: { perRunLimitCents: profile.perRunLimitCents == null ? null : Number(profile.perRunLimitCents), perDayLimitCents: profile.perDayLimitCents == null ? null : Number(profile.perDayLimitCents) },
        requesterUserId: req.user!.id,
        approver: { capability: 'process:payroll' },
      });
      res.status(202).json({ ...pendingResponse(approval), profile: profileView(updated) });
      return;
    }
    res.json({ profile: profileView(updated) });
  } catch (err) {
    next(err);
  }
});

const AccountInput = z.object({
  label: z.string().trim().min(1).max(80),
  bankName: z.string().trim().max(120).nullable().optional(),
  routingNumber: DIGITS(9),
  accountNumber: z.string().trim().regex(/^\d{4,17}$/),
  accountType: z.enum(['CHECKING', 'SAVINGS']).default('CHECKING'),
});

bankingRouter.post('/accounts', PROCESS, async (req, res, next) => {
  try {
    const input = AccountInput.parse(req.body);
    if (!isValidRouting(input.routingNumber)) throw new HttpError(400, 'invalid_routing', `${input.routingNumber} isn’t a valid routing number — check the nine digits at the bottom left of a check.`);
    const row = await prisma.employerBankAccount.create({
      data: {
        tenantId: tenantIdForWrite(),
        label: input.label,
        bankName: input.bankName ?? null,
        routingNumber: input.routingNumber,
        accountNumberEnc: encryptString(input.accountNumber),
        accountLast4: input.accountNumber.slice(-4),
        accountType: input.accountType,
        createdById: req.user!.id,
      },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'banking.account_added', entityType: 'EmployerBankAccount', entityId: row.id, metadata: { last4: row.accountLast4, routing: row.routingNumber } }, 'banking');
    res.status(201).json({ account: accountView(row) });
  } catch (err) {
    next(err);
  }
});

async function ownAccount(id: string) {
  const a = await prisma.employerBankAccount.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!a) throw new HttpError(404, 'account_not_found', 'That bank account isn’t on file.');
  return a;
}

bankingRouter.post('/accounts/:id/verify', PROCESS, async (req, res, next) => {
  try {
    const { method } = z.object({ method: z.enum(['MICRODEPOSITS', 'PRENOTE']).default('MICRODEPOSITS') }).parse(req.body ?? {});
    await ownAccount(req.params.id!);
    const r = await startAccountVerification(prisma, req.params.id!, method, req.user!.id);
    res.json({ ...r, account: accountView(await ownAccount(req.params.id!)) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/accounts/:id/confirm', PROCESS, async (req, res, next) => {
  try {
    const { amounts } = z.object({ amounts: z.tuple([z.number().int().min(1).max(99), z.number().int().min(1).max(99)]) }).parse(req.body);
    await ownAccount(req.params.id!);
    const r = await confirmMicroDeposits(prisma, req.params.id!, amounts, req.user!.id);
    res.json({ ...r, account: accountView(await ownAccount(req.params.id!)) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/accounts/:id/funding', PROCESS, async (req, res, next) => {
  try {
    const a = await ownAccount(req.params.id!);
    if (a.status !== 'VERIFIED') throw new HttpError(409, 'account_unverified', 'Verify this account before pulling payroll from it.');
    const profile = await bankingProfile(prisma);
    const updated = await prisma.payrollBankingProfile.update({ where: { id: profile.id }, data: { fundingAccountId: a.id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.funding_account_changed', entityType: 'PayrollBankingProfile', entityId: profile.id, metadata: { from: profile.fundingAccountId, to: a.id, last4: a.accountLast4 } }, 'banking');
    res.json({ profile: profileView(updated) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.delete('/accounts/:id', PROCESS, async (req, res, next) => {
  try {
    const a = await ownAccount(req.params.id!);
    const profile = await bankingProfile(prisma);
    if (profile.fundingAccountId === a.id) throw new HttpError(409, 'funding_account', 'Payroll is pulled from this account — choose another first.');
    await prisma.employerBankAccount.update({ where: { id: a.id }, data: { status: 'DISABLED', microDepositHash: null } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'banking.account_disabled', entityType: 'EmployerBankAccount', entityId: a.id, metadata: { last4: a.accountLast4 } }, 'banking');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

bankingRouter.get('/runs/:runId/funding', async (req, res, next) => {
  try {
    const run = await reachableRun(req.user!, req.params.runId!);
    const profile = await bankingProfile(prisma);
    if (!usesOurAch(profile) || drawnOnOwnAccount(profile)) {
      res.json({ applies: false, funding: null });
      return;
    }
    const f = await prisma.payrollFunding.findUnique({ where: { payrollRunId: run.id } });
    res.json({ applies: true, funding: f ? fundingView(f) : await fundingPreview(profile, run.id) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/runs/:runId/funding', PROCESS, idempotent, async (req, res, next) => {
  try {
    const run = await reachableRun(req.user!, req.params.runId!);
    if (run.status !== 'FINALIZED') throw new HttpError(409, 'not_finalized', 'Finalize the run before pulling its funding.');
    const r = await submitFunding(prisma, run.id, { id: req.user!.id });
    if (r.pending) {
      const approval = await prisma.approvalRequest.findUnique({ where: { id: r.pending.approvalId } });
      res.status(202).json({ ...(approval ? pendingResponse(approval) : { pending: true, approvalId: r.pending.approvalId }), funding: fundingView(r.funding) });
      return;
    }
    res.json({ funding: fundingView(r.funding) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/runs/:runId/wire', PROCESS, async (req, res, next) => {
  try {
    const run = await reachableRun(req.user!, req.params.runId!);
    const { state, note } = z.object({ state: z.enum(['WIRE_PENDING', 'WIRE_RECEIVED']), note: z.string().trim().min(1).max(500) }).parse(req.body);
    const f = await recordWire(prisma, run.id, req.user!.id, state, note);
    res.json({ funding: fundingView(f) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.get('/files', PROCESS, async (req, res, next) => {
  try {
    const purpose = z.enum(['FUNDING', 'DIRECT_DEPOSIT', 'PRENOTE', 'MICRODEPOSIT', 'GARNISHMENT', 'VENDOR']).optional().parse(req.query.purpose || undefined);
    const files = await prisma.achFile.findMany({ where: { tenantId: tenantIdForWrite(), ...(purpose ? { purpose } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    const returns = await prisma.achEntry.groupBy({ by: ['achFileId'], where: { achFileId: { in: files.map((f) => f.id) }, status: 'RETURNED' }, _count: { _all: true } });
    const rc = new Map(returns.map((r) => [r.achFileId, r._count._all]));
    res.json({ files: files.map((f) => fileView(f, rc.get(f.id) ?? 0)) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.get('/files/:id/download', PROCESS, async (req, res, next) => {
  try {
    const f = await prisma.achFile.findFirst({ where: { id: req.params.id, tenantId: tenantIdForWrite() } });
    if (!f) throw new HttpError(404, 'file_not_found', 'That file isn’t on record.');
    const content = fileContent(f);
    await prisma.achFile.update({ where: { id: f.id }, data: { status: f.status === 'CREATED' ? 'DOWNLOADED' : f.status } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.ach_file_downloaded', entityType: 'AchFile', entityId: f.id, metadata: { purpose: f.purpose, entries: f.entryCount, sha256: f.sha256 } }, 'banking');
    const name = `ach-${f.purpose.toLowerCase()}-${f.effectiveDate.toISOString().slice(0, 10)}-${f.fileIdModifier}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/files/:id/uploaded', PROCESS, idempotent, async (req, res, next) => {
  try {
    const r = await markFileUploaded(prisma, req.params.id!, req.user!.id);
    for (const runId of r.runsSettled) {
      // The run just settled: the same bookkeeping the disburse route does when a rail answers at once.
      void accrueDepositsForRun(prisma, runId).catch((err) => console.warn('[banking] tax-deposit accrual failed (advisory):', err));
      void postLiabilitiesForRun(prisma, runId).catch((err) => console.warn('[banking] tax-liability posting failed (advisory):', err));
      void accrueRemittancesForRun(prisma, runId).catch((err) => console.warn('[banking] garnishment-remittance accrual failed (advisory):', err));
      const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { clientId: true } });
      await recordPayrollEvent({ actorUserId: req.user!.id, action: 'payroll.run_disbursed', payrollRunId: runId, clientId: run?.clientId ?? null, metadata: { provider: 'ACH', viaBankFile: true, fileId: r.fileId }, req, critical: true });
    }
    res.json(r);
  } catch (err) {
    next(err);
  }
});
bankingRouter.get('/entries', PROCESS, async (req, res, next) => {
  try {
    const status = z.enum(['RETURNED', 'CORRECTED']).optional().parse(req.query.status || undefined);
    const rows = await prisma.achEntry.findMany({
      where: { tenantId: tenantIdForWrite(), ...(status ? { status } : { OR: [{ status: 'RETURNED' }, { nocCode: { not: null } }] }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { file: { select: { purpose: true, effectiveDate: true } } },
    });
    res.json({
      entries: rows.map((e) => ({
        id: e.id,
        traceNumber: e.traceNumber,
        kind: e.kind,
        purpose: e.file.purpose,
        effectiveDate: e.file.effectiveDate.toISOString().slice(0, 10),
        amountCents: Number(e.amountCents),
        name: e.individualName,
        accountLast4: e.accountLast4,
        status: e.status,
        returnCode: e.returnCode,
        returnedAt: e.returnedAt?.toISOString() ?? null,
        nocCode: e.nocCode,
        nocAppliedAt: e.nocAppliedAt?.toISOString() ?? null,
        payrollItemId: e.payrollItemId,
      })),
    });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/returns', PROCESS, async (req, res, next) => {
  try {
    const { content } = z.object({ content: z.string().min(94).max(2_000_000) }).parse(req.body);
    const items = parseReturnFile(content);
    if (!items.length) throw new HttpError(400, 'no_returns', 'That file has no returns or notifications of change in it.');
    let returned = 0;
    let corrected = 0;
    let unknown = 0;
    for (const it of items) {
      if (it.kind === 'RETURN') {
        const r = await applyAchReturn(prisma, { traceNumber: it.originalTrace }, it.code, req.user!.id);
        if (r.applied) returned += 1;
        else if (!r.kind) unknown += 1;
      } else {
        const r = await applyNoc(prisma, { traceNumber: it.originalTrace }, it.code, it.correctedData, req.user!.id);
        if (r.applied) corrected += 1;
        else if (r.reason === 'unknown_entry') unknown += 1;
      }
    }
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.ach_returns_uploaded', entityType: 'AchReturnFile', entityId: 'upload', metadata: { returned, corrected, unknown, total: items.length } }, 'banking');
    res.json({ returned, corrected, unknown, total: items.length });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/prenotes', PROCESS, async (req, res, next) => {
  try {
    res.json(await sendDuePrenotes(prisma, req.user!.id));
  } catch (err) {
    next(err);
  }
});

bankingRouter.get('/deposits', PROCESS, async (_req, res, next) => {
  try {
    const methods = await prisma.payoutMethod.findMany({
      where: { tenantId: tenantIdForWrite(), type: 'BANK_ACCOUNT', retiredAt: null },
      select: { id: true, associateId: true, accountLast4: true, accountType: true, bankName: true, isPrimary: true, verifiedAt: true, splitKind: true, splitAmountCents: true, splitPercent: true, prenoteStatus: true, prenoteSentAt: true, associate: { select: { firstName: true, lastName: true } } },
      orderBy: [{ prenoteStatus: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const counts = { cleared: 0, sent: 0, returned: 0, due: 0, unverified: 0, split: 0 };
    for (const m of methods) {
      if (!m.verifiedAt) counts.unverified += 1;
      else if (m.prenoteStatus === 'CLEARED') counts.cleared += 1;
      else if (m.prenoteStatus === 'SENT') counts.sent += 1;
      else if (m.prenoteStatus === 'RETURNED') counts.returned += 1;
      else counts.due += 1;
      if (m.splitKind) counts.split += 1;
    }
    res.json({
      counts,
      accounts: methods.map((m) => ({
        id: m.id,
        associateId: m.associateId,
        name: `${m.associate.firstName} ${m.associate.lastName}`,
        accountLast4: m.accountLast4,
        accountType: m.accountType,
        bankName: m.bankName,
        isPrimary: m.isPrimary,
        verified: !!m.verifiedAt,
        split: m.splitKind ? { kind: m.splitKind, amountCents: m.splitAmountCents, percent: m.splitPercent == null ? null : Number(m.splitPercent) } : null,
        prenoteStatus: m.prenoteStatus,
        prenoteSentAt: m.prenoteSentAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

bankingRouter.get('/calendar', async (req, res, next) => {
  try {
    const year = z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()).parse(req.query.year || undefined);
    const profile = await bankingProfile(prisma);
    const cal = await payrollCalendar(prisma, profile, year);
    const overrides = await prisma.bankHolidayOverride.findMany({ where: { tenantId: tenantIdForWrite(), date: { gte: new Date(`${year}-01-01T00:00:00Z`), lte: new Date(`${year}-12-31T00:00:00Z`) } }, orderBy: { date: 'asc' } });
    res.json({ ...cal, overrides: overrides.map((o) => ({ id: o.id, date: o.date.toISOString().slice(0, 10), name: o.name, closed: o.closed })) });
  } catch (err) {
    next(err);
  }
});

bankingRouter.post('/holidays', PROCESS, async (req, res, next) => {
  try {
    const input = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(80), closed: z.boolean().default(true) }).parse(req.body);
    const tenantId = tenantIdForWrite();
    const date = new Date(`${input.date}T00:00:00Z`);
    const row = await prisma.bankHolidayOverride.upsert({
      where: { tenantId_date: { tenantId, date } },
      create: { tenantId, date, name: input.name, closed: input.closed, createdById: req.user!.id },
      update: { name: input.name, closed: input.closed },
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.bank_holiday_set', entityType: 'BankHolidayOverride', entityId: row.id, metadata: input }, 'banking');
    res.status(201).json({ override: { id: row.id, date: input.date, name: row.name, closed: row.closed } });
  } catch (err) {
    next(err);
  }
});

bankingRouter.delete('/holidays/:id', PROCESS, async (req, res, next) => {
  try {
    const row = await prisma.bankHolidayOverride.findFirst({ where: { id: req.params.id, tenantId: tenantIdForWrite() } });
    if (!row) throw new HttpError(404, 'override_not_found', 'That day isn’t on the calendar.');
    await prisma.bankHolidayOverride.delete({ where: { id: row.id } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'payroll.bank_holiday_removed', entityType: 'BankHolidayOverride', entityId: row.id, metadata: { date: row.date.toISOString().slice(0, 10) } }, 'banking');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
