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

// Seeds a user who CAN self-clock — i.e. a manager with an Associate
// record, since hourly ASSOCIATEs are now blocked from /me/clock-* and
// must use the kiosk PIN flow.
async function seedSelfClocker() {
  const client = await createClient();
  const associate = await createAssociate();
  const { user } = await createUser({
    role: 'MANAGER',
    email: associate.email,
    associateId: associate.id,
    clientId: client.id,
  });
  return { client, associate, user };
}

describe('GET /time/me/active', () => {
  it('returns null when associate has no active entry', async () => {
    const { user } = await seedSelfClocker();
    const a = await loginAs(user.email);
    const res = await a.get('/time/me/active');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: null });
  });

  it('returns the open entry after clock-in', async () => {
    const { user } = await seedSelfClocker();
    const a = await loginAs(user.email);
    await a.post('/time/me/clock-in').send({});
    const res = await a.get('/time/me/active');
    expect(res.status).toBe(200);
    expect(res.body.active).not.toBeNull();
    expect(res.body.active.status).toBe('ACTIVE');
  });
});

describe('POST /time/me/clock-in', () => {
  it('creates an ACTIVE entry, denormalizes clientId, writes audit log', async () => {
    const { client, associate, user } = await seedSelfClocker();
    const a = await loginAs(user.email);

    const res = await a.post('/time/me/clock-in').send({ notes: 'starting morning shift' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.notes).toBe('starting morning shift');
    expect(res.body.clientId).toBe(client.id);

    const row = await prisma.timeEntry.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.associateId).toBe(associate.id);
    expect(row.clockOutAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'time.clock_in', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('returns 409 when already clocked in (partial unique index enforces it)', async () => {
    const { user } = await seedSelfClocker();
    const a = await loginAs(user.email);

    const ok = await a.post('/time/me/clock-in').send({});
    expect(ok.status).toBe(201);

    const dup = await a.post('/time/me/clock-in').send({});
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('already_clocked_in');
  });

  it('returns 403 when caller has no associate profile', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({});
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('no_associate_record');
  });

  it('rejects ASSOCIATE role (must use the kiosk PIN flow)', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-in').send({});
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('use_kiosk');
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app()).post('/time/me/clock-in').send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /time/me/clock-out', () => {
  it('closes the active entry and sets status COMPLETED', async () => {
    const { user } = await seedSelfClocker();
    const a = await loginAs(user.email);

    const inRes = await a.post('/time/me/clock-in').send({});
    const id = inRes.body.id;

    const outRes = await a.post('/time/me/clock-out').send({});
    expect(outRes.status).toBe(200);
    expect(outRes.body.id).toBe(id);
    expect(outRes.body.status).toBe('COMPLETED');
    expect(outRes.body.clockOutAt).not.toBeNull();
    expect(outRes.body.minutesElapsed).toBeGreaterThanOrEqual(0);

    // Active query is now empty.
    const empty = await a.get('/time/me/active');
    expect(empty.body).toEqual({ active: null });
  });

  it('returns 409 when not clocked in', async () => {
    const { user } = await seedSelfClocker();
    const a = await loginAs(user.email);
    const res = await a.post('/time/me/clock-out').send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('not_clocked_in');
  });
});

describe('GET /time/me/entries', () => {
  it('returns this associate\'s entries only, in reverse-chronological order', async () => {
    const { user, associate } = await seedSelfClocker();
    const a = await loginAs(user.email);

    // Two entries for this associate.
    await a.post('/time/me/clock-in').send({});
    await a.post('/time/me/clock-out').send({});
    await a.post('/time/me/clock-in').send({});
    await a.post('/time/me/clock-out').send({});

    // One for an unrelated associate.
    const otherAssoc = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: otherAssoc.id,
        clockInAt: new Date(),
        clockOutAt: new Date(),
        status: 'COMPLETED',
      },
    });

    const res = await a.get('/time/me/entries');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    for (const e of res.body.entries) {
      expect(e.associateId).toBe(associate.id);
    }
    // Reverse chronological
    const ts = res.body.entries.map((e: { clockInAt: string }) => Date.parse(e.clockInAt));
    expect(ts).toEqual([...ts].sort((x, y) => y - x));
  });
});

describe('GET /time/admin/entries', () => {
  it('returns 403 to ASSOCIATE (lacks manage:time)', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.get('/time/admin/entries');
    expect(res.status).toBe(403);
  });

  it('HR_ADMINISTRATOR sees every entry; supports status filter', async () => {
    const { user: assocUser } = await seedSelfClocker();
    const associateAgent = await loginAs(assocUser.email);
    await associateAgent.post('/time/me/clock-in').send({});
    await associateAgent.post('/time/me/clock-out').send({});
    await associateAgent.post('/time/me/clock-in').send({});
    // leave 2nd entry ACTIVE

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const all = await hrAgent.get('/time/admin/entries');
    expect(all.status).toBe(200);
    expect(all.body.entries.length).toBe(2);

    const completed = await hrAgent.get('/time/admin/entries?status=COMPLETED');
    expect(completed.body.entries.every((e: { status: string }) => e.status === 'COMPLETED')).toBe(true);
    expect(completed.body.entries.length).toBe(1);
  });
});

describe('POST /time/admin/entries/:id/approve', () => {
  it('marks COMPLETED → APPROVED with approver tracked', async () => {
    const { user: assocUser } = await seedSelfClocker();
    const associateAgent = await loginAs(assocUser.email);
    const inRes = await associateAgent.post('/time/me/clock-in').send({});
    await associateAgent.post('/time/me/clock-out').send({});

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const res = await hrAgent.post(`/time/admin/entries/${inRes.body.id}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.approvedById).toBe(hr.id);
    expect(res.body.approverEmail).toBe(hr.email);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'time.approved', entityId: inRes.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('returns 409 when entry is still ACTIVE', async () => {
    const { user: assocUser } = await seedSelfClocker();
    const associateAgent = await loginAs(assocUser.email);
    const inRes = await associateAgent.post('/time/me/clock-in').send({});

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const res = await hrAgent.post(`/time/admin/entries/${inRes.body.id}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('still_active');
  });

  it('returns 403 to ASSOCIATE', async () => {
    // ASSOCIATEs can't reach /me/clock-in anymore (use_kiosk), so we
    // create the time entry directly. The point of this test is the
    // admin-approve gate, not the clock-in flow.
    const associate = await createAssociate();
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const entry = await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clockInAt: new Date(Date.now() - 3_600_000),
        clockOutAt: new Date(),
        status: 'COMPLETED',
      },
    });
    const associateAgent = await loginAs(assocUser.email);
    const res = await associateAgent.post(`/time/admin/entries/${entry.id}/approve`).send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /time/admin/entries/:id/reject', () => {
  it('marks COMPLETED → REJECTED with the supplied reason', async () => {
    const { user: assocUser } = await seedSelfClocker();
    const associateAgent = await loginAs(assocUser.email);
    const inRes = await associateAgent.post('/time/me/clock-in').send({});
    await associateAgent.post('/time/me/clock-out').send({});

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);

    const res = await hrAgent
      .post(`/time/admin/entries/${inRes.body.id}/reject`)
      .send({ reason: 'forgot to clock out, will resubmit' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.rejectionReason).toBe('forgot to clock out, will resubmit');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'time.rejected', entityId: inRes.body.id },
    });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as { reason?: string }).reason).toBe(
      'forgot to clock out, will resubmit'
    );
  });

  it('rejects without a reason is a 400', async () => {
    const { user: assocUser } = await seedSelfClocker();
    const associateAgent = await loginAs(assocUser.email);
    const inRes = await associateAgent.post('/time/me/clock-in').send({});
    await associateAgent.post('/time/me/clock-out').send({});

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const res = await hrAgent.post(`/time/admin/entries/${inRes.body.id}/reject`).send({});
    expect(res.status).toBe(400);
  });
});

describe('CLIENT_PORTAL access', () => {
  it('cannot view /time at all (lacks view:time)', async () => {
    const client = await createClient();
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const a = await loginAs(user.email);
    const res = await a.get('/time/me/entries');
    expect(res.status).toBe(403);
  });
});
