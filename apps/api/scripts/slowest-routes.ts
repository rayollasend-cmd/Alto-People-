/**
 * The slowest API routes by mean response time, from the app's own
 * per-route daily rollup (RouteUsageDaily).
 *
 *   railway run --service api -- npx tsx scripts/slowest-routes.ts [days=7] [minRequests=20]
 *
 * This is a MEAN, not a p95 — the rollup keeps a sum and a count per route
 * per day, nothing else. p95 comes from Sentry's Performance view once
 * spans carry route names again (see src/instrument.ts).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const days = Number(process.argv[2] ?? 7);
const minRequests = Number(process.argv[3] ?? 20);

async function main() {
  const from = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.routeUsageDaily.groupBy({
    by: ['method', 'route'],
    where: { day: { gte: from } },
    _sum: { ok: true, clientError: true, serverError: true, totalMs: true },
  });
  const shaped = rows
    .map((r) => {
      const requests = (r._sum.ok ?? 0) + (r._sum.clientError ?? 0) + (r._sum.serverError ?? 0);
      return {
        route: `${r.method} ${r.route}`,
        requests,
        serverError: r._sum.serverError ?? 0,
        meanMs: requests > 0 ? Math.round(Number(r._sum.totalMs ?? 0n) / requests) : 0,
      };
    })
    .filter((r) => r.requests >= minRequests)
    .sort((a, b) => b.meanMs - a.meanMs);
  console.log(`Slowest routes, last ${days} day${days === 1 ? '' : 's'}, at least ${minRequests} requests (mean ms — not p95)\n`);
  console.log('route'.padEnd(60), 'requests'.padStart(9), 'mean ms'.padStart(8), '5xx'.padStart(5));
  for (const r of shaped.slice(0, 15)) {
    console.log(r.route.slice(0, 60).padEnd(60), String(r.requests).padStart(9), String(r.meanMs).padStart(8), String(r.serverError).padStart(5));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
