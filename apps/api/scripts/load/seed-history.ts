/**
 * seed-history — a tenant at enterprise size WITH a month of history, for the
 * payroll and time scenarios (scripts/load/seed-scale.ts seeds one shift
 * today per worker; payroll preview needs approved time to chew on).
 *
 *   50 clients × 10 stores = 500 stores, 50,000 workers placed across them,
 *   30 days of shifts (about three a week each) with the matching time
 *   entries, plus an HR admin to sign in as.
 *
 * It writes ONLY to the database named in SCALE_DATABASE_URL, and refuses
 * any URL that isn't an `alto_scale` database — never alto_dev, never the
 * test schema.
 *
 *   SCALE_DATABASE_URL=postgresql://alto:alto_dev@localhost:5432/alto_scale?schema=public \
 *     npx tsx scripts/load/seed-history.ts [--workers 50000] [--stores 500] [--days 30]
 *
 * Re-running wipes ALL shifts, time entries and placements in that database
 * first (it only ever runs against alto_scale) so numbers
 * compare run to run.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../src/lib/passwords.js';

const url = process.env.SCALE_DATABASE_URL;
if (!url || !/\/alto_scale(\?|$)/.test(url)) {
  console.error('seed-history: SCALE_DATABASE_URL must point at the alto_scale database.');
  process.exit(1);
}

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const WORKERS = arg('workers', 50_000);
const STORES = arg('stores', 500);
const DAYS = arg('days', 30);
const CLIENTS = Math.max(1, Math.round(STORES / 10));
const BATCH = 5_000;

const db = new PrismaClient({ datasources: { db: { url } } });
const TENANT = '00000000-0000-4000-8000-000000000001';

const FIRST = ['Ana', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Lea', 'Max', 'Nia', 'Oli', 'Pia', 'Quin', 'Rae', 'Sam', 'Tia'];
const LAST = ['Lopez', 'Nguyen', 'Smith', 'Patel', 'Garcia', 'Kim', 'Brown', 'Diaz', 'Okafor', 'Rossi', 'Haddad', 'Silva', 'Novak', 'Cohen', 'Ito'];

async function inBatches<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>, label: string) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await write(rows.slice(i, i + BATCH));
    if (process.stdout.isTTY) process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`);
  }
  console.log(`${process.stdout.isTTY ? '\r' : ''}  ${label}: ${rows.length.toLocaleString()}`);
}

async function main() {
  const t0 = Date.now();
  console.log(`seed-history → ${WORKERS.toLocaleString()} workers, ${STORES} stores, ${CLIENTS} clients, ${DAYS} days`);

  // Start clean: the scale tenant's people and their work (cascades take the rest).
  await db.$executeRawUnsafe('TRUNCATE "TimeEntry", "Shift", "AssociateAssignment" CASCADE');
  await db.user.deleteMany({ where: { email: { endsWith: '@scale.test' } } });
  await db.associate.deleteMany({ where: { email: { endsWith: '@scale.test' } } });
  await db.client.deleteMany({ where: { name: { startsWith: 'Scale Client ' } } });

  const region = await db.region.upsert({ where: { id: '11111111-1111-4111-8111-000000000001' }, create: { id: '11111111-1111-4111-8111-000000000001', name: 'Scale Region', tenantId: TENANT }, update: {} });

  const clients = await db.client.createManyAndReturn({
    data: Array.from({ length: CLIENTS }, (_, i) => ({ name: `Scale Client ${i + 1}`, tenantId: TENANT })),
    select: { id: true },
  });
  const sites = await db.site.createManyAndReturn({
    data: Array.from({ length: STORES }, (_, i) => ({
      name: `Store ${i + 1}`,
      clientId: clients[i % clients.length]!.id,
      regionId: region.id,
      tenantId: TENANT,
      timezone: 'America/Chicago',
      state: 'FL',
    })),
    select: { id: true, clientId: true },
  });
  console.log(`  ${clients.length} clients, ${sites.length} stores`);

  const people = Array.from({ length: WORKERS }, (_, i) => ({
    firstName: FIRST[i % FIRST.length]!,
    lastName: `${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`,
    email: `worker${i}@scale.test`,
    tenantId: TENANT,
    state: 'FL',
  }));
  const ids: string[] = [];
  await inBatches(people, async (chunk) => {
    const made = await db.associate.createManyAndReturn({ data: chunk, select: { id: true } });
    ids.push(...made.map((m) => m.id));
  }, 'workers');

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - DAYS);
  await inBatches(
    ids.map((associateId, i) => ({ associateId, locationId: sites[i % sites.length]!.id, startedAt: start, tenantId: TENANT })),
    (chunk) => db.associateAssignment.createMany({ data: chunk }),
    'placements',
  );

  // About three shifts a week each, past and coming, with time entries for the past ones.
  const shifts: Array<{ clientId: string | null; locationId: string; position: string; startsAt: Date; endsAt: Date; status: 'ASSIGNED' | 'COMPLETED'; assignedAssociateId: string; tenantId: string }> = [];
  const entries: Array<{ associateId: string; clientId: string | null; clockInAt: Date; clockOutAt: Date; status: 'APPROVED'; tenantId: string }> = [];
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    const site = sites[i % sites.length]!;
    for (let d = i % 2; d < DAYS + 7; d += 2 + (i % 2)) {
      const s = new Date(start.getTime() + d * 86_400_000 + (13 + (i % 4)) * 3_600_000);
      const e = new Date(s.getTime() + 8 * 3_600_000);
      const past = e.getTime() < now;
      shifts.push({ clientId: site.clientId, locationId: site.id, position: 'Associate', startsAt: s, endsAt: e, status: past ? 'COMPLETED' : 'ASSIGNED', assignedAssociateId: ids[i]!, tenantId: TENANT });
      if (past) entries.push({ associateId: ids[i]!, clientId: site.clientId, clockInAt: s, clockOutAt: e, status: 'APPROVED', tenantId: TENANT });
    }
  }
  await inBatches(shifts, (chunk) => db.shift.createMany({ data: chunk }), 'shifts');
  await inBatches(entries, (chunk) => db.timeEntry.createMany({ data: chunk }), 'time entries');

  await db.user.create({
    data: { email: 'hr@scale.test', passwordHash: await hashPassword('scale-load-test'), role: 'HR_ADMINISTRATOR', status: 'ACTIVE', tenantId: TENANT },
  });
  await db.$executeRawUnsafe('ANALYZE');
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s — sign in as hr@scale.test / scale-load-test`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
