/**
 * Brief 1A-4 — the access report, from the command line.
 *
 *   railway run --service api -- npx tsx scripts/access-report.ts            counts + flagged accounts
 *   railway run --service api -- npx tsx scripts/access-report.ts --csv > access-report.csv
 *
 *   railway run --service api -- npx tsx scripts/access-report.ts --persist  also records SOC 2 evidence
 *
 * Read-only. The same report the Users page shows (GET /admin/users/access-report).
 * --persist records counts only (no emails) as access-review evidence
 * (Brief 2-5); a named approver signs it off on the Compliance evidence page.
 * Nobody is deactivated by this script; the owner approves the list first.
 */
import { PrismaClient } from '@prisma/client';
import { ACCESS_FLAGS, ACCESS_FLAG_LABEL, accessReportCsv, buildAccessReport } from '../src/lib/accessCleanup.js';
import { recordEvidence } from '../src/lib/evidence.js';

const prisma = new PrismaClient();

async function main() {
  const report = await buildAccessReport(prisma);
  if (process.argv.includes('--csv')) {
    process.stdout.write(accessReportCsv(report) + '\n');
    return;
  }
  const c = report.counts;
  console.log(`Access report — ${report.generatedAt}\n`);
  console.log(`Accounts: ${c.totalAccounts}  (active ${c.byStatus.ACTIVE}, invited ${c.byStatus.INVITED}, disabled ${c.byStatus.DISABLED})`);
  console.log(`Active associates (one definition of active): ${c.activeAssociates}`);
  console.log(`Flagged accounts: ${c.flaggedAccounts}\n`);
  console.log('By role');
  for (const [role, n] of Object.entries(c.byRole).sort((a, b) => b[1] - a[1])) console.log(`  ${role.padEnd(26)} ${String(n).padStart(5)}`);
  console.log('\nBy flag');
  for (const f of ACCESS_FLAGS) console.log(`  ${ACCESS_FLAG_LABEL[f].padEnd(46)} ${String(c.byFlag[f]).padStart(5)}`);
  console.log('\nFlagged accounts');
  console.log('  ' + ['email'.padEnd(40), 'role'.padEnd(24), 'status'.padEnd(9), 'last sign-in'.padEnd(13), 'scope'.padEnd(30), 'flags'].join(' '));
  for (const r of report.rows.filter((r) => r.flags.length > 0)) {
    console.log(
      '  ' +
        [
          r.email.slice(0, 40).padEnd(40),
          r.role.padEnd(24),
          r.status.padEnd(9),
          (r.lastSignInAt ? r.lastSignInAt.slice(0, 10) : 'never').padEnd(13),
          r.scope.slice(0, 30).padEnd(30),
          r.flags.join(', '),
        ].join(' '),
    );
  }

  if (process.argv.includes('--persist')) {
    const id = await recordEvidence('access-review', 'scripts/access-report.ts', {
      status: c.flaggedAccounts === 0 ? 'PASS' : 'WARN',
      summary: `${c.totalAccounts} accounts, ${c.flaggedAccounts} flagged for review.`,
      details: { counts: c },
    }, prisma);
    console.log(id ? `\nRecorded as evidence ${id}; sign it off on the Compliance evidence page.` : '\nEvidence NOT recorded (see the error above).');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
