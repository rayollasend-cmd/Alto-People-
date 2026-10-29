import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES, type Role } from '@alto-people/shared';
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
  '/today': "the floor supervisor's Today; the page decides by role",
  '/portal/schedule': 'client portal page; the portal is gated by role, not capability',
  '/communications': "everyone's notifications share the route",
  '/admin/access-certifications': 'any reviewer opens their own campaign; running one is gated in the page',
};

interface RouteGuard {
  path: string;
  guarded: boolean;
  /** The outermost guard's capabilities (cap ∪ anyOf). */
  caps: string[];
  /** Every nested guard, outermost first: a role passes when it holds one capability of EACH level. */
  levels: string[][];
}

function routes(): RouteGuard[] {
  const out: RouteGuard[] = [];
  for (const m of APP.matchAll(/\{\s*path:\s*'([^']+)',\s*element:\s*(<[^\n]*)\},?\s*$/gm)) {
    const path = '/' + m[1]!.replace(/^\//, '');
    let element = m[2]!;
    const levels: string[][] = [];
    for (;;) {
      // cap, an optional anyOf, then any other props (notClientBounded, selfService="…") up to the tag's end.
      const guard = /^<RequireCapability\s+cap="([^"]+)"(?:\s+anyOf=\{\[([^\]]*)\]\})?[^>]*>/.exec(element);
      if (!guard) break;
      levels.push([guard[1]!, ...(guard[2] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)]);
      element = element.slice(guard[0].length);
    }
    out.push({ path, guarded: levels.length > 0, caps: levels[0] ?? [], levels });
  }
  return out;
}

const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];
const holds = (role: Role, cap: string) => (ROLE_CAPABILITIES[role] as ReadonlySet<string>).has(cap);

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
      const needs = [mod.requires, ...(mod.requiresAny ?? [])].filter((c) => c !== 'view:dashboard');
      if (!needs.length) continue;
      // Every role the module shows the page to must pass every nested guard on the route.
      const shown = (role: Role) => needs.some((c) => holds(role, c)) && (!mod.alsoRequires || holds(role, mod.alsoRequires));
      const lockedOut = ROLES.filter((role) => shown(role) && !r.levels.every((level) => level.some((c) => holds(role, c))));
      if (lockedOut.length) problems.push(`${mod.path}: guard ${r.levels.map((l) => l.join('|')).join(' + ')} locks out ${lockedOut.join(', ')} (module needs ${needs.join('|')})`);
    }
    expect(problems).toEqual([]);
  });

  it('the pages the F500 audit found open are closed', () => {
    for (const p of ['/celebrations', '/assets', '/skills', '/mentorship', '/expirations', '/learning-paths', '/succession', '/probation', '/discipline', '/separations', '/vaccinations', '/ramp', '/compensation', '/workflows', '/headcount', '/team']) {
      expect(byPath.get(p)?.guarded, p).toBe(true);
    }
  });

  // Deep audit 2026-10-29 (CRAWL-11/12): seven routes left open printed the
  // API's "Missing capability: …" to roles outside them, and four guards were
  // looser than the read their page makes on mount. Each guard now names the
  // capability the page's first GET checks (lib/routes in apps/api); the
  // self-service views (an associate's schedule, time, time off, onboarding,
  // open shifts) live inside these, since associates hold them.
  it('the routes the deep audit found open or loose carry their API’s capability', () => {
    const want: Record<string, string[]> = {
      '/onboarding': ['view:onboarding'],
      '/time-attendance': ['view:time'],
      '/timesheets': ['view:time'],
      '/time-off': ['view:time'],
      '/scheduling': ['view:scheduling'],
      '/recruiting': ['view:recruiting'],
      '/holidays': ['view:scheduling'],
      '/marketplace': ['view:scheduling'],
      '/reimbursements': ['view:payroll'],
      '/scheduling/coverage': ['manage:scheduling', 'view:executive', 'process:payroll'],
      '/call-outs': ['manage:scheduling', 'view:executive'],
      '/performance/extras': ['view:hr-admin'],
      '/admin/task-policy': ['view:time-live'],
    };
    for (const [path, caps] of Object.entries(want)) {
      expect(byPath.get(path)?.caps, path).toEqual(caps);
    }
  });

  it('the exception list names only module routes that are still unguarded', () => {
    const stale = Object.keys(UNGUARDED).filter((p) => !byPath.has(p) || byPath.get(p)!.guarded);
    expect(stale).toEqual([]);
  });
});
