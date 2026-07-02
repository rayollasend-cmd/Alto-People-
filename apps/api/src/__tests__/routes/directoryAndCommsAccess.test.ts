import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// The directory endpoint returns every associate's email + phone, and
// the /broadcasts + /surveys GETs are admin consoles (drafts, targeting,
// aggregated results). Associates hold view:communications for their own
// inbox — that capability must not open any of these.
describe('directory & comms access control', () => {
  it('403s associates on the directory and the admin comms lists', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    for (const path of ['/directory', '/broadcasts', '/surveys']) {
      const res = await a.get(path);
      expect(res.status, path).toBe(403);
    }
  });

  it('still serves associates their own broadcast feed', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/broadcasts/me');
    expect(res.status).toBe(200);
    expect(res.body.broadcasts).toEqual([]);
  });

  it('keeps the directory open to admins', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.associate.create({
      data: {
        firstName: 'Dora',
        lastName: 'Diaz',
        email: 'dora.diaz@example.com',
        phone: '555-0100',
      },
    });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.get('/directory?q=dora');
    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(1);
    expect(res.body.people[0].name).toBe('Dora Diaz');
  });
});
