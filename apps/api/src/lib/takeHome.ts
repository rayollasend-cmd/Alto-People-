import type { PrismaClient } from '@prisma/client';
import { computePaycheckTaxes, type PayFrequency } from './payrollTax.js';
import { computeYtdWages } from './payrollYtd.js';

/**
 * Continuous net pay (BEYOND): what this week's earned gross is worth after
 * taxes, deductions and any earned-wage advance already drawn — the same tax
 * engine payroll runs, fed the person's own W-4, state certificate and
 * year-to-date wages, on the week's gross as a weekly check.
 *
 * Deductions come from the person's last paycheck, spread over a week
 * (a $60 biweekly benefit is $30 a week) and never more than the week's
 * gross. A contractor has nothing withheld. Always an estimate — the
 * paycheck is the official number.
 */

const round2 = (v: number) => Math.round(v * 100) / 100;
const DAY_MS = 86_400_000;

export interface TakeHomeEstimate {
  gross: number;
  /** Federal income tax + Social Security + Medicare + state income tax. */
  taxes: number;
  federalIncomeTax: number;
  socialSecurity: number;
  medicare: number;
  stateIncomeTax: number;
  /** Pre-tax (benefits, retirement) and after-tax deductions, a week's share of the last check's. */
  deductions: number;
  /** Earned-wage advances already paid out and not yet taken back. */
  advances: number;
  net: number;
  /** How taxes were figured: the tax engine with a W-4, the engine at the default (no W-4 on file), or nothing withheld. */
  basis: 'W4' | 'NO_W4' | 'NO_WITHHOLDING';
}

/**
 * `opts.payFrequency` / `opts.days`: figure the gross as the check it will be
 * on — a biweekly period's earnings as a biweekly check, with that many
 * days' share of the last check's deductions. Omitted: a weekly check of a
 * week's share (the original "this week" reading).
 */
export async function estimateTakeHome(
  prisma: PrismaClient,
  associateId: string,
  gross: number,
  now: Date = new Date(),
  opts: { payFrequency?: PayFrequency; days?: number } = {},
): Promise<TakeHomeEstimate> {
  const [assoc, lastCheck, advances] = await Promise.all([
    prisma.associate.findUnique({
      where: { id: associateId },
      select: {
        employmentType: true,
        state: true,
        w4Submission: { select: { filingStatus: true, extraWithholding: true, deductions: true, otherIncome: true, dependentsAmount: true } },
        stateW4s: { select: { state: true, filingStatus: true, allowances: true, dependents: true, additionalWithholding: true, exempt: true, county: true } },
      },
    }),
    prisma.payrollItem.findFirst({
      where: { associateId, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] } } },
      orderBy: { payrollRun: { periodEnd: 'desc' } },
      select: { preTaxDeductions: true, preTaxRetirement: true, postTaxDeductions: true, payrollRun: { select: { periodStart: true, periodEnd: true } } },
    }),
    prisma.earnedWageAdvance.findMany({
      where: { associateId, status: 'PAID', periodEnd: { gte: new Date(now.getTime() - 14 * DAY_MS) } },
      select: { amountCents: true, feeCents: true, recoveredCents: true },
    }),
  ]);
  const owed = advances.reduce((s, a) => s + Math.max(0, a.amountCents + a.feeCents - a.recoveredCents), 0) / 100;
  const zero = { federalIncomeTax: 0, socialSecurity: 0, medicare: 0, stateIncomeTax: 0 };
  if (gross <= 0 || !assoc) {
    return { gross: round2(Math.max(0, gross)), taxes: 0, ...zero, deductions: 0, advances: round2(owed), net: 0, basis: assoc?.employmentType === 'W2_EMPLOYEE' ? (assoc.w4Submission ? 'W4' : 'NO_W4') : 'NO_WITHHOLDING' };
  }
  if (assoc.employmentType !== 'W2_EMPLOYEE') {
    return { gross: round2(gross), taxes: 0, ...zero, deductions: 0, advances: round2(owed), net: round2(Math.max(0, gross - owed)), basis: 'NO_WITHHOLDING' };
  }

  // A week's (or the period's) share of the last check's deductions.
  const spanDays = opts.days && opts.days > 0 ? opts.days : 7;
  let preTax = 0;
  let preTaxRetirement = 0;
  let postTax = 0;
  if (lastCheck) {
    const days = Math.max(1, Math.round((lastCheck.payrollRun.periodEnd.getTime() - lastCheck.payrollRun.periodStart.getTime()) / DAY_MS) + 1);
    const perWeek = spanDays / days;
    preTax = Math.min(gross, Number(lastCheck.preTaxDeductions) * perWeek);
    preTaxRetirement = Math.min(preTax, Number(lastCheck.preTaxRetirement) * perWeek);
    postTax = Number(lastCheck.postTaxDeductions) * perWeek;
  }

  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const ytd = await computeYtdWages(prisma, associateId, yearStart, now);
  const w4 = assoc.w4Submission;
  const state = assoc.state?.toUpperCase() ?? null;
  const cert = state ? assoc.stateW4s.find((c) => c.state === state) : undefined;
  const t = computePaycheckTaxes({
    grossPay: round2(Math.max(0, gross - preTax)),
    ficaMedicareGross: round2(Math.max(0, gross - (preTax - preTaxRetirement))),
    filingStatus: w4?.filingStatus ?? null,
    payFrequency: opts.payFrequency ?? 'WEEKLY',
    state,
    ytdWages: ytd,
    ytdMedicareWages: ytd,
    extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
    deductions: w4?.deductions ? Number(w4.deductions) : 0,
    otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
    dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
    stateW4: cert ? { filingStatus: cert.filingStatus, allowances: cert.allowances, dependents: cert.dependents, additionalWithholding: Number(cert.additionalWithholding), exempt: cert.exempt, county: cert.county } : null,
  });
  const taxes = t.federalIncomeTax + t.socialSecurity + t.medicare + t.stateIncomeTax;
  const deductions = preTax + postTax;
  return {
    gross: round2(gross),
    taxes: round2(taxes),
    federalIncomeTax: round2(t.federalIncomeTax),
    socialSecurity: round2(t.socialSecurity),
    medicare: round2(t.medicare),
    stateIncomeTax: round2(t.stateIncomeTax),
    deductions: round2(deductions),
    advances: round2(owed),
    net: round2(Math.max(0, gross - taxes - deductions - owed)),
    basis: w4 ? 'W4' : 'NO_W4',
  };
}
