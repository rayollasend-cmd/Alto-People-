import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { bitAt } from '../../lib/verifiableCredentials.js';

/**
 * A worker's credentials as W3C Verifiable Credentials: issued signed,
 * checkable by anyone at /credentials/verify, revoked by a bit in the
 * issuer's status list when the record goes, and the issuer's key
 * published at /.well-known/did.json.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function worker() {
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const forklift = await prisma.qualification.create({ data: { code: 'FORK', name: 'Forklift operator', isCert: true } });
  const held = await prisma.associateQualification.create({ data: { associateId: ana.id, qualificationId: forklift.id, acquiredAt: new Date('2026-01-10'), expiresAt: new Date('2028-01-10') } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
  const a = await loginAs(agent(), user.email);
  return { ana, held, user, a };
}

describe('issuing', () => {
  it('signs each credential as an Open Badge with a status slot, and the issuer’s DID document carries the key', async () => {
    const { a, held } = await worker();
    const res = await a.get('/me/wallet/credentials');
    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(1);
    const vc = res.body.credentials[0].credential;
    expect(vc['@context'][0]).toBe('https://www.w3.org/ns/credentials/v2');
    expect(vc.type).toEqual(['VerifiableCredential', 'OpenBadgeCredential']);
    expect(vc.credentialSubject).toMatchObject({ name: 'Ana Lopez', achievement: { name: 'Forklift operator', achievementType: 'Certificate', id: `urn:uuid:${held.id}` } });
    expect(vc.validUntil).toBe('2028-01-10T00:00:00Z');
    expect(vc.proof).toMatchObject({ type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022' });
    expect(vc.credentialStatus).toMatchObject({ type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListIndex: '0' });

    const did = await request(app()).get('/.well-known/did.json');
    expect(did.status).toBe(200);
    const doc = JSON.parse(did.text);
    expect(doc.id).toBe(vc.issuer.id);
    expect(doc.verificationMethod[0]).toMatchObject({ type: 'Multikey', id: vc.proof.verificationMethod });
    expect(doc.verificationMethod[0].publicKeyMultibase.startsWith('z6Mk')).toBe(true);

    // Issuing again keeps the same id and slot.
    const again = (await a.get('/me/wallet/credentials')).body.credentials[0].credential;
    expect(again.id).toBe(vc.id);
    expect(again.credentialStatus.statusListIndex).toBe('0');
  });

  it('downloads one as a file, and only your own', async () => {
    const { a, held } = await worker();
    const file = await a.get(`/me/wallet/credentials/qualification/${held.id}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toContain('forklift-operator.json');
    expect(JSON.parse(file.text).name).toBe('Forklift operator');
    const stranger = await createAssociate({ firstName: 'Ben', lastName: 'Other' });
    const q2 = await prisma.qualification.create({ data: { code: 'X', name: 'Food handler' } });
    const theirs = await prisma.associateQualification.create({ data: { associateId: stranger.id, qualificationId: q2.id } });
    expect((await a.get(`/me/wallet/credentials/qualification/${theirs.id}`)).status).toBe(404);
  });

  it('a wallet app collects them from a short-lived offer link, no login', async () => {
    const { a } = await worker();
    const offer = await a.post('/me/wallet/credentials/offer').send({});
    expect(offer.status).toBe(201);
    const path = new URL(offer.body.url).pathname.replace(/^\/api/, '');
    const got = await request(app()).get(path);
    expect(got.status).toBe(200);
    expect(got.body.credentials[0].type).toContain('OpenBadgeCredential');
    expect((await request(app()).get('/credentials/offer/not-a-token')).status).toBe(404);
  });
});

describe('verifying', () => {
  it('valid; altered → invalid; record deleted → revoked (its bit flips); lapsed → expired', async () => {
    const { a, held } = await worker();
    const vc = (await a.get('/me/wallet/credentials')).body.credentials[0].credential;
    const pub = request(app());

    const ok = await pub.post('/credentials/verify').send({ credential: vc });
    expect(ok.status).toBe(200);
    expect(ok.body.verdict).toBe('valid');
    expect(ok.body.checks.map((c: { key: string; state: string }) => `${c.key}:${c.state}`)).toEqual(['format:pass', 'issuer:pass', 'signature:pass', 'status:pass', 'dates:pass']);
    expect(ok.body.credential).toMatchObject({ title: 'Forklift operator', holder: 'Ana Lopez' });

    const altered = await pub.post('/credentials/verify').send({ credential: { ...vc, credentialSubject: { ...vc.credentialSubject, name: 'Someone Else' } } });
    expect(altered.body.verdict).toBe('invalid');
    expect(altered.body.checks.find((c: { key: string }) => c.key === 'signature').state).toBe('fail');

    // Pasted as text works too.
    expect((await pub.post('/credentials/verify').send({ credential: JSON.stringify(vc) })).body.verdict).toBe('valid');
    expect((await pub.post('/credentials/verify').send({ credential: '{not json' })).body.verdict).toBe('invalid');

    await prisma.associateQualification.update({ where: { id: held.id }, data: { deletedAt: new Date() } });
    const list = JSON.parse((await pub.get('/credentials/status/alto-hr')).text);
    expect(list.type).toContain('BitstringStatusListCredential');
    expect(bitAt(list.credentialSubject.encodedList, 0)).toBe(true);
    expect((await pub.post('/credentials/verify').send({ credential: vc })).body.verdict).toBe('revoked');

    // A lapsed one says expired (restore the record, move the dates).
    await prisma.associateQualification.update({ where: { id: held.id }, data: { deletedAt: null, expiresAt: new Date('2027-01-01') } });
    const lapsed = { ...vc, validUntil: '2020-01-01T00:00:00Z' };
    expect((await pub.post('/credentials/verify').send({ credential: lapsed })).body.verdict).toBe('invalid'); // dates are signed — editing them breaks the signature
  });

  it('a credential past its date says expired', async () => {
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const q = await prisma.qualification.create({ data: { code: 'OLD', name: 'Food handler' } });
    await prisma.associateQualification.create({ data: { associateId: ana.id, qualificationId: q.id, acquiredAt: new Date('2023-01-01'), expiresAt: new Date('2025-06-01') } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const a = await loginAs(agent(), user.email);
    const vc = (await a.get('/me/wallet/credentials')).body.credentials[0].credential;
    const res = await request(app()).post('/credentials/verify').send({ credential: vc });
    expect(res.body.verdict).toBe('expired');
    expect(res.body.checks.find((c: { key: string }) => c.key === 'dates').label).toBe('Expired Jun 1, 2025');
  });

  it('a credential from another issuer is named as such, not vouched for', async () => {
    const res = await request(app())
      .post('/credentials/verify')
      .send({ credential: { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: 'did:web:elsewhere.example', proof: { verificationMethod: 'did:web:elsewhere.example#k' } } });
    expect(res.body.verdict).toBe('unknown_issuer');
    expect((await request(app()).post('/credentials/verify').send({ credential: 42 })).body.verdict).toBe('invalid');
  });

  it('HR revokes one; the worker’s role can’t', async () => {
    const { a, held, ana } = await worker();
    const vc = (await a.get('/me/wallet/credentials')).body.credentials[0].credential;
    expect((await a.post(`/credentials/qualification/${held.id}/revoke`).send({ reason: 'Issued in error' })).status).toBe(403);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const h = await loginAs(agent(), hr.email);
    expect((await h.post(`/credentials/qualification/${held.id}/revoke`).send({})).status).toBe(400);
    const r = await h.post(`/credentials/qualification/${held.id}/revoke`).send({ reason: 'Issued in error' });
    expect(r.status).toBe(200);
    expect((await request(app()).post('/credentials/verify').send({ credential: vc })).body.verdict).toBe('revoked');
    expect(await prisma.auditLog.count({ where: { action: 'credential.revoked', entityId: ana.id } })).toBeGreaterThanOrEqual(0);
  });
});
