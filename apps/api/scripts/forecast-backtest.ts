/**
 * Brief 3-4 — the back-test against whatever the database holds.
 *
 *   npx tsx scripts/forecast-backtest.ts [--tenant <id>] [--lead 4]
 *
 * Reads verified hours per site and org week for the last 60 weeks, scores
 * every week with sixteen or more weeks of history before it at the given
 * lead, and prints the site-week error table, the weights the back-test
 * picked and the mean absolute percent error (all weeks, and June–August).
 * Read-only: it writes nothing.
 */
import { prisma } from '../src/db.js';
import { runWithTenant, ALTO_TENANT_ID } from '../src/lib/tenant.js';
import { backtest, type WeekSeries } from '../src/lib/forecast/model.js';
import { anchorWeekFor, verifiedHoursBySite } from '../src/lib/forecast/run.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const tenantId = flag('tenant') ?? ALTO_TENANT_ID;
  const lead = Number(flag('lead') ?? 4);
  const now = new Date();
  await runWithTenant(tenantId, 'job', async () => {
    const sites = await prisma.site.findMany({
      where: { tenantId, isActive: true, deletedAt: null },
      select: { id: true, name: true, timezone: true, clientId: true, client: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    const from = new Date(now.getTime() - 61 * 7 * 86_400_000);
    const history = await verifiedHoursBySite(prisma, sites, from, now);
    const completed = new Map<string, WeekSeries>();
    const names = new Map(sites.map((s) => [s.id, s.name]));
    for (const s of sites) {
      const anchor = anchorWeekFor(now, s.timezone);
      const series = new Map<string, number>();
      for (const [k, v] of history.get(s.id)!) if (k < anchor) series.set(k, v);
      completed.set(s.id, series);
    }
    const result = backtest(completed, { lead });
    console.log(`forecast back-test — tenant ${tenantId}, lead ${lead} week(s), ${sites.length} site(s), ${result.scoredWeeks} scored site-week(s)`);
    console.log(`weights: last year ${result.weights.lastYearWeight}, band ${Math.round(result.weights.bandLow * 100)}% … +${Math.round(result.weights.bandHigh * 100)}%`);
    console.log(`MAPE all weeks: ${result.mapePct ?? 'n/a'}%   June–August: ${result.summerMapePct ?? 'n/a'}%`);
    console.log('');
    console.log('site                            week        forecast   actual   error%');
    for (const p of result.points.sort((a, b) => (a.locationId === b.locationId ? a.weekStart.localeCompare(b.weekStart) : (names.get(a.locationId) ?? '').localeCompare(names.get(b.locationId) ?? '')))) {
      const name = (names.get(p.locationId) ?? p.locationId).padEnd(30).slice(0, 30);
      console.log(`${name}  ${p.weekStart}  ${p.forecastP50.toFixed(1).padStart(8)}  ${p.actualHours.toFixed(1).padStart(7)}  ${p.pctError.toFixed(1).padStart(7)}`);
    }
    const bySite = new Map<string, number[]>();
    for (const p of result.points) bySite.set(p.locationId, [...(bySite.get(p.locationId) ?? []), Math.abs(p.pctError)]);
    console.log('');
    console.log('per site MAPE:');
    for (const [id, errs] of bySite) console.log(`  ${(names.get(id) ?? id).padEnd(30)} ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1)}%  (${errs.length} weeks)`);
  });
}

main()
  .catch((err) => {
    console.error('[forecast-backtest] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
