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

describe('POST /auth/me/revoke-other-sessions', () => {
  it('bumps tokenVersion, re-issues the caller cookie, and stays logged in', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const before = user.tokenVersion;

    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post('/auth/me/revoke-other-sessions');
    expect(res.status).toBe(204);

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie);
    expect(cookieStr).toMatch(/alto\.session=/);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after!.tokenVersion).toBeGreaterThan(before);

    // The agent's stored cookie was rotated by Set-Cookie; /auth/me still works.
    const me = await a.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user?.id).toBe(user.id);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.sessions_revoked', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('a second-device cookie issued before the revoke is rejected as stale', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    // Two independent agents = two devices with the same credentials.
    const deviceA = agent();
    const deviceB = agent();
    await loginAs(deviceA, user.email, DEFAULT_TEST_PASSWORD);
    await loginAs(deviceB, user.email, DEFAULT_TEST_PASSWORD);

    // Device A revokes other sessions.
    const revoke = await deviceA.post('/auth/me/revoke-other-sessions');
    expect(revoke.status).toBe(204);

    // Device B's old cookie is now stale.
    const bMe = await deviceB.get('/auth/me');
    expect(bMe.status).toBe(401);
    expect(bMe.body.error?.code).toBe('session_stale');

    // Device A (issued a fresh cookie by the revoke response) is still good.
    const aMe = await deviceA.get('/auth/me');
    expect(aMe.status).toBe(200);
  });

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.post('/auth/me/revoke-other-sessions');
    expect(res.status).toBe(401);
  });

  it('shows up in /auth/me/login-history', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    await a.post('/auth/me/revoke-other-sessions');
    await flushPendingAudits();

    const res = await a.get('/auth/me/login-history');
    expect(res.status).toBe(200);
    const events = res.body.events as Array<{ action: string }>;
    expect(events.map((e) => e.action)).toContain('auth.sessions_revoked');
  });
});
