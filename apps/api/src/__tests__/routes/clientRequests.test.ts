import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The client in the loop: portal requests land as batons on the right
 * desk, the staff reply is client-visible, and tenants stay isolated.
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('client requests', () => {
  it('routes a staffing ask to the Workforce desk and shows the client its journey', async () => {
    const client = await createClient('Front Beach 218');
    const { user: portal } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: client.id,
    });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const agent = await loginAs(portal.email);
    const created = await agent.post('/client-portal/requests').send({
      kind: 'STAFFING',
      subject: 'Four more heads for Friday',
      body: 'Truck day doubled — we need four additional associates Friday 6am.',
    });
    expect(created.status).toBe(201);
    await flushPendingNotifications();

    // The Workforce desk is rung with the client's own words; HR is not
    // (staffing is not their baton).
    const bells = await prisma.notification.findMany({
      where: { category: 'client-request', channel: 'IN_APP' },
      select: { recipientUserId: true, subject: true, body: true },
    });
    expect(bells.some((b) => b.recipientUserId === wfm.id)).toBe(true);
    expect(bells.every((b) => b.recipientUserId !== hr.id)).toBe(true);
    expect(bells[0]!.subject).toContain('Front Beach 218');
    expect(bells[0]!.body).toContain('Truck day doubled');

    // Staff work it; the reply is what the client reads.
    const staff = await loginAs(wfm.email);
    const queue = await staff.get('/client-requests');
    expect(queue.status).toBe(200);
    expect(queue.body.requests).toHaveLength(1);
    expect(queue.body.requests[0].desk).toBe('WORKFORCE');
    const id = queue.body.requests[0].id as string;

    expect(
      (await staff.patch(`/client-requests/${id}`).send({ status: 'IN_PROGRESS' })).status,
    ).toBe(200);
    // Resolving without a reply is refused — the client must read something.
    expect(
      (await staff.patch(`/client-requests/${id}`).send({ status: 'RESOLVED' })).status,
    ).toBe(400);
    expect(
      (
        await staff.patch(`/client-requests/${id}`).send({
          status: 'RESOLVED',
          resolution: 'Four associates confirmed for Friday 6am — names are on your roster.',
        })
      ).status,
    ).toBe(200);

    // The client watches the whole journey, reply included.
    const mine = await agent.get('/client-portal/requests');
    expect(mine.status).toBe(200);
    expect(mine.body.requests[0].status).toBe('RESOLVED');
    expect(mine.body.requests[0].resolution).toContain('Four associates confirmed');
  });

  it('routes issues to HR, isolates tenants, and clamps bounded supervisors', async () => {
    const clientA = await createClient('Front Beach 218');
    const clientB = await createClient('Destin 4411');
    const { user: portalA } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: clientA.id,
    });
    const { user: portalB } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: clientB.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const agentA = await loginAs(portalA.email);
    await agentA.post('/client-portal/requests').send({
      kind: 'ISSUE',
      subject: 'Badge scanner rejected two workers',
      body: 'Two associates could not badge in this morning.',
    });
    await flushPendingNotifications();
    const bells = await prisma.notification.findMany({
      where: { category: 'client-request', channel: 'IN_APP' },
      select: { recipientUserId: true },
    });
    expect(bells.some((b) => b.recipientUserId === hr.id)).toBe(true);

    // Client B sees nothing of client A's requests.
    const agentB = await loginAs(portalB.email);
    const otherList = await agentB.get('/client-portal/requests');
    expect(otherList.body.requests).toHaveLength(0);

    // A bounded supervisor at B cannot see or touch A's request.
    const { user: supB } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: clientB.id,
    });
    const supAgent = await loginAs(supB.email);
    const reqRow = await prisma.clientRequest.findFirstOrThrow({
      select: { id: true },
    });
    // Supervisors lack view:org — the staff queue itself is above them.
    expect((await supAgent.get('/client-requests')).status).toBe(403);
    expect(
      (
        await supAgent
          .patch(`/client-requests/${reqRow.id}`)
          .send({ status: 'IN_PROGRESS' })
      ).status,
    ).toBe(404);

    // Staff cannot file requests — the desk is the client's alone.
    const hrAgent = await loginAs(hr.email);
    expect(
      (
        await hrAgent.post('/client-portal/requests').send({
          kind: 'ISSUE',
          subject: 'Not a client',
          body: 'Should fail.',
        })
      ).status,
    ).toBe(403);
  });
});
