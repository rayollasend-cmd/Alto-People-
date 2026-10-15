import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { prisma as appPrisma } from '../../db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { verifyAuditChain } from '../../lib/auditChain.js';
import { encryptString } from '../../lib/crypto.js';
import { issueScimToken } from '../../lib/identity.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';

/**
 * Brief 2-3 acceptance — "the audit log captures a scripted set of actions
 * completely and cannot be altered" (docs/identity-rbac-audit-investigation.md
 * §7). One run against a fresh tenant: each action leaves its row with
 * actor, tenant and target, masked before/after where the action changes a
 * sensitive record; then the chain verifies, an edit, a delete and a
 * truncate are refused, and an edit forced around the triggers is caught.
 *
 * The §7 actions not scripted here have their rows asserted in their own
 * suites: SSO sign-in (identityPerTenant), pay rate change and payout reveal
 * (compensation, payouts), W-4 (w4), shift create/delete and time approval
 * (scheduling, time), payroll run and finalize (payroll), the agent's gated
 * call (agents, agentProductAcceptance). Their rows go through the same
 * insert trigger, so the chain and immutability proofs below cover them.
 */

beforeEach(truncateAll);
afterAll(async () => {
  await prisma.$disconnect();
});

const one = async (where: Parameters<typeof prisma.auditLog.findFirst>[0] extends infer A ? (A extends { where?: infer W } ? W : never) : never) => {
  await flushPendingAudits();
  const r = await prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' } });
  expect(r, JSON.stringify(where)).not.toBeNull();
  return r!;
};

describe('the scripted audit acceptance', () => {
  it('records every scripted action, and the trail cannot be altered unnoticed', async () => {
    const { user: admin } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: person } = await createUser({ role: 'ASSOCIATE' });

    // 1. Password sign-in success.
    const a = await loginAs(agent(), admin.email);
    expect((await one({ action: 'auth.login', actorUserId: admin.id })).tenantId).toBe(ALTO_TENANT_ID);

    // 2. Password sign-in failure.
    expect((await agent().post('/auth/login').send({ email: person.email, password: 'wrong-password-1' })).status).toBe(401);
    await one({ action: 'auth.login_failed', entityId: person.email });

    // 4. Sign-out.
    const p = await loginAs(agent(), person.email);
    expect((await p.post('/auth/logout')).status).toBeLessThan(300);
    await one({ action: 'auth.logout', actorUserId: person.id });

    // 5–6. SCIM create, then deactivate (sessions ended).
    const { token } = await issueScimToken(prisma, ALTO_TENANT_ID, 'Okta', admin.id);
    const created = await agent()
      .post('/scim/v2/Users')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/scim+json')
      .send({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'scim.person@example.com', active: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await one({ action: 'scim.user_created', entityId: created.body.id });
    expect((await agent().delete(`/scim/v2/Users/${created.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(204);
    await one({ action: 'scim.user_deprovisioned', entityId: created.body.id });

    // 8. An admin changes a person's role: the permission change, with before/after.
    expect((await a.patch(`/admin/users/${person.id}`).send({ role: 'MANAGER' })).status).toBe(204);
    await one({ action: 'admin.user_updated', entityId: person.id, actorUserId: admin.id });
    const roleDiff = await one({ action: 'data.changed', entityType: 'User', entityId: person.id });
    expect(roleDiff.metadata).toMatchObject({ before: { role: 'ASSOCIATE' }, after: { role: 'MANAGER' } });
    expect(roleDiff.actorUserId).toBe(admin.id);

    // 9. A custom role's capabilities edited in the matrix.
    const role = await a.post('/tenant-roles').send({ name: 'Lead', archetype: 'MANAGER', capabilities: ['view:dashboard'] });
    expect((await a.patch(`/tenant-roles/${role.body.id}`).send({ capabilities: ['view:dashboard', 'view:my-team'] })).status).toBe(200);
    const matrix = await one({ action: 'permission.changed', entityId: role.body.id, actorUserId: admin.id });
    expect(matrix.metadata).toMatchObject({ change: 'role.updated', before: { capabilities: ['view:dashboard'] }, added: ['view:my-team'] });

    // 10. An additional role granted.
    expect((await a.patch(`/admin/users/${person.id}`).send({ additionalRoles: ['DRIVER'] })).status).toBe(204);
    const extra = await one({ action: 'data.changed', entityType: 'User', entityId: person.id, metadata: { path: ['changed'], array_contains: ['additionalRoles'] } });
    expect(extra.metadata).toMatchObject({ after: { additionalRoles: ['DRIVER'] } });

    // 13. A payout method changed: the bank number is masked.
    const assoc = await createAssociate();
    const pm = await prisma.payoutMethod.create({ data: { associateId: assoc.id, type: 'BANK_ACCOUNT', accountNumberEnc: encryptString('000123456789'), routingNumberEnc: encryptString('021000021'), accountLast4: '6789' } });
    await appPrisma.payoutMethod.update({ where: { id: pm.id }, data: { accountNumberEnc: encryptString('000555554444'), accountLast4: '4444' } });
    const bank = await one({ action: 'data.changed', entityType: 'PayoutMethod', entityId: pm.id });
    expect(bank.metadata).toMatchObject({ after: { accountNumberEnc: '[changed]', accountLast4: '4444' } });
    expect(JSON.stringify(bank.metadata)).not.toContain('555554444');

    // 18. The audit CSV exported.
    expect((await a.get('/audit/logs.csv')).status).toBe(200);
    await one({ action: 'http.export', actorUserId: admin.id, entityId: '/audit/logs.csv' });

    // 20. A tenant setting changed, with before/after.
    expect((await a.put('/audit/integrity/retention').send({ years: 8 })).status).toBe(200);
    expect((await one({ action: 'audit.retention_changed', actorUserId: admin.id })).metadata).toMatchObject({ before: { years: 7 }, after: { years: 8 } });

    // Every row is the tenant's, and chained.
    await flushPendingAudits();
    const rows = await prisma.auditLog.findMany({ where: { tenantId: ALTO_TENANT_ID } });
    expect(rows.length).toBeGreaterThan(12);
    expect(rows.every((r) => r.seq !== null && r.hash !== null)).toBe(true);
    expect((await verifyAuditChain(prisma, ALTO_TENANT_ID)).breaks).toEqual([]);

    // Cannot be altered: edit, delete, truncate refused; a forced edit is detected.
    const target = rows.find((r) => r.action === 'audit.retention_changed')!;
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{}' WHERE "id" = $1::uuid`, target.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "id" = $1::uuid`, target.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditLog" CASCADE`)).rejects.toThrow(/append-only/);
    await prisma.$transaction([
      prisma.$queryRawUnsafe(`SELECT set_config('session_replication_role', 'replica', true)`),
      prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{"after":{"years":50}}' WHERE "id" = $1::uuid`, target.id),
    ]);
    const after = await verifyAuditChain(prisma, ALTO_TENANT_ID);
    expect(after.breaks).toContainEqual({ seq: String(target.seq), reason: 'hash' });
  });
});
