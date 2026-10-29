import { describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES, isClientBoundedRole, type Capability, type Role } from '@alto-people/shared';
import { apiRouteFor, appRoutes, type ApiRoute } from './tables';

/**
 * A route's guard implies the capabilities of the reads its page makes on
 * mount (deep audit 2026-10-29, CRAWL-11/12 and crawl upgrade #2).
 *
 * The crawl found pages a role could open whose first read the API refused:
 * /reimbursements let five roles in on view:dashboard while GET
 * /reimbursements needs view:payroll; /scheduling/coverage and /call-outs let
 * an associate in on view:scheduling; /admin/task-policy let the client
 * portal in while GET /tasks/policy needs view:time-live; seven routes had no
 * guard at all and printed "Missing capability: …". Each showed a page
 * header over an error, or a false "Nothing waiting".
 *
 * For every route below, every role its App.tsx guard admits must pass every
 * capability check on the endpoints the page reads on mount — read from the
 * API's own source (the requireCapability / requireAnyCapability on the
 * route, its router and its mount in app.ts). A role whose page variant reads
 * something else is exempt, with why.
 */

interface Parity {
  /** Endpoints the page reads on mount, as the web calls them. */
  reads: string[];
  /** Roles the page sends to another view (and why). */
  exempt?: Partial<Record<Role, string>>;
}

const TABLE: Record<string, Parity> = {
  '/onboarding': {
    reads: ['GET /onboarding/applications'],
  },
  '/time-off': { reads: ['GET /time-off/me/requests'] },
  '/scheduling': {
    reads: ['GET /scheduling/shifts'],
    exempt: {
      ASSOCIATE: 'their own schedule view (AssociateScheduleView)',
      CLIENT_PORTAL: 'SchedulingHome shows the access page; the store’s week is /portal/schedule',
    },
  },
  '/scheduling/coverage': { reads: ['GET /scheduling/shifts'] },
  '/call-outs': { reads: ['GET /call-outs'] },
  '/recruiting': { reads: ['GET /recruiting/summary', 'GET /recruiting/candidates/board', 'GET /job-postings'] },
  '/holidays': { reads: ['GET /holidays', 'GET /holidays/upcoming'] },
  '/marketplace': { reads: ['GET /shifts/open'] },
  '/reimbursements': { reads: ['GET /reimbursements'] },
  '/performance/extras': { reads: ['GET /performance/goals'] },
  '/admin/task-policy': { reads: ['GET /tasks/policy'] },
  '/clients/:id': { reads: ['GET /clients/:id'] },
  '/payroll': { reads: ['GET /payroll/runs'] },
  '/integrations': { reads: ['GET /provider-connections'] },
};

const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];
const holds = (role: Role, cap: string) => ROLE_CAPABILITIES[role].has(cap as Capability);

describe('route guards imply their page’s reads', () => {
  const byPath = new Map(appRoutes().map((r) => [r.path, r]));

  it('every route in the table is guarded, and every read is an API route with a capability check', () => {
    const problems: string[] = [];
    for (const [path, row] of Object.entries(TABLE)) {
      const r = byPath.get(path);
      if (!r) problems.push(`${path}: not in App.tsx`);
      else if (!r.caps.length) problems.push(`${path}: no RequireCapability`);
      for (const read of row.reads) {
        const [method, p] = read.split(' ') as [string, string];
        const api = apiRouteFor(method, p);
        if (!api) problems.push(`${path}: ${read} is not an API route`);
        else if (!api.caps.length) problems.push(`${path}: ${read} (${api.file}:${api.line}) checks no capability — nothing to compare`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every role a guard admits passes the API’s checks on the page’s reads', () => {
    const problems: string[] = [];
    for (const [path, row] of Object.entries(TABLE)) {
      const guard = byPath.get(path);
      if (!guard?.caps.length) continue;
      const admitted = ROLES.filter((role) => guard.caps.some((c) => holds(role, c)) && !(guard.notClientBounded && isClientBoundedRole(role)));
      for (const read of row.reads) {
        const [method, p] = read.split(' ') as [string, string];
        const api: ApiRoute | null = apiRouteFor(method, p);
        if (!api) continue;
        for (const role of admitted) {
          if (row.exempt?.[role]) continue;
          const unmet = api.caps.filter((group) => !group.some((c) => holds(role, c)));
          if (unmet.length) problems.push(`${path} admits ${role} (guard ${guard.caps.join('|')}), but ${read} needs ${unmet.map((g) => g.join(' or ')).join(' and ')} (${api.file}:${api.line})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the parity check can fail (a loose guard is caught)', () => {
    // GET /reimbursements needs view:payroll: a view:dashboard guard admits a driver it refuses.
    const api = apiRouteFor('GET', '/reimbursements');
    expect(api?.caps).toEqual([['view:payroll']]);
    expect(holds('DRIVER', 'view:dashboard') && !api!.caps.every((g) => g.some((c) => holds('DRIVER', c)))).toBe(true);
    // A mount-level gate and a route-level any-of both count.
    expect(apiRouteFor('GET', '/scheduling/shifts')?.caps).toEqual([['view:scheduling'], ['manage:scheduling', 'view:executive', 'process:payroll']]);
  });
});
