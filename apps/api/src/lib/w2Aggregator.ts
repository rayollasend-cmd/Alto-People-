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
import { ITEM_BASES_SELECT, basesOf, type ItemBases } from './wageBases.js';
import { employerFor, stateAccountNumbers } from './payrollTaxLedger.js';

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
   * Box 12 — coded amounts, in the form's code order (A … Z, AA … II, then
   * the 2026 codes TA, TP, TT). Source: IRS 2026 General Instructions for
   * Forms W-2 and W-3.
   */
  box12?: W2Box12Entry[];
  /** Box 13 — Retirement plan: an active participant this year (deferrals or employer contributions). */
  box13RetirementPlan?: boolean;
  /** Box 14a — Other: state disability / paid-leave withholding (CASDI, NJFLI, NYPFL, WA PFML …), union dues, after-tax items. */
  box14Other?: W2Box14Entry[];
  /** Box 14b — Treasury Tipped Occupation Code(s) (TY2026+), at most two. */
  box14bTippedOccupationCodes?: string[];
  /** Box 13 — Third-party sick pay: checked when the employer reports insurer-paid sick pay (lib/manualChecks). */
  box13ThirdPartySickPay?: boolean;
  /** Box 15-17 — One block per state with wages or withholding (a two-state worker gets two). */
  stateLines: W2StateLine[];
  /** Box 18-20 — One block per locality with wages or withholding (PA EIT/LST, Ohio city/school, NYC, Yonkers …). */
  localLines?: W2LocalLine[];
  /** Source items, count only — for a sanity check on the UI. */
  sourceItemCount: number;
}

export type W2Box12Code =
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'J' | 'K' | 'L' | 'M' | 'N' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'V' | 'W' | 'Y' | 'Z'
  | 'AA' | 'BB' | 'DD' | 'EE' | 'FF' | 'GG' | 'HH' | 'II'
  | 'TA' | 'TP' | 'TT';
export interface W2Box12Entry {
  code: W2Box12Code;
  amount: number;
}
export interface W2Box14Entry {
  label: string;
  amount: number;
}
/** IRS order of codes on the form. */
export const BOX12_ORDER: W2Box12Code[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y', 'Z', 'AA', 'BB', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'TA', 'TP', 'TT'];

export interface W2StateLine {
  /** Two-letter USPS code. */
  state: string;
  /** Box 16 — State wages under that state's rules (PA includes 401(k) deferrals; a resident line carries all wages). */
  stateWages: number;
  /** Box 17 — State income tax withheld. */
  stateIncomeTax: number;
  /** The worker lived in this state (resident line). */
  resident?: boolean;
  /** Box 15 — the employer's state ID number for this state (its withholding account). */
  employerStateId?: string | null;
}

export interface W2LocalLine {
  /** The state the locality is in (Box 15 of the same row). */
  state: string | null;
  /** Box 20 — Locality name. */
  locality: string;
  /** Engine jurisdiction code (PSD, city code …). */
  code: string;
  /** LOCAL | SCHOOL | OLT | TRANSIT */
  kind: string;
  /** Box 18 — Local wages. */
  localWages: number;
  /** Box 19 — Local income tax. */
  localIncomeTax: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Helper — pull SS wage base for any historical year. */
export async function getSsWageBaseForYear(tx: Tx, taxYear: number): Promise<number> {
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
  const items = (
    await tx.payrollItem.findMany({
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
      select: ITEM_BASES_SELECT,
    })
  ).map(basesOf);

  // Insurer-paid sick pay the employer reports (PAYEXP §3): the taxable
  // part is wages in Boxes 1/3/5 with the insurer's withholding; the part
  // bought with the employee's after-tax premiums is Box 12 J. Not tied to
  // a client's EIN — it follows the tenant's own W-2.
  const sickPay: ThirdPartySickPayLine[] = [];
  if (employerClientId === undefined || (employerClientId !== null && typeof employerClientId === 'object')) {
    const sick = await tx.thirdPartySickPay.findMany({
      where: { associateId, voidedAt: null, w2ReportedBy: 'EMPLOYER', payDate: { gte: yearStart, lt: yearEndExclusive } },
      select: { grossAmount: true, nontaxableAmount: true, federalWithheld: true, socialSecurityWithheld: true, medicareWithheld: true, stateWithheld: true, associate: { select: { state: true } } },
    });
    for (const r of sick) {
      sickPay.push({
        taxable: Number(r.grossAmount) - Number(r.nontaxableAmount),
        nontaxable: Number(r.nontaxableAmount),
        federalWithheld: Number(r.federalWithheld),
        socialSecurityWithheld: Number(r.socialSecurityWithheld),
        medicareWithheld: Number(r.medicareWithheld),
        stateWithheld: Number(r.stateWithheld),
        state: r.associate.state?.toUpperCase() ?? null,
      });
    }
  }

  const boxes = boxesFromBases(items, await getSsWageBaseForYear(tx, taxYear), taxYear, sickPay);
  // Box 15's state ID: this employer's withholding account in each state.
  if (boxes.stateLines.length) {
    const ids = await stateAccountNumbers(tx, await employerFor(tx, typeof employerClientId === 'string' ? employerClientId : null)).catch(() => ({}) as Record<string, string>);
    boxes.stateLines = boxes.stateLines.map((l) => (ids[l.state] ? { ...l, employerStateId: ids[l.state] } : l));
  }
  return boxes;
}

/** Insurer-paid sick pay the employer puts on its W-2. */
export interface ThirdPartySickPayLine {
  taxable: number;
  nontaxable: number;
  federalWithheld: number;
  socialSecurityWithheld: number;
  medicareWithheld: number;
  stateWithheld: number;
  state: string | null;
}

/**
 * The W-2 boxes from a person's paid checks (lib/wageBases) — pure, so the
 * W-2, the year-end reconciliation and previews compute boxes one way.
 */
export function boxesFromBases(items: ItemBases[], ssWageBase: number, taxYear: number, sickPay: ThirdPartySickPayLine[] = []): W2Boxes {
  let box1Wages = 0;
  let box2FitWithheld = 0;
  let box5MedicareWages = 0;
  let box6MedicareTax = 0;
  let preCapSsWages = 0;
  let box4SsTax = 0;
  let tipsTotal = 0;
  let dependentCare = 0;
  let retirementPlan = false;
  const codes = new Map<string, number>();
  const occupationCodes = new Set<string>();
  const addCode = (c: string, n: number) => codes.set(c, (codes.get(c) ?? 0) + n);
  const stateBuckets = new Map<string, { wages: number; tax: number; resident: boolean }>();
  const localBuckets = new Map<string, W2LocalLine>();
  const box14 = new Map<string, number>();

  // Each check's bases (lib/wageBases): itemized deduction lines and the tax
  // engine's per-jurisdiction lines when the check has them; the lump
  // columns (§125 lowers every base, 401(k) only Box 1) when it doesn't.
  for (const b of items) {
    box1Wages += b.fitWages;
    box2FitWithheld += b.fit;
    box5MedicareWages += b.medicareWages;
    box6MedicareTax += b.medicareEmployee;
    preCapSsWages += b.ssWages;
    box4SsTax += b.ssEmployee;
    tipsTotal += b.tips;
    dependentCare += b.box10;
    retirementPlan ||= b.retirementPlan;
    for (const [c, n] of Object.entries(b.box12)) addCode(c, n);
    if (b.tippedOccupationCode && b.tips > 0) occupationCodes.add(b.tippedOccupationCode);
    for (const e of b.box14) box14.set(e.label, (box14.get(e.label) ?? 0) + e.amount);
    for (const st of b.states) {
      const s = stateBuckets.get(st.state) ?? { wages: 0, tax: 0, resident: false };
      s.wages += st.wages;
      s.tax += st.withheld;
      s.resident ||= st.resident;
      stateBuckets.set(st.state, s);
    }
    for (const l of b.locals) {
      if (l.employer) continue; // employer-paid local taxes are not the worker's W-2
      const key = `${l.state ?? ''}|${l.code}`;
      const x = localBuckets.get(key) ?? { state: l.state, locality: l.label, code: l.code, kind: l.kind, localWages: 0, localIncomeTax: 0 };
      x.localWages += l.wages;
      x.localIncomeTax += l.withheld;
      localBuckets.set(key, x);
    }
  }

  let thirdPartySick = false;
  for (const r of sickPay) {
    thirdPartySick = true;
    box1Wages += r.taxable;
    box2FitWithheld += r.federalWithheld;
    preCapSsWages += r.taxable;
    box4SsTax += r.socialSecurityWithheld;
    box5MedicareWages += r.taxable;
    box6MedicareTax += r.medicareWithheld;
    addCode('J', r.nontaxable);
    if (r.state && (r.stateWithheld > 0 || r.taxable > 0)) {
      const b = stateBuckets.get(r.state) ?? { wages: 0, tax: 0, resident: false };
      b.wages += r.taxable;
      b.tax += r.stateWithheld;
      stateBuckets.set(r.state, b);
    }
  }

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
      ...(b.resident ? { resident: true } : {}),
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
    box13RetirementPlan: retirementPlan,
    box14Other: [...box14.entries()].filter(([, n]) => round2(n) !== 0).map(([label, amount]) => ({ label, amount: round2(amount) })).sort((a, b) => a.label.localeCompare(b.label)),
    box14bTippedOccupationCodes: taxYear >= 2026 ? [...occupationCodes].sort().slice(0, 2) : [],
    box13ThirdPartySickPay: thirdPartySick,
    stateLines,
    localLines: [...localBuckets.values()]
      .map((l) => ({ ...l, localWages: round2(l.localWages), localIncomeTax: round2(l.localIncomeTax) }))
      .filter((l) => l.localWages !== 0 || l.localIncomeTax !== 0)
      .sort((a, b) => `${a.state}${a.locality}`.localeCompare(`${b.state}${b.locality}`)),
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
