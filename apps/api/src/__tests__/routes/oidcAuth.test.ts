import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { createApp } from '../../app.js';
import { agent } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  __clearOidcEnvOverrideForTests,
  __resetOidcCachesForTests,
  __setOidcEnvForTests,
} from '../../lib/oidc.js';

/* ============================================================================
 * OIDC SSO login — integration tests.
 *
 * The IdP is simulated by stubbing global fetch (discovery, JWKS, token
 * endpoint) and signing REAL RS256 ID tokens with an in-test RSA keypair,
 * so the full signature-verification path (JWK import + crypto.verify)
 * is exercised, not mocked.
 *
 * config/env.ts parses process.env once per process, so the enabled state
 * is driven through the __setOidcEnvForTests seam rather than env vars.
 * ========================================================================== */

const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'alto-test-client';
const CLIENT_SECRET = 'alto-test-secret';
const JWKS_URI = `${ISSUER}/jwks`;
const TOKEN_URL = `${ISSUER}/token`;
const AUTHZ_URL = `${ISSUER}/authorize`;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-signing-key-1';
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

// Second keypair whose signatures must NOT verify against the published JWKS.
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64urlJson(o: object): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

function signIdToken(
  payload: Record<string, unknown>,
  opts: { kid?: string; key?: KeyObject } = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid ?? KID };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = cryptoSign('sha256', Buffer.from(input, 'utf8'), opts.key ?? privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'entra-object-id-1',
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

// Mutable per-test knobs for the stubbed IdP.
let idTokenForExchange: string | null = null;
let lastTokenForm: URLSearchParams | null = null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return jsonResponse({
      issuer: ISSUER,
      authorization_endpoint: AUTHZ_URL,
      token_endpoint: TOKEN_URL,
      jwks_uri: JWKS_URI,
    });
  }
  if (url === JWKS_URI) {
    return jsonResponse({ keys: [JWK] });
  }
  if (url === TOKEN_URL) {
    lastTokenForm = new URLSearchParams(String(init?.body ?? ''));
    return jsonResponse({ token_type: 'Bearer', id_token: idTokenForExchange });
  }
  throw new Error(`unexpected outbound fetch in test: ${url}`);
});

beforeEach(async () => {
  await truncateAll();
  __resetOidcCachesForTests();
  idTokenForExchange = null;
  lastTokenForm = null;
});

afterAll(async () => {
  __clearOidcEnvOverrideForTests();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

/** Kick off /start on the given agent; returns the per-flow parameters. */
async function beginFlow(a: ReturnType<typeof agent>) {
  const res = await a.get('/auth/oidc/start');
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location as string);
  expect(`${url.origin}${url.pathname}`).toBe(AUTHZ_URL);
  const setCookie = ((res.headers['set-cookie'] as unknown as string[]) ?? []).find((c) =>
    c.startsWith('alto.oidc_flow='),
  );
  expect(setCookie).toBeTruthy();
  return {
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    challenge: url.searchParams.get('code_challenge')!,
    cookiePair: setCookie!.split(';')[0],
  };
}

function callback(a: ReturnType<typeof agent>, state: string) {
  return a.get('/auth/oidc/callback').query({ code: 'test-auth-code', state });
}

async function expectNoSession(a: ReturnType<typeof agent>) {
  const me = await a.get('/auth/me');
  expect(me.body.user ?? null).toBeNull();
}

describe('OIDC SSO when not configured', () => {
  it('GET /auth/oidc/config reports disabled', async () => {
    const res = await agent().get('/auth/oidc/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, buttonLabel: null });
  });

  it('GET /auth/oidc/start 404s', async () => {
    const res = await agent().get('/auth/oidc/start');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('sso_not_configured');
  });

  it('GET /auth/oidc/callback 404s', async () => {
    const res = await agent().get('/auth/oidc/callback').query({ code: 'x', state: 'y' });
    expect(res.status).toBe(404);
  });
});

describe('OIDC SSO when configured', () => {
  beforeAll(() => {
    __setOidcEnvForTests({
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      buttonLabel: 'Sign in with Contoso',
    });
    vi.stubGlobal('fetch', fetchStub);
  });

  it('config reports enabled with the button label', async () => {
    const res = await agent().get('/auth/oidc/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, buttonLabel: 'Sign in with Contoso' });
  });

  it('signs an ACTIVE user in end-to-end (session cookie + audit method=oidc)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state, nonce, challenge } = await beginFlow(a);

    idTokenForExchange = signIdToken(baseClaims({ nonce, email: user.email }));
    const res = await callback(a, state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.session=[^;]+/.test(c))).toBe(true);
    // Flow cookie is single-use — cleared on the callback.
    expect(cookies.some((c) => /alto\.oidc_flow=;/.test(c))).toBe(true);

    // The exchange used client_secret_post + the PKCE verifier matching
    // the S256 challenge from the authorization redirect.
    expect(lastTokenForm).not.toBeNull();
    expect(lastTokenForm!.get('grant_type')).toBe('authorization_code');
    expect(lastTokenForm!.get('client_id')).toBe(CLIENT_ID);
    expect(lastTokenForm!.get('client_secret')).toBe(CLIENT_SECRET);
    expect(lastTokenForm!.get('redirect_uri')).toMatch(/\/api\/auth\/oidc\/callback$/);
    const verifier = lastTokenForm!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier, 'ascii').digest('base64url')).toBe(challenge);

    const me = await a.get('/auth/me');
    expect(me.body.user?.email).toBe(user.email);

    await flushPendingAudits();
    const log = await prisma.auditLog.findFirst({
      where: { action: 'auth.login', actorUserId: user.id },
    });
    expect(log).not.toBeNull();
    expect((log!.metadata as { method?: string }).method).toBe('oidc');
  });

  it('falls back to an email-shaped preferred_username when email is absent (Entra)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(
      baseClaims({ nonce, preferred_username: user.email }),
    );
    const res = await callback(a, state);
    expect(res.headers.location).toBe('/');
    const me = await a.get('/auth/me');
    expect(me.body.user?.email).toBe(user.email);
  });

  it('activates an INVITED user (status flip, passwordHash stays null, sso_activated audit)', async () => {
    const email = `invited-${Date.now()}@example.com`;
    const invited = await prisma.user.create({
      data: { email, passwordHash: null, role: 'HR_ADMINISTRATOR', status: 'INVITED' },
    });
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(baseClaims({ nonce, email }));

    const res = await callback(a, state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const after = await prisma.user.findUniqueOrThrow({ where: { id: invited.id } });
    expect(after.status).toBe('ACTIVE');
    expect(after.passwordHash).toBeNull();

    const me = await a.get('/auth/me');
    expect(me.body.user?.email).toBe(email);

    await flushPendingAudits();
    const activated = await prisma.auditLog.findFirst({
      where: { action: 'auth.sso_activated', actorUserId: invited.id },
    });
    expect(activated).not.toBeNull();
  });

  it('rejects a state mismatch', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(baseClaims({ nonce, email: user.email }));

    const res = await callback(a, 'f'.repeat(64));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_failed');
    await expectNoSession(a);
  });

  it('rejects a nonce mismatch', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state } = await beginFlow(a);
    idTokenForExchange = signIdToken(
      baseClaims({ nonce: 'not-the-minted-nonce', email: user.email }),
    );
    const res = await callback(a, state);
    expect(res.headers.location).toBe('/login?error=sso_failed');
    await expectNoSession(a);
  });

  it('rejects a bad signature (signed by a key outside the JWKS)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(baseClaims({ nonce, email: user.email }), {
      key: rogue.privateKey,
    });
    const res = await callback(a, state);
    expect(res.headers.location).toBe('/login?error=sso_failed');
    await expectNoSession(a);
  });

  it('rejects an expired ID token (past the 300s skew)', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    const now = Math.floor(Date.now() / 1000);
    idTokenForExchange = signIdToken(
      baseClaims({ nonce, email: user.email, iat: now - 4000, exp: now - 400 }),
    );
    const res = await callback(a, state);
    expect(res.headers.location).toBe('/login?error=sso_failed');
    await expectNoSession(a);
  });

  it('redirects sso_no_account (no session) for an unknown email', async () => {
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(
      baseClaims({ nonce, email: 'nobody-here@example.com' }),
    );
    const res = await callback(a, state);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_no_account');
    await expectNoSession(a);

    await flushPendingAudits();
    const failed = await prisma.auditLog.findFirst({
      where: { action: 'auth.login_failed', entityId: 'nobody-here@example.com' },
    });
    expect(failed).not.toBeNull();
    expect((failed!.metadata as { reason?: string }).reason).toBe('oidc_unknown_email');
  });

  it('gives a DISABLED user the same sso_no_account redirect and no session', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', status: 'DISABLED' });
    const a = agent();
    const { state, nonce } = await beginFlow(a);
    idTokenForExchange = signIdToken(baseClaims({ nonce, email: user.email }));
    const res = await callback(a, state);
    expect(res.status).toBe(302);
    // Identical to unknown_email — the login page is not a status oracle.
    expect(res.headers.location).toBe('/login?error=sso_no_account');
    await expectNoSession(a);
  });

  it('rejects a callback replay that reuses a captured flow cookie', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    const { state, nonce, cookiePair } = await beginFlow(a);
    idTokenForExchange = signIdToken(baseClaims({ nonce, email: user.email }));

    const first = await callback(a, state);
    expect(first.headers.location).toBe('/');

    // Attacker replays the exact same callback with the captured cookie
    // (the browser's copy was cleared, but a wire capture ignores that).
    const replayAgent = request(createApp());
    const replay = await replayAgent
      .get('/auth/oidc/callback')
      .query({ code: 'test-auth-code', state })
      .set('Cookie', cookiePair);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe('/login?error=sso_failed');
    const cookies = (replay.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.some((c) => /alto\.session=[^;]+/.test(c))).toBe(false);
  });

  it('rejects a callback with no flow cookie at all', async () => {
    const res = await agent()
      .get('/auth/oidc/callback')
      .query({ code: 'test-auth-code', state: 'a'.repeat(64) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=sso_failed');
  });
});
