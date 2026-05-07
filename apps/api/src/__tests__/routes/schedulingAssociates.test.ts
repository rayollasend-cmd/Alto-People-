/**
 * Reported 2026-05-02: scheduling pickers were listing every Associate
 * regardless of role or status — managers (who use a separate system),
 * disabled/terminated users, and even invited-but-not-yet-accepted
 * associates were all appearing as schedulable rows. Fix filters to
 * Associates whose linked User is ACTIVE + role=ASSOCIATE.
 *
 * This suite locks in the filter so a future refactor that re-introduces
 * the broader query fails loudly.
 */
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

async function approveApplication(associateId: string, clientId: string) {
  return prisma.application.create({
    data: {
      associateId,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
  });
}

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

describe('GET /scheduling/associates filtering', () => {
  it('returns only ACTIVE+APPROVED associates whose user role is ASSOCIATE', async () => {
    const client = await createClient('Acme Hosp');

    // Eligible: active associate with a linked ASSOCIATE-role User AND
    // an APPROVED application (i.e. fully onboarded).
    const eligible = await createAssociate({ firstName: 'Alice', lastName: 'Active', email: 'alice@example.com' });
    await createUser({ role: 'ASSOCIATE', email: eligible.email, associateId: eligible.id, status: 'ACTIVE' });
    await approveApplication(eligible.id, client.id);

    // Excluded: ACTIVE user, ASSOCIATE role, but only a DRAFT application
    // (onboarding never completed). Reported 2026-05-07.
    const inOnboarding = await createAssociate({ firstName: 'Drew', lastName: 'Draft', email: 'drew@example.com' });
    await createUser({ role: 'ASSOCIATE', email: inOnboarding.email, associateId: inOnboarding.id, status: 'ACTIVE' });
    await prisma.application.create({
      data: {
        associateId: inOnboarding.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });

    // Excluded: ACTIVE user, ASSOCIATE role, but no Application at all
    // (junk/test row with just a User). Reported 2026-05-07.
    const orphan = await createAssociate({ firstName: 'Orph', lastName: 'An', email: 'orph@example.com' });
    await createUser({ role: 'ASSOCIATE', email: orphan.email, associateId: orphan.id, status: 'ACTIVE' });

    // Excluded: associate row exists but the linked User is a MANAGER
    // (managers use a separate scheduling system per the user's spec).
    const manager = await createAssociate({ firstName: 'Mark', lastName: 'Manager', email: 'mark@example.com' });
    await createUser({ role: 'MANAGER', email: manager.email, associateId: manager.id, status: 'ACTIVE' });
    await approveApplication(manager.id, client.id);

    // Excluded: ASSOCIATE-role User but DISABLED (terminated employee).
    const terminated = await createAssociate({ firstName: 'Tina', lastName: 'Terminated', email: 'tina@example.com' });
    await createUser({ role: 'ASSOCIATE', email: terminated.email, associateId: terminated.id, status: 'DISABLED' });
    await approveApplication(terminated.id, client.id);

    // Excluded: invited but hasn't accepted yet (no password).
    const invited = await createAssociate({ firstName: 'Ivan', lastName: 'Invited', email: 'ivan@example.com' });
    await prisma.user.create({
      data: { email: invited.email, role: 'ASSOCIATE', status: 'INVITED', associateId: invited.id },
    });

    // Excluded: associate with no User row at all (HR-only record).
    await createAssociate({ firstName: 'No', lastName: 'User', email: 'nouser@example.com' });

    // Excluded: another high-privilege role on an associate row.
    const opsManager = await createAssociate({ firstName: 'Ops', lastName: 'Lead', email: 'ops@example.com' });
    await createUser({ role: 'OPERATIONS_MANAGER', email: opsManager.email, associateId: opsManager.id, status: 'ACTIVE' });
    await approveApplication(opsManager.id, client.id);

    // HR caller (so capability check passes).
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/scheduling/associates');
    expect(res.status).toBe(200);

    const returnedIds: string[] = res.body.associates.map((x: { id: string }) => x.id);
    expect(returnedIds).toEqual([eligible.id]);
  });
});
