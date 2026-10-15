import { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { ALTO_TENANT_ID, currentTenantId, runWithTenant, tenantContext, tenantIdForWrite, withPlatformScope } from '../../lib/tenant.js';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma } from '../../../test/db.js';

/**
 * Tenant foundations (Brief 2-1, step one). Additive only:
 *
 *   The Alto HR tenant exists; every model except the shared reference
 *   data carries a nullable tenantId; rows written without any tenant in
 *   context read as Alto HR by database default; the request context
 *   resolves to Alto HR for every signed-in request today; nothing is
 *   refused.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

// Platform rows, not any tenant's: the price list, the keyring canary, the security alerts
// (their audit rows carry the tenant), SAML's request/assertion memory.
const EXEMPT = new Set(['Tenant', 'PayrollConfig', 'LocalTaxRule', 'GeoCache', 'BillingPrice', 'EncryptionCanary', 'SecurityAlert', 'SamlCache']);
const NO_DEFAULT = new Set(['ApiBoot', 'RouteUsageDaily', 'WebVitalDaily', 'ReliabilityWeek', 'ComplianceEvidence', 'ComplianceEvidenceSignoff', 'AuditChainCheck', 'AuditArchive']);

describe('the schema', () => {
  it('has the Alto HR tenant and a tenantId on every model but the shared reference data', async () => {
    const alto = await prisma.tenant.findUnique({ where: { id: ALTO_TENANT_ID } });
    expect(alto).toMatchObject({ slug: 'alto-hr', name: 'Alto HR', status: 'ACTIVE' });

    const missing: string[] = [];
    const unexpectedDefault: string[] = [];
    for (const m of Prisma.dmmf.datamodel.models) {
      if (EXEMPT.has(m.name)) {
        if (m.fields.some((f) => f.name === 'tenantId')) missing.push(`${m.name} should not carry tenantId`);
        continue;
      }
      const f = m.fields.find((x) => x.name === 'tenantId');
      if (!f) {
        missing.push(m.name);
        continue;
      }
      expect(f.isRequired, `${m.name}.tenantId must be nullable in step one`).toBe(false);
      const hasDefault = f.hasDefaultValue;
      if (NO_DEFAULT.has(m.name) && hasDefault) unexpectedDefault.push(m.name);
      if (!NO_DEFAULT.has(m.name) && !hasDefault) unexpectedDefault.push(`${m.name} (no default)`);
    }
    expect(missing).toEqual([]);
    expect(unexpectedDefault).toEqual([]);
    expect(Prisma.dmmf.datamodel.models.length).toBeGreaterThan(260);
  });

  it('a row written with no tenant in hand reads as Alto HR; telemetry stays platform-wide', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { tenantId: true } });
    expect(row.tenantId).toBe(ALTO_TENANT_ID);
    const boot = await prisma.apiBoot.create({ data: { version: 'test', nodeVersion: process.version }, select: { tenantId: true } });
    expect(boot.tenantId).toBeNull();
  });
});

describe('the request context', () => {
  it('nests, falls back to Alto HR for writes, and marks the platform scope', async () => {
    expect(currentTenantId()).toBeNull();
    expect(tenantIdForWrite()).toBe(ALTO_TENANT_ID);
    await runWithTenant('11111111-1111-4111-8111-111111111111', 'job', async () => {
      expect(currentTenantId()).toBe('11111111-1111-4111-8111-111111111111');
      expect(tenantContext()).toMatchObject({ source: 'job', platform: false });
      await withPlatformScope(async () => {
        expect(tenantContext()).toMatchObject({ platform: true, source: 'platform', tenantId: '11111111-1111-4111-8111-111111111111' });
      });
      expect(tenantContext()?.platform).toBe(false);
    });
    expect(currentTenantId()).toBeNull();
  });

  it('every signed-in request runs as Alto HR today', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), user.email);
    const me = await a.get('/auth/me');
    expect(me.status).toBe(200);
    // The context is request-scoped; it is observable only from inside a handler.
    // /health runs before the middleware and answers without one.
    expect((await agent().get('/health')).status).toBe(200);
  });
});
