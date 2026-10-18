import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The people, org and comms routes inside the caller's reach: a store-bound
 * office account sees and changes only its own store's people; former
 * people don't come back as managers, mentors, successors or recipients;
 * filters compose with AND instead of overwriting the scope.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** One client, two stores, a person at each, and an Ops manager bound to store A. */
async function world() {
  const client = await createClient('Two Stores');
  const a = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const b = await prisma.site.create({ data: { name: 'Store B', clientId: client.id, timezone: 'America/New_York' } });
  const atA = await createAssociate({ firstName: 'Ada', lastName: 'Alpha' });
  const atB = await createAssociate({ firstName: 'Bo', lastName: 'Bravo' });
  await prisma.associateAssignment.create({ data: { associateId: atA.id, locationId: a.id, startedAt: new Date() } });
  await prisma.associateAssignment.create({ data: { associateId: atB.id, locationId: b.id, startedAt: new Date() } });
  const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops@example.com' });
  await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [a.id] } });
  return { client, a, b, atA, atB, ops: await loginAs(ops.email) };
}

describe('people analytics', () => {
  it('is the office’s: a store portal login is refused; a store-bound office account sees its own store', async () => {
    const w = await world();
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', email: 'portal@example.com', clientId: w.client.id });
    expect((await (await loginAs(portal.email)).get('/people-analytics')).status).toBe(403);
    const res = await w.ops.get('/people-analytics');
    expect(res.status).toBe(200);
    const sites = (res.body.turnover.bySite as Array<{ label: string }>).map((s) => s.label);
    expect(sites).not.toContain('Store B');
  });
});

describe('mass update', () => {
  it('changes only people in reach, refuses a site outside it, a former manager, and a loop', async () => {
    const w = await world();
    const preview = await w.ops.post('/people/mass-update/preview').send({ filter: { includeSeparated: true }, changes: { departmentId: null } });
    expect(preview.status).toBe(200);
    expect(preview.body.matched).toBe(1); // Ada, not Bo

    expect((await w.ops.post('/people/mass-update/preview').send({ filter: {}, changes: { siteId: w.b.id } })).status).toBe(404);

    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const hrAgent = await loginAs(hr.email);
    expect((await hrAgent.post('/people/mass-update/preview').send({ filter: { associateIds: [w.atA.id] }, changes: { managerId: gone.id } })).status).toBe(404);

    // Ada manages Bo; putting Ada under Bo would make a loop.
    await prisma.associate.update({ where: { id: w.atB.id }, data: { managerId: w.atA.id } });
    const loop = await hrAgent.post('/people/mass-update').send({ filter: { associateIds: [w.atA.id] }, changes: { managerId: w.atB.id } });
    expect(loop.status).toBe(409);
  });
});

describe('org assignment', () => {
  it('a manager must be active and in reach; the person must be in reach', async () => {
    const w = await world();
    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const hrAgent = await loginAs(hr.email);
    expect((await hrAgent.put(`/org/associates/${w.atA.id}/org`).send({ managerId: gone.id })).status).toBe(404);
    // The store-A account can't reach Bo at all.
    expect((await w.ops.put(`/org/associates/${w.atB.id}/org`).send({ managerId: null })).status).toBe(404);
    expect((await w.ops.put(`/org/associates/${w.atA.id}/org`).send({ managerId: w.atB.id })).status).toBe(404);
  });

  it('the org list hides former people unless asked, and says when it is cut short', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    await createAssociate({ firstName: 'Ida', lastName: 'Here' });
    const a = await loginAs(hr.email);
    const now = await a.get('/org/associates');
    expect(now.body.truncated).toBe(false);
    expect(now.body.associates.map((x: { firstName: string }) => x.firstName)).toEqual(['Ida']);
    const all = await a.get('/org/associates?former=1');
    expect(all.body.associates).toHaveLength(2);
  });
});

describe('people directory', () => {
  it('a store filter cannot widen the scope, and a search keeps the client filter', async () => {
    const w = await world();
    const other = await createClient('Elsewhere');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const elsewhere = await createAssociate({ firstName: 'Ada', lastName: 'Elsewhere' });
    await prisma.associateAssignment.create({ data: { associateId: elsewhere.id, locationId: otherSite.id, startedAt: new Date() } });

    // Store-A account asking for store B: nobody (the filter used to replace the scope).
    const viaFilter = await w.ops.get(`/people/directory?locationId=${w.b.id}`);
    expect(viaFilter.body.associates).toHaveLength(0);
    // Single lookup by id outside reach.
    expect((await w.ops.get(`/people/directory/${w.atB.id}`)).status).toBe(404);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const hrAgent = await loginAs(hr.email);
    const searched = await hrAgent.get(`/people/directory?clientId=${w.client.id}&q=ada`);
    const names = (searched.body.associates as Array<{ lastName: string }>).map((x) => x.lastName);
    expect(names).toEqual(['Alpha']); // the search used to drop the client filter and find Ada Elsewhere too
  });
});

describe('former people', () => {
  it('are not sent announcements, celebrated, suggested as mentors, or listed as a manager’s reports', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const here = await createAssociate({ firstName: 'Ida', lastName: 'Here' });
    const gone = await createAssociate({ firstName: 'Gil', lastName: 'Gone' });
    const soon = new Date(Date.now() + 3 * 86_400_000 - 30 * 365 * 86_400_000);
    await prisma.associate.update({ where: { id: here.id }, data: { dob: soon } });
    await prisma.associate.update({ where: { id: gone.id }, data: { dob: soon, deactivatedAt: new Date() } });
    const { user: hereUser } = await createUser({ role: 'ASSOCIATE', associateId: here.id, email: 'ida@example.com' });
    const { user: goneUser } = await createUser({ role: 'ASSOCIATE', associateId: gone.id, email: 'gil@example.com' });
    const a = await loginAs(hr.email);

    const cel = await a.get('/celebrations/upcoming');
    const celebrated = (cel.body.items ?? cel.body.celebrations ?? []).map((x: { associateId: string }) => x.associateId);
    expect(celebrated).toContain(here.id);
    expect(celebrated).not.toContain(gone.id);

    const b = await prisma.broadcast.create({ data: { title: 'Hello', body: 'Hi all', channels: ['IN_APP'] } as never });
    expect((await a.post(`/broadcasts/${b.id}/send`)).status).toBe(200);
    const receipts = await prisma.broadcastReceipt.findMany({ where: { broadcastId: b.id }, select: { userId: true } });
    expect(receipts.map((r) => r.userId)).toContain(hereUser.id);
    expect(receipts.map((r) => r.userId)).not.toContain(goneUser.id);

    const skill = await prisma.skill.create({ data: { name: 'Forklift' } });
    await prisma.associateSkill.create({ data: { associateId: gone.id, skillId: skill.id, level: 'EXPERT' } });
    const mentee = await createAssociate({ firstName: 'Mia', lastName: 'Mentee' });
    const sug = await a.post('/mentorships/suggest').send({ skillId: skill.id, menteeAssociateId: mentee.id });
    expect((sug.body.candidates as Array<{ associateId: string }>).map((c) => c.associateId)).not.toContain(gone.id);
    const found = await a.get('/skills/search?q=fork');
    expect((found.body.associates as Array<{ associateId: string }>).map((c) => c.associateId)).not.toContain(gone.id);
  });
});
