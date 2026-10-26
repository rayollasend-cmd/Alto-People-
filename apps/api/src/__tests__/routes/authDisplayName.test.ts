import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * An account with no person record (a manager, a client's store login)
 * still has a name — its display name — so the greeting and the sidebar
 * don't fall back to "Good morning." and an email (F500 audit 2026-10-26).
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a name for an account with no person record', () => {
  it('splits the display name into first and last', async () => {
    const client = await createClient('Coastal Resort');
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    await prisma.user.update({ where: { id: user.id }, data: { displayName: 'Jordan  Price-Lee Smith' } });
    const a = request.agent(createApp());
    expect((await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    const me = await a.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ firstName: 'Jordan', lastName: 'Price-Lee Smith' });
  });

  it('leaves both empty when there is no display name', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = request.agent(createApp());
    expect((await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    const me = await a.get('/auth/me');
    expect(me.body.user.firstName ?? null).toBeNull();
    expect(me.body.user.lastName ?? null).toBeNull();
  });
});
