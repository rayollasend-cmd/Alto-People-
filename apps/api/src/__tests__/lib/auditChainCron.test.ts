import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { enqueueAudit, flushPendingAudits } from '../../lib/audit.js';
import { runAuditChainChecks } from '../../lib/auditChain.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';

/**
 * Audit 2026-10-21 item 20: the nightly verifier. A break in the chain is
 * recorded as an AuditChainCheck and raised as an AUDIT_CHAIN security
 * alert that reaches the operator's org admins (and the security contact
 * by email when one is set) — not a row nobody reads.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('runAuditChainChecks', () => {
  it('records a clean check, then detects a forced edit and alerts the security role once', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.orgSetting.upsert({ where: { tenantId: '00000000-0000-4000-8000-000000000001' }, create: { securityContactEmail: 'security@example.test' }, update: { securityContactEmail: 'security@example.test' } });
    await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
      for (let i = 0; i < 4; i += 1) {
        enqueueAudit({ actorUserId: admin.id, clientId: null, tenantId: ALTO_TENANT_ID, action: 'test.step', entityType: 'User', entityId: admin.id, metadata: { i } }, 'test');
      }
    });
    await flushPendingAudits();

    const clean = await runAuditChainChecks(prisma);
    expect(clean).toEqual([]);
    const checks = await prisma.auditChainCheck.findMany({ where: { tenantId: ALTO_TENANT_ID } });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ ok: true, rows: 4 });

    const target = (await prisma.auditLog.findFirst({ where: { tenantId: ALTO_TENANT_ID, action: 'test.step' }, orderBy: { seq: 'asc' } }))!;
    await prisma.$transaction([
      prisma.$queryRawUnsafe(`SELECT set_config('session_replication_role', 'replica', true)`),
      prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{"i":99}' WHERE "id" = $1::uuid`, target.id),
    ]);

    const broken = await runAuditChainChecks(prisma);
    await flushPendingNotifications();
    expect(broken.map((b) => b.tenantId)).toEqual([ALTO_TENANT_ID]);
    expect(broken[0]!.breaks).toContainEqual({ seq: String(target.seq), reason: 'hash' });
    expect(await prisma.auditChainCheck.findFirst({ where: { tenantId: ALTO_TENANT_ID, ok: false } })).not.toBeNull();

    const alerts = await prisma.securityAlert.findMany({ where: { rule: 'AUDIT_CHAIN' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.summary).toMatch(/hash chain is broken/);
    expect(alerts[0]!.deliveredTo).toContain('security-contact');
    expect(alerts[0]!.deliveredTo).toContain(`user:${admin.id}`);
    // The admin's bell carries it (the contact's email went out: 'security-contact' above;
    // the generic sender writes a row only for a failed send).
    const bell = await prisma.notification.findFirst({ where: { recipientUserId: admin.id, channel: 'IN_APP', subject: 'Security alert' } });
    expect(bell).not.toBeNull();
    // The link lands on the audit page (App.tsx 'audit'); '/admin/audit' was a 404 (audit 2026-10-29 CRAWL-2).
    expect(bell!.linkUrl).toBe('/audit');
    expect(await prisma.notification.count({ where: { recipientEmail: 'security@example.test', status: { not: 'SENT' } } })).toBe(0);

    // The same break an hour later is one alert, not a nightly nag.
    await runAuditChainChecks(prisma);
    expect(await prisma.securityAlert.count({ where: { rule: 'AUDIT_CHAIN' } })).toBe(1);
  });
});
