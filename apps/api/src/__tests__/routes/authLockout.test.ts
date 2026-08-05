import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Account lockout (persistent brute-force defense on the password path).
 *
 * NOTE: the per-email login rate limiter allows only 5 requests / 15 min
 * per email in test env, so these tests seed `failedLoginCount` directly
 * instead of firing 10 real requests — the increments themselves are
 * exercised with one or two live attempts on top of the seeded count.
 */

const GENERIC_401 = {
  error: { code: 'invalid_credentials', message: 'Invalid email or password' },
};

describe('POST /auth/login (account lockout)', () => {
  it('locks at 10 failures, then refuses even the correct password with the same generic 401 and audit reason locked', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // 9 failures already on record — the next wrong password is #10.
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 9 },
    });

    const a = agent();
    const wrong = await a
      .post('/auth/login')
      .send({ email: user.email, password: 'definitely-not-the-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(GENERIC_401);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(10);
    expect(row.lockedUntil).not.toBeNull();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // ~15 minutes, with slack for test latency.
    expect(row.lockedUntil!.getTime()).toBeLessThanOrEqual(
      Date.now() + 15 * 60 * 1000 + 5000,
    );

    // Correct password while locked: SAME generic 401 (no lockout oracle,
    // no confirmation the guessed password was right)...
    const locked = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual(GENERIC_401);
    // ...and no session cookie.
    const cookies = (locked.headers['set-cookie'] as unknown as string[]) ?? [];
    const sessionCookie = cookies.find((c) => /alto\.session=[^;]+/.test(c));
    expect(sessionCookie).toBeUndefined();

    // ...but the audit trail records the truth.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: user.email },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as { reason?: string }).reason).toBe('locked');
  });

  it('does not report locked before the threshold and keeps counting', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 3 },
    });

    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: 'wrong-password-attempt-1' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_401);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(4);
    expect(row.lockedUntil).toBeNull();

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: user.email },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit!.metadata as { reason?: string }).reason).toBe('wrong_password');
  });

  it('resets the counter and clears an expired lock on a successful login', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 10,
        // Lock already expired — must unlock naturally.
        lockedUntil: new Date(Date.now() - 60 * 1000),
      },
    });

    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('resets the counter when a correct password proceeds to the MFA challenge step', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    // Simulate an enrolled user with prior failures: mfaEnabledAt set means
    // login returns mfaRequired instead of a session — the reset must
    // still have happened ("successful password verification").
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 6,
        mfaEnabledAt: new Date(),
        mfaSecretEncrypted: Buffer.from('not-a-real-secret'),
      },
    });

    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginCount).toBe(0);
  });
});

describe('POST /admin/users/:id/unlock', () => {
  it('surfaces lockedUntil in the admin list, unlocks, and audits', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.user.update({
      where: { id: target.id },
      data: { failedLoginCount: 10, lockedUntil },
    });

    const a = agent();
    await loginAs(a, hr.email);

    // List surfaces the active lock.
    const list = await a.get('/admin/users');
    expect(list.status).toBe(200);
    const row = (list.body.users as { id: string; lockedUntil: string | null }[]).find(
      (u) => u.id === target.id,
    );
    expect(row?.lockedUntil).toBe(lockedUntil.toISOString());

    // Unlock.
    const res = await a.post(`/admin/users/${target.id}/unlock`);
    expect(res.status).toBe(204);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();

    // Critical audit landed.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'admin.user_unlocked', entityId: target.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(hr.id);
    expect((audit!.metadata as { failedLoginCount?: number }).failedLoginCount).toBe(10);

    // And the target can sign in again immediately.
    const b = agent();
    const login = await b
      .post('/auth/login')
      .send({ email: target.email, password: DEFAULT_TEST_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user?.email).toBe(target.email);
  });

  it('rejects callers without view:hr-admin', async () => {
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });

    const a = agent();
    await loginAs(a, assoc.email);
    const res = await a.post(`/admin/users/${target.id}/unlock`);
    expect(res.status).toBe(403);
  });

  it('404s for a missing user', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, hr.email);
    const res = await a.post(
      '/admin/users/00000000-0000-4000-8000-000000000000/unlock',
    );
    expect(res.status).toBe(404);
  });
});
