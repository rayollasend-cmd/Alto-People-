import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { __resetTrustCacheForTests } from '../../lib/trustCenter.js';
import { runAuditChainChecks } from '../../lib/auditChain.js';

/**
 * UX upgrade step 4 — the Trust Center: the public summary needs no
 * account and carries statuses, dates and counts only (never the security
 * contact's address); the signed-in view adds the tenant's numbers and is
 * read by org admins, executives and audit readers, nobody else.
 */

beforeEach(async () => {
  await truncateAll();
  __resetTrustCacheForTests();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the Trust Center', () => {
  it('the public summary needs no account and leaks nothing', async () => {
    await prisma.orgSetting.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', securityContactEmail: 'security@altohr.com' }, update: { securityContactEmail: 'security@altohr.com' } });
    const res = await request(createApp()).get('/trust/public');
    expect(res.status).toBe(200);
    expect(res.body.controls.total).toBeGreaterThan(5);
    expect(res.body.controls.items[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), status: expect.any(String) });
    expect(res.body.securityContactSet).toBe(true);
    expect(res.body.subProcessors.length).toBeGreaterThan(3);
    expect(res.body.commitments.length).toBeGreaterThan(3);
    expect(res.body.retention.auditYearsMinimum).toBe(7);
    expect(JSON.stringify(res.body)).not.toContain('security@altohr.com');
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  it('the signed-in view adds the tenant and is gated', async () => {
    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const a = await loginAs(agent(), admin.email);
    await prisma.auditLog.create({ data: { action: 'test', entityType: 'T', entityId: 't' } });
    await runAuditChainChecks(prisma);
    const res = await a.get('/trust');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tenant.auditChain).toMatchObject({ ok: true, rows: expect.any(Number) });
    expect(res.body.tenant.retentionYears).toBe(7);
    expect(res.body.tenant.siem).toBe('OFF');
    expect(res.body.tenant.agents.registered).toBeGreaterThanOrEqual(0);

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    expect((await (await loginAs(agent(), exec.email)).get('/trust')).status).toBe(200);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(agent(), assoc.email)).get('/trust')).status).toBe(403);
    expect((await agent().get('/trust')).status).toBe(401);
  });
});
