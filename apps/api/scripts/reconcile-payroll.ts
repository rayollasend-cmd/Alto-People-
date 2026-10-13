/**
 * Brief 1A-1 — Reconciliation report: platform vs payroll for one pay period.
 *
 * Read-only. Compares what the payroll engine would pay for the period
 * (hours, rate, gross, employment status, per associate) with a Synchros
 * export, lists every associate with a nonzero variance, totals the
 * headcount, hours and gross on both sides, and prints the "definition of
 * active" inventory (every place on the platform that computes an active
 * count, with its rule).
 *
 * Run with the production DATABASE_URL (a read replica is fine):
 *
 *   cd apps/api && npx tsx scripts/reconcile-payroll.ts \
 *     --start 2026-09-26 --end 2026-10-09 \
 *     [--payroll /path/to/synchros.csv] \
 *     [--map "hours=Reg Hours,overtimeHours=OT Hours,gross=Gross Pay,email=Work Email"] \
 *     [--out ./reconcile-out] [--window 14] [--persist]
 *
 * --persist keeps the totals (one ReconciliationSnapshot row) so the Headcount
 * screen shows the variance beside today's numbers.
 *
 * Without --payroll it writes the platform side alone. The CSV column map
 * lives in src/lib/reconcilePayroll.ts (PAYROLL_COLUMNS); complete it when
 * the Synchros columns are known, or pass --map.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { columnMapFromArg, persistReconciliation, runReconciliation } from '../src/lib/reconcilePayroll.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const start = arg('--start');
  const end = arg('--end');
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    console.error('Usage: npx tsx scripts/reconcile-payroll.ts --start YYYY-MM-DD --end YYYY-MM-DD [--payroll file.csv] [--map k=Header,...] [--out dir] [--window days]');
    process.exit(2);
  }
  const payrollPath = arg('--payroll');
  const payrollCsv = payrollPath ? readFileSync(payrollPath, 'utf8') : null;
  const map = columnMapFromArg(arg('--map'));
  const outDir = arg('--out') ?? join(process.cwd(), 'reconcile-out');
  const windowDays = arg('--window') ? Number(arg('--window')) : undefined;

  const prisma = new PrismaClient();
  try {
    const { result, platform, csv, markdown } = await runReconciliation(prisma, { start, end, payrollCsv, map, windowDays });
    if (process.argv.includes('--persist')) console.log(`Snapshot ${await persistReconciliation(prisma, result, platform)} saved for the Headcount screen.`);
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `reconcile-${start}-${end}`);
    writeFileSync(`${base}.csv`, csv);
    writeFileSync(`${base}.md`, markdown);
    console.log(markdown);
    console.log(`Wrote ${base}.csv and ${base}.md`);
    if (result.payrollProvided && result.missingColumns.length) {
      console.warn(`Columns not found in the export: ${result.missingColumns.join(', ')}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
