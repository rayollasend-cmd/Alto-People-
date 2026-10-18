import type { GarnishmentKind } from '@prisma/client';

/**
 * How much each withholding order takes from one paycheck — the rules a
 * payroll department is audited on, in one pure function.
 *
 *   Order of priority (federal law and common practice):
 *     1. Child and medical support (Social Security Act §466(b); an IWO
 *        takes priority over every other garnishment).
 *     2. Federal tax levies (IRC §6334) — after support issued before them.
 *     3. Chapter 13 bankruptcy wage orders (they stay ordinary creditors).
 *     4. Federal student-loan administrative wage garnishment (AWG).
 *     5. Ordinary creditor garnishments, first in time.
 *
 *   Limits (Consumer Credit Protection Act, 15 U.S.C. §1673):
 *     - Support: 50% of disposable earnings when the person supports a second
 *       family, 60% when not, plus 5% when payments are 12+ weeks in
 *       arrears. A state may set a lower limit (GarnishmentStateRule).
 *     - Creditor: the lesser of 25% of disposable earnings or the amount by
 *       which disposable earnings exceed 30 × the federal minimum wage for
 *       the pay period ($217.50 weekly at $7.25). Support already withheld
 *       counts against the 25%: when support takes 25% or more, an
 *       ordinary creditor gets nothing (DOL Fact Sheet #30).
 *     - Student loan (AWG, 31 CFR 285.11): 15% of disposable earnings, within
 *       the same 25% non-support ceiling.
 *     - Federal tax levy: everything above the Publication 1494 exempt
 *       amount of take-home pay; not subject to the CCPA percentages.
 *     - Bankruptcy: the court's amount.
 *
 *   Several support orders: when they don't all fit under the limit, the
 *   state decides how to split them — most prorate current support (OCSE
 *   Action Transmittal 97-13 and state IWO rules); some fill first in time.
 *   Current support is satisfied before arrears either way.
 *
 *   Employer fees: where the state allows a processing fee, it comes out of
 *   the employee's pay too, kept by the employer, and it counts toward the
 *   same limit as the order it is charged on.
 *
 * Pure: no database. The caller persists the amounts.
 */

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

export const FEDERAL_MINIMUM_WAGE = 7.25;

const PERIODS_PER_YEAR: Record<PayFrequency, number> = { WEEKLY: 52, BIWEEKLY: 26, SEMIMONTHLY: 24, MONTHLY: 12 };

/** 30 × the federal minimum wage, stated per pay period (DOL Fact Sheet #30 figures at $7.25). */
export function minimumWageFloor(frequency: PayFrequency, federalMinimumWage = FEDERAL_MINIMUM_WAGE): number {
  const weekly = 30 * federalMinimumWage;
  switch (frequency) {
    case 'WEEKLY':
      return round2(weekly);
    case 'BIWEEKLY':
      return round2(weekly * 2);
    case 'SEMIMONTHLY':
      return round2((weekly * 52) / 24);
    case 'MONTHLY':
      return round2((weekly * 52) / 12);
  }
}

/** An amount stated per one frequency, restated per another (annualized). */
export function convertFrequency(amount: number, from: PayFrequency, to: PayFrequency): number {
  if (from === to) return amount;
  return round2((amount * PERIODS_PER_YEAR[from]) / PERIODS_PER_YEAR[to]);
}

export interface StateRule {
  allocationMethod: 'PRO_RATA' | 'FIRST_IN_TIME';
  /** A lower support limit than the federal one, as a fraction. */
  supportMaxPercent?: number | null;
  /** A lower creditor limit than 25%, as a fraction. */
  creditorMaxPercent?: number | null;
  adminFeeMax?: number | null;
  adminFeeFrequency?: 'PER_PAYMENT' | 'MONTHLY' | 'ONE_TIME' | null;
}

export interface EngineOrder {
  id: string;
  kind: GarnishmentKind;
  priority: number;
  receivedAt?: Date | null;
  state?: string | null;
  /** A flat amount per pay period (manual orders). */
  amountPerRun?: number | null;
  /** A fraction of disposable earnings (manual orders). */
  percentOfDisp?: number | null;
  totalCap?: number | null;
  amountWithheld?: number;
  /** IWO amounts, stated per `orderFrequency`. */
  currentSupport?: number | null;
  pastDueSupport?: number | null;
  medicalSupport?: number | null;
  orderFrequency?: PayFrequency | null;
  arrearsOver12Weeks?: boolean;
  supportsSecondFamily?: boolean;
  /** The employer's fee on this order, per payment (before the state's maximum). */
  adminFee?: number | null;
  /** Federal levy: the Publication 1494 exempt amount for this pay period. */
  levyExemptPerPeriod?: number | null;
}

export interface EngineInput {
  /** Gross minus the deductions required by law (taxes). */
  disposableEarnings: number;
  /** For a federal levy: pay after taxes and the deductions in effect before the levy. Defaults to disposable. */
  takeHomePay?: number;
  /** Omitted: the minimum-wage floor isn't applied (it depends on the period). */
  payFrequency?: PayFrequency;
  orders: EngineOrder[];
  stateRules?: Record<string, StateRule>;
  /** Orders whose MONTHLY or ONE_TIME fee was already charged in its window. */
  feeAlreadyCharged?: Set<string>;
  federalMinimumWage?: number;
}

export interface EngineDeduction {
  garnishmentId: string;
  amount: number;
  adminFee: number;
  reachedCap: boolean;
  /** Why it got less than it asked for, in words a payroll admin can repeat. */
  note: string | null;
}

export interface EngineResult {
  deductions: EngineDeduction[];
  /** Garnishment amounts withheld (fees excluded). */
  total: number;
  adminFeeTotal: number;
  /** Orders that took nothing this paycheck, and why. */
  skipped: Array<{ garnishmentId: string; note: string }>;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const SUPPORT: GarnishmentKind[] = ['CHILD_SUPPORT'];

function remainingCap(o: EngineOrder): number {
  return o.totalCap != null ? Math.max(0, round2(o.totalCap - (o.amountWithheld ?? 0))) : Infinity;
}

/** What a support order asks for this period: current (incl. medical) and arrears. */
function supportRequest(o: EngineOrder, freq: PayFrequency | undefined, disposable: number): { current: number; arrears: number } {
  const hasIwoAmounts = o.currentSupport != null || o.pastDueSupport != null || o.medicalSupport != null;
  if (hasIwoAmounts) {
    const from = o.orderFrequency ?? freq ?? 'MONTHLY';
    const to = freq ?? from;
    return {
      current: convertFrequency((o.currentSupport ?? 0) + (o.medicalSupport ?? 0), from, to),
      arrears: convertFrequency(o.pastDueSupport ?? 0, from, to),
    };
  }
  const flat = o.amountPerRun != null ? o.amountPerRun : o.percentOfDisp != null ? disposable * o.percentOfDisp : 0;
  return { current: round2(flat), arrears: 0 };
}

/** Split `pool` across requests by the state's method; never more than each asks. */
function allocate(requests: Array<{ id: string; ask: number; receivedAt: number }>, pool: number, method: 'PRO_RATA' | 'FIRST_IN_TIME'): Map<string, number> {
  const out = new Map<string, number>();
  const total = requests.reduce((s, r) => s + r.ask, 0);
  if (total <= 0 || pool <= 0) {
    for (const r of requests) out.set(r.id, 0);
    return out;
  }
  if (total <= pool) {
    for (const r of requests) out.set(r.id, round2(r.ask));
    return out;
  }
  if (method === 'FIRST_IN_TIME') {
    let left = pool;
    for (const r of [...requests].sort((a, b) => a.receivedAt - b.receivedAt)) {
      const take = round2(Math.min(r.ask, left));
      out.set(r.id, take);
      left = round2(left - take);
    }
    return out;
  }
  // Pro rata by each order's share of the total asked; pennies go to the largest order.
  let given = 0;
  let largest = requests[0]!;
  for (const r of requests) {
    const share = Math.floor(((pool * r.ask) / total) * 100) / 100;
    out.set(r.id, share);
    given += share;
    if (r.ask > largest.ask) largest = r;
  }
  out.set(largest.id, round2((out.get(largest.id) ?? 0) + round2(pool - given)));
  return out;
}

export function computeWithholding(input: EngineInput): EngineResult {
  const D = Math.max(0, round2(input.disposableEarnings));
  const freq = input.payFrequency;
  const rules = input.stateRules ?? {};
  const fmw = input.federalMinimumWage ?? FEDERAL_MINIMUM_WAGE;
  const deductions = new Map<string, EngineDeduction>();
  const skipped: EngineResult['skipped'] = [];
  const orders = [...input.orders].sort((a, b) => a.priority - b.priority || (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0));
  let remaining = D;
  const set = (o: EngineOrder, amount: number, note: string | null) => {
    const amt = round2(Math.max(0, amount));
    if (amt <= 0) {
      skipped.push({ garnishmentId: o.id, note: note ?? 'Nothing due this paycheck.' });
      return;
    }
    const cap = remainingCap(o);
    deductions.set(o.id, { garnishmentId: o.id, amount: amt, adminFee: 0, reachedCap: cap !== Infinity && amt >= cap - 0.005, note });
    remaining = round2(remaining - amt);
  };
  if (D <= 0) {
    for (const o of orders) skipped.push({ garnishmentId: o.id, note: 'No disposable earnings this paycheck.' });
    return { deductions: [], total: 0, adminFeeTotal: 0, skipped };
  }

  /* 1. Support -------------------------------------------------------------- */
  const support = orders.filter((o) => SUPPORT.includes(o.kind));
  let supportTaken = 0;
  if (support.length) {
    const secondFamily = support.some((o) => o.supportsSecondFamily);
    const arrears12 = support.some((o) => o.arrearsOver12Weeks);
    const stateOf = support.find((o) => o.state && rules[o.state])?.state ?? null;
    const rule = stateOf ? rules[stateOf] : undefined;
    const federal = (secondFamily ? 0.5 : 0.6) + (arrears12 ? 0.05 : 0);
    const limit = Math.min(federal, rule?.supportMaxPercent ?? federal);
    const cap = round2(Math.min(D * limit, remaining));
    const method = rule?.allocationMethod ?? 'PRO_RATA';
    const reqs = support.map((o) => ({ o, ...supportRequest(o, freq, D) }));
    const currentAlloc = allocate(
      reqs.map((r) => ({ id: r.o.id, ask: Math.min(r.current, remainingCap(r.o)), receivedAt: r.o.receivedAt?.getTime() ?? 0 })),
      cap,
      method,
    );
    const currentUsed = [...currentAlloc.values()].reduce((s, v) => s + v, 0);
    const arrearsAlloc = allocate(
      reqs.map((r) => ({ id: r.o.id, ask: Math.max(0, Math.min(r.arrears, remainingCap(r.o) - (currentAlloc.get(r.o.id) ?? 0))), receivedAt: r.o.receivedAt?.getTime() ?? 0 })),
      round2(cap - currentUsed),
      method,
    );
    for (const r of reqs) {
      const amt = round2((currentAlloc.get(r.o.id) ?? 0) + (arrearsAlloc.get(r.o.id) ?? 0));
      const asked = round2(r.current + r.arrears);
      const note =
        amt + 0.005 < asked
          ? `Held to the ${Math.round(limit * 100)}% support limit${support.length > 1 ? ` and split ${method === 'PRO_RATA' ? 'pro rata' : 'first in time'} with the other orders` : ''}.`
          : null;
      set(r.o, amt, note);
      supportTaken = round2(supportTaken + amt);
    }
  }

  /* 2. Federal tax levy --------------------------------------------------- */
  for (const o of orders.filter((x) => x.kind === 'TAX_LEVY')) {
    if (o.levyExemptPerPeriod != null) {
      const takeHome = round2((input.takeHomePay ?? D) - supportTaken);
      const due = Math.max(0, round2(takeHome - o.levyExemptPerPeriod));
      set(o, Math.min(due, remainingCap(o), remaining), due > 0 ? null : 'Take-home pay is within the levy’s exempt amount.');
    } else {
      // A state levy, or one whose exempt amount wasn't entered: the stated amount.
      const want = o.amountPerRun ?? (o.percentOfDisp != null ? D * o.percentOfDisp : 0);
      set(o, Math.min(want, remainingCap(o), remaining), want > 0 ? null : 'Enter the levy’s exempt amount (Publication 1494) or a stated amount.');
    }
  }

  /* 3. Bankruptcy --------------------------------------------------------- */
  for (const o of orders.filter((x) => x.kind === 'BANKRUPTCY')) {
    const want = o.amountPerRun ?? (o.percentOfDisp != null ? D * o.percentOfDisp : 0);
    set(o, Math.min(want, remainingCap(o), remaining), null);
  }

  /* 4–5. Student loan, then creditors, under the 25% non-support ceiling --- */
  const creditorStateRule = (o: EngineOrder) => (o.state ? rules[o.state] : undefined);
  const floorRoom = freq ? Math.max(0, round2(D - minimumWageFloor(freq, fmw))) : Infinity;
  let nonSupportTaken = 0;
  for (const o of orders.filter((x) => x.kind === 'STUDENT_LOAN')) {
    const ceiling = Math.min(D * 0.15, floorRoom);
    const room = Math.max(0, round2(Math.min(D * 0.25, floorRoom) - supportTaken - nonSupportTaken));
    const want = o.amountPerRun ?? D * (o.percentOfDisp ?? 0.15);
    const amt = Math.min(want, ceiling, room, remainingCap(o), remaining);
    set(o, amt, amt + 0.005 < want ? (room <= 0 ? 'Support already takes the 25% that student-loan garnishment may reach.' : 'Held to 15% of disposable earnings.') : null);
    nonSupportTaken = round2(nonSupportTaken + Math.max(0, round2(amt)));
  }
  const creditors = orders
    .filter((x) => x.kind === 'CREDITOR' || x.kind === 'OTHER')
    .sort((a, b) => (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0) || a.priority - b.priority);
  for (const o of creditors) {
    const stateLimit = creditorStateRule(o)?.creditorMaxPercent;
    const pct = stateLimit != null ? Math.min(0.25, stateLimit) : 0.25;
    const ceiling = Math.min(D * pct, floorRoom);
    const room = Math.max(0, round2(ceiling - supportTaken - nonSupportTaken));
    const want = o.amountPerRun ?? (o.percentOfDisp != null ? D * o.percentOfDisp : 0);
    if (want <= 0) {
      skipped.push({ garnishmentId: o.id, note: 'The order states no amount.' });
      continue;
    }
    const amt = Math.min(want, room, remainingCap(o), remaining);
    const note =
      amt + 0.005 < want
        ? room <= 0
          ? supportTaken > 0
            ? 'Support already takes the 25% an ordinary creditor may reach.'
            : 'Disposable earnings are under 30 times the federal minimum wage, or earlier orders use the 25%.'
          : `Held to ${Math.round(pct * 100)}% of disposable earnings.`
        : null;
    set(o, amt, note);
    nonSupportTaken = round2(nonSupportTaken + Math.max(0, round2(amt)));
  }

  /* Employer fees ---------------------------------------------------------- */
  let adminFeeTotal = 0;
  for (const o of orders) {
    const d = deductions.get(o.id);
    if (!d) continue;
    const rule = o.state ? rules[o.state] : undefined;
    const asked = o.adminFee ?? rule?.adminFeeMax ?? 0;
    if (asked <= 0) continue;
    const freqRule = rule?.adminFeeFrequency ?? 'PER_PAYMENT';
    if (freqRule !== 'PER_PAYMENT' && input.feeAlreadyCharged?.has(o.id)) continue;
    const fee = rule?.adminFeeMax != null ? Math.min(asked, rule.adminFeeMax) : asked;
    // Fees count toward the limit of the order they ride on.
    const limitRoom = SUPPORT.includes(o.kind)
      ? Math.max(0, round2(D * Math.min((o.supportsSecondFamily ? 0.5 : 0.6) + (o.arrearsOver12Weeks ? 0.05 : 0), rule?.supportMaxPercent ?? 1) - supportTaken))
      : o.kind === 'CREDITOR' || o.kind === 'OTHER' || o.kind === 'STUDENT_LOAN'
        ? Math.max(0, round2(Math.min(D * 0.25, floorRoom) - supportTaken - nonSupportTaken))
        : remaining;
    const take = round2(Math.min(fee, limitRoom, remaining));
    if (take > 0) {
      d.adminFee = take;
      adminFeeTotal = round2(adminFeeTotal + take);
      remaining = round2(remaining - take);
      if (SUPPORT.includes(o.kind)) supportTaken = round2(supportTaken + take);
      else nonSupportTaken = round2(nonSupportTaken + take);
    }
  }

  const list = orders.map((o) => deductions.get(o.id)).filter((d): d is EngineDeduction => !!d);
  return { deductions: list, total: round2(list.reduce((s, d) => s + d.amount, 0)), adminFeeTotal, skipped };
}

/* ----- IRS Publication 1494 ------------------------------------------------ */

export interface LevyParameters {
  standardDeduction: number;
  additionalStandardDeduction: number;
  exemptionAmount: number;
}

/**
 * The exempt amount of take-home pay per pay period for a federal levy
 * (IRC §6334(d)): the standard deduction for the filing status, plus any
 * additional standard deduction (65+ or blind, from Form 668-W Part 3), plus
 * the exemption amount for each dependent claimed — annual, divided by the
 * pay periods. Publication 1494's tables are this formula, rounded; the
 * figures are entered per tax year from the publication.
 */
export function levyExemptPerPeriod(p: LevyParameters, dependents: number, additionalCount: number, frequency: PayFrequency): number {
  const annual = p.standardDeduction + additionalCount * p.additionalStandardDeduction + Math.max(0, dependents) * p.exemptionAmount;
  return round2(annual / PERIODS_PER_YEAR[frequency]);
}
