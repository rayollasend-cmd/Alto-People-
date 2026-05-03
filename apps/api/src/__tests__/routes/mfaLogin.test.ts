import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
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
 * Stand up an MFA-enrolled user via the real API surface (login + enroll
 * start + confirm). Returns the agent (cookie-bearing), the user row,
 * the TOTP secret (so tests can mint live codes), and the recovery codes.
 */
async function enrolledUser() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = agent();
  await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
  const start = await a.post('/auth/me/mfa/enroll/start');
  const { secret, recoveryCodes } = start.body as {
    secret: string;
    recoveryCodes: string[];
  };
  const code = generateSync({ secret });
  await a.post('/auth/me/mfa/enroll/confirm').send({ code });
  // Sign out so the next /auth/login call starts fresh — without this the
  // session cookie still works and the MFA gate is moot.
  await a.post('/auth/logout');
  // The setup login + logout left audit rows behind (auth.login,
  // auth.logout). Tests that assert the absence of auth.login from a
  // gated /login call need a clean slate, so flush + wipe.
  await flushPendingAudits();
  await prisma.auditLog.deleteMany({ where: { actorUserId: user.id } });
  return { user, agent: a, secret, recoveryCodes };
}

describe('POST /auth/login (MFA gate)', () => {
  it('returns the user directly when MFA is not enrolled', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
    expect(res.body.mfaRequired).toBeUndefined();

    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.session=/.test(c))).toBe(true);
  });

  it('returns mfaRequired and sets a pending cookie when MFA is enrolled', async () => {
    const { user } = await enrolledUser();
    const a = agent();
    const res = await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: true });

    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.mfa_pending=[^;]+/.test(c))).toBe(true);
    // No real session cookie should be issued at this step.
    const sessionCookie = cookies.find((c) => /alto\.session=[^;]+/.test(c));
    // express clears via Set-Cookie with an empty value + past expiry, so
    // the only acceptable line containing 'alto.session=' is the clear.
    if (sessionCookie) {
      expect(sessionCookie).toMatch(/alto\.session=;/);
    }

    // /auth/me must NOT recognise the pending cookie as a real session.
    const me = await a.get('/auth/me');
    expect(me.body.user).toBeNull();

    // No auth.login audit row yet — login isn't done.
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).toBeNull();
  });
});

describe('POST /auth/mfa-challenge', () => {
  it('rejects without a pending cookie', async () => {
    const a = agent();
    const res = await a.post('/auth/mfa-challenge').send({ code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('mfa_pending_missing');
  });

  it('signs the user in when the TOTP is valid', async () => {
    const { user, secret } = await enrolledUser();
    const a = agent();
    await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    const code = generateSync({ secret });
    const res = await a.post('/auth/mfa-challenge').send({ code });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);
    expect(res.body.user?.mfaEnabled).toBe(true);

    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.session=[^;]+/.test(c))).toBe(true);
    // Pending cookie cleared.
    expect(cookies.some((c) => /alto\.mfa_pending=;/.test(c))).toBe(true);

    // Now /auth/me works.
    const me = await a.get('/auth/me');
    expect(me.body.user?.email).toBe(user.email);

    // auth.login audit fires from the challenge endpoint, not /login.
    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('rejects an invalid TOTP and keeps the pending cookie', async () => {
    const { user, secret } = await enrolledUser();
    const a = agent();
    await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    const valid = generateSync({ secret });
    const wrong = valid === '000000' ? '111111' : '000000';
    const res = await a.post('/auth/mfa-challenge').send({ code: wrong });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_code');

    // Still pending — no session, no clear of mfa_pending.
    const me = await a.get('/auth/me');
    expect(me.body.user).toBeNull();
  });

  it('signs in via a recovery code and marks it used', async () => {
    const { user, recoveryCodes } = await enrolledUser();
    const a = agent();
    await a
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    const code = recoveryCodes[0];
    const res = await a.post('/auth/mfa-challenge').send({ code });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe(user.email);

    const consumed = await prisma.mfaRecoveryCode.findFirst({
      where: { userId: user.id, usedAt: { not: null } },
    });
    expect(consumed).not.toBeNull();

    await flushPendingAudits();
    const recoveryLog = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa_recovery_used', actorUserId: user.id },
    });
    expect(recoveryLog).not.toBeNull();
  });

  it('rejects a recovery code that has already been used', async () => {
    const { user, recoveryCodes } = await enrolledUser();
    const code = recoveryCodes[0];

    // First use — should succeed.
    const a1 = agent();
    await a1.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    const r1 = await a1.post('/auth/mfa-challenge').send({ code });
    expect(r1.status).toBe(200);

    // Second attempt (fresh agent, fresh login) with the same code — must fail.
    const a2 = agent();
    await a2.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    const r2 = await a2.post('/auth/mfa-challenge').send({ code });
    expect(r2.status).toBe(401);
    expect(r2.body.error.code).toBe('invalid_code');
  });

  it('rejects when tokenVersion has bumped since the pending cookie was issued', async () => {
    const { user, secret } = await enrolledUser();
    const a = agent();
    await a.post('/auth/login').send({ email: user.email, password: DEFAULT_TEST_PASSWORD });

    // Simulate an out-of-band change-password / sessions-revoked: bump
    // tokenVersion directly. The pending cookie's `ver` is now stale.
    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const code = generateSync({ secret });
    const res = await a.post('/auth/mfa-challenge').send({ code });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('mfa_state_invalid');
  });
});
