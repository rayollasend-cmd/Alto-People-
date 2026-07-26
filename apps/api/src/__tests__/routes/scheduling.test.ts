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

  it('feed 404s (not 500s) on a token with multibyte chars of equal string length', async () => {
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const meAgent = await loginAs(meUser.email);
    const urlRes = await meAgent.get('/scheduling/me/calendar-url');
    const goodPath = feedPath(urlRes.body.url);
    // Same string length as the real token, but a 2-byte char makes the
    // UTF-8 buffer longer — timingSafeEqual would throw on raw buffers.
    const evilPath = goodPath.replace(/\/([^/]+)\.ics$/, (_m, tok: string) => {
      const evil = 'é' + tok.slice(1);
      return `/${encodeURIComponent(evil)}.ics`;
    });
    const res = await request(app()).get(evilPath);
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

describe('GET /scheduling/me/shifts/:id — detail + teammates', () => {
  it('returns overlapping published teammates at the same site only', async () => {
    const client = await createClient();
    const loc = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    const otherLoc = await prisma.location.create({
      data: { clientId: client.id, name: 'Annex' },
    });
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const buddy = await createAssociate({ firstName: 'Pat', lastName: 'Nguyen' });
    const elsewhere = await createAssociate({ firstName: 'Sam', lastName: 'Faraway' });
    const later = await createAssociate({ firstName: 'Lea', lastName: 'Later' });
    const ghost = await createAssociate({ firstName: 'Gus', lastName: 'Draft' });

    const t0 = Date.now() + 24 * 3_600_000;
    const at = (h: number) => new Date(t0 + h * 3_600_000);
    const mk = (data: Record<string, unknown>) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Server',
          publishedAt: new Date(),
          status: 'ASSIGNED',
          startsAt: at(0),
          endsAt: at(8),
          ...data,
        } as never,
      });

    const mine = await mk({
      locationId: loc.id,
      assignedAssociateId: me.id,
      hourlyRate: 40,
      payRate: 17,
    });
    await mk({
      locationId: loc.id,
      assignedAssociateId: buddy.id,
      position: 'Cashier',
      location: 'Front end',
      startsAt: at(2),
      endsAt: at(10),
    });
    // Excluded: same client but different site.
    await mk({ locationId: otherLoc.id, assignedAssociateId: elsewhere.id });
    // Excluded: same site, no time overlap.
    await mk({
      locationId: loc.id,
      assignedAssociateId: later.id,
      startsAt: at(9),
      endsAt: at(17),
    });
    // Excluded: overlapping but never published.
    await mk({
      locationId: loc.id,
      assignedAssociateId: ghost.id,
      publishedAt: null,
      status: 'DRAFT',
    });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get(`/scheduling/me/shifts/${mine.id}`);
    expect(res.status).toBe(200);
    expect(res.body.shift.id).toBe(mine.id);
    // Detail goes through the associate serializer too — no money fields.
    expect(res.body.shift.hourlyRate).toBeNull();
    expect(res.body.shift.payRate).toBeNull();
    expect(res.body.teammates).toHaveLength(1);
    expect(res.body.teammates[0]).toMatchObject({
      name: 'Pat Nguyen',
      position: 'Cashier',
      location: 'Front end',
    });
  });

  it("404s for another associate's shift", async () => {
    const client = await createClient();
    const me = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const other = await createAssociate({ firstName: 'Pat', lastName: 'Other' });
    const { user: meUser } = await createUser({
      role: 'ASSOCIATE',
      email: me.email,
      associateId: me.id,
    });
    const notMine = await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: other.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 3_600_000),
        endsAt: new Date(Date.now() + 8 * 3_600_000),
        status: 'ASSIGNED',
        publishedAt: new Date(),
      },
    });

    const meAgent = await loginAs(meUser.email);
    const res = await meAgent.get(`/scheduling/me/shifts/${notMine.id}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /scheduling/me/shifts/:id/swap-candidates', () => {
  it('lists the schedulable pool minus me, flagging overlaps as busy', async () => {
    const client = await createClient();
    const loc = await prisma.location.findFirstOrThrow({
      where: { clientId: client.id },
    });
    const mkQualified = async (firstName: string, lastName: string) => {
      const a = await createAssociate({ firstName, lastName });
      await createUser({ role: 'ASSOCIATE', email: a.email, associateId: a.id });
      // Open assignment = schedulable (Phase 131 gate).
      await prisma.associateAssignment.create({
        data: { associateId: a.id, locationId: loc.id, startedAt: new Date() },
      });
      return a;
    };

    const me = await mkQualified('Maria', 'Lopez');
    const free = await mkQualified('Fay', 'Free');
    const busy = await mkQualified('Bob', 'Busy');
    // No user account → not schedulable → must not appear at all.
    await createAssociate({ firstName: 'Nou', lastName: 'Ser' });

    const startsAt = new Date(Date.now() + 24 * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3_600_000);
    const mine = await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: me.id,
        position: 'Server',
        startsAt,
        endsAt,
        status: 'ASSIGNED',
        publishedAt: new Date(),
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: busy.id,
        position: 'Cook',
        startsAt: new Date(startsAt.getTime() + 3_600_000),
        endsAt: new Date(endsAt.getTime() + 3_600_000),
        status: 'ASSIGNED',
        publishedAt: new Date(),
      },
    });

    const meAgent = await loginAs(`${me.email}`);
    const res = await meAgent.get(`/scheduling/me/shifts/${mine.id}/swap-candidates`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.candidates.map((c: { name: string; busy: boolean }) => [c.name, c.busy]),
    );
    expect(byName['Fay Free']).toBe(false);
    expect(byName['Bob Busy']).toBe(true);
    expect(byName['Maria Lopez']).toBeUndefined();
    expect(byName['Nou Ser']).toBeUndefined();
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

describe('POST /scheduling/copy-week', () => {
  // A DST-free window so the source→target offset is exactly 7×24h and clock
  // times carry over cleanly regardless of the CI machine's timezone.
  const SUN_SOURCE = new Date('2026-06-07T00:00:00'); // Sunday
  const SUN_TARGET = new Date('2026-06-14T00:00:00'); // next Sunday
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  async function seedSourceWeek(clientId: string, associateId: string) {
    // One assigned shift (Mon) and one open shift (Tue) in the source week.
    const assigned = await prisma.shift.create({
      data: {
        clientId,
        position: 'Server',
        startsAt: new Date('2026-06-08T09:00:00'),
        endsAt: new Date('2026-06-08T17:00:00'),
        status: 'ASSIGNED',
        assignedAssociateId: associateId,
        assignedAt: new Date('2026-06-01T00:00:00'),
      },
    });
    const open = await prisma.shift.create({
      data: {
        clientId,
        position: 'Cook',
        startsAt: new Date('2026-06-09T09:00:00'),
        endsAt: new Date('2026-06-09T17:00:00'),
        status: 'OPEN',
      },
    });
    return { assigned, open };
  }

  async function targetWeekShifts() {
    return prisma.shift.findMany({
      where: { startsAt: { gte: SUN_TARGET, lt: new Date(SUN_TARGET.getTime() + WEEK_MS) } },
      orderBy: { position: 'asc' },
    });
  }

  it('copies the whole week and carries each associate assignment forward as DRAFT', async () => {
    const client = await createClient();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const { assigned } = await seedSourceWeek(client.id, maria.id);

    const res = await a.post('/scheduling/copy-week').send({
      sourceWeekStart: SUN_SOURCE.toISOString(),
      targetWeekStart: SUN_TARGET.toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.assigned).toBe(1);

    const copies = await targetWeekShifts();
    expect(copies).toHaveLength(2);
    // Every copy is a reviewable draft — associates don't see it until publish.
    for (const c of copies) expect(c.status).toBe('DRAFT');

    const cook = copies.find((c) => c.position === 'Cook')!;
    const server = copies.find((c) => c.position === 'Server')!;
    // The previously-assigned shift keeps Maria; the open one stays unassigned.
    expect(server.assignedAssociateId).toBe(maria.id);
    expect(cook.assignedAssociateId).toBeNull();
    // Same day-of-week + time, one week later.
    expect(server.startsAt.getTime()).toBe(assigned.startsAt.getTime() + WEEK_MS);
  });

  it('preserveAssignments:false copies the week as blank, unassigned drafts', async () => {
    const client = await createClient();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    await seedSourceWeek(client.id, maria.id);

    const res = await a.post('/scheduling/copy-week').send({
      sourceWeekStart: SUN_SOURCE.toISOString(),
      targetWeekStart: SUN_TARGET.toISOString(),
      preserveAssignments: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.assigned).toBe(0);

    const copies = await targetWeekShifts();
    expect(copies).toHaveLength(2);
    for (const c of copies) expect(c.assignedAssociateId).toBeNull();
  });

  it('uses the sent window verbatim — a Monday-anchored week copies ITS Sunday, not the previous one', async () => {
    // Regression: the old handler re-snapped both dates to the preceding
    // server-local Sunday, so a Monday-anchored week's own Sunday never
    // copied while the PREVIOUS week's Sunday copied into the visible week.
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const MON_SOURCE = new Date('2026-06-08T00:00:00'); // Monday
    const MON_TARGET = new Date('2026-06-15T00:00:00'); // next Monday
    // Inside the Monday week — its last day (Sunday Jun 14).
    const inWindow = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date('2026-06-14T09:00:00'),
        endsAt: new Date('2026-06-14T17:00:00'),
        status: 'OPEN',
      },
    });
    // The day BEFORE the window (Sunday Jun 7) — the old snap wrongly
    // included this one.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Cook',
        startsAt: new Date('2026-06-07T09:00:00'),
        endsAt: new Date('2026-06-07T17:00:00'),
        status: 'OPEN',
      },
    });

    const res = await a.post('/scheduling/copy-week').send({
      sourceWeekStart: MON_SOURCE.toISOString(),
      targetWeekStart: MON_TARGET.toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);

    const copies = await prisma.shift.findMany({
      where: {
        startsAt: { gte: MON_TARGET, lt: new Date(MON_TARGET.getTime() + WEEK_MS) },
      },
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]!.position).toBe('Server');
    expect(copies[0]!.startsAt.getTime()).toBe(
      inWindow.startsAt.getTime() + WEEK_MS,
    );
  });

  it('keeps wall-clock time at the site across a DST boundary', async () => {
    // US DST ends Sun Nov 1 2026. A 2pm Eastern shift copied from the week
    // before must land at 2pm Eastern (19:00Z, not 18:00Z) the week after.
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date('2026-10-28T18:00:00Z'), // Wed 2pm EDT
        endsAt: new Date('2026-10-28T22:00:00Z'), // Wed 6pm EDT
        status: 'OPEN',
      },
    });

    const res = await a.post('/scheduling/copy-week').send({
      sourceWeekStart: '2026-10-26T00:00:00Z',
      targetWeekStart: '2026-11-02T00:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);

    const copy = await prisma.shift.findFirstOrThrow({
      where: { startsAt: { gte: new Date('2026-11-02T00:00:00Z') }, status: 'DRAFT' },
    });
    // 2pm EST = 19:00Z (one hour MORE than a raw +7×24h offset).
    expect(copy.startsAt.toISOString()).toBe('2026-11-04T19:00:00.000Z');
    expect(copy.endsAt.toISOString()).toBe('2026-11-04T23:00:00.000Z');
  });

  it('rejects a copy where source and target are the same week', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/scheduling/copy-week').send({
      sourceWeekStart: SUN_SOURCE.toISOString(),
      targetWeekStart: SUN_SOURCE.toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('same_week');
  });
});

/** ACTIVE_ASSOCIATE_FILTER needs an approved application OR an open
 *  assignment — give the fixture associate an open assignment at a site. */
async function placeAtSite(associateId: string, clientId: string) {
  const location = await prisma.location.create({
    data: { clientId, name: `Site ${Math.random().toString(36).slice(2, 8)}` },
  });
  await prisma.associateAssignment.create({
    data: { associateId, locationId: location.id, startedAt: new Date('2026-01-01') },
  });
  return location;
}

describe('POST /scheduling/auto-schedule-week — drafts', () => {
  it('assigns an unassigned DRAFT and keeps it DRAFT (publish-week stays the gate)', async () => {
    const client = await createClient();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await createUser({ role: 'ASSOCIATE', associateId: maria.id });
    await placeAtSite(maria.id, client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // A DST-free week; the shift is a Monday 9–17.
    const draft = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date('2026-06-08T13:00:00Z'),
        endsAt: new Date('2026-06-08T21:00:00Z'),
        status: 'DRAFT',
      },
    });

    const res = await a.post('/scheduling/auto-schedule-week').send({
      weekStart: '2026-06-08T00:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(1);

    const after = await prisma.shift.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.assignedAssociateId).toBe(maria.id);
    // Auto-filled drafts must stay invisible to associates until publish.
    expect(after.status).toBe('DRAFT');
  });
});

describe('GET /scheduling/availability-overview', () => {
  it('returns weekly windows and PTO/exception-blocked days per associate', async () => {
    const client = await createClient();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await createUser({ role: 'ASSOCIATE', associateId: maria.id });
    await placeAtSite(maria.id, client.id);
    await prisma.associateAvailability.create({
      data: { associateId: maria.id, dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
    });
    await prisma.timeOffRequest.create({
      data: {
        associateId: maria.id,
        category: 'VACATION',
        startDate: new Date('2026-06-10'),
        endDate: new Date('2026-06-11'),
        requestedMinutes: 960,
        status: 'APPROVED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get(
      '/scheduling/availability-overview?from=2026-06-08T00:00:00Z&to=2026-06-15T00:00:00Z',
    );
    expect(res.status).toBe(200);
    const row = res.body.associates.find(
      (x: { associateId: string }) => x.associateId === maria.id,
    );
    expect(row).toBeTruthy();
    expect(row.windows).toEqual([
      { dayOfWeek: 1, startMinute: 480, endMinute: 1020 },
    ]);
    expect(row.blockedDays).toEqual(
      expect.arrayContaining(['2026-06-10', '2026-06-11']),
    );
  });

  it('rejects a missing or oversized range', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    expect((await a.get('/scheduling/availability-overview')).status).toBe(400);
    const wide = await a.get(
      '/scheduling/availability-overview?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
    );
    expect(wide.status).toBe(400);
  });
});

describe('POST /scheduling/templates/:id/apply — site-timezone times', () => {
  it('stamps template minutes as wall-clock at the site, not server-local', async () => {
    const client = await createClient();
    // Default Location timezone is America/New_York.
    await prisma.location.create({
      data: { clientId: client.id, name: 'Front Beach' },
    });
    const tpl = await prisma.shiftTemplate.create({
      data: {
        clientId: client.id,
        name: 'Wed opener',
        position: 'Server',
        dayOfWeek: 3, // Wednesday
        startMinute: 540, // 9:00
        endMinute: 1020, // 17:00
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/scheduling/templates/${tpl.id}/apply`).send({
      weekStart: '2026-06-08T00:00:00Z',
    });
    expect(res.status).toBe(201);
    // Week containing Jun 8 00:00Z (= Jun 7 EDT evening → site-local week of
    // Sun Jun 7); Wednesday = Jun 10. 9:00 EDT = 13:00Z, machine-tz-agnostic.
    expect(new Date(res.body.startsAt).toISOString()).toBe('2026-06-10T13:00:00.000Z');
    expect(new Date(res.body.endsAt).toISOString()).toBe('2026-06-10T21:00:00.000Z');
  });
});

describe('Shift teams', () => {
  async function seedSite() {
    const client = await createClient();
    const location = await prisma.location.create({
      data: { clientId: client.id, name: 'Front Beach' },
    });
    return { client, location };
  }

  it('creates a team, manages members, and filters the roster by teamId', async () => {
    const { client, location } = await seedSite();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await createUser({ role: 'ASSOCIATE', associateId: maria.id });
    const omar = await createAssociate({ firstName: 'Omar', lastName: 'Nye' });
    await createUser({ role: 'ASSOCIATE', associateId: omar.id });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a.post('/scheduling/teams').send({
      clientId: client.id,
      locationId: location.id,
      name: 'Morning',
      startMinute: 360,
      endMinute: 840,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Morning',
      startMinute: 360,
      endMinute: 840,
      locationName: 'Front Beach',
      memberCount: 0,
    });
    const teamId = created.body.id as string;

    // Add Maria (twice — the second must be an idempotent no-op).
    expect(
      (await a.post(`/scheduling/teams/${teamId}/members`).send({ associateId: maria.id })).status,
    ).toBe(204);
    expect(
      (await a.post(`/scheduling/teams/${teamId}/members`).send({ associateId: maria.id })).status,
    ).toBe(204);

    const list = await a.get(`/scheduling/teams?locationId=${location.id}`);
    expect(list.status).toBe(200);
    expect(list.body.teams).toHaveLength(1);
    expect(list.body.teams[0].memberCount).toBe(1);

    // The roster narrowed to the team shows ONLY Maria — Omar (same org,
    // not on the crew) is out. This is the "only my shift's people" filter.
    const roster = await a.get(`/scheduling/associates?teamId=${teamId}`);
    expect(roster.status).toBe(200);
    expect(roster.body.associates.map((x: { id: string }) => x.id)).toEqual([maria.id]);

    // Detail flags Maria as not-at-this-site (no assignment/application there).
    const detail = await a.get(`/scheduling/teams/${teamId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.members).toHaveLength(1);
    expect(detail.body.members[0]).toMatchObject({
      associateId: maria.id,
      atLocation: false,
    });

    // Remove her; the team roster drains.
    expect(
      (await a.delete(`/scheduling/teams/${teamId}/members/${maria.id}`)).status,
    ).toBe(204);
    const after = await a.get(`/scheduling/associates?teamId=${teamId}`);
    expect(after.body.associates).toHaveLength(0);
  });

  it('soft-deleting a team removes it from lists and empties the team roster filter', async () => {
    const { client, location } = await seedSite();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a.post('/scheduling/teams').send({
      clientId: client.id,
      locationId: location.id,
      name: 'Overnight',
    });
    const teamId = created.body.id as string;
    expect((await a.delete(`/scheduling/teams/${teamId}`)).status).toBe(204);

    const list = await a.get(`/scheduling/teams?locationId=${location.id}`);
    expect(list.body.teams).toHaveLength(0);
    const roster = await a.get(`/scheduling/associates?teamId=${teamId}`);
    expect(roster.body.associates).toHaveLength(0);
  });

  it("rejects creating a team under another client's location", async () => {
    const { location } = await seedSite();
    const otherClient = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/scheduling/teams').send({
      clientId: otherClient.id,
      locationId: location.id,
      name: 'Sneaky',
    });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('location_not_found');
  });
});
