import { describe, expect, it } from 'vitest';
import { apiLinks, appRouteKnown, appRoutes, linkPath, webLinks } from './tables';

/**
 * Every in-app link lands on a page (deep audit 2026-10-29, CRAWL-2 and
 * crawl upgrade #2). Two links the API wrote into notifications went to the
 * not-found page: the urgent "Payroll needs something from you" notice
 * (`/onboarding/me`) and the audit-chain-broken security alert
 * (`/admin/audit`). Nothing checked a notification's link against the
 * web's routes. This reads every literal link the API writes (linkUrl,
 * href, actionUrl, `${appUrl}/…`) and every literal target the web renders
 * (navigate, to=, href=, nav data, <Navigate>) and resolves each against
 * the route table in App.tsx.
 */

/** Links known to be dead, each with who is fixing it. The list only shrinks. */
const KNOWN_DEAD: Record<string, string> = {};

describe('in-app links', () => {
  it('reads the routes and links it checks (the check is not silently empty)', () => {
    expect(appRoutes().length).toBeGreaterThan(200);
    expect(apiLinks().length).toBeGreaterThan(300);
    expect(webLinks().length).toBeGreaterThan(800);
    // The security alert's link is one of the links read (it went to /admin/audit, a 404).
    expect(apiLinks().some((l) => l.file.startsWith('lib/auditChain.ts:'))).toBe(true);
  });

  it('every link the API writes into a notification, email or task opens a page', () => {
    const dead = apiLinks()
      .filter((l) => !appRouteKnown(linkPath(l.target)))
      .filter((l) => !KNOWN_DEAD[linkPath(l.target).split('?')[0]!])
      .map((l) => `${l.kind}: ${l.target}  <- apps/api/src/${l.file}`);
    expect(dead).toEqual([]);
  });

  it('every literal in-app target the web renders opens a page', () => {
    const dead = webLinks()
      .filter((l) => !appRouteKnown(linkPath(l.target)))
      .map((l) => `${l.kind}: ${l.target}  <- ${l.file}`);
    expect(dead).toEqual([]);
  });

  it('the not-found page is what an unknown path gets (the resolver can say no)', () => {
    expect(appRouteKnown('/no-such-page/at-all')).toBe(false);
    expect(appRouteKnown('/admin/audit')).toBe(false);
    expect(appRouteKnown('/audit')).toBe(true);
    expect(appRouteKnown('/people/:p')).toBe(true);
  });
});
