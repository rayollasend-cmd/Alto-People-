/**
 * Brief 3-6 — the scale seed: 50,000 workers across 1,000 sites, each with
 * a shift today, 2,000 of them with a login, on top of the base seed.
 * Opt-in (LOAD_SCALE=1) and for a scratch database only: it never runs in
 * the normal seed, the design walk or the E2E job. Deterministic ids from
 * the demo seed's PRNG; idempotent through an audit marker.
 *
 *   LOAD_SCALE=1 npx tsx scripts/load/seed-scale.ts
 */
import { prisma } from '../../src/db.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { hashDeviceToken, hmacPin, tokenLookupPrefix } from '../../src/lib/kioskAuth.js';
import { encryptString } from '../../src/lib/crypto.js';
import { LOAD_DEVICE_TOKEN, LOAD_KIOSKS, LOAD_PIN } from '../../src/lib/loadHarness.js';
import { Rng } from '../../src/lib/demoSeed.js';
import { ALTO_TENANT_ID } from '../../src/lib/tenant.js';
import { SCALE_ASSOCIATE_PASSWORD, SCALE_EMAIL, SCALE_MARKER_ACTION, SCALE_POSITION, SCALE_SITES, SCALE_USERS, SCALE_WORKERS } from './scale.js';

const CHUNK = 2_000;
const HOUR = 3_600_000;

async function chunked<T>(label: string, rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK));
  console.log(`[seed-scale]   ${label}: ${rows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function main(): Promise<void> {
  if (process.env.LOAD_SCALE !== '1') {
    console.error('[seed-scale] refusing to run: set LOAD_SCALE=1 (a scratch database only — never production, never the walk).');
    process.exit(2);
  }
  const marker = await prisma.auditLog.findFirst({ where: { action: SCALE_MARKER_ACTION }, select: { id: true } });
  if (marker) {
    console.log('[seed-scale] already seeded; nothing to do.');
    return;
  }
  const admin = await prisma.user.findFirst({ where: { role: 'HR_ADMINISTRATOR', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!admin) throw new Error('[seed-scale] no HR admin — run db:seed first.');
  const client = await prisma.client.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!client) throw new Error('[seed-scale] no client — run db:seed first.');

  const rng = new Rng(360_000);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const hire = new Date(today.getTime() - 120 * 24 * HOUR);
  const passwordHash = await hashPassword(SCALE_ASSOCIATE_PASSWORD);
  console.log(`[seed-scale] ${SCALE_WORKERS} workers across ${SCALE_SITES} sites, ${SCALE_USERS} with a login`);

  const siteIds: string[] = [];
  const sites = Array.from({ length: SCALE_SITES }, (_, i) => {
    const id = rng.uuid();
    siteIds.push(id);
    return {
      id,
      clientId: client.id,
      name: `Scale site ${String(i + 1).padStart(4, '0')}`,
      addressLine1: `${100 + i} Scale Rd`,
      city: 'Panama City Beach',
      state: 'FL',
      zip: '32413',
      timezone: 'America/Chicago',
      type: 'STORE' as const,
    };
  });
  await chunked('sites', sites, (c) => prisma.site.createMany({ data: c, skipDuplicates: true }));

  const associateIds: string[] = [];
  const workerIds: string[] = [];
  const associates = Array.from({ length: SCALE_WORKERS }, (_, i) => {
    const id = rng.uuid();
    associateIds.push(id);
    workerIds.push(rng.uuid());
    return {
      id,
      firstName: `Load${i}`,
      lastName: `Worker`,
      email: SCALE_EMAIL(i),
      employmentType: 'W2_EMPLOYEE' as const,
      hireDate: hire,
      city: 'Panama City Beach',
      state: 'FL',
      zip: '32413',
    };
  });
  await chunked('associates', associates, (c) => prisma.associate.createMany({ data: c, skipDuplicates: true }));

  const assignments = associateIds.map((associateId, i) => ({ associateId, locationId: siteIds[i % SCALE_SITES]!, startedAt: hire, reason: 'Scale seed', notedById: admin.id }));
  await chunked('assignments', assignments, (c) => prisma.associateAssignment.createMany({ data: c }));

  const workers = associateIds.map((associateId, i) => ({
    id: workerIds[i]!,
    tenantId: ALTO_TENANT_ID,
    type: 'PERSON' as const,
    name: `Load${i} Worker`,
    ownerUserId: admin.id,
    status: 'ACTIVE' as const,
    associateId,
    capabilities: [] as string[],
  }));
  await chunked('workers', workers, (c) => prisma.worker.createMany({ data: c, skipDuplicates: true }));

  const users = associateIds.slice(0, SCALE_USERS).map((associateId, i) => ({
    email: SCALE_EMAIL(i),
    passwordHash,
    role: 'ASSOCIATE' as const,
    status: 'ACTIVE' as const,
    associateId,
    language: 'en',
  }));
  await chunked('users', users, (c) => prisma.user.createMany({ data: c, skipDuplicates: true }));

  // Three shift starts across the day so the clock-in burst has a shift to
  // punch against whenever the test runs; the shift carries its worker so
  // the db.ts extension does not look up 50,000 rows one by one.
  const shifts = associateIds.map((associateId, i) => {
    const startHour = [6, 14, 22][i % 3]!;
    const startsAt = new Date(today.getTime() + startHour * HOUR - 6 * HOUR);
    return {
      id: rng.uuid(),
      clientId: client.id,
      locationId: siteIds[i % SCALE_SITES]!,
      position: SCALE_POSITION,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * HOUR),
      status: 'ASSIGNED' as const,
      assignedAssociateId: associateId,
      workerId: workerIds[i]!,
      publishedAt: new Date(today.getTime() - 14 * 24 * HOUR),
      createdById: admin.id,
    };
  });
  await chunked('shifts', shifts, (c) => prisma.shift.createMany({ data: c, skipDuplicates: true }));

  // The clock-in burst: one kiosk per site for the first LOAD_KIOSKS sites and
  // one PIN per kiosk (associate i works at site i), signed with the same
  // KIOSK_PIN_SECRET the API verifies with.
  const kioskCount = Math.min(LOAD_KIOSKS, SCALE_SITES, associateIds.length);
  await prisma.kioskDevice.createMany({
    data: Array.from({ length: kioskCount }, (_, i) => ({
      clientId: client.id,
      locationId: siteIds[i]!,
      name: `Load kiosk ${i}`,
      tokenHash: hashDeviceToken(LOAD_DEVICE_TOKEN(i)),
      tokenPrefix: tokenLookupPrefix(LOAD_DEVICE_TOKEN(i)),
      tokenExpiresAt: new Date(Date.now() + 365 * 86_400_000),
      createdById: admin.id,
    })),
    skipDuplicates: true,
  });
  await prisma.kioskPin.createMany({
    data: Array.from({ length: kioskCount }, (_, i) => ({
      associateId: associateIds[i]!,
      clientId: client.id,
      pinHmac: hmacPin(LOAD_PIN(i)),
      pinEncrypted: encryptString(LOAD_PIN(i)),
      createdById: admin.id,
    })),
    skipDuplicates: true,
  });
  console.log(`[seed-scale] kiosks: ${kioskCount} (one PIN each)`);

  await prisma.auditLog.create({ data: { action: SCALE_MARKER_ACTION, entityType: 'Tenant', entityId: ALTO_TENANT_ID, actorUserId: admin.id, metadata: { workers: SCALE_WORKERS, sites: SCALE_SITES, users: SCALE_USERS } } });
  console.log('[seed-scale] complete');
}

main()
  .catch((err) => {
    console.error('[seed-scale] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
