/**
 * Itemize the deductions of paychecks cut before PayrollItemDeduction existed.
 *
 *   npx tsx scripts/backfill-deduction-lines.ts            # dry run: counts and a sample
 *   npx tsx scripts/backfill-deduction-lines.ts --apply    # write the lines
 *   npx tsx scripts/backfill-deduction-lines.ts --apply --year 2026
 *
 * Idempotent: only items with no deduction lines are touched, so it can be
 * re-run safely. Voided items are skipped.
 *
 * What each old check becomes, from what it recorded:
 *   deferrals JSON      401(k), 403(b), Roth, HSA, health FSA, dependent care, Trump account (employer)
 *   the rest of pre-tax "Health & benefits (before itemizing)" (§125)
 *   GarnishmentDeduction one line per order (and its processing fee)
 *   rideChargesCents    Van rides
 *   EarnedWageAdvance   Earned-wage advance repaid
 *   RetirementContribution loans and the employer match / safe harbor
 *   the rest of post-tax "Other deductions (before itemizing)"
 *
 * Each line's exemptFrom carries TODAY's federal and state treatment (lib/
 * deductionTaxability) for the check's work state and the person's home
 * state, so the W-2 and state returns rebuild legally correct wage bases.
 * A check from before this treatment was applied may have withheld state
 * tax on the federal base (e.g. a PA 401(k) deferral); the W-2 reports the
 * correct wages either way, and reconcile-payroll.ts shows any difference.
 */
import { PrismaClient } from '@prisma/client';
import { LOCAL_TAX_STATES, type TaxabilityContext } from '../src/lib/deductionTaxability.js';
import { deductionRows, garnishmentLabel, line, reconcile, type DeductionLine } from '../src/lib/deductionLines.js';
import { readDeferrals } from '../src/lib/retirementDeferrals.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const yearArg = process.argv.indexOf('--year');
const year = yearArg > -1 ? Number(process.argv[yearArg + 1]) : null;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const items = await prisma.payrollItem.findMany({
    where: {
      deductions: { none: {} },
      status: { not: 'VOIDED' },
      payrollRun: { status: { not: 'CANCELLED' }, ...(year ? { periodStart: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } } : {}) },
      OR: [{ preTaxDeductions: { not: 0 } }, { postTaxDeductions: { not: 0 } }, { preTaxRetirement: { not: 0 } }, { NOT: { deferrals: { equals: null as never } } }],
    },
    select: {
      id: true,
      tenantId: true,
      associateId: true,
      payrollRunId: true,
      preTaxDeductions: true,
      postTaxDeductions: true,
      preTaxRetirement: true,
      deferrals: true,
      rideChargesCents: true,
      taxState: true,
      associate: { select: { state: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${items.length} paycheck${items.length === 1 ? '' : 's'} with deductions and no itemized lines${apply ? '' : ' (dry run — pass --apply to write)'}\n`);

  let written = 0;
  let lineCount = 0;
  for (const it of items) {
    const states = [it.taxState, it.associate.state].filter((s): s is string => !!s).map((s) => s.toUpperCase());
    const ctx: TaxabilityContext = { workStates: it.taxState ? [it.taxState.toUpperCase()] : [], residentState: it.associate.state?.toUpperCase() ?? null, localApplies: states.some((s) => LOCAL_TAX_STATES.has(s)) };
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
      prisma.garnishmentDeduction.findMany({
        where: { payrollRunId: it.payrollRunId, garnishment: { associateId: it.associateId } },
        select: { amount: true, adminFee: true, garnishmentId: true, garnishment: { select: { kind: true, caseNumber: true, state: true, agencyName: true } } },
      }),
      prisma.retirementContribution.findMany({ where: { payrollItemId: it.id }, select: { employerMatch: true, safeHarbor: true, loanRepayments: true, planId: true } }),
      prisma.earnedWageAdvance.findMany({ where: { associateId: it.associateId, recoveryLog: { array_contains: [{ runId: it.payrollRunId }] } }, select: { id: true, recoveryLog: true } }),
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
    const ewaCents = ewa.reduce((s, a) => s + (Array.isArray(a.recoveryLog) ? (a.recoveryLog as Array<{ runId: string; cents: number }>) : []).filter((x) => x.runId === it.payrollRunId).reduce((t, x) => t + x.cents, 0), 0);
    add(line('EWA_RECOVERY', { employee: r2(ewaCents / 100) }, ctx, { sourceType: 'EarnedWageAdvance' }));

    const final = reconcile(lines, { preTax: Number(it.preTaxDeductions), postTax: Number(it.postTaxDeductions) }, ctx).map((l) =>
      l.code === 'AFTER_TAX_OTHER' && !l.sourceType ? { ...l, label: 'Other deductions (before itemizing)' } : l,
    );
    if (final.length === 0) continue;
    lineCount += final.length;
    if (written < 5) console.log(`${it.associate.firstName} ${it.associate.lastName} · item ${it.id.slice(0, 8)}: ${final.map((l) => `${l.label} ${l.employeeAmount || l.employerAmount}`).join(', ')}`);
    if (apply) {
      await prisma.$transaction(async (tx) => {
        const exists = await tx.payrollItemDeduction.count({ where: { payrollItemId: it.id } });
        if (exists > 0) return;
        await tx.payrollItemDeduction.createMany({ data: deductionRows(it.id, it.tenantId ?? '00000000-0000-4000-8000-000000000001', final) });
      });
    }
    written += 1;
  }
  console.log(`\n${apply ? 'Wrote' : 'Would write'} ${lineCount} line${lineCount === 1 ? '' : 's'} on ${written} paycheck${written === 1 ? '' : 's'}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
