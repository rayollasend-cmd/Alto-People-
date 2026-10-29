import type { PrismaClient, W4FilingStatus } from '@prisma/client';
import { payScheduleFor } from './associatePayday.js';
import { getCurrentPeriod, getPeriodAfter } from './payrollSchedule.js';
import { computeFederalIncomeTax, type PayFrequency } from './payrollTax.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * W-4 estimator (PAYEXP §5): "am I withholding the right amount?"
 *
 *   The year's federal income tax is estimated from the year's wages here
 *   (paid so far plus what the rest of the year's checks will pay), other
 *   jobs, other income and extra deductions, through the same annual
 *   tables the payroll engine withholds from (standard deduction built in),
 *   less the dependents credits. Against it: what's been withheld so far
 *   plus what each remaining check will withhold under the W-4 being
 *   considered. The difference is the refund or the balance due, and the
 *   Step 4(c) extra per check that lands it near zero.
 *
 *   It is an estimate for withholding, not a tax return: no credits beyond
 *   the dependents ones, no self-employment tax, no state.
 */

/** 2026 Form W-4 Step 3 amounts. */
export const CHILD_CREDIT = 2_200;
export const OTHER_DEPENDENT_CREDIT = 500;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface W4EstimateInput {
  filingStatus: W4FilingStatus;
  payFrequency: PayFrequency;
  /** Taxable gross on a typical check here. */
  payPerPeriod: number;
  /** Checks still to come this year. */
  periodsRemaining: number;
  ytdWages: number;
  ytdFederalWithheld: number;
  /** A second job or a working spouse (filing jointly): their wages for the year, and what they withhold. */
  otherJobsAnnual?: number;
  otherJobsWithheldAnnual?: number;
  /** Interest, dividends, retirement income… for the year. */
  otherIncome?: number;
  /** Deductions above the standard deduction (itemized or adjustments) for the year. */
  deductionsAboveStandard?: number;
  childrenUnder17?: number;
  otherDependents?: number;
  /** The Step 4(c) extra on the W-4 now, per check — for the "as things stand" line. */
  currentExtraPerPeriod?: number;
  /** The W-4 now, for the "as things stand" line; omitted = no W-4 changes considered. */
  current?: { filingStatus: W4FilingStatus; dependentsAmount: number; otherIncome: number; deductions: number; extraWithholding: number } | null;
}

export interface W4Projection {
  perCheck: number;
  yearWithholding: number;
  /** Positive = refund, negative = balance due. */
  refund: number;
}

export interface W4EstimateResult {
  yearWages: number;
  yearIncome: number;
  estimatedTax: number;
  credits: number;
  asIs: W4Projection | null;
  /** The W-4 fields that match the answers, with the extra that lands near zero. */
  suggested: {
    filingStatus: W4FilingStatus;
    multipleJobs: boolean;
    dependentsAmount: number;
    otherIncome: number;
    deductions: number;
    extraWithholding: number;
  };
  withSuggested: W4Projection;
}

/** The annual table tax on a year's income (the engine's tables, standard deduction built in), after credits. */
export function annualFederalTax(input: { filingStatus: W4FilingStatus; income: number; deductions: number; credits: number }): number {
  // Twelve monthly checks of a twelfth each is exactly the annual table.
  const monthly = computeFederalIncomeTax({
    grossPay: Math.max(0, input.income) / 12,
    filingStatus: input.filingStatus,
    payFrequency: 'MONTHLY',
    deductions: input.deductions,
    dependentsAmount: input.credits,
  });
  return round2(monthly * 12);
}

export function estimateW4(input: W4EstimateInput): W4EstimateResult {
  const periods = Math.max(0, Math.floor(input.periodsRemaining));
  const yearWages = round2(Math.max(0, input.ytdWages) + Math.max(0, input.payPerPeriod) * periods);
  const otherJobs = Math.max(0, input.otherJobsAnnual ?? 0);
  const otherIncome = Math.max(0, input.otherIncome ?? 0);
  const deductions = Math.max(0, input.deductionsAboveStandard ?? 0);
  const credits = Math.max(0, Math.floor(input.childrenUnder17 ?? 0)) * CHILD_CREDIT + Math.max(0, Math.floor(input.otherDependents ?? 0)) * OTHER_DEPENDENT_CREDIT;
  const yearIncome = round2(yearWages + otherJobs + otherIncome);
  const estimatedTax = annualFederalTax({ filingStatus: input.filingStatus, income: yearIncome, deductions, credits });
  const otherWithheld = Math.max(0, input.otherJobsWithheldAnnual ?? 0);

  const project = (w4: { filingStatus: W4FilingStatus; dependentsAmount: number; otherIncome: number; deductions: number; extraWithholding: number }): W4Projection => {
    const perCheck = computeFederalIncomeTax({
      grossPay: input.payPerPeriod,
      filingStatus: w4.filingStatus,
      payFrequency: input.payFrequency,
      otherIncome: w4.otherIncome,
      deductions: w4.deductions,
      dependentsAmount: w4.dependentsAmount,
      extraWithholding: w4.extraWithholding,
    });
    const yearWithholding = round2(Math.max(0, input.ytdFederalWithheld) + perCheck * periods + otherWithheld);
    return { perCheck, yearWithholding, refund: round2(yearWithholding - estimatedTax) };
  };

  // Step 4(a) carries the other job and other income on this job's W-4 —
  // the IRS's own way to have one job withhold for both.
  const base = { filingStatus: input.filingStatus, dependentsAmount: credits, otherIncome: round2(otherJobs + otherIncome), deductions, extraWithholding: 0 };
  const noExtra = project(base);
  // Owed at the end of the year → spread over the checks left, rounded up to the dollar.
  // Cents of table rounding are not a balance due.
  const extra = noExtra.refund < -1 && periods > 0 ? Math.ceil(-noExtra.refund / periods) : 0;
  const suggested = { ...base, multipleJobs: false, extraWithholding: extra };
  const withSuggested = project(suggested);
  const asIs = input.current ? project(input.current) : null;
  return { yearWages, yearIncome, estimatedTax, credits, asIs, suggested, withSuggested };
}

/** Checks left this year on the person's schedule (after today). */
export function periodsRemainingThisYear(schedule: { frequency: PayrollFrequencyLike; anchorDate: Date | string; payDateOffsetDays: number }, now: Date): number {
  const todayKey = orgDateKey(now);
  const year = Number(todayKey.slice(0, 4));
  let w = getCurrentPeriod(schedule, now);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    if (w.payDate > `${year}-12-31`) break;
    if (w.payDate > todayKey) n += 1;
    w = getPeriodAfter(schedule, w);
  }
  return n;
}
type PayrollFrequencyLike = Parameters<typeof getCurrentPeriod>[0]['frequency'];

/** What the estimator starts from: the person's own W-4, schedule and checks this year. */
export async function w4EstimatorContext(db: PrismaClient, associateId: string, now: Date = new Date()) {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const [w4, schedule, items] = await Promise.all([
    db.w4Submission.findUnique({ where: { associateId }, select: { filingStatus: true, multipleJobs: true, dependentsAmount: true, otherIncome: true, deductions: true, extraWithholding: true } }),
    payScheduleFor(associateId, { orLikely: true }),
    db.payrollItem.findMany({
      where: { associateId, status: 'DISBURSED', payrollRun: { status: { not: 'CANCELLED' }, disbursedAt: { gte: yearStart } } },
      select: { grossPay: true, preTaxDeductions: true, federalWithholding: true, payrollRun: { select: { kind: true, disbursedAt: true } } },
      orderBy: { payrollRun: { disbursedAt: 'desc' } },
    }),
  ]);
  const freq = schedule?.frequency ?? 'BIWEEKLY';
  const payFrequency: PayFrequency = freq === 'DAILY' ? 'WEEKLY' : freq;
  const ytdWages = round2(items.reduce((s, i) => s + Number(i.grossPay) - Number(i.preTaxDeductions), 0));
  const ytdFederalWithheld = round2(items.reduce((s, i) => s + Number(i.federalWithholding), 0));
  // A typical check: the average of the last three regular checks.
  const regular = items.filter((i) => i.payrollRun.kind === 'REGULAR').slice(0, 3);
  const payPerPeriod = regular.length ? round2(regular.reduce((s, i) => s + Number(i.grossPay) - Number(i.preTaxDeductions), 0) / regular.length) : 0;
  const periodsRemaining = schedule ? periodsRemainingThisYear(schedule, now) : 0;
  return {
    payFrequency,
    payPerPeriod,
    periodsRemaining,
    ytdWages,
    ytdFederalWithheld,
    current: w4
      ? {
          filingStatus: w4.filingStatus,
          multipleJobs: w4.multipleJobs,
          dependentsAmount: Number(w4.dependentsAmount),
          otherIncome: Number(w4.otherIncome),
          deductions: Number(w4.deductions),
          extraWithholding: Number(w4.extraWithholding),
        }
      : null,
  };
}
