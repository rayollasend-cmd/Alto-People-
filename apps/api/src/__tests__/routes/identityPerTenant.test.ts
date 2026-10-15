import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { decryptString } from '../../lib/crypto.js';
import { ensureEnvIdentity, setTxtResolverForTests } from '../../lib/identity.js';
import { __clearOidcEnvOverrideForTests, __resetOidcCachesForTests, __setOidcEnvForTests } from '../../lib/oidc.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Brief 2-3 step 2 — identity per tenant, against a local fake IdP (real
 * RS256 tokens, stubbed discovery/JWKS/token endpoints), the CI twin the
 * report names for the Okta acceptance run.
 *
 *   A tenant's connection signs in its own people only; discovery is by a
 *   DNS-verified domain and reveals nothing else; the first sign-in binds
 *   the IdP subject and a different subject for the same email is refused
 *   and audited; SSO-required refuses staff passwords and keeps associates';
 *   a SCIM token lands its accounts in its tenant and sees no other; the
 *   environment IdP becomes Alto HR's row with its secret sealed.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const ISSUER = 'https://login.acme-hotels.test';
const CLIENT_ID = 'acme-client';
const CLIENT_SECRET = 'acme-secret';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>): string {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
  return `${input}.${cryptoSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

let nextIdToken = '';
const fetchStub = vi.fn(async (input: unknown) => {
  const url = String(input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  if (url === `${ISSUER}/jwks`) return json({ keys: [JWK] });
  if (url === `${ISSUER}/token`) return json({ token_type: 'Bearer', id_token: nextIdToken });
  throw new Error(`unexpected fetch ${url}`);
});

beforeAll(() => vi.stubGlobal('fetch', fetchStub));
beforeEach(async () => {
  await truncateAll();
  __resetOidcCachesForTests();
});
afterEach(() => setTxtResolverForTests(null));
afterAll(async () => {
  __clearOidcEnvOverrideForTests();
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});

async function tenantTwo() {
  await prisma.tenant.create({ data: { id: T2, slug: 'acme-hotels', name: 'Acme Hotels' } });
  const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'it@acme-hotels.test' });
  await prisma.user.update({ where: { id: admin.id }, data: { tenantId: T2 } });
  const a = await loginAs(agent(), admin.email);
  const made = await a.post('/identity/connections').send({ displayName: 'Acme Okta', buttonLabel: 'Continue with Okta', issuerUrl: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { admin, a, connectionId: made.body.id as string };
}

/** One SSO round trip: start for the connection, the IdP answers with these claims, the callback. */
async function ssoSignIn(connectionId: string, claims: { sub: string; email: string }) {
  const a = agent();
  const start = await a.get('/auth/oidc/start').query({ connection: connectionId });
  expect(start.status).toBe(302);
  const url = new URL(start.headers.location as string);
  const now = Math.floor(Date.now() / 1000);
  nextIdToken = idToken({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 600, nonce: url.searchParams.get('nonce'), ...claims });
  const cb = await a.get('/auth/oidc/callback').query({ code: 'c', state: url.searchParams.get('state') });
  return { a, cb };
}

describe('discovery', () => {
  it('a verified domain leads to its tenant’s sign-in; nothing else reveals anything', async () => {
    const { a, connectionId } = await tenantTwo();
    const dom = await a.post('/identity/domains').send({ domain: 'Acme-Hotels.test' });
    expect(dom.status).toBe(201);
    expect(dom.body.txtRecord).toMatch(/^alto-verification=[0-9a-f]{32}$/);

    // Not yet verified: the same empty answer as an unknown domain.
    expect((await agent().get('/auth/oidc/discover').query({ email: 'maria@acme-hotels.test' })).body).toEqual({ connections: [] });
    setTxtResolverForTests(async () => [['v=spf1 -all'], [dom.body.txtRecord]]);
    expect((await a.post(`/identity/domains/${dom.body.id}/verify`).send({})).body.verified).toBe(true);

    expect((await agent().get('/auth/oidc/discover').query({ email: 'maria@acme-hotels.test' })).body).toEqual({ connections: [{ id: connectionId, label: 'Continue with Okta' }] });
    expect((await agent().get('/auth/oidc/discover').query({ email: 'maria@elsewhere.test' })).body).toEqual({ connections: [] });
    expect((await agent().get('/auth/oidc/tenant/acme-hotels')).body.connections).toHaveLength(1);
    expect((await agent().get('/auth/oidc/tenant/nobody')).body).toEqual({ connections: [] });

    expect((await a.post('/identity/domains').send({ domain: 'gmail.com' })).status).toBe(400);
  });
});

describe('subject binding', () => {
  it('links on first sign-in, then matches by subject; another subject for the same email is refused and audited', async () => {
    const { connectionId } = await tenantTwo();
    const { user } = await createUser({ role: 'MANAGER', email: 'maria@acme-hotels.test' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });

    const first = await ssoSignIn(connectionId, { sub: 'okta-001', email: 'maria@acme-hotels.test' });
    expect(first.cb.headers.location).toBe('/');
    expect((await first.a.get('/auth/me')).body.user?.email).toBe('maria@acme-hotels.test');
    expect(await prisma.userIdentity.count({ where: { userId: user.id, subject: 'okta-001' } })).toBe(1);

    // The IdP now reports another email for the same subject: still Maria, by subject.
    const again = await ssoSignIn(connectionId, { sub: 'okta-001', email: 'maria.r@acme-hotels.test' });
    expect((await again.a.get('/auth/me')).body.user?.id).toBe(user.id);

    // A new IdP account claiming Maria's email: refused.
    const thief = await ssoSignIn(connectionId, { sub: 'okta-999', email: 'maria@acme-hotels.test' });
    expect(thief.cb.headers.location).toBe('/login?error=sso_no_account');
    expect((await thief.a.get('/auth/me')).body.user ?? null).toBeNull();
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'identity.subject_mismatch', entityId: user.id } })).toBe(1);
  });

  it('a tenant’s connection never signs in another tenant’s person', async () => {
    const { connectionId } = await tenantTwo();
    await createUser({ role: 'MANAGER', email: 'someone@alto.test' }); // Alto HR's
    const { cb } = await ssoSignIn(connectionId, { sub: 'okta-555', email: 'someone@alto.test' });
    expect(cb.headers.location).toBe('/login?error=sso_no_account');
  });
});

describe('SSO required for staff (decision 4)', () => {
  it('refuses a manager’s password once the tenant requires its SSO; an associate keeps theirs', async () => {
    const { a, connectionId } = await tenantTwo();
    const { user: mgr } = await createUser({ role: 'MANAGER', email: 'boss@acme-hotels.test' });
    const assoc = await createAssociate({ email: 'worker@acme-hotels.test' });
    const { user: worker } = await createUser({ role: 'ASSOCIATE', email: 'worker@acme-hotels.test', associateId: assoc.id });
    await prisma.user.updateMany({ where: { id: { in: [mgr.id, worker.id] } }, data: { tenantId: T2 } });

    expect((await agent().post('/auth/login').send({ email: mgr.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    expect((await a.patch(`/identity/connections/${connectionId}`).send({ ssoRequiredForStaff: true })).status).toBe(200);
    const refused = await agent().post('/auth/login').send({ email: mgr.email, password: DEFAULT_TEST_PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('sso_required');
    expect((await agent().post('/auth/login').send({ email: worker.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
    // Alto HR's staff are untouched by another tenant's rule.
    const { user: altoMgr } = await createUser({ role: 'MANAGER' });
    expect((await agent().post('/auth/login').send({ email: altoMgr.email, password: DEFAULT_TEST_PASSWORD })).status).toBe(200);
  });
});

describe('SCIM per tenant', () => {
  it('a tenant’s token creates in its tenant, sees only its people, and stops when revoked', async () => {
    const { a } = await tenantTwo();
    await createUser({ role: 'MANAGER', email: 'alto-only@alto.test' });
    const issued = await a.post('/identity/scim-tokens').send({ name: 'Okta provisioning' });
    expect(issued.status).toBe(201);
    expect(issued.body.token).toMatch(/^alto_scim_[0-9a-f]{64}$/);
    const scim = (path: string) => agent().get(`/scim/v2${path}`).set('Authorization', `Bearer ${issued.body.token}`);

    const created = await agent()
      .post('/scim/v2/Users')
      .set('Authorization', `Bearer ${issued.body.token}`)
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'newhire@acme-hotels.test', active: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'newhire@acme-hotels.test' } })).tenantId).toBe(T2);

    const list = await scim('/Users');
    const names = (list.body.Resources as Array<{ userName: string }>).map((r) => r.userName);
    expect(names).toContain('newhire@acme-hotels.test');
    expect(names).not.toContain('alto-only@alto.test');

    const tokenRow = await prisma.scimToken.findFirstOrThrow({ where: { tenantId: T2 } });
    expect(tokenRow.hashedSecret).not.toContain(issued.body.token);
    await a.post(`/identity/scim-tokens/${tokenRow.id}/revoke`).send({});
    expect((await scim('/Users')).status).toBe(401);
  });
});

describe('administration', () => {
  it('never returns a secret; the executive cannot read or change sign-in', async () => {
    const { a } = await tenantTwo();
    const got = await a.get('/identity');
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain(CLIENT_SECRET);
    expect(got.body.connections[0]).toMatchObject({ issuerUrl: ISSUER, clientId: CLIENT_ID, enabled: true, linkedPeople: 0 });
    const row = await prisma.identityConnection.findFirstOrThrow({ where: { tenantId: T2 } });
    expect(decryptString(row.clientSecretEnc)).toBe(CLIENT_SECRET);

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(agent(), exec.email);
    expect((await e.get('/identity')).status).toBe(403);
  });

  it('the environment IdP becomes Alto HR’s connection, its secret sealed, and follows a rotated secret', async () => {
    __setOidcEnvForTests({ issuerUrl: ISSUER, clientId: 'env-client', clientSecret: 'env-secret-1', buttonLabel: 'Sign in with Entra' });
    const row = await ensureEnvIdentity(prisma);
    expect(row).toMatchObject({ tenantId: ALTO_TENANT_ID, fromEnvironment: true, clientId: 'env-client' });
    expect(decryptString(row!.clientSecretEnc)).toBe('env-secret-1');
    __setOidcEnvForTests({ issuerUrl: ISSUER, clientId: 'env-client', clientSecret: 'env-secret-2', buttonLabel: 'Sign in with Entra' });
    const rotated = await ensureEnvIdentity(prisma);
    expect(rotated!.id).toBe(row!.id);
    expect(decryptString(rotated!.clientSecretEnc)).toBe('env-secret-2');
    __clearOidcEnvOverrideForTests();
  });
});
