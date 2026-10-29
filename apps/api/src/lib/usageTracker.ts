import type { Request } from 'express';
import { platformJob } from './tenantJobs.js';
import { prisma } from '../db.js';
import { logger } from './logger.js';

/**
 * WHAT THE PRODUCT IS ACTUALLY USED FOR — counted without being felt.
 *
 * Two facts get recorded: that a user was active on a day, and that a
 * route was called. Both are accumulated in memory and flushed on a timer,
 * because the naive version — an UPDATE per request — would put a database
 * round-trip in front of every single call the app makes.
 *
 * The per-user day is written at most ONCE per user per day per process,
 * guarded by an in-memory set. A user hammering the app for eight hours
 * costs one INSERT.
 *
 * Route keys are Express PATTERNS, never resolved paths — "/rides/:id",
 * not "/rides/9f2e…". That is a privacy property, not a formatting choice:
 * this app's URLs carry associate and application ids, so storing real
 * paths would quietly turn a usage table into a record of who looked at
 * whom. A request that never matched a route is dropped rather than
 * recorded under its raw path.
 *
 * Nothing here may ever throw into a request. Every failure is logged and
 * swallowed; analytics is the least important thing happening on any given
 * call, and it must behave that way.
 */

const FLUSH_MS = 60_000;
/** Above this many distinct route keys we stop adding new ones for the
 *  window — a runaway pattern can't grow the buffer without bound. */
const MAX_ROUTE_KEYS = 2_000;

/**
 * Response-time histogram edges, milliseconds. A request lands in the
 * first bucket whose edge is ≥ its duration; anything past the last edge
 * lands in one overflow bucket, so every histogram has edges.length + 1
 * buckets. Log-spaced so the interesting end (hundreds of ms to seconds)
 * has resolution and a 30-second outlier still counts without a bucket
 * of its own. Same scheme as lib/webVitals.ts.
 */
export const LATENCY_EDGES: readonly number[] = [
  25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000,
  15000, 20000, 30000,
];

export function latencyBucket(ms: number): number {
  for (let i = 0; i < LATENCY_EDGES.length; i++) if (ms <= LATENCY_EDGES[i]!) return i;
  return LATENCY_EDGES.length;
}

export function emptyLatencyHistogram(): number[] {
  return new Array<number>(LATENCY_EDGES.length + 1).fill(0);
}

export function addLatencyHistograms(a: readonly number[], b: readonly number[]): number[] {
  const out = emptyLatencyHistogram();
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/**
 * A percentile from a latency histogram: the upper edge of the bucket the
 * target sample falls in (the overflow bucket reports its lower edge — an
 * honest "at least this much"). Null with no samples, which is also what
 * a row written before the column existed reports.
 */
export function percentileFromLatencyHistogram(
  histogram: readonly number[],
  percentile = 0.95,
): number | null {
  const total = histogram.reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * percentile);
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] ?? 0;
    if (seen >= target) {
      return i < LATENCY_EDGES.length ? LATENCY_EDGES[i]! : LATENCY_EDGES[LATENCY_EDGES.length - 1]!;
    }
  }
  return LATENCY_EDGES[LATENCY_EDGES.length - 1]!;
}

type RouteBucket = {
  day: string;
  method: string;
  route: string;
  ok: number;
  clientError: number;
  serverError: number;
  totalMs: number;
  histogram: number[];
};

const routeBuffer = new Map<string, RouteBucket>();
/** `${userId}:${day}` already written by this process. */
const seenUserDays = new Set<string>();
let timer: NodeJS.Timeout | null = null;
/** Test seam: resolves once an in-progress flush has settled. */
let inFlight: Promise<unknown> = Promise.resolve();

/** UTC calendar day. Analytics is reported in one zone or the numbers stop
 *  adding up across a company that spans several. */
export function dayKey(at: Date = new Date()): string {
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: platform telemetry read across tenants by the operator's analytics and the status page, one calendar for all.
  return at.toISOString().slice(0, 10);
}

/**
 * The Express route pattern for a finished request, or null when the
 * request never matched one (404s, and anything that died in middleware).
 * `req.route` only exists once routing has happened, which is why this is
 * read on 'finish' rather than up front.
 */
export function routePattern(req: Request): string | null {
  const route = (req as Request & { route?: { path?: string } }).route;
  if (!route?.path) return null;
  const base = req.baseUrl || '';
  const path = route.path === '/' ? '' : route.path;
  const full = `${base}${path}` || '/';
  return full.length > 200 ? full.slice(0, 200) : full;
}

/** Record one finished request. Cheap, synchronous, never throws. */
export function recordRequest(
  method: string,
  route: string,
  statusCode: number,
  ms: number,
  at: Date = new Date(),
): void {
  const day = dayKey(at);
  const key = `${day}|${method}|${route}`;
  let bucket = routeBuffer.get(key);
  if (!bucket) {
    if (routeBuffer.size >= MAX_ROUTE_KEYS) return;
    bucket = {
      day,
      method,
      route,
      ok: 0,
      clientError: 0,
      serverError: 0,
      totalMs: 0,
      histogram: emptyLatencyHistogram(),
    };
    routeBuffer.set(key, bucket);
  }
  if (statusCode >= 500) bucket.serverError += 1;
  else if (statusCode >= 400) bucket.clientError += 1;
  else bucket.ok += 1;
  const rounded = Math.max(0, Math.round(ms));
  bucket.totalMs += rounded;
  bucket.histogram[latencyBucket(rounded)]! += 1;
}

/**
 * Note that this user was active today. Returns immediately; the write is
 * fire-and-forget and happens at most once per user per day per process.
 */
export function noteUserActive(userId: string, role: string, at: Date = new Date()): void {
  const day = dayKey(at);
  const key = `${userId}:${day}`;
  if (seenUserDays.has(key)) return;
  // Claim it BEFORE the await so a burst of concurrent requests from the
  // same user produces one write, not one per request in flight.
  seenUserDays.add(key);
  const work = (async () => {
    try {
      await prisma.userActivityDay.upsert({
        where: { userId_day: { userId, day: new Date(`${day}T00:00:00.000Z`) } },
        create: { userId, day: new Date(`${day}T00:00:00.000Z`), role, firstAt: at },
        update: {},
      });
      // updateMany, not update: a user removed between the request and
      // this write is an ordinary race, not an error worth logging. update
      // throws P2025 on a missing row; updateMany quietly affects nothing.
      await prisma.user.updateMany({ where: { id: userId }, data: { lastSeenAt: at } });
    } catch (err) {
      // A deleted user, or a database blip. Forget the claim so a later
      // request can try again rather than losing the whole day.
      seenUserDays.delete(key);
      logger.warn({ err, userId }, 'usage: activity write failed');
    }
  })();
  inFlight = inFlight.then(() => work).catch(() => undefined);
}

/** Write the buffered route counters. Safe to call concurrently. */
export async function flushUsage(): Promise<void> {
  if (routeBuffer.size === 0) return;
  const batch = [...routeBuffer.values()];
  routeBuffer.clear();
  for (const b of batch) {
    try {
      const day = new Date(`${b.day}T00:00:00.000Z`);
      const where = { day_method_route: { day, method: b.method, route: b.route } };
      // The histogram can't be incremented in place by Prisma, so it is a
      // read-modify-write like the web-vitals one; the API runs one
      // replica, and a lost update costs a few samples of a percentile.
      const existing = await prisma.routeUsageDaily.findUnique({ where, select: { histogram: true } });
      const histogram = existing ? addLatencyHistograms(existing.histogram, b.histogram) : b.histogram;
      await prisma.routeUsageDaily.upsert({
        where,
        create: {
          day,
          method: b.method,
          route: b.route,
          ok: b.ok,
          clientError: b.clientError,
          serverError: b.serverError,
          totalMs: BigInt(b.totalMs),
          histogram,
        },
        update: {
          ok: { increment: b.ok },
          clientError: { increment: b.clientError },
          serverError: { increment: b.serverError },
          totalMs: { increment: BigInt(b.totalMs) },
          histogram,
        },
      });
    } catch (err) {
      logger.warn({ err, route: b.route }, 'usage: route flush failed');
    }
  }
}

export function startUsageFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void platformJob('usageTracker', flushUsage)();
  }, FLUSH_MS);
  // Never hold the process open for a counter.
  timer.unref?.();
}

export function stopUsageFlusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test-only: settle pending activity writes and empty the route buffer. */
export async function flushUsageForTests(): Promise<void> {
  await inFlight;
  await flushUsage();
}

/** Test-only: forget which user-days this process has already written. */
export function resetUsageForTests(): void {
  seenUserDays.clear();
  routeBuffer.clear();
  inFlight = Promise.resolve();
}
