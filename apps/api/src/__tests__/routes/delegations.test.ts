import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createAssociate, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * Team delegation: a manager names cover for a date range, and for those
 * days the cover sees — and may act on — the manager's direct reports.
 * The scope must widen for the cover and never for anyone else, and it
 * must close itself on the end date.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => ymd(new Date(Date.now() + n * 86_400_000));

async function managerWithReport(first: string) {
  const managerAssociate = await createAssociate({ firstName: first, lastName: 'Manager' });
  const { user } = await createUser({ role: 'MANAGER', associateId: managerAssociate.id });
  const report = await createAssociate({ firstName: `${first}s`, lastName: 'Report' });
  await prisma.associate.update({ where: { id: report.id }, data: { managerId: managerAssociate.id } });
  return { user, managerAssociate, report };
}

describe('team delegation', () => {
  it('widens the cover’s team for the dates given, and no further', async () => {
    const alice = await managerWithReport('Alice');
    const bob = await managerWithReport('Bob');
    const a = await loginAs(alice.user.email);
    const b = await loginAs(bob.user.email);

    // Before: each sees only their own report.
    const bobBefore = await b.get('/team/reports');
    expect(bobBefore.body.reports.map((r: { firstName: string }) => r.firstName)).toEqual(['Bobs']);

    const created = await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(-1), endsOn: daysFromNow(3), note: 'Out sick' });
    expect(created.status).toBe(201);
    expect(created.body.delegation.to.name).toBe('Bob Manager');

    const bobDuring = await b.get('/team/reports');
    expect(bobDuring.body.reports.map((r: { firstName: string }) => r.firstName).sort()).toEqual(['Alices', 'Bobs']);
    // Alice keeps her own team throughout; cover adds a reader, never removes one.
    const aliceDuring = await a.get('/team/reports');
    expect(aliceDuring.body.reports.map((r: { firstName: string }) => r.firstName)).toEqual(['Alices']);

    const mine = await b.get('/delegations/mine');
    expect(mine.body.received).toHaveLength(1);
    expect(mine.body.received[0].from.name).toBe('Alice Manager');
    expect(mine.body.given).toEqual([]);

    // A delegation that has ended widens nothing.
    await prisma.teamDelegation.update({ where: { id: created.body.delegation.id }, data: { startsOn: new Date(daysFromNow(-10)), endsOn: new Date(daysFromNow(-2)) } });
    const bobAfter = await b.get('/team/reports');
    expect(bobAfter.body.reports.map((r: { firstName: string }) => r.firstName)).toEqual(['Bobs']);
  });

  it('refuses self-cover, overlaps, bad ranges and accounts without a team inbox', async () => {
    const alice = await managerWithReport('Alice');
    const bob = await managerWithReport('Bob');
    const { user: associate } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(alice.user.email);
    expect((await a.post('/delegations').send({ toUserId: alice.user.id, startsOn: daysFromNow(0), endsOn: daysFromNow(1) })).status).toBe(400);
    expect((await a.post('/delegations').send({ toUserId: associate.id, startsOn: daysFromNow(0), endsOn: daysFromNow(1) })).status).toBe(400);
    expect((await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(2), endsOn: daysFromNow(1) })).status).toBe(400);
    expect((await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(0), endsOn: daysFromNow(200) })).status).toBe(400);
    expect((await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(0), endsOn: daysFromNow(5) })).status).toBe(201);
    expect((await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(3), endsOn: daysFromNow(8) })).status).toBe(409);
    // Candidates are the other people with a team inbox.
    const candidates = await a.get('/delegations/candidates');
    expect(candidates.body.candidates.map((c: { id: string }) => c.id)).toEqual([bob.user.id]);
    // An associate has no inbox to delegate.
    const s = await loginAs(associate.email);
    expect((await s.get('/delegations/mine')).status).toBe(403);
  });

  it('only the giver can remove a delegation', async () => {
    const alice = await managerWithReport('Alice');
    const bob = await managerWithReport('Bob');
    const a = await loginAs(alice.user.email);
    const b = await loginAs(bob.user.email);
    const created = await a.post('/delegations').send({ toUserId: bob.user.id, startsOn: daysFromNow(0), endsOn: daysFromNow(2) });
    const id = created.body.delegation.id as string;
    expect((await b.delete(`/delegations/${id}`)).status).toBe(404);
    expect((await a.delete(`/delegations/${id}`)).status).toBe(200);
    expect((await b.get('/team/reports')).body.reports).toHaveLength(1);
  });
});
