import { Prisma, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../db.js';
import { ALTO_TENANT_ID, runWithTenant, withPlatformScope } from '../../lib/tenant.js';
import { NULLABLE_TENANT_MODELS, PLATFORM_WIDE_MODELS, TENANT_SCOPED_MODELS } from '../../lib/tenantGuard.js';
import { prisma as owner, truncateAll } from '../../../test/db.js';

/**
 * Brief 2-1 §9.8 — the database wall, proven against Postgres itself.
 *
 *   The suite connects as a NON-OWNER role (the shape of `alto_app`,
 *   scripts/create-app-role.sql) with TENANCY_RLS=on and the application
 *   wall switched OFF (TENANCY_MODE=off), so nothing in the app narrows a
 *   query: whatever tenant B cannot see or touch here, the database refused.
 *
 *   The role is cluster-wide (roles are), granted only on this database's
 *   test schema. Its name is not the production one on purpose.
 */

const PROBE_ROLE = 'alto_rls_probe';
const PROBE_PASSWORD = 'rls-probe-test-only';
const T1 = ALTO_TENANT_ID;
const T2 = '22222222-2222-4222-8222-222222222222';

function probeUrl(): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  // A small pool: the suite's own two clients already hold connections.
  url.searchParams.set('connection_limit', '2');
  return url.toString();
}

const ENV_KEYS = ['TENANCY_RLS', 'TENANCY_MODE', 'TENANCY_UNSCOPED'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let probe: PrismaClient;
let schema: string;

async function ensureProbeRole(): Promise<void> {
  // Concurrent runs on other databases may create it at the same moment.
  await owner.$executeRawUnsafe(`DO $$
    BEGIN
      CREATE ROLE ${PROBE_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${PROBE_PASSWORD}';
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      ALTER ROLE ${PROBE_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PROBE_PASSWORD}';
    END $$`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO ${PROBE_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${PROBE_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${PROBE_ROLE}`);
}

interface World {
  a1: string;
  a2: string;
  c1: string;
  c2: string;
}

async function seed(): Promise<World> {
  await owner.tenant.upsert({ where: { id: T2 }, create: { id: T2, slug: 'rls-two', name: 'RLS Two' }, update: {} });
  const a1 = await owner.associate.create({ data: { tenantId: T1, firstName: 'One', lastName: 'Tenant', email: 'same@example.com' } });
  // Migration C: the same email may exist once per tenant.
  const a2 = await owner.associate.create({ data: { tenantId: T2, firstName: 'Two', lastName: 'Tenant', email: 'same@example.com' } });
  const c1 = await owner.client.create({ data: { tenantId: T1, name: 'Client One', status: 'ACTIVE' } });
  const c2 = await owner.client.create({ data: { tenantId: T2, name: 'Client Two', status: 'ACTIVE' } });
  await owner.timeEntry.create({ data: { tenantId: T1, associateId: a1.id, clientId: c1.id, clockInAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED', clockOutAt: new Date() } });
  await owner.timeEntry.create({ data: { tenantId: T2, associateId: a2.id, clientId: c2.id, clockInAt: new Date(Date.now() - 3_600_000), status: 'COMPLETED', clockOutAt: new Date() } });
  return { a1: a1.id, a2: a2.id, c1: c1.id, c2: c2.id };
}

describe('the database wall (row-level security as a non-owner role)', () => {
  let w: World;

  beforeAll(async () => {
    const [{ schema: s }] = await owner.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    schema = s;
    await ensureProbeRole();
    probe = createPrismaClient({ datasourceUrl: probeUrl() });
  });

  beforeEach(async () => {
    await truncateAll();
    w = await seed();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.TENANCY_RLS = 'on';
    // The application wall is OFF: only the database decides.
    process.env.TENANCY_MODE = 'off';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  afterAll(async () => {
    await probe?.$disconnect();
  });

  it('is enabled, not forced, on every tenant-scoped table, and only there', async () => {
    const rows = await owner.$queryRaw<Array<{ table: string; enabled: boolean; forced: boolean; policies: string[] }>>`
      SELECT c.relname AS "table", c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             COALESCE(array_agg(p.polname::text) FILTER (WHERE p.polname IS NOT NULL), '{}') AS policies
        FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
       WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
       GROUP BY 1, 2, 3`;
    const byTable = new Map(rows.map((r) => [r.table, r]));
    const tableOf = (model: string) => Prisma.dmmf.datamodel.models.find((m) => m.name === model)?.dbName ?? model;
    const missing: string[] = [];
    for (const model of TENANT_SCOPED_MODELS) {
      const r = byTable.get(tableOf(model));
      if (!r || !r.enabled || !r.policies.includes('tenant_isolation') || !r.policies.includes('platform_scope')) missing.push(model);
    }
    // A new tenant-keyed table needs, in its migration:
    //   SELECT alto_tenant_rls_policies('<Table>'); ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;
    expect(missing, 'tenant-scoped tables without the row-level security policies').toEqual([]);
    expect(rows.filter((r) => r.forced).map((r) => r.table), 'FORCE would wall the owner (migrations, the test harness) too').toEqual([]);
    for (const model of PLATFORM_WIDE_MODELS) expect(byTable.get(tableOf(model))?.enabled, `${model} is platform telemetry`).toBe(false);
    expect(byTable.get('Tenant')?.enabled).toBe(false);
    // The nullable models are a subset of the scoped ones plus the telemetry.
    for (const model of NULLABLE_TENANT_MODELS) expect(TENANT_SCOPED_MODELS.has(model) || PLATFORM_WIDE_MODELS.has(model)).toBe(true);
  });

  it('the probe really is a non-owner without BYPASSRLS', async () => {
    const [me] = await probe.$queryRaw<Array<{ who: string; superuser: boolean; bypass: boolean; owns: boolean }>>`
      SELECT current_user AS who, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
             pg_has_role(current_user, c.relowner, 'USAGE') AS owns
        FROM pg_roles r, pg_class c
       WHERE r.rolname = current_user AND c.oid = '"Associate"'::regclass`;
    expect(me).toEqual({ who: PROBE_ROLE, superuser: false, bypass: false, owns: false });
  });

  it('tenant two reads none of tenant one\'s rows: lists, lookups by id, counts, a transaction and a batch', async () => {
    await runWithTenant(T2, 'session', async () => {
      const people = await probe.associate.findMany({ select: { id: true, tenantId: true } });
      expect(people.map((p) => p.id)).toEqual([w.a2]);
      expect(await probe.associate.findUnique({ where: { id: w.a1 } })).toBeNull();
      expect(await probe.client.findFirst({ where: { id: w.c1 } })).toBeNull();
      expect(await probe.timeEntry.count()).toBe(1);
      expect(await probe.timeEntry.count({ where: { associateId: w.a1 } })).toBe(0);
      const inTx = await probe.$transaction(async (tx) => tx.associate.findMany({ select: { id: true } }));
      expect(inTx.map((p) => p.id)).toEqual([w.a2]);
      const [clients, entries] = await probe.$transaction([probe.client.findMany({ select: { id: true } }), probe.timeEntry.count()]);
      expect(clients.map((c) => c.id)).toEqual([w.c2]);
      expect(entries).toBe(1);
    });
    // And the other way round.
    await runWithTenant(T1, 'session', async () => {
      expect((await probe.associate.findMany({ select: { id: true } })).map((p) => p.id)).toEqual([w.a1]);
    });
  });

  it('tenant two cannot change, delete or plant a row in tenant one', async () => {
    await runWithTenant(T2, 'session', async () => {
      await expect(probe.associate.update({ where: { id: w.a1 }, data: { firstName: 'Hijacked' } })).rejects.toMatchObject({ code: 'P2025' });
      expect((await probe.associate.updateMany({ where: { id: w.a1 }, data: { firstName: 'Hijacked' } })).count).toBe(0);
      expect((await probe.timeEntry.deleteMany({ where: { associateId: w.a1 } })).count).toBe(0);
      await expect(probe.client.delete({ where: { id: w.c1 } })).rejects.toMatchObject({ code: 'P2025' });
      // WITH CHECK: a row written into another tenant is refused by the database.
      await expect(probe.associate.create({ data: { tenantId: T1, firstName: 'Planted', lastName: 'Row', email: 'planted@example.com' } })).rejects.toThrow(/row-level security/i);
      // Nor can tenant two move its own row into tenant one.
      await expect(probe.associate.update({ where: { id: w.a2 }, data: { tenantId: T1 } })).rejects.toThrow(/row-level security/i);
      // Its own rows are its to change.
      await probe.associate.update({ where: { id: w.a2 }, data: { firstName: 'Changed' } });
    });
    const one = await owner.associate.findUniqueOrThrow({ where: { id: w.a1 } });
    expect(one.firstName).toBe('One');
    expect(await owner.timeEntry.count({ where: { associateId: w.a1 } })).toBe(1);
    expect(await owner.client.count({ where: { id: w.c1 } })).toBe(1);
    expect(await owner.associate.count({ where: { email: 'planted@example.com' } })).toBe(0);
    expect((await owner.associate.findUniqueOrThrow({ where: { id: w.a2 } })).firstName).toBe('Changed');
  });

  it('raw SQL is walled the same way (the §4 paths that bypass the Prisma extension)', async () => {
    await runWithTenant(T2, 'session', async () => {
      const rows = await probe.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM "Associate" ORDER BY id`;
      expect(rows.map((r) => r.id)).toEqual([w.a2]);
      const hours = await probe.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "TimeEntry" WHERE "clockOutAt" IS NOT NULL`);
      expect(Number(hours[0]!.n)).toBe(1);
      expect(await probe.$executeRaw`UPDATE "Associate" SET "firstName" = 'Raw' WHERE id = ${w.a1}::uuid`).toBe(0);
    });
    expect((await owner.associate.findUniqueOrThrow({ where: { id: w.a1 } })).firstName).toBe('One');
  });

  it('the audited platform scope sees every tenant; a statement with no tenant at all sees nothing', async () => {
    const both = await withPlatformScope(() => probe.associate.findMany({ where: { id: { in: [w.a1, w.a2] } }, select: { id: true } }));
    expect(both.map((p) => p.id).sort()).toEqual([w.a1, w.a2].sort());
    delete process.env.TENANCY_UNSCOPED;
    expect(await probe.associate.count()).toBe(0);
    expect(await probe.$queryRaw<unknown[]>`SELECT id FROM "Client"`).toEqual([]);
    // With the flag off the probe still sends no tenant — the wall does not depend on the app being configured.
    process.env.TENANCY_RLS = 'off';
    expect(await probe.associate.count()).toBe(0);
  });

  it('shared rows: a platform release note and the platform agent switch are read by every tenant; another tenant\'s note is not', async () => {
    const platformNote = await owner.releaseNote.create({ data: { tenantId: null, day: new Date('2026-10-22'), items: [{ audience: 'ALL', en: 'For everyone' }], publishedAt: new Date() } });
    const oneNote = await owner.releaseNote.create({ data: { tenantId: T1, day: new Date('2026-10-22'), items: [{ audience: 'ALL', en: 'Tenant one only' }], publishedAt: new Date() } });
    await owner.agentControl.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', tenantId: T1, allSuspendedAt: new Date(), reason: 'drill' }, update: { allSuspendedAt: new Date() } });
    await runWithTenant(T2, 'session', async () => {
      const notes = await probe.releaseNote.findMany({ select: { id: true } });
      expect(notes.map((n) => n.id)).toEqual([platformNote.id]);
      expect(notes.map((n) => n.id)).not.toContain(oneNote.id);
      const sw = await probe.$queryRawUnsafe<Array<{ suspended: boolean }>>(`SELECT ("allSuspendedAt" IS NOT NULL) AS suspended FROM "AgentControl" WHERE id = 'singleton'`);
      expect(sw[0]?.suspended).toBe(true);
      // Reading is all: tenant two cannot lift the platform switch.
      expect(await probe.$executeRaw`UPDATE "AgentControl" SET "allSuspendedAt" = NULL WHERE id = 'singleton'`).toBe(0);
      // Nor write a platform-wide note.
      await expect(probe.releaseNote.create({ data: { tenantId: null, day: new Date('2026-10-22'), items: [], publishedAt: new Date() } })).rejects.toThrow(/row-level security/i);
    });
  });
});
