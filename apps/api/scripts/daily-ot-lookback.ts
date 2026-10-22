/**
 * Brief 2-2, step 0 — the daily-overtime look-back over paid periods.
 *
 *   npx tsx scripts/daily-ot-lookback.ts [--since YYYY-MM-DD] [--out path.csv]
 *
 * READ-ONLY. For every FINALIZED or DISBURSED payroll run (since the date,
 * if given), finds the approved hours worked at sites in states with daily
 * overtime (lib/stateLaborPolicy.ts) and reports, per associate and company
 * week, the overtime hours the engine paid at straight time and the half-
 * rate difference at the rate recorded on the payroll item. The rules are
 * lib/dailyOvertimeLookback.ts; this file only reads and prints.
 *
 * Writes nothing to the database (findMany only). The CSV holds run, period,
 * associate id and name, states, hours and amounts; never SSN, bank or tax
 * identity fields. The owner and counsel decide what is owed (decision 4 of
 * docs/labor-rules-investigation.md); this script decides nothing.
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { dailyOvertimeLookback, type LookbackEntry, type LookbackWeek } from '../src/lib/dailyOvertimeLookback.js';
import { loadLiveRules } from '../src/lib/laborRules/live.js';
import { ALTO_TENANT_ID } from '../src/lib/tenant.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const since = arg('--since');
const outPath = arg('--out') ?? `daily-ot-lookback-${new Date().toISOString().slice(0, 10)}.csv`;
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('--since must be YYYY-MM-DD');
  process.exit(2);
}

const prisma = new PrismaClient();

type Row = LookbackWeek & { runId: string; periodStart: string; periodEnd: string; runStatus: string; associateName: string };

async function main() {
  // What the engine paid is its own split under the tenant's live rules (Alto HR's; the script is single-tenant).
  const liveRules = await loadLiveRules(prisma, process.env.TENANT_ID ?? ALTO_TENANT_ID);
  const runs = await prisma.payrollRun.findMany({
    where: {
      status: { in: ['FINALIZED', 'DISBURSED'] },
      ...(since ? { periodEnd: { gte: new Date(`${since}T00:00:00.000Z`) } } : {}),
    },
    select: { id: true, clientId: true, periodStart: true, periodEnd: true, status: true },
    orderBy: { periodStart: 'asc' },
  });

  const rows: Row[] = [];
  for (const run of runs) {
    const items = await prisma.payrollItem.findMany({
      where: { payrollRunId: run.id },
      select: { associateId: true, hourlyRate: true, associate: { select: { firstName: true, lastName: true } } },
    });
    if (items.length === 0) continue;
    const rateByAssociate = new Map(items.map((i) => [i.associateId, Number(i.hourlyRate)]));
    const nameById = new Map(items.map((i) => [i.associateId, `${i.associate.firstName} ${i.associate.lastName}`.trim()]));
    const periodEndExclusive = new Date(run.periodEnd.getTime() + 86_400_000);
    const entries = await prisma.timeEntry.findMany({
      where: {
        status: 'APPROVED',
        associateId: { in: items.map((i) => i.associateId) },
        clockInAt: { gte: run.periodStart, lt: periodEndExclusive },
        ...(run.clientId ? { clientId: run.clientId } : {}),
      },
      select: {
        associateId: true,
        status: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
        location: { select: { id: true, state: true, city: true, timezone: true } },
        associate: { select: { state: true } },
      },
    });
    const lookbackEntries: LookbackEntry[] = entries.map((e) => ({
      associateId: e.associateId,
      status: e.status,
      clockInAt: e.clockInAt,
      clockOutAt: e.clockOutAt,
      breaks: e.breaks,
      location: e.location ? { timezone: e.location.timezone } : null,
      siteState: e.location?.state ?? null,
      siteTimezone: e.location?.timezone ?? null,
      siteId: e.location?.id ?? null,
      siteCity: e.location?.city ?? null,
      associateState: e.associate.state ?? null,
    }));
    for (const w of dailyOvertimeLookback(lookbackEntries, rateByAssociate, liveRules)) {
      rows.push({
        ...w,
        runId: run.id,
        runStatus: run.status,
        periodStart: run.periodStart.toISOString().slice(0, 10),
        periodEnd: run.periodEnd.toISOString().slice(0, 10),
        associateName: nameById.get(w.associateId) ?? '',
      });
    }
  }

  const header = [
    'runId', 'runStatus', 'periodStart', 'periodEnd', 'associateId', 'associateName', 'workStates', 'weekStart',
    'weekHours', 'dailyOvertimeHours', 'lawOvertimeHours', 'enginePaidOvertimeHours', 'straightTimeOvertimeHours', 'rate', 'difference',
  ];
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header.join(','), ...rows.map((r) => [
    r.runId, r.runStatus, r.periodStart, r.periodEnd, r.associateId, r.associateName, r.workStates.join(' '), r.weekStart,
    r.weekHours, r.dailyOvertimeHours, r.lawOvertimeHours, r.enginePaidOvertimeHours, r.straightTimeOvertimeHours, r.rate, r.difference,
  ].map(cell).join(','))].join('\n') + '\n';
  writeFileSync(outPath, csv);

  const people = new Set(rows.map((r) => r.associateId));
  const hours = rows.reduce((s, r) => s + r.straightTimeOvertimeHours, 0);
  const amount = rows.reduce((s, r) => s + r.difference, 0);
  console.log(`Daily-overtime look-back over ${runs.length} finalized or disbursed run(s)${since ? ` since ${since}` : ''}.`);
  console.log(`  weeks with straight-time overtime: ${rows.length}`);
  console.log(`  associates: ${people.size}`);
  console.log(`  overtime hours paid at straight time: ${hours.toFixed(2)}`);
  console.log(`  half-rate difference at recorded rates: $${amount.toFixed(2)}`);
  console.log('  not assessed: double time past 12 hours a day and on the seventh day (California).');
  console.log(`  CSV: ${outPath}`);
  console.log('Read-only report for the owner and counsel; nothing was paid or changed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
