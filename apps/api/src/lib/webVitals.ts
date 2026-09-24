import { prisma } from '../db.js';
import { logger } from './logger.js';

/**
 * REAL-USER WEB VITALS — what the app feels like on the phones and
 * tablets it actually runs on, not on a laptop in the office.
 *
 * The browser reports four numbers per page view (lib/webVitals.ts in the
 * web app): LCP (how long until the biggest thing painted), INP (how long
 * a tap takes to respond), CLS (how much the page jumped) and TTFB (how
 * long the server took). They arrive in batches on a beacon and are
 * rolled up here per SPA route and UTC day, the same way lib/usageTracker
 * rolls up API traffic — buffered in memory, flushed on a timer, never on
 * the request path.
 *
 * Percentiles need a distribution, and storing every sample would make
 * the table grow with traffic forever. Each rollup row keeps a fixed
 * log-spaced histogram instead: p75 is a walk over ~25 integers, and a
 * day of a route costs one row whether ten people or ten thousand opened
 * it. The edges live here, once, so the API and the dashboard agree.
 *
 * Routes are SPA path PATTERNS — "/people", "/clients/:id" — never a
 * resolved path. The browser already sends patterns; the server strips
 * anything id-shaped again, because a usage table must never become a
 * record of who looked at whom.
 */

export type WebVitalMetric = 'LCP' | 'INP' | 'CLS' | 'TTFB';
export type WebVitalRating = 'good' | 'needs-improvement' | 'poor';

export const WEB_VITAL_METRICS: readonly WebVitalMetric[] = ['LCP', 'INP', 'CLS', 'TTFB'];

/** Google's published thresholds: [good ≤, poor >]. CLS is unitless. */
export const THRESHOLDS: Record<WebVitalMetric, readonly [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
};

/**
 * Histogram edges per metric. A value lands in the first bucket whose
 * edge is ≥ the value; anything past the last edge lands in one final
 * overflow bucket, so every histogram has edges.length + 1 buckets.
 */
export const EDGES: Record<WebVitalMetric, readonly number[]> = {
  LCP: [200, 400, 600, 800, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 10000, 12000, 15000, 20000],
  INP: [16, 32, 48, 64, 80, 100, 120, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 1000, 1250, 1500, 2000, 3000, 4000, 5000],
  CLS: [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 1, 1.5, 2, 3],
  TTFB: [50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000, 2500, 3000, 4000, 5000, 7000, 10000, 15000],
};

export function rate(metric: WebVitalMetric, value: number): WebVitalRating {
  const [good, poor] = THRESHOLDS[metric];
  if (value <= good) return 'good';
  if (value > poor) return 'poor';
  return 'needs-improvement';
}

export function bucketIndex(metric: WebVitalMetric, value: number): number {
  const edges = EDGES[metric];
  for (let i = 0; i < edges.length; i++) if (value <= edges[i]!) return i;
  return edges.length;
}

/**
 * The 75th percentile from a histogram: the upper edge of the bucket in
 * which the 75th-percentile sample falls (the overflow bucket reports its
 * lower edge, which is the honest "at least this much"). Null with no
 * samples.
 */
export function p75FromHistogram(metric: WebVitalMetric, histogram: readonly number[]): number | null {
  const total = histogram.reduce((s, n) => s + n, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * 0.75);
  const edges = EDGES[metric];
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i] ?? 0;
    if (seen >= target) return i < edges.length ? edges[i]! : edges[edges.length - 1]!;
  }
  return edges[edges.length - 1]!;
}

export function emptyHistogram(metric: WebVitalMetric): number[] {
  return new Array<number>(EDGES[metric].length + 1).fill(0);
}

export function addHistograms(metric: WebVitalMetric, a: readonly number[], b: readonly number[]): number[] {
  const out = emptyHistogram(metric);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{4,}$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{20,}$/;
const MAX_SEGMENTS = 12;
const MAX_ROUTE_LENGTH = 200;

/**
 * The route key a sample is stored under, or null when the path is not
 * something worth storing (not a path, absurdly deep, empty).
 */
export function routeKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return null;
  const cleaned = segments.map((seg) => {
    if (seg === ':id') return seg;
    if (UUID.test(seg) || NUMERIC_ID.test(seg) || OPAQUE_TOKEN.test(seg)) return ':id';
    return seg.length > 40 ? seg.slice(0, 40) : seg;
  });
  const key = `/${cleaned.join('/')}`;
  return key.length > MAX_ROUTE_LENGTH ? key.slice(0, MAX_ROUTE_LENGTH) : key;
}

const FLUSH_MS = 60_000;
/** A runaway client can't grow the buffer without bound. */
const MAX_KEYS = 2_000;

type Bucket = {
  day: string;
  route: string;
  metric: WebVitalMetric;
  count: number;
  sum: number;
  good: number;
  needsWork: number;
  poor: number;
  histogram: number[];
};

const buffer = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;

const dayKey = (at: Date) => at.toISOString().slice(0, 10);

/** Record one sample. Synchronous, cheap, never throws. */
export function recordVital(route: string, metric: WebVitalMetric, value: number, at: Date = new Date()): void {
  if (!Number.isFinite(value) || value < 0) return;
  const day = dayKey(at);
  const key = `${day}|${route}|${metric}`;
  let b = buffer.get(key);
  if (!b) {
    if (buffer.size >= MAX_KEYS) return;
    b = { day, route, metric, count: 0, sum: 0, good: 0, needsWork: 0, poor: 0, histogram: emptyHistogram(metric) };
    buffer.set(key, b);
  }
  b.count += 1;
  b.sum += value;
  const r = rate(metric, value);
  if (r === 'good') b.good += 1;
  else if (r === 'poor') b.poor += 1;
  else b.needsWork += 1;
  b.histogram[bucketIndex(metric, value)]! += 1;
}

/**
 * Write the buffered rollups. Histograms can't be incremented in place by
 * Prisma, so each bucket is a read-modify-write; the API runs one replica
 * (see index.ts), and a lost update here costs a few samples, not money.
 */
export async function flushVitals(): Promise<void> {
  if (buffer.size === 0) return;
  const batch = [...buffer.values()];
  buffer.clear();
  for (const b of batch) {
    try {
      const day = new Date(`${b.day}T00:00:00.000Z`);
      const where = { day_route_metric: { day, route: b.route, metric: b.metric } };
      const existing = await prisma.webVitalDaily.findUnique({ where, select: { histogram: true } });
      const histogram = existing ? addHistograms(b.metric, existing.histogram, b.histogram) : b.histogram;
      await prisma.webVitalDaily.upsert({
        where,
        create: {
          day,
          route: b.route,
          metric: b.metric,
          count: b.count,
          sum: b.sum,
          good: b.good,
          needsWork: b.needsWork,
          poor: b.poor,
          histogram,
        },
        update: {
          count: { increment: b.count },
          sum: { increment: b.sum },
          good: { increment: b.good },
          needsWork: { increment: b.needsWork },
          poor: { increment: b.poor },
          histogram,
        },
      });
    } catch (err) {
      logger.warn({ err, route: b.route, metric: b.metric }, 'web vitals: flush failed');
    }
  }
}

export function startVitalsFlusher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushVitals();
  }, FLUSH_MS);
  timer.unref?.();
}

export function stopVitalsFlusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test-only: write everything buffered so a read can see it. */
export async function flushVitalsForTests(): Promise<void> {
  await flushVitals();
}

/** Test-only: forget everything buffered. */
export function resetVitalsForTests(): void {
  buffer.clear();
}
