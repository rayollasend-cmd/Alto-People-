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
 * Manual time entries must land WITH a client (reported: "when we do
 * manual entry of time it says no client"). Associates with no open
 * assignment — the migrated-workforce shape — now fall back to the
 * hiring record: the most recent APPROVED application's client.
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
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

describe('POST /time/admin/entries client attribution', () => {
  it('attributes via the approved application when the associate has no open assignment', async () => {
    const client = await createClient('Walmart Destin');
    const associate = await createAssociate({ firstName: 'Manual', lastName: 'Entry' });
    // Hired for the client, but never placed at a Location — no
    // AssociateAssignment row exists.
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: new Date('2026-06-01T00:00:00Z'),
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.post('/time/admin/entries').send({
      associateId: associate.id,
      clockInAt: '2026-08-20T13:00:00.000Z',
      clockOutAt: '2026-08-20T21:00:00.000Z',
    });
    expect(res.status).toBeLessThan(300);

    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.clientId).toBe(client.id);
    // The client's default Location rides along for history/scoping.
    expect(entry.locationId).not.toBeNull();
  });

  it('an associate with no approved application still creates a (clientless) entry rather than failing', async () => {
    const associate = await createAssociate({ firstName: 'No', lastName: 'Hire' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.post('/time/admin/entries').send({
      associateId: associate.id,
      clockInAt: '2026-08-20T13:00:00.000Z',
      clockOutAt: '2026-08-20T21:00:00.000Z',
    });
    expect(res.status).toBeLessThan(300);
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(entry.clientId).toBeNull();
  });
});
