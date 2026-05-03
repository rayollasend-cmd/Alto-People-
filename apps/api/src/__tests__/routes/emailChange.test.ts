import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs, makeApp } from '../../../test/http.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  generateEmailChangeToken,
  hashEmailChangeToken,
} from '../../lib/emailChangeToken.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /auth/me/email-change/request', () => {
  it('mints a hashed single-use token tied to the new email', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const res = await a.post('/auth/me/email-change/request').send({
      newEmail: 'new-address@example.com',
      currentPassword: DEFAULT_TEST_PASSWORD,
    });
    expect(res.status).toBe(204);

    const rows = await prisma.emailChangeRequest.findMany({
      where: { userId: user.id, consumedAt: null },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].newEmail).toBe('new-address@example.com');
    // Hash, not plaintext.
    expect(rows[0].tokenHash).not.toContain('-');
    expect(rows[0].tokenHash.length).toBe(64);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.email_change_requested', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('rejects wrong current password with 401', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post('/auth/me/email-change/request').send({
      newEmail: 'new@example.com',
      currentPassword: 'definitely-not-it-99',
    });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_credentials');
    const rows = await prisma.emailChangeRequest.findMany({
      where: { userId: user.id },
    });
    expect(rows.length).toBe(0);
  });

  it('rejects same-email with 400', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post('/auth/me/email-change/request').send({
      newEmail: user.email,
      currentPassword: DEFAULT_TEST_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('same_email');
  });

  it('rejects collision with another active account (409)', async () => {
    const { user: a1 } = await createUser({ role: 'ASSOCIATE' });
    const { user: a2 } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, a1.email, DEFAULT_TEST_PASSWORD);
    const res = await a.post('/auth/me/email-change/request').send({
      newEmail: a2.email,
      currentPassword: DEFAULT_TEST_PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('email_in_use');
  });

  it('invalidates older outstanding requests when a new one is minted', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    await a.post('/auth/me/email-change/request').send({
      newEmail: 'first@example.com',
      currentPassword: DEFAULT_TEST_PASSWORD,
    });
    await a.post('/auth/me/email-change/request').send({
      newEmail: 'second@example.com',
      currentPassword: DEFAULT_TEST_PASSWORD,
    });

    const open = await prisma.emailChangeRequest.findMany({
      where: { userId: user.id, consumedAt: null },
    });
    expect(open.length).toBe(1);
    expect(open[0].newEmail).toBe('second@example.com');
    const total = await prisma.emailChangeRequest.findMany({
      where: { userId: user.id },
    });
    expect(total.length).toBe(2);
  });

  it('returns 401 without a session', async () => {
    const a = agent();
    const res = await a.post('/auth/me/email-change/request').send({
      newEmail: 'x@example.com',
      currentPassword: DEFAULT_TEST_PASSWORD,
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/email-change/confirm', () => {
  // Helper: mint a request row directly (bypasses the password-reauth UX)
  // and return both the raw token and the row.
  async function seedRequest(userId: string, newEmail: string, opts: { expiresInMinutes?: number } = {}) {
    const { raw, hash } = generateEmailChangeToken();
    const expiresAt = new Date(Date.now() + (opts.expiresInMinutes ?? 60) * 60 * 1000);
    const row = await prisma.emailChangeRequest.create({
      data: { userId, newEmail, tokenHash: hash, expiresAt },
    });
    return { raw, row };
  }

  it('swaps the email, bumps tokenVersion, and consumes the token', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const before = user.tokenVersion;
    const { raw } = await seedRequest(user.id, 'new@example.com');

    const res = await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });
    expect(res.status).toBe(204);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.email).toBe('new@example.com');
    expect(after!.tokenVersion).toBeGreaterThan(before);

    const consumed = await prisma.emailChangeRequest.findUnique({
      where: { tokenHash: hashEmailChangeToken(raw) },
    });
    expect(consumed?.consumedAt).not.toBeNull();

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.email_changed', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
  });

  it('returns 400 invalid_token on a tampered token', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await seedRequest(user.id, 'new@example.com');

    const res = await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: 'not-a-real-token-1234567890' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_token');
  });

  it('returns 400 on an expired token', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const { raw } = await seedRequest(user.id, 'new@example.com', { expiresInMinutes: -5 });

    const res = await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_token');
  });

  it('rejects a consumed token (single-use)', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const { raw } = await seedRequest(user.id, 'new@example.com');

    await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });

    const replay = await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });
    expect(replay.status).toBe(400);
  });

  it('refuses if the new email got claimed since the request', async () => {
    const { user: a1 } = await createUser({ role: 'ASSOCIATE' });
    const { raw } = await seedRequest(a1.id, 'race@example.com');
    // Another user grabs the address before the confirm lands.
    await createUser({ role: 'ASSOCIATE', email: 'race@example.com' });

    const res = await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('email_in_use');
  });

  it('logging in with the OLD email after a successful change fails', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const oldEmail = user.email;
    const { raw } = await seedRequest(user.id, 'fresh@example.com');

    await request(makeApp())
      .post('/auth/email-change/confirm')
      .send({ token: raw });

    // Old email no longer logs in.
    const oldLogin = await request(makeApp())
      .post('/auth/login')
      .send({ email: oldEmail, password: DEFAULT_TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);

    // New email does.
    const newLogin = await request(makeApp())
      .post('/auth/login')
      .send({ email: 'fresh@example.com', password: DEFAULT_TEST_PASSWORD });
    expect(newLogin.status).toBe(200);
  });
});
