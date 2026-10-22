import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALTO_TENANT_ID, runWithTenant, withPlatformScope } from '../../lib/tenant.js';
import { getTransportSettings } from '../../lib/transport.js';
import { runUsageSnapshots } from '../../lib/billing.js';
import { sweepIdempotencyRecords } from '../../middleware/idempotency.js';
import { prisma as appPrisma } from '../../db.js';
import { prisma, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-1 migration C (20270128190000_tenancy_required): the keys that
 * were unique for the one employer are unique per tenant, the singletons are
 * one row per tenant, pay-check numbers run per tenant, and tenantId is
 * required everywhere it means "whose row".
 */

const T1 = ALTO_TENANT_ID;
const T2 = '22222222-2222-4222-8222-222222222222';

async function payItem(tenantId: string) {
  const a = await prisma.associate.create({ data: { tenantId, firstName: 'Pay', lastName: 'Check', email: `pay-${Math.random().toString(36).slice(2)}@example.com` } });
  const run = await prisma.payrollRun.create({
    data: { tenantId, periodStart: new Date('2026-10-03'), periodEnd: new Date('2026-10-09'), status: 'FINALIZED', totalGross: 1000, totalTax: 0, totalNet: 1000, totalEmployerTax: 0 },
  });
  return prisma.payrollItem.create({ data: { tenantId, payrollRunId: run.id, associateId: a.id, hoursWorked: 40, hourlyRate: 25, grossPay: 1000, federalWithholding: 0, netPay: 1000 } });
}

const check = (tenantId: string, payrollItemId: string) =>
  // Issued void: one LIVE check per paycheck is its own rule, and the numbering is what is under test.
  prisma.payCheck.create({ data: { tenantId, payrollItemId, payeeName: 'Pay Check', amount: 1000, voidedAt: new Date() }, select: { checkNumber: true } });

describe('migration C — keys per tenant', () => {
  beforeEach(async () => {
    await truncateAll();
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'keys-two', name: 'Keys Two' }, update: {} });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a person\'s email is unique within a tenant, not across tenants (associates and candidates)', async () => {
    await prisma.associate.create({ data: { tenantId: T1, firstName: 'A', lastName: 'One', email: 'pat@example.com' } });
    await prisma.associate.create({ data: { tenantId: T2, firstName: 'A', lastName: 'Two', email: 'pat@example.com' } });
    await expect(prisma.associate.create({ data: { tenantId: T1, firstName: 'A', lastName: 'Dup', email: 'pat@example.com' } })).rejects.toMatchObject({ code: 'P2002' });
    await prisma.candidate.create({ data: { tenantId: T1, firstName: 'C', lastName: 'One', email: 'cand@example.com' } });
    await prisma.candidate.create({ data: { tenantId: T2, firstName: 'C', lastName: 'Two', email: 'cand@example.com' } });
    await expect(prisma.candidate.create({ data: { tenantId: T2, firstName: 'C', lastName: 'Dup', email: 'cand@example.com' } })).rejects.toMatchObject({ code: 'P2002' });
    // Login stays global (decision 1): one User per email across the platform.
    await prisma.user.create({ data: { email: 'login@example.com', role: 'ASSOCIATE', status: 'ACTIVE' } });
    await expect(prisma.user.create({ data: { tenantId: T2, email: 'login@example.com', role: 'ASSOCIATE', status: 'ACTIVE' } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the four-digit employee number space is per tenant (decision 6)', async () => {
    const hmac = Buffer.from('same-pin-hmac');
    const a1 = await prisma.associate.create({ data: { tenantId: T1, firstName: 'K', lastName: 'One', email: 'k1@example.com' } });
    const a2 = await prisma.associate.create({ data: { tenantId: T2, firstName: 'K', lastName: 'Two', email: 'k2@example.com' } });
    const a3 = await prisma.associate.create({ data: { tenantId: T1, firstName: 'K', lastName: 'Three', email: 'k3@example.com' } });
    await prisma.kioskPin.create({ data: { tenantId: T1, associateId: a1.id, pinHmac: hmac } });
    await prisma.kioskPin.create({ data: { tenantId: T2, associateId: a2.id, pinHmac: hmac } });
    await expect(prisma.kioskPin.create({ data: { tenantId: T1, associateId: a3.id, pinHmac: hmac } })).rejects.toMatchObject({ code: 'P2002' });
    const found = await prisma.kioskPin.findUnique({ where: { tenantId_pinHmac: { tenantId: T2, pinHmac: hmac } }, select: { associateId: true } });
    expect(found?.associateId).toBe(a2.id);
  });

  it('generated keys no longer collide across tenants', async () => {
    const attester = await prisma.user.create({ data: { email: 'attester@example.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE' } });
    for (const tenantId of [T1, T2]) {
      await prisma.sponsor.create({ data: { tenantId, name: 'CIEE', programType: 'J1_SWT' } });
      await prisma.worktagCategory.create({ data: { tenantId, key: 'cost-center', label: 'Cost center' } });
      await prisma.recruitingSourceSpend.create({ data: { tenantId, source: 'indeed', month: new Date('2026-10-01'), amount: 100 } });
      await prisma.manualComplianceAttestation.create({
        data: { tenantId, key: 'osha-300a', periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-12-31'), outcome: 'YES', attestedById: attester.id },
      });
    }
    expect(await prisma.sponsor.count({ where: { name: 'CIEE' } })).toBe(2);
    expect(await prisma.worktagCategory.count({ where: { key: 'cost-center' } })).toBe(2);
    expect(await prisma.recruitingSourceSpend.count({ where: { source: 'indeed' } })).toBe(2);
    expect(await prisma.manualComplianceAttestation.count({ where: { key: 'osha-300a' } })).toBe(2);
    await expect(prisma.sponsor.create({ data: { tenantId: T1, name: 'CIEE', programType: 'J1_SWT' } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a filed 941 for the same quarter is one per tenant, not one per platform', async () => {
    const filed = (tenantId: string) => prisma.$executeRaw`
      INSERT INTO "TaxForm" ("id", "tenantId", "kind", "taxYear", "quarter", "status", "amounts", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, 'F941'::"TaxFormKind", 2026, 3, 'FILED'::"TaxFormStatus", '{}'::jsonb, now())`;
    await filed(T1);
    await filed(T2);
    await expect(filed(T1)).rejects.toThrow(/23505|already exists/);
  });

  it('pay-check numbers run per tenant: a new tenant starts at 1, Alto HR carries on, nothing is renumbered', async () => {
    const i1 = await payItem(T1);
    const i2 = await payItem(T2);
    // Alto HR's counter carries on from wherever it stands (the migration seeded it from the old sequence).
    await prisma.tenantCounter.upsert({ where: { tenantId_key: { tenantId: T1, key: 'pay_check_number' } }, create: { tenantId: T1, key: 'pay_check_number', value: 1041 }, update: { value: 1041 } });
    expect((await check(T1, i1.id)).checkNumber).toBe(1042);
    expect((await check(T2, i2.id)).checkNumber).toBe(1);
    expect((await check(T2, i2.id)).checkNumber).toBe(2);
    expect((await check(T1, i1.id)).checkNumber).toBe(1043);
    // A caller that names its number keeps it, and the counter moves past it.
    expect((await prisma.payCheck.create({ data: { tenantId: T2, payrollItemId: i2.id, payeeName: 'x', amount: 1, checkNumber: 50, voidedAt: new Date() }, select: { checkNumber: true } })).checkNumber).toBe(50);
    expect((await check(T2, i2.id)).checkNumber).toBe(51);
    await expect(prisma.payCheck.create({ data: { tenantId: T2, payrollItemId: i2.id, payeeName: 'x', amount: 1, checkNumber: 51, voidedAt: new Date() } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the singletons are one row per tenant: each tenant reads and writes its own', async () => {
    const one = await runWithTenant(T1, 'session', () => getTransportSettings(prisma));
    const two = await runWithTenant(T2, 'session', () => getTransportSettings(prisma));
    expect(one).toBeTruthy();
    expect(two).toBeTruthy();
    const rows = await prisma.transportSettings.findMany({ select: { id: true, tenantId: true } });
    expect(rows.map((r) => r.tenantId).sort()).toEqual([T1, T2].sort());
    await prisma.submitterProfile.create({ data: { tenantId: T1, ein: '123456789', userId: 'BSO1', name: 'Alto', addressLine1: '1 A St', city: 'Destin', state: 'FL', zip5: '32541', contactName: 'A', contactPhone: '8505550100', contactEmail: 'a@example.com' } });
    await prisma.submitterProfile.create({ data: { tenantId: T2, ein: '987654321', userId: 'BSO2', name: 'Two', addressLine1: '2 B St', city: 'Destin', state: 'FL', zip5: '32541', contactName: 'B', contactPhone: '8505550101', contactEmail: 'b@example.com' } });
    await expect(prisma.submitterProfile.create({ data: { tenantId: T2, ein: '111111111', userId: 'BSO3', name: 'Dup', addressLine1: '3 C St', city: 'Destin', state: 'FL', zip5: '32541', contactName: 'C', contactPhone: '8505550102', contactEmail: 'c@example.com' } })).rejects.toMatchObject({ code: 'P2002' });
    expect((await prisma.submitterProfile.findUniqueOrThrow({ where: { tenantId: T2 } })).ein).toBe('987654321');
    await prisma.orgSetting.create({ data: { tenantId: T2, orgName: 'Two' } });
    await expect(prisma.orgSetting.create({ data: { tenantId: T2, orgName: 'Again' } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('tenantId is required: a row cannot be written with no tenant', async () => {
    await expect(prisma.$executeRaw`INSERT INTO "Region" ("id", "name", "updatedAt", "tenantId") VALUES (gen_random_uuid(), 'nowhere', now(), NULL)`).rejects.toThrow(/23502/);
    // The database default still fills a row that names no tenant (Alto HR).
    const r = await prisma.region.create({ data: { name: 'Defaulted' }, select: { tenantId: true } });
    expect(r.tenantId).toBe(T1);
  });
});

describe('§9.3 — a nested write carries the tenant (so the database default never decides it)', () => {
  beforeEach(async () => {
    await truncateAll();
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'keys-two', name: 'Keys Two' }, update: {} });
  });

  it('rows made by nested create, connectOrCreate and update-create land in the creating tenant', async () => {
    const client = await runWithTenant(T2, 'session', () =>
      appPrisma.client.create({ data: { name: 'Two Co', status: 'ACTIVE', locations: { create: [{ name: 'Two Site' }] } }, include: { locations: true } }),
    );
    expect(client.tenantId).toBe(T2);
    expect(client.locations.map((l) => l.tenantId)).toEqual([T2]);
    await runWithTenant(T2, 'session', () =>
      appPrisma.client.update({ where: { id: client.id }, data: { locations: { create: { name: 'Second Site' } } } }),
    );
    const sites = await prisma.site.findMany({ where: { clientId: client.id }, select: { tenantId: true } });
    expect(sites.map((s) => s.tenantId)).toEqual([T2, T2]);
    // A parent that names its tenant passes it down (a platform job writing for a tenant).
    const viaPlatform = await withPlatformScope(() =>
      appPrisma.client.create({ data: { tenantId: T2, name: 'Two Again', status: 'ACTIVE', locations: { create: { name: 'Two Again Site' } } }, include: { locations: true } }),
    );
    expect(viaPlatform.locations[0]!.tenantId).toBe(T2);
  });
});

describe('§5 — the jobs that ran outside any tenant now run inside one', () => {
  const saved = process.env.TENANCY_UNSCOPED;
  beforeEach(async () => {
    await truncateAll();
    await prisma.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'keys-two', name: 'Keys Two' }, update: {} });
    // As deployed: no fixture escape hatch, so a tenant-keyed query with no context throws.
    delete process.env.TENANCY_UNSCOPED;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TENANCY_UNSCOPED;
    else process.env.TENANCY_UNSCOPED = saved;
  });

  it('the idempotency sweep clears each tenant\'s expired records', async () => {
    process.env.TENANCY_UNSCOPED = 'platform';
    const old = new Date(Date.now() - 7 * 86_400_000);
    for (const tenantId of [T1, T2]) {
      await prisma.idempotencyRecord.create({ data: { tenantId, userId: '00000000-0000-4000-8000-0000000000aa', method: 'POST', path: '/x', key: `k-${tenantId}`, requestHash: 'h', createdAt: old } });
    }
    delete process.env.TENANCY_UNSCOPED;
    expect(await sweepIdempotencyRecords()).toBe(2);
  });

  it('the billing tick reads each tenant inside its own context', async () => {
    // The app's client (the tenant guard in enforce mode), as the timer runs it.
    await expect(runUsageSnapshots(appPrisma)).resolves.toBeGreaterThanOrEqual(0);
  });
});
