import { Prisma, type DailyPayPolicy, type PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { enqueueAudit } from './audit.js';
import { resolveAdapter, type DisbursementResult } from './disbursement.js';
import { recoverEarnedWageAdvances } from './earnedWage.js';
import { resolvePayoutsForPayroll } from './financialChanges.js';
import { payableMs } from './payroll.js';
import type { AggregatorResult, ProjectedItem } from './payrollAggregator.js';
import { computePaycheckTaxes, stateAwaitingReview } from './payrollTax.js';
import { computeYtdWages } from './payrollYtd.js';
import { tenantJob } from './tenantJobs.js';

/**
 * Daily / next-day pay (PAYEXP §1).
 *
 *   Opted-in workers (or everyone on a DAILY pay schedule) are paid each
 *   night for the approved time they worked: one small off-cycle run per
 *   worker per work day (kind DAILY), withheld as a daily paycheck (×260),
 *   minus any earned-wage advance still owed and the tenant's fee (default
 *   $0), sent to the fastest rail the person has (a Branch card loads
 *   instantly; a bank account goes ACH — same-day where the provider offers
 *   it).
 *
 *   The regular weekly/biweekly run still computes the whole period — so
 *   weekly overtime, deductions and garnishments come out right — and then
 *   subtracts, once, exactly what each time entry was already paid
 *   (DailyPaidTimeEntry holds every entry's gross and tax share). A daily
 *   check that never left (held, failed) is voided at that point and the
 *   regular check pays those hours in full. Nothing is paid twice.
 *
 *   Checks: the policy is OFF until Finance asks and a second person
 *   approves (approval kind DAILY_PAY_POLICY) — that standing approval is
 *   the run's sign-off. Each night still runs the per-person checks the
 *   regular disbursement runs: a new pay account Finance hasn't verified
 *   is held, never paid; an unreviewed state isn't guessed at; people with
 *   a wage garnishment, salaried and exempt staff, contractors and anyone
 *   without an hourly pay record wait for the regular check.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const round2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export type DailyPayTiming = 'SAME_DAY' | 'NEXT_DAY';
export type DailyPayEligibility = 'ENROLLED' | 'EVERYONE';

export interface DailyPaySettings {
  timing: DailyPayTiming;
  eligibility: DailyPayEligibility;
  feeCents: number;
  dailyCapCents: number;
}

export const DAILY_PAY_DEFAULTS: DailyPaySettings = { timing: 'NEXT_DAY', eligibility: 'ENROLLED', feeCents: 0, dailyCapCents: 50_000 };

export interface DailyPayPolicyView extends DailyPaySettings {
  status: 'OFF' | 'PENDING' | 'ACTIVE';
  pending: (Partial<DailyPaySettings> & { enable?: boolean }) | null;
  approvalId: string | null;
  approvedAt: string | null;
  lastRunAt: string | null;
}

export async function loadDailyPayPolicy(db: Db = prisma): Promise<DailyPayPolicy | null> {
  return db.dailyPayPolicy.findFirst();
}

export function policyView(row: DailyPayPolicy | null): DailyPayPolicyView {
  if (!row) return { status: 'OFF', ...DAILY_PAY_DEFAULTS, pending: null, approvalId: null, approvedAt: null, lastRunAt: null };
  return {
    status: row.status as DailyPayPolicyView['status'],
    timing: row.timing as DailyPayTiming,
    eligibility: row.eligibility as DailyPayEligibility,
    feeCents: row.feeCents,
    dailyCapCents: row.dailyCapCents,
    pending: (row.pending as DailyPayPolicyView['pending']) ?? null,
    approvalId: row.approvalId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
  };
}

/**
 * Finance asks for a change. Turning daily pay OFF takes effect at once
 * (stopping money is never held back); turning it on or changing the fee,
 * cap, timing or who's eligible waits for a second person.
 */
export async function requestDailyPayChange(
  db: PrismaClient,
  input: { actorUserId: string; enable: boolean; settings: Partial<DailyPaySettings> },
): Promise<{ applied: boolean; approvalId: string | null; policy: DailyPayPolicyView }> {
  const current = await loadDailyPayPolicy(db);
  const row = current ?? (await db.dailyPayPolicy.create({ data: {} }));
  if (!input.enable) {
    const updated = await db.dailyPayPolicy.update({
      where: { id: row.id },
      data: { status: 'OFF', pending: Prisma.DbNull, approvalId: null },
    });
    if (row.approvalId) {
      await db.approvalRequest.updateMany({ where: { id: row.approvalId, status: 'PENDING' }, data: { status: 'CANCELLED' } }).catch(() => undefined);
    }
    enqueueAudit({ actorUserId: input.actorUserId, action: 'payroll.daily_pay.turned_off', entityType: 'DailyPayPolicy', entityId: row.id, metadata: {} }, 'dailyPay.off');
    return { applied: true, approvalId: null, policy: policyView(updated) };
  }
  const next: DailyPaySettings = {
    timing: input.settings.timing ?? (row.timing as DailyPayTiming),
    eligibility: input.settings.eligibility ?? (row.eligibility as DailyPayEligibility),
    feeCents: Math.max(0, Math.round(input.settings.feeCents ?? row.feeCents)),
    dailyCapCents: Math.max(100, Math.round(input.settings.dailyCapCents ?? row.dailyCapCents)),
  };
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const approval = await createApprovalRequest(db, {
    kind: 'DAILY_PAY_POLICY',
    subjectType: 'DailyPayPolicy',
    subjectId: row.id,
    title: row.status === 'ACTIVE' ? 'Change daily pay' : 'Turn on daily pay',
    summary: `${next.timing === 'SAME_DAY' ? 'Same day' : 'Next day'} · ${next.eligibility === 'EVERYONE' ? 'any hourly worker can opt in' : 'people payroll enrolls'} · up to ${money(next.dailyCapCents)} a day · fee ${money(next.feeCents)}`,
    proposed: { policyId: row.id, ...next },
    before: { status: row.status, timing: row.timing, eligibility: row.eligibility, feeCents: row.feeCents, dailyCapCents: row.dailyCapCents },
    requesterUserId: input.actorUserId,
    approver: { capability: 'process:payroll' },
  });
  const updated = await db.dailyPayPolicy.update({
    where: { id: row.id },
    data: {
      status: row.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING',
      pending: { ...next, enable: true } as unknown as Prisma.InputJsonValue,
      approvalId: approval.id,
      requestedById: input.actorUserId,
    },
  });
  return { applied: false, approvalId: approval.id, policy: policyView(updated) };
}

registerApplyHandler(
  'DAILY_PAY_POLICY',
  async (db, row, decider) => {
    const p = row.proposed as unknown as { policyId: string } & DailyPaySettings;
    await db.dailyPayPolicy.update({
      where: { id: p.policyId },
      data: {
        status: 'ACTIVE',
        timing: p.timing,
        eligibility: p.eligibility,
        feeCents: p.feeCents,
        dailyCapCents: p.dailyCapCents,
        pending: Prisma.DbNull,
        approvalId: null,
        approvedById: decider.id,
        approvedAt: new Date(),
      },
    });
  },
  async (db, row) => {
    const p = row.proposed as { policyId: string };
    const policy = await db.dailyPayPolicy.findUnique({ where: { id: p.policyId } });
    if (!policy) return;
    await db.dailyPayPolicy.update({
      where: { id: policy.id },
      data: { pending: Prisma.DbNull, approvalId: null, status: policy.status === 'PENDING' ? 'OFF' : policy.status },
    });
  },
);

/* ---- Who is paid daily ------------------------------------------------------ */

export async function setDailyPayEnrollment(db: Db, input: { associateId: string; enrolled: boolean; actorUserId: string | null }): Promise<void> {
  if (input.enrolled) {
    await db.dailyPayEnrollment.upsert({
      where: { associateId: input.associateId },
      create: { associateId: input.associateId, enrolledById: input.actorUserId },
      update: { endedAt: null, enrolledById: input.actorUserId, enrolledAt: new Date() },
    });
  } else {
    await db.dailyPayEnrollment.updateMany({ where: { associateId: input.associateId, endedAt: null }, data: { endedAt: new Date() } });
  }
  enqueueAudit(
    { actorUserId: input.actorUserId, action: input.enrolled ? 'payroll.daily_pay.enrolled' : 'payroll.daily_pay.unenrolled', entityType: 'Associate', entityId: input.associateId, metadata: {} },
    'dailyPay.enroll',
  );
}

/**
 * Everyone the nightly job pays: the people enrolled (by payroll, or by
 * themselves when eligibility is EVERYONE) and everyone on a DAILY pay
 * schedule. Eligibility decides who may opt in, never who is paid
 * without asking.
 */
export async function dailyPayCandidates(db: Db, _eligibility: DailyPayEligibility): Promise<Set<string> | 'ALL'> {
  const [enrolled, scheduled] = await Promise.all([
    db.dailyPayEnrollment.findMany({ where: { endedAt: null }, select: { associateId: true } }),
    db.associate.findMany({ where: { deletedAt: null, payrollSchedule: { frequency: 'DAILY' } }, select: { id: true } }),
  ]);
  return new Set([...enrolled.map((e) => e.associateId), ...scheduled.map((a) => a.id)]);
}

/* ---- The nightly settlement ---------------------------------------------------- */

export type DailySkipReason =
  | 'NO_HOURLY_RATE'
  | 'SALARIED_OR_EXEMPT'
  | 'CONTRACTOR'
  | 'GARNISHMENT'
  | 'STATE_UNDER_REVIEW'
  | 'OVER_DAILY_CAP'
  | 'REGULAR_RUN_EXISTS';

export interface DailyPayRunSummary {
  ran: boolean;
  reason?: 'OFF' | 'NOT_YET';
  cutoff: string;
  paid: Array<{ associateId: string; workDate: string; runId: string; itemId: string; gross: number; net: number; status: string }>;
  held: Array<{ associateId: string; workDate: string; reason: string }>;
  skipped: Array<{ associateId: string; reason: DailySkipReason }>;
}

/** The instant the night's work ends: midnight for next-day pay, now for same-day. */
export function dailyCutoff(timing: DailyPayTiming, now: Date): Date {
  return timing === 'SAME_DAY' ? now : dayStart(now);
}

interface EntryRow {
  id: string;
  associateId: string;
  clientId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  status: string;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
  location: { state: string | null; timezone: string } | null;
}

/**
 * Build and pay tonight's daily settlements. Idempotent: an entry already
 * settled (or inside a regular run) is never picked up again.
 */
export async function runDailyPay(opts: { now?: Date; actorUserId?: string | null; force?: boolean } = {}): Promise<DailyPayRunSummary> {
  const now = opts.now ?? new Date();
  const policy = await loadDailyPayPolicy(prisma);
  const settings: DailyPaySettings = policy
    ? { timing: policy.timing as DailyPayTiming, eligibility: policy.eligibility as DailyPayEligibility, feeCents: policy.feeCents, dailyCapCents: policy.dailyCapCents }
    : DAILY_PAY_DEFAULTS;
  const cutoff = dailyCutoff(settings.timing, now);
  const summary: DailyPayRunSummary = { ran: false, cutoff: cutoff.toISOString(), paid: [], held: [], skipped: [] };
  if (!policy || policy.status !== 'ACTIVE') return { ...summary, reason: 'OFF' };

  const candidates = await dailyPayCandidates(prisma, settings.eligibility);
  if (candidates !== 'ALL' && candidates.size === 0) {
    await prisma.dailyPayPolicy.update({ where: { id: policy.id }, data: { lastRunAt: now } });
    return { ...summary, ran: true };
  }

  // Approved, closed time from the last 14 days not yet paid ahead.
  const lookback = new Date(dayStart(now).getTime() - 14 * 86_400_000);
  const entries: EntryRow[] = await prisma.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockOutAt: { not: null, lte: cutoff },
      clockInAt: { gte: lookback },
      dailyPaid: null,
      ...(candidates === 'ALL' ? {} : { associateId: { in: [...candidates] } }),
      associate: { deletedAt: null, employmentType: 'W2_EMPLOYEE' },
    },
    select: {
      id: true,
      associateId: true,
      clientId: true,
      clockInAt: true,
      clockOutAt: true,
      status: true,
      breaks: { select: { startedAt: true, endedAt: true } },
      location: { select: { state: true, timezone: true } },
    },
    orderBy: { clockInAt: 'asc' },
  });
  if (entries.length === 0) {
    await prisma.dailyPayPolicy.update({ where: { id: policy.id }, data: { lastRunAt: now } });
    return { ...summary, ran: true };
  }

  const associateIds = [...new Set(entries.map((e) => e.associateId))];
  const [associates, comps, garnished, regularRuns] = await Promise.all([
    prisma.associate.findMany({
      where: { id: { in: associateIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        addressLine1: true,
        city: true,
        state: true,
        zip: true,
        employmentType: true,
        jobProfile: { select: { isExempt: true } },
        localTaxRule: { select: { rate: true, isActive: true } },
        stateW4s: { select: { state: true, filingStatus: true, allowances: true, dependents: true, exempt: true, county: true } },
        w4Submission: { select: { filingStatus: true, deductions: true, otherIncome: true, dependentsAmount: true } },
      },
    }),
    prisma.compensationRecord.findMany({
      where: { associateId: { in: associateIds }, effectiveTo: null, effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: 'desc' },
      select: { associateId: true, payType: true, amount: true },
    }),
    prisma.garnishment.findMany({ where: { associateId: { in: associateIds }, status: 'ACTIVE' }, select: { associateId: true } }),
    prisma.payrollRun.findMany({
      where: { kind: { in: ['REGULAR', 'AMENDMENT'] }, status: { not: 'CANCELLED' }, periodEnd: { gte: lookback } },
      select: { clientId: true, periodStart: true, periodEnd: true },
    }),
  ]);
  const byId = new Map(associates.map((a) => [a.id, a]));
  const compBy = new Map<string, { payType: string; amount: number }>();
  for (const c of comps) if (!compBy.has(c.associateId)) compBy.set(c.associateId, { payType: c.payType, amount: Number(c.amount) });
  const garnishedSet = new Set(garnished.map((g) => g.associateId));
  const inRegularRun = (e: EntryRow) => {
    const d = dayStart(e.clockInAt).getTime();
    return regularRuns.some((r) => (r.clientId === null || r.clientId === e.clientId) && r.periodStart.getTime() <= d && d <= r.periodEnd.getTime());
  };

  const adapter = await resolveAdapter();
  const payouts = await resolvePayoutsForPayroll(prisma, associateIds);
  const cap = settings.dailyCapCents / 100;
  const fee = settings.feeCents / 100;
  const skip = (associateId: string, reason: DailySkipReason) => {
    if (!summary.skipped.some((s) => s.associateId === associateId && s.reason === reason)) summary.skipped.push({ associateId, reason });
  };

  // Group by person and work day.
  const groups = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const key = `${e.associateId}|${ymd(e.clockInAt)}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }

  for (const [key, group] of groups) {
    const [associateId, workDay] = key.split('|') as [string, string];
    const a = byId.get(associateId);
    if (!a) continue;
    const comp = compBy.get(associateId);
    if (a.employmentType !== 'W2_EMPLOYEE') { skip(associateId, 'CONTRACTOR'); continue; }
    if (a.jobProfile?.isExempt || comp?.payType === 'SALARY') { skip(associateId, 'SALARIED_OR_EXEMPT'); continue; }
    if (!comp || comp.payType !== 'HOURLY' || !(comp.amount > 0)) { skip(associateId, 'NO_HOURLY_RATE'); continue; }
    if (garnishedSet.has(associateId)) { skip(associateId, 'GARNISHMENT'); continue; }
    const state = (group[0].location?.state ?? a.state ?? null)?.toUpperCase() ?? null;
    if (stateAwaitingReview(state)) { skip(associateId, 'STATE_UNDER_REVIEW'); continue; }

    const workDate = new Date(`${workDay}T00:00:00.000Z`);
    const already = await prisma.dailyPaidTimeEntry.aggregate({ where: { associateId, workDate }, _sum: { gross: true } });
    let room = round2(cap - Number(already._sum.gross ?? 0));
    const rate = comp.amount;
    const chosen: Array<{ entry: EntryRow; hours: number; gross: number }> = [];
    for (const e of group) {
      if (inRegularRun(e)) { skip(associateId, 'REGULAR_RUN_EXISTS'); continue; }
      const hours = round2(payableMs(e) / 3_600_000);
      const gross = round2(hours * rate);
      if (gross <= 0) continue;
      if (gross > room) { skip(associateId, 'OVER_DAILY_CAP'); continue; }
      room = round2(room - gross);
      chosen.push({ entry: e, hours, gross });
    }
    if (chosen.length === 0) continue;

    const gross = round2(chosen.reduce((s, c) => s + c.gross, 0));
    const hours = round2(chosen.reduce((s, c) => s + c.hours, 0));
    const yearStart = new Date(Date.UTC(workDate.getUTCFullYear(), 0, 1));
    const ytd = await computeYtdWages(prisma, associateId, yearStart, workDate);
    const w4 = a.w4Submission;
    const sw = state ? a.stateW4s.find((s) => s.state === state) : undefined;
    // The person's W-4 extra withholding rides on the regular check (the
    // true-up), not on each daily one — five extras a week would over-withhold.
    const taxes = computePaycheckTaxes({
      grossPay: gross,
      filingStatus: w4?.filingStatus ?? null,
      payFrequency: 'DAILY',
      state,
      ytdWages: ytd,
      ytdMedicareWages: ytd,
      extraWithholding: 0,
      deductions: w4?.deductions ? Number(w4.deductions) : 0,
      otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
      dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
      stateW4: sw ? { filingStatus: sw.filingStatus, allowances: sw.allowances, dependents: sw.dependents, additionalWithholding: 0, exempt: sw.exempt, county: sw.county } : null,
    });
    const local = a.localTaxRule?.isActive ? round2(gross * Number(a.localTaxRule.rate)) : 0;
    const netBeforeFee = round2(gross - taxes.federalIncomeTax - taxes.socialSecurity - taxes.medicare - taxes.stateIncomeTax - local);
    const feeTaken = round2(Math.min(fee, Math.max(0, netBeforeFee)));

    // One small off-cycle run per worker per work day.
    const { run, item } = await prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.create({
        data: {
          kind: 'DAILY',
          clientId: null,
          periodStart: workDate,
          periodEnd: workDate,
          status: 'DRAFT',
          notes: `Daily pay for ${workDay}`,
          createdById: opts.actorUserId ?? null,
        },
      });
      const item = await tx.payrollItem.create({
        data: {
          payrollRunId: run.id,
          associateId,
          hoursWorked: hours,
          hourlyRate: rate,
          grossPay: gross,
          federalWithholding: taxes.federalIncomeTax,
          fica: taxes.socialSecurity,
          medicare: taxes.medicare,
          stateWithholding: taxes.stateIncomeTax,
          localWithholding: local,
          taxState: state,
          employerFica: taxes.employer.fica,
          employerMedicare: taxes.employer.medicare,
          employerFuta: taxes.employer.futa,
          employerSuta: taxes.employer.suta,
          ytdWages: ytd,
          ytdMedicareWages: ytd,
          postTaxDeductions: feeTaken,
          netPay: round2(netBeforeFee - feeTaken),
          status: 'PENDING',
        },
      });
      await tx.payrollItemEarning.create({
        data: { payrollItemId: item.id, kind: 'REGULAR', hours, rate, amount: gross, isTaxable: true, notes: feeTaken > 0 ? `Paid daily · fee $${feeTaken.toFixed(2)}` : 'Paid daily' },
      });
      // Each entry's share of the taxes (the last one takes the rounding),
      // so the regular check can subtract exactly what was paid.
      const parts = { federal: taxes.federalIncomeTax, fica: taxes.socialSecurity, medicare: taxes.medicare, state: taxes.stateIncomeTax, local, employerFica: taxes.employer.fica, employerMedicare: taxes.employer.medicare, employerFuta: taxes.employer.futa, employerSuta: taxes.employer.suta };
      const used: Record<keyof typeof parts, number> = { federal: 0, fica: 0, medicare: 0, state: 0, local: 0, employerFica: 0, employerMedicare: 0, employerFuta: 0, employerSuta: 0 };
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i];
        const last = i === chosen.length - 1;
        const share = (k: keyof typeof parts) => {
          const v = last ? round2(parts[k] - used[k]) : round2((parts[k] * c.gross) / gross);
          used[k] = round2(used[k] + v);
          return v;
        };
        const row = { federal: share('federal'), fica: share('fica'), medicare: share('medicare'), state: share('state'), local: share('local'), employerFica: share('employerFica'), employerMedicare: share('employerMedicare'), employerFuta: share('employerFuta'), employerSuta: share('employerSuta') };
        await tx.dailyPaidTimeEntry.create({
          data: {
            timeEntryId: c.entry.id,
            payrollItemId: item.id,
            associateId,
            workDate,
            hours: c.hours,
            gross: c.gross,
            ...row,
            net: round2(c.gross - row.federal - row.fica - row.medicare - row.state - row.local),
          },
        });
      }
      // Earned-wage advances still owed come out first (never below $0).
      const ewa = await recoverEarnedWageAdvances(tx, { associateId, availableNet: Number(item.netPay), payrollRunId: run.id, payrollItemId: item.id, now });
      const finalItem = ewa.totalApplied > 0
        ? await tx.payrollItem.update({
            where: { id: item.id },
            data: { postTaxDeductions: round2(feeTaken + ewa.totalApplied), netPay: round2(Number(item.netPay) - ewa.totalApplied) },
          })
        : item;
      // The standing approval is the run's sign-off.
      const finalized = await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'FINALIZED',
          finalizedAt: now,
          approvedById: policy.approvedById,
          approvedAt: now,
          totalGross: gross,
          totalTax: round2(taxes.totalEmployeeTax + local),
          totalNet: finalItem.netPay,
          totalEmployerTax: round2(taxes.employer.fica + taxes.employer.medicare + taxes.employer.futa + taxes.employer.suta),
        },
      });
      return { run: finalized, item: finalItem };
    });

    // Pay it: verified accounts only, fastest rail first.
    const net = Number(item.netPay);
    const resolution = payouts.get(associateId) ?? { method: null, decision: 'none' as const, changeId: null, pendingMethod: null };
    let status: 'DISBURSED' | 'PENDING' | 'HELD';
    let failure: string | null = null;
    let result: DisbursementResult | null = null;
    if (net <= 0) {
      // An advance took the whole check: settled in Alto, nothing to send.
      status = 'DISBURSED';
    } else if (resolution.decision === 'hold') {
      status = 'HELD';
      failure = 'unverified_payout_change: Finance has not verified the new pay account';
    } else {
      const { recipientFromPayoutMethod } = await import('../routes/payroll.js');
      const input = {
        amount: net,
        currency: 'USD',
        recipient: recipientFromPayoutMethod(a, resolution.method),
        idempotencyKey: item.id,
        memo: `Daily pay ${workDay}`,
        speed: 'INSTANT' as const,
      };
      result = await adapter.disburse(input).catch((err: unknown) => ({ provider: adapter.provider, externalRef: '', status: 'FAILED' as const, failureReason: err instanceof Error ? err.message : String(err) }));
      if (result.status === 'FAILED' && env.PAYROLL_CHECK_FALLBACK && adapter.provider !== 'CHECK' && (result.failureReason ?? '').startsWith('no_payout_rail')) {
        // No card and no account: daily pay waits for the regular check
        // rather than printing a paper check every night.
        result = { ...result, failureReason: 'no_payout_rail: daily pay needs a card or bank account' };
      }
      if (result.status === 'SUCCESS') status = 'DISBURSED';
      else if (result.status === 'PENDING') status = 'PENDING';
      else { status = 'HELD'; failure = result.failureReason ?? 'unknown'; }
    }
    await prisma.payrollDisbursementAttempt.create({
      data: {
        payrollItemId: item.id,
        provider: result?.provider ?? (net <= 0 ? 'NETTED' : adapter.provider),
        status: status === 'DISBURSED' ? 'SUCCESS' : status === 'PENDING' ? 'PENDING' : 'FAILED',
        externalRef: result?.externalRef || null,
        failureReason: failure,
        attemptedById: opts.actorUserId ?? null,
      },
    });
    await prisma.payrollItem.update({
      where: { id: item.id },
      data: {
        status,
        failureReason: failure,
        ...(status === 'DISBURSED' ? { disbursedAt: now, disbursementRef: result?.externalRef || (net <= 0 ? 'NETTED' : null) } : {}),
      },
    });
    if (status === 'DISBURSED') {
      await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'DISBURSED', disbursedAt: now } });
      void (async () => {
        const [{ accrueDepositsForRun }, { postLiabilitiesForRun }] = await Promise.all([import('./taxDeposits.js'), import('./payrollTaxLedger.js')]);
        await accrueDepositsForRun(prisma, run.id);
        await postLiabilitiesForRun(prisma, run.id);
      })().catch((err) => console.warn('[dailyPay] liability accrual failed (advisory):', err));
    }
    if (status === 'HELD') summary.held.push({ associateId, workDate: workDay, reason: failure ?? 'held' });
    summary.paid.push({ associateId, workDate: workDay, runId: run.id, itemId: item.id, gross, net, status });
    enqueueAudit(
      { actorUserId: opts.actorUserId ?? null, action: 'payroll.daily_pay.settled', entityType: 'PayrollRun', entityId: run.id, metadata: { associateId, workDate: workDay, gross, net, status, fee: feeTaken } },
      'dailyPay.settle',
    );
  }

  await prisma.dailyPayPolicy.update({ where: { id: policy.id }, data: { lastRunAt: now } });
  return { ...summary, ran: true };
}

/* ---- The regular run's true-up ---------------------------------------------------- */

export interface DailySettledTotals {
  hours: number;
  gross: number;
  federal: number;
  fica: number;
  medicare: number;
  state: number;
  local: number;
  employerFica: number;
  employerMedicare: number;
  employerFuta: number;
  employerSuta: number;
  days: number;
  linkIds: string[];
}

/**
 * Subtract what the period's daily checks already paid from each projected
 * item, in place. The regular run computed the whole period (weekly
 * overtime, deductions, the person's W-4 extra); what's left is the
 * true-up. With `persist`, daily checks that never left are voided first
 * (their hours are paid here in full) and the counted settlements are
 * stamped with the run so no other run subtracts them again.
 *
 * Returns the shortfall per person when deductions on the true-up exceed
 * what is left — the caller carries it to the next check.
 */
export async function reconcileDailySettlements(
  tx: Db,
  projection: AggregatorResult,
  input: { runId: string | null; periodStart: Date; periodEndExclusive: Date; clientId: string | null; persist: boolean },
): Promise<{ reconciled: number; shortfalls: Map<string, number> }> {
  const shortfalls = new Map<string, number>();
  const associateIds = projection.items.map((i) => i.associateId);
  if (associateIds.length === 0) return { reconciled: 0, shortfalls };

  if (input.persist && input.runId) {
    await tx.dailyPaidTimeEntry.updateMany({ where: { reconciledRunId: input.runId }, data: { reconciledRunId: null } });
  }
  const links = await tx.dailyPaidTimeEntry.findMany({
    where: {
      associateId: { in: associateIds },
      OR: [{ reconciledRunId: null }, ...(input.runId ? [{ reconciledRunId: input.runId }] : [])],
      timeEntry: {
        clockInAt: { gte: input.periodStart, lt: input.periodEndExclusive },
        ...(input.clientId ? { clientId: input.clientId } : {}),
      },
    },
    include: { payrollItem: { select: { id: true, status: true, payrollRunId: true, payrollRun: { select: { status: true } } } } },
  });
  if (links.length === 0) return { reconciled: 0, shortfalls };

  // Counted: paid, or sent and in flight. Anything else never reached the
  // person — the regular check pays those hours.
  const counted = links.filter((l) => l.payrollItem.status === 'DISBURSED' || (l.payrollItem.status === 'PENDING' && l.payrollItem.payrollRun.status === 'FINALIZED'));
  const dropped = links.filter((l) => !counted.includes(l));
  if (input.persist && dropped.length > 0) {
    const itemIds = [...new Set(dropped.map((l) => l.payrollItem.id))];
    const runIds = [...new Set(dropped.map((l) => l.payrollItem.payrollRunId))];
    const now = new Date();
    for (const runId of runIds) {
      const { releaseEarnedWageRecoveryForRun } = await import('./earnedWage.js');
      await releaseEarnedWageRecoveryForRun(tx, runId);
    }
    await tx.dailyPaidTimeEntry.deleteMany({ where: { id: { in: dropped.map((l) => l.id) } } });
    await tx.payrollItem.updateMany({ where: { id: { in: itemIds } }, data: { status: 'VOIDED', voidedAt: now, failureReason: 'Paid on the regular check instead' } });
    await tx.payrollRun.updateMany({
      where: { id: { in: runIds }, kind: 'DAILY' },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Daily check never left; paid on the regular check' },
    });
  }

  const totals = new Map<string, DailySettledTotals>();
  for (const l of counted) {
    const t = totals.get(l.associateId) ?? { hours: 0, gross: 0, federal: 0, fica: 0, medicare: 0, state: 0, local: 0, employerFica: 0, employerMedicare: 0, employerFuta: 0, employerSuta: 0, days: 0, linkIds: [] };
    t.hours += Number(l.hours);
    t.gross += Number(l.gross);
    t.federal += Number(l.federal);
    t.fica += Number(l.fica);
    t.medicare += Number(l.medicare);
    t.state += Number(l.state);
    t.local += Number(l.local);
    t.employerFica += Number(l.employerFica);
    t.employerMedicare += Number(l.employerMedicare);
    t.employerFuta += Number(l.employerFuta);
    t.employerSuta += Number(l.employerSuta);
    t.linkIds.push(l.id);
    totals.set(l.associateId, t);
  }
  for (const [id, t] of totals) {
    t.days = new Set(counted.filter((l) => l.associateId === id).map((l) => ymd(l.workDate))).size;
  }

  for (const p of projection.items) {
    const t = totals.get(p.associateId);
    if (!t) continue;
    applySettled(p, t, shortfalls);
  }
  // Totals follow the items.
  projection.totals = {
    ...projection.totals,
    totalGross: round2(projection.items.reduce((s, i) => s + i.grossPay, 0)),
    totalEmployeeTax: round2(projection.items.reduce((s, i) => s + i.federalIncomeTax + i.fica + i.medicare + i.stateIncomeTax + i.localIncomeTax, 0)),
    totalNet: round2(projection.items.reduce((s, i) => s + i.netPay, 0)),
    totalEmployerTax: round2(projection.items.reduce((s, i) => s + i.employerFica + i.employerMedicare + i.employerFuta + i.employerSuta + (i.employerLocalTax ?? 0), 0)),
  };

  if (input.persist && input.runId) {
    const ids = [...totals.values()].flatMap((t) => t.linkIds);
    if (ids.length > 0) await tx.dailyPaidTimeEntry.updateMany({ where: { id: { in: ids } }, data: { reconciledRunId: input.runId } });
  }
  return { reconciled: totals.size, shortfalls };
}

/** One item's true-up: the whole period minus what was paid ahead. Exported for tests. */
export function applySettled(p: ProjectedItem, t: DailySettledTotals, shortfalls: Map<string, number>): void {
  const settledGross = round2(t.gross);
  const oldTax = { federal: p.federalIncomeTax, fica: p.fica, medicare: p.medicare, state: p.stateIncomeTax, local: p.localIncomeTax };
  p.grossPay = round2(p.grossPay - settledGross);
  p.hoursWorked = round2(Math.max(0, p.hoursWorked - t.hours));
  p.earnings.push({
    kind: 'DAILY_SETTLED',
    hours: null,
    rate: null,
    amount: -settledGross,
    isTaxable: true,
    note: `Paid daily (${t.days} ${t.days === 1 ? 'day' : 'days'})`,
  });
  // Taxes: the period's truth minus what the daily checks withheld. A
  // daily check can withhold a little more than its share of the week
  // (the ×260 table is coarse); the true-up never withholds below $0.
  p.federalIncomeTax = round2(Math.max(0, p.federalIncomeTax - t.federal));
  p.fica = round2(Math.max(0, p.fica - t.fica));
  p.medicare = round2(Math.max(0, p.medicare - t.medicare));
  p.stateIncomeTax = round2(Math.max(0, p.stateIncomeTax - t.state));
  p.localIncomeTax = round2(Math.max(0, p.localIncomeTax - t.local));
  p.employerFica = round2(Math.max(0, p.employerFica - t.employerFica));
  p.employerMedicare = round2(Math.max(0, p.employerMedicare - t.employerMedicare));
  p.employerFuta = round2(Math.max(0, p.employerFuta - t.employerFuta));
  p.employerSuta = round2(Math.max(0, p.employerSuta - t.employerSuta));
  const taxDrop =
    oldTax.federal - p.federalIncomeTax + (oldTax.fica - p.fica) + (oldTax.medicare - p.medicare) + (oldTax.state - p.stateIncomeTax) + (oldTax.local - p.localIncomeTax);
  p.disposableEarnings = round2(Math.max(0, p.disposableEarnings - settledGross + taxDrop));
  // Jurisdiction lines scale with what is left of each tax.
  const scale = (oldV: number, newV: number) => (oldV > 0 ? newV / oldV : 0);
  const sState = scale(oldTax.state, p.stateIncomeTax);
  const sLocal = scale(oldTax.local, p.localIncomeTax);
  p.taxLines = p.taxLines.map((l) => {
    if (l.employer || l.kind === 'SUI' || l.kind === 'EMPLOYER') return l;
    const s = l.kind === 'STATE' ? sState : sLocal;
    return { ...l, amount: round2(l.amount * s) };
  });
  let net = round2(p.netPay - settledGross + taxDrop);
  if (net < 0) {
    // Deductions the true-up can't carry: the caller queues them for the next check.
    shortfalls.set(p.associateId, round2(-net));
    net = 0;
  }
  p.netPay = net;
}

/** A regular run going away (deleted, voided, re-aggregated) gives its settlements back. */
export async function releaseDailyReconciliation(tx: Db, runId: string): Promise<void> {
  await tx.dailyPaidTimeEntry.updateMany({ where: { reconciledRunId: runId }, data: { reconciledRunId: null } });
}

/** What a person was paid ahead in a window — for the paystub and the pay preview. */
export async function dailyPaidInWindow(db: Db, associateId: string, from: Date, toExclusive: Date): Promise<{ gross: number; net: number; days: number }> {
  const rows = await db.dailyPaidTimeEntry.findMany({
    where: { associateId, workDate: { gte: from, lt: toExclusive }, payrollItem: { status: { in: ['DISBURSED', 'PENDING'] } } },
    select: { gross: true, net: true, workDate: true },
  });
  return {
    gross: round2(rows.reduce((s, r) => s + Number(r.gross), 0)),
    net: round2(rows.reduce((s, r) => s + Number(r.net), 0)),
    days: new Set(rows.map((r) => ymd(r.workDate))).size,
  };
}

/* ---- The nightly timer ---------------------------------------------------------- */

let timer: NodeJS.Timeout | null = null;

/** Should tonight's job run now? Next-day pay runs after 6am UTC, same-day after 10pm UTC — once a day. */
export function dueToRun(policy: Pick<DailyPayPolicy, 'status' | 'timing' | 'lastRunAt'>, now: Date): boolean {
  if (policy.status !== 'ACTIVE') return false;
  const hour = now.getUTCHours();
  const startHour = policy.timing === 'SAME_DAY' ? 22 : 6;
  if (hour < startHour) return false;
  return !policy.lastRunAt || ymd(policy.lastRunAt) !== ymd(now) || policy.lastRunAt.getUTCHours() < startHour;
}

export function startDailyPayCron(): void {
  if (timer) return;
  if (env.NODE_ENV === 'test') return;
  const tick = () => {
    void tenantJob('dailyPay', async () => {
      const policy = await loadDailyPayPolicy(prisma);
      if (policy && dueToRun(policy, new Date())) await runDailyPay();
    })().catch((err) => console.error('[alto-people/api] daily pay failed:', err));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref();
}

