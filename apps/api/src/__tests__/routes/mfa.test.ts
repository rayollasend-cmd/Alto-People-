import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { decryptMfaSecret, hashRecoveryCode } from '../../lib/mfaCrypto.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /auth/me/mfa/enroll/start', () => {
  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.post('/auth/me/mfa/enroll/start');
    expect(res.status).toBe(401);
  });

  it('issues a secret, provisioning URI, and 8 recovery codes', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.post('/auth/me/mfa/enroll/start');
    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.secret.length).toBeGreaterThan(0);
    expect(res.body.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.recoveryCodes).toHaveLength(8);
    for (const code of res.body.recoveryCodes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    }
    // Codes are unique within the set.
    expect(new Set(res.body.recoveryCodes).size).toBe(8);
  });

  it('persists the encrypted secret and hashed codes; the plaintext is NOT in the DB', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.post('/auth/me/mfa/enroll/start');
    const { secret, recoveryCodes } = res.body as {
      secret: string;
      recoveryCodes: string[];
    };

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser?.mfaSecretEncrypted).not.toBeNull();
    expect(dbUser?.mfaEnabledAt).toBeNull();
    // The encrypted blob must not contain the plaintext secret bytes.
    const blob = Buffer.from(dbUser!.mfaSecretEncrypted!);
    expect(blob.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    // Round-trip decryption returns the same plaintext.
    expect(decryptMfaSecret(blob)).toBe(secret);

    const rows = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      // No row stores plaintext, and each hash matches one of the issued codes.
      expect(recoveryCodes).not.toContain(row.codeHash);
      expect(recoveryCodes.some((c) => hashRecoveryCode(c) === row.codeHash)).toBe(true);
    }
  });

  it('replaces stale in-flight enrollment + codes on a second start', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const first = await a.post('/auth/me/mfa/enroll/start');
    const second = await a.post('/auth/me/mfa/enroll/start');
    expect(first.body.secret).not.toBe(second.body.secret);

    const rows = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    // Old codes wiped; only the second batch remains.
    expect(rows).toHaveLength(8);
    const secondHashes = (second.body.recoveryCodes as string[]).map(hashRecoveryCode);
    for (const r of rows) expect(secondHashes).toContain(r.codeHash);
  });
});

describe('POST /auth/me/mfa/enroll/confirm', () => {
  it('rejects non-numeric / wrong-length codes with 400', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    await a.post('/auth/me/mfa/enroll/start');

    const r1 = await a.post('/auth/me/mfa/enroll/confirm').send({ code: 'abcdef' });
    expect(r1.status).toBe(400);
    const r2 = await a.post('/auth/me/mfa/enroll/confirm').send({ code: '12345' });
    expect(r2.status).toBe(400);
  });

  it('returns 409 when no enrollment is in flight', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post('/auth/me/mfa/enroll/confirm').send({ code: '000000' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_pending_enrollment');
  });

  it('rejects an obviously-wrong 6-digit code with 401', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const { secret } = start.body as { secret: string };
    // Compute the current valid code, then pick something different.
    const valid = generateSync({ secret });
    const wrong = valid === '000000' ? '111111' : '000000';

    const res = await a.post('/auth/me/mfa/enroll/confirm').send({ code: wrong });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_code');

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser?.mfaEnabledAt).toBeNull();
  });

  it('flips mfaEnabledAt and writes an audit row when the code is valid', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const code = generateSync({ secret: start.body.secret as string });

    const res = await a.post('/auth/me/mfa/enroll/confirm').send({ code });
    expect(res.status).toBe(204);

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser?.mfaEnabledAt).not.toBeNull();

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa_enabled', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('surfaces mfaEnabled=true on /auth/me after confirming', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const code = generateSync({ secret: start.body.secret as string });
    await a.post('/auth/me/mfa/enroll/confirm').send({ code });

    const me = await a.get('/auth/me');
    expect(me.body.user.mfaEnabled).toBe(true);
  });
});

describe('DELETE /auth/me/mfa', () => {
  it('rejects without password reauth', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const code = generateSync({ secret: start.body.secret as string });
    await a.post('/auth/me/mfa/enroll/confirm').send({ code });

    const res = await a.delete('/auth/me/mfa').send({ currentPassword: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser?.mfaEnabledAt).not.toBeNull();
  });

  it('clears secret + codes when password is correct', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const start = await a.post('/auth/me/mfa/enroll/start');
    const code = generateSync({ secret: start.body.secret as string });
    await a.post('/auth/me/mfa/enroll/confirm').send({ code });

    const res = await a.delete('/auth/me/mfa').send({ currentPassword: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(204);

    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    expect(dbUser?.mfaEnabledAt).toBeNull();
    expect(dbUser?.mfaSecretEncrypted).toBeNull();
    const codes = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(codes).toHaveLength(0);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa_disabled', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('is idempotent when not enrolled (still 204, no audit row)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.delete('/auth/me/mfa').send({ currentPassword: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(204);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa_disabled', actorUserId: user.id },
    });
    expect(log).toBeNull();
  });
});

