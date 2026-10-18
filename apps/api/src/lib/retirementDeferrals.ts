import type { BenefitsPlanKind, Prisma, PrismaClient } from '@prisma/client';
import { findInChunks } from './chunkedIn.js';
import { ageAtYearEnd, catchUpAllowance, isRothCatchUpHigherEarner, limitsFor, splitDeferral } from './contributionLimits.js';

/**
 * Benefit deductions for one check, with the annual limits enforced and the
 * SECURE 2.0 Roth catch-up rule applied — shared by the pay calculation
 * (payrollAggregator) and the pre-run checks (payrollExceptions), so both
 * reach the same answer.
 *
 *   401(k)/403(b)  the election is split into the part within 402(g), the
 *                  catch-up past it (50+ by year end; the larger amount at
 *                  60–63) and what the annual limit stops. A Roth election
 *                  is taken after tax. A higher earner's catch-up (prior-year
 *                  FICA wages over the indexed threshold) is Roth whatever
 *                  the election — automatically where the plan allows a
 *                  deemed Roth election or the person elected Roth;
 *                  otherwise the catch-up stops and the pre-run checks say so.
 *   HSA / FSA      capped at the year's limit (HSA at the family limit — the
 *                  enrollment does not record the tier — plus $1,000 at 55+).
 *   Other §125     medical, dental, vision, life, disability: pre-tax, uncapped.
 *   Trump account  an employer contribution (W-2 Box 12 TA); nothing is
 *                  withheld from the worker.
 *
 * Year-to-date amounts come from the checks already paid this calendar year
 * (PayrollItem.deferrals; a check from before this existed counts its
 * preTaxRetirement as 401(k)).
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export interface DeferralRecord {
  pre401k: number;
  pre403b: number;
  roth401k: number;
  roth403b: number;
  /** Of the retirement deferrals above, the part past 402(g). */
  catchUp: number;
  /** Of catchUp, the part taken as Roth. */
  catchUpRoth: number;
  hsa: number;
  fsa: number;
  dcap: number;
  /** Elected but not taken: an annual limit was reached. */
  limitStopped: number;
  /** A higher earner's catch-up stopped because the plan has no deemed Roth. */
  catchUpStoppedNoRoth: number;
  highEarner: boolean;
  /** Employer contributions to a Trump account (Box 12 TA) this check. */
  trumpAccountEmployer: number;
}

export interface CheckDeductions {
  /** Every pre-tax deduction (reduces the FIT base). */
  preTax: number;
  /** Of preTax, traditional retirement (FIT-only — not the FICA base). */
  preTaxRetirement: number;
  /** Roth deferrals, taken after tax. */
  roth: number;
  deferrals: DeferralRecord;
}

export interface EnrollmentFacts {
  electedAmountCentsPerPeriod: number;
  rothElection: boolean;
  plan: { kind: BenefitsPlanKind; allowsDeemedRoth: boolean; employerContributionCentsPerPeriod: number };
}

/** A person's Roth catch-up position for a year — the person record and the compliance page. */
export type RothCatchUpStatus = 'NOT_ELIGIBLE' | 'AGE_UNKNOWN' | 'PRE_TAX_OR_ROTH' | 'ROTH_BY_ELECTION' | 'ROTH_DEEMED' | 'CATCH_UP_STOPPED';

export function rothCatchUpStatus(input: { dob: Date | null; priorYearFicaWages: number; year: number; rothElection: boolean; allowsDeemedRoth: boolean }): { status: RothCatchUpStatus; highEarner: boolean; age: number | null; catchUpAllowance: number } {
  const age = ageAtYearEnd(input.dob, input.year);
  const allowance = catchUpAllowance(input.dob, input.year);
  const highEarner = isRothCatchUpHigherEarner(input.priorYearFicaWages, input.year);
  if (age === null) return { status: 'AGE_UNKNOWN', highEarner, age, catchUpAllowance: 0 };
  if (allowance === 0) return { status: 'NOT_ELIGIBLE', highEarner, age, catchUpAllowance: 0 };
  if (!highEarner) return { status: 'PRE_TAX_OR_ROTH', highEarner, age, catchUpAllowance: allowance };
  if (input.rothElection) return { status: 'ROTH_BY_ELECTION', highEarner, age, catchUpAllowance: allowance };
  return { status: input.allowsDeemedRoth ? 'ROTH_DEEMED' : 'CATCH_UP_STOPPED', highEarner, age, catchUpAllowance: allowance };
}

export interface PersonDeferralContext {
  dob: Date | null;
  ytd: DeferralRecord;
  priorYearFicaWages: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function emptyDeferrals(): DeferralRecord {
  return { pre401k: 0, pre403b: 0, roth401k: 0, roth403b: 0, catchUp: 0, catchUpRoth: 0, hsa: 0, fsa: 0, dcap: 0, limitStopped: 0, catchUpStoppedNoRoth: 0, highEarner: false, trumpAccountEmployer: 0 };
}

export function readDeferrals(raw: unknown, legacyPreTaxRetirement = 0): DeferralRecord {
  const base = emptyDeferrals();
  if (!raw || typeof raw !== 'object') return { ...base, pre401k: legacyPreTaxRetirement };
  const o = raw as Record<string, unknown>;
  const num = (k: keyof DeferralRecord) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  return {
    pre401k: num('pre401k'),
    pre403b: num('pre403b'),
    roth401k: num('roth401k'),
    roth403b: num('roth403b'),
    catchUp: num('catchUp'),
    catchUpRoth: num('catchUpRoth'),
    hsa: num('hsa'),
    fsa: num('fsa'),
    dcap: num('dcap'),
    limitStopped: num('limitStopped'),
    catchUpStoppedNoRoth: num('catchUpStoppedNoRoth'),
    highEarner: o.highEarner === true,
    trumpAccountEmployer: num('trumpAccountEmployer'),
  };
}

function addInto(a: DeferralRecord, b: DeferralRecord): void {
  for (const k of Object.keys(a) as Array<keyof DeferralRecord>) {
    if (k === 'highEarner') continue;
    (a[k] as number) = r2((a[k] as number) + (b[k] as number));
  }
}

/**
 * Year-to-date deferrals and prior-year FICA wages for a set of people, for
 * the calendar year of `periodStart`, from checks paid before this period.
 */
export async function loadDeferralContexts(
  tx: Tx,
  associateIds: string[],
  periodStart: Date,
): Promise<Map<string, PersonDeferralContext>> {
  const out = new Map<string, PersonDeferralContext>();
  if (associateIds.length === 0) return out;
  const year = periodStart.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const priorStart = new Date(Date.UTC(year - 1, 0, 1));
  const [people, thisYear, lastYear] = await Promise.all([
    findInChunks(associateIds, (chunk) => tx.associate.findMany({ where: { id: { in: chunk } }, select: { id: true, dob: true } })),
    findInChunks(associateIds, (chunk) =>
      tx.payrollItem.findMany({
        where: { associateId: { in: chunk }, status: { not: 'VOIDED' }, payrollRun: { status: { notIn: ['CANCELLED', 'DRAFT'] }, periodStart: { gte: yearStart, lt: periodStart } } },
        select: { associateId: true, deferrals: true, preTaxRetirement: true },
      }),
    ),
    // Box 3: gross less §125 (traditional retirement stays in the FICA base).
    findInChunks(associateIds, (chunk) =>
      tx.payrollItem.findMany({
        where: { associateId: { in: chunk }, status: { not: 'VOIDED' }, payrollRun: { status: { not: 'CANCELLED' }, disbursedAt: { gte: priorStart, lt: yearStart } } },
        select: { associateId: true, grossPay: true, preTaxDeductions: true, preTaxRetirement: true },
      }),
    ),
  ]);
  for (const p of people) out.set(p.id, { dob: p.dob, ytd: emptyDeferrals(), priorYearFicaWages: 0 });
  for (const it of thisYear) {
    const ctx = out.get(it.associateId);
    if (ctx) addInto(ctx.ytd, readDeferrals(it.deferrals, Number(it.preTaxRetirement)));
  }
  for (const it of lastYear) {
    const ctx = out.get(it.associateId);
    if (ctx) ctx.priorYearFicaWages = r2(ctx.priorYearFicaWages + Number(it.grossPay) - (Number(it.preTaxDeductions) - Number(it.preTaxRetirement)));
  }
  return out;
}

/** This check's deductions under the limits and the Roth catch-up rule. */
export function computeCheckDeductions(enrollments: EnrollmentFacts[], ctx: PersonDeferralContext | undefined, year: number): CheckDeductions {
  const limits = limitsFor(year);
  const ytd = ctx?.ytd ?? emptyDeferrals();
  const dob = ctx?.dob ?? null;
  const highEarner = !!ctx && isRothCatchUpHigherEarner(ctx.priorYearFicaWages, year);
  const d = emptyDeferrals();
  d.highEarner = highEarner;
  let preTax = 0;
  let preTaxRetirement = 0;
  let roth = 0;
  // Retirement deferrals share one 402(g) limit across plans: track the running total.
  let retirementSoFar = r2(ytd.pre401k + ytd.pre403b + ytd.roth401k + ytd.roth403b);
  const allowance = catchUpAllowance(dob, year);
  const age = ageAtYearEnd(dob, year);
  for (const e of enrollments) {
    const elected = e.electedAmountCentsPerPeriod / 100;
    switch (e.plan.kind) {
      case 'RETIREMENT_401K':
      case 'RETIREMENT_403B': {
        const split = splitDeferral(elected, retirementSoFar, limits.deferral402g, allowance);
        let catchUp = split.catchUp;
        let catchUpRoth = 0;
        if (catchUp > 0 && highEarner) {
          // Roth by the person's own election, or deemed Roth where the plan allows it.
          if (e.rothElection || e.plan.allowsDeemedRoth) catchUpRoth = catchUp;
          else {
            d.catchUpStoppedNoRoth = r2(d.catchUpStoppedNoRoth + catchUp);
            catchUp = 0;
          }
        } else if (catchUp > 0 && e.rothElection) catchUpRoth = catchUp;
        const regularRoth = e.rothElection ? split.regular : 0;
        const pre = r2(split.regular - regularRoth + catchUp - catchUpRoth);
        const rothPart = r2(regularRoth + catchUpRoth);
        if (e.plan.kind === 'RETIREMENT_401K') {
          d.pre401k = r2(d.pre401k + pre);
          d.roth401k = r2(d.roth401k + rothPart);
        } else {
          d.pre403b = r2(d.pre403b + pre);
          d.roth403b = r2(d.roth403b + rothPart);
        }
        d.catchUp = r2(d.catchUp + catchUp);
        d.catchUpRoth = r2(d.catchUpRoth + catchUpRoth);
        d.limitStopped = r2(d.limitStopped + split.stopped);
        retirementSoFar = r2(retirementSoFar + split.regular + catchUp);
        preTax += pre;
        preTaxRetirement += pre;
        roth += rothPart;
        break;
      }
      case 'HSA': {
        const cap = limits.hsaFamily + (age !== null && age >= 55 ? limits.hsaCatchUp55 : 0);
        const take = Math.min(elected, Math.max(0, cap - ytd.hsa - d.hsa));
        d.hsa = r2(d.hsa + take);
        d.limitStopped = r2(d.limitStopped + elected - take);
        preTax += take;
        break;
      }
      case 'FSA_HEALTHCARE': {
        const take = Math.min(elected, Math.max(0, limits.healthFsa - ytd.fsa - d.fsa));
        d.fsa = r2(d.fsa + take);
        d.limitStopped = r2(d.limitStopped + elected - take);
        preTax += take;
        break;
      }
      case 'FSA_DEPENDENT_CARE': {
        const take = Math.min(elected, Math.max(0, limits.dependentCareFsa - ytd.dcap - d.dcap));
        d.dcap = r2(d.dcap + take);
        d.limitStopped = r2(d.limitStopped + elected - take);
        preTax += take;
        break;
      }
      case 'TRUMP_ACCOUNT':
        // Employer-funded: nothing is withheld; the contribution is reported in Box 12 TA.
        d.trumpAccountEmployer = r2(d.trumpAccountEmployer + e.plan.employerContributionCentsPerPeriod / 100);
        break;
      default:
        preTax += elected;
    }
  }
  return { preTax: r2(preTax), preTaxRetirement: r2(preTaxRetirement), roth: r2(roth), deferrals: d };
}
