import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * READING SENTRY BACK.
 *
 * The SDK only ever writes. The error budget ("weekly errors under ten")
 * is a number Sentry holds, so the dashboard and the weekly summary read
 * it through the REST API with an auth token — when one is configured.
 * Without one every function here answers null and the callers say so;
 * nothing throws into a request, and nothing here is on the hot path.
 *
 * Two reads, both cached in memory for ten minutes so a dashboard that
 * five people refresh costs Sentry one request per read, not fifty:
 *
 *   weeklyErrorCounts  accepted error events per org week, from the
 *                      outcomes API (category=error, outcome=accepted),
 *                      summed across the configured projects
 *   openIssues         unresolved issues, most frequent first, for the
 *                      "what is actually breaking" table
 *
 * Project slugs come from SENTRY_PROJECTS (comma-separated) or
 * SENTRY_PROJECT. The project *ids* the outcomes endpoint wants are
 * resolved once from the slugs and kept for the process lifetime.
 */

const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;

export interface SentryConfig {
  baseUrl: string;
  token: string;
  org: string;
  projects: string[];
}

export function sentryReadConfig(): SentryConfig | null {
  const token = env.SENTRY_AUTH_TOKEN;
  const org = env.SENTRY_ORG;
  const raw = env.SENTRY_PROJECTS ?? env.SENTRY_PROJECT;
  if (!token || !org || !raw) return null;
  const projects = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (projects.length === 0) return null;
  return { baseUrl: env.SENTRY_API_URL.replace(/\/+$/, ''), token, org, projects };
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  /** Events in the window. */
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  /** Which project it belongs to. */
  project: string;
}

export interface SentryWeekCount {
  /** ISO instant of the org week's start. */
  weekStart: string;
  errors: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchLike = (input, init) => fetch(input, init);

/** Test seam: swap the HTTP layer. */
export function setSentryFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
  cache.clear();
  projectIds = null;
}

const cache = new Map<string, { at: number; value: unknown }>();
let projectIds: Map<string, number> | null = null;

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function sentryGet<T>(cfg: SentryConfig, path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/api/0${path}`, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sentry ${res.status} on ${path}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProjectIds(cfg: SentryConfig): Promise<Map<string, number>> {
  if (projectIds) return projectIds;
  const ids = new Map<string, number>();
  for (const slug of cfg.projects) {
    const p = await sentryGet<{ id: string | number }>(cfg, `/projects/${cfg.org}/${slug}/`);
    ids.set(slug, Number(p.id));
  }
  projectIds = ids;
  return ids;
}

interface OutcomesResponse {
  intervals: string[];
  groups: Array<{ by: Record<string, unknown>; series: Record<string, number[]> }>;
}

/**
 * Accepted error events per hour across the configured projects, from
 * `start` (inclusive) to `end` (exclusive). Hourly so the caller can fold
 * them into org weeks, which start at Saturday midnight Florida-local —
 * not a UTC day boundary. Null when Sentry is not configured or
 * unreachable.
 */
export async function sentryHourlyErrorCounts(
  start: Date,
  end: Date,
): Promise<Array<{ at: string; errors: number }> | null> {
  const cfg = sentryReadConfig();
  if (!cfg) return null;
  // Whole hours, so the cache key is stable across a minute of refreshes.
  const from = new Date(Math.floor(start.getTime() / 3_600_000) * 3_600_000);
  const to = new Date(Math.ceil(end.getTime() / 3_600_000) * 3_600_000);
  const key = `hourly|${from.toISOString()}|${to.toISOString()}`;
  try {
    return await cached(key, async () => {
      const ids = await resolveProjectIds(cfg);
      const project = [...ids.values()].map((id) => `project=${id}`).join('&');
      const qs =
        `field=sum(quantity)&category=error&outcome=accepted&interval=1h` +
        `&start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}` +
        `&${project}`;
      const out = await sentryGet<OutcomesResponse>(cfg, `/organizations/${cfg.org}/stats_v2/?${qs}`);
      const totals = new Map<string, number>();
      for (const iv of out.intervals) totals.set(iv, 0);
      for (const g of out.groups) {
        const series = g.series['sum(quantity)'] ?? [];
        series.forEach((n, i) => {
          const at = out.intervals[i];
          if (at) totals.set(at, (totals.get(at) ?? 0) + (n ?? 0));
        });
      }
      return [...totals.entries()].map(([at, errors]) => ({ at, errors }));
    });
  } catch (err) {
    logger.warn({ err }, 'sentry: error counts unavailable');
    return null;
  }
}

interface RawIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  count: string | number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project?: { slug?: string };
}

/**
 * Unresolved issues seen in the last `days`, most frequent first, across
 * the configured projects. Null when Sentry is not configured.
 */
export async function sentryOpenIssues(days = 7, limit = 10): Promise<SentryIssue[] | null> {
  const cfg = sentryReadConfig();
  if (!cfg) return null;
  const key = `issues|${days}|${limit}`;
  try {
    return await cached(key, async () => {
      const all: SentryIssue[] = [];
      for (const slug of cfg.projects) {
        const rows = await sentryGet<RawIssue[]>(
          cfg,
          `/projects/${cfg.org}/${slug}/issues/?query=is:unresolved&statsPeriod=${days}d&sort=freq&limit=${limit}`,
        );
        for (const r of rows) {
          all.push({
            id: String(r.id),
            shortId: r.shortId,
            title: r.title,
            culprit: r.culprit ?? '',
            count: Number(r.count) || 0,
            userCount: r.userCount ?? 0,
            firstSeen: r.firstSeen,
            lastSeen: r.lastSeen,
            permalink: r.permalink,
            project: r.project?.slug ?? slug,
          });
        }
      }
      return all.sort((a, b) => b.count - a.count).slice(0, limit);
    });
  } catch (err) {
    logger.warn({ err }, 'sentry: open issues unavailable');
    return null;
  }
}
