import { describe, expect, it } from 'vitest';
import { apiPathMatches, apiRoutes, webApiCalls } from './tables';

/**
 * Every API path the web calls answers somewhere (deep audit 2026-10-29,
 * crawl upgrade #2). The Oct 21 audit found two web calls to routes that no
 * longer existed (`/shifts/:id/qualifications`, `/surveys/:id/responses`):
 * each was a feature that failed only when someone pressed its button. This
 * reads every `apiFetch(…)` and every literal '/api/…' in apps/web/src and
 * matches it — path and method — against the routes apps/api mounts.
 */

/**
 * Calls the static reader can't follow, each with why. Matched on
 * `file` + normalized path; the list only shrinks.
 */
const UNRESOLVABLE: Record<string, string> = {};

describe('web → API contract', () => {
  const routes = apiRoutes();
  const calls = webApiCalls();

  it('reads the tables it checks (neither side is silently empty)', () => {
    expect(routes.length).toBeGreaterThan(2000);
    expect(calls.length).toBeGreaterThan(2000);
  });

  it('every path the web calls is an API route', () => {
    const missing = calls
      .filter((c) => c.path && !c.path.startsWith(':p'))
      .filter((c) => !routes.some((r) => apiPathMatches(c.path!, r.path)))
      .filter((c) => !UNRESOLVABLE[`${c.file} ${c.path}`])
      .map((c) => `${c.method} ${c.path}  <- ${c.file}:${c.line}`);
    expect(missing).toEqual([]);
  });

  it('every apiFetch method is one the route accepts', () => {
    const wrong = calls
      .filter((c) => c.kind === 'apiFetch' && c.path && !c.path.startsWith(':p') && c.method !== '?' && c.method !== 'ANY')
      .filter((c) => !UNRESOLVABLE[`${c.file} ${c.path}`])
      .flatMap((c) => {
        const hits = routes.filter((r) => apiPathMatches(c.path!, r.path));
        if (!hits.length || hits.some((r) => r.method === c.method || r.method === 'ALL')) return [];
        return [`${c.method} ${c.path}  <- ${c.file}:${c.line} (API has ${[...new Set(hits.map((h) => h.method))].join('/')})`];
      });
    expect(wrong).toEqual([]);
  });
});
