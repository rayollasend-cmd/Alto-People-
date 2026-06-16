// Wave 6 — Pure-ish payroll run aggregator.
//
// Reads time entries, shifts, W-4s, pay schedules, prior YTD wages, active
// pre-tax benefit enrollments, and active garnishments — runs all of the
// math (OT split, FIT/SIT/FICA/Medicare, employer-side taxes, garnishment
// CCPA caps) — and returns a projected per-associate list. Does NOT write
// any rows. The DB-writing wrapper (POST /runs) calls this then persists
// the projection. The preview endpoint (POST /runs/preview) calls this
// alone and returns the projection as JSON.
//
// "Pure-ish" because it still touches the DB to read inputs — but it makes
// no writes, so it's safe to call from a read-only endpoint and trivial to
// re-run after fixing inputs.

import type { BenefitsPlanKind, Prisma, PrismaClient } from '@prisma/client';
import {
  pickHourlyRate,
  round2,
  splitWeeklyOvertime,
  sumApprovedHours,
} from './payroll.js';

/**
 * Gap 1 — IRS pre-tax classification. Traditional retirement (401k/403b)
 * is FIT-deferred but FICA-includable, so it must NOT reduce the FICA /
 * Medicare wage base. Section 125 cafeteria-plan items (health/dental/
 * vision/HSA/FSA) reduce all three. Imputed-income items (life/disability
 * over the §79 threshold) are out of scope here — assume cafeteria-plan
 * for now and revisit if HR ever offers >$50k group-term life.
 */
function classifyPreTax(kind: BenefitsPlanKind): 'FIT_ONLY' | 'ALL_THREE' {
  switch (kind) {
    case 'RETIREMENT_401K':
    case 'RETIREMENT_403B':
      return 'FIT_ONLY';
    default:
      return 'ALL_THREE';
  }
}
import {
  computePaycheckTaxes,
  zeroTaxBreakdown,
  type PayFrequency,
} from './payrollTax.js';
import { computeGarnishmentDeductions } from './garnishments.js';
import { computeYtdMedicareWages, computeYtdWages } from './payrollYtd.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AggregatorInput {
  /** Inclusive UTC midnight of the first day of the period. */
  periodStart: Date;
  /** Exclusive — start of the day AFTER periodEnd. */
  periodEndExclusive: Date;
  /** Optional client filter — null means cross-client run. */
  clientId: string | null;
  /** Default hourly rate when no shift in the period has one. */
  defaultRate: number;
  /**
   * Optional per-associate hourly-rate override. When an associate id is
   * present here, this rate is used instead of the shift-derived rate (and
   * the shift lookup is skipped). Lets callers drive gross from a different
   * rate source — e.g. the payroll-ready sheet uses each associate's current
   * compensation-record wage. Real payroll runs omit this and keep using
   * shift rates.
   */
  hourlyRateOverride?: Map<string, number>;
  /**
   * Optional state override for the state-income-tax calc. When set (incl.
   * an explicit value), it replaces each associate's stored state — used by
   * the payroll sheet to apply the selected client's work-site state (e.g.
   * a Florida client → no state income tax) rather than a possibly-unset
   * per-associate state, which would otherwise hit the 4% fallback.
   */
  stateOverride?: string | null;
}

export interface ProjectedEarning {
  kind: 'REGULAR' | 'OVERTIME';
  hours: number;
  rate: number;
  amount: number;
  isTaxable: true;
}

export interface ProjectedGarnishment {
  garnishmentId: string;
  amount: number;
  reachedCap: boolean;
}

export interface ProjectedItem {
  associateId: string;
  associateName: string;
  hoursWorked: number;
  hourlyRate: number;
  /** Federal weekly OT split: regular vs overtime hours. */
  regularHours: number;
  overtimeHours: number;
  earnings: ProjectedEarning[];
  grossPay: number;
  preTaxDeductions: number;
  /**
   * Gap 1 — sub-bucket of preTaxDeductions covering 401(k)/403(b) only.
   * This portion reduces the FIT base but NOT the FICA / Medicare /
   * employer-tax base, so the W-2 aggregator can compute Box 1 vs Box 3/5
   * correctly. Section-125 pre-tax = preTaxDeductions - preTaxRetirement.
   */
  preTaxRetirement: number;
  /** Tax breakdown — zero when employmentType is 1099. */
  federalIncomeTax: number;
  fica: number;
  medicare: number;
  stateIncomeTax: number;
  taxState: string | null;
  /** Pay frequency from the schedule (or BIWEEKLY fallback). */
  payFrequency: PayFrequency;
  /** Per-CCPA disposable earnings used for garnishment math. */
  disposableEarnings: number;
  garnishments: ProjectedGarnishment[];
  postTaxDeductions: number;
  /**
   * Gap 10 — sum of SETTLED reimbursements queued for this associate. Added
   * to netPay AFTER taxes / deductions; never affects grossPay or any
   * wage base (accountable-plan rule). Persistence stamps these rows
   * with payrollItemId at run-creation time.
   */
  reimbursementsTotal: number;
  /** IDs of Reimbursement rows consumed for this item — empty in preview. */
  reimbursementIds: string[];
  netPay: number;
  /** Employer-side accruals (informational; not deducted from net). */
  employerFica: number;
  employerMedicare: number;
  employerFuta: number;
  employerSuta: number;
  /** Pre-paycheck YTD snapshots used for FICA cap + Medicare surcharge. */
  ytdWages: number;
  ytdMedicareWages: number;
}

export interface ProjectedTotals {
  totalGross: number;
  totalEmployeeTax: number;
  totalNet: number;
  totalEmployerTax: number;
  totalGarnishments: number;
  itemCount: number;
}

export interface AggregatorResult {
  items: ProjectedItem[];
  totals: ProjectedTotals;
}

/**
 * Reads inputs + runs the math. No writes. Caller decides whether to
 * persist (POST /runs) or just project (POST /runs/preview).
 */
export async function aggregatePayrollProjection(
  tx: Tx,
  input: AggregatorInput
): Promise<AggregatorResult> {
  const { periodStart, periodEndExclusive, clientId, defaultRate } = input;

  const entries = await tx.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockInAt: { gte: periodStart, lt: periodEndExclusive },
      ...(clientId ? { clientId } : {}),
    },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          employmentType: true,
          payrollSchedule: { select: { frequency: true } },
          w4Submission: {
            select: {
              filingStatus: true,
              extraWithholding: true,
              deductions: true,
              otherIncome: true,
              dependentsAmount: true,
            },
          },
        },
      },
    },
  });

  const byAssociate = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byAssociate.get(e.associateId) ?? [];
    arr.push(e);
    byAssociate.set(e.associateId, arr);
  }

  const yearStart = new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1));
  const items: ProjectedItem[] = [];
  let totalGross = 0;
  let totalEmployeeTax = 0;
  let totalNet = 0;
  let totalEmployerTax = 0;
  let totalGarnishments = 0;

  for (const [associateId, group] of byAssociate) {
    const hoursWorked = sumApprovedHours(group);
    if (hoursWorked === 0) continue;

    const overrideRate = input.hourlyRateOverride?.get(associateId);
    let hourlyRate: number;
    if (overrideRate !== undefined) {
      hourlyRate = overrideRate;
    } else {
      const shifts = await tx.shift.findMany({
        where: {
          assignedAssociateId: associateId,
          startsAt: { gte: periodStart, lt: periodEndExclusive },
        },
        select: { hourlyRate: true },
      });
      hourlyRate = pickHourlyRate(shifts, defaultRate);
    }

    const otSplit = splitWeeklyOvertime(group);
    const regularPay = round2(otSplit.regularHours * hourlyRate);
    const overtimePay = round2(otSplit.overtimeHours * hourlyRate * 1.5);
    const grossPay = round2(regularPay + overtimePay);

    // Gap 8 — live YTD aggregation. Excludes CANCELLED (voided) runs and
    // non-DISBURSED items; AMENDMENT items contribute signed deltas so
    // corrections naturally land in the result.
    const ytdWages = await computeYtdWages(tx, associateId, yearStart, periodStart);
    const ytdMedicareWages = await computeYtdMedicareWages(tx, associateId, yearStart, periodStart);

    const w4 = group[0].associate.w4Submission;
    const associateState =
      input.stateOverride !== undefined
        ? input.stateOverride
        : group[0].associate.state ?? null;
    const employmentType = group[0].associate.employmentType;
    const payFrequency: PayFrequency =
      group[0].associate.payrollSchedule?.frequency ?? 'BIWEEKLY';

    let preTaxDeductions = 0;
    let preTaxRetirement = 0;
    if (employmentType === 'W2_EMPLOYEE') {
      const enrollments = await tx.benefitsEnrollment.findMany({
        where: {
          associateId,
          effectiveDate: { lte: periodEndExclusive },
          OR: [
            { terminationDate: null },
            { terminationDate: { gte: periodStart } },
          ],
        },
        select: {
          electedAmountCentsPerPeriod: true,
          plan: { select: { kind: true } },
        },
      });
      let totalCents = 0;
      let retirementCents = 0;
      for (const e of enrollments) {
        totalCents += e.electedAmountCentsPerPeriod;
        if (classifyPreTax(e.plan.kind) === 'FIT_ONLY') {
          retirementCents += e.electedAmountCentsPerPeriod;
        }
      }
      preTaxDeductions = round2(totalCents / 100);
      preTaxRetirement = round2(retirementCents / 100);
    }
    // FIT base subtracts ALL pre-tax (Section 125 + retirement).
    // FICA / Medicare base subtracts ONLY the Section 125 slice — retirement
    // contributions are FIT-deferred but FICA-includable per IRS rules.
    const fitGross = round2(Math.max(0, grossPay - preTaxDeductions));
    const ficaMedicareGross = round2(
      Math.max(0, grossPay - (preTaxDeductions - preTaxRetirement)),
    );

    const breakdown =
      employmentType === 'W2_EMPLOYEE'
        ? computePaycheckTaxes({
            grossPay: fitGross,
            ficaMedicareGross,
            filingStatus: w4?.filingStatus ?? null,
            payFrequency,
            state: associateState,
            ytdWages,
            ytdMedicareWages,
            extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
            deductions: w4?.deductions ? Number(w4.deductions) : 0,
            otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
            dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
          })
        : zeroTaxBreakdown(grossPay);

    const disposableEarnings =
      employmentType === 'W2_EMPLOYEE'
        ? round2(
            grossPay -
              breakdown.federalIncomeTax -
              breakdown.socialSecurity -
              breakdown.medicare -
              breakdown.stateIncomeTax
          )
        : 0;

    const activeGarns =
      employmentType === 'W2_EMPLOYEE' && disposableEarnings > 0
        ? await tx.garnishment.findMany({
            where: {
              associateId,
              status: 'ACTIVE',
              deletedAt: null,
              startDate: { lte: periodEndExclusive },
              OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
            },
            orderBy: { priority: 'asc' },
          })
        : [];

    const garnResult = computeGarnishmentDeductions({
      disposableEarnings,
      rules: activeGarns.map((g) => ({
        id: g.id,
        kind: g.kind,
        amountPerRun: g.amountPerRun !== null ? Number(g.amountPerRun) : null,
        percentOfDisp: g.percentOfDisp !== null ? Number(g.percentOfDisp) : null,
        totalCap: g.totalCap !== null ? Number(g.totalCap) : null,
        amountWithheld: Number(g.amountWithheld),
        priority: g.priority,
      })),
    });

    const postTaxDeductions = garnResult.total;

    // Gap 10 — fold settled-but-unpaid reimbursements into this item.
    // Read-only here (preview safe); persistence is run-creation's job.
    // Accountable-plan rule: amount is added AFTER taxes and never
    // touches grossPay / taxableGross / any wage base.
    const settledReimbursements = await tx.reimbursement.findMany({
      where: {
        associateId,
        status: 'SETTLED',
        payrollItemId: null,
      },
      select: { id: true, totalAmount: true },
      orderBy: { settledAt: 'asc' },
    });
    const reimbursementsTotal = round2(
      settledReimbursements.reduce((sum, r) => sum + Number(r.totalAmount), 0)
    );
    const reimbursementIds = settledReimbursements.map((r) => r.id);

    const finalNetPay = round2(
      breakdown.netPay - postTaxDeductions + reimbursementsTotal
    );

    const earnings: ProjectedEarning[] = [];
    if (otSplit.regularHours > 0) {
      earnings.push({
        kind: 'REGULAR',
        hours: otSplit.regularHours,
        rate: hourlyRate,
        amount: regularPay,
        isTaxable: true,
      });
    }
    if (otSplit.overtimeHours > 0) {
      earnings.push({
        kind: 'OVERTIME',
        hours: otSplit.overtimeHours,
        rate: round2(hourlyRate * 1.5),
        amount: overtimePay,
        isTaxable: true,
      });
    }

    const associateName =
      `${group[0].associate.firstName} ${group[0].associate.lastName}`.trim();

    items.push({
      associateId,
      associateName,
      hoursWorked,
      hourlyRate,
      regularHours: otSplit.regularHours,
      overtimeHours: otSplit.overtimeHours,
      earnings,
      grossPay,
      preTaxDeductions,
      preTaxRetirement,
      federalIncomeTax: breakdown.federalIncomeTax,
      fica: breakdown.socialSecurity,
      medicare: breakdown.medicare,
      stateIncomeTax: breakdown.stateIncomeTax,
      taxState: associateState,
      payFrequency,
      disposableEarnings,
      garnishments: garnResult.deductions,
      postTaxDeductions,
      reimbursementsTotal,
      reimbursementIds,
      netPay: finalNetPay,
      employerFica: breakdown.employer.fica,
      employerMedicare: breakdown.employer.medicare,
      employerFuta: breakdown.employer.futa,
      employerSuta: breakdown.employer.suta,
      ytdWages,
      ytdMedicareWages,
    });

    totalGross += grossPay;
    totalEmployeeTax += breakdown.totalEmployeeTax;
    totalNet += finalNetPay;
    totalEmployerTax +=
      breakdown.employer.fica +
      breakdown.employer.medicare +
      breakdown.employer.futa +
      breakdown.employer.suta;
    totalGarnishments += postTaxDeductions;
  }

  return {
    items,
    totals: {
      totalGross: round2(totalGross),
      totalEmployeeTax: round2(totalEmployeeTax),
      totalNet: round2(totalNet),
      totalEmployerTax: round2(totalEmployerTax),
      totalGarnishments: round2(totalGarnishments),
      itemCount: items.length,
    },
  };
}
