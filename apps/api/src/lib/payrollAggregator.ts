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

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  pickHourlyRate,
  round2,
  splitWeeklyOvertime,
  sumApprovedHours,
} from './payroll.js';
import {
  computePaycheckTaxes,
  zeroTaxBreakdown,
  type PayFrequency,
} from './payrollTax.js';
import { computeGarnishmentDeductions } from './garnishments.js';

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

    const shifts = await tx.shift.findMany({
      where: {
        assignedAssociateId: associateId,
        startsAt: { gte: periodStart, lt: periodEndExclusive },
      },
      select: { hourlyRate: true },
    });
    const hourlyRate = pickHourlyRate(shifts, defaultRate);

    const otSplit = splitWeeklyOvertime(group);
    const regularPay = round2(otSplit.regularHours * hourlyRate);
    const overtimePay = round2(otSplit.overtimeHours * hourlyRate * 1.5);
    const grossPay = round2(regularPay + overtimePay);

    const priorYtd = await tx.payrollItem.aggregate({
      where: {
        associateId,
        payrollRun: { periodStart: { gte: yearStart, lt: periodStart } },
      },
      _sum: { grossPay: true },
    });
    const ytdWages = Number(priorYtd._sum.grossPay ?? 0);
    const ytdMedicareWages = ytdWages;

    const w4 = group[0].associate.w4Submission;
    const associateState = group[0].associate.state ?? null;
    const employmentType = group[0].associate.employmentType;
    const payFrequency: PayFrequency =
      group[0].associate.payrollSchedule?.frequency ?? 'BIWEEKLY';

    let preTaxDeductions = 0;
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
        select: { electedAmountCentsPerPeriod: true },
      });
      const totalCents = enrollments.reduce(
        (acc, e) => acc + e.electedAmountCentsPerPeriod,
        0
      );
      preTaxDeductions = round2(totalCents / 100);
    }
    const taxableGross = round2(Math.max(0, grossPay - preTaxDeductions));

    const breakdown =
      employmentType === 'W2_EMPLOYEE'
        ? computePaycheckTaxes({
            grossPay: taxableGross,
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
    const finalNetPay = round2(breakdown.netPay - postTaxDeductions);

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
      federalIncomeTax: breakdown.federalIncomeTax,
      fica: breakdown.socialSecurity,
      medicare: breakdown.medicare,
      stateIncomeTax: breakdown.stateIncomeTax,
      taxState: associateState,
      payFrequency,
      disposableEarnings,
      garnishments: garnResult.deductions,
      postTaxDeductions,
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
