import type { BenefitsPlanKind, Prisma, PrismaClient } from '@prisma/client';
import type { EnrollmentFacts, DeferralRecord } from './retirementDeferrals.js';
import { dateColumnKey } from './timezone.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * A 401(k) plan, its people and its money — the part a recordkeeper needs.
 *
 *   elections   ONE source of truth: the person's benefits enrollment in the
 *               plan's 401(k) benefits plan (RetirementPlan.benefitsPlanId).
 *               A rate (auto-enrollment, escalation, an HR change, the
 *               recordkeeper's deferral change) is written there as
 *               electedPercent / rothPercent; payroll turns it into this
 *               paycheck's amount and lib/retirementDeferrals applies the
 *               annual limits, catch-up and the Roth catch-up rule once.
 *               RetirementElection keeps only plan membership: eligibility,
 *               the opt-out window and the escalation date.
 *   eligibility minimum age and service, then the plan's entry date.
 *   auto-enroll the plan's default rate once eligible, an opt-out window, and
 *               yearly escalation to a ceiling. A plan established after
 *               2022-12-29 must auto-enroll (SECURE 2.0 §101; IRC §414A) at
 *               3–10% escalating 1% a year to at least 10%, at most 15%.
 *   employer    the match formula (tiers of the deferral rate) or a safe
 *               harbor: BASIC 100% of 3% + 50% of the next 2%, ENHANCED 100%
 *               of 4%, NONELECTIVE_3 3% of pay for everyone eligible.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

export interface MatchTier {
  /** Of pay, up to this deferral percent… */
  upToPercent: number;
  /** …the employer matches this percent of the deferral. */
  matchPercent: number;
}

export type SafeHarbor = 'NONE' | 'BASIC' | 'ENHANCED' | 'NONELECTIVE_3';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function safeHarborTiers(sh: SafeHarbor): MatchTier[] | null {
  if (sh === 'BASIC') return [{ upToPercent: 3, matchPercent: 100 }, { upToPercent: 5, matchPercent: 50 }];
  if (sh === 'ENHANCED') return [{ upToPercent: 4, matchPercent: 100 }];
  return null;
}

/** Parse the stored formula: tiers sorted by their ceiling, invalid ones dropped. */
export function parseMatchFormula(raw: unknown): MatchTier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => ({ upToPercent: Number((t as MatchTier)?.upToPercent), matchPercent: Number((t as MatchTier)?.matchPercent) }))
    .filter((t) => Number.isFinite(t.upToPercent) && Number.isFinite(t.matchPercent) && t.upToPercent > 0 && t.matchPercent >= 0)
    .sort((a, b) => a.upToPercent - b.upToPercent);
}

/**
 * The employer's money for one paycheck. Tiers are cumulative bands of the
 * deferral rate: [{3,100},{5,50}] matches 100% of deferrals up to 3% of pay
 * and 50% of the deferrals between 3% and 5%. Catch-up isn't matched.
 */
export function employerContribution(
  plan: { matchFormula: unknown; safeHarbor: string },
  comp: number,
  deferralExCatchUp: number,
): { match: number; safeHarbor: number } {
  if (comp <= 0) return { match: 0, safeHarbor: 0 };
  const sh = (plan.safeHarbor as SafeHarbor) ?? 'NONE';
  const nonElective = sh === 'NONELECTIVE_3' ? r2(comp * 0.03) : 0;
  const tiers = safeHarborTiers(sh) ?? parseMatchFormula(plan.matchFormula);
  const rate = (deferralExCatchUp / comp) * 100;
  let match = 0;
  let floor = 0;
  for (const t of tiers) {
    const band = Math.max(0, Math.min(rate, t.upToPercent) - floor);
    match += (band / 100) * comp * (t.matchPercent / 100);
    floor = t.upToPercent;
    if (rate <= t.upToPercent) break;
  }
  const isSafeHarborMatch = sh === 'BASIC' || sh === 'ENHANCED';
  return { match: isSafeHarborMatch ? 0 : r2(match), safeHarbor: r2((isSafeHarborMatch ? match : 0) + nonElective) };
}

/* ----- eligibility & auto-enroll ------------------------------------------ */

/** A calendar day held at UTC midnight (a DATE column, or one built with Date.UTC): its own day. */
const ymd = (d: Date) => dateColumnKey(d);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** The first day a person may join: old enough, served long enough, then the plan's entry date. */
export function eligibleOn(
  plan: { eligibilityMinAge: number; eligibilityServiceDays: number; entryTiming: string },
  person: { dob: Date | null; hireDate: Date | null },
): Date | null {
  if (!person.hireDate) return null;
  const service = addDays(person.hireDate, plan.eligibilityServiceDays);
  let date = service;
  if (person.dob) {
    const ageDate = new Date(Date.UTC(person.dob.getUTCFullYear() + plan.eligibilityMinAge, person.dob.getUTCMonth(), person.dob.getUTCDate()));
    if (ageDate > date) date = ageDate;
  } else if (plan.eligibilityMinAge > 18) {
    return null; // age unknown: can't confirm
  }
  if (plan.entryTiming === 'MONTHLY') {
    if (date.getUTCDate() !== 1) date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  } else if (plan.entryTiming === 'QUARTERLY') {
    const q = Math.floor(date.getUTCMonth() / 3);
    const start = new Date(Date.UTC(date.getUTCFullYear(), q * 3, 1));
    date = ymd(start) === ymd(date) ? start : new Date(Date.UTC(date.getUTCFullYear(), q * 3 + 3, 1));
  }
  return date;
}

/** SECURE 2.0 §101: a 401(k) established after 2022-12-29 must auto-enroll (with listed exceptions). */
export function mustAutoEnroll(plan: { establishedOn: Date | null }): boolean {
  return !!plan.establishedOn && plan.establishedOn > new Date('2022-12-29T00:00:00Z');
}

/** Problems with a plan's auto-enroll settings, plainly (empty = fine). */
export function autoEnrollProblems(plan: {
  establishedOn: Date | null;
  autoEnroll: boolean;
  autoEnrollPercent: number;
  autoEscalatePercent: number;
  autoEscalateMax: number;
}): string[] {
  const out: string[] = [];
  if (!mustAutoEnroll(plan)) return out;
  if (!plan.autoEnroll) out.push('Plans set up after December 29, 2022 must auto-enroll new hires (SECURE 2.0).');
  if (plan.autoEnroll && (plan.autoEnrollPercent < 3 || plan.autoEnrollPercent > 10)) out.push('The starting rate must be between 3% and 10%.');
  if (plan.autoEnroll && plan.autoEscalatePercent < 1) out.push('The rate must rise at least 1% a year.');
  if (plan.autoEnroll && (plan.autoEscalateMax < 10 || plan.autoEscalateMax > 15)) out.push('Escalation must reach at least 10% and stop at 15% or less.');
  return out;
}

/* ----- the one election: the benefits enrollment --------------------------- */

/**
 * The day a Date names, held at UTC midnight. A DATE value (UTC midnight —
 * an effective date from a file or a column) is its own day; any other
 * instant ("now") is read on the company's calendar, so a change made at
 * 9 PM Eastern is dated that day, not tomorrow's UTC date.
 */
const dayStart = (d: Date) => {
  const isDateValue = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return new Date(`${isDateValue ? ymd(d) : orgDateKey(d)}T00:00:00Z`);
};

/** The person's enrollment in a benefits plan that is in force on `day`. */
export async function activeEnrollment(db: Db, benefitsPlanId: string, associateId: string, day: Date) {
  const d = dayStart(day);
  return db.benefitsEnrollment.findFirst({
    where: { planId: benefitsPlanId, associateId, effectiveDate: { lte: d }, OR: [{ terminationDate: null }, { terminationDate: { gte: d } }] },
    orderBy: { effectiveDate: 'desc' },
  });
}

/**
 * Set a person's 401(k) rate — the only writer of deferral elections from
 * this module. A change dated today replaces today's row; otherwise the old
 * row ends yesterday and a new one starts today (history kept). Opting out
 * ends the enrollment.
 */
export async function setDeferralRate(
  db: Db,
  plan: { id: string; tenantId: string | null; benefitsPlanId: string | null; rothEnabled: boolean },
  associateId: string,
  rate: { preTaxPercent: number; rothPercent: number; optOut?: boolean },
  today: Date = new Date(),
): Promise<void> {
  if (!plan.benefitsPlanId) throw new Error('This retirement plan has no 401(k) benefits plan to hold elections.');
  const d = dayStart(today);
  const current = await activeEnrollment(db, plan.benefitsPlanId, associateId, d);
  const roth = plan.rothEnabled ? rate.rothPercent : 0;
  if (rate.optOut || (rate.preTaxPercent <= 0 && roth <= 0)) {
    if (current) await db.benefitsEnrollment.update({ where: { id: current.id }, data: { terminationDate: current.effectiveDate >= d ? current.effectiveDate : addDays(d, -1) } });
    return;
  }
  const data = { electedAmountCentsPerPeriod: 0, electedPercent: rate.preTaxPercent, rothPercent: roth > 0 ? roth : null, rothElection: false, retirementPlanId: plan.id };
  if (current && ymd(current.effectiveDate) === ymd(d)) {
    await db.benefitsEnrollment.update({ where: { id: current.id }, data });
    return;
  }
  if (current) await db.benefitsEnrollment.update({ where: { id: current.id }, data: { terminationDate: addDays(d, -1) } });
  await db.benefitsEnrollment.create({ data: { ...data, tenantId: plan.tenantId ?? undefined, associateId, planId: plan.benefitsPlanId, effectiveDate: d } });
}

/**
 * Bring every active person's membership in line with the plan on `today`:
 * create NOT_ELIGIBLE / ELIGIBLE rows, auto-enroll those whose opt-out
 * window has closed (writing their enrollment), and apply yearly escalation
 * to auto-enrolled rates. Someone who already chose a rate is ENROLLED and
 * never overwritten. Idempotent.
 */
export async function syncPlanElections(db: Db, planId: string, now: Date = new Date()): Promise<{ eligible: number; autoEnrolled: number; escalated: number }> {
  // Today on the company's calendar, as a DATE value: eligibility, opt-out and escalation dates are days.
  const today = dayStart(now);
  const plan = await db.retirementPlan.findUniqueOrThrow({ where: { id: planId } });
  const people = await db.associate.findMany({
    where: { tenantId: plan.tenantId, deletedAt: null, deactivatedAt: null, employmentType: 'W2_EMPLOYEE', ...(plan.employerId ? { employments: { some: { employerOrgId: plan.employerId, endDate: null } } } : {}) },
    select: { id: true, dob: true, hireDate: true },
  });
  const existing = new Map((await db.retirementElection.findMany({ where: { planId } })).map((e) => [e.associateId, e]));
  let eligible = 0;
  let autoEnrolled = 0;
  let escalated = 0;
  for (const p of people) {
    const on = eligibleOn(plan, p);
    const e = existing.get(p.id);
    const isEligible = !!on && on <= today;
    if (!e) {
      await db.retirementElection.create({
        data: { tenantId: plan.tenantId, planId, associateId: p.id, status: isEligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE', eligibleOn: on, optOutDeadline: plan.autoEnroll && on ? addDays(on, plan.optOutDays) : null, source: 'AUTO' },
      });
      if (isEligible) eligible += 1;
      continue;
    }
    if (e.status === 'NOT_ELIGIBLE' && isEligible) {
      await db.retirementElection.update({ where: { id: e.id }, data: { status: 'ELIGIBLE', eligibleOn: on, optOutDeadline: plan.autoEnroll && on ? addDays(on, plan.optOutDays) : null } });
      eligible += 1;
      continue;
    }
    if (!plan.benefitsPlanId) continue;
    if (e.status === 'ELIGIBLE') {
      // They chose a rate themselves (a benefits enrollment): that is the election.
      const own = await activeEnrollment(db, plan.benefitsPlanId, p.id, today);
      if (own) {
        await db.retirementElection.update({ where: { id: e.id }, data: { status: 'ENROLLED', enrolledOn: own.effectiveDate, source: 'EMPLOYEE' } });
        continue;
      }
      if (plan.autoEnroll && e.optOutDeadline && e.optOutDeadline <= today) {
        await setDeferralRate(db, plan, p.id, { preTaxPercent: Number(plan.autoEnrollPercent), rothPercent: 0 }, today);
        await db.retirementElection.update({
          where: { id: e.id },
          data: { status: 'AUTO_ENROLLED', enrolledOn: today, nextEscalationOn: Number(plan.autoEscalatePercent) > 0 ? new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate())) : null, source: 'AUTO' },
        });
        autoEnrolled += 1;
      }
      continue;
    }
    if (e.status === 'AUTO_ENROLLED' && e.nextEscalationOn && e.nextEscalationOn <= today && Number(plan.autoEscalatePercent) > 0) {
      const own = await activeEnrollment(db, plan.benefitsPlanId, p.id, today);
      if (!own || own.electedPercent == null) continue;
      const next = Math.min(Number(plan.autoEscalateMax), Number(own.electedPercent) + Number(plan.autoEscalatePercent));
      await setDeferralRate(db, plan, p.id, { preTaxPercent: next, rothPercent: Number(own.rothPercent ?? 0) }, today);
      await db.retirementElection.update({
        where: { id: e.id },
        data: { nextEscalationOn: next >= Number(plan.autoEscalateMax) ? null : new Date(Date.UTC(e.nextEscalationOn.getUTCFullYear() + 1, e.nextEscalationOn.getUTCMonth(), e.nextEscalationOn.getUTCDate())) },
      });
      escalated += 1;
    }
  }
  return { eligible, autoEnrolled, escalated };
}

/* ----- payroll ---------------------------------------------------------- */

export interface PayrollElection {
  planId: string;
  matchFormula: unknown;
  safeHarbor: string;
  loans: Array<{ loanNumber: string; perPayAmount: number }>;
}

/**
 * The recordkeeper plan each person's deferral reports to (from their
 * enrollment), with its match and their active loans. Read-only: the
 * deduction itself comes from the enrollment, never from here.
 */
export async function loadPayrollElections(db: Db, associateIds: string[], periodStart: Date, periodEndExclusive: Date): Promise<Map<string, PayrollElection>> {
  const out = new Map<string, PayrollElection>();
  // A partial client (the labor golden harness fakes only some models) has no plans to read.
  if (!associateIds.length || !db.retirementPlan || !db.retirementLoan || !db.benefitsEnrollment) return out;
  const enrollments = await db.benefitsEnrollment.findMany({
    where: { associateId: { in: associateIds }, retirementPlanId: { not: null }, effectiveDate: { lt: periodEndExclusive }, OR: [{ terminationDate: null }, { terminationDate: { gte: periodStart } }] },
    select: { associateId: true, retirementPlanId: true },
    orderBy: { effectiveDate: 'desc' },
  });
  if (!enrollments.length) return out;
  const plans = new Map(
    (await db.retirementPlan.findMany({ where: { id: { in: [...new Set(enrollments.map((e) => e.retirementPlanId!))] }, status: 'ACTIVE' }, select: { id: true, matchFormula: true, safeHarbor: true } })).map((p) => [p.id, p]),
  );
  const loans = await db.retirementLoan.findMany({
    where: { associateId: { in: associateIds }, status: 'ACTIVE', startDate: { lt: periodEndExclusive }, OR: [{ endDate: null }, { endDate: { gte: periodStart } }] },
    select: { associateId: true, planId: true, loanNumber: true, perPayAmount: true },
  });
  for (const e of enrollments) {
    if (out.has(e.associateId)) continue;
    const plan = plans.get(e.retirementPlanId!);
    if (!plan) continue;
    out.set(e.associateId, {
      planId: plan.id,
      matchFormula: plan.matchFormula,
      safeHarbor: plan.safeHarbor,
      loans: loans.filter((l) => l.associateId === e.associateId && l.planId === plan.id).map((l) => ({ loanNumber: l.loanNumber, perPayAmount: Number(l.perPayAmount) })),
    });
  }
  return out;
}

/** An enrollment row as payroll reads it. */
export interface EnrollmentRow {
  /** The BenefitsEnrollment id, carried to the deduction line's sourceId. */
  id?: string;
  electedAmountCentsPerPeriod: number;
  rothElection: boolean;
  electedPercent?: { toString(): string } | number | null;
  rothPercent?: { toString(): string } | number | null;
  plan: { kind: BenefitsPlanKind; allowsDeemedRoth: boolean; employerContributionCentsPerPeriod: number };
}

/**
 * This paycheck's enrollment facts for lib/retirementDeferrals. A flat
 * enrollment passes through; a rate becomes cents of this gross — the
 * pre-tax (or Roth, by its checkbox) part and any Roth part. One
 * enrollment, one deduction.
 */
export function enrollmentFacts(e: EnrollmentRow, grossPay: number): EnrollmentFacts[] {
  if (e.electedPercent == null && e.rothPercent == null) return [{ electedAmountCentsPerPeriod: e.electedAmountCentsPerPeriod, rothElection: e.rothElection, plan: e.plan, ...(e.id ? { sourceId: e.id } : {}) }];
  const facts: EnrollmentFacts[] = [];
  const pre = Math.round(grossPay * Number(e.electedPercent ?? 0));
  const roth = Math.round(grossPay * Number(e.rothPercent ?? 0));
  const src = e.id ? { sourceId: e.id } : {};
  if (pre > 0) facts.push({ electedAmountCentsPerPeriod: pre, rothElection: e.rothElection, plan: e.plan, ...src });
  if (roth > 0) facts.push({ electedAmountCentsPerPeriod: roth, rothElection: true, plan: e.plan, ...src });
  return facts;
}

export interface ProjectedRetirement {
  planId: string;
  eligibleComp: number;
  preTax: number;
  roth: number;
  catchUpPreTax: number;
  catchUpRoth: number;
  employerMatch: number;
  safeHarbor: number;
  loanRepayments: Array<{ loanNumber: string; amount: number }>;
}

/**
 * What this paycheck sends the plan, from what payroll actually withheld
 * (the deferral record) — never from the election alone, so a limit that
 * stopped a deferral stops it in the file too.
 */
export function projectRetirement(e: PayrollElection, grossPay: number, deferrals: DeferralRecord | null, loanRoom: number): ProjectedRetirement {
  const d: Pick<DeferralRecord, 'pre401k' | 'roth401k' | 'catchUp' | 'catchUpRoth'> = deferrals ?? { pre401k: 0, roth401k: 0, catchUp: 0, catchUpRoth: 0 };
  const catchUpRoth = r2(d.catchUpRoth ?? 0);
  const catchUpPreTax = r2(Math.max(0, (d.catchUp ?? 0) - catchUpRoth));
  const preTax = r2(Math.max(0, d.pre401k - catchUpPreTax));
  const roth = r2(Math.max(0, d.roth401k - catchUpRoth));
  const employer = employerContribution({ matchFormula: e.matchFormula, safeHarbor: e.safeHarbor }, grossPay, preTax + roth);
  let room = Math.max(0, loanRoom);
  const loanRepayments = e.loans.map((l) => {
    const amount = r2(Math.min(l.perPayAmount, room));
    room = r2(room - amount);
    return { loanNumber: l.loanNumber, amount };
  }).filter((l) => l.amount > 0);
  return { planId: e.planId, eligibleComp: r2(grossPay), preTax, roth, catchUpPreTax, catchUpRoth, employerMatch: employer.match, safeHarbor: employer.safeHarbor, loanRepayments };
}

/**
 * Year-end true-up: a person who front-loaded deferrals and hit the limit
 * early can be owed match a per-paycheck formula didn't pay. Annual match
 * on annual comp and deferrals, less what was paid.
 */
export function trueUp(plan: { matchFormula: unknown; safeHarbor: string }, annual: { comp: number; deferralExCatchUp: number; matchPaid: number; safeHarborPaid: number }): number {
  const owed = employerContribution(plan, annual.comp, annual.deferralExCatchUp);
  return r2(Math.max(0, owed.match + owed.safeHarbor - annual.matchPaid - annual.safeHarborPaid));
}

/** Every active plan of the current tenant, brought up to date (the daily sweep). */
export async function syncAllPlans(db: Db, today: Date = new Date()): Promise<number> {
  const plans = await db.retirementPlan.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  for (const p of plans) await syncPlanElections(db, p.id, today);
  return plans.length;
}
