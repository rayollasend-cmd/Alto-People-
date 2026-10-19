import type { PayrollBankingProfile, PayrollFunding, Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../../middleware/error.js';
import { enqueueAudit } from '../audit.js';
import { decryptString } from '../crypto.js';
import { notifyFinance } from '../financialChanges.js';
import { tenantIdForWrite } from '../tenant.js';
import { createApprovalRequest, registerApplyHandler } from '../approvalRequests.js';
import { describeBranchFailure } from '../achReturnCodes.js';
import { bankingProfile, originate, usesOurAch } from './ach.js';
import { achTimeline, adjustPayDate, setHolidayOverrides, type AchSpeed } from './holidays.js';

/**
 * The money behind a run.
 *
 * Before anyone is paid through our ACH, the employer's money comes in: a
 * CCD debit from its verified operating account for the run's net pay to
 * bank accounts (plus its taxes and garnishment remittances when we pay
 * those on), settling at least a banking day before the credits go out.
 * Disbursement refuses a run whose funding hasn't settled (or arrived by
 * wire). A debit that comes back — R01 insufficient funds, R02 closed,
 * R03 no account — holds the run and tells Finance how to wire instead.
 *
 * Limits: a run over the profile's per-run limit, or a day over its
 * per-day limit, waits for a second person (PAYROLL_FUNDING_LIMIT). KYB:
 * a production bank connection originates only for an approved employer.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const cents = (d: Prisma.Decimal | number | null | undefined) => Math.round(Number(d ?? 0) * 100);

export interface FundingBreakdown {
  netPayCents: number;
  /** People paid by our ACH (the ones this debit covers). */
  achPeople: number;
  /** Paid elsewhere (card, check): funded through that rail, not this debit. */
  otherRailNetCents: number;
  taxesCents: number;
  garnishmentsCents: number;
  feesCents: number;
  /** Paychecks payroll set to pay by paper check this time: drawn on the employer's account, so the debit covers them too. */
  paperCheckNetCents?: number;
  paperCheckPeople?: number;
}

/** What this run needs from the employer. */
export async function computeFunding(db: Db, runId: string, profile: PayrollBankingProfile): Promise<{ amountCents: number; breakdown: FundingBreakdown }> {
  const run = await db.payrollRun.findFirstOrThrow({ where: { id: runId, tenantId: tenantIdForWrite() }, select: { id: true, totalTax: true, totalEmployerTax: true } });
  const items = await db.payrollItem.findMany({ where: { payrollRunId: run.id }, select: { id: true, associateId: true, netPay: true, payoutOverride: { select: { clearedAt: true, method: true } } } });
  const methods = await db.payoutMethod.findMany({
    where: { associateId: { in: [...new Set(items.map((i) => i.associateId))] }, isPrimary: true, retiredAt: null },
    select: { associateId: true, branchCardId: true, accountNumberEnc: true },
  });
  const rail = new Map(methods.map((m) => [m.associateId, m.branchCardId ? 'card' : m.accountNumberEnc ? 'bank' : 'none']));
  let net = 0;
  let other = 0;
  let people = 0;
  let paper = 0;
  let paperPeople = 0;
  for (const i of items) {
    const n = cents(i.netPay);
    if (n <= 0) continue;
    // A paper check this time: never in the ACH credit file, still the employer's money.
    if (i.payoutOverride && !i.payoutOverride.clearedAt && i.payoutOverride.method === 'CHECK') {
      paper += n;
      paperPeople += 1;
    } else if (rail.get(i.associateId) === 'bank') {
      net += n;
      people += 1;
    } else other += n;
  }
  const taxes = profile.collectTaxes ? cents(run.totalTax) + cents(run.totalEmployerTax) : 0;
  let garnish = 0;
  if (profile.collectGarnishments) {
    const g = await db.garnishmentDeduction.aggregate({ where: { payrollRunId: run.id }, _sum: { amount: true } });
    garnish = cents(g._sum.amount);
  }
  const breakdown: FundingBreakdown = { netPayCents: net, achPeople: people, otherRailNetCents: other, taxesCents: taxes, garnishmentsCents: garnish, feesCents: 0, paperCheckNetCents: paper, paperCheckPeople: paperPeople };
  return { amountCents: net + paper + taxes + garnish, breakdown };
}

/**
 * The run's pay date: its period end plus the pay schedule's offset (the
 * client's schedule, else the tenant's, else 7 days), moved to the banking
 * day before a weekend or holiday.
 */
export async function payDateFor(db: Db, runId: string): Promise<string> {
  const run = await db.payrollRun.findFirstOrThrow({ where: { id: runId, tenantId: tenantIdForWrite() }, select: { periodEnd: true, clientId: true, payrollScheduleId: true } });
  const schedule =
    // A run made for one pay schedule is paid on that schedule's day.
    (run.payrollScheduleId ? await db.payrollSchedule.findFirst({ where: { id: run.payrollScheduleId }, select: { payDateOffsetDays: true } }) : null) ??
    (run.clientId ? await db.payrollSchedule.findFirst({ where: { clientId: run.clientId, isActive: true, deletedAt: null }, select: { payDateOffsetDays: true } }) : null) ??
    (await db.payrollSchedule.findFirst({ where: { tenantId: tenantIdForWrite(), clientId: null, isActive: true, deletedAt: null }, select: { payDateOffsetDays: true } }));
  const offset = schedule?.payDateOffsetDays ?? 7;
  const nominal = new Date(run.periodEnd.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return adjustPayDate(nominal).payDate;
}

/** Load this tenant's holiday overrides into the calendar before date math. */
export async function loadTenantHolidays(db: Db): Promise<void> {
  const rows = await db.bankHolidayOverride.findMany({ where: { tenantId: tenantIdForWrite() } });
  setHolidayOverrides(rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), name: r.name, closed: r.closed })));
}

const money = (c: number | bigint) => (Number(c) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export interface FundingView extends Omit<PayrollFunding, 'amountCents'> {
  amountCents: number;
}
export function viewFunding(f: PayrollFunding): FundingView {
  return { ...f, amountCents: Number(f.amountCents) };
}

/**
 * Work out (or refresh) the run's funding: amount, the account it comes
 * from, and the deadline. Nothing moves until submitFunding.
 */
export async function prepareFunding(db: PrismaClient, runId: string, actorUserId: string, payDateOverride?: string): Promise<PayrollFunding> {
  const profile = await bankingProfile(db);
  if (!usesOurAch(profile)) throw new HttpError(409, 'not_our_ach', 'This organization pays bank accounts through another rail, so there is nothing to fund here.');
  await loadTenantHolidays(db);
  const existing = await db.payrollFunding.findUnique({ where: { payrollRunId: runId } });
  if (existing && !['DRAFT', 'CANCELLED'].includes(existing.status)) return existing;
  const { amountCents, breakdown } = await computeFunding(db, runId, profile);
  const payDate = payDateOverride ?? (await payDateFor(db, runId));
  const t = achTimeline(payDate, profile.achSpeed as AchSpeed, profile.submitCutoffEt);
  const data = {
    tenantId: tenantIdForWrite(),
    payrollRunId: runId,
    bankAccountId: profile.fundingAccountId,
    amountCents: BigInt(amountCents),
    breakdown: breakdown as unknown as Prisma.InputJsonValue,
    payDate: new Date(`${t.payDate}T00:00:00Z`),
    debitEffectiveDate: new Date(`${t.debitEffectiveDate}T00:00:00Z`),
    fundingDeadline: t.fundingDeadline,
    achSpeed: profile.achSpeed,
    status: 'DRAFT',
    createdById: actorUserId,
  };
  return existing ? db.payrollFunding.update({ where: { id: existing.id }, data }) : db.payrollFunding.create({ data });
}

/** Sum of today's submitted funding, for the per-day limit. */
async function fundedToday(db: Db, excludeId: string, now: Date): Promise<number> {
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const agg = await db.payrollFunding.aggregate({
    where: { tenantId: tenantIdForWrite(), id: { not: excludeId }, submittedAt: { gte: start }, status: { in: ['SUBMITTED', 'SETTLED'] } },
    _sum: { amountCents: true },
  });
  return Number(agg._sum.amountCents ?? 0n);
}

/**
 * Pull the money: checks the account, KYB and limits, then sends the CCD
 * debit. Over a limit (without an approved override) it waits for a
 * second person instead and answers { pending }.
 */
export async function submitFunding(db: PrismaClient, runId: string, actor: { id: string }, opts: { limitApproved?: boolean; now?: Date } = {}): Promise<{ funding: PayrollFunding; pending?: { approvalId: string } }> {
  const now = opts.now ?? new Date();
  const profile = await bankingProfile(db);
  let funding = await prepareFunding(db, runId, actor.id);
  if (funding.status === 'AWAITING_APPROVAL' && !opts.limitApproved) {
    return { funding, pending: { approvalId: funding.approvalRequestId! } };
  }
  if (!['DRAFT', 'AWAITING_APPROVAL', 'RETURNED'].includes(funding.status)) throw new HttpError(409, 'already_funding', 'This run’s funding is already on its way.');
  if (funding.amountCents <= 0n) {
    funding = await db.payrollFunding.update({ where: { id: funding.id }, data: { status: 'SETTLED', settledAt: now, note: 'Nothing to pull: no one on this run is paid by our ACH.' } });
    return { funding };
  }
  const account = profile.fundingAccountId ? await db.employerBankAccount.findFirst({ where: { id: profile.fundingAccountId, tenantId: tenantIdForWrite() } }) : null;
  if (!account) throw new HttpError(409, 'no_funding_account', 'Choose the operating account payroll is pulled from.');
  if (account.status !== 'VERIFIED') throw new HttpError(409, 'funding_account_unverified', `${account.label} ····${account.accountLast4} isn’t verified yet — confirm its micro-deposits first.`);
  const conn = await db.providerConnection.findFirst({ where: { tenantId: tenantIdForWrite(), kind: 'ORIGINATION', active: true }, orderBy: { createdAt: 'desc' } });
  if (conn?.environment === 'PRODUCTION' && profile.kybStatus !== 'APPROVED') {
    throw new HttpError(409, 'kyb_required', 'Your bank hasn’t approved this employer (KYB) yet, so live payroll can’t be pulled.');
  }
  // Limits: a second person approves anything over them.
  const amount = Number(funding.amountCents);
  const overRun = profile.perRunLimitCents != null && amount > Number(profile.perRunLimitCents);
  const overDay = profile.perDayLimitCents != null && amount + (await fundedToday(db, funding.id, now)) > Number(profile.perDayLimitCents);
  if ((overRun || overDay) && !opts.limitApproved) {
    const why = overRun
      ? `${money(amount)} is over the per-run limit of ${money(profile.perRunLimitCents!)}`
      : `it would take today past the per-day limit of ${money(profile.perDayLimitCents!)}`;
    const approval = await createApprovalRequest(db, {
      kind: 'PAYROLL_FUNDING_LIMIT',
      subjectType: 'PayrollRun',
      subjectId: runId,
      title: `Pull ${money(amount)} for payroll — ${why}`,
      summary: `Debit ${account.label} ····${account.accountLast4} on ${funding.debitEffectiveDate.toISOString().slice(0, 10)} for pay on ${funding.payDate.toISOString().slice(0, 10)}.`,
      proposed: { payrollRunId: runId, amountCents: amount },
      before: null,
      requesterUserId: actor.id,
      approver: { capability: 'process:payroll' },
    });
    funding = await db.payrollFunding.update({ where: { id: funding.id }, data: { status: 'AWAITING_APPROVAL', approvalRequestId: approval.id } });
    return { funding, pending: { approvalId: approval.id } };
  }
  const result = await originate(db, profile, {
    purpose: 'FUNDING',
    effectiveDate: funding.debitEffectiveDate.toISOString().slice(0, 10),
    sameDay: false,
    entryDescription: 'PAYROLL',
    payrollRunId: runId,
    createdById: actor.id,
    entries: [
      {
        kind: 'DEBIT',
        sec: 'CCD',
        amountCents: amount,
        routingNumber: account.routingNumber,
        accountNumber: decryptString(account.accountNumberEnc),
        accountType: account.accountType === 'SAVINGS' ? 'SAVINGS' : 'CHECKING',
        name: profile.companyName ?? account.label,
        individualId: runId.replace(/-/g, '').slice(0, 15),
        bankAccountId: account.id,
      },
    ],
  });
  const entry = result.entries[0]!;
  if (!entry.accepted) {
    await db.payrollFunding.update({ where: { id: funding.id }, data: { status: 'RETURNED', returnReason: (entry.error ?? 'The bank refused the debit.').slice(0, 300), returnedAt: now } });
    throw new HttpError(502, 'funding_refused', entry.error ?? 'The bank refused the debit.');
  }
  funding = await db.payrollFunding.update({
    where: { id: funding.id },
    data: { status: 'SUBMITTED', submittedAt: now, achEntryId: entry.id, returnCode: null, returnReason: null, returnedAt: null },
  });
  enqueueAudit({ actorUserId: actor.id, action: 'payroll.funding_submitted', entityType: 'PayrollRun', entityId: runId, metadata: { amountCents: amount, accountLast4: account.accountLast4, effectiveDate: funding.debitEffectiveDate.toISOString().slice(0, 10), file: result.file.id } }, 'banking.funding');
  return { funding };
}

registerApplyHandler(
  'PAYROLL_FUNDING_LIMIT',
  async (db, row, decider) => {
    const p = row.proposed as { payrollRunId?: string; profileLimits?: { profileId: string; perRunLimitCents: number | null; perDayLimitCents: number | null } };
    if (p.profileLimits) {
      // Raising or removing a limit is the same two-person decision as going over one.
      await db.payrollBankingProfile.update({
        where: { id: p.profileLimits.profileId },
        data: {
          perRunLimitCents: p.profileLimits.perRunLimitCents == null ? null : BigInt(p.profileLimits.perRunLimitCents),
          perDayLimitCents: p.profileLimits.perDayLimitCents == null ? null : BigInt(p.profileLimits.perDayLimitCents),
        },
      });
      return;
    }
    await submitFunding(db, p.payrollRunId!, { id: decider.id }, { limitApproved: true });
  },
  async (db, row) => {
    const p = row.proposed as { payrollRunId?: string };
    if (!p.payrollRunId) return;
    await db.payrollFunding.updateMany({ where: { payrollRunId: p.payrollRunId, status: 'AWAITING_APPROVAL' }, data: { status: 'DRAFT', approvalRequestId: null, note: 'The limit override was declined.' } });
  },
);

/**
 * A submitted debit counts as settled once its effective date has passed
 * (partners also tell us directly). A return can still arrive for two
 * banking days after; it reopens the funding and holds what hasn't paid.
 */
export async function settleDueFunding(db: Db, now = new Date()): Promise<number> {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const due = await db.payrollFunding.findMany({ where: { tenantId: tenantIdForWrite(), status: 'SUBMITTED', debitEffectiveDate: { lte: today } }, select: { id: true } });
  for (const f of due) await db.payrollFunding.update({ where: { id: f.id }, data: { status: 'SETTLED', settledAt: now } });
  return due.length;
}

/** The employer's debit came back: hold the run's unpaid items and tell Finance how to wire. */
export async function applyFundingReturn(db: PrismaClient, achEntryId: string, code: string, now = new Date()): Promise<PayrollFunding | null> {
  const funding = await db.payrollFunding.findFirst({ where: { tenantId: tenantIdForWrite(), achEntryId } });
  if (!funding) return null;
  const reason = describeBranchFailure(code);
  const updated = await db.payrollFunding.update({ where: { id: funding.id }, data: { status: 'RETURNED', returnCode: /^R\d{2}$/i.test(code.trim()) ? code.trim().toUpperCase() : null, returnReason: reason.slice(0, 300), returnedAt: now } });
  const amount = money(funding.amountCents);
  void notifyFinance({
    subject: `Payroll funding came back (${code}) — ${amount}`,
    body: `The bank returned the payroll debit: ${reason}. No one on this run is paid until the money arrives — wire ${amount} or fix the account and pull again.`,
    linkUrl: `/payroll/banking?tab=funding&run=${funding.payrollRunId}`,
    category: 'finance.payroll_funding',
  }).catch(() => undefined);
  enqueueAudit({ actorUserId: null, action: 'payroll.funding_returned', entityType: 'PayrollRun', entityId: funding.payrollRunId, metadata: { code, amountCents: Number(funding.amountCents) } }, 'banking.funding');
  return updated;
}

/** Finance expects (WIRE_PENDING) or has received (WIRE_RECEIVED) a wire instead of the debit. */
export async function recordWire(db: PrismaClient, runId: string, actorUserId: string, state: 'WIRE_PENDING' | 'WIRE_RECEIVED', note: string, now = new Date()): Promise<PayrollFunding> {
  const funding = await db.payrollFunding.findUnique({ where: { payrollRunId: runId } });
  if (!funding || funding.tenantId !== tenantIdForWrite()) throw new HttpError(404, 'funding_not_found', 'This run has no funding yet.');
  if (['SETTLED', 'WIRE_RECEIVED', 'CANCELLED'].includes(funding.status)) throw new HttpError(409, 'funding_closed', 'This run’s funding is already settled.');
  const updated = await db.payrollFunding.update({
    where: { id: funding.id },
    data: { status: state, note: note.slice(0, 500), ...(state === 'WIRE_RECEIVED' ? { settledAt: now } : {}) },
  });
  enqueueAudit({ actorUserId, action: state === 'WIRE_RECEIVED' ? 'payroll.funding_wire_received' : 'payroll.funding_wire_expected', entityType: 'PayrollRun', entityId: runId, metadata: { note, amountCents: Number(funding.amountCents) } }, 'banking.funding');
  return updated;
}

/**
 * The gate disbursement runs: with our ACH paying bank accounts, the run's
 * money must have settled (or arrived by wire) before anyone is paid.
 */
export async function assertRunFunded(db: Db, runId: string): Promise<void> {
  const profile = await bankingProfile(db);
  if (!usesOurAch(profile)) return;
  const funding = await db.payrollFunding.findUnique({ where: { payrollRunId: runId } });
  if (funding && ['SETTLED', 'WIRE_RECEIVED'].includes(funding.status)) return;
  // A run with no one paid by our ACH (and nothing else we collect) needs no debit.
  if ((!funding || funding.status === 'DRAFT') && (await computeFunding(db, runId, profile)).amountCents === 0) return;
  if (!funding) throw new HttpError(409, 'not_funded', 'Pull this run’s funding first — no one is paid until the employer’s money arrives.');
  const message: Record<string, string> = {
    DRAFT: 'Pull this run’s funding first — no one is paid until the employer’s money arrives.',
    AWAITING_APPROVAL: 'The funding is over a limit and waits for a second person.',
    SUBMITTED: `The funding debit settles on ${funding.debitEffectiveDate.toISOString().slice(0, 10)}; pay goes out after that.`,
    RETURNED: `The funding came back (${funding.returnCode ?? 'returned'}): ${funding.returnReason ?? 'see the funding page'}. Wire the money or pull again.`,
    WIRE_PENDING: 'Waiting for the wire to arrive.',
    CANCELLED: 'The funding was cancelled.',
  };
  throw new HttpError(409, 'not_funded', message[funding.status] ?? 'This run isn’t funded yet.');
}

/**
 * The inbox count (Payroll funding): runs approved for pay whose money
 * hasn't been pulled, debits that came back or wait on a wire, and new
 * operating accounts waiting for their micro-deposit amounts.
 */
export async function payrollFundingNeedingYou(db: Db): Promise<{ count: number; description: string }> {
  const profile = await bankingProfile(db);
  if (!usesOurAch(profile)) return { count: 0, description: 'Payroll isn’t paid through your own ACH.' };
  const tenantId = tenantIdForWrite();
  const [unfunded, trouble, accounts] = await Promise.all([
    db.payrollRun.count({ where: { tenantId, status: 'FINALIZED', NOT: { id: { in: (await db.payrollFunding.findMany({ where: { tenantId, status: { in: ['SUBMITTED', 'SETTLED', 'WIRE_RECEIVED', 'AWAITING_APPROVAL'] } }, select: { payrollRunId: true } })).map((f) => f.payrollRunId) } } } }),
    db.payrollFunding.count({ where: { tenantId, status: { in: ['RETURNED', 'WIRE_PENDING'] } } }),
    db.employerBankAccount.count({ where: { tenantId, status: 'MICRODEPOSITS_SENT' } }),
  ]);
  const parts = [
    unfunded ? `${unfunded} run${unfunded === 1 ? '' : 's'} to fund` : null,
    trouble ? `${trouble} debit${trouble === 1 ? '' : 's'} returned or waiting on a wire` : null,
    accounts ? `${accounts} account${accounts === 1 ? '' : 's'} waiting for deposit amounts` : null,
  ].filter(Boolean);
  return { count: unfunded + trouble + accounts, description: parts.length ? `${parts.join(', ')}.` : 'Every approved run is funded.' };
}
