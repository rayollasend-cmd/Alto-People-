import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { listRoutes, type RouteEntry } from '../../lib/routeInventory.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * The site-scope suite, generated from the router — the cross-tenant
 * suite's sibling one level down.
 *
 *   One client, two stores. People, shifts, time, documents, cases,
 *   skills and birthdays at each. An Operations manager bound to store A
 *   (User.scopeSiteIds) calls every GET list route the app mounts — no
 *   path parameters — and no response may carry anything that exists only
 *   at store B: B's person (id, email, surname), B's shift, B's time
 *   entry, B's document, B's case.
 *
 *   A route that legitimately shows another store's people to a store-
 *   bound office account belongs in siteScope.baseline.json with the
 *   reason beside it; anything else that leaks fails the run, so a new
 *   list route cannot forget the caller's reach. The baseline only shrinks.
 *
 *   SITE_SCOPE_SUITE=off skips it; SITE_SCOPE_BASELINE_WRITE=1 rewrites the
 *   leak list from this run (reasons for routes still listed are kept).
 */

const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'siteScope.baseline.json');

const SKIP = [
  /^\/auth\//,
  /^\/health/,
  /^\/resend\/webhook/,
  /^\/whatsapp\/webhook/,
  /^\/agent\/v1/,
  /^\/integrations\/v1/,
  /^\/kiosk\//,
  /live|stream|\/sse|subscribe/,
  /\*/,
  /\.(pdf|csv|zip|ics|xlsx)$/,
];

interface Baseline {
  generatedAt: string;
  routes: number;
  leaks: string[];
  /** Why each listed route may show another store's people to a store-bound office account. */
  reasons: Record<string, string>;
}

const app = createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app);
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

/** Everything at one store, named so a leak is unmistakable. */
async function seedStore(clientId: string, siteId: string, tag: 'North' | 'South') {
  const person = await createAssociate({ firstName: `Ann${tag}`, lastName: `${tag}sider`, email: `ann.${tag.toLowerCase()}@site-scope.example` });
  await prisma.associate.update({ where: { id: person.id }, data: { dob: new Date(Date.now() + 5 * 86_400_000 - 30 * 365 * 86_400_000) } });
  await prisma.application.create({ data: { associateId: person.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(), startDate: new Date('2024-01-02') } });
  await prisma.associateAssignment.create({ data: { associateId: person.id, locationId: siteId, startedAt: new Date('2024-01-02') } });
  const shift = await prisma.shift.create({
    data: { clientId, locationId: siteId, position: 'Associate', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000), status: 'ASSIGNED', assignedAssociateId: person.id, publishedAt: new Date() },
  });
  const entry = await prisma.timeEntry.create({
    data: { associateId: person.id, clientId, locationId: siteId, clockInAt: new Date(Date.now() - 8 * 3_600_000), clockOutAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED' },
  });
  const document = await prisma.documentRecord.create({ data: { associateId: person.id, kind: 'ID', filename: `${tag}.pdf`, mimeType: 'application/pdf', size: 10 } });
  const hrCase = await prisma.hrCase.create({ data: { associateId: person.id, category: 'OTHER', subject: `${tag} case`, description: 'x' } });
  return { person, shift, entry, document, hrCase };
}

describe.skipIf(process.env.SITE_SCOPE_SUITE === 'off')('site-scope suite (generated from the router)', () => {
  let scoped: TestAgent<Test>;
  let markers: string[];
  let routes: RouteEntry[];

  beforeAll(async () => {
    await truncateAll();
    const client = await createClient('Two Store Client');
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: 'America/New_York' } });
    await seedStore(client.id, north.id, 'North');
    const b = await seedStore(client.id, south.id, 'South');
    const skill = await prisma.skill.create({ data: { name: 'Forklift' } });
    await prisma.associateSkill.create({ data: { associateId: b.person.id, skillId: skill.id, level: 'EXPERT' } });
    // Everything that exists only at store B.
    markers = [b.person.id, b.person.email, 'Southsider', b.shift.id, b.entry.id, b.document.id, b.hrCase.id];

    const { user } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops.north@site-scope.example' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [north.id] } });
    scoped = await loginAs(user.email);
    routes = listRoutes(app)
      .filter((r) => r.method === 'GET' && !/:[A-Za-z_]+/.test(r.path))
      .filter((r) => !SKIP.some((re) => re.test(r.path)))
      .sort((x, y) => x.path.localeCompare(y.path));
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a store-bound office account reads no list route that shows another store’s people, against the baseline', async () => {
    expect(routes.length).toBeGreaterThan(150);
    const leaks: string[] = [];
    const statuses: Record<string, number> = {};
    for (const route of routes) {
      const key = `GET ${route.path}`;
      let res: request.Response;
      try {
        res = await scoped.get(route.path).timeout({ response: 20_000, deadline: 30_000 });
      } catch {
        continue;
      }
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status < 200 || res.status >= 300) continue;
      const text = JSON.stringify(res.body ?? {}) + (typeof res.text === 'string' ? res.text : '');
      const hit = markers.find((m) => text.includes(m));
      if (hit) {
        leaks.push(key);
        if (process.env.SITE_SCOPE_DEBUG) fs.appendFileSync(process.env.SITE_SCOPE_DEBUG, `${key} carries ${hit}: …${text.slice(Math.max(0, text.indexOf(hit) - 160), text.indexOf(hit) + 40)}…\n`);
      }
    }
    expect(statuses[429] ?? 0, 'the suite must not be rate limited').toBe(0);
    leaks.sort();
    console.log(`[site-scope] ${routes.length} list routes called as a store-bound office account; ${leaks.length} show another store's people`);

    const exists = fs.existsSync(BASELINE);
    const prior: Baseline | null = exists ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Baseline) : null;
    if (!exists || process.env.SITE_SCOPE_BASELINE_WRITE === '1') {
      const reasons: Record<string, string> = {};
      for (const k of leaks) reasons[k] = prior?.reasons[k] ?? 'TODO: say why this route may show another store’s people, or scope it.';
      const json: Baseline = { generatedAt: new Date().toISOString(), routes: routes.length, leaks, reasons };
      fs.writeFileSync(BASELINE, JSON.stringify(json, null, 2) + '\n');
      console.log(`[site-scope] baseline ${exists ? 'rewritten' : 'written'}:\n${leaks.join('\n')}`);
      return;
    }
    const known = new Set(prior!.leaks);
    const fresh = leaks.filter((k) => !known.has(k));
    const fixed = prior!.leaks.filter((k) => !leaks.includes(k));
    if (fixed.length) console.log(`[site-scope] ${fixed.length} baseline routes no longer leak — shrink siteScope.baseline.json:\n${fixed.join('\n')}`);
    expect(fresh, 'list routes that show another store’s people to a store-bound office account and are not in the baseline').toEqual([]);
    // Every listed route says why.
    for (const k of prior!.leaks) expect(prior!.reasons[k], `reason for ${k}`).toBeTruthy();
  }, 900_000);
});
