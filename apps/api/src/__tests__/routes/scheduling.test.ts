import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const future = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

describe('POST /scheduling/shifts', () => {
  it('HR creates a shift; audit log written', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
      hourlyRate: 18.5,
      location: 'Main dining',
    });
    expect(res.status).toBe(201);
    expect(res.body.position).toBe('Server');
    expect(res.body.status).toBe('OPEN');
    expect(res.body.scheduledMinutes).toBeGreaterThan(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'shift.created', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects endsAt before startsAt with 400', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60 * 8),
      endsAt: future(60),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown clientId', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: '00000000-0000-4000-8000-000000000000',
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    expect(res.status).toBe(404);
  });

  it('ASSOCIATE cannot create shifts', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    expect(res.status).toBe(403);
  });
});

describe('Assignment', () => {
  it('HR assigns → status flips to ASSIGNED with associate name', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });

    const assign = await a
      .post(`/scheduling/shifts/${create.body.id}/assign`)
      .send({ associateId: associate.id });
    expect(assign.status).toBe(200);
    expect(assign.body.status).toBe('ASSIGNED');
    expect(assign.body.assignedAssociateId).toBe(associate.id);
    expect(assign.body.assignedAssociateName).toBe('Maria Lopez');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'shift.assigned', entityId: create.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('cannot assign a CANCELLED shift', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    await a
      .post(`/scheduling/shifts/${create.body.id}/cancel`)
      .send({ reason: 'no longer needed' });

    const res = await a
      .post(`/scheduling/shifts/${create.body.id}/assign`)
      .send({ associateId: associate.id });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('shift_cancelled');
  });

  it('unassign reverts status to OPEN when previously ASSIGNED', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    await a
      .post(`/scheduling/shifts/${create.body.id}/assign`)
      .send({ associateId: associate.id });

    const un = await a.post(`/scheduling/shifts/${create.body.id}/unassign`).send({});
    expect(un.status).toBe(200);
    expect(un.body.status).toBe('OPEN');
    expect(un.body.assignedAssociateId).toBeNull();
  });

  it('unassign on never-assigned shift returns 409', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    const res = await a.post(`/scheduling/shifts/${create.body.id}/unassign`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('not_assigned');
  });
});

describe('Cancellation', () => {
  it('cancel sets status + reason; rejects empty reason', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const create = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });

    const bad = await a.post(`/scheduling/shifts/${create.body.id}/cancel`).send({});
    expect(bad.status).toBe(400);

    const ok = await a
      .post(`/scheduling/shifts/${create.body.id}/cancel`)
      .send({ reason: 'event postponed' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CANCELLED');
    expect(ok.body.cancellationReason).toBe('event postponed');
  });
});

describe('GET /scheduling/me/shifts', () => {
  it('ASSOCIATE sees only their own shifts; CANCELLED filtered out', async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const other = await createAssociate({ firstName: 'Pat', lastName: 'Other' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const hrAgent = await loginAs(hr.email);

    const mine = await hrAgent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    await hrAgent
      .post(`/scheduling/shifts/${mine.body.id}/assign`)
      .send({ associateId: me.id });

    const cancelled = await hrAgent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Cook',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    await hrAgent
      .post(`/scheduling/shifts/${cancelled.body.id}/assign`)
      .send({ associateId: me.id });
    await hrAgent
      .post(`/scheduling/shifts/${cancelled.body.id}/cancel`)
      .send({ reason: 'no longer needed' });

    const others = await hrAgent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    await hrAgent
      .post(`/scheduling/shifts/${others.body.id}/assign`)
      .send({ associateId: other.id });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get('/scheduling/me/shifts');
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(1);
    expect(res.body.shifts[0].id).toBe(mine.body.id);
  });
});

describe('CLIENT_PORTAL access', () => {
  it('CLIENT_PORTAL can view but cannot manage', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const create = await hrAgent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });

    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const portalAgent = await loginAs(portal.email);

    // CLIENT_PORTAL HAS view:scheduling, so /me/shifts works (returns []).
    const mine = await portalAgent.get('/scheduling/me/shifts');
    expect(mine.status).toBe(200);

    // But /shifts requires manage:scheduling.
    const list = await portalAgent.get('/scheduling/shifts');
    expect(list.status).toBe(403);

    const create2 = await portalAgent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: future(60),
      endsAt: future(60 * 8),
    });
    expect(create2.status).toBe(403);

    const cancel = await portalAgent
      .post(`/scheduling/shifts/${create.body.id}/cancel`)
      .send({ reason: 'X' });
    expect(cancel.status).toBe(403);
  });
});
