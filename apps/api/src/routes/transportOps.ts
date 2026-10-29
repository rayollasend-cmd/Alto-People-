import { Router, type Request } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Prisma } from '@prisma/client';
import { can, hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBlobStore, tenantBlobKey } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { notifyUser, notifyAssociate, trackNotificationWork } from '../lib/notify.js';
import { emitLiveEvent } from '../lib/liveEvents.js';
import { companyWorkweek, dateKeyInZone } from '../lib/timeAnomalies.js';
import { fmtDayInZone } from '../lib/humanDates.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';
import { actsAsAny } from '../lib/roleScope.js';
import { geocode } from '../lib/geocode.js';
import { computeAssociateEarnings } from '../lib/associateEarnings.js';
import { nextPaydayFor } from '../lib/associatePayday.js';
import { accountPhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { TRANSPORT_PHOTO_NAME, bookableStores, transportPhotoUrl } from '../lib/transport.js';
import { storeShiftWindows } from '../lib/transportSeats.js';
import { driverHourlyRates, runDriverCents } from '../lib/transportCosts.js';
import { computeOpsBoard } from '../lib/transportOpsBoard.js';
import { computeReadiness, tomorrowKey } from '../lib/transportReadiness.js';
import { generateSeries, seriesTargetAt } from '../lib/rideSeries.js';
import { ackSos, driverOk, expectedRunEnd, publicTrack, raiseSos, shareToken, shareTokenState } from '../lib/transportSafety.js';
import { haversineM, liveRunInclude } from '../lib/transportLive.js';
import {
  DRIVER_POSITION,
  PRE_TRIP_ITEMS,
  assertShiftWithinHos,
  dayBounds,
  dayRunCounts,
  driverCredentialStatus,
  driverShiftSelect,
  driverShiftsBetween,
  evaluatePreTrip,
  hosSettings,
  preTripLabel,
  syncDriverQualifications,
  transportExpirations,
  vanDayKey,
  vanDayPreTrips,
} from '../lib/transportDrivers.js';

/**
 * Transportation, the driver and fleet pack — mounted beside routes/transport
 * under /transport:
 *
 *   /driver/profile, /driver/today, /driver/shifts   the driver as a worker:
 *       their navigation app, credentials, today's runs → hours → pay
 *   /driver/runs/:id/pre-trip                        the walk around the van
 *   /driver/runs/:id/sos | /ok | /share, /track/:t   the safety toolkit
 *   /incidents                                       accidents, written up
 *   /me/rides/:id/feedback, /me/feedback/pending     the rider's thumb
 *   /me/series                                       standing bookings
 *   /vans/:id/record, /vans/:id/service              the fleet record
 *   /drivers, /drivers/:id/profile, /driver-shifts   the desk's drivers
 *   /feedback, /costs, /needs-you                    the director's numbers
 *   /photos                                          a photo for a check or an incident
 */
export const transportOpsRouter = Router();

const RIDE = requireCapability('ride:transport');
const DRIVE = requireCapability('drive:transport');
const VIEW = requireCapability('view:transport');
const MANAGE = requireCapability('manage:transport');

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
/** A date-only column's day (they read at UTC midnight). Never an instant — those go through the company's zone. */
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: only @db.Date columns come through here
const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;
/** The company's zone (CODE-14): transport's "today" was New York, hard-coded. */
const companyZone = (): string => companyWorkweek().timezone;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null }): string {
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
}

async function notifyDesk(opts: { subject: string; body: string; linkUrl: string }) {
  const desk = await prisma.user.findMany({ where: { role: 'TRANSPORTATION_DIRECTOR', status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  await Promise.all(desk.map((u) => notifyUser(u.id, { ...opts, category: 'transport' })));
  for (const u of desk) emitLiveEvent(u.id, 'transport');
}

const runSelect = {
  id: true,
  vanId: true,
  driverUserId: true,
  status: true,
  serviceDate: true,
  departAt: true,
  lastLat: true,
  lastLng: true,
  van: { select: { id: true, name: true, plate: true } },
} satisfies Prisma.RideRunSelect;

async function ownRun(req: Request, runId: string) {
  const run = await prisma.rideRun.findUnique({ where: { id: runId }, select: runSelect });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  if (run.driverUserId !== req.user!.id && !can(req.user!, 'manage:transport')) throw new HttpError(404, 'not_found', 'Run not found.');
  return run;
}

/* ===== The driver's profile and day ====================================== */

const profileView = (p: {
  navApp: string;
  licenceNumber: string | null;
  licenceState: string | null;
  licenceClass: string | null;
  licenceExpiresAt: Date | null;
  dotMedicalRequired: boolean;
  dotMedicalExpiresAt: Date | null;
  mvrCheckedAt: Date | null;
  trainingCompletedAt: Date | null;
  trainingExpiresAt: Date | null;
  notes: string | null;
} | null) => ({
  navApp: p?.navApp ?? 'GOOGLE',
  licenceNumber: p?.licenceNumber ?? null,
  licenceState: p?.licenceState ?? null,
  licenceClass: p?.licenceClass ?? null,
  licenceExpiresAt: ymd(p?.licenceExpiresAt),
  dotMedicalRequired: p?.dotMedicalRequired ?? false,
  dotMedicalExpiresAt: ymd(p?.dotMedicalExpiresAt),
  mvrCheckedAt: ymd(p?.mvrCheckedAt),
  trainingCompletedAt: ymd(p?.trainingCompletedAt),
  trainingExpiresAt: ymd(p?.trainingExpiresAt),
  notes: p?.notes ?? null,
});

transportOpsRouter.get('/driver/profile', DRIVE, async (req, res) => {
  const [profile, user] = await Promise.all([
    prisma.driverProfile.findUnique({ where: { userId: req.user!.id } }),
    prisma.user.findUnique({ where: { id: req.user!.id }, select: { associateId: true } }),
  ]);
  res.json({ profile: profileView(profile), credentials: driverCredentialStatus(profile), associateId: user?.associateId ?? null });
});

/** The driver's own choices — how they navigate. The desk keeps the rest. */
transportOpsRouter.patch('/driver/profile', DRIVE, async (req, res) => {
  const { navApp } = z.object({ navApp: z.enum(['GOOGLE', 'APPLE', 'WAZE']) }).parse(req.body);
  const profile = await prisma.driverProfile.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id, navApp, tenantId: tenantIdForWrite() },
    update: { navApp },
  });
  res.json({ profile: profileView(profile), credentials: driverCredentialStatus(profile) });
});

/**
 * Today, for the driver: runs → hours → pay. Hours come from the ordinary
 * time clock (a driver on file as a person clocks in like anyone); pay is
 * the same live estimate associates see on their home.
 */
transportOpsRouter.get('/driver/today', DRIVE, async (req, res) => {
  const now = new Date();
  const date = dateKeyInZone(now, companyZone());
  const { from, to } = dayBounds(date);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { associateId: true } });
  const associateId = user?.associateId ?? null;
  const [runs, profile, shifts, entries, earnings, settings, dispatch, payday] = await Promise.all([
    prisma.rideRun.findMany({ where: { driverUserId: req.user!.id, serviceDate: date, status: { not: 'CANCELLED' } }, select: { status: true, startedAt: true, endedAt: true } }),
    prisma.driverProfile.findUnique({ where: { userId: req.user!.id } }),
    associateId
      ? prisma.shift.findMany({
          where: { position: DRIVER_POSITION, assignedAssociateId: associateId, status: { not: 'CANCELLED' }, startsAt: { lt: new Date(to.getTime() + 7 * 86_400_000) }, endsAt: { gt: from } },
          orderBy: { startsAt: 'asc' },
          select: driverShiftSelect,
          take: 14,
        })
      : Promise.resolve([]),
    associateId
      ? prisma.timeEntry.findMany({
          where: { associateId, status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] }, clockInAt: { gte: from, lt: to } },
          select: { clockInAt: true, clockOutAt: true, status: true },
        })
      : Promise.resolve([]),
    associateId ? computeAssociateEarnings(prisma, associateId, now).catch(() => null) : Promise.resolve(null),
    hosSettings(),
    prisma.transportSettings.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { dispatchPhone: true } }),
    // The payday the driver's pay sheet counts down to: the same schedule
    // membership as /payroll/me/next-payday (drivers can't call it).
    associateId ? nextPaydayFor(associateId, now).catch(() => null) : Promise.resolve(null),
  ]);
  const workedMs = entries.reduce((t, e) => t + ((e.clockOutAt ?? now).getTime() - e.clockInAt.getTime()), 0);
  const drivenMs = runs.reduce((t, r) => (r.startedAt ? t + ((r.endedAt ?? now).getTime() - r.startedAt.getTime()) : t), 0);
  res.json({
    date,
    associateId,
    // "Runs today", one definition (lib/transportDrivers dayRunCounts) — GET /driver/runs' counts are the same.
    runs: dayRunCounts(runs),
    hours: { worked: Math.round((workedMs / 3_600_000) * 100) / 100, driven: Math.round((drivenMs / 3_600_000) * 100) / 100, onClock: entries.some((e) => e.status === 'ACTIVE') },
    shifts: shifts.map((s) => ({ id: s.id, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), status: s.status, today: s.startsAt < to && s.endsAt > from })),
    earnings: earnings
      ? {
          hourlyRate: earnings.hourlyRate,
          earnedSoFar: earnings.earnedSoFar,
          workedHours: earnings.workedHours,
          projectedWeek: earnings.projectedWeek,
          currentShiftEarned: earnings.currentShiftEarned,
          onClock: earnings.onClock,
          weekStart: earnings.weekStart,
          weekEnd: earnings.weekEnd,
          // The pay sheet (transport upgrade 2026-10-28): the engine's own
          // shapes, as GET /time/me/earnings returns them.
          days: earnings.days,
          overtime: earnings.overtime,
          currentRatePerHour: earnings.currentRatePerHour,
          takeHome: earnings.takeHome,
          rateSource: earnings.rateSource,
        }
      : null,
    /** Null when the driver is on no pay schedule (or has no person record). */
    nextPayday: payday ? { payDate: payday.payDate, periodStart: payday.periodStart, periodEnd: payday.periodEnd } : null,
    /** The dispatch line — the driver's "Call dispatch". */
    dispatchPhone: dispatch?.dispatchPhone ?? null,
    // Only once the desk keeps a record for this driver: a fleet that
    // tracks no licences is not told "not on file" on every phone.
    credentials: profile ? driverCredentialStatus(profile) : null,
    hoursOfService: { maxPerDay: settings.driverMaxHoursPerDay, minRest: settings.driverMinRestHours },
    preTripRequired: settings.preTripRequired,
  });
});

/**
 * The driver's time clock. Drivers hold no `view:time` (they have no Time
 * area), so the clock lives here: the same TimeEntry rows the rest of the
 * product reads — approvals, payroll, the live earnings estimate — tied
 * to the driver shift they're working when there is one.
 */
async function driverAssociate(req: Request): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { associateId: true } });
  if (!user?.associateId) {
    throw new HttpError(403, 'no_associate_record', 'Your login is not linked to a person record yet — ask transportation to link it before you clock in.');
  }
  return user.associateId;
}

transportOpsRouter.post('/driver/clock-in', DRIVE, async (req, res) => {
  const associateId = await driverAssociate(req);
  const now = new Date();
  const open = await prisma.timeEntry.findFirst({ where: { associateId, status: 'ACTIVE' }, select: { id: true } });
  if (open) throw new HttpError(409, 'already_clocked_in', 'You are already clocked in.');
  // The driver shift running now (or starting within the hour).
  const shift = await prisma.shift.findFirst({
    where: { position: DRIVER_POSITION, assignedAssociateId: associateId, status: { not: 'CANCELLED' }, startsAt: { lte: new Date(now.getTime() + 3_600_000) }, endsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
    select: { id: true, locationId: true },
  });
  const entry = await prisma.timeEntry.create({
    data: { associateId, clockInAt: now, status: 'ACTIVE', shiftId: shift?.id ?? null, locationId: shift?.locationId ?? null, notes: 'Driver clock-in', tenantId: tenantIdForWrite() },
    select: { id: true, clockInAt: true },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'time.clock_in', entityType: 'TimeEntry', entityId: entry.id, metadata: { via: 'driver', shiftId: shift?.id ?? null } }, 'transportOps');
  res.status(201).json({ entry: { id: entry.id, clockInAt: entry.clockInAt.toISOString() } });
});

transportOpsRouter.post('/driver/clock-out', DRIVE, async (req, res) => {
  const associateId = await driverAssociate(req);
  const open = await prisma.timeEntry.findFirst({ where: { associateId, status: 'ACTIVE' }, select: { id: true } });
  if (!open) throw new HttpError(409, 'not_clocked_in', 'You are not clocked in.');
  const active = await prisma.rideRun.count({ where: { driverUserId: req.user!.id, status: 'ACTIVE' } });
  if (active > 0) throw new HttpError(409, 'run_in_progress', 'Finish the run on the road before you clock out.');
  const entry = await prisma.timeEntry.update({ where: { id: open.id }, data: { clockOutAt: new Date(), status: 'COMPLETED' }, select: { id: true, clockInAt: true, clockOutAt: true } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'time.clock_out', entityType: 'TimeEntry', entityId: entry.id, metadata: { via: 'driver' } }, 'transportOps');
  res.json({ entry: { id: entry.id, clockInAt: entry.clockInAt.toISOString(), clockOutAt: entry.clockOutAt!.toISOString() } });
});

/** The driver's own recent punches — what the stacked-role driver never saw. */
transportOpsRouter.get('/driver/time', DRIVE, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { associateId: true } });
  if (!user?.associateId) {
    res.json({ entries: [] });
    return;
  }
  const rows = await prisma.timeEntry.findMany({
    where: { associateId: user.associateId, clockInAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
    orderBy: { clockInAt: 'desc' },
    take: 30,
    select: { id: true, clockInAt: true, clockOutAt: true, status: true },
  });
  res.json({ entries: rows.map((e) => ({ id: e.id, clockInAt: e.clockInAt.toISOString(), clockOutAt: iso(e.clockOutAt), status: e.status, hours: e.clockOutAt ? Math.round(((e.clockOutAt.getTime() - e.clockInAt.getTime()) / 3_600_000) * 100) / 100 : null })) });
});

transportOpsRouter.get('/driver/shifts', DRIVE, async (req, res) => {
  const q = z.object({ from: dateOnly.optional(), days: z.coerce.number().int().min(1).max(31).default(14) }).parse(req.query);
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { associateId: true } });
  if (!user?.associateId) {
    res.json({ shifts: [], associateId: null });
    return;
  }
  const from = dayBounds(q.from ?? dateKeyInZone(new Date(), companyZone())).from;
  const to = new Date(from.getTime() + q.days * 86_400_000);
  const shifts = await prisma.shift.findMany({
    where: { position: DRIVER_POSITION, assignedAssociateId: user.associateId, status: { not: 'CANCELLED' }, startsAt: { lt: to }, endsAt: { gt: from } },
    orderBy: { startsAt: 'asc' },
    select: driverShiftSelect,
  });
  res.json({ associateId: user.associateId, shifts: shifts.map((s) => ({ id: s.id, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), status: s.status, notes: s.notes })) });
});

/* ===== Photos (a check, an incident) ======================================= */

const PHOTO_MIMES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!PHOTO_MIMES[file.mimetype]) {
      cb(new HttpError(400, 'invalid_mime', `A photo must be PNG, JPEG or WebP — got ${file.mimetype}.`));
      return;
    }
    cb(null, true);
  },
});

function mayPhoto(req: Request): boolean {
  const role = req.user!.role;
  return hasCapability(role, 'drive:transport') || hasCapability(role, 'manage:transport') || hasCapability(role, 'ride:transport');
}

transportOpsRouter.post('/photos', requireAuth, upload.single('photo'), async (req, res) => {
  if (!mayPhoto(req)) throw new HttpError(403, 'forbidden', 'Not allowed.');
  const file = req.file;
  if (!file) throw new HttpError(400, 'no_file', 'Attach a photo as "photo".');
  const magic = verifyFileMagic(file.buffer, file.mimetype);
  if (magic) throw new HttpError(400, 'invalid_file_contents', magic);
  const ext = PHOTO_MIMES[file.mimetype] ?? (extname(sanitizeUploadFilename(file.originalname)).toLowerCase() || '.bin');
  const name = `${randomUUID()}${ext}`;
  // The row keeps the bare name; the object lives under the tenant (lib/blobStore tenantBlobKey).
  await getBlobStore().put(tenantBlobKey(`transport/${name}`), file.buffer, file.mimetype);
  res.status(201).json({ key: name, url: `/transport/photos/${name}` });
});

transportOpsRouter.get('/photos/:name', requireAuth, async (req, res) => {
  const role = req.user!.role;
  if (!hasCapability(role, 'view:transport') && !hasCapability(role, 'drive:transport')) throw new HttpError(403, 'forbidden', 'Not allowed.');
  const name = z.string().regex(TRANSPORT_PHOTO_NAME).parse(req.params.name);
  // The caller's own tenant first; a photo from before the tenant prefix is
  // Alto HR's (the only tenant then), so only Alto HR falls back to it.
  const buf =
    (await getBlobStore().get(tenantBlobKey(`transport/${name}`))) ??
    (tenantIdForWrite() === ALTO_TENANT_ID ? await getBlobStore().get(`transport/${name}`) : null);
  if (!buf) throw new HttpError(404, 'not_found', 'No such photo.');
  const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

/* ===== The pre-trip check ================================================== */

const PreTripInput = z.object({
  items: z.array(z.object({ key: z.string().min(1).max(30), ok: z.boolean(), note: z.string().trim().max(200).nullable().optional() })).min(1).max(30),
  odometerMiles: z.number().int().min(0).max(5_000_000).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  photoKey: z.string().regex(/^[0-9a-f-]{36}\.(png|jpg|webp|bin)$/).nullable().optional(),
});

function checkView(c: { id: string; passed: boolean; items: unknown; odometerMiles: number | null; photoS3Key: string | null; notes: string | null; createdAt: Date; driverUserId: string }) {
  const items = (Array.isArray(c.items) ? c.items : []) as Array<{ key: string; ok: boolean; note?: string | null }>;
  return {
    id: c.id,
    passed: c.passed,
    items: items.map((i) => ({ ...i, label: preTripLabel(i.key), safety: PRE_TRIP_ITEMS.find((d) => d.key === i.key)?.safety ?? false })),
    failed: items.filter((i) => !i.ok).map((i) => i.key),
    odometerMiles: c.odometerMiles,
    photoUrl: c.photoS3Key ? `/transport/photos/${c.photoS3Key}` : null,
    notes: c.notes,
    at: c.createdAt.toISOString(),
    driverUserId: c.driverUserId,
  };
}

transportOpsRouter.get('/driver/runs/:id/pre-trip', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  // One walk-around per van per day: the van's latest check on any of the
  // day's runs answers for this run too (lib/transportDrivers vanDayPreTrips).
  const [own, day, settings] = await Promise.all([
    prisma.preTripCheck.findUnique({ where: { runId: run.id } }),
    vanDayPreTrips([{ vanId: run.vanId, serviceDate: run.serviceDate }]),
    hosSettings(),
  ]);
  const latest = day.get(vanDayKey(run.vanId, run.serviceDate)) ?? null;
  const check = latest && latest.checkId !== own?.id ? await prisma.preTripCheck.findUnique({ where: { id: latest.checkId } }) : own;
  res.json({
    required: settings.preTripRequired,
    items: PRE_TRIP_ITEMS,
    check: check ? checkView(check) : null,
    /** The van passed its walk-around today on this or another run — nothing to do before leaving. */
    done: !!latest?.passed,
    /** The check that answers was done for another of the van's runs today. */
    fromOtherRun: !!check && check.runId !== run.id,
  });
});

transportOpsRouter.post('/driver/runs/:id/pre-trip', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status !== 'PLANNED') throw new HttpError(409, 'run_not_planned', 'The pre-trip check is done before the run leaves.');
  const input = PreTripInput.parse(req.body);
  const verdict = evaluatePreTrip(input.items);
  if (verdict.missing.length > 0) {
    throw new HttpError(400, 'incomplete_check', `Answer every item: ${verdict.missing.map(preTripLabel).join(', ')}.`);
  }
  const existing = await prisma.preTripCheck.findUnique({ where: { runId: run.id }, select: { id: true, passed: true } });
  if (existing?.passed) throw new HttpError(409, 'already_checked', 'This run already passed its pre-trip check.');
  const check = await prisma.$transaction(async (tx) => {
    if (existing) await tx.preTripCheck.delete({ where: { id: existing.id } });
    const created = await tx.preTripCheck.create({
      data: {
        runId: run.id,
        vanId: run.vanId,
        driverUserId: req.user!.id,
        tenantId: tenantIdForWrite(),
        items: input.items,
        passed: verdict.passed,
        odometerMiles: input.odometerMiles ?? null,
        photoS3Key: input.photoKey ?? null,
        notes: input.notes ?? null,
      },
    });
    if (input.odometerMiles !== null && input.odometerMiles !== undefined) {
      await tx.van.updateMany({ where: { id: run.vanId, OR: [{ odometerMiles: null }, { odometerMiles: { lt: input.odometerMiles } }] }, data: { odometerMiles: input.odometerMiles } });
    }
    return created;
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: verdict.passed ? 'transport.pretrip_passed' : 'transport.pretrip_failed', entityType: 'RideRun', entityId: run.id, metadata: { vanId: run.vanId, failed: verdict.failed, odometerMiles: input.odometerMiles ?? null } },
    'transportOps',
  );
  // A failed safety item is a VEHICLE issue the desk works — and the run
  // stays on the lot until a check passes.
  if (!verdict.passed) {
    const who = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { email: true, associate: { select: { firstName: true, lastName: true } } } });
    const body = `Pre-trip check failed on ${run.van.name}${run.van.plate ? ` (${run.van.plate})` : ''}: ${verdict.failedSafety.map(preTripLabel).join(', ')}.${input.notes ? ` ${input.notes}` : ''}`;
    await prisma.transportIssue.create({ data: { reportedById: req.user!.id, category: 'VEHICLE', body: body.slice(0, 2000), runId: run.id, tenantId: tenantIdForWrite() } });
    void trackNotificationWork(
      notifyDesk({ subject: `Pre-trip failed — ${run.van.name}`, body: `${who ? personName(who) : 'The driver'}: ${body} The run can't leave until a check passes.`, linkUrl: '/transport?tab=issues' }),
    );
  }
  res.status(201).json({ check: checkView(check), passed: verdict.passed, failedSafety: verdict.failedSafety.map((k) => ({ key: k, label: preTripLabel(k) })) });
});

/* ===== The safety toolkit ================================================== */

transportOpsRouter.post('/driver/runs/:id/sos', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  const input = z.object({ note: z.string().trim().max(300).nullable().optional(), lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional() }).parse(req.body ?? {});
  await raiseSos(run, req.user!.id, input);
  res.status(201).json({ ok: true });
});

transportOpsRouter.post('/driver/runs/:id/ok', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  await driverOk(run.id);
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.driver_ok', entityType: 'RideRun', entityId: run.id }, 'transportOps');
  res.json({ ok: true });
});

transportOpsRouter.get('/driver/runs/:id/share', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status === 'COMPLETED' || run.status === 'CANCELLED') throw new HttpError(409, 'run_closed', 'This run is over.');
  const { token, expiresAt } = shareToken(run.id);
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.trip_shared', entityType: 'RideRun', entityId: run.id, metadata: { expiresAt: expiresAt.toISOString() } }, 'transportOps');
  res.json({ url: `${env.APP_BASE_URL}/track/${token}`, token, expiresAt: expiresAt.toISOString() });
});

/**
 * The rider's share (transport upgrade 2026-10-28): a link they can text
 * someone waiting on them — the van and its ETA to their stop, nothing
 * else (lib/transportSafety riderTrack). Their own ride only; it has to be
 * on a van; it lasts until two hours after the run should be over.
 */
transportOpsRouter.post('/me/rides/:id/share', RIDE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const associateId = req.user!.associateId;
  const ride = associateId
    ? await prisma.ride.findFirst({ where: { id, associateId }, select: { id: true, status: true, runId: true } })
    : null;
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  if (!ride.runId) throw new HttpError(409, 'no_run', "Your ride isn't on a van yet — you can share it once a van is set.");
  if (!['SCHEDULED', 'BOARDED'].includes(ride.status)) throw new HttpError(409, 'ride_over', 'This ride is over — there is nothing to share.');
  const run = await prisma.rideRun.findUnique({ where: { id: ride.runId }, include: liveRunInclude });
  if (!run || run.status === 'CANCELLED' || run.status === 'COMPLETED') throw new HttpError(409, 'ride_over', 'This ride is over — there is nothing to share.');
  const now = new Date();
  const expiresAt = new Date((await expectedRunEnd(run, now)).getTime() + 2 * 3_600_000);
  const { token } = shareToken(run.id, now, { rideId: ride.id, expiresAt });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.ride_shared', entityType: 'Ride', entityId: ride.id, metadata: { runId: run.id, expiresAt: expiresAt.toISOString() } }, 'transportOps');
  res.json({ url: `${env.APP_BASE_URL}/track/${token}`, expiresAt: expiresAt.toISOString() });
});

transportOpsRouter.post('/runs/:id/sos/ack', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const run = await prisma.rideRun.findUnique({ where: { id }, select: { id: true, sosAt: true } });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  if (!run.sosAt) throw new HttpError(409, 'no_sos', 'There is no SOS on this run.');
  await ackSos(run.id, req.user!.id);
  res.json({ ok: true });
});

/** Public: the shared trip. No auth — the link IS the key, and it expires. */
transportOpsRouter.get('/track/:token', async (req, res) => {
  // 410 for a real link past its time (or a run that was cancelled), 404 for one that never was (F500 G5).
  const state = shareTokenState(String(req.params.token));
  if (state === 'invalid') throw new HttpError(404, 'not_found', 'This link is not valid.');
  if (state === 'expired') throw new HttpError(410, 'link_expired', 'This shared trip has expired.');
  const view = await publicTrack(state.runId, new Date(), state.rideId);
  if (!view) throw new HttpError(410, 'link_expired', 'This trip is no longer shared.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ trip: view });
});

/* ===== Incidents ============================================================ */

const IncidentInput = z.object({
  kind: z.enum(['COLLISION', 'INJURY', 'BREAKDOWN', 'NEAR_MISS', 'PROPERTY_DAMAGE', 'OTHER']),
  runId: z.string().uuid().nullable().optional(),
  vanId: z.string().uuid().nullable().optional(),
  occurredAt: z.string().datetime().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  description: z.string().trim().min(10).max(4000),
  injuries: z.boolean().default(false),
  injuredAssociateIds: z.array(z.string().uuid()).max(30).default([]),
  parties: z
    .array(z.object({ name: z.string().trim().max(120), phone: z.string().trim().max(40).nullable().optional(), plate: z.string().trim().max(20).nullable().optional(), insurer: z.string().trim().max(120).nullable().optional(), note: z.string().trim().max(300).nullable().optional() }))
    .max(10)
    .default([]),
  policeReportNumber: z.string().trim().max(60).nullable().optional(),
  photoKeys: z.array(z.string().regex(/^[0-9a-f-]{36}\.(png|jpg|webp|bin)$/)).max(12).default([]),
  parkVan: z.boolean().optional(),
});

const incidentInclude = {
  reportedBy: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  van: { select: { id: true, name: true, plate: true } },
  run: { select: { id: true, serviceDate: true, departAt: true, direction: true } },
} satisfies Prisma.TransportIncidentInclude;

function incidentView(i: Prisma.TransportIncidentGetPayload<{ include: typeof incidentInclude }>) {
  return {
    id: i.id,
    kind: i.kind,
    status: i.status,
    occurredAt: i.occurredAt.toISOString(),
    point: i.lat !== null && i.lng !== null ? { lat: Number(i.lat), lng: Number(i.lng) } : null,
    description: i.description,
    injuries: i.injuries,
    injuredAssociateIds: (i.injuredAssociateIds as string[]) ?? [],
    parties: (i.parties as Array<Record<string, string | null>>) ?? [],
    policeReportNumber: i.policeReportNumber,
    photos: ((i.photoKeys as string[]) ?? []).map((k) => `/transport/photos/${k}`),
    oshaIncidentIds: (i.oshaIncidentIds as string[]) ?? [],
    vanParked: i.vanParked,
    reviewNote: i.reviewNote,
    reviewedAt: iso(i.reviewedAt),
    reportedBy: { userId: i.reportedBy.id, name: personName(i.reportedBy) },
    van: i.van,
    run: i.run ? { id: i.run.id, serviceDate: i.run.serviceDate, departAt: i.run.departAt.toISOString(), direction: i.run.direction } : null,
    createdAt: i.createdAt.toISOString(),
  };
}

transportOpsRouter.post('/incidents', requireAuth, async (req, res) => {
  const role = req.user!.role;
  if (!hasCapability(role, 'drive:transport') && !hasCapability(role, 'manage:transport')) throw new HttpError(403, 'forbidden', 'Not allowed.');
  const input = IncidentInput.parse(req.body);
  let vanId = input.vanId ?? null;
  let run: { id: string; vanId: string; driverUserId: string; status: string } | null = null;
  if (input.runId) {
    run = await prisma.rideRun.findUnique({ where: { id: input.runId }, select: { id: true, vanId: true, driverUserId: true, status: true } });
    if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
    if (run.driverUserId !== req.user!.id && !hasCapability(role, 'manage:transport')) throw new HttpError(404, 'not_found', 'Run not found.');
    vanId = vanId ?? run.vanId;
  }
  if (vanId && !(await prisma.van.findUnique({ where: { id: vanId }, select: { id: true } }))) throw new HttpError(400, 'van_not_found', 'No such van.');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const parkVan = input.parkVan ?? (input.kind === 'COLLISION' || input.kind === 'BREAKDOWN');

  // Each person hurt gets an OSHA incident: the client is the store the
  // run was serving, else wherever the person is placed.
  const oshaIds: string[] = [];
  if (input.injuries && input.injuredAssociateIds.length > 0) {
    const stores = run
      ? await prisma.ride.findMany({ where: { runId: run.id }, select: { location: { select: { id: true, clientId: true, name: true } } }, take: 1 })
      : [];
    const fallback = stores[0]?.location ?? null;
    for (const associateId of input.injuredAssociateIds) {
      const assoc = await prisma.associate.findUnique({ where: { id: associateId }, select: { id: true, applications: { where: { status: 'APPROVED', deletedAt: null }, select: { clientId: true }, take: 1 } } });
      if (!assoc) continue;
      const clientId = fallback?.clientId ?? assoc.applications[0]?.clientId ?? null;
      if (!clientId) continue;
      const created = await prisma.oshaIncident.create({
        data: {
          clientId,
          locationId: fallback?.clientId === clientId ? fallback.id : null,
          associateId,
          occurredAt,
          location: 'In transit (Alto van)',
          description: `Transport incident (${input.kind.toLowerCase().replace(/_/g, ' ')}): ${input.description}`.slice(0, 4000),
          severity: 'MEDICAL_TREATMENT',
          reportedById: req.user!.id,
          tenantId: tenantIdForWrite(),
        },
        select: { id: true },
      });
      oshaIds.push(created.id);
    }
  }

  const incident = await prisma.$transaction(async (tx) => {
    const created = await tx.transportIncident.create({
      data: {
        tenantId: tenantIdForWrite(),
        kind: input.kind,
        runId: run?.id ?? null,
        vanId,
        reportedById: req.user!.id,
        occurredAt,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        description: input.description,
        injuries: input.injuries,
        injuredAssociateIds: input.injuredAssociateIds,
        parties: input.parties,
        policeReportNumber: input.policeReportNumber ?? null,
        photoKeys: input.photoKeys,
        oshaIncidentIds: oshaIds,
        vanParked: parkVan && !!vanId,
      },
      include: incidentInclude,
    });
    if (parkVan && vanId) {
      await tx.van.update({ where: { id: vanId }, data: { outOfServiceAt: occurredAt, outOfServiceReason: `${input.kind.toLowerCase().replace(/_/g, ' ')} on ${fmtDayInZone(occurredAt, companyZone())} — see incident` } });
    }
    return created;
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.incident_reported', entityType: 'TransportIncident', entityId: incident.id, metadata: { kind: input.kind, runId: run?.id ?? null, vanId, injuries: input.injuries, osha: oshaIds, vanParked: incident.vanParked } },
    'transportOps',
  );
  void trackNotificationWork(
    notifyDesk({
      subject: `${input.kind === 'INJURY' || input.injuries ? 'Injury' : input.kind.charAt(0) + input.kind.slice(1).toLowerCase().replace(/_/g, ' ')} reported${incident.van ? ` — ${incident.van.name}` : ''}`,
      body: `${personName(incident.reportedBy)}: ${input.description.slice(0, 240)}${input.description.length > 240 ? '…' : ''}${incident.vanParked ? ' The van is out of service until you put it back.' : ''}${oshaIds.length ? ` ${oshaIds.length} OSHA incident${oshaIds.length === 1 ? '' : 's'} opened.` : ''}`,
      linkUrl: '/transport?tab=issues',
    }),
  );
  res.status(201).json({ incident: incidentView(incident) });
});

transportOpsRouter.get('/incidents', VIEW, async (req, res) => {
  const q = z.object({ status: z.enum(['OPEN', 'REVIEWED', 'CLOSED']).optional(), vanId: z.string().uuid().optional() }).parse(req.query);
  const rows = await prisma.transportIncident.findMany({
    where: { ...(q.status ? { status: q.status } : {}), ...(q.vanId ? { vanId: q.vanId } : {}) },
    orderBy: { occurredAt: 'desc' },
    include: incidentInclude,
    take: 200,
  });
  res.json({ incidents: rows.map(incidentView) });
});

transportOpsRouter.patch('/incidents/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ status: z.enum(['OPEN', 'REVIEWED', 'CLOSED']).optional(), reviewNote: z.string().trim().max(2000).nullable().optional() }).parse(req.body);
  const before = await prisma.transportIncident.findUnique({ where: { id }, select: { id: true } });
  if (!before) throw new HttpError(404, 'not_found', 'Incident not found.');
  const updated = await prisma.transportIncident.update({
    where: { id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.reviewNote !== undefined ? { reviewNote: input.reviewNote } : {}),
      ...(input.status && input.status !== 'OPEN' ? { reviewedAt: new Date(), reviewedById: req.user!.id } : {}),
    },
    include: incidentInclude,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.incident_reviewed', entityType: 'TransportIncident', entityId: id, metadata: input }, 'transportOps');
  res.json({ incident: incidentView(updated) });
});

/* ===== The rider's thumb ================================================= */

const FEEDBACK_REASONS = ['GREAT', 'LATE', 'DRIVING', 'VEHICLE', 'CONDUCT', 'ROUTE', 'OTHER'] as const;

transportOpsRouter.post('/me/rides/:id/feedback', RIDE, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate', 'Your login is not linked to an associate record yet.');
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ thumbsUp: z.boolean(), reason: z.enum(FEEDBACK_REASONS).nullable().optional(), note: z.string().trim().max(500).nullable().optional() }).parse(req.body);
  const ride = await prisma.ride.findFirst({ where: { id, associateId }, select: { id: true, status: true, runId: true } });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  if (ride.status !== 'COMPLETED') throw new HttpError(409, 'not_completed', 'You can rate a ride once it is done.');
  const fb = await prisma.rideFeedback.upsert({
    where: { rideId: ride.id },
    create: { rideId: ride.id, associateId, thumbsUp: input.thumbsUp, reason: input.reason ?? null, note: input.note ?? null, tenantId: tenantIdForWrite() },
    update: { thumbsUp: input.thumbsUp, reason: input.reason ?? null, note: input.note ?? null },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.ride_feedback', entityType: 'Ride', entityId: ride.id, metadata: { thumbsUp: input.thumbsUp, reason: input.reason ?? null } }, 'transportOps');
  res.status(201).json({ feedback: { id: fb.id, thumbsUp: fb.thumbsUp, reason: fb.reason, note: fb.note } });
});

/** Rides finished in the last three days the rider hasn't rated — one card, dismissable by rating. */
transportOpsRouter.get('/me/feedback/pending', RIDE, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) {
    res.json({ rides: [] });
    return;
  }
  const rows = await prisma.ride.findMany({
    where: { associateId, status: 'COMPLETED', completedAt: { gte: new Date(Date.now() - 3 * 86_400_000) }, feedback: null },
    orderBy: { completedAt: 'desc' },
    take: 3,
    select: {
      id: true,
      direction: true,
      completedAt: true,
      location: { select: { name: true, timezone: true } },
      run: { select: { van: { select: { name: true } }, driver: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } } },
    },
  });
  res.json({
    rides: rows.map((r) => ({
      rideId: r.id,
      direction: r.direction,
      completedAt: iso(r.completedAt),
      store: r.location.name,
      timezone: r.location.timezone,
      van: r.run?.van.name ?? null,
      driver: r.run ? personName(r.run.driver).split(' ')[0] : null,
    })),
    reasons: FEEDBACK_REASONS,
  });
});

/** The director's read: thumbs by driver and by route, and the notes. */
transportOpsRouter.get('/feedback', VIEW, async (req, res) => {
  const q = z.object({ from: dateOnly, to: dateOnly }).parse(req.query);
  const rows = await prisma.rideFeedback.findMany({
    where: { ride: { serviceDate: { gte: q.from, lte: q.to } } },
    orderBy: { createdAt: 'desc' },
    select: {
      thumbsUp: true,
      reason: true,
      note: true,
      createdAt: true,
      ride: {
        select: {
          direction: true,
          serviceDate: true,
          location: { select: { id: true, name: true } },
          run: { select: { driver: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } } } },
        },
      },
    },
    take: 5000,
  });
  type Tally = { up: number; down: number; reasons: Record<string, number> };
  const tally = (): Tally => ({ up: 0, down: 0, reasons: {} });
  const add = (t: Tally, r: { thumbsUp: boolean; reason: string | null }) => {
    if (r.thumbsUp) t.up += 1;
    else t.down += 1;
    if (r.reason) t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1;
  };
  const byDriver = new Map<string, Tally & { userId: string; name: string }>();
  const byRoute = new Map<string, Tally & { locationId: string; store: string; direction: string }>();
  const total = tally();
  for (const r of rows) {
    add(total, r);
    const d = r.ride.run?.driver;
    if (d) {
      const t = byDriver.get(d.id) ?? { ...tally(), userId: d.id, name: personName(d) };
      add(t, r);
      byDriver.set(d.id, t);
    }
    const key = `${r.ride.location.id}|${r.ride.direction}`;
    const t = byRoute.get(key) ?? { ...tally(), locationId: r.ride.location.id, store: r.ride.location.name, direction: r.ride.direction };
    add(t, r);
    byRoute.set(key, t);
  }
  const score = (t: Tally) => (t.up + t.down > 0 ? Math.round((t.up / (t.up + t.down)) * 100) : null);
  res.json({
    from: q.from,
    to: q.to,
    total: { ...total, score: score(total) },
    byDriver: [...byDriver.values()].map((t) => ({ ...t, score: score(t) })).sort((a, b) => (a.score ?? 101) - (b.score ?? 101)),
    byRoute: [...byRoute.values()].map((t) => ({ ...t, score: score(t) })).sort((a, b) => (a.score ?? 101) - (b.score ?? 101)),
    notes: rows
      .filter((r) => r.note)
      .slice(0, 50)
      .map((r) => ({ at: r.createdAt.toISOString(), thumbsUp: r.thumbsUp, reason: r.reason, note: r.note, store: r.ride.location.name, driver: r.ride.run ? personName(r.ride.run.driver) : null })),
  });
});

/* ===== Standing bookings ================================================== */

const SeriesInput = z
  .object({
    direction: z.enum(['TO_WORK', 'FROM_WORK']),
    locationId: z.string().uuid(),
    stopId: z.string().uuid().optional(),
    placeId: z.string().uuid().optional(),
    address: z.string().trim().min(3).max(300).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    windowLabel: z.string().trim().min(1).max(80).optional(),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startsOn: dateOnly,
    endsOn: dateOnly.nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.stopId && !v.placeId && !v.address) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopId'], message: 'Pick a stop, a saved address or an address.' });
    if (!v.windowLabel && !v.timeOfDay) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['windowLabel'], message: 'Pick a shift or a time.' });
    if (v.endsOn && v.endsOn < v.startsOn) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsOn'], message: 'The end is before the start.' });
  });

function seriesView(s: {
  id: string;
  direction: string;
  locationId: string;
  stopId: string | null;
  address: string | null;
  windowLabel: string | null;
  timeOfDay: string | null;
  daysOfWeek: number[];
  startsOn: Date;
  endsOn: Date | null;
  note: string | null;
  cancelledAt: Date | null;
  generatedThrough: Date | null;
  location: { id: string; name: string; timezone: string };
  stop: { id: string; name: string } | null;
  _count?: { rides: number };
}) {
  return {
    id: s.id,
    direction: s.direction,
    store: { id: s.location.id, name: s.location.name, timezone: s.location.timezone },
    pickup: s.stop ? { kind: 'stop' as const, id: s.stop.id, name: s.stop.name } : { kind: 'address' as const, id: null, name: null, address: s.address ?? '' },
    windowLabel: s.windowLabel,
    timeOfDay: s.timeOfDay,
    daysOfWeek: s.daysOfWeek,
    startsOn: ymd(s.startsOn),
    endsOn: ymd(s.endsOn),
    note: s.note,
    active: !s.cancelledAt,
    bookedThrough: ymd(s.generatedThrough),
    rides: s._count?.rides ?? 0,
  };
}

const seriesInclude = {
  location: { select: { id: true, name: true, timezone: true } },
  stop: { select: { id: true, name: true } },
  _count: { select: { rides: { where: { status: { in: ['REQUESTED', 'SCHEDULED'] } } } } },
} satisfies Prisma.RideSeriesInclude;

transportOpsRouter.get('/me/series', RIDE, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) {
    res.json({ series: [] });
    return;
  }
  const rows = await prisma.rideSeries.findMany({ where: { associateId, cancelledAt: null }, orderBy: { createdAt: 'asc' }, include: seriesInclude });
  res.json({ series: rows.map(seriesView) });
});

transportOpsRouter.post('/me/series', RIDE, async (req, res) => {
  const associateId = req.user!.associateId;
  if (!associateId) throw new HttpError(403, 'no_associate', 'Your login is not linked to an associate record yet.');
  const input = SeriesInput.parse(req.body);
  const store = (await bookableStores(associateId, req.user!.clientId ?? null)).find((s) => s.id === input.locationId);
  if (!store) throw new HttpError(403, 'store_not_allowed', 'You can book rides to your own stores only.');
  if (input.windowLabel) {
    const w = (await storeShiftWindows([store.id])).get(store.id)?.find((x) => x.label === input.windowLabel);
    if (!w) throw new HttpError(400, 'shift_not_found', `${store.name} has no ${input.windowLabel} shift.`);
  }
  let stopId: string | null = null;
  let address: string | null = null;
  let at: { lat: number; lng: number } | null = null;
  if (input.stopId) {
    const stop = await prisma.transportStop.findFirst({ where: { id: input.stopId, isActive: true }, select: { id: true } });
    if (!stop) throw new HttpError(400, 'stop_not_found', 'That pickup stop is not available.');
    stopId = stop.id;
  } else if (input.placeId) {
    const place = await prisma.ridePlace.findFirst({ where: { id: input.placeId, associateId } });
    if (!place) throw new HttpError(400, 'place_not_found', 'That saved address is gone.');
    address = place.address;
    at = place.lat !== null && place.lng !== null ? { lat: Number(place.lat), lng: Number(place.lng) } : await geocode(place.address);
    if (!at) throw new HttpError(422, 'place_not_located', `Your saved address "${place.label}" isn't on the map yet. Drop a pin on it first.`, { placeId: place.id });
  } else {
    address = input.address!;
    at = input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : await geocode(address);
    if (!at) throw new HttpError(422, 'pickup_not_located', 'We could not place that address on the map. Pick a suggestion or drop a pin.');
  }
  const fence = at ? await prisma.site.findUnique({ where: { id: store.id }, select: { latitude: true, longitude: true } }) : null;
  if (at && fence?.latitude != null && fence.longitude != null && haversineM(at, { lat: Number(fence.latitude), lng: Number(fence.longitude) }) < 150) {
    throw new HttpError(422, 'pickup_at_store', `That pickup is ${store.name} itself. Use the address where you live.`);
  }
  const series = await prisma.rideSeries.create({
    data: {
      associateId,
      tenantId: tenantIdForWrite(),
      direction: input.direction,
      locationId: store.id,
      stopId,
      address,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      windowLabel: input.windowLabel ?? null,
      timeOfDay: input.windowLabel ? null : (input.timeOfDay ?? null),
      daysOfWeek: [...new Set(input.daysOfWeek)].sort(),
      startsOn: toDate(input.startsOn)!,
      endsOn: toDate(input.endsOn ?? null),
      note: input.note ?? null,
      createdById: req.user!.id,
    },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.series_created', entityType: 'RideSeries', entityId: series.id, metadata: { direction: input.direction, locationId: store.id, daysOfWeek: series.daysOfWeek, windowLabel: series.windowLabel, timeOfDay: series.timeOfDay } }, 'transportOps');
  const booked = await generateSeries(series);
  const row = await prisma.rideSeries.findUniqueOrThrow({ where: { id: series.id }, include: seriesInclude });
  // Every driver's list (and the desk) refreshes for the new seats.
  const watchers = await prisma.user.findMany({ where: { ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  for (const u of watchers) emitLiveEvent(u.id, 'transport');
  res.status(201).json({ series: seriesView(row), booked: booked.booked, skipped: booked.skipped });
});

transportOpsRouter.delete('/me/series/:id', RIDE, async (req, res) => {
  const associateId = req.user!.associateId;
  const id = z.string().uuid().parse(req.params.id);
  const r = await prisma.rideSeries.updateMany({ where: { id, associateId: associateId ?? '00000000-0000-0000-0000-000000000000', cancelledAt: null }, data: { cancelledAt: new Date() } });
  if (!r.count) throw new HttpError(404, 'not_found', 'No such standing booking.');
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.series_cancelled', entityType: 'RideSeries', entityId: id }, 'transportOps');
  res.status(204).end();
});

/** What a series' next ride would be — for the form's preview. */
transportOpsRouter.get('/me/series/preview', RIDE, async (req, res) => {
  const q = z.object({ locationId: z.string().uuid(), direction: z.enum(['TO_WORK', 'FROM_WORK']), windowLabel: z.string().optional(), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(), date: dateOnly }).parse(req.query);
  const store = await prisma.site.findUnique({ where: { id: q.locationId }, select: { timezone: true } });
  if (!store) throw new HttpError(404, 'not_found', 'Store not found.');
  const at = await seriesTargetAt({ locationId: q.locationId, direction: q.direction, windowLabel: q.windowLabel ?? null, timeOfDay: q.timeOfDay ?? null }, q.date, store.timezone);
  res.json({ targetAt: iso(at) });
});

/* ===== The fleet record =================================================== */

const vanRecordSelect = {
  id: true,
  name: true,
  plate: true,
  capacity: true,
  isActive: true,
  make: true,
  model: true,
  color: true,
  year: true,
  vin: true,
  registrationExpiresAt: true,
  insuranceExpiresAt: true,
  inspectionDueAt: true,
  odometerMiles: true,
  outOfServiceAt: true,
  outOfServiceReason: true,
} satisfies Prisma.VanSelect;

function vanRecordView(v: Prisma.VanGetPayload<{ select: typeof vanRecordSelect }>, now = new Date()) {
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const doc = (label: string, at: Date | null) => ({ label, expiresAt: ymd(at), expired: !!at && at < now, dueSoon: !!at && at >= now && at < soon });
  return {
    id: v.id,
    name: v.name,
    plate: v.plate,
    vin: v.vin,
    odometerMiles: v.odometerMiles,
    registrationExpiresAt: ymd(v.registrationExpiresAt),
    insuranceExpiresAt: ymd(v.insuranceExpiresAt),
    inspectionDueAt: ymd(v.inspectionDueAt),
    outOfService: v.outOfServiceAt ? { since: v.outOfServiceAt.toISOString(), reason: v.outOfServiceReason } : null,
    documents: [doc('Registration', v.registrationExpiresAt), doc('Insurance', v.insuranceExpiresAt), doc('State inspection', v.inspectionDueAt)],
  };
}

transportOpsRouter.get('/vans/:id/record', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const van = await prisma.van.findUnique({ where: { id }, select: vanRecordSelect });
  if (!van) throw new HttpError(404, 'not_found', 'Van not found.');
  const [log, checks, incidents] = await Promise.all([
    prisma.vanServiceEntry.findMany({ where: { vanId: id }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 100 }),
    prisma.preTripCheck.findMany({ where: { vanId: id }, orderBy: { createdAt: 'desc' }, take: 20, include: { driver: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } } }),
    prisma.transportIncident.findMany({ where: { vanId: id }, orderBy: { occurredAt: 'desc' }, take: 10, include: incidentInclude }),
  ]);
  res.json({
    record: vanRecordView(van),
    serviceLog: log.map((e) => ({ id: e.id, kind: e.kind, occurredAt: ymd(e.occurredAt), odometerMiles: e.odometerMiles, costCents: e.costCents, vendor: e.vendor, notes: e.notes, photoUrl: transportPhotoUrl(e.photoS3Key) })),
    checks: checks.map((c) => ({ ...checkView(c), driver: personName(c.driver) })),
    incidents: incidents.map(incidentView),
  });
});

const VanRecordInput = z.object({
  vin: z.string().trim().max(17).nullable().optional(),
  registrationExpiresAt: dateOnly.nullable().optional(),
  insuranceExpiresAt: dateOnly.nullable().optional(),
  inspectionDueAt: dateOnly.nullable().optional(),
  odometerMiles: z.number().int().min(0).max(5_000_000).nullable().optional(),
  /** `{ reason }` takes the van out of service; `null` puts it back. */
  outOfService: z.object({ reason: z.string().trim().min(2).max(300) }).nullable().optional(),
});

transportOpsRouter.patch('/vans/:id/record', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = VanRecordInput.parse(req.body);
  const before = await prisma.van.findUnique({ where: { id }, select: { id: true, name: true, outOfServiceAt: true } });
  if (!before) throw new HttpError(404, 'not_found', 'Van not found.');
  const data: Prisma.VanUpdateInput = {};
  if (input.vin !== undefined) data.vin = input.vin ? input.vin.toUpperCase() : null;
  if (input.registrationExpiresAt !== undefined) data.registrationExpiresAt = toDate(input.registrationExpiresAt);
  if (input.insuranceExpiresAt !== undefined) data.insuranceExpiresAt = toDate(input.insuranceExpiresAt);
  if (input.inspectionDueAt !== undefined) data.inspectionDueAt = toDate(input.inspectionDueAt);
  if (input.odometerMiles !== undefined) data.odometerMiles = input.odometerMiles;
  if (input.outOfService !== undefined) {
    data.outOfServiceAt = input.outOfService ? new Date() : null;
    data.outOfServiceReason = input.outOfService?.reason ?? null;
  }
  const van = await prisma.van.update({ where: { id }, data, select: vanRecordSelect });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.van_record_changed', entityType: 'Van', entityId: id, metadata: input }, 'transportOps');
  if (input.outOfService !== undefined && !!input.outOfService !== !!before.outOfServiceAt && van.outOfServiceAt) {
    // Runs planned on a parked van need another van: the desk is told.
    const plannedRuns = await prisma.rideRun.findMany({ where: { vanId: id, status: 'PLANNED', departAt: { gte: new Date() } }, orderBy: { departAt: 'asc' }, select: { serviceDate: true } });
    const planned = plannedRuns.length;
    if (planned > 0) {
      // Straight to the board on the first day that needs another van.
      const linkUrl = `/transport?date=${plannedRuns[0]!.serviceDate}`;
      void trackNotificationWork(notifyDesk({ subject: `${before.name} is out of service — ${planned} planned run${planned === 1 ? '' : 's'} need another van`, body: input.outOfService?.reason ?? '', linkUrl }));
    }
  }
  res.json({ record: vanRecordView(van) });
});

const ServiceInput = z.object({
  kind: z.enum(['FUEL', 'OIL_CHANGE', 'TIRES', 'BRAKES', 'INSPECTION', 'REPAIR', 'CLEANING', 'OTHER']),
  occurredAt: dateOnly,
  odometerMiles: z.number().int().min(0).max(5_000_000).nullable().optional(),
  costCents: z.number().int().min(0).max(100_000_000).default(0),
  vendor: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

transportOpsRouter.post('/vans/:id/service', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = ServiceInput.parse(req.body);
  const van = await prisma.van.findUnique({ where: { id }, select: { id: true, odometerMiles: true, inspectionDueAt: true } });
  if (!van) throw new HttpError(404, 'not_found', 'Van not found.');
  const entry = await prisma.$transaction(async (tx) => {
    const created = await tx.vanServiceEntry.create({
      data: { vanId: id, tenantId: tenantIdForWrite(), kind: input.kind, occurredAt: toDate(input.occurredAt)!, odometerMiles: input.odometerMiles ?? null, costCents: input.costCents, vendor: input.vendor ?? null, notes: input.notes ?? null, createdById: req.user!.id },
    });
    const data: Prisma.VanUpdateInput = {};
    if (input.odometerMiles !== null && input.odometerMiles !== undefined && (van.odometerMiles === null || input.odometerMiles > van.odometerMiles)) data.odometerMiles = input.odometerMiles;
    // A passed state inspection is good for a year.
    if (input.kind === 'INSPECTION') data.inspectionDueAt = new Date(Date.parse(`${input.occurredAt}T00:00:00Z`) + 365 * 86_400_000);
    if (Object.keys(data).length > 0) await tx.van.update({ where: { id }, data });
    return created;
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.van_serviced', entityType: 'Van', entityId: id, metadata: { entryId: entry.id, kind: input.kind, costCents: input.costCents } }, 'transportOps');
  res.status(201).json({ entry: { id: entry.id, kind: entry.kind, occurredAt: ymd(entry.occurredAt), odometerMiles: entry.odometerMiles, costCents: entry.costCents, vendor: entry.vendor, notes: entry.notes } });
});

transportOpsRouter.delete('/vans/:id/service/:entryId', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const entryId = z.string().uuid().parse(req.params.entryId);
  const r = await prisma.vanServiceEntry.deleteMany({ where: { id: entryId, vanId: id } });
  if (!r.count) throw new HttpError(404, 'not_found', 'No such entry.');
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.van_service_removed', entityType: 'Van', entityId: id, metadata: { entryId } }, 'transportOps');
  res.status(204).end();
});

/* ===== The desk's drivers =================================================== */

transportOpsRouter.get('/drivers', VIEW, async (_req, res) => {
  const now = new Date();
  const date = dateKeyInZone(now, companyZone());
  const { from, to } = dayBounds(date);
  const [users, vans, shifts] = await Promise.all([
    prisma.user.findMany({
      where: { ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        additionalRoles: true,
        associateId: true,
        photoS3Key: true,
        photoUpdatedAt: true,
        associate: { select: { id: true, firstName: true, lastName: true, phone: true, photoS3Key: true, photoUpdatedAt: true } },
        driverProfile: true,
      },
    }),
    prisma.van.findMany({ where: { driverUserId: { not: null } }, select: { id: true, name: true, plate: true, driverUserId: true, outOfServiceAt: true } }),
    driverShiftsBetween(from, to),
  ]);
  res.json({
    drivers: users
      .map((u) => {
        const van = vans.find((v) => v.driverUserId === u.id) ?? null;
        const todays = u.associateId ? shifts.filter((s) => s.assignedAssociateId === u.associateId) : [];
        return {
          userId: u.id,
          name: personName(u),
          role: u.role,
          drivesByTrade: u.role === 'DRIVER' || u.additionalRoles.includes('DRIVER'),
          phone: u.associate?.phone ?? null,
          associateId: u.associateId,
          photoUrl: accountPhotoUrlFor(u),
          van: van ? { id: van.id, name: van.name, plate: van.plate, outOfService: !!van.outOfServiceAt } : null,
          profile: profileView(u.driverProfile),
          credentials: driverCredentialStatus(u.driverProfile, now),
          today: todays.map((s) => ({ id: s.id, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) })),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

const ProfileInput = z.object({
  navApp: z.enum(['GOOGLE', 'APPLE', 'WAZE']).optional(),
  licenceNumber: z.string().trim().max(40).nullable().optional(),
  licenceState: z.string().trim().length(2).toUpperCase().nullable().optional(),
  licenceClass: z.string().trim().max(10).nullable().optional(),
  licenceExpiresAt: dateOnly.nullable().optional(),
  dotMedicalRequired: z.boolean().optional(),
  dotMedicalExpiresAt: dateOnly.nullable().optional(),
  mvrCheckedAt: dateOnly.nullable().optional(),
  trainingCompletedAt: dateOnly.nullable().optional(),
  trainingExpiresAt: dateOnly.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

transportOpsRouter.patch('/drivers/:userId/profile', MANAGE, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const input = ProfileInput.parse(req.body);
  const driver = await prisma.user.findFirst({ where: { id: userId, ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), deletedAt: null }, select: { id: true } });
  if (!driver) throw new HttpError(404, 'driver_not_found', 'No such driver.');
  const data: Omit<Prisma.DriverProfileUncheckedCreateInput, 'userId'> = { updatedById: req.user!.id };
  if (input.navApp !== undefined) data.navApp = input.navApp;
  if (input.licenceNumber !== undefined) data.licenceNumber = input.licenceNumber;
  if (input.licenceState !== undefined) data.licenceState = input.licenceState;
  if (input.licenceClass !== undefined) data.licenceClass = input.licenceClass;
  if (input.licenceExpiresAt !== undefined) data.licenceExpiresAt = toDate(input.licenceExpiresAt);
  if (input.dotMedicalRequired !== undefined) data.dotMedicalRequired = input.dotMedicalRequired;
  if (input.dotMedicalExpiresAt !== undefined) data.dotMedicalExpiresAt = toDate(input.dotMedicalExpiresAt);
  if (input.mvrCheckedAt !== undefined) data.mvrCheckedAt = toDate(input.mvrCheckedAt);
  if (input.trainingCompletedAt !== undefined) data.trainingCompletedAt = toDate(input.trainingCompletedAt);
  if (input.trainingExpiresAt !== undefined) data.trainingExpiresAt = toDate(input.trainingExpiresAt);
  if (input.notes !== undefined) data.notes = input.notes;
  const profile = await prisma.driverProfile.upsert({
    where: { userId },
    create: { userId, tenantId: tenantIdForWrite(), ...data },
    update: data,
  });
  await syncDriverQualifications(prisma, userId);
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.driver_profile_changed', entityType: 'User', entityId: userId, metadata: { ...input, licenceNumber: input.licenceNumber ? '•••' : input.licenceNumber } }, 'transportOps');
  res.json({ profile: profileView(profile), credentials: driverCredentialStatus(profile) });
});

/* ----- Driver shifts ----------------------------------------------------- */

async function shiftViews(rows: Array<Prisma.ShiftGetPayload<{ select: typeof driverShiftSelect }>>) {
  const ids = [...new Set(rows.map((s) => s.assignedAssociateId).filter((x): x is string => !!x))];
  const people = ids.length
    ? await prisma.user.findMany({ where: { associateId: { in: ids }, deletedAt: null }, select: { id: true, email: true, associateId: true, associate: { select: { firstName: true, lastName: true } } } })
    : [];
  return rows.map((s) => {
    const u = people.find((p) => p.associateId === s.assignedAssociateId);
    return { id: s.id, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), status: s.status, notes: s.notes, driver: u ? { userId: u.id, name: personName(u), associateId: u.associateId } : null };
  });
}

transportOpsRouter.get('/driver-shifts', VIEW, async (req, res) => {
  const q = z.object({ from: dateOnly.optional(), to: dateOnly.optional() }).parse(req.query);
  const today = dateKeyInZone(new Date(), companyZone());
  const from = dayBounds(q.from ?? today).from;
  const to = dayBounds(q.to ?? q.from ?? today).to;
  const rows = await driverShiftsBetween(from, to);
  res.json({ shifts: await shiftViews(rows) });
});

transportOpsRouter.post('/driver-shifts', MANAGE, async (req, res) => {
  const input = z.object({ driverUserId: z.string().uuid(), startsAt: z.string().datetime(), endsAt: z.string().datetime(), notes: z.string().trim().max(500).nullable().optional() }).parse(req.body);
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  if (endsAt <= startsAt) throw new HttpError(400, 'bad_span', 'The shift ends before it starts.');
  const driver = await prisma.user.findFirst({
    where: { id: input.driverUserId, ...actsAsAny(['DRIVER', 'TRANSPORTATION_DIRECTOR']), status: 'ACTIVE', deletedAt: null },
    select: { id: true, email: true, associateId: true, associate: { select: { firstName: true, lastName: true } } },
  });
  if (!driver) throw new HttpError(404, 'driver_not_found', 'No such driver.');
  if (!driver.associateId) {
    throw new HttpError(409, 'driver_not_on_file', `${personName(driver)} has no person record, so they can't be scheduled or paid. Link their login to a person in Users first.`);
  }
  const settings = await hosSettings();
  await assertShiftWithinHos(driver.associateId, startsAt, endsAt, settings);
  const shift = await prisma.shift.create({
    data: {
      clientId: null,
      locationId: settings.driverShiftLocationId,
      position: DRIVER_POSITION,
      startsAt,
      endsAt,
      status: 'ASSIGNED',
      assignedAssociateId: driver.associateId,
      assignedAt: new Date(),
      publishedAt: new Date(),
      notes: input.notes ?? null,
      createdById: req.user!.id,
      tenantId: tenantIdForWrite(),
    },
    select: driverShiftSelect,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.driver_shift_created', entityType: 'Shift', entityId: shift.id, metadata: { driverUserId: driver.id, startsAt: input.startsAt, endsAt: input.endsAt } }, 'transportOps');
  void trackNotificationWork(
    notifyUser(driver.id, {
      subject: 'A driver shift for you',
      body: `${new Intl.DateTimeFormat('en-US', { timeZone: companyZone(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(startsAt)} – ${new Intl.DateTimeFormat('en-US', { timeZone: companyZone(), hour: 'numeric', minute: '2-digit' }).format(endsAt)}. Clock in from your runs when you start.`,
      category: 'transport',
      linkUrl: '/',
    }),
  );
  emitLiveEvent(driver.id, 'transport');
  res.status(201).json({ shift: (await shiftViews([shift]))[0] });
});

transportOpsRouter.delete('/driver-shifts/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const shift = await prisma.shift.findFirst({ where: { id, position: DRIVER_POSITION, status: { not: 'CANCELLED' } }, select: { id: true, assignedAssociateId: true, startsAt: true } });
  if (!shift) throw new HttpError(404, 'not_found', 'No such driver shift.');
  await prisma.shift.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancellationReason: 'Removed by transportation' } });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.driver_shift_cancelled', entityType: 'Shift', entityId: id }, 'transportOps');
  if (shift.assignedAssociateId) {
    void trackNotificationWork(notifyAssociate(shift.assignedAssociateId, { subject: 'A driver shift was removed', body: `Your driver shift on ${fmtDayInZone(shift.startsAt, companyZone(), { weekday: true })} was taken off the schedule.`, category: 'transport', linkUrl: '/' }));
  }
  res.status(204).end();
});

/* ===== Needs you ============================================================= */

export interface NeedsYouItem {
  key: string;
  label: string;
  count: number;
  path: string;
  tone: 'alert' | 'warning' | 'info';
}

/** Everything waiting on the transportation desk right now, counted. */
export async function transportNeedsYou(now = new Date()): Promise<{ total: number; items: NeedsYouItem[] }> {
  const date = dateKeyInZone(now, companyZone());
  const [sos, escalated, needsVan, late, safetyIssues, incidents, access, expiring] = await Promise.all([
    prisma.rideRun.count({ where: { status: 'ACTIVE', sosAt: { not: null }, sosAckAt: null } }),
    prisma.rideRun.count({ where: { status: 'ACTIVE', stallEscalatedAt: { not: null } } }),
    prisma.ride.count({ where: { serviceDate: date, status: 'REQUESTED', runId: null } }),
    prisma.rideRun.count({ where: { status: 'ACTIVE', lateAlertedAt: { not: null } } }),
    prisma.transportIssue.count({ where: { category: { in: ['SAFETY', 'VEHICLE'] }, status: { not: 'RESOLVED' } } }),
    prisma.transportIncident.count({ where: { status: 'OPEN' } }),
    prisma.driverClientAccess.count({ where: { status: 'REQUESTED' } }),
    transportExpirations(30, now),
  ]);
  const all: NeedsYouItem[] = [
    { key: 'sos', label: 'SOS from a van', count: sos, path: '/transport?tab=live', tone: 'alert' },
    { key: 'no-answer', label: 'Driver not answering', count: escalated, path: '/transport?tab=live', tone: 'alert' },
    { key: 'needs-van', label: 'Seats today without a van', count: needsVan, path: '/transport', tone: 'warning' },
    { key: 'late', label: 'Vans running late', count: late, path: '/transport?tab=live', tone: 'warning' },
    { key: 'incidents', label: 'Incidents to review', count: incidents, path: '/transport?tab=issues', tone: 'warning' },
    { key: 'safety-issues', label: 'Safety and vehicle issues', count: safetyIssues, path: '/transport?tab=issues', tone: 'warning' },
    { key: 'expiring', label: 'Van papers and driver credentials lapsing', count: expiring.length, path: '/transport?tab=vans', tone: 'info' },
    { key: 'access', label: 'Driver access requests', count: access, path: '/transport?tab=vans', tone: 'info' },
  ];
  const items = all.filter((i) => i.count > 0);
  return { total: items.reduce((t, i) => t + i.count, 0), items };
}

transportOpsRouter.get('/needs-you', VIEW, async (_req, res) => {
  res.json(await transportNeedsYou());
});

/** Van papers and driver credentials for the expirations desk. */
transportOpsRouter.get('/expiring', VIEW, async (req, res) => {
  const days = z.coerce.number().int().min(1).max(365).default(60).parse(req.query.days ?? 60);
  res.json({ items: await transportExpirations(days) });
});

/* ===== Cost per seat, per client =========================================== */

/**
 * What a seat costs against what it earns, by client: the fares and fees
 * charged on the client's riders' rides; the van side (fuel and
 * maintenance from the service logs, spread over the period's runs by
 * run) and the driver side (run hours × the driver's hourly rate — the
 * run's clock, since drivers are paid through the time clock). A client's
 * share of a van's day is the share of that run's seats it filled.
 */
transportOpsRouter.get('/costs', VIEW, async (req, res) => {
  const q = z.object({ from: dateOnly, to: dateOnly }).parse(req.query);
  const [runs, service, settings] = await Promise.all([
    prisma.rideRun.findMany({
      where: { serviceDate: { gte: q.from, lte: q.to }, status: 'COMPLETED' },
      select: {
        id: true,
        vanId: true,
        driverUserId: true,
        startedAt: true,
        endedAt: true,
        departAt: true,
        rides: { where: { status: { in: ['COMPLETED', 'NO_SHOW'] } }, select: { status: true, chargeCents: true, waivedAt: true, location: { select: { clientId: true, client: { select: { name: true } } } } } },
      },
    }),
    prisma.vanServiceEntry.findMany({ where: { occurredAt: { gte: toDate(q.from)!, lte: toDate(q.to)! }, kind: { in: ['FUEL', 'OIL_CHANGE', 'TIRES', 'BRAKES', 'REPAIR', 'INSPECTION', 'CLEANING', 'OTHER'] } }, select: { vanId: true, kind: true, costCents: true } }),
    hosSettings(),
  ]);
  void settings;
  // Driver rates, in one read (lib/transportCosts — the same reckoning as /trends and the ops board).
  const rateOf = await driverHourlyRates(runs.map((r) => r.driverUserId));
  const vanCost = new Map<string, { fuel: number; maintenance: number }>();
  for (const s of service) {
    const v = vanCost.get(s.vanId) ?? { fuel: 0, maintenance: 0 };
    if (s.kind === 'FUEL') v.fuel += s.costCents;
    else v.maintenance += s.costCents;
    vanCost.set(s.vanId, v);
  }
  const runsPerVan = new Map<string, number>();
  for (const r of runs) runsPerVan.set(r.vanId, (runsPerVan.get(r.vanId) ?? 0) + 1);

  type Row = { clientId: string | null; client: string; runs: number; seats: number; noShows: number; faresCents: number; driverCents: number; fuelCents: number; maintenanceCents: number };
  const rows = new Map<string, Row>();
  const row = (clientId: string | null, name: string) => {
    const k = clientId ?? 'none';
    const r = rows.get(k) ?? { clientId, client: name, runs: 0, seats: 0, noShows: 0, faresCents: 0, driverCents: 0, fuelCents: 0, maintenanceCents: 0 };
    rows.set(k, r);
    return r;
  };
  for (const r of runs) {
    const driverCents = runDriverCents(r, rateOf);
    const perRun = vanCost.get(r.vanId);
    const share = runsPerVan.get(r.vanId) ?? 1;
    const fuelCents = perRun ? Math.round(perRun.fuel / share) : 0;
    const maintenanceCents = perRun ? Math.round(perRun.maintenance / share) : 0;
    const seatsOnRun = r.rides.filter((x) => x.status === 'COMPLETED').length || 1;
    const byClient = new Map<string, { clientId: string | null; name: string; seats: number; noShows: number; fares: number }>();
    for (const ride of r.rides) {
      const k = ride.location.clientId ?? 'none';
      const c = byClient.get(k) ?? { clientId: ride.location.clientId, name: ride.location.client?.name ?? 'Direct', seats: 0, noShows: 0, fares: 0 };
      if (ride.status === 'COMPLETED') c.seats += 1;
      else c.noShows += 1;
      if (!ride.waivedAt) c.fares += ride.chargeCents;
      byClient.set(k, c);
    }
    for (const c of byClient.values()) {
      const portion = c.seats / seatsOnRun;
      const out = row(c.clientId, c.name);
      out.runs += portion;
      out.seats += c.seats;
      out.noShows += c.noShows;
      out.faresCents += c.fares;
      out.driverCents += Math.round(driverCents * portion);
      out.fuelCents += Math.round(fuelCents * portion);
      out.maintenanceCents += Math.round(maintenanceCents * portion);
    }
  }
  const finish = (r: Row) => {
    const costCents = r.driverCents + r.fuelCents + r.maintenanceCents;
    return { ...r, runs: Math.round(r.runs * 10) / 10, costCents, netCents: r.faresCents - costCents, costPerSeatCents: r.seats > 0 ? Math.round(costCents / r.seats) : null, farePerSeatCents: r.seats > 0 ? Math.round(r.faresCents / r.seats) : null };
  };
  const list = [...rows.values()].map(finish).sort((a, b) => b.seats - a.seats);
  const totals = finish(list.reduce<Row>((t, r) => ({ ...t, runs: t.runs + r.runs, seats: t.seats + r.seats, noShows: t.noShows + r.noShows, faresCents: t.faresCents + r.faresCents, driverCents: t.driverCents + r.driverCents, fuelCents: t.fuelCents + r.fuelCents, maintenanceCents: t.maintenanceCents + r.maintenanceCents }), { clientId: null, client: 'All', runs: 0, seats: 0, noShows: 0, faresCents: 0, driverCents: 0, fuelCents: 0, maintenanceCents: 0 }));
  res.json({ from: q.from, to: q.to, rows: list, totals, note: 'Driver cost is run hours at each driver’s hourly rate; fuel and maintenance are the period’s service-log entries spread over the van’s runs.' });
});

/* ===== Eight weeks, week by week =========================================== */

/**
 * The Saturday that starts the org week a YYYY-MM-DD falls in (service
 * dates are store-local days). Alto's week runs Saturday to Friday — the
 * week payroll, overtime and the schedule use (lib/timeAnomalies
 * startOfWeekInZone; web lib/workweek) — so the vans' weeks line up with
 * everyone else's (F500 G2: these said "Monday to Sunday").
 */
export function orgWeekStartOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  // Sat → 0 days back, Sun → 1, … Fri → 6.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: date arithmetic on a day key's UTC anchor
  return d.toISOString().slice(0, 10);
}
const addDaysYmd = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: date arithmetic on a day key's UTC anchor
  return d.toISOString().slice(0, 10);
};

/** A pickup counts as on time when the van got there (or the rider boarded) within five minutes of the planned time. */
const ON_TIME_GRACE_MS = 5 * 60_000;

/**
 * The director's trend lines: riders carried, on-time pickups, no-shows,
 * and what the vans earned against what they cost — Saturday to Friday, the
 * last `weeks` weeks with this one (still running) last. Cost is the same
 * reckoning as /costs: run hours at each driver's rate, plus the week's
 * fuel and upkeep from the service log.
 */
transportOpsRouter.get('/trends', VIEW, async (req, res) => {
  const weeks = z.coerce.number().int().min(2).max(26).default(8).parse(req.query.weeks ?? 8);
  const today = dateKeyInZone(new Date(), companyZone());
  const thisWeek = orgWeekStartOf(today);
  const starts = Array.from({ length: weeks }, (_, i) => addDaysYmd(thisWeek, (i - weeks + 1) * 7));
  const from = starts[0]!;
  const to = addDaysYmd(thisWeek, 6);
  const [rides, runs, service, lastRide] = await Promise.all([
    prisma.ride.findMany({
      where: { tenantId: tenantIdForWrite(), serviceDate: { gte: from, lte: to }, status: { in: ['BOARDED', 'COMPLETED', 'NO_SHOW'] } },
      select: { serviceDate: true, status: true, chargeCents: true, waivedAt: true, pickupAt: true, vanArrivedAt: true, boardedAt: true, run: { select: { status: true } } },
    }),
    prisma.rideRun.findMany({
      where: { tenantId: tenantIdForWrite(), serviceDate: { gte: from, lte: to }, status: 'COMPLETED' },
      select: { serviceDate: true, driverUserId: true, startedAt: true, endedAt: true },
    }),
    prisma.vanServiceEntry.findMany({
      where: { tenantId: tenantIdForWrite(), occurredAt: { gte: toDate(from)!, lt: toDate(addDaysYmd(to, 1))! } },
      select: { occurredAt: true, costCents: true },
    }),
    // The last day anyone rode, at any distance back: a quiet week says when
    // the vans last carried someone ("No rides last week — last ride Sep 14").
    prisma.ride.findFirst({
      where: { tenantId: tenantIdForWrite(), serviceDate: { lte: today }, status: { in: ['BOARDED', 'COMPLETED'] } },
      orderBy: { serviceDate: 'desc' },
      select: { serviceDate: true },
    }),
  ]);
  // Driver rates, in one read (lib/transportCosts).
  const rateOf = await driverHourlyRates(runs.map((r) => r.driverUserId));

  const buckets = new Map(starts.map((s) => [s, { riders: 0, noShows: 0, timed: 0, onTime: 0, revenueCents: 0, costCents: 0 }]));
  for (const r of rides) {
    const b = buckets.get(orgWeekStartOf(r.serviceDate));
    if (!b) continue;
    if (r.status === 'NO_SHOW') b.noShows += 1;
    else b.riders += 1;
    // Earned on the same terms as /costs: rides finished (or no-shows) on runs that ended — so
    // a run still out, or one a driver never closed, doesn't count fares against zero cost.
    if (!r.waivedAt && r.run?.status === 'COMPLETED' && (r.status === 'COMPLETED' || r.status === 'NO_SHOW')) b.revenueCents += r.chargeCents;
    const reached = r.vanArrivedAt ?? r.boardedAt;
    if (r.status !== 'NO_SHOW' && r.pickupAt && reached) {
      b.timed += 1;
      if (reached.getTime() <= r.pickupAt.getTime() + ON_TIME_GRACE_MS) b.onTime += 1;
    }
  }
  for (const run of runs) {
    const b = buckets.get(orgWeekStartOf(run.serviceDate));
    if (!b) continue;
    b.costCents += runDriverCents(run, rateOf);
  }
  for (const s of service) {
    // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: VanServiceEntry.occurredAt is a @db.Date
    const b = buckets.get(orgWeekStartOf(s.occurredAt.toISOString().slice(0, 10)));
    if (b) b.costCents += s.costCents;
  }
  res.json({
    weeks: starts.map((start) => {
      const b = buckets.get(start)!;
      return {
        start,
        partial: start === thisWeek,
        riders: b.riders,
        noShows: b.noShows,
        noShowPct: b.riders + b.noShows > 0 ? Math.round((b.noShows / (b.riders + b.noShows)) * 1000) / 10 : null,
        onTimePct: b.timed > 0 ? Math.round((b.onTime / b.timed) * 1000) / 10 : null,
        revenueCents: b.revenueCents,
        costCents: b.costCents,
      };
    }),
    weekStartsOn: 'SATURDAY',
    lastRideDate: lastRide?.serviceDate ?? null,
    note: 'On time: the van arrived (or the rider boarded) within 5 minutes of the planned pickup. Revenue is fares and no-show fees charged on runs that ended, less waivers — the same terms as Costs. Cost is run hours at each driver’s rate plus fuel and upkeep from the service log.',
  });
});

/* ===== Live operations and tomorrow's readiness (transport upgrade 2026-10-28) ===== */

/**
 * The dispatcher's live operations: every van and what it is doing, the
 * exceptions worst first, the four KPIs, where the map opens
 * (lib/transportOpsBoard; TransportOpsBoard in packages/shared transportOps).
 */
transportOpsRouter.get('/ops', VIEW, async (req, res) => {
  const { date } = z.object({ date: dateOnly.optional() }).parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await computeOpsBoard(date ?? dateKeyInZone(new Date(), companyZone())));
});

/** Is the day ready? Six checks, tomorrow unless ?date= says otherwise (lib/transportReadiness). */
transportOpsRouter.get('/readiness', VIEW, async (req, res) => {
  const { date } = z.object({ date: dateOnly.optional() }).parse(req.query);
  res.json(await computeReadiness(date ?? tomorrowKey()));
});
