import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES } from '@/lib/modules';

/**
 * A page the sidebar gates is gated at the route too.
 *
 * Fourteen pages (/celebrations, /assets, /skills, /discipline …) were
 * mounted with no RequireCapability, so an associate following a link saw
 * the API's raw "Missing capability: view:org" under live tabs and
 * skeletons that never filled. The route now shows the access page
 * instead. This reads App.tsx and holds every module route to its module's
 * own requirement (lib/modules `requires` / `requiresAny`).
 */

const APP = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

/**
 * Module pages left unguarded on purpose: a self-service view lives on the
 * same route for people outside the module's capability, or the page has
 * not been checked against every role that links to it. Each needs a
 * reason; the list only shrinks.
 */
const UNGUARDED: Record<string, string> = {
  '/onboarding': 'associates open their own onboarding from it; not yet checked per role',
  '/time-attendance': 'the associate/driver punch view shares the route',
  '/timesheets': "Finance's alias of /time-attendance",
  '/time-off': 'self-service requests share the route',
  '/today': "the floor supervisor's Today; the page decides by role",
  '/portal/schedule': 'client portal page; the portal is gated by role, not capability',
  '/scheduling': 'the associate schedule view shares the route',
  '/communications': "everyone's notifications share the route",
  '/recruiting': 'not yet checked against every role that links to it',
  '/holidays': 'not yet checked against every role that links to it',
  '/marketplace': "associates' open shifts share the route",
  '/admin/access-certifications': 'any reviewer opens their own campaign; running one is gated in the page',
};

interface RouteGuard {
  path: string;
  guarded: boolean;
  caps: string[];
}

function routes(): RouteGuard[] {
  const out: RouteGuard[] = [];
  for (const m of APP.matchAll(/\{\s*path:\s*'([^']+)',\s*element:\s*(<[^\n]*)\},?\s*$/gm)) {
    const path = '/' + m[1]!.replace(/^\//, '');
    const element = m[2]!;
    const guard = /^<RequireCapability\s+cap="([^"]+)"(?:\s+anyOf=\{\[([^\]]*)\]\})?/.exec(element);
    const caps = guard ? [guard[1]!, ...(guard[2] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)] : [];
    out.push({ path, guarded: !!guard, caps });
  }
  return out;
}

describe('route guards follow the modules', () => {
  const byPath = new Map(routes().map((r) => [r.path, r]));

  it('reads the routes it checks (the check is not silently empty)', () => {
    expect(byPath.size).toBeGreaterThan(150);
  });

  it('every gated module page is wrapped in its module’s RequireCapability', () => {
    const problems: string[] = [];
    for (const mod of MODULES) {
      if (mod.requires === 'view:dashboard' && !mod.requiresAny?.length) continue;
      if (UNGUARDED[mod.path]) continue;
      const r = byPath.get(mod.path);
      if (!r) continue;
      if (!r.guarded) problems.push(`${mod.path}: no RequireCapability (module needs ${mod.requires})`);
    }
    expect(problems).toEqual([]);
  });

  it('a guard admits whoever the module admits (the route never locks out its own sidebar entry)', () => {
    const problems: string[] = [];
    for (const mod of MODULES) {
      const r = byPath.get(mod.path);
      if (!r?.guarded) continue;
      const needs = [mod.requires, ...(mod.requiresAny ?? [])];
      const missing = needs.filter((c) => c !== 'view:dashboard' && !r.caps.includes(c));
      if (missing.length) problems.push(`${mod.path}: guard ${r.caps.join('|')} misses ${missing.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('the pages the F500 audit found open are closed', () => {
    for (const p of ['/celebrations', '/assets', '/skills', '/mentorship', '/expirations', '/learning-paths', '/succession', '/probation', '/discipline', '/separations', '/vaccinations', '/ramp', '/compensation', '/workflows', '/headcount', '/team']) {
      expect(byPath.get(p)?.guarded, p).toBe(true);
    }
  });

  it('the exception list names only module routes that are still unguarded', () => {
    const stale = Object.keys(UNGUARDED).filter((p) => !byPath.has(p) || byPath.get(p)!.guarded);
    expect(stale).toEqual([]);
  });
});
