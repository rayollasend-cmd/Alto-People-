import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * One person by id — the lookup behind a profile deep link.
 *
 * The People page used to find the linked person by scanning the page of
 * rows it had loaded: 500 people sorted by last name, under the viewer's
 * saved filters. Anyone past that page, or still onboarding behind an
 * Active filter, came back as "Couldn't find that person". The lookup
 * answers for them regardless of where the list is.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hrAgent() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = agent();
  await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
  return a;
}

describe('GET /people/directory/:id', () => {
  it('finds a person the first page of the list does not reach', async () => {
    const a = await hrAgent();
    // 520 people whose last names sort ahead of hers — she is row 521.
    await prisma.associate.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({
        firstName: 'Row',
        lastName: `Aaa${String(i).padStart(4, '0')}`,
        email: `row-${i}@example.com`,
      })),
    });
    const zoe = await createAssociate({ firstName: 'Zoe', lastName: 'Zyla', email: 'zoe@example.com' });

    const page = await a.get('/people/directory');
    expect(page.status).toBe(200);
    expect(page.body.associates).toHaveLength(500);
    expect(page.body.nextCursor).not.toBeNull();
    expect(page.body.associates.some((r: { id: string }) => r.id === zoe.id)).toBe(false);

    const one = await a.get(`/people/directory/${zoe.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: zoe.id, firstName: 'Zoe', lastName: 'Zyla', status: 'INACTIVE', workplaceClientId: null });
  });

  it('finds someone still onboarding while the list is filtered to Active, with their workplace', async () => {
    const a = await hrAgent();
    const coastal = await createClient('Coastal');
    const noor = await createAssociate({ firstName: 'Noor', lastName: 'Haddad', email: 'noor@example.com' });
    await prisma.application.create({
      data: { associateId: noor.id, clientId: coastal.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', position: 'Associate' },
    });

    const active = await a.get('/people/directory?status=ACTIVE');
    expect(active.status).toBe(200);
    expect(active.body.associates).toEqual([]);

    const one = await a.get(`/people/directory/${noor.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: noor.id,
      status: 'PENDING',
      workplaceClientId: coastal.id,
      workplaceClientName: 'Coastal',
      position: 'Associate',
    });
    // Same row the list would have built.
    const listed = await a.get('/people/directory?status=PENDING');
    expect(listed.body.associates).toEqual([one.body]);
  });

  it('is not found for an unknown id, a malformed id, or someone erased', async () => {
    const a = await hrAgent();
    expect((await a.get('/people/directory/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await a.get('/people/directory/not-a-uuid')).status).toBe(404);
    const gone = await createAssociate({ firstName: 'Gone', lastName: 'Person' });
    await prisma.associate.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const res = await a.get(`/people/directory/${gone.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('is gated like the list: an associate cannot look anyone up', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const other = await createAssociate({ firstName: 'Other', lastName: 'Person' });
    expect((await a.get(`/people/directory/${other.id}`)).status).toBe(403);
  });
});
