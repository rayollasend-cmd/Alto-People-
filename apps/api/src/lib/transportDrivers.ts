import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { tenantIdForWrite } from './tenant.js';
import { actsAsAny } from './roleScope.js';

/**
 * The driver as a worker, not only a login.
 *
 *   the pre-trip check   PRE_TRIP_ITEMS, evaluatePreTrip — the walk around
 *                        the van before a run leaves; a failed SAFETY item
 *                        keeps the run on the lot
 *   credentials          DriverProfile → driverCredentialStatus; a lapsed
 *                        licence or DOT card refuses the run; mirrored into
 *                        AssociateQualification rows (DRIVER_LICENCE,
 *                        DOT_MEDICAL_CARD) for drivers on file as people,
 *                        so the expirations desk and the Compliance agent
 *                        see them with every other credential
 *   driver shifts        a Shift with position DRIVER_POSITION, assigned to
 *                        the driver's associate record: scheduled by the
 *                        director, clocked through the ordinary time clock,
 *                        paid as hourly. When a day has driver shifts at
 *                        all, auto-plan and dispatch take only drivers on
 *                        shift then.
 *   hours of service     settings.driverMaxHoursPerDay on a day's shifts
 *                        and runs; settings.driverMinRestHours between two
 *                        shifts. Enforced where shifts and runs are given.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const DRIVER_POSITION = 'Driver';
/** How long a run is assumed to keep a driver busy when it has not ended. */
export const RUN_SPAN_MS = 2 * 3_600_000;

export interface PreTripItem {
  key: string;
  label: string;
  /** A failed safety item keeps the van on the lot. */
  safety: boolean;
}

export const PRE_TRIP_ITEMS: readonly PreTripItem[] = [
  { key: 'tires', label: 'Tires and wheels', safety: true },
  { key: 'brakes', label: 'Brakes', safety: true },
  { key: 'lights', label: 'Lights and signals', safety: true },
  { key: 'mirrors', label: 'Mirrors, wipers and glass', safety: true },
  { key: 'seatbelts', label: 'Seats and belts', safety: true },
  { key: 'firstAid', label: 'First-aid kit and extinguisher', safety: true },
  { key: 'leaks', label: 'No leaks or warning lights', safety: true },
  { key: 'fuel', label: 'Fuel for the day', safety: false },
  { key: 'clean', label: 'Clean inside and out', safety: false },
  { key: 'damage', label: 'No new damage', safety: false },
];

export interface PreTripAnswer {
  key: string;
  ok: boolean;
  note?: string | null;
}

/** Every item answered; the run leaves only when every SAFETY item passed. */
export function evaluatePreTrip(items: PreTripAnswer[]): { passed: boolean; failed: string[]; failedSafety: string[]; missing: string[] } {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const missing = PRE_TRIP_ITEMS.filter((d) => !byKey.has(d.key)).map((d) => d.key);
  const failed = PRE_TRIP_ITEMS.filter((d) => byKey.get(d.key)?.ok === false).map((d) => d.key);
  const failedSafety = PRE_TRIP_ITEMS.filter((d) => d.safety && byKey.get(d.key)?.ok === false).map((d) => d.key);
  return { passed: missing.length === 0 && failedSafety.length === 0, failed, failedSafety, missing };
}

export const preTripLabel = (key: string): string => PRE_TRIP_ITEMS.find((i) => i.key === key)?.label ?? key;

/* ----- Credentials ---------------------------------------------------------- */

export type CredentialKey = 'licence' | 'dot' | 'training' | 'mvr';

export interface CredentialStatus {
  ok: boolean;
  /** What is lapsed or missing. Training counts only once a renewal date is on file. */
  problems: Array<{ key: CredentialKey; label: string; expiresAt: string | null; expired: boolean }>;
  /** Anything that lapses inside 30 days — and an MVR more than eleven months old. */
  dueSoon: Array<{ key: CredentialKey; label: string; expiresAt: string }>;
}

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function driverCredentialStatus(
  profile: {
    licenceExpiresAt: Date | null;
    dotMedicalRequired: boolean;
    dotMedicalExpiresAt: Date | null;
    trainingExpiresAt?: Date | null;
    mvrCheckedAt?: Date | null;
  } | null,
  now = new Date(),
): CredentialStatus {
  const problems: CredentialStatus['problems'] = [];
  const dueSoon: CredentialStatus['dueSoon'] = [];
  const soon = new Date(now.getTime() + 30 * DAY_MS);
  const today = ymd(now);
  const judge = (key: CredentialKey, label: string, at: Date | null) => {
    if (!at) {
      problems.push({ key, label, expiresAt: null, expired: false });
      return;
    }
    if (ymd(at) < today) problems.push({ key, label, expiresAt: ymd(at), expired: true });
    else if (at < soon) dueSoon.push({ key, label, expiresAt: ymd(at) });
  };
  judge('licence', "Driver's licence", profile?.licenceExpiresAt ?? null);
  if (profile?.dotMedicalRequired) judge('dot', 'DOT medical card', profile.dotMedicalExpiresAt);
  // Training is judged once a renewal date is on file; a fleet that doesn't
  // track it isn't stopped by its absence.
  if (profile?.trainingExpiresAt) judge('training', 'Driver safety training', profile.trainingExpiresAt);
  // The motor-vehicle record is re-pulled yearly: a warning, never a block.
  if (profile?.mvrCheckedAt) {
    const due = new Date(profile.mvrCheckedAt.getTime() + 365 * DAY_MS);
    if (due < soon) dueSoon.push({ key: 'mvr', label: 'Motor-vehicle record check', expiresAt: ymd(due) });
  }
  return { ok: problems.length === 0, problems, dueSoon };
}

export const DRIVER_QUALIFICATIONS = {
  licence: { code: 'DRIVER_LICENCE', name: "Driver's licence" },
  dot: { code: 'DOT_MEDICAL_CARD', name: 'DOT medical card' },
  training: { code: 'DRIVER_SAFETY_TRAINING', name: 'Driver safety training' },
} as const;

/**
 * Mirror the profile's expiries into the person's qualifications, so the
 * expirations dashboard, renewals and the Compliance agent treat a licence
 * like any other credential. A driver with no associate record has only
 * the profile; the desk's driver list carries their dates.
 */
export async function syncDriverQualifications(db: Db, userId: string, now = new Date()): Promise<void> {
  const [user, profile] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { associateId: true } }),
    db.driverProfile.findUnique({ where: { userId } }),
  ]);
  if (!user?.associateId || !profile) return;
  const tenantId = tenantIdForWrite();
  const want: Array<{ code: string; name: string; expiresAt: Date | null; keep: boolean }> = [
    { ...DRIVER_QUALIFICATIONS.licence, expiresAt: profile.licenceExpiresAt, keep: !!profile.licenceExpiresAt },
    { ...DRIVER_QUALIFICATIONS.dot, expiresAt: profile.dotMedicalExpiresAt, keep: profile.dotMedicalRequired && !!profile.dotMedicalExpiresAt },
    { ...DRIVER_QUALIFICATIONS.training, expiresAt: profile.trainingExpiresAt, keep: !!profile.trainingExpiresAt },
  ];
  for (const w of want) {
    let qual = await db.qualification.findFirst({ where: { code: w.code, clientId: null, tenantId, deletedAt: null }, select: { id: true } });
    if (!qual && w.keep) {
      qual = await db.qualification.create({ data: { code: w.code, name: w.name, isCert: true, clientId: null, tenantId }, select: { id: true } });
    }
    if (!qual) continue;
    const row = await db.associateQualification.findFirst({
      where: { associateId: user.associateId, qualificationId: qual.id, deletedAt: null },
      select: { id: true },
    });
    if (w.keep) {
      if (row) await db.associateQualification.update({ where: { id: row.id }, data: { expiresAt: w.expiresAt } });
      else await db.associateQualification.create({ data: { associateId: user.associateId, qualificationId: qual.id, expiresAt: w.expiresAt, acquiredAt: now, tenantId } });
    } else if (row) {
      await db.associateQualification.update({ where: { id: row.id }, data: { deletedAt: now } });
    }
  }
}

/* ----- Driver shifts ---------------------------------------------------------- */

export interface HosSettings {
  driverMaxHoursPerDay: number;
  driverMinRestHours: number;
}

export async function hosSettings(db: Db = prisma): Promise<HosSettings & { preTripRequired: boolean; driverShiftLocationId: string | null }> {
  const row = await db.transportSettings.findUnique({
    where: { id: 'default' },
    select: { driverMaxHoursPerDay: true, driverMinRestHours: true, preTripRequired: true, driverShiftLocationId: true },
  });
  return {
    driverMaxHoursPerDay: row?.driverMaxHoursPerDay ?? 10,
    driverMinRestHours: row?.driverMinRestHours ?? 8,
    preTripRequired: row?.preTripRequired ?? true,
    driverShiftLocationId: row?.driverShiftLocationId ?? null,
  };
}

/** The UTC bounds of a service day in the fleet's zone. */
export function dayBounds(date: string, tz = DEFAULT_TIMEZONE): { from: Date; to: Date } {
  // Walk from noon UTC of that date to the zone's midnight boundaries.
  const noon = new Date(`${date}T12:00:00Z`);
  let from = new Date(noon.getTime() - 24 * 3_600_000);
  while (dateKeyInZone(from, tz) < date) from = new Date(from.getTime() + 15 * 60_000);
  let to = new Date(noon.getTime());
  while (dateKeyInZone(to, tz) <= date) to = new Date(to.getTime() + 15 * 60_000);
  return { from, to };
}

export const driverShiftSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  assignedAssociateId: true,
  locationId: true,
  notes: true,
} satisfies Prisma.ShiftSelect;

export type DriverShiftRow = Prisma.ShiftGetPayload<{ select: typeof driverShiftSelect }>;

/** Every driver shift that touches the window — a shift that starts the day before and runs past midnight counts. */
export async function driverShiftsBetween(from: Date, to: Date, db: Db = prisma): Promise<DriverShiftRow[]> {
  return db.shift.findMany({
    where: { position: DRIVER_POSITION, status: { not: 'CANCELLED' }, startsAt: { lt: to }, endsAt: { gt: from } },
    orderBy: { startsAt: 'asc' },
    select: driverShiftSelect,
  });
}

/** Driver users keyed by their associate id (only drivers on file as people can be scheduled). */
export async function driverUsersByAssociate(db: Db = prisma): Promise<Map<string, { id: string; role: string }>> {
  const rows = await db.user.findMany({
    where: { ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), status: 'ACTIVE', deletedAt: null, associateId: { not: null } },
    select: { id: true, role: true, associateId: true },
  });
  return new Map(rows.map((r) => [r.associateId!, { id: r.id, role: r.role }]));
}

/**
 * Who is on a driver shift at `at`, as user ids — or null when the day has
 * no driver shifts at all (the fleet does not schedule drivers; everyone
 * active is fair game, as before).
 */
export async function driversOnShiftAt(at: Date, db: Db = prisma): Promise<Set<string> | null> {
  const date = dateKeyInZone(at, DEFAULT_TIMEZONE);
  const { from, to } = dayBounds(date);
  const shifts = await driverShiftsBetween(from, to, db);
  if (shifts.length === 0) return null;
  const users = await driverUsersByAssociate(db);
  const on = new Set<string>();
  for (const s of shifts) {
    if (!s.assignedAssociateId) continue;
    if (s.startsAt <= at && s.endsAt > at) {
      const u = users.get(s.assignedAssociateId);
      if (u) on.add(u.id);
    }
  }
  return on;
}

const hours = (ms: number) => ms / 3_600_000;

/** Hours a driver is already down for on a day: shifts, else runs. */
export async function plannedHoursOn(driverUserId: string, date: string, db: Db = prisma): Promise<{ shiftHours: number; runHours: number }> {
  const { from, to } = dayBounds(date);
  const user = await db.user.findUnique({ where: { id: driverUserId }, select: { associateId: true } });
  const [shifts, runs] = await Promise.all([
    user?.associateId
      ? db.shift.findMany({
          where: { position: DRIVER_POSITION, assignedAssociateId: user.associateId, status: { not: 'CANCELLED' }, startsAt: { lt: to }, endsAt: { gt: from } },
          select: { startsAt: true, endsAt: true },
        })
      : Promise.resolve([]),
    db.rideRun.findMany({
      where: { driverUserId, serviceDate: date, status: { not: 'CANCELLED' } },
      select: { departAt: true, startedAt: true, endedAt: true },
    }),
  ]);
  const clip = (a: Date, b: Date) => Math.max(0, Math.min(b.getTime(), to.getTime()) - Math.max(a.getTime(), from.getTime()));
  const shiftHours = hours(shifts.reduce((t, s) => t + clip(s.startsAt, s.endsAt), 0));
  const runHours = hours(
    runs.reduce((t, r) => {
      const start = r.startedAt ?? r.departAt;
      const end = r.endedAt ?? new Date(start.getTime() + RUN_SPAN_MS);
      return t + (end.getTime() - start.getTime());
    }, 0),
  );
  return { shiftHours, runHours };
}

/** Credentials are judged once the desk has recorded at least one driver profile. */
export async function credentialsEnforced(db: Db = prisma): Promise<boolean> {
  return (await db.driverProfile.count()) > 0;
}

/** The window a run keeps its van and driver busy: 15 minutes before it leaves until it ends (or RUN_SPAN_MS after leaving). */
export function runBusyWindow(run: { departAt: Date; startedAt?: Date | null; endedAt?: Date | null }): { from: number; to: number } {
  const start = run.startedAt ?? run.departAt;
  return { from: run.departAt.getTime() - 15 * 60_000, to: (run.endedAt ?? new Date(start.getTime() + RUN_SPAN_MS)).getTime() };
}

const fmtClock = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(d);

/**
 * Transport walk 1: a van and a driver take one run at a time. Any PLANNED
 * or ACTIVE run of the same van or driver whose busy window overlaps this
 * departure's refuses it — 409 van_busy / driver_busy, naming the run.
 * The planner uses the same window (lib/transportPlan), so what it never
 * proposes, dispatch never accepts by hand either.
 */
export async function assertVanDriverFree(
  vanId: string,
  driverUserId: string,
  departAt: Date,
  opts: { excludeRunId?: string; excludeRunIds?: string[] } = {},
  db: Db = prisma,
): Promise<void> {
  const mine = runBusyWindow({ departAt });
  const exclude = [...(opts.excludeRunIds ?? []), ...(opts.excludeRunId ? [opts.excludeRunId] : [])];
  const others = await db.rideRun.findMany({
    where: {
      status: { in: ['PLANNED', 'ACTIVE'] },
      OR: [{ vanId }, { driverUserId }],
      ...(exclude.length ? { id: { notIn: exclude } } : {}),
      // Only runs that could overlap: leaving inside a day either way.
      departAt: { gte: new Date(mine.from - RUN_SPAN_MS - 86_400_000), lte: new Date(mine.to + 86_400_000) },
    },
    select: { id: true, vanId: true, driverUserId: true, departAt: true, startedAt: true, endedAt: true, van: { select: { name: true } }, driver: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } },
    orderBy: { departAt: 'asc' },
  });
  for (const r of others) {
    const w = runBusyWindow(r);
    if (!(w.from < mine.to && w.to > mine.from)) continue;
    if (r.vanId === vanId) {
      throw new HttpError(409, 'van_busy', `${r.van.name} is already on a run leaving ${fmtClock(r.departAt)}. Pick another van, or another time.`);
    }
    const who = r.driver.associate ? `${r.driver.associate.firstName} ${r.driver.associate.lastName}` : r.driver.email;
    throw new HttpError(409, 'driver_busy', `${who} is already driving ${r.van.name}'s run leaving ${fmtClock(r.departAt)}. Pick another driver, or another time.`);
  }
}

/**
 * May this driver take a run leaving at `departAt`? Credentials current;
 * on shift if the day schedules drivers; under the day's hours of service.
 * Throws the HttpError dispatch should show.
 */
export async function assertDriverFit(driverUserId: string, departAt: Date, opts: { excludeRunId?: string } = {}, db: Db = prisma): Promise<void> {
  const [profile, user] = await Promise.all([
    db.driverProfile.findUnique({ where: { userId: driverUserId } }),
    db.user.findUnique({ where: { id: driverUserId }, select: { email: true, associate: { select: { firstName: true, lastName: true } } } }),
  ]);
  const name = user?.associate ? `${user.associate.firstName} ${user.associate.lastName}` : (user?.email ?? 'This driver');
  // Credentials are enforced once the desk has started recording them: a
  // fleet that has not opened a single profile is not refused every run.
  // From the first profile on, a driver with NO profile is a driver with
  // no licence on file — the same refusal as a lapsed one (transport walk
  // 2: a missing licence used to pass every check).
  const judged = profile ?? ((await credentialsEnforced(db)) ? null : undefined);
  if (judged !== undefined) {
    const cred = driverCredentialStatus(judged, new Date());
    if (!cred.ok) {
      const what = cred.problems.map((p) => `${p.label}${p.expired ? ` expired ${p.expiresAt}` : ' not on file'}`).join('; ');
      throw new HttpError(409, 'driver_credentials', `${name} can't take a run: ${what}. Update their driver record first.`);
    }
  }
  const on = await driversOnShiftAt(departAt, db);
  if (on && !on.has(driverUserId)) {
    throw new HttpError(409, 'driver_not_on_shift', `${name} isn't on a driver shift when this run leaves. Schedule them, or pick a driver who is.`);
  }
  const settings = await hosSettings(db);
  const date = dateKeyInZone(departAt, DEFAULT_TIMEZONE);
  const planned = await plannedHoursOn(driverUserId, date, db);
  // Shifts bound the day when they exist; otherwise the runs do.
  const already = planned.shiftHours > 0 ? planned.shiftHours : planned.runHours + (opts.excludeRunId ? 0 : hours(RUN_SPAN_MS));
  if (already > settings.driverMaxHoursPerDay + 1e-9) {
    throw new HttpError(
      409,
      'hours_of_service',
      `${name} would be over ${settings.driverMaxHoursPerDay} hours on ${date} (${already.toFixed(1)}h planned). Hours of service — pick another driver or shorten the day.`,
    );
  }
}

/** A shift's hours and rest against the rules. Throws the HttpError to show. */
export async function assertShiftWithinHos(
  associateId: string,
  startsAt: Date,
  endsAt: Date,
  settings: HosSettings,
  opts: { excludeShiftId?: string } = {},
  db: Db = prisma,
): Promise<void> {
  const span = hours(endsAt.getTime() - startsAt.getTime());
  if (span > settings.driverMaxHoursPerDay) {
    throw new HttpError(409, 'hours_of_service', `A driver shift can't be longer than ${settings.driverMaxHoursPerDay} hours (this one is ${span.toFixed(1)}h).`);
  }
  const rest = settings.driverMinRestHours * 3_600_000;
  const near = await db.shift.findMany({
    where: {
      position: DRIVER_POSITION,
      assignedAssociateId: associateId,
      status: { not: 'CANCELLED' },
      ...(opts.excludeShiftId ? { id: { not: opts.excludeShiftId } } : {}),
      startsAt: { lt: new Date(endsAt.getTime() + rest) },
      endsAt: { gt: new Date(startsAt.getTime() - rest) },
    },
    select: { startsAt: true, endsAt: true },
  });
  if (near.length > 0) {
    throw new HttpError(
      409,
      'hours_of_service',
      `Drivers get ${settings.driverMinRestHours} hours between shifts — this one sits too close to another of theirs.`,
    );
  }
  // The day's total across shifts.
  const date = dateKeyInZone(startsAt, DEFAULT_TIMEZONE);
  const { from, to } = dayBounds(date);
  const sameDay = await db.shift.findMany({
    where: {
      position: DRIVER_POSITION,
      assignedAssociateId: associateId,
      status: { not: 'CANCELLED' },
      ...(opts.excludeShiftId ? { id: { not: opts.excludeShiftId } } : {}),
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    select: { startsAt: true, endsAt: true },
  });
  const total = span + hours(sameDay.reduce((t, s) => t + (s.endsAt.getTime() - s.startsAt.getTime()), 0));
  if (total > settings.driverMaxHoursPerDay + 1e-9) {
    throw new HttpError(409, 'hours_of_service', `That puts the driver over ${settings.driverMaxHoursPerDay} hours on ${date}.`);
  }
}

/* ----- The expirations desk ------------------------------------------------- */

export interface TransportExpiration {
  kind: 'van' | 'driver';
  id: string;
  name: string;
  document: string;
  expiresAt: string;
  daysUntilExpiry: number;
}

/** Van papers and driver credentials lapsing inside `days` (or already lapsed). */
export async function transportExpirations(days: number, now = new Date(), db: Db = prisma): Promise<TransportExpiration[]> {
  const until = new Date(now.getTime() + days * DAY_MS);
  const [vans, profiles] = await Promise.all([
    db.van.findMany({ where: { isActive: true }, select: { id: true, name: true, plate: true, registrationExpiresAt: true, insuranceExpiresAt: true, inspectionDueAt: true } }),
    db.driverProfile.findMany({
      where: { user: { status: 'ACTIVE', deletedAt: null } },
      select: { userId: true, licenceExpiresAt: true, dotMedicalRequired: true, dotMedicalExpiresAt: true, trainingExpiresAt: true, user: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } },
    }),
  ]);
  const out: TransportExpiration[] = [];
  const push = (kind: 'van' | 'driver', id: string, name: string, document: string, at: Date | null) => {
    if (!at || at > until) return;
    out.push({ kind, id, name, document, expiresAt: ymd(at), daysUntilExpiry: Math.round((at.getTime() - now.getTime()) / DAY_MS) });
  };
  for (const v of vans) {
    const name = v.plate ? `${v.name} · ${v.plate}` : v.name;
    push('van', v.id, name, 'Registration', v.registrationExpiresAt);
    push('van', v.id, name, 'Insurance', v.insuranceExpiresAt);
    push('van', v.id, name, 'State inspection', v.inspectionDueAt);
  }
  for (const p of profiles) {
    const name = p.user.associate ? `${p.user.associate.firstName} ${p.user.associate.lastName}` : p.user.email;
    push('driver', p.userId, name, "Driver's licence", p.licenceExpiresAt);
    if (p.dotMedicalRequired) push('driver', p.userId, name, 'DOT medical card', p.dotMedicalExpiresAt);
    push('driver', p.userId, name, 'Driver safety training', p.trainingExpiresAt);
  }
  return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}
