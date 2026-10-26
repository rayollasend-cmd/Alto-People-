/**
 * The rolling demo refresh: one consistent, believable story on a dev or
 * demo database, re-anchored on today every time it runs.
 *
 *   npm -w apps/api run db:seed:refresh            (after db:seed, seed-demo-shifts and db:seed:analytics)
 *
 * The base seed makes the personas, the analytics seed a year of history at
 * Front Beach 218 and the Seaside store. This layer keeps that world alive:
 *
 * - Clean-up: test leftovers a browser spec or a one-off session left in the
 *   shared dev database (the "Tess Member…" hires and their Grand Hotel
 *   sites, a temporary pay schedule, an unfinished invite), hard-deleted
 *   with everything that hangs off them.
 * - People: every account with a name; the manager with a person record and
 *   a team; every crew member employed, placed, paid by the hour, on the
 *   company pay schedule; two new Coastal stores in the region.
 * - The schedule: published shifts from 8 days back to 14 ahead (and history
 *   back to each person's start where the analytics seed left none), staffed
 *   to each store's contract, confirmed by most; punches for every shift that
 *   has started (late now and then, a rare no-show), approved the morning
 *   after; people on the floor right now.
 * - Payroll: every period whose payday has passed is run, reviewed, signed,
 *   paid, its taxes accrued, deposited and booked — the same functions the
 *   app runs after a real disbursement. The period that just closed is left
 *   for finance to run.
 * - Compliance, transport, the client's desk, store operations, tasks, help
 *   articles, programs, the season plan, cost centers and release notes.
 *
 * Idempotent: every row this script creates has an id derived from what it
 * is (prefix da7a7011-), so a second run on the same day changes nothing and
 * a run on a later day only adds the new days and settles the ones that
 * passed. Never production: it refuses NODE_ENV=production and any database
 * host that is not this machine or the docker network, unless
 * DEMO_REFRESH_ALLOW_HOST=1 is set on purpose.
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Prisma, type PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';

// apps/api/.env, as the server reads it (a DATABASE_URL already set wins).
loadDotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

if (process.env.NODE_ENV === 'production') {
  console.error('[demo-refresh] refusing to run with NODE_ENV=production.');
  process.exit(2);
}
{
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  if (!['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host) && process.env.DEMO_REFRESH_ALLOW_HOST !== '1') {
    console.error(`[demo-refresh] refusing to run against database host "${host || '?'}": this is demo data for a local or demo database only.`);
    process.exit(2);
  }
}
// Scripts run outside a request: the tenancy guard lets them through unnarrowed
// only when told so; every query below still runs inside Alto HR's context.
process.env.TENANCY_UNSCOPED ??= 'platform';

const { prisma } = await import('../src/db.js');
const { ALTO_TENANT_ID, runWithTenant } = await import('../src/lib/tenant.js');
const { utcInstantOfLocalMidnight } = await import('../src/lib/timeAnomalies.js');
const { ATTENDANCE_POINTS } = await import('../src/lib/attendance.js');
const { ensurePersonWorkers } = await import('../src/lib/workers.js');
const { withMandatoryTasks } = await import('../src/lib/checklistTasks.js');
const { openEmployment } = await import('../src/lib/employment.js');
const { aggregateAndPersistRun } = await import('../src/routes/payroll.js');
const { preloadPayrollTaxConfig } = await import('../src/lib/payrollTax.js');
const { buildPayrollReview, signPayrollReview } = await import('../src/lib/payrollReview.js');
const { postPayrollRun } = await import('../src/lib/books/posting/payroll.js');
const { afterRunSettled } = await import('../src/lib/payrollSettled.js');
const { createPayment, markPaymentPaid } = await import('../src/lib/payrollTaxLedger.js');
const { computeStatementSnapshot } = await import('../src/lib/clientStatement.js');
const { encryptString } = await import('../src/lib/crypto.js');
const { accountFingerprint } = await import('../src/lib/financialChanges.js');
const { ATTESTATION_CONFIGS, periodForNow } = await import('../src/lib/manualAttestation.js');
const { createOpsShift } = await import('../src/lib/storeShiftSop.js');
const { createPlan } = await import('../src/lib/seasonPlanner.js');
const { autoAssign, recordEvent } = await import('../src/lib/tasks/engine.js');
const { signRideAuthorization } = await import('../src/lib/rideAuthorization.js');

type Db = PrismaClient;
const db = prisma as unknown as Db;

// ---------------------------------------------------------------------------
// Time and ids
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Today, or (to rehearse a later day's refresh on a scratch copy) DEMO_REFRESH_NOW. */
const NOW = process.env.DEMO_REFRESH_NOW ? new Date(process.env.DEMO_REFRESH_NOW) : new Date();
const PREFIX = 'da7a7011';
/** Every id this script writes, as a range a uuid column can be filtered by. */
const MINE = { gte: `${PREFIX}-0000-0000-0000-000000000000`, lte: `${PREFIX}-ffff-ffff-ffff-ffffffffffff` };
/** How far back a store's schedule is filled where nobody has worked yet. */
const HISTORY_FILL_DAYS = 70;
const PAST_DAYS = 8;
const AHEAD_DAYS = 14;
/** Punches closed longer ago than this were approved by the store's supervisor (the morning after). */
const APPROVE_AFTER = 16 * HOUR;

const pad = (n: number) => String(n).padStart(2, '0');
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function keyIn(d: Date, tz: string): string {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(tz, f);
  }
  return f.format(d);
}
function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (key: string) => new Date(`${key}T12:00:00.000Z`).getUTCDay();
const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * MIN);
const minDate = (...ds: Date[]) => new Date(Math.min(...ds.map((d) => d.getTime())));
const maxDate = (...ds: Date[]) => new Date(Math.max(...ds.map((d) => d.getTime())));
/** The instant a zone's wall clock reads `minute` minutes after midnight on `key` (right across a DST change). */
function wallToUtc(key: string, minute: number, tz: string): Date {
  const midnight = utcInstantOfLocalMidnight(key, tz);
  const guess = new Date(midnight.getTime() + minute * MIN);
  // The wall clock at the guess; if a DST change happened since midnight, move by the difference.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(guess);
  const wall = Number(parts.find((x) => x.type === 'hour')!.value) * 60 + Number(parts.find((x) => x.type === 'minute')!.value);
  const want = minute % (24 * 60);
  let diff = want - wall;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return new Date(guess.getTime() + diff * MIN);
}

/** The org week (Saturday to Friday) a day belongs to, by its Saturday. */
function weekOf(key: string): string {
  const wd = weekdayOf(key);
  return addDays(key, -((wd + 1) % 7));
}

/** A stable uuid for a thing this script makes: same input, same id. */
function sid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${PREFIX}-${h.slice(0, 4)}-4${h.slice(5, 8)}-8${h.slice(9, 12)}-${h.slice(12, 24)}`;
}
/** A stable fraction in [0, 1) for a key. */
function frac(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}
const pickBy = <T>(key: string, list: readonly T[]): T => list[Math.floor(frac(key) * list.length)]!;
const intBy = (key: string, min: number, max: number) => min + Math.floor(frac(key) * (max - min + 1));

const counts: Record<string, number> = {};
const count = (k: string, n = 1) => {
  if (n) counts[k] = (counts[k] ?? 0) + n;
};
const log = (msg: string) => console.log(`[demo-refresh] ${msg}`);

// ---------------------------------------------------------------------------
// The story's cast and places
// ---------------------------------------------------------------------------

/** Pay and bill per hour by position (the analytics seed's table; every rate at or above Florida's minimum). */
const RATES: Record<string, { pay: number; bill: number }> = {
  'Shift Lead': { pay: 18, bill: 24.24 },
  'Overnight stocker': { pay: 17, bill: 23.8 },
  'Deli associate': { pay: 16, bill: 22.4 },
  Stocker: { pay: 15.5, bill: 21.7 },
  'Produce associate': { pay: 15.5, bill: 21.7 },
  Cashier: { pay: 15, bill: 21.21 },
  'GM floor associate': { pay: 15, bill: 21.21 },
};
const LEAD = 'Shift Lead';
const AREAS: Record<string, string[]> = {
  'Shift Lead': ['Front end', 'GM floor'],
  'Overnight stocker': ['Grocery aisles', 'Receiving'],
  'Deli associate': ['Deli'],
  Stocker: ['Receiving', 'Grocery aisles'],
  'Produce associate': ['Produce'],
  Cashier: ['Front end', 'Registers'],
  'GM floor associate': ['GM floor'],
};

type WindowLabel = 'Morning' | 'Afternoon' | 'Overnight';
const WINDOW: Record<WindowLabel, { start: number; end: number }> = {
  Morning: { start: 6 * 60, end: 14 * 60 },
  Afternoon: { start: 14 * 60, end: 22 * 60 },
  Overnight: { start: 22 * 60, end: 6 * 60 },
};

interface CrewSpec {
  name: string;
  window: WindowLabel;
  position: string;
  role?: 'lead' | 'backup';
  /** A person this script hires (the others exist already). */
  hire?: { email: string; phone: string; dob: string; lang?: 'en' | 'es' | 'tr' };
}
interface StoreSpec {
  key: string;
  /** Found by one of these names; the first is what it is called. */
  names: string[];
  clientName: string;
  create?: { addressLine1: string; city: string; zip: string; timezone: string; openedDaysAgo: number };
  rename?: { addressLine1: string; city: string; zip: string };
  inRegion: boolean;
  targets: Partial<Record<WindowLabel, number>>;
  crew: CrewSpec[];
  supervisorEmail: string;
}

const STORES: StoreSpec[] = [
  {
    key: 'front-beach',
    names: ['Front Beach 218'],
    clientName: 'Coastal Resort Holdings',
    inRegion: true,
    targets: { Morning: 5, Afternoon: 3, Overnight: 2 },
    supervisorEmail: 'dana.reyes@altohr.com',
    crew: [
      { name: 'Denise Whitaker', window: 'Morning', position: LEAD, role: 'lead' },
      { name: 'Malik Jenkins', window: 'Morning', position: 'Cashier', role: 'backup' },
      { name: 'Carlos Mendoza', window: 'Morning', position: 'Stocker' },
      { name: 'Hannah Kowalski', window: 'Morning', position: 'Deli associate' },
      { name: 'Jean-Baptiste Pierre', window: 'Morning', position: 'Produce associate' },
      { name: 'Tamika Freeman', window: 'Morning', position: 'Cashier' },
      { name: 'Maria Lopez', window: 'Morning', position: 'Cashier' },
      { name: 'Brianna Hayes', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Kayla Robinson', window: 'Afternoon', position: 'Cashier' },
      { name: 'Luis Ortega', window: 'Afternoon', position: 'Cashier' },
      { name: 'Mehmet Yılmaz', window: 'Afternoon', position: 'Deli associate' },
      { name: 'Pat Nguyen', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Kendra Toussaint', window: 'Afternoon', position: 'Cashier' },
      { name: 'Marcus Bell', window: 'Overnight', position: 'Overnight stocker' },
      { name: 'Oleksandr Bondar', window: 'Overnight', position: 'Overnight stocker' },
      { name: 'Tyler Alvarez', window: 'Overnight', position: 'Overnight stocker' },
    ],
  },
  {
    key: 'tallahassee',
    names: ['Seaside Grand · Tallahassee', 'Demo Store'],
    clientName: 'Seaside Hospitality Group',
    rename: { addressLine1: '101 S Monroe St', city: 'Tallahassee', zip: '32301' },
    inRegion: false,
    targets: { Morning: 3, Afternoon: 2 },
    supervisorEmail: 'workforce@altohr.com',
    crew: [
      { name: 'Yolanda Castillo', window: 'Morning', position: LEAD, role: 'lead' },
      { name: 'Sofia Ramírez', window: 'Morning', position: 'Cashier', role: 'backup' },
      { name: 'Alejandro Herrera', window: 'Morning', position: 'Cashier' },
      { name: 'Andre Baptiste', window: 'Morning', position: 'Stocker' },
      { name: 'Lucía Ferreira', window: 'Morning', position: 'Stocker', hire: { email: 'lucia.ferreira@example.com', phone: '+1-850-555-4103', dob: '1999-04-17', lang: 'es' } },
      { name: 'Andrea Soto', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Darnell Price', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Kendra Coleman', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Kevin Tran', window: 'Afternoon', position: 'GM floor associate' },
      { name: 'Valentina Cruz', window: 'Afternoon', position: 'Cashier' },
    ],
  },
  {
    key: 'thomas-drive',
    names: ['Thomas Drive 412'],
    clientName: 'Coastal Resort Holdings',
    create: { addressLine1: '5601 Thomas Dr', city: 'Panama City Beach', zip: '32408', timezone: 'America/Chicago', openedDaysAgo: 49 },
    inRegion: true,
    targets: { Morning: 3 },
    supervisorEmail: 'dana.reyes@altohr.com',
    crew: [
      { name: 'Gerodney Lee', window: 'Morning', position: LEAD, role: 'lead' },
      { name: 'Aaliyah Brooks', window: 'Morning', position: 'Cashier', role: 'backup' },
      { name: 'Jay Patel', window: 'Morning', position: 'Stocker' },
      { name: 'Leo Ramos', window: 'Morning', position: 'Cashier' },
      { name: 'Grace Holloway', window: 'Morning', position: 'Stocker', hire: { email: 'grace.holloway@example.com', phone: '+1-850-555-4101', dob: '1996-08-02' } },
    ],
  },
  {
    key: 'destin-harbor',
    names: ['Destin Harbor 507'],
    clientName: 'Coastal Resort Holdings',
    create: { addressLine1: '10 Harbor Blvd', city: 'Destin', zip: '32541', timezone: 'America/Chicago', openedDaysAgo: 49 },
    inRegion: true,
    targets: { Morning: 3 },
    supervisorEmail: 'dana.reyes@altohr.com',
    crew: [
      { name: 'Rosa Vega', window: 'Morning', position: LEAD, role: 'lead' },
      { name: 'Kim Nguyen', window: 'Morning', position: 'Cashier', role: 'backup' },
      { name: 'Tomas Ortiz', window: 'Morning', position: 'Stocker' },
      { name: 'Nia Carter', window: 'Morning', position: 'Deli associate' },
      { name: 'Mateo Salinas', window: 'Morning', position: 'Cashier', hire: { email: 'mateo.salinas@example.com', phone: '+1-850-555-4102', dob: '2001-11-23', lang: 'es' } },
    ],
  },
];

/** Accounts that read as a person, not an email. */
const DISPLAY_NAMES: Record<string, string> = {
  'maria.lopez@example.com': 'Maria Lopez',
  'dana.reyes@altohr.com': 'Dana Reyes',
  'floor.demo@altohr.com': 'Marcus Hill',
  'transport@altohr.com': 'Tasha Grant',
  'driver@altohr.com': 'Mike Chen',
  'aaliyah.brooks@example.com': 'Aaliyah Brooks',
  'kim.nguyen@example.com': 'Kim Nguyen',
  'portal@coastalresort.example': 'Lauren Whitfield',
  'region@coastalresort.example': 'Victor Alvarez',
};

/** The manager persona's person record, and who reports to them. */
const MANAGER = { email: 'manager@altohr.com', associateEmail: 'priya.shah@altohr.com', first: 'Priya', last: 'Shah', phone: '+1-850-555-0190' };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface StoreRow {
  spec: StoreSpec;
  id: string;
  clientId: string;
  tz: string;
  openedKey: string;
}
interface Person {
  id: string;
  name: string;
  spec: CrewSpec;
  store: StoreRow;
  startKey: string;
  offDays: [number, number];
  /** First day this script may schedule them (the day after anyone else last scheduled them). */
  genFrom: string;
  userId: string | null;
}

async function user(email: string) {
  return db.user.findUnique({ where: { email }, select: { id: true, role: true, associateId: true, clientId: true, locationId: true, regionId: true, displayName: true } });
}

// ---------------------------------------------------------------------------
// 1. Clean-up: what tests and one-off sessions left in the shared database
// ---------------------------------------------------------------------------

type FkRef = { table: string; column: string; rule: string };
const fkCache = new Map<string, FkRef[]>();
async function referencing(table: string): Promise<FkRef[]> {
  const hit = fkCache.get(table);
  if (hit) return hit;
  const rows = await db.$queryRawUnsafe<Array<{ tbl: string; col: string; rule: string }>>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype::text AS rule
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1`,
    `"${table}"`,
  );
  const out = rows.map((r) => ({ table: r.tbl.replace(/"/g, ''), column: r.col, rule: r.rule }));
  fkCache.set(table, out);
  return out;
}

/**
 * Delete rows and everything that cannot outlive them. Cascading and
 * nulling foreign keys the database handles; a restricting one is followed
 * down first. Only ever called with ids this script found as test leftovers.
 */
async function purge(tx: Prisma.TransactionClient, table: string, ids: string[], depth = 0): Promise<number> {
  if (ids.length === 0) return 0;
  if (depth > 8) throw new Error(`[demo-refresh] purge went too deep at ${table}`);
  for (const ref of await referencing(table)) {
    if (ref.rule !== 'r' && ref.rule !== 'a') continue;
    if (ref.table === table && ref.column === 'id') continue;
    const children = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM "${ref.table}" WHERE "${ref.column}"::text = ANY($1::text[])`, ids);
    await purge(tx, ref.table, children.map((c) => c.id).filter((c) => !ids.includes(c)), depth + 1);
  }
  const n = await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id::text = ANY($1::text[])`, ids);
  count(`purged ${table}`, n);
  return n;
}

async function cleanUp(): Promise<void> {
  // The hotel journey's hires: "Tess Member<stamp>", tess.member.<stamp>@example.com.
  const tess = await db.associate.findMany({ where: { OR: [{ email: { startsWith: 'tess.member.' } }, { lastName: { startsWith: 'Member' }, firstName: 'Tess' }] }, select: { id: true, email: true } });
  // An invite a recruiter-flow session made and never finished.
  const strays = await db.associate.findMany({ where: { email: { in: ['ana.reyes.hirepay@example.com'] } }, select: { id: true, email: true } });
  const people = [...tess, ...strays];
  const peopleIds = people.map((p) => p.id);
  const users = await db.user.findMany({ where: { OR: [{ associateId: { in: peopleIds } }, { email: { in: people.map((p) => p.email) } }] }, select: { id: true } });
  // The hotel journey's client-less "The Grand Hotel" sites in this tenant, its "Gulf Coast" regions, and its open shifts.
  const sites = await db.site.findMany({ where: { tenantId: ALTO_TENANT_ID, name: 'The Grand Hotel', clientId: null }, select: { id: true } });
  const siteIds = sites.map((s) => s.id);
  const orgUnits = await db.orgUnit.findMany({ where: { tenantId: ALTO_TENANT_ID, name: 'Gulf Coast' }, select: { id: true } });
  // A pay schedule a screenshot session made and only soft-deleted.
  const schedules = await db.payrollSchedule.findMany({ where: { name: { startsWith: 'ZZ ' } }, select: { id: true } });
  // Shifts the first demo-shift seed and test sessions left: "Demo: …" rows and a stray housekeeping shift on Maria.
  const strayShifts = await db.shift.findMany({
    where: { OR: [{ position: { startsWith: 'Demo:' } }, { locationId: { in: siteIds } }, { position: 'Housekeeper', assignedAssociate: { email: 'maria.lopez@example.com' } }], timeEntries: { none: {} } },
    select: { id: true },
  });
  // A payroll run with a header and no paychecks (the "totals disagree" banner) — rebuilt below from real punches.
  const emptyRuns = await db.payrollRun.findMany({ where: { status: 'DISBURSED', items: { none: {} } }, select: { id: true } });
  // Old placeholder statements (flat $2,880 a week whatever was worked) — rebuilt below from approved time.
  const oldStatements = await db.clientStatement.findMany({ where: { NOT: { id: MINE } }, select: { id: true } });

  // Store-ops checklists opened weeks ago and closed by the never-closed sweep long after (abandoned test runs).
  const abandonedOps = (await db.opsShift.findMany({ where: { NOT: { id: MINE }, closedAt: { not: null }, openedAt: { lt: new Date(NOW.getTime() - 14 * DAY) } }, select: { id: true, openedAt: true, closedAt: true } })).filter((o) => o.closedAt!.getTime() - o.openedAt.getTime() > 2 * DAY);
  // Their roster rows (a worker keeps the name after its person is gone).
  const workers = await db.worker.findMany({ where: { type: 'PERSON', OR: [{ associateId: { in: peopleIds } }, { associateId: null, OR: [{ name: { startsWith: 'Tess Member' } }, { name: 'Ana Reyes-Montgomery' }] }] }, select: { id: true } });
  const total = workers.length + abandonedOps.length + peopleIds.length + siteIds.length + schedules.length + strayShifts.length + emptyRuns.length + oldStatements.length + orgUnits.length;
  if (total === 0) return;
  await db.$transaction(
    async (tx) => {
      // The bell rows about them.
      const bell = await tx.notification.deleteMany({ where: { OR: [{ subject: { contains: 'Tess Member' } }, { body: { contains: 'Tess Member' } }, { subject: { contains: 'Ana Reyes-Montgomery' } }, { body: { contains: 'Ana Reyes-Montgomery' } }] } });
      count('purged Notification', bell.count);
      await purge(tx, 'Shift', strayShifts.map((s) => s.id));
      await purge(tx, 'User', users.map((u) => u.id));
      await purge(tx, 'Worker', workers.map((w) => w.id));
      await purge(tx, 'Associate', peopleIds);
      await purge(tx, 'Location', siteIds);
      await purge(tx, 'OrgUnit', orgUnits.map((o) => o.id));
      await purge(tx, 'PayrollSchedule', schedules.map((s) => s.id));
      await purge(tx, 'PayrollRun', emptyRuns.map((r) => r.id));
      await purge(tx, 'ClientStatement', oldStatements.map((s) => s.id));
      await purge(tx, 'OpsShift', abandonedOps.map((o) => o.id));
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  log(`cleaned up ${people.length} test people, ${siteIds.length} test sites, ${strayShifts.length} stray shifts, ${schedules.length} temporary schedule(s), ${emptyRuns.length} empty run(s).`);
}

// ---------------------------------------------------------------------------
// 2. Accounts with names, the analytics crew's addresses, a healthy Payouts card
// ---------------------------------------------------------------------------

async function accountsAndHygiene(adminId: string): Promise<void> {
  for (const [email, displayName] of Object.entries(DISPLAY_NAMES)) {
    const n = await db.user.updateMany({ where: { email, OR: [{ displayName: null }, { displayName: '' }] }, data: { displayName } });
    count('displayNames', n.count);
  }

  // The analytics crew and candidates had test-looking addresses; the rest of
  // the cast are first.last@example.com, so they are too.
  const oldDomain = '@analytics-demo.altohr.example';
  const assoc = await db.$executeRawUnsafe(`UPDATE "Associate" SET email = replace(email, $1, '@example.com') WHERE email LIKE $2 AND NOT EXISTS (SELECT 1 FROM "Associate" b WHERE b."tenantId" = "Associate"."tenantId" AND b.email = replace("Associate".email, $1, '@example.com'))`, oldDomain, `%${oldDomain}`);
  const cand = await db.$executeRawUnsafe(`UPDATE "Candidate" SET email = replace(email, $1, '@example.com') WHERE email LIKE $2 AND NOT EXISTS (SELECT 1 FROM "Candidate" b WHERE b."tenantId" = "Candidate"."tenantId" AND b.email = replace("Candidate".email, $1, '@example.com'))`, oldDomain, `%${oldDomain}`);
  count('emailsRenamed', assoc + cand);

  // Careers-page links that read like a test fixture ("analytics-demo-…-demo-store").
  for (const j of await db.jobPosting.findMany({ where: { slug: { startsWith: 'analytics-demo-' } }, select: { id: true, slug: true } })) {
    const slug = j.slug.replace(/^analytics-demo-/, '').replace(/-demo-store$/, '-seaside-grand-tallahassee');
    if (!(await db.jobPosting.findFirst({ where: { slug }, select: { id: true } }))) await db.jobPosting.update({ where: { id: j.id }, data: { slug } });
  }

  // Payouts (Wise): a demo connection that answers, not one failing since a test token expired.
  const wise = await db.providerConnection.updateMany({
    where: { kind: 'PAYOUT', provider: 'WISE' },
    data: { lastError: null, lastErrorAt: null, lastSuccessAt: new Date(NOW.getTime() - 47 * MIN), lastTestAt: new Date(NOW.getTime() - 3 * HOUR), lastTestOk: true },
  });
  count('providersHealthy', wise.count);
  // Every integration answered recently (a demo database has no live vendor to ask).
  await db.providerConnection.updateMany({ where: { active: true, lastError: null }, data: { lastSuccessAt: new Date(NOW.getTime() - 2 * HOUR) } });

  // The bell: hundreds of weeks-old automatic reminders read as a backlog
  // nobody works. Anything older than two days was seen.
  const read = await db.notification.updateMany({ where: { readAt: null, createdAt: { lt: new Date(NOW.getTime() - 2 * DAY) } }, data: { readAt: new Date(NOW.getTime() - DAY) } });
  count('notificationsMarkedRead', read.count);

  // Shifts that were left running for weeks (a punch nobody closed) end with their shift.
  const stale = await db.timeEntry.findMany({ where: { status: 'ACTIVE', clockInAt: { lt: new Date(NOW.getTime() - 16 * HOUR) }, OR: [{ shiftId: null }, { NOT: { shiftId: MINE } }] }, select: { id: true, clockInAt: true, shift: { select: { endsAt: true } } } });
  for (const e of stale) {
    const out = e.shift?.endsAt && e.shift.endsAt > e.clockInAt ? e.shift.endsAt : new Date(e.clockInAt.getTime() + 8 * HOUR);
    await db.timeEntry.update({ where: { id: e.id }, data: { clockOutAt: out, status: 'APPROVED', approvedById: adminId, approvedAt: new Date(out.getTime() + 20 * HOUR) } });
  }
  count('staleActivePunchesClosed', stale.length);
}

// ---------------------------------------------------------------------------
// 3. Stores: the region's two new Coastal stores, contracts, positions, rate cards
// ---------------------------------------------------------------------------

async function ensureStores(adminId: string, todayKey: string): Promise<StoreRow[]> {
  const region = await db.region.findFirst({ where: { name: 'Florida Panhandle', deletedAt: null }, select: { id: true } });
  const out: StoreRow[] = [];
  let regionOrgUnit: string | null = null;
  for (const spec of STORES) {
    const client = await db.client.findFirst({ where: { name: spec.clientName, deletedAt: null }, select: { id: true } });
    if (!client) throw new Error(`[demo-refresh] client "${spec.clientName}" is missing — run db:seed first.`);
    let site = await db.site.findFirst({ where: { clientId: client.id, name: { in: spec.names }, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    if (!site && spec.create) {
      const opened = new Date(utcInstantOfLocalMidnight(addDays(todayKey, -spec.create.openedDaysAgo), spec.create.timezone).getTime() + 9 * HOUR);
      site = await db.site.create({
        data: {
          id: sid(`site|${spec.key}`),
          clientId: client.id,
          name: spec.names[0]!,
          addressLine1: spec.create.addressLine1,
          city: spec.create.city,
          state: 'FL',
          zip: spec.create.zip,
          timezone: spec.create.timezone,
          type: 'STORE',
          createdAt: opened,
          ...(region && spec.inRegion ? { regionId: region.id } : {}),
          ...(regionOrgUnit ? { orgUnitId: regionOrgUnit } : {}),
        },
      });
      count('storesOpened');
    }
    if (!site) throw new Error(`[demo-refresh] store "${spec.names[0]}" is missing — run db:seed and scripts/seed-demo-shifts.ts first.`);
    if (spec.rename && site.name !== spec.names[0]) {
      site = await db.site.update({ where: { id: site.id }, data: { name: spec.names[0]!, addressLine1: spec.rename.addressLine1, city: spec.rename.city, state: 'FL', zip: spec.rename.zip } });
      count('storesRenamed');
    }
    if (region && spec.inRegion && site.regionId !== region.id) await db.site.update({ where: { id: site.id }, data: { regionId: region.id } });
    if (spec.key === 'front-beach') regionOrgUnit = site.orgUnitId;
    if (!site.isActive) await db.site.update({ where: { id: site.id }, data: { isActive: true } });

    // The contract: a floor target per window, nothing outside them.
    const existing = await db.staffingTarget.findMany({ where: { locationId: site.id } });
    const wanted = Object.entries(spec.targets) as Array<[WindowLabel, number]>;
    for (const [label, targetCount] of wanted) {
      const w = WINDOW[label];
      const row = existing.find((t) => t.label === label) ?? (label === 'Afternoon' ? existing.find((t) => t.label === 'Swing') : undefined);
      if (row) {
        if (row.targetCount !== targetCount || row.label !== label || row.startMinute !== w.start || row.endMinute !== w.end) {
          await db.staffingTarget.update({ where: { id: row.id }, data: { targetCount, label, startMinute: w.start, endMinute: w.end } });
          count('targetsUpdated');
        }
      } else {
        await db.staffingTarget.create({ data: { id: sid(`target|${spec.key}|${label}`), locationId: site.id, targetCount, label, startMinute: w.start, endMinute: w.end, effectiveFrom: dateOf('2025-01-04'), createdById: adminId } });
        count('targetsCreated');
      }
    }
    const keep = new Set(wanted.map(([l]) => l as string));
    const drop = existing.filter((t) => !(t.label && (keep.has(t.label) || (t.label === 'Swing' && keep.has('Afternoon')))));
    if (drop.length) {
      await db.staffingTarget.deleteMany({ where: { id: { in: drop.map((t) => t.id) } } });
      count('targetsRemoved', drop.length);
    }

    const openedKey = spec.create ? keyIn(site.createdAt, site.timezone) : '2024-01-01';
    out.push({ spec, id: site.id, clientId: client.id, tz: site.timezone, openedKey });
  }

  // Who leads which window: the shift supervisor the mornings, the floor supervisor the afternoons and nights.
  await db.supervisorShiftWindow.updateMany({ where: { label: 'Swing' }, data: { label: 'Afternoon' } }).catch(() => undefined);
  const leads: Array<[string, string, WindowLabel]> = [
    ['dana.reyes@altohr.com', 'front-beach', 'Morning'],
    ['dana.reyes@altohr.com', 'thomas-drive', 'Morning'],
    ['dana.reyes@altohr.com', 'destin-harbor', 'Morning'],
    ['floor.demo@altohr.com', 'front-beach', 'Afternoon'],
    ['floor.demo@altohr.com', 'front-beach', 'Overnight'],
  ];
  for (const [email, key, label] of leads) {
    const u = await user(email);
    const st = out.find((s) => s.spec.key === key);
    if (!u || !st) continue;
    if (await db.supervisorShiftWindow.findFirst({ where: { userId: u.id, locationId: st.id, label }, select: { id: true } })) continue;
    await db.supervisorShiftWindow.create({ data: { id: sid(`lead-window|${u.id}|${st.id}|${label}`), userId: u.id, locationId: st.id, label } });
    count('leadWindows');
  }

  // Positions and rate cards for every client a store belongs to.
  for (const clientId of new Set(out.map((s) => s.clientId))) {
    const positions = new Set(out.filter((s) => s.clientId === clientId).flatMap((s) => s.spec.crew.map((c) => c.position)));
    positions.add(LEAD);
    let order = 1;
    for (const name of positions) {
      const isLead = name === LEAD;
      const found = await db.shiftPosition.findFirst({ where: { clientId, name, deletedAt: null } });
      if (!found) {
        await db.shiftPosition.create({ data: { clientId, name, isLead, sortOrder: isLead ? 0 : order } });
        count('positions');
      }
      order += 1;
      const rate = RATES[name]!;
      const cards = await db.shiftRateDefault.findMany({ where: { clientId, position: name } });
      if (cards.length === 0) {
        await db.shiftRateDefault.create({ data: { clientId, position: name, payRate: rate.pay, billRate: rate.bill, effectiveFrom: dateOf('2025-01-01'), createdById: adminId } });
        count('rateCards');
      } else {
        for (const c of cards) {
          if (Number(c.payRate) !== rate.pay || Number(c.billRate) !== rate.bill) {
            await db.shiftRateDefault.update({ where: { id: c.id }, data: { payRate: rate.pay, billRate: rate.bill } });
            count('rateCardsAligned');
          }
        }
      }
    }
  }
  return out;
}

/** The crew's demo password (the people this script gives a login sign in with it). */
const ASSOCIATE_DEMO_PASSWORD = 'demo-associate-2026!';
let demoHash: string | null = null;
async function demoPasswordHash(): Promise<string> {
  if (!demoHash) {
    const { hashPassword } = await import('../src/lib/passwords.js');
    demoHash = await hashPassword(ASSOCIATE_DEMO_PASSWORD);
  }
  return demoHash;
}

// ---------------------------------------------------------------------------
// 4. People: employed, placed, paid by the hour, reporting to someone
// ---------------------------------------------------------------------------

async function templateTasks() {
  const template = await db.onboardingTemplate.findFirst({ where: { clientId: null, track: 'STANDARD' }, include: { tasks: { orderBy: { order: 'asc' } } } });
  if (!template) throw new Error('[demo-refresh] the standard onboarding template is missing — run db:seed first.');
  return withMandatoryTasks(template.tasks.map((t) => ({ kind: t.kind, title: t.title, description: t.description, order: t.order, dueOffsetDays: t.dueOffsetDays ?? undefined })));
}

/** A finished onboarding: every task done at the start. */
async function ensureApprovedApplication(associateId: string, store: StoreRow, position: string, startKey: string, tasks: Awaited<ReturnType<typeof templateTasks>>) {
  const start = dateOf(startKey);
  const approved = await db.application.findFirst({ where: { associateId, status: 'APPROVED', deletedAt: null }, select: { id: true, checklist: { select: { id: true } } } });
  const invitedAt = new Date(start.getTime() - 9 * DAY);
  const doneAt = new Date(start.getTime() - 6 * DAY);
  if (approved) {
    if (!approved.checklist) {
      await db.onboardingChecklist.create({ data: { applicationId: approved.id, tasks: { create: tasks.map((t) => ({ ...t, status: 'DONE' as const, completedAt: doneAt })) } } });
      count('checklistsAdded');
    } else {
      const open = await db.onboardingTask.updateMany({ where: { checklistId: approved.checklist.id, status: { notIn: ['DONE', 'SKIPPED'] } }, data: { status: 'DONE', completedAt: doneAt } });
      count('onboardingTasksClosed', open.count);
    }
    return approved.id;
  }
  const draft = await db.application.findFirst({ where: { associateId, deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] } }, select: { id: true, checklist: { select: { id: true } } } });
  if (draft) {
    // The person has been working: their onboarding was finished long ago.
    await db.application.update({ where: { id: draft.id }, data: { status: 'APPROVED', clientId: store.clientId, locationId: store.id, position, startDate: start, submittedAt: new Date(start.getTime() - 7 * DAY), approvedAt: doneAt, invitedAt } });
    if (draft.checklist) await db.onboardingTask.updateMany({ where: { checklistId: draft.checklist.id }, data: { status: 'DONE', completedAt: doneAt } });
    else await db.onboardingChecklist.create({ data: { applicationId: draft.id, tasks: { create: tasks.map((t) => ({ ...t, status: 'DONE' as const, completedAt: doneAt })) } } });
    count('applicationsCompleted');
    return draft.id;
  }
  const app = await db.application.create({
    data: {
      id: sid(`application|${associateId}`),
      associateId,
      clientId: store.clientId,
      locationId: store.id,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
      position,
      startDate: start,
      invitedAt,
      submittedAt: new Date(start.getTime() - 7 * DAY),
      approvedAt: doneAt,
      createdAt: invitedAt,
      checklist: { create: { tasks: { create: tasks.map((t) => ({ ...t, status: 'DONE' as const, completedAt: doneAt })) } } },
    },
  });
  count('applicationsAdded');
  return app.id;
}

async function ensurePeople(stores: StoreRow[], todayKey: string, adminId: string): Promise<Person[]> {
  const tasks = await templateTasks();
  const dana = await db.associate.findFirst({ where: { email: 'dana.reyes@altohr.com' }, select: { id: true } });
  const marcusHill = await db.associate.findFirst({ where: { email: 'floor.demo@altohr.com' }, select: { id: true } });

  // The manager persona: a person with a record, so the app greets them by name and they have a team.
  const managerUser = await user(MANAGER.email);
  let managerId: string | null = managerUser?.associateId ?? null;
  if (managerUser && !managerId) {
    const a =
      (await db.associate.findFirst({ where: { email: MANAGER.associateEmail }, select: { id: true } })) ??
      (await db.associate.create({
        data: { id: sid('associate|manager'), firstName: MANAGER.first, lastName: MANAGER.last, email: MANAGER.associateEmail, phone: MANAGER.phone, city: 'Panama City Beach', state: 'FL', zip: '32413', employmentType: 'W2_EMPLOYEE', hireDate: dateOf('2023-03-06'), dob: dateOf('1986-02-14'), createdAt: dateOf('2023-02-20') },
        select: { id: true },
      }));
    await db.user.update({ where: { id: managerUser.id }, data: { associateId: a.id } });
    managerId = a.id;
    count('managerLinked');
  }
  for (const id of [dana?.id, marcusHill?.id]) if (id && managerId) await db.associate.updateMany({ where: { id, managerId: null }, data: { managerId } });

  const people: Person[] = [];
  for (const store of stores) {
    const windows = new Map<WindowLabel, CrewSpec[]>();
    for (const c of store.spec.crew) windows.set(c.window, [...(windows.get(c.window) ?? []), c]);
    let leadId: string | null = null;
    for (const [, pool] of windows) {
      const ordered = [...pool.filter((c) => c.role === 'lead'), ...pool.filter((c) => c.role === 'backup'), ...pool.filter((c) => !c.role)];
      for (const [i, spec] of ordered.entries()) {
        const [first, ...rest] = spec.name.split(' ');
        const last = rest.join(' ');
        let a = await db.associate.findFirst({ where: { tenantId: ALTO_TENANT_ID, firstName: first!, lastName: last, deletedAt: null }, orderBy: { createdAt: 'asc' } });
        if (!a && spec.hire) {
          const startKey = store.openedKey > addDays(todayKey, -HISTORY_FILL_DAYS) ? store.openedKey : addDays(todayKey, -49);
          a = await db.associate.create({
            data: { id: sid(`associate|${spec.hire.email}`), firstName: first!, lastName: last, email: spec.hire.email, phone: spec.hire.phone, dob: dateOf(spec.hire.dob), addressLine1: `${intBy(spec.name, 200, 9800)} ${pickBy(spec.name, ['Thomas Dr', 'Back Beach Rd', 'Hutchison Blvd', 'Harbor Blvd', 'Front Beach Rd'])}`, city: store.spec.create?.city ?? 'Panama City Beach', state: 'FL', zip: store.spec.create?.zip ?? '32413', employmentType: 'W2_EMPLOYEE', hireDate: dateOf(startKey), createdAt: new Date(dateOf(startKey).getTime() - 10 * DAY) },
          });
          count('peopleHired');
        }
        if (!a) {
          log(`  (skipped ${spec.name}: not in this database)`);
          continue;
        }
        if (a.separatedAt || a.deactivatedAt) continue;

        // Where they work now, and since when.
        const open = await db.associateAssignment.findFirst({ where: { associateId: a.id, endedAt: null }, orderBy: { startedAt: 'desc' } });
        let startKey = a.hireDate ? ymd(a.hireDate) : open ? ymd(open.startedAt) : store.openedKey > addDays(todayKey, -HISTORY_FILL_DAYS) ? store.openedKey : addDays(todayKey, -HISTORY_FILL_DAYS);
        if (!a.phone) {
          await db.associate.update({ where: { id: a.id }, data: { phone: `+1-850-555-${String(intBy(`phone|${a.id}`, 4300, 4899))}` } });
        }
        if (!a.hireDate || !a.dob || !a.addressLine1) {
          await db.associate.update({
            where: { id: a.id },
            data: {
              ...(a.hireDate ? {} : { hireDate: dateOf(startKey) }),
              ...(a.dob ? {} : { dob: dateOf(`${intBy(`${a.id}|y`, 1975, 2003)}-${pad(intBy(`${a.id}|m`, 1, 12))}-${pad(intBy(`${a.id}|d`, 1, 28))}`) }),
              ...(a.addressLine1 ? {} : { addressLine1: `${intBy(a.id, 200, 9800)} ${pickBy(a.id, ['Thomas Dr', 'Back Beach Rd', 'Hutchison Blvd', 'Harbor Blvd', 'Front Beach Rd'])}`, city: a.city ?? 'Panama City Beach', state: a.state ?? 'FL', zip: a.zip ?? '32413' }),
            },
          });
          count('peopleCompleted');
        }
        const placedFrom = startKey > store.openedKey ? startKey : store.openedKey;
        if (!open || open.locationId !== store.id) {
          if (open) {
            const endKey = addDays(placedFrom, -1) >= ymd(open.startedAt) ? addDays(placedFrom, -1) : ymd(open.startedAt);
            await db.associateAssignment.update({ where: { id: open.id }, data: { endedAt: dateOf(endKey), reason: open.reason ?? 'Placed at hire', notes: `Moved to ${store.spec.names[0]} when it opened` } });
          }
          await db.associateAssignment.create({ data: { id: sid(`assignment|${a.id}|${store.id}`), associateId: a.id, locationId: store.id, startedAt: dateOf(placedFrom), reason: open ? 'Transfer' : 'Placed at hire', notedById: adminId } });
          count('placements');
        }
        const appId = await ensureApprovedApplication(a.id, store, spec.position, startKey, tasks);
        if (!(await db.employment.findFirst({ where: { associateId: a.id, endDate: null }, select: { id: true } }))) {
          await openEmployment(db, { associateId: a.id, applicationId: (await db.employment.findUnique({ where: { applicationId: appId }, select: { id: true } })) ? null : appId, clientId: store.clientId, siteId: store.id, hireDate: startKey });
          count('employments');
        }
        // Both clients buy through SAP Fieldglass: every worker placed there has a Fieldglass worker id.
        if (!(await db.fieldglassRegistration.findUnique({ where: { associateId: a.id }, select: { associateId: true } }))) {
          await db.fieldglassRegistration.create({ data: { associateId: a.id, clientId: store.clientId, addedById: adminId, addedAt: minDate(new Date(dateOf(placedFrom).getTime() - 2 * DAY + 15 * HOUR), new Date(NOW.getTime() - HOUR)), workerId: `WKR${String(intBy(`wkr|${a.id}`, 10_000_000, 99_999_999)).padStart(8, '0')}` } });
          count('fieldglassRegistrations');
        }
        // Paid by direct deposit (most) or on the Branch card.
        if (!(await db.payoutMethod.findFirst({ where: { associateId: a.id, retiredAt: null }, select: { id: true } }))) {
          const branch = frac(`payout|${a.id}`) < 0.3;
          if (branch) {
            await db.payoutMethod.create({ data: { id: sid(`payout|${a.id}`), associateId: a.id, type: 'BRANCH_CARD', branchCardId: `br_${sid(`branch|${a.id}`).slice(-12)}`, isPrimary: true, verifiedAt: dateOf(startKey), verifiedById: adminId } });
          } else {
            const routing = pickBy(`bank|${a.id}`, ['063100277', '263191387', '063107513', '062203751'] as const);
            const account = String(intBy(`acct|${a.id}`, 1_000_000_000, 9_999_999_999));
            await db.payoutMethod.create({
              data: { id: sid(`payout|${a.id}`), associateId: a.id, type: 'BANK_ACCOUNT', routingNumberEnc: Buffer.from(routing, 'utf8'), accountNumberEnc: encryptString(account), accountType: 'CHECKING', bankName: routing === '263191387' ? 'Regions Bank' : routing === '062203751' ? 'Truist' : 'Bank of America', accountLast4: account.slice(-4), accountFingerprint: accountFingerprint(routing, account), isPrimary: true, verifiedAt: dateOf(startKey), verifiedById: adminId },
            });
          }
          count('payoutMethods');
        }
        if (!(await db.compensationRecord.findFirst({ where: { associateId: a.id }, select: { id: true } }))) {
          await db.compensationRecord.create({ data: { id: sid(`comp|${a.id}`), associateId: a.id, effectiveFrom: dateOf(startKey), payType: 'HOURLY', amount: RATES[spec.position]!.pay, reason: 'HIRE', actorUserId: adminId, notes: spec.position === LEAD ? 'Shift lead rate' : 'Rate card for the position' } });
          count('compensation');
        }
        // Who they report to: the store's supervisor at Front Beach, the
        // manager at the new stores, the lead at the Seaside store.
        if (spec.role === 'lead') leadId = a.id;
        const reportsTo = store.spec.key === 'front-beach' ? (dana?.id ?? managerId) : store.spec.key === 'tallahassee' ? (spec.role === 'lead' ? managerId : leadId) : managerId;
        if (reportsTo && a.managerId !== reportsTo && reportsTo !== a.id) await db.associate.update({ where: { id: a.id }, data: { managerId: reportsTo } });

        // Everyone has the app: their schedule, punches and pay stubs (payroll pays only people with an account).
        if (!(await db.user.findFirst({ where: { associateId: a.id }, select: { id: true } })) && !(await db.user.findUnique({ where: { email: a.email }, select: { id: true } }))) {
          await db.user.create({ data: { id: sid(`user|${a.id}`), email: a.email, passwordHash: await demoPasswordHash(), role: 'ASSOCIATE', status: 'ACTIVE', associateId: a.id, lastSeenAt: new Date(NOW.getTime() - intBy(`seen|${a.id}`, 1, 120) * HOUR), createdAt: new Date(dateOf(startKey).getTime() - 8 * DAY) } });
          count('associateLogins');
        }
        // The last day anyone else scheduled them (the analytics seed's history): this script carries on from the day after.
        const lastShift = await db.shift.findFirst({ where: { assignedAssociateId: a.id, NOT: { id: MINE }, status: { not: 'CANCELLED' } }, orderBy: { startsAt: 'desc' }, select: { startsAt: true } });
        const lastKey = lastShift ? keyIn(lastShift.startsAt, store.tz) : null;
        const genFrom = lastKey && addDays(lastKey, 1) > placedFrom ? addDays(lastKey, 1) : placedFrom;
        const u = await db.user.findFirst({ where: { associateId: a.id }, select: { id: true } });
        startKey = placedFrom;
        people.push({ id: a.id, name: spec.name, spec, store, startKey, offDays: [(2 * i) % 7, (2 * i + 1) % 7], genFrom, userId: u?.id ?? null });
      }
    }
  }
  await ensurePersonWorkers(db);
  count('crew', people.length);
  return people;
}

// ---------------------------------------------------------------------------
// 5. The company pay schedule: everyone employed is on it from their start
// ---------------------------------------------------------------------------

interface Schedule {
  id: string;
  anchorKey: string;
  offset: number;
}

async function ensurePaySchedule(people: Person[], todayKey: string): Promise<Schedule | null> {
  const schedule = await db.payrollSchedule.findFirst({ where: { clientId: null, deletedAt: null, isActive: true, frequency: 'BIWEEKLY' }, orderBy: { createdAt: 'asc' } });
  if (!schedule) {
    log('  no company biweekly schedule — skipping pay schedules and payroll.');
    return null;
  }
  // The company default: anyone no rule covers is on it (new hires included).
  if (!schedule.isDefault) await db.payrollSchedule.update({ where: { id: schedule.id }, data: { isDefault: true } });
  // Everyone in the pay population (employed, and placed or approved), crew or not.
  const population = await db.associate.findMany({
    where: {
      tenantId: ALTO_TENANT_ID,
      deletedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      erasedAt: null,
      OR: [{ assignments: { some: { endedAt: null } } }, { applications: { some: { status: 'APPROVED', deletedAt: null } } }],
    },
    select: { id: true, hireDate: true, payrollScheduleId: true, payScheduleAssignments: { select: { id: true, scheduleId: true, effectiveFrom: true, effectiveTo: true } } },
  });
  const startOf = new Map(people.map((p) => [p.id, p.startKey]));
  for (const a of population) {
    const inForce = a.payScheduleAssignments.find((x) => ymd(x.effectiveFrom) <= todayKey && (!x.effectiveTo || ymd(x.effectiveTo) >= todayKey));
    if (!inForce) {
      const from = (a.hireDate ? ymd(a.hireDate) : startOf.get(a.id)) ?? todayKey;
      const later = a.payScheduleAssignments.filter((x) => ymd(x.effectiveFrom) > todayKey);
      if (later.length) await db.payrollScheduleAssignment.deleteMany({ where: { id: { in: later.map((x) => x.id) } } });
      const earlier = a.payScheduleAssignments.filter((x) => x.effectiveTo && ymd(x.effectiveTo) < todayKey).map((x) => ymd(x.effectiveTo!)).sort().pop();
      await db.payrollScheduleAssignment.create({
        data: { id: sid(`schedule-assignment|${a.id}`), associateId: a.id, scheduleId: schedule.id, effectiveFrom: dateOf(earlier && addDays(earlier, 1) > from ? addDays(earlier, 1) : from), effectiveTo: null, source: 'DEFAULT', reason: 'Company default' },
      });
      count('scheduleAssignments');
    }
    if (a.payrollScheduleId !== schedule.id) await db.associate.update({ where: { id: a.id }, data: { payrollScheduleId: schedule.id } });
  }
  return { id: schedule.id, anchorKey: ymd(schedule.anchorDate), offset: schedule.payDateOffsetDays };
}

// ---------------------------------------------------------------------------
// 6. The schedule: staffed to contract, published, mostly confirmed
// ---------------------------------------------------------------------------

interface ShiftLite {
  id: string;
  assignedAssociateId: string | null;
  startsAt: Date;
  position: string;
  status: string;
  locationId: string | null;
}

function windowOfStart(startsAt: Date, tz: string): WindowLabel {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(startsAt);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = h * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
  if (minute >= 4 * 60 && minute < 12 * 60) return 'Morning';
  if (minute >= 12 * 60 && minute < 20 * 60) return 'Afternoon';
  return 'Overnight';
}

async function rollSchedule(stores: StoreRow[], people: Person[], todayKey: string, users: { workforce: string }): Promise<void> {
  const rows: Prisma.ShiftCreateManyInput[] = [];
  for (const store of stores) {
    const crew = people.filter((p) => p.store === store);
    if (crew.length === 0) continue;
    // From the earliest day anyone here can still be scheduled, but no further back than the fill window.
    const earliestGen = crew.map((p) => p.genFrom).sort()[0]!;
    const floor = addDays(todayKey, -HISTORY_FILL_DAYS);
    const fromKey = [earliestGen > floor ? earliestGen : floor, addDays(todayKey, -PAST_DAYS)].sort()[0]!;
    const toKey = addDays(todayKey, AHEAD_DAYS);
    const rangeStart = utcInstantOfLocalMidnight(addDays(fromKey, -7), store.tz);
    const rangeEnd = utcInstantOfLocalMidnight(addDays(toKey, 2), store.tz);
    // Every shift at the store in the range, and every shift the crew holds anywhere (one shift a day, five a week).
    const atStore: ShiftLite[] = await db.shift.findMany({ where: { locationId: store.id, startsAt: { gte: rangeStart, lt: rangeEnd }, status: { not: 'CANCELLED' } }, select: { id: true, assignedAssociateId: true, startsAt: true, position: true, status: true, locationId: true } });
    const held: ShiftLite[] = await db.shift.findMany({ where: { assignedAssociateId: { in: crew.map((p) => p.id) }, startsAt: { gte: rangeStart, lt: rangeEnd }, status: { not: 'CANCELLED' } }, select: { id: true, assignedAssociateId: true, startsAt: true, position: true, status: true, locationId: true } });
    const dayOf = (s: ShiftLite) => keyIn(s.startsAt, store.tz);
    const busy = new Set(held.map((s) => `${s.assignedAssociateId}|${dayOf(s)}`));
    const perWeek = new Map<string, number>();
    for (const s of held) perWeek.set(`${s.assignedAssociateId}|${weekOf(dayOf(s))}`, (perWeek.get(`${s.assignedAssociateId}|${weekOf(dayOf(s))}`) ?? 0) + 1);
    const planned = new Set(atStore.filter((s) => s.id.startsWith(PREFIX)).map((s) => `${dayOf(s)}|${windowOfStart(s.startsAt, store.tz)}`));

    for (let key = fromKey; key <= toKey; key = addDays(key, 1)) {
      if (key < store.openedKey) continue;
      const weekday = weekdayOf(key);
      for (const [label, target] of Object.entries(store.spec.targets) as Array<[WindowLabel, number]>) {
        if (planned.has(`${key}|${label}`)) continue;
        const theirs = atStore.filter((s) => dayOf(s) === key && windowOfStart(s.startsAt, store.tz) === label && s.assignedAssociateId && s.status !== 'OPEN');
        let need = target - theirs.length;
        const hasLead = theirs.some((s) => s.position === LEAD);
        if (need <= 0) continue;
        const pool = crew.filter((p) => p.spec.window === label && key >= p.genFrom && !p.offDays.includes(weekday) && !busy.has(`${p.id}|${key}`) && (perWeek.get(`${p.id}|${weekOf(key)}`) ?? 0) < 5);
        const ordered = pool.sort((a, b) => (perWeek.get(`${a.id}|${weekOf(key)}`) ?? 0) - (perWeek.get(`${b.id}|${weekOf(key)}`) ?? 0) || frac(`${a.id}|${key}`) - frac(`${b.id}|${key}`));
        const lead = !hasLead ? (pool.find((p) => p.spec.role === 'lead') ?? pool.find((p) => p.spec.role === 'backup')) : undefined;
        const picks = lead ? [lead, ...ordered.filter((p) => p !== lead)] : ordered;
        const startsAt = wallToUtc(key, WINDOW[label].start, store.tz);
        const endsAt = WINDOW[label].end > WINDOW[label].start ? wallToUtc(key, WINDOW[label].end, store.tz) : wallToUtc(addDays(key, 1), WINDOW[label].end, store.tz);
        for (const p of picks) {
          if (need <= 0) break;
          const position = p === lead ? LEAD : p.spec.position === LEAD ? 'Cashier' : p.spec.position;
          const rate = RATES[position]!;
          const id = sid(`shift|${store.id}|${key}|${label}|${p.id}`);
          const publishedAt = minDate(new Date(startsAt.getTime() - 10 * DAY), new Date(NOW.getTime() - HOUR));
          rows.push({
            id,
            clientId: store.clientId,
            locationId: store.id,
            position,
            startsAt,
            endsAt,
            location: pickBy(id, AREAS[position] ?? ['Front end']),
            hourlyRate: rate.bill,
            payRate: rate.pay,
            status: 'ASSIGNED',
            assignedAssociateId: p.id,
            assignedAt: publishedAt,
            publishedAt,
            createdById: users.workforce,
            createdAt: new Date(publishedAt.getTime() - 2 * HOUR),
          });
          busy.add(`${p.id}|${key}`);
          perWeek.set(`${p.id}|${weekOf(key)}`, (perWeek.get(`${p.id}|${weekOf(key)}`) ?? 0) + 1);
          need -= 1;
        }
      }
    }
  }
  for (let i = 0; i < rows.length; i += 500) await db.shift.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
  count('shiftsPlanned', rows.length);

  // A couple of extra hands the store asked for that nobody has picked up yet.
  const fb = stores.find((s) => s.spec.key === 'front-beach');
  if (fb) {
    for (const d of [2, 5]) {
      const key = addDays(todayKey, d);
      const startsAt = wallToUtc(key, 14 * 60, fb.tz);
      const id = sid(`open-shift|${fb.id}|${key}`);
      await db.shift.createMany({
        data: [{ id, clientId: fb.clientId, locationId: fb.id, position: 'Stocker', startsAt, endsAt: new Date(startsAt.getTime() + 6 * HOUR), location: 'Receiving', hourlyRate: RATES.Stocker!.bill, payRate: RATES.Stocker!.pay, status: 'OPEN', publishedAt: new Date(NOW.getTime() - 20 * HOUR), createdById: users.workforce, notes: d === 2 ? 'Truck day — extra hands in receiving.' : 'Weekend reset of the seasonal aisle.' }],
        skipDuplicates: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Punches: every shift that has started is worked (or, rarely, missed)
// ---------------------------------------------------------------------------

/** A lead on the floor every day at every store for the last five weeks (the backup lead steps up on the lead's days off). */
async function leadEveryDay(stores: StoreRow[], people: Person[]): Promise<void> {
  // Days a payroll run already paid stay as they were paid.
  const lastRun = await db.payrollRun.findFirst({ where: { status: { not: 'CANCELLED' } }, orderBy: { periodEnd: 'desc' }, select: { periodEnd: true } });
  const after = maxDate(new Date(NOW.getTime() - 35 * DAY), lastRun ? new Date(lastRun.periodEnd.getTime() + 2 * DAY) : new Date(0));
  for (const store of stores) {
    const stepUp = new Set(people.filter((p) => p.store === store && (p.spec.role === 'backup' || p.spec.role === 'lead')).map((p) => p.id));
    const shifts = await db.shift.findMany({
      where: { locationId: store.id, startsAt: { gte: after, lte: new Date(NOW.getTime() + (AHEAD_DAYS + 1) * DAY) }, status: { in: ['ASSIGNED', 'COMPLETED'] }, assignedAssociateId: { not: null } },
      select: { id: true, startsAt: true, position: true, assignedAssociateId: true, timeEntries: { select: { id: true } } },
    });
    const byDay = new Map<string, typeof shifts>();
    for (const s of shifts) {
      const k = s.startsAt.toISOString().slice(0, 10); // the compliance signal counts UTC days
      byDay.set(k, [...(byDay.get(k) ?? []), s]);
    }
    for (const [, list] of byDay) {
      if (list.some((s) => s.position === LEAD)) continue;
      const step = list
        .filter((s) => windowOfStart(s.startsAt, store.tz) === 'Morning')
        .sort((a, b) => Number(stepUp.has(b.assignedAssociateId!)) - Number(stepUp.has(a.assignedAssociateId!)) || a.id.localeCompare(b.id))[0];
      if (!step) continue;
      await db.shift.update({ where: { id: step.id }, data: { position: LEAD, payRate: RATES[LEAD]!.pay, hourlyRate: RATES[LEAD]!.bill } });
      if (step.timeEntries.length) await db.timeEntry.updateMany({ where: { id: { in: step.timeEntries.map((e) => e.id) } }, data: { payRate: RATES[LEAD]!.pay } });
      count('leadSteppedUp');
    }
  }
}

async function settlePunches(stores: StoreRow[], supervisorOf: Map<string, string>, adminId: string): Promise<void> {
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const started = await db.shift.findMany({
    where: { id: MINE, startsAt: { lte: NOW }, status: 'ASSIGNED', assignedAssociateId: { not: null }, noShowRecordedAt: null },
    orderBy: { startsAt: 'asc' },
    select: { id: true, startsAt: true, endsAt: true, clientId: true, locationId: true, payRate: true, assignedAssociateId: true, acknowledgedAt: true, timeEntries: { select: { id: true, status: true, clockInAt: true } } },
  });
  const entries: Prisma.TimeEntryCreateManyInput[] = [];
  const breaks: Prisma.BreakEntryCreateManyInput[] = [];
  const events: Prisma.AttendanceEventCreateManyInput[] = [];
  const onClock = new Set((await db.timeEntry.findMany({ where: { status: 'ACTIVE' }, select: { associateId: true } })).map((e) => e.associateId));
  for (const s of started) {
    const who = s.assignedAssociateId!;
    const store = s.locationId ? storeById.get(s.locationId) : undefined;
    const r = frac(`attend|${s.id}`);
    const ended = s.endsAt <= NOW;
    const missed = r < 0.018;
    const late = !missed && r < 0.075 ? intBy(`late|${s.id}`, 8, 22) : 0;
    const clockInAt = plusMin(s.startsAt, late || intBy(`in|${s.id}`, -12, 1));
    const clockOutAt = plusMin(s.endsAt, intBy(`out|${s.id}`, -4, 7));
    const ack = s.acknowledgedAt ? {} : { acknowledgedAt: new Date(s.startsAt.getTime() - intBy(`ack|${s.id}`, 14, 60) * HOUR) };
    if (missed) {
      if (!ended) continue;
      await db.shift.update({ where: { id: s.id }, data: { noShowRecordedAt: s.endsAt, noShowNotifiedAt: plusMin(s.startsAt, 15), ...ack } });
      events.push({ id: sid(`ncns|${s.id}`), associateId: who, shiftId: s.id, clientId: s.clientId, kind: 'NO_CALL_NO_SHOW', points: ATTENDANCE_POINTS.NO_CALL_NO_SHOW!, occurredOn: dateOf(s.startsAt.toISOString().slice(0, 10)), source: 'AUTO', createdAt: s.endsAt });
      count('noShows');
      continue;
    }
    const active = s.timeEntries.find((e) => e.status === 'ACTIVE');
    if (ended) {
      if (active) {
        await db.timeEntry.update({ where: { id: active.id }, data: { clockOutAt, status: 'COMPLETED' } });
        onClock.delete(who);
        breaks.push({ id: sid(`meal|${active.id}`), timeEntryId: active.id, type: 'MEAL', startedAt: plusMin(active.clockInAt, intBy(`meal|${s.id}`, 220, 260)), endedAt: plusMin(active.clockInAt, intBy(`meal|${s.id}`, 220, 260) + 30) });
      } else if (s.timeEntries.length === 0) {
        const id = sid(`punch|${s.id}`);
        entries.push({ id, associateId: who, clientId: s.clientId, locationId: s.locationId, shiftId: s.id, clockInAt, clockOutAt, payRate: s.payRate, status: 'COMPLETED', createdAt: clockInAt });
        breaks.push({ id: sid(`meal|${id}`), timeEntryId: id, type: 'MEAL', startedAt: plusMin(clockInAt, intBy(`meal|${s.id}`, 220, 260)), endedAt: plusMin(clockInAt, intBy(`meal|${s.id}`, 220, 260) + 30) });
      }
      await db.shift.update({ where: { id: s.id }, data: { status: 'COMPLETED', ...ack } });
      if (late) events.push({ id: sid(`late|${s.id}`), associateId: who, shiftId: s.id, clientId: s.clientId, kind: 'LATE', points: ATTENDANCE_POINTS.LATE!, occurredOn: dateOf(s.startsAt.toISOString().slice(0, 10)), source: 'AUTO', note: `${late} min after shift start`, createdAt: clockInAt });
      count('punches');
    } else if (!active && s.timeEntries.length === 0 && clockInAt <= NOW && !onClock.has(who)) {
      // On the floor right now.
      entries.push({ id: sid(`punch|${s.id}`), associateId: who, clientId: s.clientId, locationId: s.locationId, shiftId: s.id, clockInAt, clockOutAt: null, payRate: s.payRate, status: 'ACTIVE', createdAt: clockInAt });
      onClock.add(who);
      if (Object.keys(ack).length) await db.shift.update({ where: { id: s.id }, data: ack });
      if (late) events.push({ id: sid(`late|${s.id}`), associateId: who, shiftId: s.id, clientId: s.clientId, kind: 'LATE', points: ATTENDANCE_POINTS.LATE!, occurredOn: dateOf(s.startsAt.toISOString().slice(0, 10)), source: 'AUTO', note: `${late} min after shift start`, createdAt: clockInAt });
      count('onTheFloor');
    }
    void store;
  }
  for (let i = 0; i < entries.length; i += 500) await db.timeEntry.createMany({ data: entries.slice(i, i + 500), skipDuplicates: true });
  for (let i = 0; i < breaks.length; i += 500) await db.breakEntry.createMany({ data: breaks.slice(i, i + 500), skipDuplicates: true });
  if (events.length) await db.attendanceEvent.createMany({ data: events, skipDuplicates: true });

  // Time the supervisor has looked at: approved the morning after the punch closed.
  const toApprove = await db.timeEntry.findMany({ where: { status: 'COMPLETED', clockOutAt: { lt: new Date(NOW.getTime() - APPROVE_AFTER) } }, select: { id: true, clockOutAt: true, locationId: true } });
  for (const e of toApprove) {
    const by = (e.locationId && supervisorOf.get(e.locationId)) || adminId;
    const at = minDate(new Date(e.clockOutAt!.getTime() + intBy(`approve|${e.id}`, 10, 16) * HOUR), new Date(NOW.getTime() - 10 * MIN));
    await db.timeEntry.update({ where: { id: e.id }, data: { status: 'APPROVED', approvedById: by, approvedAt: at } });
  }
  count('punchesApproved', toApprove.length);

  // Ahead: most people have tapped "I'll be there"; a few have not yet.
  const ahead = await db.shift.findMany({ where: { id: MINE, startsAt: { gt: NOW }, status: 'ASSIGNED', acknowledgedAt: null }, select: { id: true, publishedAt: true, startsAt: true } });
  let confirmed = 0;
  for (const s of ahead) {
    const soon = s.startsAt.getTime() - NOW.getTime() < 48 * HOUR;
    if (frac(`confirm|${s.id}`) < (soon ? 0.12 : 0.2)) continue;
    const at = minDate(new Date((s.publishedAt ?? NOW).getTime() + intBy(`confirm-at|${s.id}`, 2, 40) * HOUR), new Date(NOW.getTime() - intBy(`confirm-ago|${s.id}`, 10, 300) * MIN));
    await db.shift.update({ where: { id: s.id }, data: { acknowledgedAt: at } });
    confirmed += 1;
  }
  count('shiftsConfirmed', confirmed);
}

// ---------------------------------------------------------------------------
// 8. Payroll: every period whose payday has passed, run the way the app runs it
// ---------------------------------------------------------------------------

async function runPaidPeriods(schedule: Schedule, todayKey: string, users: { finance: string; admin: string; financeRole: import('@prisma/client').Role }): Promise<void> {
  // The company's tax accounts: registered, and a semiweekly 941 depositor (over $50,000 a year of withholding).
  const accounts = async () => {
    await db.taxAgencyAccount.updateMany({ where: { status: 'PENDING_REGISTRATION' }, data: { status: 'ACTIVE' } });
    await db.taxAgencyAccount.updateMany({ where: { kind: 'FEDERAL_WITHHOLDING', depositFrequency: { not: 'SEMIWEEKLY' } }, data: { depositFrequency: 'SEMIWEEKLY' } });
  };
  await accounts();
  const periods: Array<{ start: string; end: string; pay: string }> = [];
  for (let start = schedule.anchorKey; ; start = addDays(start, 14)) {
    const end = addDays(start, 13);
    const pay = addDays(end, schedule.offset);
    if (pay > todayKey) break;
    if (addDays(todayKey, -180) <= end) periods.push({ start, end, pay });
  }
  for (const p of periods) {
    const exists = await db.payrollRun.findFirst({ where: { status: { not: 'CANCELLED' }, kind: 'REGULAR', periodStart: dateOf(p.start), periodEnd: dateOf(p.end) }, select: { id: true } });
    if (exists) continue;
    await preloadPayrollTaxConfig(db, Number(p.end.slice(0, 4))).catch(() => preloadPayrollTaxConfig(db));
    const createdAt = new Date(dateOf(addDays(p.end, 1)).getTime() + 15 * HOUR);
    const finalizedAt = new Date(dateOf(addDays(p.end, 3)).getTime() + 16 * HOUR);
    const disbursedAt = new Date(dateOf(p.pay).getTime() + 12 * HOUR);
    const runId = sid(`payroll-run|${p.start}`);
    await db.$transaction(
      async (tx) => {
        const r = await tx.payrollRun.create({ data: { id: runId, clientId: null, periodStart: dateOf(p.start), periodEnd: dateOf(p.end), status: 'DRAFT', kind: 'REGULAR', payrollScheduleId: schedule.id, createdById: users.finance, createdAt } });
        await aggregateAndPersistRun(tx, r, RATES.Cashier!.pay);
      },
      { timeout: 240_000, maxWait: 20_000 },
    );
    const items = await db.payrollItem.count({ where: { payrollRunId: runId } });
    if (items === 0) {
      // Nobody worked this period on this database: a run that pays no one is not a story.
      await purgeRun(runId);
      continue;
    }
    await db.payrollItem.updateMany({ where: { payrollRunId: runId }, data: { createdAt: disbursedAt } });
    await db.payrollRun.update({ where: { id: runId }, data: { status: 'FINALIZED', finalizedAt } });
    // The pre-payroll review, signed by a second person on the exact numbers.
    const report = await buildPayrollReview(db, runId);
    await signPayrollReview(db, { runId, userId: users.admin, fingerprint: report.fingerprint, note: 'Hours tie to the approved timesheets; checked the new hires and the overtime.' });
    await db.payrollRunReview.updateMany({ where: { payrollRunId: runId }, data: { signedAt: new Date(finalizedAt.getTime() - 2 * HOUR) } });
    await db.payrollItem.updateMany({ where: { payrollRunId: runId }, data: { status: 'DISBURSED', disbursedAt, disbursementRef: `ACH-${p.pay.replace(/-/g, '')}`, paystubEmailedAt: plusMin(disbursedAt, 25) } });
    await db.payrollRun.update({ where: { id: runId }, data: { status: 'DISBURSED', approvedById: users.admin, approvedAt: new Date(finalizedAt.getTime() - 2 * HOUR), disbursedAt, updatedAt: disbursedAt } });
    // What the app does after a disbursement: the books, then the taxes it owes.
    await postPayrollRun(db, runId);
    await afterRunSettled(db, runId);
    await accounts();
    log(`  paid ${p.start} – ${p.end} on ${p.pay}: ${items} paychecks`);
    count('payrollRuns');
  }
  await payTaxesDue(todayKey, users);
}

/**
 * Taxes paid on time: every open liability whose due date has come is paid
 * the business day before, one payment per agency, the way the tax desk
 * records it. Quarterly unemployment waits for its quarter's due date.
 */
async function payTaxesDue(todayKey: string, users: { finance: string; financeRole: import('@prisma/client').Role }): Promise<void> {
  // A 941 deposit already accrued against the monthly calendar moves to the semiweekly one.
  const fed = await db.taxLiability.findMany({ where: { status: 'OPEN', kind: 'FEDERAL_WITHHOLDING' }, select: { id: true, payrollRun: { select: { disbursedAt: true } } } });
  for (const l of fed) {
    if (!l.payrollRun?.disbursedAt) continue;
    const pay = l.payrollRun.disbursedAt;
    // Paid on a Friday: due the following Wednesday.
    const due = new Date(Date.UTC(pay.getUTCFullYear(), pay.getUTCMonth(), pay.getUTCDate() + ((3 - pay.getUTCDay() + 7) % 7 || 7)));
    await db.taxLiability.update({ where: { id: l.id }, data: { dueDate: due } });
  }
  const open = await db.taxLiability.findMany({ where: { status: 'OPEN', dueDate: { lte: dateOf(addDays(todayKey, 1)) } }, select: { id: true, kind: true, jurisdiction: true, accountId: true, dueDate: true } });
  const groups = new Map<string, typeof open>();
  for (const l of open) {
    const k = `${l.kind}|${l.jurisdiction}|${l.accountId}|${ymd(l.dueDate)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const list of groups.values()) {
    const due = ymd(list[0]!.dueDate);
    const paidOn = addDays(due, -1) < todayKey ? addDays(due, -1) : todayKey;
    try {
      const { payment } = await createPayment(db, { id: users.finance, role: users.financeRole }, list.map((l) => l.id));
      if (payment.status !== 'PAID') await markPaymentPaid(db, payment.id, { confirmationNumber: `EFT${due.replace(/-/g, '')}${payment.id.slice(0, 4).toUpperCase()}`, paidOn }, users.finance);
      count('taxPayments');
    } catch (err) {
      log(`  tax payment due ${due} not recorded: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function purgeRun(runId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await purge(tx, 'PayrollRun', [runId]);
  });
}

/**
 * The onboarding pipeline: three people hired and on their way in, at
 * different steps. Their dates follow today, so the desk always shows a live
 * pipeline rather than one that went stale a week after it was seeded.
 */
async function ensureOnboardingPipeline(stores: StoreRow[], todayKey: string): Promise<void> {
  const tasks = await templateTasks();
  const pipeline: Array<{ first: string; last: string; email: string; storeKey: string; position: string; status: 'SUBMITTED' | 'DRAFT'; done: number; invitedDaysAgo: number; startsIn: number }> = [
    { first: 'Sophia', last: 'Delgado', email: 'sophia.delgado@example.com', storeKey: 'front-beach', position: 'Cashier', status: 'SUBMITTED', done: tasks.length, invitedDaysAgo: 4, startsIn: 5 },
    { first: 'Daniel', last: 'Okafor', email: 'daniel.okafor@example.com', storeKey: 'thomas-drive', position: 'Stocker', status: 'DRAFT', done: Math.ceil(tasks.length * 0.6), invitedDaysAgo: 3, startsIn: 9 },
    { first: 'Elif', last: 'Kaya', email: 'elif.kaya@example.com', storeKey: 'front-beach', position: 'Deli associate', status: 'DRAFT', done: 2, invitedDaysAgo: 1, startsIn: 12 },
  ];
  for (const [n, p] of pipeline.entries()) {
    const store = stores.find((s) => s.spec.key === p.storeKey);
    if (!store) continue;
    const associateId = sid(`associate|${p.email}`);
    const invitedAt = new Date(NOW.getTime() - p.invitedDaysAgo * DAY - (n + 2) * HOUR);
    if (!(await db.associate.findUnique({ where: { id: associateId }, select: { id: true } }))) {
      if (await db.associate.findFirst({ where: { email: p.email }, select: { id: true } })) continue;
      await db.associate.create({ data: { id: associateId, firstName: p.first, lastName: p.last, email: p.email, phone: `+1-850-555-42${pad(n + 10)}`, city: 'Panama City Beach', state: 'FL', zip: '32413', employmentType: 'W2_EMPLOYEE', createdAt: invitedAt } });
      count('applicants');
    }
    const appId = sid(`application|${associateId}`);
    const app = await db.application.findUnique({ where: { id: appId }, select: { id: true, status: true, checklist: { select: { id: true } } } });
    const dates = { invitedAt, startDate: dateOf(addDays(todayKey, p.startsIn)), createdAt: invitedAt, ...(p.status === 'SUBMITTED' ? { submittedAt: new Date(NOW.getTime() - 20 * HOUR) } : {}) };
    if (!app) {
      await db.application.create({
        data: {
          id: appId, associateId, clientId: store.clientId, locationId: store.id, onboardingTrack: 'STANDARD', status: p.status, position: p.position, ...dates,
          checklist: { create: { tasks: { create: tasks.map((t, i) => ({ ...t, status: i < p.done ? ('DONE' as const) : i === p.done ? ('IN_PROGRESS' as const) : ('PENDING' as const), ...(i < p.done ? { completedAt: new Date(invitedAt.getTime() + (i + 1) * 3 * HOUR) } : {}) })) } } },
        },
      });
    } else if (app.status === p.status) {
      // Still where the story left them: keep their dates moving with today.
      await db.application.update({ where: { id: appId }, data: dates });
      if (app.checklist) {
        const done = await db.onboardingTask.findMany({ where: { checklistId: app.checklist.id, status: 'DONE' }, orderBy: { order: 'asc' }, select: { id: true } });
        for (const [i, t] of done.entries()) await db.onboardingTask.update({ where: { id: t.id }, data: { completedAt: new Date(invitedAt.getTime() + (i + 1) * 3 * HOUR) } });
      }
    }
  }
}

/**
 * The money side: the clients' VMS (SAP Fieldglass) SOW rates and weekly
 * timesheets entered on time, everyone in the pay population on a rate, and
 * the company books opened with the cash it started the quarter with.
 */
async function ensureFinance(stores: StoreRow[], todayKey: string, adminId: string, financeId: string): Promise<void> {
  const { fieldglassDueAt } = await import('../src/lib/fieldglassDesk.js');
  const { postEntry } = await import('../src/lib/books/ledger.js');
  // The Seaside SOW is billed through Fieldglass too.
  const seaside = stores.find((s) => s.spec.key === 'tallahassee');
  if (seaside) await db.client.updateMany({ where: { id: seaside.clientId, fieldglassBillRate: null }, data: { fieldglassBillRate: 21.75, fieldglassSiteName: '1 - Onsite - FL - Tallahassee' } });

  // Supervisors and anyone else paid without a rate on file get theirs.
  const unpriced = await db.associate.findMany({ where: { deletedAt: null, separatedAt: null, compRecords: { none: {} }, OR: [{ assignments: { some: { endedAt: null } } }, { applications: { some: { status: 'APPROVED', deletedAt: null } } }] }, select: { id: true, email: true, hireDate: true } });
  for (const a of unpriced) {
    const amount = a.email === 'dana.reyes@altohr.com' ? 22 : a.email === 'floor.demo@altohr.com' ? 20 : 15;
    await db.compensationRecord.create({ data: { id: sid(`comp|${a.id}`), associateId: a.id, effectiveFrom: a.hireDate ?? dateOf('2026-01-05'), payType: 'HOURLY', amount, reason: 'HIRE', actorUserId: adminId, notes: amount > 18 ? 'Supervisor rate' : 'Rate card for the position' } });
    count('compensation');
  }

  // Everyone in the pay population (the supervisors too) has a home state and a payout method.
  const payees = await db.associate.findMany({ where: { deletedAt: null, separatedAt: null, OR: [{ assignments: { some: { endedAt: null } } }, { applications: { some: { status: 'APPROVED', deletedAt: null } } }] }, select: { id: true, state: true, city: true, addressLine1: true, hireDate: true, payoutMethods: { where: { retiredAt: null }, select: { id: true } } } });
  for (const a of payees) {
    if (!a.state || !a.addressLine1) {
      await db.associate.update({ where: { id: a.id }, data: { state: a.state ?? 'FL', city: a.city ?? 'Panama City Beach', zip: '32413', addressLine1: a.addressLine1 ?? `${intBy(a.id, 200, 9800)} ${pickBy(a.id, ['Thomas Dr', 'Back Beach Rd', 'Hutchison Blvd', 'Front Beach Rd'])}` } });
    }
    if (a.payoutMethods.length === 0) {
      const routing = '063100277';
      const account = String(intBy(`acct|${a.id}`, 1_000_000_000, 9_999_999_999));
      await db.payoutMethod.create({ data: { id: sid(`payout|${a.id}`), associateId: a.id, type: 'BANK_ACCOUNT', routingNumberEnc: Buffer.from(routing, 'utf8'), accountNumberEnc: encryptString(account), accountType: 'CHECKING', bankName: 'Bank of America', accountLast4: account.slice(-4), accountFingerprint: accountFingerprint(routing, account), isPrimary: true, verifiedAt: a.hireDate ?? dateOf('2026-01-05'), verifiedById: adminId } });
      count('payoutMethods');
    }
  }

  // Weekly VMS timesheets: every finished week entered before Monday 2 PM Pacific
  // and approved by the buyer; the week just ended is being entered this morning.
  const lastFriday = addDays(todayKey, -((weekdayOf(todayKey) + 2) % 7 || 7));
  for (let w = 6; w >= 0; w--) {
    const weekEnd = addDays(lastFriday, -7 * w);
    const weekStart = addDays(weekEnd, -6);
    const due = fieldglassDueAt(weekEnd);
    const latest = w === 0;
    const rows = await db.timeEntry.groupBy({
      by: ['associateId', 'clientId'],
      where: { status: { in: ['APPROVED', 'COMPLETED'] }, clientId: { in: stores.map((s) => s.clientId) }, clockInAt: { gte: utcInstantOfLocalMidnight(weekStart, 'America/Chicago'), lt: utcInstantOfLocalMidnight(addDays(weekEnd, 1), 'America/Chicago') } },
      _count: { _all: true },
    });
    for (const r of rows) {
      if (!r.clientId) continue;
      const id = sid(`vms|${r.associateId}|${weekStart}`);
      if (await db.fieldglassTimesheet.findFirst({ where: { OR: [{ id }, { associateId: r.associateId, clientId: r.clientId, weekStart: dateOf(weekStart) }] }, select: { id: true } })) continue;
      // The hours as the timesheet shows them (worked minus unpaid breaks).
      const entries = await db.timeEntry.findMany({ where: { associateId: r.associateId, clientId: r.clientId, clockOutAt: { not: null }, clockInAt: { gte: utcInstantOfLocalMidnight(weekStart, 'America/Chicago'), lt: utcInstantOfLocalMidnight(addDays(weekEnd, 1), 'America/Chicago') } }, select: { clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true, type: true } } } });
      const hours = Math.round(entries.reduce((sum, e) => sum + (e.clockOutAt!.getTime() - e.clockInAt.getTime()) / HOUR - e.breaks.filter((b) => b.type === 'MEAL' && b.endedAt).reduce((x, b) => x + (b.endedAt!.getTime() - b.startedAt.getTime()) / HOUR, 0), 0) * 100) / 100;
      if (hours <= 0) continue;
      let enteredAt = new Date(due.getTime() - intBy(`vms-at|${id}`, 2, 9) * HOUR);
      if (latest && due > NOW) {
        // This morning's batch: most are in, a few are left for finance before the cut-off.
        if (frac(`vms-left|${id}`) < 0.25) continue;
        enteredAt = minDate(enteredAt, new Date(NOW.getTime() - intBy(`vms-ago|${id}`, 10, 120) * MIN));
      }
      const fgStatus = latest ? 'SUBMITTED' : w === 1 ? 'APPROVED' : 'INVOICED';
      await db.fieldglassTimesheet.create({ data: { id, weekStart: dateOf(weekStart), associateId: r.associateId, clientId: r.clientId, enteredAt, enteredById: financeId, enteredHours: hours, fgHours: hours, fgStatus, fgRevision: 1, fgTimesheetId: `TS${intBy(`ts|${id}`, 10_000_000, 99_999_999)}`, fgSyncedAt: minDate(new Date(enteredAt.getTime() + 3 * HOUR), NOW), createdAt: enteredAt } });
      count('vmsTimesheets');
    }
  }
  // Older rows the buyer bounced or never answered were fixed and approved long ago.
  const stuck = await db.fieldglassTimesheet.updateMany({ where: { NOT: { id: MINE }, fgStatus: { in: ['REJECTED', 'SUBMITTED'] }, weekStart: { lt: dateOf(addDays(lastFriday, -13)) } }, data: { fgStatus: 'APPROVED', resubmittedAt: new Date(NOW.getTime() - 30 * DAY), note: 'Corrected hours resubmitted; approved by the buyer.' } });
  count('vmsFixed', stuck.count);

  // The books open with the cash the company had going into the quarter.
  try {
    await postEntry(db, {
      date: '2026-07-01', memo: 'Opening balances — operating and payroll checking', source: 'OPENING', sourceKey: 'demo:opening-balance', createdById: financeId,
      lines: [{ account: 'CASH_OPERATING', debit: 185_000 }, { account: 'CASH_PAYROLL', debit: 65_000 }, { account: 'OWNER_EQUITY', credit: 250_000 }],
    });
  } catch (err) {
    log(`  opening balance not posted: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Robotics is switched on for the demo tenant: two simulated service robots
 * on the Front Beach floor, commissioned, checked before each shift, with a
 * day of fleet readings that rolls with today.
 */
async function ensureRobots(fb: StoreRow, todayKey: string, adminId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({ where: { id: ALTO_TENANT_ID }, select: { modules: true } });
  if (!(tenant?.modules as Record<string, boolean> | null)?.robotics) return;
  const { registerSimulatedRobot, simulatedStatus } = await import('../src/lib/fleet/index.js');
  const dana = (await user('dana.reyes@altohr.com')) ?? { id: adminId };
  const templateId = sid('robot-checklist|front-beach');
  if (!(await db.robotChecklistTemplate.findUnique({ where: { id: templateId }, select: { id: true } }))) {
    await db.robotChecklistTemplate.create({
      data: { id: templateId, tenantId: ALTO_TENANT_ID, locationId: fb.id, name: 'Front Beach pre-shift', items: [{ key: 'estop', label: 'Emergency stop button tested', required: true }, { key: 'sensors', label: 'Bump and cliff sensors clear', required: true }, { key: 'trays', label: 'Trays or tank clean and locked', required: true }, { key: 'route', label: 'Route free of cables and mats', required: false }] },
    });
    await db.siteSafetyZone.createMany({
      data: [
        { id: sid('zone|front-beach|front-end'), tenantId: ALTO_TENANT_ID, locationId: fb.id, name: 'Front end and registers', shape: { type: 'rect', x: 0, y: 0, w: 20, h: 15 } },
        { id: sid('zone|front-beach|receiving'), tenantId: ALTO_TENANT_ID, locationId: fb.id, name: 'Receiving dock', shape: { type: 'rect', x: 30, y: 30, w: 25, h: 20 }, robotsAllowedWhenOccupied: false },
      ],
      skipDuplicates: true,
    });
  }
  const specs = [
    { key: 'scrubber', name: 'Scrubber 01', externalId: 'sim-cc1-fb-01', manufacturer: 'Pudu Robotics', model: 'CC1', serial: 'PD-CC1-2026-0088', firmware: '2.9.0', capabilities: ['floor-care'] },
    { key: 'scanner', name: 'Shelf Scanner 02', externalId: 'sim-scan-fb-02', manufacturer: 'Simbe', model: 'Tally', serial: 'SB-TL-2026-0311', firmware: '5.1.4', capabilities: ['shelf-scanning'] },
  ];
  for (const spec of specs) {
    registerSimulatedRobot(spec.externalId);
    const workerId = sid(`robot|${spec.key}`);
    if (!(await db.worker.findUnique({ where: { id: workerId }, select: { id: true } }))) {
      const since = new Date(NOW.getTime() - 60 * DAY);
      await db.worker.create({ data: { id: workerId, tenantId: ALTO_TENANT_ID, type: 'ROBOT', name: spec.name, ownerUserId: adminId, status: 'ACTIVE', capabilities: spec.capabilities, createdAt: since } });
      await db.robotProfile.create({ data: { workerId, tenantId: ALTO_TENANT_ID, manufacturer: spec.manufacturer, model: spec.model, serial: spec.serial, firmware: spec.firmware, connectorProvider: 'SIMULATED', connectorExternalId: spec.externalId, certifications: [{ name: 'UL 3300 service robot safety', issuedOn: '2026-02-10', expiresOn: '2028-02-10' }] } });
      await db.workerAssignment.create({ data: { workerId, locationId: fb.id, startedAt: since } });
      await db.robotCommissioning.create({ data: { workerId, tenantId: ALTO_TENANT_ID, locationId: fb.id, mapNotes: 'Sales floor, aisles 1–12 and the front end; charging dock behind receiving.', chargingStations: [{ label: 'Dock A · behind receiving', x: 2, y: 48 }], safetyLeadUserId: dana.id, signedOffAt: new Date(since.getTime() + 5 * DAY), createdAt: since } });
      await db.robotEvent.createMany({ data: [{ workerId, tenantId: ALTO_TENANT_ID, kind: 'COMMISSIONED', at: new Date(since.getTime() + 5 * DAY), byUserId: dana.id, note: 'Commissioned at Front Beach 218' }] });
      await db.robotMaintenance.create({ data: { workerId, tenantId: ALTO_TENANT_ID, performedOn: new Date(NOW.getTime() - 20 * DAY), kind: 'Firmware update', description: `Updated to ${spec.firmware}; recalibrated the sensors after the update.`, performedBy: 'Vendor field tech', nextDueOn: new Date(NOW.getTime() + 70 * DAY) } });
      count('robots');
    }
    // A day of fleet readings, every five minutes, up to now.
    const samples = [];
    const start = Math.floor((NOW.getTime() - DAY) / (5 * MIN)) * 5 * MIN;
    for (let t = start; t <= NOW.getTime(); t += 5 * MIN) {
      const at = new Date(t);
      const st = simulatedStatus(spec.externalId, at);
      samples.push({ id: sid(`robot-sample|${workerId}|${t}`), workerId, tenantId: ALTO_TENANT_ID, at, status: st.status, batteryPct: st.batteryPct, x: st.x, y: st.y, currentTask: st.currentTask, errorCode: st.errorCode });
    }
    await db.robotStatusSample.createMany({ data: samples, skipDuplicates: true });
    // Checked before the shift, yesterday and today.
    for (const day of [addDays(todayKey, -1), todayKey]) {
      const completedAt = wallToUtc(day, 5 * 60 + 40, fb.tz);
      if (completedAt > NOW) continue;
      const runId = sid(`robot-check|${workerId}|${day}`);
      if (await db.robotChecklistRun.findUnique({ where: { id: runId }, select: { id: true } })) continue;
      await db.robotChecklistRun.create({ data: { id: runId, workerId, tenantId: ALTO_TENANT_ID, templateId, completedByUserId: dana.id, completedAt, allPassed: true, answers: [{ key: 'estop', ok: true }, { key: 'sensors', ok: true }, { key: 'trays', ok: true }, { key: 'route', ok: true }] } });
      await db.robotEvent.create({ data: { id: sid(`robot-check-event|${workerId}|${day}`), workerId, tenantId: ALTO_TENANT_ID, kind: 'CHECKLIST_COMPLETED', at: completedAt, byUserId: dana.id, note: 'Front Beach pre-shift: all clear' } });
    }
  }
}

/** What waits on the manager: a couple of time-off requests from their team. */
async function ensureTeamAsks(people: Person[], todayKey: string): Promise<void> {
  const asks: Array<{ name: string; inDays: number; days: number; category: 'VACATION' | 'PTO' | 'OTHER'; reason: string }> = [
    { name: 'Leo Ramos', inDays: 9, days: 2, category: 'VACATION', reason: 'Cousin’s wedding in Mobile' },
    { name: 'Nia Carter', inDays: 16, days: 1, category: 'PTO', reason: 'Moving apartments' },
  ];
  for (const a of asks) {
    const p = people.find((x) => x.name === a.name);
    if (!p) continue;
    const id = sid(`time-off|${p.id}|${a.reason}`);
    if (await db.timeOffRequest.findUnique({ where: { id }, select: { id: true } })) continue;
    const start = addDays(todayKey, a.inDays);
    await db.timeOffRequest.create({ data: { id, associateId: p.id, category: a.category, startDate: dateOf(start), endDate: dateOf(addDays(start, a.days - 1)), requestedMinutes: a.days * 8 * 60, reason: a.reason, status: 'PENDING', createdAt: new Date(NOW.getTime() - intBy(id, 3, 30) * HOUR) } });
    count('timeOffAsks');
  }
}


// ---------------------------------------------------------------------------
// 9. Compliance: every placed person's file complete; the vault; the Trust Center
// ---------------------------------------------------------------------------

/** A plain one-page PDF (Helvetica), for the documents the demo shows. */
async function simplePdf(title: string, lines: string[]): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'LETTER', margin: 64, info: { Title: title, Author: 'Alto HR' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.font('Helvetica-Bold').fontSize(18).text(title);
  doc.moveDown(0.8).font('Helvetica').fontSize(11);
  for (const l of lines) doc.text(l).moveDown(0.5);
  doc.end();
  return done;
}

async function storeFile(key: string, body: Buffer, mime: string): Promise<string> {
  const { getBlobStore, tenantBlobKey } = await import('../src/lib/blobStore.js');
  const full = tenantBlobKey(key);
  await getBlobStore().put(full, body, mime);
  return full;
}

async function ensureCompliance(todayKey: string, adminId: string): Promise<void> {
  const placed = await db.associate.findMany({
    where: { tenantId: ALTO_TENANT_ID, deletedAt: null, separatedAt: null, deactivatedAt: null, erasedAt: null, OR: [{ assignments: { some: { endedAt: null } } }, { applications: { some: { status: 'APPROVED', deletedAt: null } } }] },
    select: {
      id: true, firstName: true, lastName: true, hireDate: true, dob: true,
      i9Verification: { select: { id: true, section1CompletedAt: true, section2CompletedAt: true, eVerifyStatus: true, workAuthExpiresAt: true } },
      w4Submission: { select: { id: true } },
      backgroundChecks: { select: { status: true } },
      assignments: { where: { endedAt: null }, select: { location: { select: { clientId: true } } }, take: 1 },
    },
  });
  const policies = await db.policy.findMany({ where: { clientId: null, deletedAt: null, requiredForOnboarding: true }, select: { id: true } });
  const docs = await db.documentRecord.findMany({ where: { associateId: { in: placed.map((p) => p.id) }, deletedAt: null }, select: { associateId: true, kind: true, createdAt: true, expiresAt: true, id: true } });
  const docsOf = (id: string, kind: string) => docs.filter((d) => d.associateId === id && d.kind === kind);
  const acks = new Set((await db.policyAcknowledgment.findMany({ where: { associateId: { in: placed.map((p) => p.id) } }, select: { associateId: true, policyId: true } })).map((a) => `${a.associateId}|${a.policyId}`));
  const reportPdf = await simplePdf('Screening report', ['Result: clear.', 'This is a demo record on the Alto People demo database.']);
  const drugPdf = await simplePdf('Drug screen result', ['10-panel urine screen — negative.', 'Collected at the Panama City Beach patient service center.', 'This is a demo record on the Alto People demo database.']);
  const bgKey = await storeFile('demo/background-check-report.pdf', reportPdf, 'application/pdf');
  const drugKey = await storeFile('demo/drug-screen-result.pdf', drugPdf, 'application/pdf');

  for (const p of placed) {
    const hire = p.hireDate ?? new Date(NOW.getTime() - 30 * DAY);
    const before = (days: number) => new Date(hire.getTime() - days * DAY + 14 * HOUR);
    const clientId = p.assignments[0]?.location.clientId ?? null;
    if (!p.dob) {
      await db.associate.update({ where: { id: p.id }, data: { dob: dateOf(`${intBy(`${p.id}|y`, 1975, 2000)}-${pad(intBy(`${p.id}|m`, 1, 12))}-${pad(intBy(`${p.id}|d`, 1, 28))}`) } });
      count('birthDates');
    }
    // I-9, both sections, E-Verify closed as authorized.
    const s2 = new Date(Math.min(hire.getTime() + DAY + 15 * HOUR, NOW.getTime() - HOUR));
    if (!p.i9Verification) {
      await db.i9Verification.create({
        data: {
          id: sid(`i9|${p.id}`), associateId: p.id, section1CompletedAt: before(6), section1TypedName: `${p.firstName} ${p.lastName}`, citizenshipStatus: 'US_CITIZEN', documentsSubmittedAt: before(6),
          section2VerifierUserId: adminId, section2CompletedAt: s2, documentList: pickBy(`i9list|${p.id}`, ['LIST_A', 'LIST_B_AND_C'] as const),
          eVerifyCaseNumber: `${s2.getUTCFullYear()}${String(intBy(`ev|${p.id}`, 100_000_000, 999_999_999))}`, eVerifyCaseOpenedAt: s2, eVerifyStatus: 'EMPLOYMENT_AUTHORIZED', eVerifyClosedAt: new Date(s2.getTime() + 20 * HOUR), createdAt: before(6),
        },
      });
      count('i9Completed');
    } else if (!p.i9Verification.section1CompletedAt || !p.i9Verification.section2CompletedAt || p.i9Verification.eVerifyStatus !== 'EMPLOYMENT_AUTHORIZED') {
      await db.i9Verification.update({
        where: { id: p.i9Verification.id },
        data: {
          ...(p.i9Verification.section1CompletedAt ? {} : { section1CompletedAt: before(6), section1TypedName: `${p.firstName} ${p.lastName}`, citizenshipStatus: 'US_CITIZEN', documentsSubmittedAt: before(6) }),
          ...(p.i9Verification.section2CompletedAt ? {} : { section2CompletedAt: s2, section2VerifierUserId: adminId, documentList: 'LIST_A' }),
          eVerifyStatus: 'EMPLOYMENT_AUTHORIZED', eVerifyCaseNumber: `${s2.getUTCFullYear()}${String(intBy(`ev|${p.id}`, 100_000_000, 999_999_999))}`, eVerifyCaseOpenedAt: s2, eVerifyClosedAt: new Date(s2.getTime() + 20 * HOUR),
        },
      });
      count('i9Completed');
    }
    if (p.i9Verification?.workAuthExpiresAt && p.i9Verification.workAuthExpiresAt.getTime() < NOW.getTime() + 120 * DAY) {
      await db.i9Verification.update({ where: { id: p.i9Verification.id }, data: { workAuthExpiresAt: dateOf(addDays(todayKey, intBy(`wa|${p.id}`, 200, 700))) } });
    }
    if (!p.w4Submission) {
      await db.w4Submission.create({ data: { id: sid(`w4|${p.id}`), associateId: p.id, filingStatus: pickBy(`w4|${p.id}`, ['SINGLE', 'SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD'] as const), dependentsAmount: frac(`dep|${p.id}`) < 0.3 ? 2000 : 0, signedAt: before(5), createdAt: before(5) } as never });
      count('w4s');
    }
    if (!p.backgroundChecks.some((b) => b.status === 'PASSED')) {
      await db.backgroundCheck.create({ data: { id: sid(`bg|${p.id}`), associateId: p.id, clientId, provider: 'Checkr', externalId: `chk_${sid(`chk|${p.id}`).slice(9, 21)}`, status: 'PASSED', initiatedAt: before(12), completedAt: before(9) } });
      count('backgroundChecks');
    }
    if (docsOf(p.id, 'BACKGROUND_CHECK_RESULT').length === 0) {
      await db.documentRecord.create({ data: { id: sid(`bgdoc|${p.id}`), associateId: p.id, clientId, kind: 'BACKGROUND_CHECK_RESULT', s3Key: bgKey, filename: 'background-check-report.pdf', mimeType: 'application/pdf', size: reportPdf.byteLength, status: 'VERIFIED', verifiedById: adminId, verifiedAt: before(9), createdAt: before(9) } });
    }
    // The client wants a drug screen inside 60 days: the crew retests each month.
    const latestDrug = docsOf(p.id, 'DRUG_TEST_RESULT').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!latestDrug || latestDrug.createdAt.getTime() < NOW.getTime() - 27 * DAY) {
      const testedKey = addDays(todayKey, -intBy(`drug|${p.id}|${todayKey.slice(0, 7)}`, 3, 18));
      const at = new Date(dateOf(testedKey).getTime() + 15 * HOUR);
      await db.drugTest.create({ data: { id: sid(`drug|${p.id}|${testedKey}`), associateId: p.id, clientId, provider: 'Quest Diagnostics', externalId: `qd-${intBy(`qd|${p.id}|${testedKey}`, 100000, 999999)}`, status: 'PASSED', initiatedAt: new Date(at.getTime() - 2 * DAY), completedAt: at } }).catch(() => undefined);
      await db.documentRecord.create({ data: { id: sid(`drugdoc|${p.id}|${testedKey}`), associateId: p.id, clientId, kind: 'DRUG_TEST_RESULT', s3Key: drugKey, filename: 'drug-screen-result.pdf', mimeType: 'application/pdf', size: drugPdf.byteLength, status: 'VERIFIED', verifiedById: adminId, verifiedAt: at, createdAt: at } }).catch(() => undefined);
      count('drugScreens');
    }
    // Identity documents on file, none about to expire.
    if (docsOf(p.id, 'ID').length === 0) {
      await db.documentRecord.create({ data: { id: sid(`iddoc|${p.id}`), associateId: p.id, clientId, kind: 'ID', filename: 'drivers-license.jpg', mimeType: 'image/jpeg', size: intBy(`idsz|${p.id}`, 180_000, 420_000), status: 'VERIFIED', expiresAt: dateOf(addDays(todayKey, intBy(`idexp|${p.id}`, 220, 1400))), verifiedById: adminId, verifiedAt: before(7), createdAt: before(8) } });
      count('idDocuments');
    }
    for (const d of docs.filter((x) => x.associateId === p.id && x.expiresAt && x.expiresAt.getTime() < NOW.getTime() + 35 * DAY)) {
      await db.documentRecord.update({ where: { id: d.id }, data: { expiresAt: dateOf(addDays(todayKey, intBy(`renew|${d.id}`, 120, 900))) } });
      count('expiringRenewed');
    }
    for (const pol of policies) {
      if (acks.has(`${p.id}|${pol.id}`)) continue;
      await db.policyAcknowledgment.create({ data: { policyId: pol.id, associateId: p.id, clientId, acknowledgedAt: before(5) } }).catch(() => undefined);
      count('policyAcks');
    }
  }

  // Safety: an injury with days away is closed out once the person is back and the fix is in.
  const awayOpen = await db.oshaIncident.findMany({ where: { severity: 'DAYS_AWAY', status: { in: ['REPORTED', 'INVESTIGATING', 'ESCALATED'] }, occurredAt: { lt: new Date(NOW.getTime() - 7 * DAY) } }, select: { id: true, occurredAt: true } });
  for (const i of awayOpen) {
    await db.oshaIncident.update({ where: { id: i.id }, data: { status: 'RESOLVED', resolvedAt: new Date(i.occurredAt.getTime() + 6 * DAY), resolutionNote: 'Back on full duty after four days; cut-resistant gloves issued at the carton station and the crew retrained on box cutters.' } as never });
    count('incidentsClosed');
  }

  // The vault: a few new uploads waiting on HR (renewals, a food handler card, a direct deposit form).
  const vault: Array<{ name: string; kind: 'ID' | 'OTHER' | 'I9_SUPPORTING'; file: string; title: string; lines: string[]; daysAgo: number }> = [
    { name: 'Hannah Kowalski', kind: 'OTHER', file: 'food-handler-card.pdf', title: 'Florida food handler certificate', lines: ['Hannah Kowalski — certificate of completion, food handler training (ANSI accredited).', 'Valid for three years from the date of issue.'], daysAgo: 1 },
    { name: 'Mehmet Yılmaz', kind: 'I9_SUPPORTING', file: 'employment-authorization-card.pdf', title: 'Employment authorization document (renewal)', lines: ['Renewed employment authorization card, uploaded for reverification.', 'Category C09 — valid through two years from issue.'], daysAgo: 2 },
    { name: 'Tamika Freeman', kind: 'OTHER', file: 'direct-deposit-form.pdf', title: 'Direct deposit authorization', lines: ['Change of bank account for net pay, signed by the associate.', 'Effective with the next pay period.'], daysAgo: 0 },
    { name: 'Kendra Toussaint', kind: 'ID', file: 'state-id.pdf', title: 'Florida identification card', lines: ['Front and back of a Florida identification card, uploaded at onboarding.'], daysAgo: 3 },
  ];
  for (const v of vault) {
    const [first, ...rest] = v.name.split(' ');
    const a = await db.associate.findFirst({ where: { firstName: first!, lastName: rest.join(' '), deletedAt: null }, select: { id: true } });
    if (!a) continue;
    const id = sid(`vault|${v.file}|${a.id}`);
    if (await db.documentRecord.findUnique({ where: { id }, select: { id: true } })) continue;
    const pdf = await simplePdf(v.title, v.lines);
    const key = await storeFile(`demo/vault/${a.id}/${v.file}`, pdf, 'application/pdf');
    await db.documentRecord.create({ data: { id, associateId: a.id, kind: v.kind, s3Key: key, filename: v.file, mimeType: 'application/pdf', size: pdf.byteLength, status: 'UPLOADED', createdAt: new Date(NOW.getTime() - v.daysAgo * DAY - intBy(id, 1, 9) * HOUR) } });
    count('vaultUploads');
  }

  // The desk's own attestations for the current period, signed by the admin.
  for (const config of ATTESTATION_CONFIGS) {
    const { periodStart, periodEnd } = periodForNow(config.cadence, NOW);
    const found = await db.manualComplianceAttestation.findFirst({ where: { key: config.key, periodStart }, select: { id: true } });
    if (found) continue;
    await db.manualComplianceAttestation.create({ data: { key: config.key, periodStart, periodEnd, outcome: 'YES', attestedById: adminId, attestedAt: maxDate(new Date(periodStart.getTime() + 9 * HOUR), new Date(Math.min(NOW.getTime() - HOUR, periodStart.getTime() + 2 * DAY))), actionTakenAt: maxDate(periodStart, new Date(Math.min(NOW.getTime() - HOUR, periodStart.getTime() + 2 * DAY))), notes: 'Reviewed on the compliance desk.' } });
    count('attestations');
  }
}

async function ensureTrustCenter(adminId: string): Promise<void> {
  const { COMPLIANCE_CONTROLS } = await import('@alto-people/shared');
  // Evidence for every control: fresh, passing, signed off where a person must sign.
  // On a demo database these are demo rows (collected by "demo-seed"); the
  // server's own hourly sweep replaces the ones it measures after 20 hours.
  for (const c of COMPLIANCE_CONTROLS) {
    const latest = await db.complianceEvidence.findFirst({ where: { control: c.id }, orderBy: { collectedAt: 'desc' }, include: { signoffs: { select: { id: true } } } });
    const ageDays = latest ? (NOW.getTime() - latest.collectedAt.getTime()) / DAY : Infinity;
    const ok = latest && ageDays <= Math.max(1, c.freshnessDays - 1) && latest.status !== 'FAIL' && (c.needsSignoff ? latest.signoffs.length > 0 : latest.status === 'PASS');
    if (ok) continue;
    const collectedAt = new Date(NOW.getTime() - intBy(`ev|${c.id}`, 20, 160) * MIN);
    const row = await db.complianceEvidence.create({
      data: { tenantId: null, control: c.id, status: 'PASS', summary: `${c.plain} Checked on the demo database.`.slice(0, 500), details: { demo: true }, collectedBy: 'demo-seed', collectedAt },
    });
    if (c.needsSignoff) await db.complianceEvidenceSignoff.create({ data: { tenantId: null, evidenceId: row.id, signedOffById: adminId, note: 'Reviewed and signed off.', createdAt: new Date(collectedAt.getTime() + 15 * MIN) } });
    count('evidenceRows');
  }
  // The documents a prospect's security review asks for.
  const trustDocs: Array<{ kind: 'SOC2_REPORT' | 'PEN_TEST_SUMMARY' | 'SUB_PROCESSOR_LIST' | 'DPA'; title: string; lines: string[] }> = [
    { kind: 'SOC2_REPORT', title: 'SOC 2 Type II report — summary', lines: ['Alto HR — independent service auditor’s report on controls relevant to security, availability and confidentiality.', 'Observation period: twelve months. Opinion: unqualified.', 'Full report available under NDA.'] },
    { kind: 'PEN_TEST_SUMMARY', title: 'Penetration test — executive summary', lines: ['External and authenticated application testing of the Alto People web app and API.', 'No critical or high findings open; two medium findings remediated and retested.'] },
    { kind: 'SUB_PROCESSOR_LIST', title: 'Sub-processors', lines: ['Railway — application hosting (United States).', 'Neon — PostgreSQL database with point-in-time recovery (United States).', 'Amazon Web Services — encrypted document, photo and backup storage (United States).', 'Resend — transactional email. Meta — WhatsApp messages to workers who opted in.', 'Stripe — invoicing and payment collection. Intuit — QuickBooks sync when a customer connects it.', 'Sentry — error monitoring. GitHub — source control, CI and the encrypted database backup job.'] },
    { kind: 'DPA', title: 'Data processing agreement', lines: ['Standard data processing agreement for Alto People customers.', 'Covers processing purposes, security measures, sub-processors, breach notice and deletion on termination.'] },
  ];
  for (const d of trustDocs) {
    const found = await db.trustDocument.findFirst({ where: { tenantId: ALTO_TENANT_ID, kind: d.kind }, select: { id: true } });
    if (found) continue;
    const pdf = await simplePdf(d.title, d.lines);
    const key = await storeFile(`trust/${d.kind.toLowerCase()}.pdf`, pdf, 'application/pdf');
    await db.trustDocument.create({ data: { id: sid(`trust|${d.kind}`), tenantId: ALTO_TENANT_ID, kind: d.kind, title: d.title, s3Key: key, contentType: 'application/pdf', bytes: pdf.byteLength, uploadedByUserId: adminId } });
    count('trustDocuments');
  }
}

// ---------------------------------------------------------------------------
// 10. Transport: the vans run the Front Beach crew from housing and back
// ---------------------------------------------------------------------------

const RIDERS: Array<{ name: string; stop: 'Seaside Housing' | 'Gulf Pines Apartments' }> = [
  { name: 'Maria Lopez', stop: 'Seaside Housing' },
  { name: 'Hannah Kowalski', stop: 'Seaside Housing' },
  { name: 'Jean-Baptiste Pierre', stop: 'Gulf Pines Apartments' },
  { name: 'Tamika Freeman', stop: 'Gulf Pines Apartments' },
  { name: 'Mehmet Yılmaz', stop: 'Seaside Housing' },
  { name: 'Luis Ortega', stop: 'Gulf Pines Apartments' },
  { name: 'Kayla Robinson', stop: 'Seaside Housing' },
];

async function ensureTransport(stores: StoreRow[], todayKey: string, adminId: string): Promise<void> {
  const fb = stores.find((s) => s.spec.key === 'front-beach');
  const driver = await user('driver@altohr.com');
  const director = (await user('transport@altohr.com')) ?? { id: adminId };
  const vans = await db.van.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const stops = await db.transportStop.findMany({ select: { id: true, name: true, address: true, lat: true, lng: true } });
  const rate = await db.transportRate.findFirst({ orderBy: { effectiveFrom: 'desc' }, select: { fareCents: true, noShowFeeCents: true } });
  if (!fb || !driver || vans.length === 0 || stops.length === 0 || !rate) {
    log('  transport skipped (no driver, van, stop or rate on this database).');
    return;
  }
  // Runs in the past that were planned and never driven read as broken: they were cancelled.
  const stale = await db.rideRun.updateMany({ where: { NOT: { id: MINE }, status: 'PLANNED', departAt: { lt: new Date(NOW.getTime() - DAY) } }, data: { status: 'CANCELLED', notes: 'Cancelled — the riders were covered by another run.' } });
  await db.ride.updateMany({ where: { NOT: { id: MINE }, status: { in: ['REQUESTED', 'SCHEDULED'] }, targetAt: { lt: new Date(NOW.getTime() - DAY) } }, data: { status: 'CANCELLED', cancelledAt: new Date(NOW.getTime() - DAY), cancelReason: 'Run cancelled' } });
  count('staleRunsCancelled', stale.count);

  // Each rider has signed the ride authorization (payroll takes a fare only with one).
  const riders: Array<{ id: string; stop: (typeof stops)[number]; signatureId: string | null }> = [];
  for (const r of RIDERS) {
    const [first, ...rest] = r.name.split(' ');
    const a = await db.associate.findFirst({ where: { firstName: first!, lastName: rest.join(' '), deletedAt: null }, select: { id: true } });
    const stop = stops.find((s) => s.name === r.stop) ?? stops[0]!;
    if (!a) continue;
    let consent = await db.rideConsent.findUnique({ where: { associateId: a.id }, select: { signatureId: true, withdrawnAt: true } });
    if (!consent?.signatureId || consent.withdrawnAt) {
      const u = await db.user.findFirst({ where: { associateId: a.id }, select: { id: true } });
      try {
        await signRideAuthorization(db, { associateId: a.id, userId: u?.id ?? director.id, typedName: r.name, language: 'en', ipAddress: null, userAgent: 'Alto People kiosk' }, new Date(NOW.getTime() - 40 * DAY));
        count('rideAuthorizations');
      } catch (err) {
        log(`  ride authorization for ${r.name} not signed: ${err instanceof Error ? err.message : err}`);
      }
      consent = await db.rideConsent.findUnique({ where: { associateId: a.id }, select: { signatureId: true, withdrawnAt: true } });
    }
    riders.push({ id: a.id, stop, signatureId: consent?.signatureId ?? null });
  }

  const runSpecs: Array<{ key: string; direction: 'TO_WORK' | 'FROM_WORK'; window: WindowLabel; departMinute: number; van: number }> = [
    { key: 'am-in', direction: 'TO_WORK', window: 'Morning', departMinute: 5 * 60 + 15, van: 0 },
    { key: 'pm-in', direction: 'TO_WORK', window: 'Afternoon', departMinute: 13 * 60 + 15, van: 1 },
    { key: 'am-out', direction: 'FROM_WORK', window: 'Morning', departMinute: 14 * 60 + 10, van: 0 },
    { key: 'pm-out', direction: 'FROM_WORK', window: 'Afternoon', departMinute: 22 * 60 + 10, van: 1 },
  ];
  for (let d = -7; d <= 1; d++) {
    const key = addDays(todayKey, d);
    const dayShifts = await db.shift.findMany({
      where: { locationId: fb.id, assignedAssociateId: { in: riders.map((r) => r.id) }, startsAt: { gte: utcInstantOfLocalMidnight(key, fb.tz), lt: utcInstantOfLocalMidnight(addDays(key, 1), fb.tz) }, status: { in: ['ASSIGNED', 'COMPLETED'] }, noShowRecordedAt: null },
      select: { id: true, assignedAssociateId: true, startsAt: true, endsAt: true },
    });
    for (const spec of runSpecs) {
      const onRun = dayShifts.filter((s) => windowOfStart(s.startsAt, fb.tz) === spec.window).sort((a, b) => a.assignedAssociateId!.localeCompare(b.assignedAssociateId!));
      if (onRun.length === 0) continue;
      const departAt = wallToUtc(key, spec.departMinute, fb.tz);
      const runId = sid(`ride-run|${key}|${spec.key}`);
      const legMin = 12;
      const doneAt = new Date(departAt.getTime() + (onRun.length * legMin + 22) * MIN);
      const status = doneAt <= NOW ? 'COMPLETED' : departAt <= NOW ? 'ACTIVE' : 'PLANNED';
      const van = vans[spec.van % vans.length]!;
      const existing = await db.rideRun.findUnique({ where: { id: runId }, select: { status: true } });
      if (!existing) {
        await db.rideRun.create({ data: { id: runId, vanId: van.id, driverUserId: driver.id, direction: spec.direction, serviceDate: key, departAt, status, createdById: director.id, createdAt: new Date(departAt.getTime() - 2 * DAY), ...(status !== 'PLANNED' ? { startedAt: departAt } : {}), ...(status === 'COMPLETED' ? { endedAt: doneAt } : {}) } });
        count('rideRuns');
      } else if (existing.status !== status && existing.status !== 'COMPLETED' && existing.status !== 'CANCELLED') {
        await db.rideRun.update({ where: { id: runId }, data: { status, ...(status !== 'PLANNED' ? { startedAt: departAt } : {}), ...(status === 'COMPLETED' ? { endedAt: doneAt } : {}) } });
      }
      for (const [i, s] of onRun.entries()) {
        const rider = riders.find((r) => r.id === s.assignedAssociateId)!;
        const pickupAt = new Date(departAt.getTime() + (i * legMin + 8) * MIN);
        const id = sid(`ride|${runId}|${rider.id}`);
        const rideStatus = status === 'COMPLETED' ? 'COMPLETED' : status === 'ACTIVE' ? (pickupAt <= NOW ? 'BOARDED' : 'SCHEDULED') : 'SCHEDULED';
        const taken = rideStatus === 'COMPLETED' || rideStatus === 'BOARDED';
        const data = {
          status: rideStatus,
          ...(taken ? { boardedAt: pickupAt, chargeCents: rate.fareCents, authorizedSignatureId: rider.signatureId } : {}),
          ...(rideStatus === 'COMPLETED' ? { completedAt: doneAt } : {}),
        } as const;
        const ride = await db.ride.findUnique({ where: { id }, select: { status: true } });
        if (!ride) {
          await db.ride.create({
            data: {
              id, associateId: rider.id, direction: spec.direction, locationId: fb.id, stopId: rider.stop.id, address: rider.stop.address, lat: rider.stop.lat, lng: rider.stop.lng,
              targetAt: spec.direction === 'TO_WORK' ? s.startsAt : s.endsAt, serviceDate: key, shiftId: s.id, windowLabel: spec.window, runId, pickupOrder: i + 1, pickupAt,
              fareCents: rate.fareCents, noShowFeeCents: rate.noShowFeeCents, createdById: director.id, acceptedAt: new Date(departAt.getTime() - DAY), acceptedById: director.id,
              createdAt: new Date(departAt.getTime() - 2 * DAY), ...data,
            },
          });
          count('rides');
        } else if (ride.status !== rideStatus && ride.status !== 'COMPLETED' && ride.status !== 'CANCELLED' && ride.status !== 'NO_SHOW') {
          await db.ride.update({ where: { id }, data });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 11. The client's desk: requests answered, statements from approved time
// ---------------------------------------------------------------------------

async function ensureClientDesk(stores: StoreRow[], todayKey: string, adminId: string): Promise<void> {
  const fb = stores.find((s) => s.spec.key === 'front-beach');
  const dana = await user('dana.reyes@altohr.com');
  const portal = await user('portal@coastalresort.example');
  // Requests: none left waiting; the latest one answered within the day.
  const waiting = await db.clientRequest.findMany({ where: { status: { not: 'RESOLVED' }, NOT: { id: MINE } }, select: { id: true, createdAt: true, kind: true } });
  for (const r of waiting) {
    await db.clientRequest.update({ where: { id: r.id }, data: { status: 'RESOLVED', startedAt: new Date(r.createdAt.getTime() + 2 * HOUR), startedById: dana?.id ?? adminId, resolvedAt: new Date(r.createdAt.getTime() + 19 * HOUR), resolvedById: dana?.id ?? adminId, resolution: 'Done — two overnight stockers added for Friday; both confirmed on the schedule.' } });
    count('requestsAnswered');
  }
  if (fb && portal) {
    const id = sid('client-request|weekend-receiving');
    if (!(await db.clientRequest.findUnique({ where: { id }, select: { id: true } }))) {
      const createdAt = new Date(NOW.getTime() - 3 * DAY + 2 * HOUR);
      await db.clientRequest.create({
        data: {
          id, clientId: fb.clientId, locationId: fb.id, kind: 'STAFFING', subject: 'One more in receiving for Saturday’s truck', body: 'The holiday freight lands Saturday morning. Can we have an extra person in receiving from 6 to 10?',
          status: 'RESOLVED', createdByUserId: portal.id, createdAt, dueAt: new Date(createdAt.getTime() + 24 * HOUR), startedAt: new Date(createdAt.getTime() + 40 * MIN), startedById: dana?.id ?? adminId,
          resolvedAt: new Date(createdAt.getTime() + 5 * HOUR), resolvedById: dana?.id ?? adminId, resolution: 'Added Carlos Mendoza to receiving Saturday 6–10 AM; he has confirmed.',
        },
      });
      count('requestsAdded');
    }
  }

  // Statements: one a week per client, built from the week's approved time.
  // Every week but the latest is paid; the latest is due in two weeks.
  const lastFriday = addDays(todayKey, -((weekdayOf(todayKey) + 2) % 7 || 7));
  const clientIds = [...new Set(stores.map((s) => s.clientId))];
  for (const clientId of clientIds) {
    for (let w = 3; w >= 0; w--) {
      const end = addDays(lastFriday, -7 * w);
      const start = addDays(end, -6);
      const id = sid(`statement|${clientId}|${start}`);
      const existing = await db.clientStatement.findUnique({ where: { id }, select: { id: true, paidAt: true } });
      const finalizedAt = new Date(dateOf(addDays(end, 3)).getTime() + 14 * HOUR);
      const dueKey = addDays(end, 14);
      const latest = w === 0;
      if (!existing) {
        const snapshot = await computeStatementSnapshot(db, clientId, utcInstantOfLocalMidnight(start, 'America/Chicago'), utcInstantOfLocalMidnight(addDays(end, 1), 'America/Chicago'));
        const totals = (snapshot as unknown as { totals?: { amount?: number } }).totals;
        if (!totals || !totals.amount) continue;
        const number = 1000 + Math.round((dateOf(start).getTime() - dateOf('2025-01-04').getTime()) / (7 * DAY));
        await db.clientStatement.create({
          data: { id, clientId, periodStart: dateOf(start), periodEnd: dateOf(end), number, status: 'FINAL', snapshot: snapshot as unknown as Prisma.InputJsonValue, finalizedById: adminId, finalizedAt, dueAt: dateOf(dueKey), createdAt: finalizedAt },
        });
        count('statements');
      }
      if (!latest && !(existing?.paidAt)) {
        const paidAt = minDate(new Date(dateOf(addDays(dueKey, -intBy(`paid|${id}`, 2, 5))).getTime() + 16 * HOUR), new Date(NOW.getTime() - 6 * HOUR));
        await db.clientStatement.update({ where: { id }, data: { paidAt, paidById: adminId, paymentRef: `ACH ${end.replace(/-/g, '').slice(2)}`, reminderStage: 0 } }).catch(() => undefined);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 12. The modules a demo walks through: tasks, store ops, programs, the season
//     plan, help articles, cost centers, release notes
// ---------------------------------------------------------------------------

async function ensureWorkTasks(fb: StoreRow, todayKey: string, people: Person[]): Promise<void> {
  const dana = await user('dana.reyes@altohr.com');
  const crewWorkers = await db.worker.findMany({ where: { associateId: { in: people.filter((p) => p.store === fb).map((p) => p.id) } }, select: { id: true, associateId: true } });
  for (const [i, w] of crewWorkers.entries()) {
    const caps = i % 3 === 0 ? ['stocking', 'unloading', 'floor-care'] : i % 3 === 1 ? ['stocking', 'food-service'] : ['stocking', 'unloading'];
    await db.worker.update({ where: { id: w.id }, data: { capabilities: caps } });
  }
  const specs: Array<{ type: string; area: string; start: number; end: number; capability: string; risk: 'LOW' | 'MEDIUM' | 'HIGH'; minutes: number; reference: string | null }> = [
    { type: 'Unload the 6 AM truck', area: 'Receiving dock', start: 6 * 60, end: 8 * 60, capability: 'unloading', risk: 'HIGH', minutes: 90, reference: 'Truck 4471' },
    { type: 'Stock dairy and frozen', area: 'Aisles 1–4', start: 8 * 60, end: 11 * 60, capability: 'stocking', risk: 'LOW', minutes: 120, reference: null },
    { type: 'Scrub the front entrance', area: 'Entrance', start: 13 * 60, end: 15 * 60, capability: 'floor-care', risk: 'LOW', minutes: 45, reference: null },
    { type: 'Face the center aisles', area: 'Aisles 5–9', start: 14 * 60, end: 18 * 60, capability: 'stocking', risk: 'LOW', minutes: 60, reference: null },
    { type: 'Unload the afternoon produce truck', area: 'Receiving dock', start: 15 * 60, end: 17 * 60, capability: 'unloading', risk: 'HIGH', minutes: 75, reference: 'Truck 4502' },
    { type: 'Deli case breakdown', area: 'Deli', start: 20 * 60, end: 22 * 60, capability: 'food-service', risk: 'MEDIUM', minutes: 40, reference: null },
    { type: 'Overnight floor scrub', area: 'Sales floor', start: 23 * 60, end: 23 * 60 + 59, capability: 'floor-care', risk: 'LOW', minutes: 120, reference: null },
  ];
  for (const day of [addDays(todayKey, -1), todayKey]) {
    for (const [i, s] of specs.entries()) {
      const id = sid(`work-task|${fb.id}|${day}|${i}`);
      if (await db.workTask.findUnique({ where: { id }, select: { id: true } })) continue;
      const windowStart = wallToUtc(day, s.start, fb.tz);
      const windowEnd = wallToUtc(day, s.end, fb.tz);
      await db.workTask.create({ data: { id, type: s.type, locationId: fb.id, area: s.area, windowStart, windowEnd, capability: s.capability, risk: s.risk, estimatedMinutes: s.minutes, reference: s.reference, createdByUserId: dana?.id ?? null, createdAt: wallToUtc(day, 5 * 60 + 30, fb.tz) } });
      try {
        const detail = await autoAssign(db, id, dana?.id ?? null);
        if (detail.assignment && windowStart <= NOW) {
          await recordEvent(db, id, 'STARTED', null, null);
          if (windowEnd <= NOW || new Date(windowStart.getTime() + s.minutes * MIN) <= NOW) await recordEvent(db, id, 'DONE', null, null);
        }
      } catch (err) {
        log(`  task "${s.type}" not assigned: ${err instanceof Error ? err.message : err}`);
      }
      count('workTasks');
    }
  }
}

async function ensureStoreOps(fb: StoreRow, todayKey: string): Promise<void> {
  const dana = await user('dana.reyes@altohr.com');
  if (!dana) return;
  const shiftsSpec = [
    { label: 'Morning', template: 'Deli & Bakery — Morning', department: 'Deli & Bakery', period: 'MORNING' as const, position: 'Shift Lead', open: 6 * 60 + 10, close: 13 * 60 + 50 },
    { label: 'Afternoon', template: 'Frozen & Dairy — Evening & Receiving', department: 'Frozen & Dairy', period: 'EVENING' as const, position: 'Shift Lead', open: 14 * 60 + 10, close: 21 * 60 + 45 },
  ];
  for (let d = -7; d <= 0; d++) {
    const day = addDays(todayKey, d);
    for (const spec of shiftsSpec) {
      const openedAt = wallToUtc(day, spec.open, fb.tz);
      if (openedAt > NOW) continue;
      const closedAt = wallToUtc(day, spec.close, fb.tz);
      const template = await db.opsSopTemplate.findFirst({ where: { name: spec.template, active: true }, select: { id: true } });
      if (!template) continue;
      let shift = await db.opsShift.findFirst({ where: { locationId: fb.id, dateKey: day, windowLabel: spec.label }, select: { id: true, status: true } });
      if (!shift) {
        const created = await createOpsShift(db, { clientId: fb.clientId, openedById: dana.id, department: spec.department, period: spec.period, position: spec.position, templateId: template.id, locationId: fb.id, windowLabel: spec.label, dueAt: closedAt, startsAt: openedAt, now: openedAt, scheduledBetween: { from: openedAt, to: closedAt } });
        await db.opsShift.update({ where: { id: created.id }, data: { openedAt, dateKey: day } });
        shift = { id: created.id, status: created.status };
        count('opsShifts');
      }
      if (shift.status === 'CLOSED' || shift.status === 'CANCELLED') continue;
      const tasks = await db.opsTask.findMany({ where: { opsShiftId: shift.id }, orderBy: { order: 'asc' }, select: { id: true, responseType: true, tempMin: true, tempMax: true, dueAt: true, status: true, title: true } });
      const done = closedAt <= NOW;
      // The tasks whose time has come are done (all of them once the shift has closed).
      for (const [i, t] of tasks.entries()) {
        if (t.status === 'DONE') continue;
        const at = new Date(openedAt.getTime() + ((i + 1) / (tasks.length + 1)) * (closedAt.getTime() - openedAt.getTime()));
        if (!done && at > NOW) continue;
        const reading = t.responseType === 'TEMPERATURE' ? Math.round(((Number(t.tempMin ?? 33) + Number(t.tempMax ?? 38)) / 2 + (frac(`temp|${t.id}`) - 0.5)) * 10) / 10 : null;
        await db.opsTask.update({
          where: { id: t.id },
          data: {
            status: 'DONE', completedAt: at, completedById: dana.id,
            ...(t.responseType === 'YES_NO' || t.responseType === 'YES_NO_PARTIAL' ? { answerChoice: 'YES' } : {}),
            ...(t.responseType === 'NUMBER' ? { answerNumber: intBy(`num|${t.id}`, 2, 12) } : {}),
            ...(t.responseType === 'TEXT' ? { answerText: 'All set.' } : {}),
            ...(reading !== null ? { answerNumber: reading } : {}),
          },
        });
        if (t.responseType === 'TEMPERATURE' || t.responseType === 'PHOTO') {
          await db.opsTaskPhoto.create({ data: { id: sid(`ops-photo|${t.id}`), taskId: t.id, s3Key: 'tenants/00000000-0000-4000-8000-000000000001/demo/ops/gauge.jpg', filename: 'gauge.jpg', mimeType: 'image/jpeg', size: 84_000, uploadedById: dana.id, createdAt: at } }).catch(() => undefined);
        }
      }
      const total = tasks.length;
      const doneNow = await db.opsTask.count({ where: { opsShiftId: shift.id, status: 'DONE' } });
      await db.opsShift.update({ where: { id: shift.id }, data: { sopTotal: total, sopDone: doneNow, taskTotal: total, taskDone: doneNow, ...(done ? { status: 'CLOSED', closedAt, closedById: dana.id, closingSummary: 'Checklist complete; temperatures in range; handed over to the next shift.', handoverNone: true } : {}) } });
    }
  }
}

const KB_ARTICLES: Array<{ slug: string; title: string; category: string; tags: string[]; body: string }> = [
  {
    slug: 'when-is-payday',
    title: 'When is payday, and where is my pay stub?',
    category: 'Pay',
    tags: ['payroll', 'pay stub'],
    body: 'We pay every other Friday for the two weeks that ended the Friday before. A pay period runs Saturday through Friday.\n\nYour pay stub is in the app under Pay as soon as payroll is paid — open the latest one to see your hours, overtime, taxes and deductions. Tap Download for a PDF you can print or send to a landlord.\n\nIf your hours look wrong, tell your supervisor before payday and open a pay question from the stub. We fix a mistake on the next payroll at the latest.',
  },
  {
    slug: 'clock-in-and-out',
    title: 'How to clock in and out',
    category: 'Time',
    tags: ['time clock', 'kiosk'],
    body: 'Clock in on the store kiosk or in the app when you arrive, not before your shift starts. The app needs your location on the first punch of the day.\n\nTake your 30-minute meal break by tapping Start break and End break. Clock out before you leave the store.\n\nForgot a punch? Open Time, pick the day and tap Fix a punch. Your supervisor approves the change; it shows on your next pay stub.',
  },
  {
    slug: 'call-out-or-swap',
    title: 'Can’t make a shift? Call out or swap',
    category: 'Schedule',
    tags: ['call out', 'swap', 'attendance'],
    body: 'If you are sick or something comes up, tell us as early as you can: open your shift and tap I can’t make it, or send a WhatsApp message to the store line. Two hours’ notice or more is not counted as a late call-out.\n\nTo trade, tap Swap on the shift and pick a teammate who is free. When they say yes, your supervisor approves it and both schedules update.\n\nNot showing up without telling anyone (a no-call no-show) costs two attendance points.',
  },
  {
    slug: 'attendance-points',
    title: 'How attendance points work',
    category: 'Policies',
    tags: ['attendance', 'points'],
    body: 'Points keep scheduling fair for everyone. A late arrival (more than 7 minutes) is half a point; a call-out with less than two hours’ notice is one point; a no-call no-show is two points.\n\nPoints fall off after 90 days. At 6 points your supervisor sits down with you; at 8 points we review whether the schedule still works for you.\n\nApproved time off, jury duty and documented emergencies never count.',
  },
  {
    slug: 'request-time-off',
    title: 'Requesting time off',
    category: 'Time off',
    tags: ['time off', 'PTO'],
    body: 'Ask for time off in the app under Time off at least two weeks ahead when you can. Pick the days, a reason, and send it — your supervisor answers within two business days.\n\nPeak weekends (holidays and summer Saturdays) fill first, so ask early. Your balance shows on the same page.',
  },
  {
    slug: 'van-rides',
    title: 'Riding the Alto van',
    category: 'Transportation',
    tags: ['van', 'rides'],
    body: 'The van picks up at Seaside Housing and Gulf Pines Apartments about 45 minutes before the morning and afternoon shifts, and brings you back after.\n\nBook a ride in the app under Rides, or ask your supervisor to add you to the regular run. Be at the stop five minutes early — the driver waits two minutes.\n\nEach ride is $5, taken from your next paycheck after you sign the ride authorization once. A missed pickup costs $1.',
  },
  {
    slug: 'update-direct-deposit',
    title: 'Changing your bank account or address',
    category: 'Pay',
    tags: ['direct deposit', 'address'],
    body: 'Open Me, then Pay settings, to change your bank account or switch to the Branch card. A change made before Tuesday counts for that week’s payroll.\n\nMoved? Update your address under Me so your W-2 reaches you. Your new address also sets the right local tax.',
  },
  {
    slug: 'safety-at-work',
    title: 'Staying safe on the floor',
    category: 'Safety',
    tags: ['safety', 'OSHA'],
    body: 'Wear closed-toe, non-slip shoes on every shift. Use the step ladder, never a shelf, and ask a teammate to spot you on a pallet jack.\n\nReport any injury, even a small cut, to your supervisor the same day — we file it and make sure you are looked after. Spills get a cone right away.\n\nThe safety data sheets for cleaning products are in the binder at the receiving desk.',
  },
];

const RELEASE_NOTES: Array<{ day: string; items: Array<{ audience: 'ALL' | 'ADMIN' | 'ASSOCIATE' | 'SUPERVISOR' | 'DRIVER' | 'CLIENT'; en: string; es: string }> }> = [
  {
    day: '2026-09-24',
    items: [
      { audience: 'ADMIN', en: 'The org chart, two ways: the company with its reporting lines and open seats, and the field from region to crew.', es: 'El organigrama de dos formas: la empresa con sus líneas de reporte y puestos abiertos, y el campo de la región al equipo.' },
      { audience: 'SUPERVISOR', en: 'A missed punch is fixed with a tap, and the person behind a shift is one click away.', es: 'Una marcación olvidada se corrige con un toque, y la persona detrás de cada turno está a un clic.' },
      { audience: 'ASSOCIATE', en: 'Your onboarding asks when you can work, so your first schedule fits your week.', es: 'Tu incorporación pregunta cuándo puedes trabajar, para que tu primer horario se ajuste a tu semana.' },
    ],
  },
  {
    day: '2026-10-09',
    items: [
      { audience: 'ADMIN', en: 'Pay schedules a payroll team can run on: add a whole client, a site, a department or one person and see who moves before it happens.', es: 'Calendarios de pago listos para nómina: agrega un cliente, un sitio, un departamento o una persona y ve quién cambia antes de que pase.' },
      { audience: 'ADMIN', en: 'The company’s own books: a double-entry ledger the site posts to by itself, with bank and card reconciliation.', es: 'La contabilidad propia de la empresa: un libro mayor de partida doble que el sitio registra solo, con conciliación bancaria y de tarjetas.' },
      { audience: 'ALL', en: 'Notifications by type: choose which updates reach your phone.', es: 'Notificaciones por tipo: elige qué avisos llegan a tu teléfono.' },
    ],
  },
  {
    day: '2026-10-19',
    items: [
      { audience: 'ADMIN', en: 'Payroll goes live in-house: a go-live checklist of every account and setting, and a pre-payroll review a second person signs before money moves.', es: 'La nómina se procesa en casa: una lista de puesta en marcha de cada cuenta y ajuste, y una revisión previa que firma una segunda persona antes de mover dinero.' },
      { audience: 'ASSOCIATE', en: 'Every deduction on your pay stub is itemized, with what it lowered and why.', es: 'Cada deducción de tu talón de pago aparece detallada, con lo que redujo y por qué.' },
      { audience: 'SUPERVISOR', en: 'The coverage board: every store’s next seven days on one screen, short shifts first.', es: 'El tablero de cobertura: los próximos siete días de cada tienda en una pantalla, primero los turnos cortos.' },
    ],
  },
  {
    day: '2026-10-23',
    items: [
      { audience: 'ADMIN', en: 'New analytics figures: how candidates move through hiring, the year in attendance, and where the labor money goes.', es: 'Nuevas gráficas: cómo avanzan los candidatos en la contratación, el año en asistencia y a dónde va el dinero de la mano de obra.' },
      { audience: 'ADMIN', en: 'Clients, rebuilt: an overview that opens first, a list that scales, a real pipeline and one client picker everywhere.', es: 'Clientes, renovado: un resumen que abre primero, una lista que crece, un embudo real y un solo selector de cliente en todas partes.' },
      { audience: 'CLIENT', en: 'Your store page shows who is on the floor now and this week against your contract.', es: 'La página de tu tienda muestra quién está en piso ahora y la semana frente a tu contrato.' },
      { audience: 'ALL', en: 'Address search on every address form — start typing and pick the right one.', es: 'Búsqueda de direcciones en cada formulario: empieza a escribir y elige la correcta.' },
    ],
  },
  {
    day: '2026-10-25',
    items: [
      { audience: 'ALL', en: 'Meet Hugo in 3D: the assistant now lives in the top bar and celebrates the wins with you.', es: 'Conoce a Hugo en 3D: el asistente ahora vive en la barra superior y celebra los logros contigo.' },
      { audience: 'ADMIN', en: 'Hugo works for you: he carries tasks on in the background and raises notes on his own, in six languages.', es: 'Hugo trabaja para ti: continúa tareas en segundo plano y te deja notas por su cuenta, en seis idiomas.' },
      { audience: 'ASSOCIATE', en: 'Ask Hugo out loud: tap the microphone and say what you need — your schedule, your pay, a day off.', es: 'Pregúntale a Hugo en voz alta: toca el micrófono y di lo que necesitas — tu horario, tu pago, un día libre.' },
    ],
  },
];

async function ensureModules(stores: StoreRow[], people: Person[], todayKey: string, adminId: string): Promise<void> {
  const fb = stores.find((s) => s.spec.key === 'front-beach');
  if (fb) {
    await ensureWorkTasks(fb, todayKey, people);
    await ensureStoreOps(fb, todayKey);
    await ensureRobots(fb, todayKey, adminId);
  }

  // Help center.
  for (const a of KB_ARTICLES) {
    const found = await db.kbArticle.findFirst({ where: { slug: a.slug }, select: { id: true } });
    if (found) continue;
    const publishedAt = new Date(NOW.getTime() - intBy(`kb|${a.slug}`, 12, 60) * DAY);
    await db.kbArticle.create({ data: { id: sid(`kb|${a.slug}`), title: a.title, slug: a.slug, body: a.body, category: a.category, tags: a.tags, status: 'PUBLISHED', publishedAt, authorId: adminId, views: intBy(`kbv|${a.slug}`, 18, 240), helpful: intBy(`kbh|${a.slug}`, 4, 30), notHelpful: intBy(`kbn|${a.slug}`, 0, 3), createdAt: publishedAt } });
    count('helpArticles');
  }

  // What's new.
  for (const n of RELEASE_NOTES) {
    const exists = await db.releaseNote.findFirst({ where: { tenantId: ALTO_TENANT_ID, day: dateOf(n.day) }, select: { id: true } });
    if (exists) continue;
    await db.releaseNote.create({ data: { id: sid(`release-note|${n.day}`), tenantId: ALTO_TENANT_ID, day: dateOf(n.day), items: n.items as unknown as Prisma.InputJsonValue, publishedAt: new Date(dateOf(n.day).getTime() + 15 * HOUR), createdById: adminId } });
    count('releaseNotes');
  }

  // Cost centers: one per store, plus the office.
  const ccs: Array<{ code: string; name: string; storeKey: string | null; description: string }> = [
    { code: 'CC-110', name: 'Front Beach 218', storeKey: 'front-beach', description: 'Store labor, Coastal Resort Holdings' },
    { code: 'CC-120', name: 'Thomas Drive 412', storeKey: 'thomas-drive', description: 'Store labor, Coastal Resort Holdings' },
    { code: 'CC-130', name: 'Destin Harbor 507', storeKey: 'destin-harbor', description: 'Store labor, Coastal Resort Holdings' },
    { code: 'CC-210', name: 'Seaside Grand · Tallahassee', storeKey: 'tallahassee', description: 'Store labor, Seaside Hospitality Group' },
    { code: 'CC-900', name: 'Alto HR office', storeKey: null, description: 'Recruiting, payroll, transport and management' },
  ];
  for (const c of ccs) {
    const store = c.storeKey ? stores.find((s) => s.spec.key === c.storeKey) : null;
    let cc = await db.costCenter.findFirst({ where: { code: c.code, deletedAt: null }, select: { id: true } });
    if (!cc) {
      cc = await db.costCenter.create({ data: { id: sid(`cost-center|${c.code}`), code: c.code, name: c.name, description: c.description, clientId: store?.clientId ?? null }, select: { id: true } });
      count('costCenters');
    }
    if (store) await db.associate.updateMany({ where: { id: { in: people.filter((p) => p.store === store).map((p) => p.id) }, costCenterId: null }, data: { costCenterId: cc.id } });
  }

  // Programs: the two crew members here on H-2B visas, with their agent.
  const sponsor =
    (await db.sponsor.findFirst({ where: { name: 'Gulf Seasonal Labor Partners' }, select: { id: true } })) ??
    (await db.sponsor.create({ data: { id: sid('sponsor|gulf-seasonal'), name: 'Gulf Seasonal Labor Partners', programType: 'H2B', contactName: 'Renata Alves', contactEmail: 'renata.alves@gulfseasonal.example', contactPhone: '+1-850-555-0177', checkInCadenceDays: 30, checkInRequirements: 'Monthly check-in call; report any change of worksite within 10 days.', reportingCadence: 'Monthly' }, select: { id: true } }));
  const coastal = stores.find((s) => s.spec.key === 'front-beach')?.clientId ?? null;
  for (const [name, country] of [['Oleksandr Bondar', 'Ukraine'], ['Mehmet Yılmaz', 'Türkiye']] as const) {
    const [first, ...rest] = name.split(' ');
    const a = await db.associate.findFirst({ where: { firstName: first!, lastName: rest.join(' '), deletedAt: null }, select: { id: true } });
    if (!a) continue;
    if (await db.program.findFirst({ where: { associateId: a.id }, select: { id: true } })) continue;
    await db.program.create({
      data: {
        id: sid(`program|${a.id}`), associateId: a.id, type: 'H2B', sponsorId: sponsor.id, country, programStart: dateOf('2026-03-16'), programEnd: dateOf('2026-12-18'), visaExpiresOn: dateOf('2026-12-31'),
        h2bPetitionNumber: `EAC-26-${intBy(`h2b|${a.id}`, 100, 999)}-${intBy(`h2b2|${a.id}`, 10000, 99999)}`, petitionClientId: coastal, petitionValidFrom: dateOf('2026-03-16'), petitionValidTo: dateOf('2026-12-18'),
        worksiteArea: 'Bay County, FL', lastSponsorCheckInOn: dateOf(addDays(todayKey, -intBy(`chk|${a.id}`, 6, 20))), notes: 'Returning seasonal worker; extension filed for the holiday season.', createdById: adminId,
      },
    });
    count('programs');
  }

  // The season plan for next summer at Coastal's stores.
  const planName = 'Summer 2027 · Coastal Resort Holdings';
  if (coastal && !(await db.seasonPlan.findFirst({ where: { name: planName, archivedAt: null }, select: { id: true } }))) {
    try {
      await createPlan(db, { name: planName, clientId: coastal, seasonStart: '2027-05-22', seasonEnd: '2027-09-06', targetHoursPerWeek: 36, shiftHours: 8, reservePct: 12, notes: 'Peak season: Memorial Day weekend to Labor Day. Housing at Seaside and Gulf Pines; vans from both.' } as never, adminId);
      count('seasonPlans');
    } catch (err) {
      log(`  season plan not created: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const admin = await user('admin@altohr.com');
  if (!admin) throw new Error('[demo-refresh] run the dev seed first (npm -w apps/api run db:seed): admin@altohr.com is missing.');
  const finance = (await user('finance@altohr.com')) ?? admin;
  const workforce = (await user('workforce@altohr.com')) ?? admin;
  const fbSite = await db.site.findFirst({ where: { name: 'Front Beach 218', deletedAt: null }, select: { timezone: true } });
  const todayKey = keyIn(NOW, fbSite?.timezone ?? 'America/Chicago');
  log(`refreshing the demo for ${todayKey}`);

  await cleanUp();
  await accountsAndHygiene(admin.id);
  const stores = await ensureStores(admin.id, todayKey);
  const people = await ensurePeople(stores, todayKey, admin.id);
  const schedule = await ensurePaySchedule(people, todayKey);
  await rollSchedule(stores, people, todayKey, { workforce: workforce.id });
  await leadEveryDay(stores, people);
  const supervisorOf = new Map<string, string>();
  for (const s of stores) {
    const u = await user(s.spec.supervisorEmail);
    if (u) supervisorOf.set(s.id, u.id);
  }
  await settlePunches(stores, supervisorOf, admin.id);
  await ensureTransport(stores, todayKey, admin.id);
  await ensureFinance(stores, todayKey, admin.id, finance.id);
  if (schedule) await runPaidPeriods(schedule, todayKey, { finance: finance.id, admin: admin.id, financeRole: finance.role });
  await ensureCompliance(todayKey, admin.id);
  await ensureTrustCenter(admin.id);
  await ensureClientDesk(stores, todayKey, admin.id);
  await ensureModules(stores, people, todayKey, admin.id);
  await ensureTeamAsks(people, todayKey);
  await ensureOnboardingPipeline(stores, todayKey);
  // Anything the books have not seen yet (statements, tax payments) is posted the way the nightly catch-up does.
  const { backfillPosting } = await import('../src/lib/books/posting/gaps.js');
  const posted = await backfillPosting(db, { since: new Date(NOW.getTime() - 120 * DAY) });
  count('booksCaughtUp', posted.payrollRuns + posted.statements + posted.taxPayments + posted.taxDeposits);

  for (const [k, v] of Object.entries(counts).sort()) log(`  ${k}: ${v}`);
  log('done.');
}

await runWithTenant(ALTO_TENANT_ID, 'script', main)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[demo-refresh] failed:', err);
    process.exit(1);
  });
