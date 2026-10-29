import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUMAN_ROLES, ROLE_CAPABILITIES, type Role } from '@alto-people/shared';
import {
  DOORS,
  MODULES,
  RAIL_ROWS,
  navShapeFor,
  visibleModules,
  type ModuleKey,
} from '@/lib/modules';

/**
 * The navigation covers the product.
 *
 * Integrations, Reports, Document templates and Client statements each
 * shipped reachable only by typing the URL, and each was found by a user
 * asking "where is it?". These checks make the next one a failing build:
 *
 *   1. every signed-in route has a way in — a module, a page under one, or
 *      a documented exception;
 *   2. every module has a place in the rail — a row, a door, or the client
 *      portal's own menu — so nothing lands in the "More" safety net;
 *   3. no role's sidebar grows back into the hundred-row console.
 */

const APP = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

/** Pages that are public, or reached from the chrome rather than the rail. */
const NOT_IN_THE_RAIL: Record<string, string> = {
  '/login': 'public',
  '/forgot-password': 'public',
  '/verify': 'public: an outside employer checks a signed credential, no login',
  '/kiosk': 'the tablet, not a signed-in page',
  '/install': 'public install page',
  '/native-handoff': 'public: the system browser lands here after SSO / a passkey and hands the sign-in back to the native app',
  '/status': 'public status page',
  '/accessibility': 'public statement',
  '/careers': 'public careers page',
  '/hotline': 'public anonymous hotline',
  '/trust-center': 'public trust center (the signed-in one is /trust)',
  '/developers': 'public developer docs',
  '/settings': 'account settings — the account menu',
  '/whats-new': 'release notes — the help menu',
  '/support': 'support — the help menu',
  '/platform/support': 'the Settings & trust rail (platform operator)',
  '/admin/task-policy': 'the Settings & trust rail',
  '/worktags': 'opened from Payroll',
  '/admin/regions': 'old link — redirects to the Org chart field view',
  '/directory': 'old link — "Directory & comms" retired; redirects to People, Notifications › Broadcasts or Pulse',
  '/decisions/open': 'a hand-off, not a page: an assigned decision\'s notification lands here and is sent on to the item\'s own page',
};

const term = (key: string) => key;

function routePaths(): string[] {
  const out = new Set<string>();
  for (const m of APP.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)) {
    const p = '/' + m[1]!.replace(/^\//, '');
    if (p.includes(':') || p === '/*' || p === '/') continue;
    out.add(p);
  }
  return [...out];
}

function shapeFor(role: Role) {
  const caps = ROLE_CAPABILITIES[role];
  const can = (c: string) => caps.has(c as never);
  const visible = visibleModules(role, can as never, { regionId: null, modules: undefined, tenantId: null });
  return navShapeFor(visible, role, term);
}

describe('every signed-in page has a way in', () => {
  const navPaths = MODULES.map((m) => m.path);
  const reachable = (p: string) =>
    navPaths.includes(p) ||
    navPaths.some((n) => p.startsWith(`${n}/`)) ||
    Object.keys(NOT_IN_THE_RAIL).some((q) => p === q || p.startsWith(`${q}/`));

  it('routes in App.tsx are modules, pages under one, or a documented exception', () => {
    const orphans = routePaths().filter((p) => !reachable(p));
    expect(orphans, `Add a module in lib/modules.ts, or a reason in NOT_IN_THE_RAIL: ${orphans.join(', ')}`).toEqual([]);
  });

  it('the exception list only names routes that still exist', () => {
    const routes = routePaths();
    const stale = Object.keys(NOT_IN_THE_RAIL).filter((q) => !routes.some((p) => p === q || p.startsWith(`${q}/`)));
    expect(stale).toEqual([]);
  });
});

describe('every module has a place in the rail', () => {
  const placed = new Set<ModuleKey>(RAIL_ROWS);
  for (const d of Object.values(DOORS)) {
    if (d.hub) placed.add(d.hub);
    for (const c of d.children) placed.add(c);
  }
  it('a module is a row, behind a door, or the client portal’s own menu', () => {
    const portal = (k: string) => k.startsWith('portal') || k === 'region';
    const missing = MODULES.map((m) => m.key).filter((k) => !placed.has(k) && !portal(k));
    expect(missing, `Name a door for: ${missing.join(', ')}`).toEqual([]);
  });

  it('no role falls into the "More" safety net', () => {
    for (const role of HUMAN_ROLES) {
      const shape = shapeFor(role);
      const more = shape.doors.find((d) => d.key === 'more');
      expect(more?.children.map((c) => c.key) ?? [], `${role}: ${more?.children.map((c) => c.key).join(', ')}`).toEqual([]);
    }
  });
});

describe('the sidebar stays a dozen rows, not a hundred', () => {
  it('no role sees more than 20 top-level rows', () => {
    for (const role of HUMAN_ROLES) {
      const shape = shapeFor(role);
      const rows = shape.rows.length + shape.doors.length;
      expect(rows, role).toBeLessThanOrEqual(20);
    }
  });

  it('the roles that hold every capability still get a short rail', () => {
    for (const role of ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER', 'MANAGER', 'MARKETING_MANAGER'] as Role[]) {
      const shape = shapeFor(role);
      // 17 since the owner's Books door (2027-01) — the company's own finance is a door, not a corner of Pay.
      expect(shape.rows.length + shape.doors.length, role).toBeLessThanOrEqual(17);
    }
  });

  it('a marketing manager is not shown pay, compliance or settings doors', () => {
    const keys = shapeFor('MARKETING_MANAGER').doors.map((d) => d.key);
    expect(keys).not.toContain('pay');
    expect(keys).not.toContain('compliance');
    expect(keys).not.toContain('settings');
  });

  it('a marketing manager opens on its own door \u2014 the funnel \u2014 then the pipeline it feeds', () => {
    const keys = shapeFor('MARKETING_MANAGER').doors.map((d) => d.key);
    expect(keys.slice(0, 3)).toEqual(['me', 'marketing', 'hire']);
    const visible = shapeFor('MARKETING_MANAGER').doors.flatMap((d) => d.children.map((c) => c.key));
    expect(visible).toEqual(expect.arrayContaining(['marketing', 'recruiting', 'people']));
    for (const gone of ['payroll', 'scheduling', 'onboarding', 'compliance', 'users']) expect(visible, gone).not.toContain(gone);
  });

  it('the chairman reaches client NPS, the Trust center and the season planner from the nav', () => {
    const shape = shapeFor('EXECUTIVE_CHAIRMAN');
    const visible = [...shape.doors, ...(shape.folded?.doors ?? [])].flatMap((d) => [d.target.key, ...d.children.map((c) => c.key)]);
    expect(visible).toEqual(expect.arrayContaining(['client-nps', 'trust-center', 'season-planner']));
  });

  it('the chairman’s menu leads with the board topics; every other door is kept whole under All modules', () => {
    const shape = shapeFor('EXECUTIVE_CHAIRMAN');
    expect(shape.doors.map((d) => d.label)).toEqual(['Financials', 'Workforce', 'Client portfolio', 'Risk', 'Scenarios', 'Board packs', 'Operations pulse', 'Me']);
    expect(shape.folded?.label).toBe('All modules');
    expect(shape.folded?.doors.map((d) => d.key)).toEqual(expect.arrayContaining(['people', 'clients', 'insights', 'compliance']));
    // The executive pages are in the lead, not repeated inside Insights.
    const insights = shape.folded!.doors.find((d) => d.key === 'insights')!;
    expect(insights.children.map((c) => c.key).some((k) => k.startsWith('exec-'))).toBe(false);
    // An admin, who reads the same numbers, finds them in Insights.
    const admin = shapeFor('HR_ADMINISTRATOR');
    const adminInsights = admin.doors.find((d) => d.key === 'insights')!;
    expect(adminInsights.children.map((c) => c.key)).toEqual(expect.arrayContaining(['exec-financials', 'exec-risk']));
  });

  it('the associate\u2019s doors speak in the first person, and leave nothing out', () => {
    const shape = shapeFor('ASSOCIATE');
    const keys = shape.doors.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(['me', 'my-schedule', 'my-pay']));
    expect(keys).not.toContain('people');
    expect(shape.dropped.map((m) => m.key)).toEqual([]);
  });

  it('what an explicit rail leaves out is behind a door it chose not to show, never a module with no door at all', () => {
    const placed = new Set<ModuleKey>(RAIL_ROWS);
    for (const d of Object.values(DOORS)) {
      if (d.hub) placed.add(d.hub);
      for (const c of d.children) placed.add(c);
    }
    const homeless = shapeFor('MARKETING_MANAGER').dropped.map((m) => m.key).filter((k) => !placed.has(k));
    expect(homeless).toEqual([]);
  });
});

describe('the phone tabs and the desktop rail are one menu', () => {
  it('every tab a role gets is a destination its sidebar also shows', async () => {
    const { tabSetFor } = await import('@/components/BottomTabBar');
    for (const role of HUMAN_ROLES) {
      const caps = ROLE_CAPABILITIES[role];
      const can = (c: string) => caps.has(c as never);
      const visible = visibleModules(role, can as never, { regionId: null, modules: undefined, tenantId: null });
      const paths = new Set(visible.map((m) => m.path));
      const tabs = tabSetFor({ role, regionId: null, clientId: null }, can as never).filter(
        (t) => t.requires === null || can(t.requires),
      );
      const strays = tabs
        .map((t) => t.path)
        .filter((p) => p !== '/' && !paths.has(p) && ![...paths].some((n) => p.startsWith(`${n}/`)));
      expect(strays, `${role}: ${strays.join(', ')}`).toEqual([]);
    }
  });
});
