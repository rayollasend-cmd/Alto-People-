import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { TenantModule } from '@alto-people/shared';
import { createApp } from '../../app.js';
import { listRoutes, type RouteEntry } from '../../lib/routeInventory.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile, setTenantProfile } from '../../lib/tenantProfile.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * Module off → 404, generated from the router (tenant profiles §5.3 item 2).
 *
 * Every mounted route under a module's path prefixes answers 404 while the
 * module is off — as HR, and unauthenticated, since the gate runs before
 * any capability check so an off module is indistinguishable from an
 * absent one. The prefixes are the §5.2 table; a route added later under
 * one of them is covered without touching this file.
 */

const RANDOM = '00000000-0000-4000-8000-00000000abcd';

/** Brief module → the path prefixes it owns (apps/api/src/app.ts and the routers mounted at '/'). */
const GATES: Array<{ module: TenantModule; prefixes: string[] }> = [
  { module: 'clientPortal', prefixes: ['/client-portal', '/client-requests', '/clients', '/region', '/regions', '/messages', '/ready-to-work', '/finance/fieldglass'] },
  { module: 'billRates', prefixes: ['/finance/overview'] },
  { module: 'agentBuilder', prefixes: ['/agents', '/agent/v1'] },
  { module: 'transportation', prefixes: ['/transport'] },
  { module: 'programs', prefixes: ['/programs', '/season-plans'] },
  { module: 'payrollSync', prefixes: ['/integrations/v1', '/external-payments'] },
  { module: 'earnedWage', prefixes: ['/me/earned-wage', '/earned-wage'] },
];

/** Routes under a gated prefix that stay reachable on purpose. Keep this empty; name a route here only with its reason. */
const ALLOWLIST: Array<{ route: RegExp; reason: string }> = [];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

describe('module off → 404, generated from the router', () => {
  const app = createApp();
  let routes: RouteEntry[];
  let hr: Awaited<ReturnType<typeof loginAs>>;

  beforeAll(async () => {
    await truncateAll();
    invalidateTenantProfile();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    hr = await loginAs(agent(), user.email);
    routes = listRoutes(app).filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS');
  }, 60_000);

  afterAll(async () => {
    await setTenantProfile(ALTO_TENANT_ID, { resetToDefaults: true }, null).catch(() => undefined);
    invalidateTenantProfile();
    await prisma.$disconnect();
  });

  it('finds routes under every gated prefix', () => {
    for (const g of GATES) {
      const owned = routes.filter((r) => g.prefixes.some((p) => under(r.path, p)));
      expect(owned.length, `${g.module}: ${g.prefixes.join(', ')}`).toBeGreaterThan(0);
    }
  });

  for (const g of GATES) {
    it(`${g.module} off: every route under ${g.prefixes.join(', ')} answers 404`, async () => {
      await setTenantProfile(ALTO_TENANT_ID, { modules: { [g.module]: false } }, null);
      invalidateTenantProfile();
      try {
        const owned = routes
          .filter((r) => g.prefixes.some((p) => under(r.path, p)))
          .filter((r) => !ALLOWLIST.some((a) => a.route.test(`${r.method} ${r.path}`)));
        const leaks: string[] = [];
        for (const route of owned) {
          const url = route.path.replace(/:([A-Za-z_]+)\??/g, RANDOM);
          const m = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
          const signedIn = await (m === 'get' || m === 'delete' ? hr[m](url) : hr[m](url).send({}));
          if (signedIn.status !== 404) leaks.push(`${route.method} ${route.path} → ${signedIn.status} (signed in)`);
          const anonymous = await (m === 'get' || m === 'delete' ? request(app)[m](url) : request(app)[m](url).send({}));
          if (anonymous.status !== 404) leaks.push(`${route.method} ${route.path} → ${anonymous.status} (anonymous)`);
        }
        expect(leaks, leaks.join('\n')).toEqual([]);
      } finally {
        await setTenantProfile(ALTO_TENANT_ID, { modules: { [g.module]: true } }, null);
        invalidateTenantProfile();
      }
    }, 120_000);
  }

  it('with every module on, the first route of each prefix is reachable again (not 404)', async () => {
    await setTenantProfile(ALTO_TENANT_ID, { resetToDefaults: true }, null);
    invalidateTenantProfile();
    for (const g of GATES) {
      const first = routes.find((r) => r.method === 'GET' && g.prefixes.some((p) => under(r.path, p)) && !/:[A-Za-z_]+/.test(r.path));
      if (!first) continue;
      const res = await hr.get(first.path);
      expect(res.status, `${first.method} ${first.path}`).not.toBe(404);
    }
  });
});
