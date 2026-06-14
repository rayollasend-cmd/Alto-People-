/**
 * GET /scheduling/associates?clientId&locationId scopes the schedulable
 * roster to the people who actually work at the selected client/location
 * (via an approved application or an open assignment), so the grid rows and
 * the create-dialog picker reflect the filter. Reported 2026-06-14.
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

// A fully schedulable associate AT a given client: ACTIVE ASSOCIATE user +
// an approved application for that client.
async function makeAssocAtClient(clientId: string, first: string, last: string) {
  const assoc = await createAssociate({ firstName: first, lastName: last });
  await createUser({ role: 'ASSOCIATE', email: assoc.email, associateId: assoc.id, status: 'ACTIVE' });
  await prisma.application.create({
    data: { associateId: assoc.id, clientId, onboardingTrack: 'STANDARD', status: 'APPROVED' },
  });
  return assoc;
}

describe('GET /scheduling/associates — client/location scope', () => {
  it('returns only the selected client\'s associates when clientId is given', async () => {
    const clientA = await createClient('Walmart Front Beach');
    const clientB = await createClient('Target Pier Park');
    const aliceA = await makeAssocAtClient(clientA.id, 'Alice', 'A');
    const bobA = await makeAssocAtClient(clientA.id, 'Bob', 'A');
    await makeAssocAtClient(clientB.id, 'Carol', 'B');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // No scope → all three.
    const all = await agent.get('/scheduling/associates');
    expect(all.status).toBe(200);
    expect(all.body.associates).toHaveLength(3);

    // Scoped to client A → only Alice + Bob.
    const scoped = await agent.get(`/scheduling/associates?clientId=${clientA.id}`);
    expect(scoped.status).toBe(200);
    const ids = scoped.body.associates.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([aliceA.id, bobA.id].sort());
  });

  it('scopes to a location via an open assignment when locationId is given', async () => {
    const client = await createClient('Acme');
    const loc1 = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const loc2 = await prisma.location.create({ data: { clientId: client.id, name: 'Annex' } });

    // dana: open assignment at loc1. erin: open assignment at loc2.
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'One' });
    await createUser({ role: 'ASSOCIATE', email: dana.email, associateId: dana.id, status: 'ACTIVE' });
    await prisma.associateAssignment.create({
      data: { associateId: dana.id, locationId: loc1.id, startedAt: new Date('2026-01-01') },
    });
    const erin = await createAssociate({ firstName: 'Erin', lastName: 'Two' });
    await createUser({ role: 'ASSOCIATE', email: erin.email, associateId: erin.id, status: 'ACTIVE' });
    await prisma.associateAssignment.create({
      data: { associateId: erin.id, locationId: loc2.id, startedAt: new Date('2026-01-01') },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const atLoc1 = await agent.get(`/scheduling/associates?locationId=${loc1.id}`);
    expect(atLoc1.status).toBe(200);
    expect(atLoc1.body.associates).toHaveLength(1);
    expect(atLoc1.body.associates[0].id).toBe(dana.id);

    // Client scope still returns both (both work at the client).
    const atClient = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(atClient.body.associates).toHaveLength(2);
  });
});
