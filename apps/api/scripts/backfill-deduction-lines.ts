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
 * The derivation lives in src/lib/deductionBackfill.ts; the paystub reads
 * the same lines in memory for a check that still has none, so this script
 * is a one-time write for year-to-date per line and the W-2 bases, not a
 * precondition for a readable stub.
 *
 * Each line's exemptFrom carries TODAY's federal and state treatment (lib/
 * deductionTaxability) for the check's work state and the person's home
 * state, so the W-2 and state returns rebuild legally correct wage bases.
 * A check from before this treatment was applied may have withheld state
 * tax on the federal base (e.g. a PA 401(k) deferral); the W-2 reports the
 * correct wages either way, and reconcile-payroll.ts shows any difference.
 */
import { PrismaClient } from '@prisma/client';
import { deriveLegacyDeductionLines } from '../src/lib/deductionBackfill.js';
import { deductionRows } from '../src/lib/deductionLines.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const yearArg = process.argv.indexOf('--year');
const year = yearArg > -1 ? Number(process.argv[yearArg + 1]) : null;

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
    // The same derivation the paystub reads in memory (lib/deductionBackfill).
    const final = await deriveLegacyDeductionLines(prisma, it);
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
