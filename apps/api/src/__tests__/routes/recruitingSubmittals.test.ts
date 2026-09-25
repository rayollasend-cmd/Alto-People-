import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A client reviews the candidates Alto puts forward.
 *
 * Putting someone in front of a client used to be a phone call: the
 * client's answer lived in the recruiter's head, and nothing of it reached
 * the candidate's record.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function setup() {
  const client = await createClient('Walmart');
  const [storeA] = await prisma.location.findMany({ where: { clientId: client.id } });
  const storeB = await prisma.location.create({ data: { clientId: client.id, name: 'Walmart Destin' } });
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const { user: market } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  const { user: storeBUser } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: storeBUser.id }, data: { locationId: storeB.id } });
  const a = await loginAs(rec.email);
  const c = await a.post('/recruiting/candidates').send({
    firstName: 'Kim', lastName: 'Phan', email: 'kim.phan@example.com', phone: '850-555-0101', position: 'Cashier',
  });
  return { a, rec, client, storeA: storeA!, storeB, market, storeBUser, candidateId: c.body.id as string };
}

describe('putting a candidate in front of a client', () => {
  it('the client sees who and why — not how to reach them — and their answer comes back', async () => {
    const { a, rec, client, market, candidateId } = await setup();
    // An interview Alto already ran, to show the client.
    const iv = await a.post('/interviews').send({ candidateId, scheduledFor: new Date(Date.now() - 3_600_000).toISOString(), notify: false });
    await a.post(`/interviews/${iv.body.id}/score`).send({ scorecard: null, rating: 2 });

    const sub = await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({
      clientId: client.id,
      pitch: 'Two years at Target, can open.',
    });
    expect(sub.status).toBe(201);
    expect(sub.body).toMatchObject({ status: 'PENDING', clientName: 'Walmart', locationName: null });
    // Once per client while they're deciding.
    expect((await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({ clientId: client.id })).status).toBe(409);

    // Their portal accounts heard about it.
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: market.id, channel: 'IN_APP', linkUrl: '/portal/candidates' } })).toBe(1);

    const m = await loginAs(market.email);
    const list = await m.get('/client-portal/candidates');
    expect(list.status).toBe(200);
    expect(list.body.canDecide).toBe(true);
    const [row] = list.body.candidates;
    expect(row).toMatchObject({
      name: 'Kim Phan',
      position: 'Cashier',
      pitch: 'Two years at Target, can open.',
      status: 'PENDING',
      interviewRatings: [2],
    });
    // Not theirs to have yet.
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain('kim.phan@example.com');
    expect(raw).not.toContain('850-555-0101');

    // Passing needs a reason.
    expect((await m.post(`/client-portal/candidates/${row.id}/decision`).send({ decision: 'DECLINED' })).status).toBe(400);
    const ok = await m.post(`/client-portal/candidates/${row.id}/decision`).send({ decision: 'APPROVED', feedback: 'Send her Monday.' });
    expect(ok.status).toBe(200);
    // Once.
    expect((await m.post(`/client-portal/candidates/${row.id}/decision`).send({ decision: 'DECLINED', feedback: 'x' })).status).toBe(409);

    const events = (await a.get(`/recruiting/candidates/${candidateId}/events`)).body.events;
    expect(events[0]).toMatchObject({ kind: 'CLIENT_FEEDBACK', body: 'Approved by Walmart\nSend her Monday.' });
    expect(events.map((e: { kind: string }) => e.kind)).toContain('SUBMITTED_TO_CLIENT');

    const mine = (await a.get(`/recruiting/candidates/${candidateId}/submittals`)).body.submittals;
    expect(mine[0]).toMatchObject({ status: 'APPROVED', feedback: 'Send her Monday.', decidedByEmail: market.email });

    await flushPendingNotifications();
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: rec.id, channel: 'IN_APP' } });
    expect(bell).toMatchObject({ subject: 'Walmart approved Kim Phan', body: 'Send her Monday.' });
  });

  it('a store sees its own and the whole client’s — never another store’s', async () => {
    const { a, client, storeA, storeB, storeBUser, candidateId } = await setup();
    const other = await a.post('/recruiting/candidates').send({ firstName: 'Lee', lastName: 'Ray', email: 'lee@example.com' });
    const third = await a.post('/recruiting/candidates').send({ firstName: 'Ana', lastName: 'Diaz', email: 'ana@example.com' });
    const forA = await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({ clientId: client.id, locationId: storeA.id });
    await a.post(`/recruiting/candidates/${other.body.id}/submittals`).send({ clientId: client.id, locationId: storeB.id });
    await a.post(`/recruiting/candidates/${third.body.id}/submittals`).send({ clientId: client.id });

    const b = await loginAs(storeBUser.email);
    const names = (await b.get('/client-portal/candidates')).body.candidates.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['Ana Diaz', 'Lee Ray']);
    // Store A's is not theirs to answer, either.
    const r = await b.post(`/client-portal/candidates/${forA.body.id}/decision`).send({ decision: 'APPROVED' });
    expect(r.status).toBe(404);
  });

  it('another client can’t see or answer it', async () => {
    const { a, client, candidateId } = await setup();
    const sub = await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({ clientId: client.id });
    const target = await createClient('Target');
    const { user: t } = await createUser({ role: 'CLIENT_PORTAL', clientId: target.id });
    const ta = await loginAs(t.email);
    expect((await ta.get('/client-portal/candidates')).body.candidates).toEqual([]);
    expect((await ta.post(`/client-portal/candidates/${sub.body.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(404);
  });

  it('only a client account answers for the client — Alto staff can’t', async () => {
    const { a, client, candidateId } = await setup();
    const sub = await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({ clientId: client.id });
    const r = await a.post(`/client-portal/candidates/${sub.body.id}/decision`).send({ decision: 'APPROVED' });
    expect(r.status).toBe(403);
  });

  it('a withdrawn candidate drops off the client’s list', async () => {
    const { a, client, market, candidateId } = await setup();
    const sub = await a.post(`/recruiting/candidates/${candidateId}/submittals`).send({ clientId: client.id });
    expect((await a.post(`/recruiting/submittals/${sub.body.id}/withdraw`)).status).toBe(200);
    const m = await loginAs(market.email);
    expect((await m.get('/client-portal/candidates')).body.candidates).toEqual([]);
    expect((await m.post(`/client-portal/candidates/${sub.body.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(409);
  });
});
