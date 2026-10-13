import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env.js';
import {
  sentryHourlyErrorCounts,
  sentryOpenIssues,
  sentryReadConfig,
  setSentryFetchForTests,
} from '../../lib/sentryApi.js';

/**
 * Reading Sentry back. The thing to guard is the two ways this can lie:
 * answering a number when nothing is configured (it must say null, so the
 * dashboard says "not connected" rather than "zero errors"), and letting
 * a Sentry outage reach a request (every failure is a null, logged).
 */

const saved = {
  token: env.SENTRY_AUTH_TOKEN,
  org: env.SENTRY_ORG,
  project: env.SENTRY_PROJECT,
  projects: env.SENTRY_PROJECTS,
};

function configure(projects = 'api') {
  Object.assign(env, { SENTRY_AUTH_TOKEN: 'tok', SENTRY_ORG: 'alto', SENTRY_PROJECTS: projects, SENTRY_PROJECT: undefined });
}

afterEach(() => {
  Object.assign(env, {
    SENTRY_AUTH_TOKEN: saved.token,
    SENTRY_ORG: saved.org,
    SENTRY_PROJECT: saved.project,
    SENTRY_PROJECTS: saved.projects,
  });
  setSentryFetchForTests(null);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('sentryReadConfig', () => {
  it('is null until a token, an org and at least one project are set', () => {
    Object.assign(env, { SENTRY_AUTH_TOKEN: undefined, SENTRY_ORG: undefined, SENTRY_PROJECT: undefined, SENTRY_PROJECTS: undefined });
    expect(sentryReadConfig()).toBeNull();
    Object.assign(env, { SENTRY_AUTH_TOKEN: 'tok', SENTRY_ORG: 'alto' });
    expect(sentryReadConfig()).toBeNull();
    Object.assign(env, { SENTRY_PROJECT: 'api' });
    expect(sentryReadConfig()?.projects).toEqual(['api']);
    // The list form wins over the single slug and trims its entries.
    Object.assign(env, { SENTRY_PROJECTS: 'api, web' });
    expect(sentryReadConfig()?.projects).toEqual(['api', 'web']);
  });
});

describe('sentryHourlyErrorCounts', () => {
  it('answers null when Sentry is not configured — never zero', async () => {
    Object.assign(env, { SENTRY_AUTH_TOKEN: undefined, SENTRY_ORG: undefined, SENTRY_PROJECT: undefined, SENTRY_PROJECTS: undefined });
    expect(await sentryHourlyErrorCounts(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'))).toBeNull();
  });

  it('sums accepted error events per hour across the configured projects', async () => {
    configure('api,web');
    const calls: string[] = [];
    setSentryFetchForTests(async (url) => {
      calls.push(url);
      if (url.includes('/projects/alto/api/')) return json({ id: '11' });
      if (url.includes('/projects/alto/web/')) return json({ id: '22' });
      if (url.includes('/stats_v2/')) {
        return json({
          intervals: ['2026-07-01T00:00:00Z', '2026-07-01T01:00:00Z'],
          groups: [
            { by: { project: 11 }, series: { 'sum(quantity)': [3, 0] } },
            { by: { project: 22 }, series: { 'sum(quantity)': [1, 2] } },
          ],
        });
      }
      return json({ detail: 'not found' }, 404);
    });

    const rows = await sentryHourlyErrorCounts(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T02:00:00Z'));
    expect(rows).toEqual([
      { at: '2026-07-01T00:00:00Z', errors: 4 },
      { at: '2026-07-01T01:00:00Z', errors: 2 },
    ]);
    const stats = calls.find((c) => c.includes('/stats_v2/'))!;
    expect(stats).toContain('category=error');
    expect(stats).toContain('outcome=accepted');
    expect(stats).toContain('project=11');
    expect(stats).toContain('project=22');

    // A second read inside the cache window costs Sentry nothing.
    const before = calls.length;
    await sentryHourlyErrorCounts(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T02:00:00Z'));
    expect(calls.length).toBe(before);
  });

  it('turns a Sentry failure into null rather than a thrown request', async () => {
    configure();
    setSentryFetchForTests(async () => json({ detail: 'nope' }, 500));
    expect(await sentryHourlyErrorCounts(new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'))).toBeNull();
  });
});

describe('sentryOpenIssues', () => {
  it('lists unresolved issues most frequent first, across projects', async () => {
    configure('api,web');
    setSentryFetchForTests(async (url) => {
      if (url.includes('/projects/alto/api/issues/')) {
        expect(url).toContain('query=is%3Aunresolved');
        expect(url).toContain('statsPeriod=7d');
        return json([
          { id: '1', shortId: 'API-1', title: 'TypeError', culprit: 'GET /api/x', count: '4', userCount: 2, firstSeen: 'a', lastSeen: 'b', permalink: 'p1' },
        ]);
      }
      if (url.includes('/projects/alto/web/issues/')) {
        return json([
          { id: '2', shortId: 'WEB-9', title: 'ChunkLoadError', culprit: '/schedule', count: 12, userCount: 7, firstSeen: 'a', lastSeen: 'b', permalink: 'p2' },
        ]);
      }
      return json({ detail: 'not found' }, 404);
    });
    const issues = await sentryOpenIssues(7, 10);
    expect(issues?.map((i) => i.shortId)).toEqual(['WEB-9', 'API-1']);
    expect(issues?.[0]?.project).toBe('web');
    expect(issues?.[1]?.count).toBe(4);
  });
});
