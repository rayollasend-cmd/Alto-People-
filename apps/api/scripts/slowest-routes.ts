/**
 * The slowest API routes, from the app's own per-route daily rollup
 * (RouteUsageDaily): p95 from the latency histogram where the rows carry
 * one, and the mean alongside.
 *
 *   railway run --service api -- npx tsx scripts/slowest-routes.ts [days=7] [minRequests=20]
 *
 * Rows written before the histogram column existed (Brief 1B-3) have a
 * mean and no p95; once a full window has passed every route reports
 * both. The same numbers are on /reliability in the app.
 */
import { PrismaClient } from '@prisma/client';
import {
  addLatencyHistograms,
  emptyLatencyHistogram,
  percentileFromLatencyHistogram,
} from '../src/lib/usageTracker.js';

const prisma = new PrismaClient();
const days = Number(process.argv[2] ?? 7);
const minRequests = Number(process.argv[3] ?? 20);

async function main() {
  const from = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.routeUsageDaily.findMany({
    where: { day: { gte: from } },
    select: { method: true, route: true, ok: true, clientError: true, serverError: true, totalMs: true, histogram: true },
  });
  const byRoute = new Map<
    string,
    { requests: number; serverError: number; totalMs: number; histogram: number[] }
  >();
  for (const r of rows) {
    const key = `${r.method} ${r.route}`;
    const b = byRoute.get(key) ?? { requests: 0, serverError: 0, totalMs: 0, histogram: emptyLatencyHistogram() };
    b.requests += r.ok + r.clientError + r.serverError;
    b.serverError += r.serverError;
    b.totalMs += Number(r.totalMs);
    b.histogram = addLatencyHistograms(b.histogram, r.histogram);
    byRoute.set(key, b);
  }
  const shaped = [...byRoute.entries()]
    .map(([route, b]) => ({
      route,
      requests: b.requests,
      serverError: b.serverError,
      meanMs: b.requests > 0 ? Math.round(b.totalMs / b.requests) : 0,
      p95Ms: percentileFromLatencyHistogram(b.histogram, 0.95),
    }))
    .filter((r) => r.requests >= minRequests)
    .sort((a, b) => (b.p95Ms ?? b.meanMs) - (a.p95Ms ?? a.meanMs));
  console.log(`Slowest routes, last ${days} day${days === 1 ? '' : 's'}, at least ${minRequests} requests\n`);
  console.log('route'.padEnd(60), 'requests'.padStart(9), 'p95 ms'.padStart(8), 'mean ms'.padStart(8), '5xx'.padStart(5));
  for (const r of shaped.slice(0, 15)) {
    console.log(
      r.route.slice(0, 60).padEnd(60),
      String(r.requests).padStart(9),
      (r.p95Ms === null ? '—' : String(r.p95Ms)).padStart(8),
      String(r.meanMs).padStart(8),
      String(r.serverError).padStart(5),
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
