import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { listRoutes, type RouteEntry } from '../../lib/routeInventory.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-1 — the cross-tenant suite, generated from the router.
 *
 *   A second tenant is seeded with its own HR administrator. Every route
 *   the app mounts is called as that administrator with TENANT ONE's ids
 *   in its parameters. A 2xx on such a call, or a list that carries a
 *   tenant-one id, is a LEAK.
 *
 *   Today (observe mode, nothing enforced) most routes leak: that is the
 *   finding the enforcing step empties. The suite is still a gate: the
 *   known leaks live in crossTenant.baseline.json, and a route that
 *   leaks and is not in the baseline fails the run — a new route cannot
 *   regress unnoticed, and the baseline only ever shrinks.
 *
 *   TENANCY_SUITE=off skips it; TENANCY_BASELINE_WRITE=1 rewrites the
 *   baseline from what this run saw (print + file).
 */

const BASELINE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'crossTenant.baseline.json');
const T2 = '22222222-2222-4222-8222-222222222222';
const RANDOM = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

const SKIP = [
  /^\/auth\//,
  /^\/health/,
  /^\/resend\/webhook/,
  /^\/whatsapp\/webhook/,
  /^\/agent\/v1/,
  /^\/integrations\/v1/,
  /^\/kiosk\/punch/,
  /^\/kiosk\/(status|offline|heartbeat|boot|session)/,
  /live|stream|\/sse|subscribe/,
  /\*/,
];

interface Outcome {
  key: string;
  status: number | 'timeout' | 'error';
  leak: boolean;
  why: string;
}

const app = createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

/** Tenant one's world: one id per entity type the routes name. */
async function seedTenantOne() {
  const client = await createClient('Tenant One Client');
  const location = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const associate = await createAssociate({ firstName: 'One', lastName: 'Tenant' });
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: associateUser } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
  const application = await prisma.application.create({ data: { associateId: associate.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  const assignment = await prisma.associateAssignment.create({ data: { associateId: associate.id, locationId: location.id, startedAt: new Date() } });
  const shift = await prisma.shift.create({
    data: { clientId: client.id, locationId: location.id, position: 'Associate', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'ASSIGNED', assignedAssociateId: associate.id },
  });
  const timeEntry = await prisma.timeEntry.create({
    data: { associateId: associate.id, clientId: client.id, locationId: location.id, clockInAt: new Date(Date.now() - 8 * 3_600_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'APPROVED' },
  });
  const document = await prisma.documentRecord.create({ data: { associateId: associate.id, kind: 'ID', filename: 'one.pdf', mimeType: 'application/pdf', size: 10 } });
  const region = await prisma.region.create({ data: { name: 'Tenant One Region' } });
  // Brief 2-6 step 1: the agent registry is the customer's; tenant one's agent must not reach tenant two.
  const agentWorker = await prisma.worker.create({
    data: { type: 'AGENT', name: 'Tenant One Agent', ownerUserId: user.id, status: 'ACTIVE', agent: { create: { purpose: 'Reads the schedule', vendor: 'Test', model: 'test', modelVersion: '1', scopes: ['view:scheduling'] } } },
  });
  return {
    ids: {
      client: client.id,
      location: location.id,
      store: location.id,
      associate: associate.id,
      user: user.id,
      associateUser: associateUser.id,
      application: application.id,
      assignment: assignment.id,
      shift: shift.id,
      timeEntry: timeEntry.id,
      entry: timeEntry.id,
      document: document.id,
      region: region.id,
      agent: agentWorker.id,
    } as Record<string, string>,
  };
}

/** Which tenant-one id a path parameter stands for. */
function idFor(param: string, routePath: string, ids: Record<string, string>): string {
  const p = param.toLowerCase();
  const byName: Array<[RegExp, string]> = [
    [/associate/, 'associate'],
    [/client/, 'client'],
    [/location|store|site/, 'location'],
    [/shift/, 'shift'],
    [/user/, 'user'],
    [/application|app$/, 'application'],
    [/assignment/, 'assignment'],
    [/entry|time/, 'timeEntry'],
    [/document|doc/, 'document'],
    [/region/, 'region'],
    [/agent|worker/, 'agent'],
  ];
  for (const [re, key] of byName) if (re.test(p) && ids[key]) return ids[key]!;
  if (p === 'id') {
    const first = routePath.split('/').filter(Boolean)[0] ?? '';
    const seg = routePath.replace(/\/:id.*$/, '').split('/').filter(Boolean).pop() ?? first;
    const byPath: Array<[RegExp, string]> = [
      [/^associates?$|^people$|^directory$/, 'associate'],
      [/^clients?$/, 'client'],
      [/^locations?$|^stores?$/, 'location'],
      [/^shifts?$/, 'shift'],
      [/^users?$/, 'user'],
      [/^applications?$/, 'application'],
      [/^assignments?$/, 'assignment'],
      [/^time|entries$/, 'timeEntry'],
      [/^documents?$/, 'document'],
      [/^regions?$/, 'region'],
      [/^agents?$|^workers?$/, 'agent'],
    ];
    for (const [re, key] of byPath) if (re.test(seg) && ids[key]) return ids[key]!;
    return ids.associate!;
  }
  return RANDOM;
}

function fill(route: RouteEntry, ids: Record<string, string>): string {
  return route.path.replace(/:([A-Za-z_]+)\??/g, (_m, name: string) => idFor(name, route.path, ids));
}

const ORDER: Record<string, number> = { GET: 0, HEAD: 0, POST: 1, PUT: 2, PATCH: 2, DELETE: 3 };

describe.skipIf(process.env.TENANCY_SUITE === 'off')('cross-tenant suite (generated from the router)', () => {
  let t2: TestAgent<Test>;
  let ids: Record<string, string>;
  let routes: RouteEntry[];

  beforeAll(async () => {
    await truncateAll();
    ({ ids } = await seedTenantOne());
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@tenant-two.example' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
    t2 = await loginAs(user.email);
    routes = listRoutes(app)
      .filter((r) => !SKIP.some((re) => re.test(r.path)))
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .sort((a, b) => (ORDER[a.method] ?? 9) - (ORDER[b.method] ?? 9) || a.path.localeCompare(b.path));
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('calls every route as the other tenant with tenant one\'s ids and reports every leak against the baseline', async () => {
    expect(routes.length).toBeGreaterThan(300);
    const t1Ids = Object.values(ids);
    const outcomes: Outcome[] = [];
    for (const route of routes) {
      const hasParams = /:[A-Za-z_]+/.test(route.path);
      const url = fill(route, ids);
      const key = `${route.method} ${route.path}`;
      let res: request.Response | null = null;
      let status: Outcome['status'];
      try {
        const req = (t2 as unknown as Record<string, (u: string) => Test>)[route.method.toLowerCase()]!(url).timeout({ response: 20_000, deadline: 30_000 });
        res = route.method === 'GET' || route.method === 'DELETE' ? await req : await req.send({});
        status = res.status;
      } catch (err) {
        status = /timeout/i.test(String(err)) ? 'timeout' : 'error';
      }
      let leak = false;
      let why = '';
      if (typeof status === 'number' && status >= 200 && status < 300) {
        if (hasParams) {
          leak = true;
          why = `${status} with tenant one's id`;
        } else if (route.method === 'GET') {
          const text = res ? JSON.stringify(res.body ?? {}) + (typeof res.text === 'string' ? res.text : '') : '';
          const found = t1Ids.find((id) => text.includes(id));
          if (found) {
            leak = true;
            why = `${status} list carries a tenant one id`;
          }
        }
      }
      if (status === 429) {
        why = 'rate limited';
      }
      outcomes.push({ key, status, leak, why });
    }

    const rateLimited = outcomes.filter((o) => o.status === 429);
    expect(rateLimited, 'the suite must not be rate limited').toEqual([]);

    const leaks = outcomes.filter((o) => o.leak).map((o) => o.key).sort();
    const summary = {
      routes: outcomes.length,
      leaks: leaks.length,
      timeouts: outcomes.filter((o) => o.status === 'timeout').length,
      errors: outcomes.filter((o) => o.status === 'error').length,
    };
    console.log(`[cross-tenant] ${summary.routes} routes called as tenant two; ${summary.leaks} leak tenant one's data; ${summary.timeouts} timed out; ${summary.errors} errored`);

    const baselineExists = fs.existsSync(BASELINE);
    if (!baselineExists || process.env.TENANCY_BASELINE_WRITE === '1') {
      const json = JSON.stringify({ generatedAt: new Date().toISOString(), ...summary, leaks }, null, 2);
      console.log(`[cross-tenant] baseline ${baselineExists ? 'rewritten' : 'written'} (${leaks.length} known leaks):\n${json}`);
      fs.writeFileSync(BASELINE, json + '\n');
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as { leaks: string[] };
    const known = new Set(baseline.leaks);
    const newLeaks = leaks.filter((k) => !known.has(k));
    const fixed = baseline.leaks.filter((k) => !leaks.includes(k));
    if (fixed.length) console.log(`[cross-tenant] ${fixed.length} baseline routes no longer leak — shrink crossTenant.baseline.json:\n${fixed.join('\n')}`);
    expect(newLeaks, 'routes that leak tenant one\'s data and are not in the baseline').toEqual([]);
  }, 900_000);
});
