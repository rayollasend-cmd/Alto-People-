import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { __resetTrustCacheForTests, soc2StageFrom } from '../../lib/trustCenter.js';
import { mintDownloadToken, verifyDownloadToken } from '../../lib/trustDownloads.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { recordEvidence } from '../../lib/evidence.js';
import { COMPLIANCE_CONTROLS } from '@alto-people/shared';

/**
 * Audit 2026-10-21, Trust Center: gated downloads (a public request, an
 * approval, a signed link that expires, every download logged) and the SOC 2
 * progress block, said from the controls' evidence.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

beforeEach(async () => {
  await truncateAll();
  __resetTrustCacheForTests();
});
afterAll(async () => {
  await flushPendingAudits();
  await prisma.$disconnect();
});

describe('gated downloads', () => {
  it('request → approve → signed link downloads once logged; expired is 410, unknown is 404', async () => {
    const app = createApp();
    const ask = await request(app).post('/trust/public/requests').send({ name: 'Priya Natarajan', email: 'Priya@BuyerCo.com', company: 'BuyerCo', kind: 'SOC2_REPORT', note: 'Vendor review Q4' });
    expect(ask.status).toBe(202);
    expect(ask.body.status).toBe('PENDING');
    // The same person asking twice gets the one open request.
    expect((await request(app).post('/trust/public/requests').send({ name: 'Priya Natarajan', email: 'priya@buyerco.com', company: 'BuyerCo', kind: 'SOC2_REPORT' })).body.id).toBe(ask.body.id);
    expect((await request(app).post('/trust/public/requests').send({ name: 'P', email: 'nope', company: 'B', kind: 'SOC2_REPORT' })).status).toBe(400);

    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    const list = await a.get('/trust/requests');
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0]).toMatchObject({ email: 'priya@buyerco.com', company: 'BuyerCo', status: 'PENDING', documentOnFile: false });

    // Nothing on file: approving would send a link to nothing.
    const early = await a.post(`/trust/requests/${ask.body.id}`).send({ decision: 'APPROVED' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('no_document');

    const up = await a.post('/trust/documents').field('kind', 'SOC2_REPORT').field('title', 'SOC 2 Type II report 2026').attach('file', PDF, { filename: 'soc2.pdf', contentType: 'application/pdf' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect((await a.get('/trust/documents')).body.documents[0]).toMatchObject({ kind: 'SOC2_REPORT', title: 'SOC 2 Type II report 2026', bytes: PDF.byteLength });

    const ok = await a.post(`/trust/requests/${ask.body.id}`).send({ decision: 'APPROVED' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    expect(ok.body.linkExpiresAt).toEqual(expect.any(String));
    expect((await a.post(`/trust/requests/${ask.body.id}`).send({ decision: 'DECLINED' })).status).toBe(409);

    // The link the email carried: the same token the approval minted.
    const row = await prisma.trustDownloadRequest.findUniqueOrThrow({ where: { id: ask.body.id } });
    const token = mintDownloadToken(row.id, row.linkExpiresAt!);
    const dl = await request(app).get(`/trust/downloads/${token}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(dl.body as Buffer).equals(PDF) || dl.text.startsWith('%PDF')).toBe(true);
    const after = await prisma.trustDownloadRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.downloadCount).toBe(1);
    expect(after.lastDownloadedAt).not.toBeNull();
    await flushPendingAudits();
    expect(await prisma.auditLog.count({ where: { action: 'trust.document_downloaded', entityId: row.id } })).toBe(1);

    // Expired: a token minted for a past expiry.
    const expired = mintDownloadToken(row.id, new Date(Date.now() - 1000));
    expect((await request(app).get(`/trust/downloads/${expired}`)).status).toBe(410);
    // Unknown or tampered.
    expect((await request(app).get(`/trust/downloads/${token.slice(0, -4)}abcd`)).status).toBe(404);
    expect((await request(app).get('/trust/downloads/not-a-token-at-all')).status).toBe(404);

    // The manage gate holds.
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).get('/trust/requests')).status).toBe(403);
  });

  it('tokens verify only with the right signature and a live expiry', () => {
    const exp = new Date(Date.now() + 60_000);
    const t = mintDownloadToken('11111111-1111-4111-8111-111111111111', exp);
    expect(verifyDownloadToken(t)).toMatchObject({ ok: true, requestId: '11111111-1111-4111-8111-111111111111' });
    expect(verifyDownloadToken(t, new Date(exp.getTime() + 1))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyDownloadToken(`${t.slice(0, -2)}zz`)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('SOC 2 progress', () => {
  it('is preparing without evidence, in observation once every control is current, audited only when dated', async () => {
    const controls = COMPLIANCE_CONTROLS.map(() => ({ state: 'current', latest: { status: 'PASS', collectedAt: new Date().toISOString() } }));
    expect(soc2StageFrom([], null)).toBe('preparing');
    expect(soc2StageFrom(controls, null)).toBe('observation');
    expect(soc2StageFrom([...controls.slice(1), { state: 'missing', latest: null }], null)).toBe('preparing');
    expect(soc2StageFrom([...controls.slice(1), { state: 'stale', latest: { status: 'PASS', collectedAt: '2020-01-01T00:00:00.000Z' } }], null)).toBe('preparing');
    expect(soc2StageFrom([{ state: 'missing', latest: null }], new Date('2026-09-01'))).toBe('audited');

    const pub = await request(createApp()).get('/trust/public');
    expect(pub.status).toBe(200);
    expect(pub.body.soc2).toMatchObject({ stage: 'preparing', controlsTotal: COMPLIANCE_CONTROLS.length, reportIssuedOn: null });

    for (const c of COMPLIANCE_CONTROLS) await recordEvidence(c.id, 'test', { status: 'PASS', summary: 'ok', details: {} });
    __resetTrustCacheForTests();
    const observing = await request(createApp()).get('/trust/public');
    expect(observing.body.soc2.stage).toBe('observation');
    expect(observing.body.soc2.controlsCurrent).toBe(COMPLIANCE_CONTROLS.length);
    expect(observing.body.soc2.observationSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    expect((await a.put('/trust/soc2').send({ reportIssuedOn: '2026-09-30' })).status).toBe(200);
    const audited = await request(createApp()).get('/trust/public');
    expect(audited.body.soc2).toMatchObject({ stage: 'audited', reportIssuedOn: '2026-09-30' });
    expect((await a.put('/trust/soc2').send({ reportIssuedOn: null })).status).toBe(200);
    __resetTrustCacheForTests();
    expect((await request(createApp()).get('/trust/public')).body.soc2.stage).toBe('observation');
  });
});
