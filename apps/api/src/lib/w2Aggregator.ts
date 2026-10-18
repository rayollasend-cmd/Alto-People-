// Gap 1 — W-2 box aggregator.
//
// Reads PayrollItems for one associate in one tax year and produces the
// per-box totals that feed Form W-2. Pure-ish: it queries the DB but
// makes no writes, so it's safe to call from preview / regenerate flows
// (matching payrollAggregator's contract).
//
// Tax-year attribution follows the IRS pay-date rule, NOT the work-period
// rule: a paystub for period Dec 28 with disbursedAt Jan 3 belongs to the
// NEXT year's W-2. That mirrors how Rippling / Gusto / ADP handle it.
// Items whose run is CANCELLED, or whose own status is VOIDED, are
// excluded entirely. AMENDMENT items contribute signed deltas exactly the
// way payrollYtd.ts already does for live YTD aggregation, so a
// correction lands on the same year as the run that paid it out.
//
// Pre-tax IRS rules:
//   · Section 125 cafeteria plans (health/dental/vision/HSA/FSA premiums)
//     reduce Box 1, Box 3, AND Box 5.
//   · Traditional 401(k)/403(b) reduces Box 1 ONLY. Box 3/5 are computed
//     against the un-retirement-reduced wage base — that's why the
//     `preTaxRetirement` sub-bucket on PayrollItem is added back below.

import type { Prisma, PrismaClient } from '@prisma/client';
import { readDeferrals } from './retirementDeferrals.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface W2Boxes {
  /** Box 1 — Wages, tips, other compensation (FIT-taxable). */
  box1Wages: number;
  /** Box 2 — Federal income tax withheld. */
  box2FitWithheld: number;
  /** Box 3 — Social Security wages, capped at the year's SS wage base. */
  box3SsWages: number;
  /** Box 4 — Social Security tax withheld (6.2% of Box 3). */
  box4SsTax: number;
  /** Box 5 — Medicare wages, uncapped. */
  box5MedicareWages: number;
  /** Box 6 — Medicare tax withheld (1.45% + 0.9% surcharge over $200k YTD). */
  box6MedicareTax: number;
  /** Box 10 — Dependent care benefits (dependent care FSA, IRC §129). */
  box10DependentCare?: number;
  /** Box 7 — Social security tips (cash tips reported to the employer). Box 3 + Box 7 ≤ the wage base. */
  box7SsTips?: number;
  /**
   * Box 12 — coded amounts, in code order. 2026 adds TA (Trump account,
   * IRC §128), TP (cash tips reported to the employer) and TT (qualified
   * overtime: the FLSA premium portion). Source: IRS 2026 W-2/W-3 instructions.
   */
  box12?: W2Box12Entry[];
  /** Box 14b — Treasury Tipped Occupation Code(s) (TY2026+), at most two. */
  box14bTippedOccupationCodes?: string[];
  /** Box 13 — Third-party sick pay: checked when the employer reports insurer-paid sick pay (lib/manualChecks). */
  box13ThirdPartySickPay?: boolean;
  /** Box 15-17 — One block per state with non-zero withholding. */
  stateLines: W2StateLine[];
  /** Source items, count only — for a sanity check on the UI. */
  sourceItemCount: number;
}

export type W2Box12Code = 'D' | 'E' | 'J' | 'W' | 'AA' | 'BB' | 'TA' | 'TP' | 'TT';
export interface W2Box12Entry {
  code: W2Box12Code;
  amount: number;
}
/** IRS order of codes on the form. */
const BOX12_ORDER: W2Box12Code[] = ['D', 'E', 'J', 'W', 'AA', 'BB', 'TA', 'TP', 'TT'];

export interface W2StateLine {
  /** Two-letter USPS code from PayrollItem.taxState. */
  state: string;
  /** Box 16 — State wages. Tracks Box 1 for now (per-state pre-tax math TODO). */
  stateWages: number;
  /** Box 17 — State income tax withheld. */
  stateIncomeTax: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Helper — pull SS wage base for any historical year. */
async function getSsWageBaseForYear(tx: Tx, taxYear: number): Promise<number> {
  const row = await tx.payrollConfig.findUnique({
    where: { year: taxYear },
    select: { ssWageBase: true },
  });
  if (!row) {
    throw new Error(
      `payrollConfig row for year ${taxYear} not found. Cannot generate W-2 ` +
        `without the year's SS wage base.`,
    );
  }
  return Number(row.ssWageBase);
}

/**
 * Aggregates W-2 boxes for one associate / one tax year. Returns zeros if
 * the associate had no qualifying paystubs in the year — the caller decides
 * whether to skip them or generate a $0 W-2.
 */
export async function aggregateW2Wages(
  tx: Tx,
  associateId: string,
  taxYear: number,
  /**
   * Tier-2 — multi-EIN split. `undefined` aggregates across every run
   * (legacy single-W-2 behavior); a client id (or explicit null for
   * cross-client internal runs) scopes the boxes to wages paid under
   * that employer's EIN, so a worker paid by two clients gets two W-2s.
   */
  employerClientId?: string | null | { kind: 'TENANT' | 'THIRD_PARTY' },
): Promise<W2Boxes> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));

  // Pull every PayrollItem disbursed inside the year. We filter by the run's
  // disbursedAt timestamp to land on the IRS pay-date rule. CANCELLED runs
  // and VOIDED items are out; AMENDMENT items count and naturally produce
  // signed deltas because their grossPay / tax columns are already signed.
  const items = await tx.payrollItem.findMany({
    where: {
      associateId,
      status: { not: 'VOIDED' },
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
        // Brief 2-1b: a client employer = that client's runs; the tenant's own
        // employer = the client-less runs and the runs of clients with no employer row of their own.
        ...(employerClientId === undefined
          ? {}
          : employerClientId !== null && typeof employerClientId === 'object'
            ? { OR: [{ clientId: null }, { client: { employerOrganization: null } }] }
            : { clientId: employerClientId }),
      },
    },
    select: {
      grossPay: true,
      preTaxDeductions: true,
      preTaxRetirement: true,
      federalWithholding: true,
      fica: true,
      medicare: true,
      stateWithholding: true,
      taxState: true,
      qualifiedTips: true,
      qualifiedOvertime: true,
      tippedOccupationCode: true,
      deferrals: true,
    },
  });

  let box1Wages = 0;
  let box2FitWithheld = 0;
  let box5MedicareWages = 0;
  let box6MedicareTax = 0;
  let preCapSsWages = 0;
  let box4SsTax = 0;
  let tipsTotal = 0;
  let dependentCare = 0;
  const codes = new Map<W2Box12Code, number>();
  const occupationCodes = new Set<string>();
  const addCode = (c: W2Box12Code, n: number) => codes.set(c, (codes.get(c) ?? 0) + n);
  const stateBuckets = new Map<string, { wages: number; tax: number }>();

  for (const item of items) {
    const gross = Number(item.grossPay);
    const preTax = Number(item.preTaxDeductions);
    const retirement = Number(item.preTaxRetirement);
    // Box 1 (FIT base) subtracts ALL pre-tax — Section 125 + 401(k).
    const box1Slice = gross - preTax;
    // Box 3/5 (FICA / Medicare base) only subtracts Section 125,
    // i.e. add back the retirement slice that Box 1 just removed.
    const box35Slice = gross - (preTax - retirement);

    box1Wages += box1Slice;
    box2FitWithheld += Number(item.federalWithholding);
    box5MedicareWages += box35Slice;
    box6MedicareTax += Number(item.medicare);
    preCapSsWages += box35Slice;
    box4SsTax += Number(item.fica);
    const tips = Number(item.qualifiedTips);
    tipsTotal += tips;
    const d = readDeferrals(item.deferrals, retirement);
    dependentCare += d.dcap;
    addCode('D', d.pre401k);
    addCode('E', d.pre403b);
    addCode('W', d.hsa);
    addCode('AA', d.roth401k);
    addCode('BB', d.roth403b);
    addCode('TA', d.trumpAccountEmployer);
    addCode('TP', tips);
    addCode('TT', Number(item.qualifiedOvertime));
    if (item.tippedOccupationCode && tips > 0) occupationCodes.add(item.tippedOccupationCode);

    if (item.taxState) {
      const b = stateBuckets.get(item.taxState) ?? { wages: 0, tax: 0 };
      // State wages mirror Box 1 — most states piggy-back on FIT base.
      // Per-state retirement-conformity is on the long-tail TODO list.
      b.wages += box1Slice;
      b.tax += Number(item.stateWithholding);
      stateBuckets.set(item.taxState, b);
    }
  }

  // Insurer-paid sick pay the employer reports (PAYEXP §3): the taxable
  // part is wages in Boxes 1/3/5 with the insurer's withholding; the part
  // bought with the employee's after-tax premiums is Box 12 J. Not tied to
  // a client's EIN — it follows the tenant's own W-2.
  let thirdPartySick = false;
  if (employerClientId === undefined || (employerClientId !== null && typeof employerClientId === 'object')) {
    const sick = await tx.thirdPartySickPay.findMany({
      where: { associateId, voidedAt: null, w2ReportedBy: 'EMPLOYER', payDate: { gte: yearStart, lt: yearEndExclusive } },
      select: { grossAmount: true, nontaxableAmount: true, federalWithheld: true, socialSecurityWithheld: true, medicareWithheld: true, stateWithheld: true, associate: { select: { state: true } } },
    });
    for (const r of sick) {
      thirdPartySick = true;
      const taxable = Number(r.grossAmount) - Number(r.nontaxableAmount);
      box1Wages += taxable;
      box2FitWithheld += Number(r.federalWithheld);
      preCapSsWages += taxable;
      box4SsTax += Number(r.socialSecurityWithheld);
      box5MedicareWages += taxable;
      box6MedicareTax += Number(r.medicareWithheld);
      addCode('J', Number(r.nontaxableAmount));
      const st = r.associate.state?.toUpperCase();
      if (st && (Number(r.stateWithheld) > 0 || taxable > 0)) {
        const b = stateBuckets.get(st) ?? { wages: 0, tax: 0 };
        b.wages += taxable;
        b.tax += Number(r.stateWithheld);
        stateBuckets.set(st, b);
      }
    }
  }

  const ssWageBase = await getSsWageBaseForYear(tx, taxYear);
  // Box 3 cannot exceed the SS wage base, even if the running total of
  // signed amendment deltas pushed past it. min() handles both directions.
  // Tips are social security tips (Box 7), not Box 3 wages; together they stop at the base.
  const box3SsWages = Math.min(preCapSsWages - tipsTotal, ssWageBase);
  const box7SsTips = Math.max(0, Math.min(tipsTotal, ssWageBase - box3SsWages));

  const stateLines: W2StateLine[] = [...stateBuckets.entries()]
    .map(([state, b]) => ({
      state,
      stateWages: round2(b.wages),
      stateIncomeTax: round2(b.tax),
    }))
    .filter((l) => l.stateWages !== 0 || l.stateIncomeTax !== 0)
    .sort((a, b) => a.state.localeCompare(b.state));

  return {
    box1Wages: round2(box1Wages),
    box2FitWithheld: round2(box2FitWithheld),
    box3SsWages: round2(box3SsWages),
    box4SsTax: round2(box4SsTax),
    box5MedicareWages: round2(box5MedicareWages),
    box6MedicareTax: round2(box6MedicareTax),
    box7SsTips: round2(box7SsTips),
    box10DependentCare: round2(dependentCare),
    box12: BOX12_ORDER.filter((c) => round2(codes.get(c) ?? 0) !== 0).map((c) => ({ code: c, amount: round2(codes.get(c)!) })),
    box14bTippedOccupationCodes: taxYear >= 2026 ? [...occupationCodes].sort().slice(0, 2) : [],
    box13ThirdPartySickPay: thirdPartySick,
    stateLines,
    sourceItemCount: items.length,
  };
}

/**
 * Returns associates who had at least one qualifying paystub in the year,
 * scoped to one client (or all clients if clientId is null). Used by the
 * generate route to know whom to build W-2s for.
 */
/**
 * Tier-2 — the distinct employers (run clientIds, null = cross-client
 * internal) that paid this associate in the year. One W-2 per entry.
 */
export async function listEmployerClientIds(
  tx: Tx,
  associateId: string,
  taxYear: number,
): Promise<Array<string | null>> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));
  const runs = await tx.payrollRun.findMany({
    where: {
      status: { not: 'CANCELLED' },
      disbursedAt: { gte: yearStart, lt: yearEndExclusive },
      items: { some: { associateId, status: { not: 'VOIDED' } } },
    },
    select: { clientId: true },
    distinct: ['clientId'],
  });
  return runs.map((r) => r.clientId);
}

export async function listW2EligibleAssociates(
  tx: Tx,
  taxYear: number,
  clientId: string | null,
): Promise<string[]> {
  const yearStart = new Date(Date.UTC(taxYear, 0, 1));
  const yearEndExclusive = new Date(Date.UTC(taxYear + 1, 0, 1));

  const rows = await tx.payrollItem.findMany({
    where: {
      status: { not: 'VOIDED' },
      associate: { employmentType: 'W2_EMPLOYEE' },
      payrollRun: {
        status: { not: 'CANCELLED' },
        disbursedAt: { gte: yearStart, lt: yearEndExclusive },
        ...(clientId ? { clientId } : {}),
      },
    },
    select: { associateId: true },
    distinct: ['associateId'],
  });

  return rows.map((r) => r.associateId);
}
