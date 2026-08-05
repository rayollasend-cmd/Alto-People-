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

// Passkey (WebAuthn) ceremony plumbing. A real authenticator can't run in
// CI, so these cover the server-side contract around the crypto: origin
// gating, challenge minting/consumption, anti-enumeration, and the
// generic-401 failure path. Signature verification itself is
// @simplewebauthn/server's tested code.

const ORIGIN = 'http://localhost:5173';

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

describe('POST /auth/webauthn/register/options', () => {
  it('requires a session', async () => {
    const res = await request(app())
      .post('/auth/webauthn/register/options')
      .set('Origin', ORIGIN)
      .send({});
    expect(res.status).toBe(401);
  });

  it('rejects an origin outside CORS_ORIGIN', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/auth/webauthn/register/options')
      .set('Origin', 'https://evil.example.com')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_origin');
  });

  it('accepts a same-host origin outside CORS_ORIGIN (production same-origin serving)', async () => {
    // In production the API serves the SPA itself, so the ceremony's
    // origin is the request's own host — which never appears in
    // CORS_ORIGIN. This was the "Unrecognized origin" bug that blocked
    // every real-deployment passkey enrollment.
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/auth/webauthn/register/options')
      .set('Host', 'people.example.com')
      .set('Origin', 'http://people.example.com')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.options.rp.id).toBe('people.example.com');
  });

  it('same-host origin must also match the request protocol', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    // https origin against an http request (no trusted proxy in tests)
    // — host alone is not enough.
    const res = await a
      .post('/auth/webauthn/register/options')
      .set('Host', 'people.example.com')
      .set('Origin', 'https://people.example.com')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('bad_origin');
  });

  it('mints a one-shot challenge row and returns registration options', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a
      .post('/auth/webauthn/register/options')
      .set('Origin', ORIGIN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.challengeId).toBeTruthy();
    expect(res.body.options.challenge).toBeTruthy();
    expect(res.body.options.rp.id).toBe('localhost');
    expect(res.body.options.user.name).toBe(user.email);

    const row = await prisma.webAuthnChallenge.findUnique({
      where: { id: res.body.challengeId },
    });
    expect(row).not.toBeNull();
    expect(row!.type).toBe('registration');
    expect(row!.userId).toBe(user.id);
    expect(row!.challenge).toBe(res.body.options.challenge);
  });
});

describe('POST /auth/webauthn/register/verify', () => {
  it('consumes the challenge exactly once — a garbage response burns it', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const opts = await a
      .post('/auth/webauthn/register/options')
      .set('Origin', ORIGIN)
      .send({});
    const challengeId = opts.body.challengeId as string;

    const bad = await a
      .post('/auth/webauthn/register/verify')
      .set('Origin', ORIGIN)
      .send({ challengeId, response: { id: 'not-a-real-assertion' } });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    // The challenge was consumed by the failed attempt — replays 400.
    const replay = await a
      .post('/auth/webauthn/register/verify')
      .set('Origin', ORIGIN)
      .send({ challengeId, response: { id: 'not-a-real-assertion' } });
    expect(replay.status).toBe(400);
    expect(replay.body.error?.code).toBe('challenge_expired');
  });
});

describe('POST /auth/webauthn/login/options', () => {
  it('returns a REAL challenge with an empty allow-list for unknown emails (anti-enumeration)', async () => {
    const res = await request(app())
      .post('/auth/webauthn/login/options')
      .set('Origin', ORIGIN)
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.challengeId).toBeTruthy();
    expect(res.body.options.challenge).toBeTruthy();
    expect(res.body.options.allowCredentials ?? []).toHaveLength(0);
  });

  it('lists the registered credential ids for a real account', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId: 'dGVzdC1jcmVkZW50aWFs',
        publicKey: Buffer.from([1, 2, 3]),
        transports: ['internal'],
      },
    });
    const res = await request(app())
      .post('/auth/webauthn/login/options')
      .set('Origin', ORIGIN)
      .send({ email: user.email });
    expect(res.status).toBe(200);
    expect(res.body.options.allowCredentials).toHaveLength(1);
    expect(res.body.options.allowCredentials[0].id).toBe('dGVzdC1jcmVkZW50aWFs');
  });
});

describe('POST /auth/webauthn/login/verify', () => {
  it('generic 401 for an unknown challenge id', async () => {
    const res = await request(app())
      .post('/auth/webauthn/login/verify')
      .set('Origin', ORIGIN)
      .send({
        challengeId: '00000000-0000-4000-8000-000000000000',
        response: { id: 'whatever' },
      });
    expect(res.status).toBe(401);
  });

  it('generic 401 when the assertion credential does not match the ceremony user', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.webAuthnCredential.create({
      data: {
        userId: user.id,
        credentialId: 'dGVzdC1jcmVkZW50aWFs',
        publicKey: Buffer.from([1, 2, 3]),
        transports: ['internal'],
      },
    });
    // Ceremony minted for an UNKNOWN email (userId null) but replayed with
    // a real credential id — must not sign anyone in.
    const opts = await request(app())
      .post('/auth/webauthn/login/options')
      .set('Origin', ORIGIN)
      .send({ email: 'nobody@example.com' });
    const res = await request(app())
      .post('/auth/webauthn/login/verify')
      .set('Origin', ORIGIN)
      .send({
        challengeId: opts.body.challengeId,
        response: { id: 'dGVzdC1jcmVkZW50aWFs' },
      });
    expect(res.status).toBe(401);
    // No session cookie on any failure path.
    expect(res.headers['set-cookie'] ?? []).toHaveLength(0);
  });
});

describe('passkey management', () => {
  it('lists and deletes only the caller’s own credentials', async () => {
    const { user: alice } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: bob } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const bobCred = await prisma.webAuthnCredential.create({
      data: {
        userId: bob.id,
        credentialId: 'Ym9iLWNyZWQ',
        publicKey: Buffer.from([9]),
        deviceName: 'Bob iPhone',
      },
    });
    const a = await loginAs(alice.email);

    const list = await a.get('/auth/webauthn/credentials');
    expect(list.status).toBe(200);
    expect(list.body.credentials).toHaveLength(0);

    // Alice cannot delete Bob's passkey — 404, not an oracle.
    const del = await a.delete(`/auth/webauthn/credentials/${bobCred.id}`);
    expect(del.status).toBe(404);
    expect(
      await prisma.webAuthnCredential.findUnique({ where: { id: bobCred.id } }),
    ).not.toBeNull();
  });
});
