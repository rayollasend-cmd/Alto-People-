import type { Prisma } from '@prisma/client';
import { CODES, codeForPlanKind, exemptBasesFor, type DeductionCategory, type DeductionCode, type TaxabilityContext } from './deductionTaxability.js';
import type { PlanDeduction } from './retirementDeferrals.js';

/**
 * The itemized deduction lines of one paycheck (PayrollItemDeduction):
 * built from what the pay calculation already decided — each benefit plan's
 * share, each garnishment order, each 401(k) loan, the employer's
 * contributions — with the wage bases each one lowered (lib/deductionTaxability).
 *
 * The lump columns on PayrollItem stay the sums of these lines:
 *   preTaxDeductions  = Σ PRE_TAX employeeAmount
 *   postTaxDeductions = Σ POST_TAX employeeAmount
 *   preTaxRetirement  = Σ PRE_TAX deferral lines (401(k)/403(b)/457(b))
 */

export interface DeductionLine {
  code: DeductionCode;
  category: DeductionCategory;
  label: string;
  employeeAmount: number;
  employerAmount: number;
  sourceType: string | null;
  sourceId: string | null;
  exemptFrom: string[];
  w2Box12Code: string | null;
  w2Box14Label: string | null;
  w2Box10: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function line(code: DeductionCode, amounts: { employee?: number; employer?: number }, ctx: TaxabilityContext, extra: Partial<Pick<DeductionLine, 'label' | 'sourceType' | 'sourceId' | 'w2Box12Code'>> = {}): DeductionLine {
  const spec = CODES[code];
  return {
    code,
    category: spec.category,
    label: extra.label ?? spec.label,
    employeeAmount: r2(amounts.employee ?? 0),
    employerAmount: r2(amounts.employer ?? 0),
    sourceType: extra.sourceType ?? null,
    sourceId: extra.sourceId ?? null,
    exemptFrom: exemptBasesFor(code, ctx),
    w2Box12Code: extra.w2Box12Code !== undefined ? extra.w2Box12Code : spec.box12 ?? null,
    w2Box14Label: spec.box14 ?? null,
    w2Box10: spec.box10 === true,
  };
}

const GARN_KIND_LABEL: Record<string, string> = {
  CHILD_SUPPORT: 'Child support',
  TAX_LEVY: 'Tax levy',
  STUDENT_LOAN: 'Student loan',
  BANKRUPTCY: 'Chapter 13 trustee',
  CREDITOR: 'Wage garnishment',
  OTHER: 'Garnishment',
};

/** "Child support — case 1234 (TX SDU)", "IRS levy", "Student loan (AWG) — Dept. of Education". */
export function garnishmentLabel(g: { kind: string; caseNumber?: string | null; state?: string | null; agencyName?: string | null }): string {
  const agency = g.agencyName?.trim() || null;
  let head: string;
  if (g.kind === 'TAX_LEVY') head = agency && /\birs\b|internal revenue/i.test(agency) ? 'IRS levy' : agency ? `${agency} levy` : g.state ? `${g.state} tax levy` : 'Tax levy';
  else if (g.kind === 'STUDENT_LOAN') head = 'Student loan (AWG)';
  else head = GARN_KIND_LABEL[g.kind] ?? 'Garnishment';
  const parts = [head];
  if (g.caseNumber) parts.push(`case ${g.caseNumber}`);
  let label = parts.join(' — ');
  if (g.kind === 'CHILD_SUPPORT' && g.state) label += ` (${g.state} SDU)`;
  else if (g.kind !== 'TAX_LEVY' && agency) label += ` · ${agency}`;
  return label.slice(0, 160);
}

export interface BuildLinesInput {
  perPlan: PlanDeduction[];
  garnishments: Array<{ garnishmentId: string; amount: number; adminFee?: number; kind: string; caseNumber?: string | null; state?: string | null; agencyName?: string | null }>;
  loans: Array<{ loanNumber: string; amount: number; loanId?: string | null }>;
  /** 401(k) employer match + safe harbor on this check. */
  employerRetirement: number;
  retirementPlanId?: string | null;
  ctx: TaxabilityContext;
}

/** The lines the pay calculation knows about (clawbacks, rides and advances are added when the check is persisted). */
export function buildDeductionLines(i: BuildLinesInput): DeductionLine[] {
  const out: DeductionLine[] = [];
  for (const p of i.perPlan) {
    const code = codeForPlanKind(p.planKind, p.roth);
    if (p.planKind === 'TRUMP_ACCOUNT') {
      if (p.employerAmount > 0) out.push(line('ER_TRUMP_ACCOUNT', { employer: p.employerAmount }, i.ctx, { sourceType: 'BenefitsEnrollment', sourceId: p.sourceId }));
      continue;
    }
    if (p.amount > 0) out.push(line(code, { employee: p.amount }, i.ctx, { sourceType: 'BenefitsEnrollment', sourceId: p.sourceId }));
    if (p.employerAmount > 0) {
      if (p.planKind === 'HSA') out.push(line('ER_HSA', { employer: p.employerAmount }, i.ctx, { sourceType: 'BenefitsEnrollment', sourceId: p.sourceId }));
      else if (p.planKind === 'HEALTH_MEDICAL') out.push(line('ER_HEALTH', { employer: p.employerAmount }, i.ctx, { sourceType: 'BenefitsEnrollment', sourceId: p.sourceId }));
      else if (p.planKind === 'DENTAL' || p.planKind === 'VISION')
        // Stand-alone dental and vision are excepted benefits: no Box 12 DD.
        out.push(line('ER_HEALTH', { employer: p.employerAmount }, i.ctx, { sourceType: 'BenefitsEnrollment', sourceId: p.sourceId, label: `Employer ${p.planKind === 'DENTAL' ? 'dental' : 'vision'} coverage`, w2Box12Code: null }));
    }
  }
  for (const g of i.garnishments) {
    if (g.amount > 0) out.push(line('GARNISHMENT', { employee: g.amount }, i.ctx, { sourceType: 'Garnishment', sourceId: g.garnishmentId, label: garnishmentLabel(g) }));
    if ((g.adminFee ?? 0) > 0) out.push(line('GARNISHMENT_FEE', { employee: g.adminFee }, i.ctx, { sourceType: 'Garnishment', sourceId: g.garnishmentId }));
  }
  for (const l of i.loans) {
    if (l.amount > 0) out.push(line('RET_LOAN', { employee: l.amount }, i.ctx, { sourceType: 'RetirementLoan', sourceId: l.loanId ?? null, label: `401(k) loan ${l.loanNumber}` }));
  }
  if (i.employerRetirement > 0) out.push(line('ER_401K_MATCH', { employer: i.employerRetirement }, i.ctx, { sourceType: 'RetirementPlan', sourceId: i.retirementPlanId ?? null }));
  return out;
}

export function sumEmployee(lines: DeductionLine[], category: DeductionCategory): number {
  return r2(lines.reduce((s, l) => (l.category === category ? s + l.employeeAmount : s), 0));
}

/**
 * Keep the lump columns and the lines in agreement: a rounding cent (or a
 * deduction source not itemized yet) becomes an honest catch-all line
 * rather than a silent gap the W-2 would inherit.
 */
export function reconcile(lines: DeductionLine[], expected: { preTax: number; postTax: number }, ctx: TaxabilityContext): DeductionLine[] {
  const out = [...lines];
  const preGap = r2(expected.preTax - sumEmployee(out, 'PRE_TAX'));
  if (Math.abs(preGap) >= 0.01) {
    const target = [...out].reverse().find((l) => l.category === 'PRE_TAX');
    if (target && Math.abs(preGap) <= 0.05) target.employeeAmount = r2(target.employeeAmount + preGap);
    else out.push(line('MEDICAL', { employee: preGap }, ctx, { label: 'Health & benefits (not itemized)', w2Box12Code: null }));
  }
  const postGap = r2(expected.postTax - sumEmployee(out, 'POST_TAX'));
  if (Math.abs(postGap) >= 0.01) out.push(line('AFTER_TAX_OTHER', { employee: postGap }, ctx));
  return out;
}

/** createMany rows for one item. */
export function deductionRows(payrollItemId: string, tenantId: string, lines: DeductionLine[]): Prisma.PayrollItemDeductionCreateManyInput[] {
  return lines
    .filter((l) => l.employeeAmount !== 0 || l.employerAmount !== 0)
    .map((l) => ({
      tenantId,
      payrollItemId,
      code: l.code,
      category: l.category,
      label: l.label,
      employeeAmount: l.employeeAmount,
      employerAmount: l.employerAmount,
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      exemptFrom: l.exemptFrom,
      w2Box12Code: l.w2Box12Code,
      w2Box14Label: l.w2Box14Label,
      w2Box10: l.w2Box10,
    }));
}
