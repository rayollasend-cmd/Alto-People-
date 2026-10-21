import type { PrismaClient } from '@prisma/client';
import type { AssistantTool } from './assistantModel.js';
import { estimateW4, w4EstimatorContext } from './w4Estimator.js';

/**
 * The assistant's pay tools (PAYEXP §5), for a worker asking about their
 * own pay. Each reads ONLY the asking person's records — the associate id
 * comes from the session, never from the model's input — and returns plain
 * facts the model explains in the person's language.
 *
 *   explain_my_latest_paystub   every line of the latest paystub: hours ×
 *                               rate, each tax and why, deductions, what
 *                               daily pay or an advance already took, YTD.
 *   check_my_withholding        the W-4 estimator on their numbers: on
 *                               track for a refund or a balance due, and
 *                               the page to change it.
 */

const money = (n: number) => `$${n.toFixed(2)}`;

const EARNING_LABEL: Record<string, string> = {
  REGULAR: 'Regular hours',
  OVERTIME: 'Overtime (1.5× after 40 hours in the week)',
  DOUBLE_TIME: 'Double time',
  HOLIDAY: 'Holiday pay',
  SICK: 'Sick pay',
  VACATION: 'Vacation pay',
  BONUS: 'Bonus',
  COMMISSION: 'Commission',
  TIPS: 'Tips',
  REIMBURSEMENT: 'Reimbursement (not taxed)',
  RETRO: 'Back pay from a raise dated earlier',
  PREMIUM: 'Premium (a labor-law payment, like a missed meal break)',
  DAILY_SETTLED: 'Already paid to you day by day (daily pay)',
};

/** The latest paystub, line by line, as facts for the model. Exported for tests. */
export async function explainLatestPaystub(db: PrismaClient, associateId: string): Promise<{ reply: string; linkUrl: string | null }> {
  const item = await db.payrollItem.findFirst({
    where: { associateId, status: { in: ['DISBURSED', 'PENDING'] }, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] } } },
    orderBy: [{ payrollRun: { periodEnd: 'desc' } }, { createdAt: 'desc' }],
    include: {
      earnings: true,
      payrollRun: { select: { kind: true, periodStart: true, periodEnd: true, disbursedAt: true } },
      earnedWageAdvancesRecovered: { select: { id: true } },
    },
  });
  if (!item) return { reply: 'No paystub on file yet for this person.', linkUrl: '/payroll' };
  const run = item.payrollRun;
  const lines: string[] = [];
  const kindWord = run.kind === 'DAILY' ? 'daily pay' : run.kind === 'MANUAL' ? 'a manual (paper) check' : run.kind === 'OFF_CYCLE' ? 'an extra (off-cycle) check' : run.kind === 'AMENDMENT' ? 'a correction to an earlier check' : 'a regular paycheck';
  lines.push(`Paystub for ${run.periodStart.toISOString().slice(0, 10)} to ${run.periodEnd.toISOString().slice(0, 10)}, ${kindWord}${run.disbursedAt ? `, paid ${run.disbursedAt.toISOString().slice(0, 10)}` : ' (not paid yet)'}.`);
  lines.push('PAY:');
  for (const e of item.earnings) {
    const label = EARNING_LABEL[e.kind] ?? e.kind;
    const hrs = e.hours !== null && e.rate !== null ? ` — ${Number(e.hours)} h × ${money(Number(e.rate))}` : '';
    lines.push(`- ${label}${hrs} = ${money(Number(e.amount))}${e.notes ? ` (${e.notes})` : ''}`);
  }
  lines.push(`Gross pay (before anything comes out): ${money(Number(item.grossPay))}.`);
  if (Number(item.preTaxDeductions) > 0) lines.push(`Pre-tax deductions (benefits, 401(k)) — taken before taxes, so they lower the taxes: ${money(Number(item.preTaxDeductions))}.`);
  lines.push('TAXES:');
  const tax = (label: string, n: number, why: string) => n !== 0 && lines.push(`- ${label}: ${money(n)} — ${why}`);
  tax('Federal income tax', Number(item.federalWithholding), 'from the W-4 on file and how often you are paid; it is a prepayment of the year’s income tax.');
  tax('Social Security', Number(item.fica), '6.2% of pay, up to the yearly wage limit.');
  tax('Medicare', Number(item.medicare), '1.45% of pay (plus 0.9% on pay over $200,000 in the year).');
  tax(`State income tax${item.taxState ? ` (${item.taxState})` : ''}`, Number(item.stateWithholding), 'the state’s withholding table for where you work or live.');
  tax('Local tax', Number(item.localWithholding), 'a city or county wage tax where it applies.');
  if (Number(item.postTaxDeductions) > 0) {
    const parts: string[] = [];
    if (item.rideChargesCents > 0) parts.push(`van rides ${money(item.rideChargesCents / 100)}`);
    if (item.earnedWageAdvancesRecovered.length > 0) parts.push('pay you took early (earned-wage advance) coming back');
    lines.push(`After-tax deductions: ${money(Number(item.postTaxDeductions))}${parts.length ? ` — includes ${parts.join(', ')}` : ''} (garnishments, Roth 401(k), and fees go here too).`);
  }
  if (Number(item.reimbursementsTotal) > 0) lines.push(`Reimbursements added back (not taxed): ${money(Number(item.reimbursementsTotal))}.`);
  lines.push(`Take-home (net pay): ${money(Number(item.netPay))}.`);
  lines.push(`Year to date before this check: ${money(Number(item.ytdWages))} in wages.`);
  // That paystub, opened.
  return { reply: lines.join('\n'), linkUrl: `/payroll?item=${item.id}` };
}

export async function withholdingCheck(db: PrismaClient, associateId: string, now: Date = new Date()): Promise<{ reply: string; linkUrl: string | null }> {
  const ctx = await w4EstimatorContext(db, associateId, now);
  if (!ctx.current) return { reply: 'No W-4 on file: federal tax is withheld at the default (single, no adjustments). The W-4 estimator page sets one up.', linkUrl: '/payroll/w4-estimator' };
  if (ctx.payPerPeriod <= 0) return { reply: 'Not enough paychecks this year to estimate yet. The W-4 estimator page works from numbers the person types in.', linkUrl: '/payroll/w4-estimator' };
  const r = estimateW4({
    filingStatus: ctx.current.filingStatus,
    payFrequency: ctx.payFrequency,
    payPerPeriod: ctx.payPerPeriod,
    periodsRemaining: ctx.periodsRemaining,
    ytdWages: ctx.ytdWages,
    ytdFederalWithheld: ctx.ytdFederalWithheld,
    otherIncome: ctx.current.otherIncome,
    deductionsAboveStandard: ctx.current.deductions,
    current: ctx.current,
  });
  const asIs = r.asIs!;
  const outcome = asIs.refund >= 0 ? `on track for a federal refund of about ${money(asIs.refund)}` : `on track to owe about ${money(-asIs.refund)} at tax time`;
  return {
    reply: `With the W-4 on file and this job alone (${ctx.periodsRemaining} checks left this year, about ${money(ctx.payPerPeriod)} each), the person is ${outcome}. This counts only this job and what's on the W-4; another job, a spouse's pay, or children change it — the W-4 estimator page asks about those and can submit a new W-4.`,
    linkUrl: '/payroll/w4-estimator',
  };
}

/** The tools, for an associate only. */
export function payTools(db: PrismaClient, user: { associateId: string | null }): AssistantTool[] {
  const associateId = user.associateId;
  if (!associateId) return [];
  return [
    {
      key: 'PAYSTUB',
      name: 'explain_my_latest_paystub',
      description: "Every line of the person's own latest paystub: hours × rate, each tax and why it's taken, deductions, daily pay or advances already taken, take-home and year to date. Use it for any question about their paycheck, a deduction, or why the amount differs.",
      run: () => explainLatestPaystub(db, associateId),
    },
    {
      key: 'W4_CHECK',
      name: 'check_my_withholding',
      description: "Whether the person's federal withholding is on track for the year from their W-4 and paychecks so far, and where to change their W-4.",
      run: () => withholdingCheck(db, associateId),
    },
  ];
}
