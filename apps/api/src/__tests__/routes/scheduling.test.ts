import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
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

    await flushPendingAudits();
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

    await flushPendingAudits();
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

  it('returns recent-past and future shifts but drops shifts older than 30 days', async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    // Published + assigned shifts created directly so we control startsAt.
    const recent = await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt: daysAgo(5),
        endsAt: new Date(daysAgo(5).getTime() + 8 * 3600 * 1000),
        status: 'COMPLETED',
        publishedAt: new Date(),
      },
    });
    const old = await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt: daysAgo(40),
        endsAt: new Date(daysAgo(40).getTime() + 8 * 3600 * 1000),
        status: 'COMPLETED',
        publishedAt: new Date(),
      },
    });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get('/scheduling/me/shifts');
    expect(res.status).toBe(200);
    const ids = res.body.shifts.map((s: { id: string }) => s.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it('nulls the bill and pay rates in the associate payload', async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 8 * 3_600_000),
        status: 'ASSIGNED',
        publishedAt: new Date(),
        hourlyRate: 42.5, // client bill rate — must never reach an associate
        payRate: 18.25,
      },
    });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get('/scheduling/me/shifts');
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(1);
    expect(res.body.shifts[0].hourlyRate).toBeNull();
    expect(res.body.shifts[0].payRate).toBeNull();
  });

  it('sets truncated=true when more shifts match than the cap returns', async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const base = Date.now() + 86_400_000;
    await prisma.shift.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        clientId: client.id,
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt: new Date(base + i * 3_600_000),
        endsAt: new Date(base + i * 3_600_000 + 1_800_000),
        status: 'ASSIGNED' as const,
        publishedAt: new Date(),
      })),
    });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get('/scheduling/me/shifts');
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(100);
    expect(res.body.truncated).toBe(true);
  });
});

describe('calendar feed URL rotation', () => {
  // The response URL is absolute and carries the prod-proxy /api prefix;
  // the express app itself mounts the feed at /calendar.
  const feedPath = (u: string) => new URL(u).pathname.replace(/^\/api/, '');

  it('rotate invalidates the old feed URL and the new one serves iCal', async () => {
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const meAgent = await loginAs(meUser.email);

    const before = await meAgent.get('/scheduling/me/calendar-url');
    expect(before.status).toBe(200);

    const okBefore = await request(app()).get(feedPath(before.body.url));
    expect(okBefore.status).toBe(200);
    expect(okBefore.text).toContain('BEGIN:VCALENDAR');

    const rotated = await meAgent.post('/scheduling/me/calendar-url/rotate');
    expect(rotated.status).toBe(200);
    expect(rotated.body.url).not.toBe(before.body.url);

    const oldAfter = await request(app()).get(feedPath(before.body.url));
    expect(oldAfter.status).toBe(404);
    const newAfter = await request(app()).get(feedPath(rotated.body.url));
    expect(newAfter.status).toBe(200);
    expect(newAfter.text).toContain('BEGIN:VCALENDAR');

    // GET hands out the rotated URL from now on.
    const again = await meAgent.get('/scheduling/me/calendar-url');
    expect(again.body.url).toBe(rotated.body.url);
  });

  it('feed 404s on malformed associate ids instead of erroring', async () => {
    const res = await request(app()).get('/calendar/v1/not-a-uuid/whatever.ics');
    expect(res.status).toBe(404);
  });

  it('feed events carry the site name, not just the sub-zone label', async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const loc = await prisma.location.create({
      data: { clientId: client.id, name: 'Store 1424', timezone: 'America/New_York' },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        location: 'Bar',
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 8 * 3_600_000),
        status: 'ASSIGNED',
        publishedAt: new Date(),
      },
    });

    const meAgent = await loginAs(meUser.email);
    const urlRes = await meAgent.get('/scheduling/me/calendar-url');
    const ics = await request(app()).get(feedPath(urlRes.body.url));
    expect(ics.status).toBe(200);
    expect(ics.text).toContain('LOCATION:Store 1424 · Bar');
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

describe('GET /scheduling/shifts — range boundary + truncation', () => {
  it('excludes a shift starting exactly at the exclusive `to` (no double-count)', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const startsAt = new Date(Date.now() + 60 * 60_000);
    const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60_000);
    await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Server',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });

    const from = new Date(startsAt.getTime() - 60 * 60_000).toISOString();
    const q = (to: string) =>
      `/scheduling/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    // `to` == the shift's start instant → excluded (belongs to the next window).
    const excluded = await a.get(q(startsAt.toISOString()));
    expect(excluded.status).toBe(200);
    expect(excluded.body.shifts).toHaveLength(0);
    expect(excluded.body.truncated).toBe(false);

    // `to` one minute later → the same shift now falls inside the window.
    const included = await a.get(q(new Date(startsAt.getTime() + 60_000).toISOString()));
    expect(included.body.shifts).toHaveLength(1);
  });
});
