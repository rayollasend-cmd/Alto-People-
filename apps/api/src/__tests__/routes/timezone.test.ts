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

describe('PATCH /auth/me/timezone', () => {
  it('persists a supported IANA timezone and surfaces it on /auth/me', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/auth/me/timezone')
      .send({ timezone: 'America/Chicago' });
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.timezone).toBe('America/Chicago');

    const me = await a.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user?.timezone).toBe('America/Chicago');
  });

  it('clears the preference when timezone is null', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.user.update({
      where: { id: user.id },
      data: { timezone: 'America/Los_Angeles' },
    });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.patch('/auth/me/timezone').send({ timezone: null });
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.timezone).toBeNull();
  });

  it('rejects an unknown timezone string with 400', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a
      .patch('/auth/me/timezone')
      .send({ timezone: 'Mars/Olympus_Mons' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_body');
  });

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a
      .patch('/auth/me/timezone')
      .send({ timezone: 'UTC' });
    expect(res.status).toBe(401);
  });

  it('does NOT bump tokenVersion (timezone is cosmetic, not security)', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const before = user.tokenVersion;
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    await a.patch('/auth/me/timezone').send({ timezone: 'Europe/London' });

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after!.tokenVersion).toBe(before);
  });
});
