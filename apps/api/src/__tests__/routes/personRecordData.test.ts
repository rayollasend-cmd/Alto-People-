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

/**
 * What the person record reads that nothing else did:
 *   - one person's time-off requests (GET /time-off/admin/requests?associateId=),
 *     under the desk scope like the rest of the list;
 *   - who can be messaged: the directory entry names the login the
 *     messenger serves (staff), never a plain associate's.
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

async function requestFor(associateId: string, category: 'VACATION' | 'SICK') {
  return prisma.timeOffRequest.create({
    data: {
      associateId,
      category,
      startDate: new Date('2026-11-02T00:00:00Z'),
      endDate: new Date('2026-11-03T00:00:00Z'),
      requestedMinutes: 960,
      status: 'PENDING',
    },
  });
}

describe('GET /time-off/admin/requests?associateId=', () => {
  it("returns one person's requests, and the whole queue without it", async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Diaz' });
    await requestFor(ana.id, 'VACATION');
    await requestFor(ana.id, 'SICK');
    await requestFor(bo.id, 'VACATION');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const mine = await agent.get(`/time-off/admin/requests?associateId=${ana.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.requests).toHaveLength(2);
    expect(mine.body.requests.every((r: { associateId: string }) => r.associateId === ana.id)).toBe(true);
    expect(mine.body.total).toBe(2);

    const all = await agent.get('/time-off/admin/requests');
    expect(all.body.requests).toHaveLength(3);

    expect((await agent.get('/time-off/admin/requests?associateId=not-a-uuid')).status).toBe(400);
  });
});

describe('the directory entry names who can be messaged', () => {
  it("the login's id — a supervisor's, and an associate's now that the messenger reaches them; nothing without a login", async () => {
    const client = await createClient('Walmart 1234');
    const lead = await createAssociate({ firstName: 'Lee', lastName: 'Lead' });
    const { user: leadUser } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: lead.id });
    const plain = await createAssociate({ firstName: 'Pat', lastName: 'Plain' });
    const { user: plainUser } = await createUser({ role: 'ASSOCIATE', associateId: plain.id });
    const noLogin = await createAssociate({ firstName: 'Nora', lastName: 'Nologin' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    expect((await agent.get(`/people/directory/${lead.id}`)).body.messageUserId).toBe(leadUser.id);
    // Field roles (2026-10): the record's Message lands in the associate's app.
    expect((await agent.get(`/people/directory/${plain.id}`)).body.messageUserId).toBe(plainUser.id);
    expect((await agent.get(`/people/directory/${noLogin.id}`)).body.messageUserId).toBeNull();
  });
});
