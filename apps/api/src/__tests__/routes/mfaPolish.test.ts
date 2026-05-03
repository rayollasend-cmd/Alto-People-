import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync } from 'otplib';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { hashRecoveryCode } from '../../lib/mfaCrypto.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Stand up an MFA-enrolled user via the real surface and return the
 *  cookie-bearing agent + the recovery codes the user was shown. */
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
  return { user, agent: a, secret, recoveryCodes };
}

describe('GET /auth/me/mfa/status', () => {
  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.get('/auth/me/mfa/status');
    expect(res.status).toBe(401);
  });

  it('reports not-enrolled for a fresh user', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.get('/auth/me/mfa/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enrolled: false,
      enabledAt: null,
      remainingRecoveryCodes: 0,
    });
  });

  it('reports enrolled + 8 codes after enrollment', async () => {
    const { agent: a } = await enrolledUser();
    const res = await a.get('/auth/me/mfa/status');
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(true);
    expect(typeof res.body.enabledAt).toBe('string');
    expect(res.body.remainingRecoveryCodes).toBe(8);
  });

  it('decrements remainingRecoveryCodes after a code is used', async () => {
    const { user, agent: a, recoveryCodes } = await enrolledUser();

    // Sign out, sign back in with MFA, consume one recovery code.
    await a.post('/auth/logout');
    const a2 = agent();
    await a2.post('/auth/login').send({
      email: user.email,
      password: DEFAULT_TEST_PASSWORD,
    });
    const challenge = await a2.post('/auth/mfa-challenge').send({
      code: recoveryCodes[0],
    });
    expect(challenge.status).toBe(200);

    const status = await a2.get('/auth/me/mfa/status');
    expect(status.body.remainingRecoveryCodes).toBe(7);
  });
});

describe('POST /auth/me/mfa/recovery-codes/regenerate', () => {
  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects with 401 when password is wrong', async () => {
    const { agent: a } = await enrolledUser();
    const res = await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('rejects with 409 when MFA is not enrolled', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('mfa_not_enrolled');
  });

  it('replaces every existing code (used or unused) with 8 fresh ones', async () => {
    const { user, agent: a, recoveryCodes } = await enrolledUser();

    // Mark one of the codes as used (simulate it was consumed at login)
    // so we can prove regenerate wipes used rows too — not just unused.
    await prisma.mfaRecoveryCode.updateMany({
      where: { userId: user.id, codeHash: hashRecoveryCode(recoveryCodes[0]) },
      data: { usedAt: new Date() },
    });

    const res = await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD });
    expect(res.status).toBe(200);
    const newCodes = res.body.recoveryCodes as string[];
    expect(newCodes).toHaveLength(8);
    // None of the new codes overlap with the original set.
    for (const c of newCodes) expect(recoveryCodes).not.toContain(c);

    const rows = await prisma.mfaRecoveryCode.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(8);
    // Every row is unused (the used row got wiped along with the rest).
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    // Every new plaintext hashes to one of the persisted hashes.
    const hashes = rows.map((r) => r.codeHash);
    for (const c of newCodes) expect(hashes).toContain(hashRecoveryCode(c));
  });

  it('does not rotate the TOTP secret — the authenticator app keeps working', async () => {
    const { user, agent: a, secret } = await enrolledUser();
    const before = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mfaSecretEncrypted: true, mfaEnabledAt: true },
    });

    await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD });

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mfaSecretEncrypted: true, mfaEnabledAt: true },
    });
    expect(Buffer.from(after!.mfaSecretEncrypted!).equals(Buffer.from(before!.mfaSecretEncrypted!))).toBe(true);
    expect(after!.mfaEnabledAt?.toISOString()).toBe(before!.mfaEnabledAt?.toISOString());

    // Sign out and prove a fresh MFA challenge with a code generated from
    // the original secret still works — secret was not rotated.
    await a.post('/auth/logout');
    const a2 = agent();
    await a2.post('/auth/login').send({
      email: user.email,
      password: DEFAULT_TEST_PASSWORD,
    });
    const code = generateSync({ secret });
    const challenge = await a2.post('/auth/mfa-challenge').send({ code });
    expect(challenge.status).toBe(200);
  });

  it('writes an auth.mfa_codes_regenerated audit row', async () => {
    const { user, agent: a } = await enrolledUser();
    await a
      .post('/auth/me/mfa/recovery-codes/regenerate')
      .send({ currentPassword: DEFAULT_TEST_PASSWORD });

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.mfa_codes_regenerated', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });
});
