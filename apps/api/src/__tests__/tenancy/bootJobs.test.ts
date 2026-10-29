import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { prisma as appPrisma } from '../../db.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { AUDIT_SINK_JOB, createAuditSink, setAuditSinkSenderForTests, startAuditSinkCron } from '../../lib/auditSink.js';
import { bootJobDefinitions, installPlatformScopeAudit } from '../../lib/bootJobs.js';
import { __resetBrandingCacheForTests, refreshBranding } from '../../lib/branding.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { __resetJobsForTests, runJobNow } from '../../lib/jobs.js';
import { startOpsSopCron } from '../../lib/storeShiftSop.js';
import { ALTO_TENANT_ID, runWithTenant, withPlatformScope } from '../../lib/tenant.js';
import { resetTenantCache, type TenantJobRun } from '../../lib/tenantJobs.js';
import { resetTenantObservations, tenantObservations } from '../../lib/tenantGuard.js';
import { sealLegacyWebhookSecretsEverywhere } from '../../lib/webhookDispatch.js';
import { openWebhookSecret } from '../../lib/webhookSecrets.js';

/**
 * Audit 2026-10-29 CRAWL-4 / CRAWL-5 / CODE-23: the boot's timers and
 * one-shots run under the tenancy wall exactly as production does — no
 * TENANCY_UNSCOPED escape hatch — and none of them may leave a
 * `no_context` observation. Before the fix the agents' approval expiry,
 * the platform-scope audit row, the webhook secret seal, the branding
 * refresh and the SOP library seed were all refused by the wall at every
 * boot or every 15 minutes, and nothing caught it.
 */

const T2 = '29292929-2929-4929-8929-292929292929';
let unscoped: string | undefined;

/** Production's wall: a query with no tenant in context throws. */
function strictWall(): void {
  unscoped = process.env.TENANCY_UNSCOPED;
  delete process.env.TENANCY_UNSCOPED;
}
function noContextSeen() {
  return tenantObservations().filter((o) => o.kind === 'no_context');
}

beforeEach(async () => {
  await truncateAll();
  await prisma.tenant.create({ data: { id: T2, slug: 'boot-two', name: 'Boot Two' } });
  resetTenantCache();
  __resetBrandingCacheForTests();
  resetTenantObservations();
});
afterEach(() => {
  if (unscoped !== undefined) process.env.TENANCY_UNSCOPED = unscoped;
  unscoped = undefined;
  setAuditSinkSenderForTests(null);
  __resetJobsForTests();
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('the boot sweeps (lib/bootJobs)', () => {
  it('every one runs once per tenant, inside it, with no query outside a tenant', async () => {
    strictWall();
    const defs = bootJobDefinitions(appPrisma);
    expect(defs.map((d) => d.name)).toEqual(['personWorkers', 'agentSweep', 'retirementElections', 'backupWithholding', 'paySchedules', 'books', 'integrations', 'robotSampling']);
    for (const def of defs) {
      const r = (await def.run()) as TenantJobRun;
      // Robots run only where the module is on (off by default); the rest run for both tenants.
      expect({ job: def.name, failed: r.failed }).toEqual({ job: def.name, failed: 0 });
      expect(r.ran + r.skipped).toBe(2);
    }
    expect(noContextSeen()).toEqual([]);
  });

  it('agent approvals past their deadline expire — in their own tenant', async () => {
    await createUser({ role: 'HR_ADMINISTRATOR' }); // the built-ins' owner
    await runWithTenant(ALTO_TENANT_ID, 'job', () => ensureBuiltInAgents(appPrisma, ALTO_TENANT_ID));
    const agent = await prisma.agentProfile.findFirstOrThrow({ where: { tenantId: ALTO_TENANT_ID } });
    const past = new Date(Date.now() - 60_000);
    const due = await prisma.agentApprovalRequest.create({
      data: { workerId: agent.workerId, tenantId: ALTO_TENANT_ID, action: 'CASE_OPEN', summary: 'Open a case', payload: {}, payloadHash: 'x'.repeat(64), expiresAt: past },
    });
    const later = await prisma.agentApprovalRequest.create({
      data: { workerId: agent.workerId, tenantId: ALTO_TENANT_ID, action: 'CASE_OPEN', summary: 'Open another', payload: {}, payloadHash: 'y'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    strictWall();
    const sweep = bootJobDefinitions(appPrisma).find((d) => d.name === 'agentSweep')!;
    expect(((await sweep.run()) as TenantJobRun).failed).toBe(0);
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('EXPIRED');
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('PENDING');
    expect(noContextSeen()).toEqual([]);
  });
});

describe('the boot one-shots', () => {
  it('opening the platform scope with no tenant in context writes the platform.scope_opened row', async () => {
    const uninstall = installPlatformScopeAudit();
    try {
      strictWall();
      await withPlatformScope(() => 1);
      await flushPendingAudits();
      const rows = await prisma.auditLog.findMany({ where: { action: 'platform.scope_opened' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tenantId: ALTO_TENANT_ID, entityType: 'Tenant', entityId: ALTO_TENANT_ID });
      expect(noContextSeen()).toEqual([]);
    } finally {
      uninstall();
    }
  });

  it('legacy plain-text webhook secrets are sealed in every tenant', async () => {
    const a = await prisma.webhook.create({ data: { name: 'A', url: 'https://203.0.113.20/hook', secret: 'plain-a', tenantId: ALTO_TENANT_ID } });
    const b = await prisma.webhook.create({ data: { name: 'B', url: 'https://203.0.113.21/hook', secret: 'plain-b', tenantId: T2 } });
    strictWall();
    await sealLegacyWebhookSecretsEverywhere(appPrisma);
    for (const [id, plain] of [[a.id, 'plain-a'], [b.id, 'plain-b']] as const) {
      const row = await prisma.webhook.findUniqueOrThrow({ where: { id } });
      expect(row.secret).toBe('');
      expect(row.secretEnc).not.toBeNull();
      expect(openWebhookSecret(row)).toBe(plain);
    }
    expect(noContextSeen()).toEqual([]);
  });

  it('a branding refresh started outside any tenant reads that tenant’s row', async () => {
    await prisma.orgSetting.create({ data: { id: 'boottwo', tenantId: T2, orgName: 'Boot Two Hotels' } });
    strictWall();
    expect((await refreshBranding(appPrisma, T2)).orgName).toBe('Boot Two Hotels');
    expect(noContextSeen()).toEqual([]);
  });

  it('the SOP library is seeded per tenant at boot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    strictWall();
    startOpsSopCron();
    // The seed is fire-and-forget at boot; wait for both tenants' libraries.
    for (let i = 0; i < 150; i += 1) {
      const counts = await Promise.all([ALTO_TENANT_ID, T2].map((tenantId) => prisma.opsSopTemplate.count({ where: { tenantId } })));
      if (counts.every((n) => n > 0)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await prisma.opsSopTemplate.count({ where: { tenantId: ALTO_TENANT_ID } })).toBeGreaterThan(0);
    expect(await prisma.opsSopTemplate.count({ where: { tenantId: T2 } })).toBeGreaterThan(0);
    expect(noContextSeen()).toEqual([]);
  });
});

describe('the SIEM sink (CODE-23)', () => {
  it('a tick still sending is not overlapped by the next one, so a batch is sent once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await createAuditSink(prisma, ALTO_TENANT_ID, 'https://203.0.113.10/siem', user.id);
    for (const n of [1, 2, 3]) await prisma.auditLog.create({ data: { action: `boot.${n}`, entityType: 'Test', entityId: String(n), tenantId: ALTO_TENANT_ID } });
    let sends = 0;
    setAuditSinkSenderForTests(async () => {
      sends += 1;
      await new Promise((r) => setTimeout(r, 300));
      return { status: 200, ok: true };
    });
    startAuditSinkCron(appPrisma);
    await Promise.all([runJobNow(AUDIT_SINK_JOB), runJobNow(AUDIT_SINK_JOB)]);
    expect(sends).toBe(1);
    expect(await prisma.auditSinkDelivery.count()).toBe(1);
  });
});
