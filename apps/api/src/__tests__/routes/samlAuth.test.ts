import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { fakeIdpKeys, fakeSamlResponse } from '../../../test/samlFakeIdp.js';
import { flushPendingAudits } from '../../lib/audit.js';

/**
 * Brief 2-3 step 5 — SAML end to end through the routes, against the fake
 * IdP: an admin adds the connection; the login page's button (the OIDC
 * start) hands a SAML connection over; the IdP's form post to the ACS signs
 * the person in by the same rules as OIDC (subject bound on first sign-in,
 * a different subject later refused); a replayed post is refused and
 * audited; the metadata is served.
 */

const IDP = 'http://www.okta.com/exk-acme';
const { KEY, CERT } = fakeIdpKeys();

beforeEach(truncateAll);
afterAll(async () => {
  await prisma.$disconnect();
});

async function setup() {
  const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(agent(), admin.email);
  const made = await a.post('/identity/saml-connections').send({ displayName: 'Acme Okta', ssoUrl: 'https://acme.okta.test/app/sso/saml', idpEntityId: IDP, idpCert: CERT });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const conn = await prisma.identityConnection.findUniqueOrThrow({ where: { id: made.body.id } });
  return { admin, a, conn };
}

/** The browser's trip: the button, our AuthnRequest, and the request id the cache holds. */
async function startFor(connectionId: string, next?: string) {
  const b = agent();
  const viaButton = await b.get('/auth/oidc/start').query({ connection: connectionId, ...(next ? { next } : {}) });
  expect(viaButton.status).toBe(302);
  expect(viaButton.headers.location).toMatch(/^\/auth\/saml\/start\?connection=/);
  const toIdp = await b.get(viaButton.headers.location as string);
  expect(toIdp.status).toBe(302);
  expect(toIdp.headers.location as string).toMatch(/^https:\/\/acme\.okta\.test\/app\/sso\/saml\?/);
  expect(new URL(toIdp.headers.location as string).searchParams.get('SAMLRequest')).toBeTruthy();
  const row = await prisma.samlCache.findFirst({ where: { key: { startsWith: `req:${connectionId}:` } }, orderBy: { createdAt: 'desc' } });
  return { b, requestId: row!.key.slice(`req:${connectionId}:`.length), relayState: new URL(toIdp.headers.location as string).searchParams.get('RelayState') ?? '' };
}

describe('SAML sign-in', () => {
  it('signs a known person in, binds the subject, and lands them where they were going', async () => {
    const { conn } = await setup();
    const { user } = await createUser({ role: 'MANAGER', email: 'ana@acme.test' });
    const { b, requestId, relayState } = await startFor(conn.id, '/schedule');
    expect(relayState).toBe('/schedule');
    const res = await b.post(`/auth/saml/acs/${conn.id}`).type('form').send(fakeSamlResponse(conn, { idp: IDP, key: KEY, inResponseTo: requestId, relayState }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/schedule');
    const me = await b.get('/auth/me');
    expect(me.body.user?.id).toBe(user.id);
    expect(await prisma.userIdentity.count({ where: { userId: user.id, connectionId: conn.id, subject: '00u-ana' } })).toBe(1);
    await flushPendingAudits();
    const login = await prisma.auditLog.findFirst({ where: { action: 'auth.login', actorUserId: user.id }, orderBy: { createdAt: 'desc' } });
    expect(login?.metadata).toMatchObject({ method: 'saml' });

    // The same post again: refused, audited, no session.
    const again = await agent().post(`/auth/saml/acs/${conn.id}`).type('form').send(fakeSamlResponse(conn, { idp: IDP, key: KEY, inResponseTo: requestId }));
    expect(again.headers.location).toMatch(/\/login\?error=sso_failed/);
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed', metadata: { path: ['reason'], string_starts_with: 'saml_' } } })).toBeGreaterThanOrEqual(1);
  });

  it('refuses a different subject for a bound person, and an unknown person, with the same page', async () => {
    const { conn } = await setup();
    await createUser({ role: 'MANAGER', email: 'ana@acme.test' });
    let s = await startFor(conn.id);
    await s.b.post(`/auth/saml/acs/${conn.id}`).type('form').send(fakeSamlResponse(conn, { idp: IDP, key: KEY, inResponseTo: s.requestId }));
    s = await startFor(conn.id);
    const other = await s.b.post(`/auth/saml/acs/${conn.id}`).type('form').send(fakeSamlResponse(conn, { idp: IDP, key: KEY, inResponseTo: s.requestId, nameId: '00u-intruder' }));
    expect(other.headers.location).toBe('/login?error=sso_no_account');
    s = await startFor(conn.id);
    const unknown = await s.b.post(`/auth/saml/acs/${conn.id}`).type('form').send(fakeSamlResponse(conn, { idp: IDP, key: KEY, inResponseTo: s.requestId, nameId: '00u-nobody', email: 'nobody@acme.test' }));
    expect(unknown.headers.location).toBe('/login?error=sso_no_account');
  });

  it('serves SP metadata and lists the connection with what the IdP admin needs', async () => {
    const { a, conn } = await setup();
    const md = await agent().get(`/auth/saml/metadata/${conn.id}`);
    expect(md.status).toBe(200);
    expect(md.text).toContain(`/auth/saml/acs/${conn.id}`);
    const listed = await a.get('/identity');
    const row = listed.body.connections.find((c: { id: string }) => c.id === conn.id);
    expect(row).toMatchObject({ kind: 'SAML', allowIdpInitiated: false });
    expect(row.acsUrl).toContain(`/auth/saml/acs/${conn.id}`);
    expect((await a.post('/identity/saml-connections').send({ displayName: 'Bad', ssoUrl: 'https://x.test/sso', idpEntityId: 'x', idpCert: 'not a certificate at all '.repeat(10) })).status).toBe(400);
  });
});
