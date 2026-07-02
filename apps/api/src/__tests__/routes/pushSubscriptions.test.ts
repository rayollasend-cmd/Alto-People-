import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
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

const SUB = {
  endpoint: 'https://push.example.com/send/abc123',
  keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
};

describe('web push subscriptions', () => {
  it('subscribe stores one row per endpoint and re-subscribing upserts', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(user.email);

    const first = await agent
      .post('/communications/me/push/subscriptions')
      .send(SUB);
    expect(first.status).toBe(201);

    // Same endpoint again (page reload re-registers) — no duplicate row.
    const again = await agent
      .post('/communications/me/push/subscriptions')
      .send(SUB);
    expect(again.status).toBe(201);

    const rows = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.endpoint).toBe(SUB.endpoint);
    expect(rows[0]!.p256dh).toBe(SUB.keys.p256dh);
  });

  it('an endpoint that changes hands moves to the new user', async () => {
    // Browser profiles get reused (shared store tablet, logout/login):
    // the same push endpoint re-registered by a different account must
    // deliver to the NEW account only.
    const { user: alice } = await createUser({ role: 'ASSOCIATE' });
    const { user: bob } = await createUser({ role: 'ASSOCIATE' });
    const aliceAgent = await loginAs(alice.email);
    await aliceAgent.post('/communications/me/push/subscriptions').send(SUB);

    const bobAgent = await loginAs(bob.email);
    const res = await bobAgent.post('/communications/me/push/subscriptions').send(SUB);
    expect(res.status).toBe(201);

    const rows = await prisma.pushSubscription.findMany({
      where: { endpoint: SUB.endpoint },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(bob.id);
  });

  it('unsubscribe deletes only the caller’s row for that endpoint', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(user.email);
    await agent.post('/communications/me/push/subscriptions').send(SUB);

    const del = await agent
      .delete('/communications/me/push/subscriptions')
      .send({ endpoint: SUB.endpoint });
    expect(del.status).toBe(204);
    expect(
      await prisma.pushSubscription.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it('rejects malformed subscriptions', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(user.email);
    const res = await agent
      .post('/communications/me/push/subscriptions')
      .send({ endpoint: 'not-a-url', keys: { p256dh: '', auth: '' } });
    expect(res.status).toBe(400);
  });

  it('public-key endpoint serves the key when configured, 404s when not', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const agent = await loginAs(user.email);
    const res = await agent.get('/communications/me/push/public-key');
    // Env-dependent by design: local dev has VAPID keys in .env (200),
    // CI deliberately doesn't (404). Both must be clean states — never a
    // 200 with a missing/empty key.
    if (res.status === 200) {
      expect(typeof res.body.publicKey).toBe('string');
      expect(res.body.publicKey.length).toBeGreaterThan(20);
    } else {
      expect(res.status).toBe(404);
    }
  });
});
