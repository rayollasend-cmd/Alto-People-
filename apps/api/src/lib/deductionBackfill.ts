import type { Prisma, PrismaClient } from '@prisma/client';
import { LOCAL_TAX_STATES, type TaxabilityContext } from './deductionTaxability.js';
import { garnishmentLabel, line, reconcile, type DeductionLine } from './deductionLines.js';
import { readDeferrals } from './retirementDeferrals.js';

/**
 * The itemized deduction lines of a paycheck cut BEFORE PayrollItemDeduction
 * existed, derived from what the check recorded: the deferrals JSON, the
 * garnishment deductions of its run, the retirement contributions, the
 * ride charges, the earned-wage recoveries, and the lump columns for the
 * rest. One derivation, used by two readers:
 *
 *   scripts/backfill-deduction-lines.ts   writes the lines down, once
 *   lib/paystubData                       reads them in memory when a check
 *                                         still has none, so an old paystub
 *                                         itemizes whether or not the
 *                                         backfill has run on this deploy
 *
 * Each line's exemptFrom carries TODAY's federal and state treatment
 * (lib/deductionTaxability) for the check's work state and the person's
 * home state.
 */

export type LegacyDeductionDb = Pick<PrismaClient, 'garnishmentDeduction' | 'retirementContribution' | 'earnedWageAdvance'>;

export interface LegacyDeductionItem {
  id: string;
  associateId: string;
  payrollRunId: string;
  preTaxDeductions: Prisma.Decimal | number;
  postTaxDeductions: Prisma.Decimal | number;
  preTaxRetirement: Prisma.Decimal | number;
  deferrals: Prisma.JsonValue;
  rideChargesCents: number;
  taxState: string | null;
  associate: { state: string | null };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** True when the check carries any deduction the lines could itemize. */
export function hasLegacyDeductions(it: Pick<LegacyDeductionItem, 'preTaxDeductions' | 'postTaxDeductions' | 'preTaxRetirement' | 'deferrals'>): boolean {
  return Number(it.preTaxDeductions) !== 0 || Number(it.postTaxDeductions) !== 0 || Number(it.preTaxRetirement) !== 0 || (it.deferrals !== null && it.deferrals !== undefined);
}

export function legacyTaxabilityContext(it: Pick<LegacyDeductionItem, 'taxState' | 'associate'>): TaxabilityContext {
  const states = [it.taxState, it.associate.state].filter((s): s is string => !!s).map((s) => s.toUpperCase());
  return {
    workStates: it.taxState ? [it.taxState.toUpperCase()] : [],
    residentState: it.associate.state?.toUpperCase() ?? null,
    localApplies: states.some((s) => LOCAL_TAX_STATES.has(s)),
  };
}

/** The lines one old check becomes; empty when it carried no deductions. */
export async function deriveLegacyDeductionLines(db: LegacyDeductionDb, it: LegacyDeductionItem): Promise<DeductionLine[]> {
  if (!hasLegacyDeductions(it)) return [];
  const ctx = legacyTaxabilityContext(it);
  const d = readDeferrals(it.deferrals, Number(it.preTaxRetirement));
  const lines: DeductionLine[] = [];
  const add = (l: DeductionLine) => {
    if (l.employeeAmount !== 0 || l.employerAmount !== 0) lines.push(l);
  };
  add(line('RET_401K', { employee: d.pre401k }, ctx));
  add(line('RET_403B', { employee: d.pre403b }, ctx));
  add(line('HSA', { employee: d.hsa }, ctx));
  add(line('HEALTH_FSA', { employee: d.fsa }, ctx));
  add(line('DCAP', { employee: d.dcap }, ctx));
  const named = r2(d.pre401k + d.pre403b + d.hsa + d.fsa + d.dcap);
  const otherPre = r2(Number(it.preTaxDeductions) - named);
  if (otherPre > 0) add(line('MEDICAL', { employee: otherPre }, ctx, { label: 'Health & benefits (before itemizing)', w2Box12Code: null }));
  add(line('ER_TRUMP_ACCOUNT', { employer: d.trumpAccountEmployer }, ctx));

  add(line('ROTH_401K', { employee: d.roth401k }, ctx));
  add(line('ROTH_403B', { employee: d.roth403b }, ctx));
  const [garns, contrib, ewa] = await Promise.all([
    db.garnishmentDeduction.findMany({
      where: { payrollRunId: it.payrollRunId, garnishment: { associateId: it.associateId } },
      select: { amount: true, adminFee: true, garnishmentId: true, garnishment: { select: { kind: true, caseNumber: true, state: true, agencyName: true } } },
    }),
    db.retirementContribution.findMany({ where: { payrollItemId: it.id }, select: { employerMatch: true, safeHarbor: true, loanRepayments: true, planId: true } }),
    db.earnedWageAdvance.findMany({ where: { associateId: it.associateId, recoveryLog: { array_contains: [{ runId: it.payrollRunId }] } }, select: { id: true, recoveryLog: true } }),
  ]);
  for (const g of garns) {
    add(line('GARNISHMENT', { employee: Number(g.amount) }, ctx, { sourceType: 'Garnishment', sourceId: g.garnishmentId, label: garnishmentLabel(g.garnishment) }));
    add(line('GARNISHMENT_FEE', { employee: Number(g.adminFee) }, ctx, { sourceType: 'Garnishment', sourceId: g.garnishmentId }));
  }
  for (const c of contrib) {
    const loans = Array.isArray(c.loanRepayments) ? (c.loanRepayments as Array<{ loanNumber: string; amount: number }>) : [];
    for (const l of loans) add(line('RET_LOAN', { employee: l.amount }, ctx, { sourceType: 'RetirementLoan', label: `401(k) loan ${l.loanNumber}` }));
    add(line('ER_401K_MATCH', { employer: r2(Number(c.employerMatch) + Number(c.safeHarbor)) }, ctx, { sourceType: 'RetirementPlan', sourceId: c.planId }));
  }
  add(line('RIDES', { employee: r2(it.rideChargesCents / 100) }, ctx, { sourceType: 'RideCharge' }));
  const ewaCents = ewa.reduce(
    (s, a) => s + (Array.isArray(a.recoveryLog) ? (a.recoveryLog as Array<{ runId: string; cents: number }>) : []).filter((x) => x.runId === it.payrollRunId).reduce((t, x) => t + x.cents, 0),
    0,
  );
  add(line('EWA_RECOVERY', { employee: r2(ewaCents / 100) }, ctx, { sourceType: 'EarnedWageAdvance' }));

  return reconcile(lines, { preTax: Number(it.preTaxDeductions), postTax: Number(it.postTaxDeductions) }, ctx).map((l) =>
    l.code === 'AFTER_TAX_OTHER' && !l.sourceType ? { ...l, label: 'Other deductions (before itemizing)' } : l,
  );
}

/** The select a reader needs to derive lines for an item that has none. */
export const LEGACY_DEDUCTION_SELECT = {
  id: true,
  associateId: true,
  payrollRunId: true,
  preTaxDeductions: true,
  postTaxDeductions: true,
  preTaxRetirement: true,
  deferrals: true,
  rideChargesCents: true,
  taxState: true,
  associate: { select: { state: true } },
} satisfies Prisma.PayrollItemSelect;
