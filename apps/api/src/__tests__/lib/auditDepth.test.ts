import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { prisma as appPrisma } from '../../db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { archiveAuditRows, runAuditChainChecks, verifyAuditChain } from '../../lib/auditChain.js';
import { deliverAuditSinks, setAuditSinkSenderForTests } from '../../lib/auditSink.js';
import { getBlobStore } from '../../lib/blobStore.js';
import { decryptBytes } from '../../lib/crypto.js';
import { encryptString } from '../../lib/crypto.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { verifySignatureV2 } from '../../lib/webhookSecrets.js';
import { gunzipSync } from 'node:zlib';

/**
 * Brief 2-3 step 4 — audit depth: the per-tenant hash chain and its
 * verifier (an edit made around the triggers is detected), masked
 * before/after on the sensitive models, retention with the encrypted
 * archive (nothing deleted), the uncapped export and the SIEM sink.
 */

const T2 = '44444444-4444-4444-8444-444444444444';
const SINK_URL = 'https://203.0.113.10/siem';

beforeEach(truncateAll);
afterEach(() => setAuditSinkSenderForTests(null));
afterAll(async () => {
  await prisma.$disconnect();
});

const row = (action: string, tenantId: string = ALTO_TENANT_ID, createdAt?: Date) =>
  prisma.auditLog.create({ data: { action, entityType: 'Test', entityId: action, tenantId, metadata: { n: action }, ...(createdAt ? { createdAt } : {}) } });

describe('the hash chain', () => {
  it('chains each tenant separately, in order, and verifies', async () => {
    await prisma.tenant.create({ data: { id: T2, slug: 'chain-two', name: 'Two' } });
    const a1 = await row('a1');
    const b1 = await row('b1', T2);
    const a2 = await row('a2');
    expect([a1.seq, a2.seq, b1.seq]).toEqual([1n, 2n, 1n]);
    expect(a1.prevHash).toBeNull();
    expect(a2.prevHash).toBe(a1.hash);
    expect(a2.hash).toMatch(/^[0-9a-f]{64}$/);
    const r = await verifyAuditChain(prisma, ALTO_TENANT_ID);
    expect(r).toMatchObject({ rows: 2, headSeq: 2n, headHash: a2.hash, breaks: [] });
  });

  it('refuses edits, deletes and TRUNCATE; detects an edit made around the triggers', async () => {
    await row('x1');
    const x2 = await row('x2');
    await row('x3');
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'forged' WHERE "id" = $1::uuid`, x2.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "hash" = 'f' WHERE "id" = $1::uuid`, x2.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = $1::uuid`, x2.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/);

    // A superuser who switches the triggers off for one transaction (the
    // test database's owner can): the verifier still sees it.
    await prisma.$transaction([
      prisma.$queryRawUnsafe(`SELECT set_config('session_replication_role', 'replica', true)`),
      prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{"n":"forged"}' WHERE "id" = $1::uuid`, x2.id),
    ]);
    const r = await verifyAuditChain(prisma, ALTO_TENANT_ID);
    expect(r.breaks).toEqual([{ seq: '2', reason: 'hash' }]);

    const broken = await runAuditChainChecks(prisma);
    expect(broken.map((b) => b.tenantId)).toEqual([ALTO_TENANT_ID]);
    expect(await prisma.securityAlert.count({ where: { rule: 'AUDIT_CHAIN' } })).toBe(1);
    expect(await prisma.auditChainCheck.count({ where: { tenantId: ALTO_TENANT_ID, ok: false } })).toBe(1);
  });

  it('detects a removed tail against the last clean head', async () => {
    await row('t1');
    const t2 = await row('t2');
    expect(await runAuditChainChecks(prisma)).toEqual([]);
    await prisma.$transaction([
      prisma.$queryRawUnsafe(`SELECT set_config('session_replication_role', 'replica', true)`),
      prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = $1::uuid`, t2.id),
    ]);
    const r = await verifyAuditChain(prisma, ALTO_TENANT_ID);
    expect(r.breaks).toEqual([{ seq: '2', reason: 'head_missing' }]);
  });
});

describe('before and after, masked', () => {
  it('a role change and a bank change carry what changed, never a secret', async () => {
    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(agent(), admin.email);
    expect((await a.patch(`/admin/users/${target.id}`).send({ role: 'MANAGER' })).status).toBe(200);
    await flushPendingAudits();
    const roleRow = await prisma.auditLog.findFirst({ where: { action: 'data.changed', entityType: 'User', entityId: target.id } });
    expect(roleRow?.actorUserId).toBe(admin.id);
    expect(roleRow?.metadata).toMatchObject({ changed: expect.arrayContaining(['role']), before: { role: 'ASSOCIATE' }, after: { role: 'MANAGER' } });

    const assoc = await createAssociate();
    const pm = await prisma.payoutMethod.create({
      data: { associateId: assoc.id, type: 'BANK_ACCOUNT', accountNumberEnc: encryptString('000123456789'), routingNumberEnc: encryptString('021000021'), accountLast4: '6789', bankName: 'First' },
    });
    await appPrisma.payoutMethod.update({ where: { id: pm.id }, data: { accountNumberEnc: encryptString('000999998888'), accountLast4: '8888' } });
    await flushPendingAudits();
    const bank = await prisma.auditLog.findFirst({ where: { action: 'data.changed', entityType: 'PayoutMethod', entityId: pm.id } });
    expect(bank?.metadata).toMatchObject({ before: { accountNumberEnc: '[set]', accountLast4: '6789' }, after: { accountNumberEnc: '[changed]', accountLast4: '8888' } });
    expect(JSON.stringify(bank?.metadata)).not.toMatch(/999998888|123456789/);
  });
});

describe('retention and the archive', () => {
  it('archives rows past retention, encrypted, and deletes nothing; retention never drops below 7 years', async () => {
    const old = new Date();
    old.setUTCFullYear(old.getUTCFullYear() - 8);
    await row('old-1', ALTO_TENANT_ID, old);
    await row('old-2', ALTO_TENANT_ID, new Date(old.getTime() + 1000));
    await row('recent');
    const r = await archiveAuditRows(prisma, ALTO_TENANT_ID);
    expect(r.archived).toBe(2);
    const blob = await getBlobStore().get(r.objectKey!);
    const lines = gunzipSync(decryptBytes(blob!)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string });
    expect(lines.map((l) => l.action)).toEqual(['old-1', 'old-2']);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'old-' } } })).toBe(2);
    expect((await archiveAuditRows(prisma, ALTO_TENANT_ID)).archived).toBe(0);

    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    expect((await a.put('/audit/integrity/retention').send({ years: 5 })).status).toBe(400);
    expect((await a.put('/audit/integrity/retention').send({ years: 10 })).status).toBe(200);
    const integrity = await a.get('/audit/integrity');
    expect(integrity.body.retentionYears).toBe(10);
    expect(integrity.body.archives).toHaveLength(1);
  });
});

describe('export and the SIEM sink', () => {
  it('the full export is uncapped and carries the chain', async () => {
    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    for (let i = 0; i < 3; i++) await row(`e${i}`);
    const res = await a.get('/audit/export.csv');
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toBe('seq,createdAt,action,actorEmail,entityType,entityId,clientId,metadata,hash');
    expect(res.text).toContain(',e2,');
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    expect((await (await loginAs(agent(), exec.email)).get('/audit/export.csv')).status).toBe(403);
  });

  it('streams new rows in chain order, signed; a failure keeps the cursor and backs off', async () => {
    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    const made = await a.put('/audit/integrity/sink').send({ url: SINK_URL });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const secret = made.body.secret as string;

    const posts: Array<{ body: string; sig: string }> = [];
    let fail = true;
    setAuditSinkSenderForTests(async (_url, init) => {
      posts.push({ body: init.body, sig: init.headers['X-Alto-Signature']! });
      return fail ? { status: 503, ok: false } : { status: 200, ok: true };
    });
    await row('s1');
    await row('s2');
    expect(await deliverAuditSinks(prisma)).toBe(0);
    let sink = await prisma.auditSink.findFirstOrThrow();
    expect(sink.failures).toBe(1);
    expect(sink.nextAttemptAt).not.toBeNull();

    fail = false;
    await prisma.auditSink.update({ where: { id: sink.id }, data: { nextAttemptAt: null } });
    const sent = await deliverAuditSinks(prisma);
    expect(sent).toBeGreaterThanOrEqual(2);
    const last = posts[posts.length - 1]!;
    expect(verifySignatureV2(secret, last.body, last.sig)).toBe(true);
    const lines = last.body.trim().split('\n').map((l) => JSON.parse(l) as { action: string; seq: string; hash: string });
    expect(lines.map((l) => l.action)).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(lines.map((l) => Number(l.seq))).toEqual([...lines.map((l) => Number(l.seq))].sort((x, y) => x - y));
    sink = await prisma.auditSink.findFirstOrThrow();
    expect(sink.failures).toBe(0);
    expect(String(sink.cursorSeq)).toBe(lines[lines.length - 1]!.seq);
    expect(await prisma.auditSinkDelivery.count({ where: { ok: false } })).toBe(1);
  });
});
