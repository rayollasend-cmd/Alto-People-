import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /auth/me/login-history', () => {
  it('returns the caller\'s recent auth events newest-first', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    // Trigger another auditable event so there are >1 rows.
    await a.post('/auth/change-password').send({
      currentPassword: DEFAULT_TEST_PASSWORD,
      newPassword: 'a-new-strong-pw-99',
    });
    await flushPendingAudits();

    const res = await a.get('/auth/me/login-history');
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{ action: string; at: string }>;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.action)).toContain('auth.login');
    expect(events.map((e) => e.action)).toContain('auth.password_changed');
    // Newest-first: ISO timestamps strictly non-increasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].at >= events[i].at).toBe(true);
    }
  });

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.get('/auth/me/login-history');
    expect(res.status).toBe(401);
  });

  it('does not leak another user\'s events', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });

    // Both users log in; HR's history should not include associate's row.
    await loginAs(agent(), assoc.email, DEFAULT_TEST_PASSWORD);
    const a = agent();
    await loginAs(a, hr.email, DEFAULT_TEST_PASSWORD);
    await flushPendingAudits();

    const res = await a.get('/auth/me/login-history');
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{ action: string }>;
    // All events belong to HR (only auth.login since they only logged in once).
    expect(events.length).toBe(1);
    expect(events[0].action).toBe('auth.login');
  });
});
