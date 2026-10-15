/**
 * Brief 2-2 step 3 — the dry run the owner signs before pay switches to the
 * labor rules engine (docs/labor-rules-investigation.md §6.3, step 4's gate).
 *
 *   npx tsx scripts/labor-dry-run.ts [--since YYYY-MM-DD] [--out path.csv]
 *
 * READ-ONLY. Recomputes every FINALIZED or DISBURSED payroll run (since the
 * date, if given) through the engine, under the rules of the site where each
 * hour was worked, and lists every difference from what the run paid by
 * associate, with the engine's reasons. Premiums (meal, rest, rest between
 * shifts) are listed and never counted as pay. Zero differences across
 * Florida and Alabama is the gate; the script prints whether it is green.
 * Writes nothing to the database (lib/laborRules/shadow reads only here).
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { shadowPayrollRun } from '../src/lib/laborRules/shadow.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const since = arg('--since');
const outPath = arg('--out') ?? `labor-dry-run-${new Date().toISOString().slice(0, 10)}.csv`;
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('--since must be YYYY-MM-DD');
  process.exit(2);
}

const prisma = new PrismaClient();
const cell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const runs = await prisma.payrollRun.findMany({
    where: { status: { in: ['FINALIZED', 'DISBURSED'] }, ...(since ? { periodEnd: { gte: new Date(`${since}T00:00:00.000Z`) } } : {}) },
    select: { id: true },
    orderBy: { periodStart: 'asc' },
  });
  const header = ['runId', 'periodStart', 'periodEnd', 'associateId', 'paidRegular', 'paidOvertime', 'engineRegular', 'engineOvertime', 'engineDouble', 'rate', 'amountDifference', 'premiumHoursShown', 'reasons'];
  const lines = [header.join(',')];
  let people = 0;
  let differences = 0;
  let amount = 0;
  let premiums = 0;
  for (const r of runs) {
    const { run, results } = await shadowPayrollRun(prisma, r.id);
    people += results.length;
    for (const x of results.filter((y) => y.differs)) {
      differences += 1;
      amount += x.amountDifference;
      premiums += x.penaltyHours;
      lines.push(
        [run.id, run.periodStart.toISOString().slice(0, 10), run.periodEnd.toISOString().slice(0, 10), x.associateId, x.paid.regularHours, x.paid.overtimeHours, x.engine.regularHours, x.engine.overtimeHours, x.engine.doubleTimeHours, x.hourlyRate, x.amountDifference, x.penaltyHours, x.reasons.join(' | ')]
          .map(cell)
          .join(','),
      );
    }
  }
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`Labor rules dry run over ${runs.length} finalized or disbursed run(s)${since ? ` since ${since}` : ''}, ${people} paid line(s).`);
  console.log(`  differences: ${differences}`);
  console.log(`  pay difference (engine − paid): $${amount.toFixed(2)}`);
  console.log(`  premium hours computed (shown, never paid until signed): ${premiums.toFixed(2)}`);
  console.log(`  CSV: ${outPath}`);
  console.log(differences === 0 ? 'GATE GREEN: the engine reproduces every paid run. The owner may sign the switch (step 4).' : 'GATE NOT GREEN: review each difference with the owner and counsel before any switch.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
