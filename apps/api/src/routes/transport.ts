import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyAssociate, notifyUser, trackNotificationWork } from '../lib/notify.js';
import { emitLiveEvent } from '../lib/liveEvents.js';
import { DEFAULT_TIMEZONE } from '../lib/timezone.js';
import { dateKeyInZone } from '../lib/timeAnomalies.js';
import { nextPaydayFor } from '../lib/associatePayday.js';
import { geocode, reverseGeocode } from '../lib/geocode.js';
import { orderAndTime, planDay, planRideSelect } from '../lib/transportPlan.js';
import {
  MIN_PING_GAP_MS,
  afterPing,
  computeRunLive,
  liveRunInclude,
  type LiveRunRow,
  type RunLive,
} from '../lib/transportLive.js';
import {
  NO_SHOW_WAIT_MS,
  OPEN_RIDE_STATUSES,
  bookableStores,
  getTransportSettings,
  owedCents,
  rideSelect,
  serviceDateFor,
  toRideView,
} from '../lib/transport.js';

/**
 * Transportation — the Alto vans (lib/transport for the model).
 *
 *   /transport/me…        the associate's Ride tab: book, cancel, their
 *                         rides and charges, saved addresses, report a problem
 *   /transport/driver…    the driver's runs: start, on board / no-show,
 *                         complete
 *   /transport/board…     the Transportation Director's command center:
 *                         the day's rides and runs, dispatch, cancellations,
 *                         vans, drivers, stops, issues, charges, fares
 *   /transport/arrivals   the store supervisors' heads-up — who's arriving
 *                         by van (with or without a shift). Heads-up only.
 */
export const transportRouter = Router();

const RIDE = requireCapability('ride:transport');
const DRIVE = requireCapability('drive:transport');
const VIEW = requireCapability('view:transport');
const MANAGE = requireCapability('manage:transport');

const MAX_DAYS_AHEAD = 30;
const DUPLICATE_WINDOW_MS = 3 * 3_600_000;

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null }): string {
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
}

function fmtWhen(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function fmtTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function requireAssociate(req: Request): string {
  const id = req.user!.associateId;
  if (!id) throw new HttpError(403, 'no_associate', 'Your login is not linked to an associate record yet.');
  return id;
}

/** The people who run transportation — they hear about issues. */
async function notifyTransportDesk(opts: { subject: string; body: string; linkUrl: string }) {
  const desk = await prisma.user.findMany({
    where: { role: 'TRANSPORTATION_DIRECTOR', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  await Promise.all(desk.map((u) => notifyUser(u.id, { ...opts, category: 'transport' })));
}

/* ===== The associate's Ride tab ========================================= */

transportRouter.get('/me', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const now = new Date();
  const [settings, consent, places, stops, stores, rides, shifts, payday] = await Promise.all([
    getTransportSettings(),
    prisma.rideConsent.findUnique({ where: { associateId } }),
    prisma.ridePlace.findMany({ where: { associateId }, orderBy: { createdAt: 'asc' } }),
    prisma.transportStop.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    bookableStores(associateId, req.user!.clientId ?? null),
    prisma.ride.findMany({
      where: {
        associateId,
        OR: [
          { targetAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
          { status: { in: [...OPEN_RIDE_STATUSES] } },
        ],
      },
      orderBy: { targetAt: 'desc' },
      take: 80,
      select: rideSelect,
    }),
    // Shortcuts only — booking never needs a shift.
    prisma.shift.findMany({
      where: {
        assignedAssociateId: associateId,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED'] },
        startsAt: { gt: now, lt: new Date(now.getTime() + 14 * 86_400_000) },
        locationId: { not: null },
      },
      orderBy: { startsAt: 'asc' },
      take: 14,
      select: { id: true, startsAt: true, endsAt: true, position: true, locationId: true },
    }),
    nextPaydayFor(associateId),
  ]);
  const owed = await prisma.ride.findMany({
    where: { associateId, chargeCents: { gt: 0 }, waivedAt: null, chargedRunId: null },
    select: { chargeCents: true, status: true },
  });
  // One-tap booking goes from where they went last time: that pickup (a
  // stop, a saved address, or the address itself) and that store.
  const last = await prisma.ride.findFirst({
    where: { associateId },
    orderBy: { createdAt: 'desc' },
    select: { locationId: true, stopId: true, address: true, lat: true, lng: true },
  });
  const liveStop = last?.stopId ? stops.find((x) => x.id === last.stopId) : undefined;
  const lastPlace = last?.address ? places.find((p) => p.address === last.address) : undefined;
  const defaultPickup = liveStop
    ? { kind: 'stop' as const, stopId: liveStop.id, label: liveStop.name }
    : lastPlace
      ? { kind: 'place' as const, placeId: lastPlace.id, label: lastPlace.label }
      : last?.address
        ? {
            kind: 'address' as const,
            address: last.address,
            lat: last.lat === null ? null : Number(last.lat),
            lng: last.lng === null ? null : Number(last.lng),
            label: last.address,
          }
        : places[0]
          ? { kind: 'place' as const, placeId: places[0].id, label: places[0].label }
          : null;
  const defaultStoreId =
    last && stores.some((x) => x.id === last.locationId) ? last.locationId : (stores[0]?.id ?? null);
  res.json({
    settings,
    consent: consent ? { acceptedAt: consent.acceptedAt.toISOString() } : null,
    places: places.map((p) => ({ id: p.id, label: p.label, address: p.address })),
    stops: stops.map((s) => ({ id: s.id, name: s.name, address: s.address })),
    stores: stores.map((s) => ({
      id: s.id,
      name: s.name,
      timezone: s.timezone,
      clientName: s.client.name,
      address: [s.addressLine1, s.city, s.state].filter(Boolean).join(', ') || null,
    })),
    shifts: shifts.map((s) => ({
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      position: s.position,
      locationId: s.locationId,
    })),
    rides: rides.map(toRideView),
    defaultPickup,
    defaultStoreId,
    charges: {
      pendingCents: owed.reduce((n, r) => n + r.chargeCents, 0),
      rides: owed.filter((r) => r.status !== 'NO_SHOW').length,
      noShows: owed.filter((r) => r.status === 'NO_SHOW').length,
      nextPayday: payday,
    },
  });
});

transportRouter.post('/me/consent', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const s = await getTransportSettings();
  await prisma.rideConsent.upsert({
    where: { associateId },
    create: { associateId, fareCents: s.fareCents, noShowFeeCents: s.noShowFeeCents, ip: req.ip ?? null },
    update: { fareCents: s.fareCents, noShowFeeCents: s.noShowFeeCents, acceptedAt: new Date(), ip: req.ip ?? null },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'transport.consent_given',
      entityType: 'Associate',
      entityId: associateId,
      metadata: { fareCents: s.fareCents, noShowFeeCents: s.noShowFeeCents },
    },
    'transport',
  );
  res.status(201).json({ ok: true });
});

const LatLng = {
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
};

const PlaceInput = z.object({
  label: z.string().trim().min(1).max(40),
  address: z.string().trim().min(5).max(300),
  // "Use where I am now" — the phone's own coordinates beat a lookup.
  ...LatLng,
});

/** The point for an address: the one the phone gave, else looked up. */
async function pointFor(address: string, lat?: number, lng?: number) {
  return lat !== undefined && lng !== undefined ? { lat, lng } : await geocode(address);
}

transportRouter.post('/me/places', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const input = PlaceInput.parse(req.body);
  const at = await pointFor(input.address, input.lat, input.lng);
  const place = await prisma.ridePlace.create({
    data: { associateId, label: input.label, address: input.address, lat: at?.lat ?? null, lng: at?.lng ?? null },
  });
  res.status(201).json({ place: { id: place.id, label: place.label, address: place.address } });
});

/** "Use where I am now": the street address of the phone's position. */
transportRouter.get('/me/where', RIDE, async (req, res) => {
  const q = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }).parse(req.query);
  res.json({ address: await reverseGeocode({ lat: q.lat, lng: q.lng }) });
});

transportRouter.delete('/me/places/:id', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const n = await prisma.ridePlace.deleteMany({ where: { id: z.string().uuid().parse(req.params.id), associateId } });
  if (n.count === 0) throw new HttpError(404, 'not_found', 'Address not found.');
  res.status(204).end();
});

const BookInput = z
  .object({
    direction: z.enum(['TO_WORK', 'FROM_WORK']),
    locationId: z.string().uuid(),
    stopId: z.string().uuid().optional(),
    placeId: z.string().uuid().optional(),
    address: z.string().trim().min(5).max(300).optional(),
    ...LatLng,
    targetAt: z.string().datetime(),
    note: z.string().trim().max(300).optional(),
    shiftId: z.string().uuid().optional(),
  })
  .refine((v) => [v.stopId, v.placeId, v.address].filter(Boolean).length === 1, {
    message: 'Pick one pickup: a stop, a saved address, or an address.',
  });

transportRouter.post('/me/rides', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const input = BookInput.parse(req.body);
  const settings = await getTransportSettings();
  if (!(await prisma.rideConsent.findUnique({ where: { associateId } }))) {
    throw new HttpError(409, 'consent_required', 'Agree to the ride charges before your first booking.');
  }
  const store = (await bookableStores(associateId, req.user!.clientId ?? null)).find((s) => s.id === input.locationId);
  if (!store) throw new HttpError(403, 'store_not_allowed', 'You can book rides to your own stores only.');
  const targetAt = new Date(input.targetAt);
  const now = Date.now();
  if (targetAt.getTime() - now < settings.cutoffHours * 3_600_000) {
    throw new HttpError(
      400,
      'too_late',
      `Book at least ${settings.cutoffHours} hours ahead — the vans are planned ahead of time.`,
    );
  }
  if (targetAt.getTime() - now > MAX_DAYS_AHEAD * 86_400_000) {
    throw new HttpError(400, 'too_far', `You can book up to ${MAX_DAYS_AHEAD} days ahead.`);
  }
  // The home end: a housing complex / stop, a saved address, or a one-off.
  let stopId: string | null = null;
  let address: string | null = null;
  let at: { lat: number; lng: number } | null = null;
  if (input.stopId) {
    const stop = await prisma.transportStop.findFirst({ where: { id: input.stopId, isActive: true } });
    if (!stop) throw new HttpError(400, 'stop_not_found', 'That pickup stop is not available.');
    stopId = stop.id;
  } else if (input.placeId) {
    const place = await prisma.ridePlace.findFirst({ where: { id: input.placeId, associateId } });
    if (!place) throw new HttpError(400, 'place_not_found', 'That saved address is gone.');
    address = place.address;
    at = place.lat !== null && place.lng !== null ? { lat: Number(place.lat), lng: Number(place.lng) } : await geocode(place.address);
  } else {
    address = input.address!;
    at = await pointFor(address, input.lat, input.lng);
  }
  const clash = await prisma.ride.findFirst({
    where: {
      associateId,
      direction: input.direction,
      status: { in: [...OPEN_RIDE_STATUSES] },
      targetAt: {
        gt: new Date(targetAt.getTime() - DUPLICATE_WINDOW_MS),
        lt: new Date(targetAt.getTime() + DUPLICATE_WINDOW_MS),
      },
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(409, 'duplicate', 'You already have a ride booked around then.');

  const ride = await prisma.ride.create({
    data: {
      associateId,
      direction: input.direction,
      locationId: store.id,
      stopId,
      address,
      lat: at?.lat ?? null,
      lng: at?.lng ?? null,
      targetAt,
      serviceDate: serviceDateFor(targetAt, store.timezone),
      shiftId: input.shiftId ?? null,
      note: input.note || null,
      fareCents: settings.fareCents,
      noShowFeeCents: settings.noShowFeeCents,
      createdById: req.user!.id,
    },
    select: rideSelect,
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId: ride.location.client.id,
      action: 'transport.ride_booked',
      entityType: 'Ride',
      entityId: ride.id,
      metadata: { direction: ride.direction, locationId: ride.location.id, targetAt: ride.targetAt.toISOString() },
    },
    'transport',
  );
  res.status(201).json({ ride: toRideView(ride) });
});

transportRouter.post('/me/rides/:id/cancel', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const id = z.string().uuid().parse(req.params.id);
  const ride = await prisma.ride.findFirst({ where: { id, associateId }, select: rideSelect });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  if (!(OPEN_RIDE_STATUSES as readonly string[]).includes(ride.status)) {
    throw new HttpError(409, 'not_open', 'This ride can no longer be cancelled.');
  }
  if (ride.run && ride.run.status === 'ACTIVE') {
    throw new HttpError(409, 'van_departed', 'The van is already on its way — it can’t be cancelled now.');
  }
  await prisma.ride.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: req.user!.id, cancelReason: 'Cancelled by the rider' },
  });
  if (ride.run) {
    const tz = ride.location.timezone;
    void trackNotificationWork(
      notifyUser(ride.run.driver.id, {
        subject: `${ride.associate.firstName} cancelled — skip the pickup`,
        body: `${ride.associate.firstName} ${ride.associate.lastName} won't be riding ${ride.run.van.name} at ${
          ride.pickupAt ? fmtTime(ride.pickupAt, tz) : fmtTime(ride.targetAt, tz)
        }.`,
        category: 'transport',
        linkUrl: '/',
      }),
    );
  }
  res.json({ ok: true });
});

/**
 * The rider's word to the driver while the van is coming: "I'm outside" or
 * "running a few minutes late". The driver sees it on the stop and hears it.
 */
transportRouter.post('/me/rides/:id/signal', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const id = z.string().uuid().parse(req.params.id);
  const { kind } = z.object({ kind: z.enum(['OUTSIDE', 'LATE']) }).parse(req.body);
  const ride = await prisma.ride.findFirst({ where: { id, associateId }, select: rideSelect });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  const soon = ride.run && ride.run.status === 'PLANNED' && ride.run.departAt.getTime() - Date.now() < 2 * 3_600_000;
  if (ride.status !== 'SCHEDULED' || !ride.run || !(ride.run.status === 'ACTIVE' || soon)) {
    throw new HttpError(409, 'not_on_the_way', 'You can message the driver once your van is on its way.');
  }
  await prisma.ride.update({ where: { id }, data: { riderSignal: kind, riderSignalAt: new Date() } });
  const first = ride.associate.firstName;
  void trackNotificationWork(
    notifyUser(ride.run.driver.id, {
      subject: kind === 'OUTSIDE' ? `${first} is outside` : `${first} is running a few minutes late`,
      body:
        kind === 'OUTSIDE'
          ? `${first} ${ride.associate.lastName} is waiting at ${ride.stop ? ride.stop.name : (ride.address ?? 'the pickup')}.`
          : `${first} ${ride.associate.lastName} asked you to hold on a few minutes at ${ride.stop ? ride.stop.name : (ride.address ?? 'the pickup')}.`,
      category: 'transport',
      linkUrl: '/',
    }),
  );
  emitLiveEvent(ride.run.driver.id, 'transport');
  res.json({ ok: true });
});

const IssueInput = z.object({
  category: z.enum(['LATE_VAN', 'MISSED_PICKUP', 'CHARGE_DISPUTE', 'SAFETY', 'VEHICLE', 'CONDUCT', 'OTHER']),
  body: z.string().trim().min(5).max(2000),
  rideId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});

/** Riders and drivers report a problem — the director's queue. */
transportRouter.post('/issues', requireAuth, async (req, res) => {
  const role = req.user!.role;
  if (!hasCapability(role, 'ride:transport') && !hasCapability(role, 'drive:transport')) {
    throw new HttpError(403, 'forbidden', 'Not allowed.');
  }
  const input = IssueInput.parse(req.body);
  if (input.rideId) {
    const ride = await prisma.ride.findUnique({ where: { id: input.rideId }, select: { associateId: true, run: { select: { driverUserId: true } } } });
    const mine = ride && (ride.associateId === req.user!.associateId || ride.run?.driverUserId === req.user!.id);
    if (!mine && !hasCapability(role, 'manage:transport')) throw new HttpError(404, 'not_found', 'Ride not found.');
  }
  const issue = await prisma.transportIssue.create({
    data: { reportedById: req.user!.id, category: input.category, body: input.body, rideId: input.rideId ?? null, runId: input.runId ?? null },
  });
  const who = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { email: true, associate: { select: { firstName: true, lastName: true } } },
  });
  void trackNotificationWork(
    notifyTransportDesk({
      subject: `Transport issue — ${input.category.replace(/_/g, ' ').toLowerCase()}`,
      body: `${who ? personName(who) : 'Someone'}: ${input.body}`,
      linkUrl: '/transport?tab=issues',
    }),
  );
  res.status(201).json({ id: issue.id });
});

/* ===== The driver ======================================================== */

const runInclude = {
  van: { select: { id: true, name: true, plate: true, capacity: true } },
  driver: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  rides: { orderBy: [{ pickupOrder: 'asc' }, { targetAt: 'asc' }], select: rideSelect },
} satisfies Prisma.RideRunInclude;

type RunRow = Prisma.RideRunGetPayload<{ include: typeof runInclude }>;

function toRunView(r: RunRow) {
  const live = r.rides.filter((x) => x.status !== 'CANCELLED');
  return {
    id: r.id,
    direction: r.direction,
    serviceDate: r.serviceDate,
    departAt: r.departAt.toISOString(),
    status: r.status,
    startedAt: r.startedAt?.toISOString() ?? null,
    endedAt: r.endedAt?.toISOString() ?? null,
    notes: r.notes,
    van: r.van,
    driver: { userId: r.driver.id, name: personName(r.driver) },
    seats: { taken: live.length, capacity: r.van.capacity },
    rides: r.rides.map(toRideView),
  };
}

async function ownRun(req: Request, runId: string) {
  const run = await prisma.rideRun.findUnique({ where: { id: runId }, include: runInclude });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  if (run.driverUserId !== req.user!.id && !hasCapability(req.user!.role, 'manage:transport')) {
    throw new HttpError(404, 'not_found', 'Run not found.');
  }
  return run;
}

transportRouter.get('/driver/runs', DRIVE, async (req, res) => {
  const today = dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  const runs = await prisma.rideRun.findMany({
    where: { driverUserId: req.user!.id, serviceDate: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
    orderBy: { departAt: 'asc' },
    include: runInclude,
  });
  res.json({ today, runs: runs.map(toRunView) });
});

async function startRun(runId: string, actorId: string) {
  const run = await prisma.rideRun.update({
    where: { id: runId },
    data: { status: 'ACTIVE', startedAt: new Date() },
    include: runInclude,
  });
  enqueueAudit({ actorUserId: actorId, action: 'transport.run_started', entityType: 'RideRun', entityId: runId }, 'transport');
  // Riders waiting at home hear the van is on its way.
  if (run.direction === 'TO_WORK') {
    for (const r of run.rides.filter((x) => x.status === 'SCHEDULED')) {
      void trackNotificationWork(
        notifyAssociate(r.associate.id, {
          subject: `${run.van.name} is on its way`,
          body: `Be ready at ${r.stop ? r.stop.name : 'your pickup'}${
            r.pickupAt ? ` around ${fmtTime(r.pickupAt, r.location.timezone)}` : ''
          }.`,
          category: 'transport',
          linkUrl: '/rides',
        }),
      );
    }
  }
  return run;
}

transportRouter.post('/driver/runs/:id/start', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status !== 'PLANNED') throw new HttpError(409, 'not_planned', 'This run has already started.');
  res.json({ run: toRunView(await startRun(run.id, req.user!.id)) });
});

transportRouter.post('/driver/runs/:id/complete', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status !== 'ACTIVE') throw new HttpError(409, 'not_active', 'Start the run first.');
  const unmarked = run.rides.filter((r) => r.status === 'SCHEDULED');
  if (unmarked.length > 0) {
    throw new HttpError(
      409,
      'unmarked_riders',
      `Mark every rider on board or no-show first (${unmarked.length} left).`,
    );
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.ride.updateMany({ where: { runId: run.id, status: 'BOARDED' }, data: { status: 'COMPLETED', completedAt: now } }),
    prisma.rideRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', endedAt: now } }),
  ]);
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.run_completed', entityType: 'RideRun', entityId: run.id }, 'transport');
  res.json({ run: toRunView((await prisma.rideRun.findUnique({ where: { id: run.id }, include: runInclude }))!) });
});

async function driverRide(req: Request) {
  const id = z.string().uuid().parse(req.params.id);
  const ride = await prisma.ride.findUnique({ where: { id }, select: { ...rideSelect, runId: true } });
  if (!ride || !ride.runId) throw new HttpError(404, 'not_found', 'Ride not found.');
  const run = await ownRun(req, ride.runId);
  if (run.status === 'COMPLETED' || run.status === 'CANCELLED') {
    throw new HttpError(409, 'run_closed', 'This run is closed.');
  }
  // Marking the first rider starts the run.
  if (run.status === 'PLANNED') await startRun(run.id, req.user!.id);
  return ride;
}

transportRouter.post('/driver/rides/:id/board', DRIVE, async (req, res) => {
  const ride = await driverRide(req);
  if (ride.status !== 'SCHEDULED') throw new HttpError(409, 'not_scheduled', 'This rider is already marked.');
  const updated = await prisma.ride.update({
    where: { id: ride.id },
    data: { status: 'BOARDED', boardedAt: new Date(), chargeCents: ride.fareCents },
    select: rideSelect,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.boarded', entityType: 'Ride', entityId: ride.id }, 'transport');
  res.json({ ride: toRideView(updated) });
});

/**
 * "Arrived" at a pickup: every rider still waiting there hears "your van is
 * here", and the 3-minute clock before a no-show starts.
 */
transportRouter.post('/driver/runs/:id/arrived', DRIVE, async (req, res) => {
  const { rideIds } = z.object({ rideIds: z.array(z.string().uuid()).min(1).max(60) }).parse(req.body);
  let run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status === 'COMPLETED' || run.status === 'CANCELLED') throw new HttpError(409, 'run_closed', 'This run is closed.');
  if (run.status === 'PLANNED') run = await startRun(run.id, req.user!.id);
  const here = run.rides.filter((r) => rideIds.includes(r.id) && r.status === 'SCHEDULED' && !r.vanArrivedAt);
  const now = new Date();
  if (here.length > 0) {
    await prisma.ride.updateMany({ where: { id: { in: here.map((r) => r.id) } }, data: { vanArrivedAt: now } });
    for (const r of here) {
      const where = run.direction === 'TO_WORK' ? (r.stop ? r.stop.name : 'your pickup') : r.location.name;
      void trackNotificationWork(
        notifyAssociate(r.associate.id, {
          subject: `Your van is here`,
          body:
            `${run.van.name}${run.van.plate ? ` (${run.van.plate})` : ''} is at ${where}. ` +
            `${personName(run.driver).split(' ')[0]} will wait ${Math.round(NO_SHOW_WAIT_MS / 60_000)} minutes.`,
          category: 'transport',
          linkUrl: '/rides',
        }),
      );
    }
    const riders = await prisma.user.findMany({
      where: { associateId: { in: here.map((r) => r.associate.id) }, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    for (const u of riders) emitLiveEvent(u.id, 'transport');
  }
  res.json({ run: toRunView((await prisma.rideRun.findUnique({ where: { id: run.id }, include: runInclude }))!) });
});

transportRouter.post('/driver/rides/:id/no-show', DRIVE, async (req, res) => {
  const ride = await driverRide(req);
  if (ride.status !== 'SCHEDULED') throw new HttpError(409, 'not_scheduled', 'This rider is already marked.');
  // Fair to the rider: the van stopped, they heard it, and they had 3
  // minutes to come out.
  if (!ride.vanArrivedAt) {
    throw new HttpError(409, 'not_arrived', 'Tap Arrived at the stop first — riders get 3 minutes to come out.');
  }
  const waitUntil = ride.vanArrivedAt.getTime() + NO_SHOW_WAIT_MS;
  if (Date.now() < waitUntil) {
    throw new HttpError(
      409,
      'still_waiting',
      `Give them until ${fmtTime(new Date(waitUntil), ride.location.timezone)} — riders get 3 minutes after you arrive.`,
    );
  }
  const updated = await prisma.ride.update({
    where: { id: ride.id },
    data: { status: 'NO_SHOW', noShowAt: new Date(), chargeCents: ride.noShowFeeCents },
    select: rideSelect,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.no_show', entityType: 'Ride', entityId: ride.id }, 'transport');
  void trackNotificationWork(
    notifyAssociate(ride.associate.id, {
      subject: 'Missed your van',
      body:
        `The driver marked you a no-show for ${ride.run?.van.name ?? 'your van'} (${fmtWhen(ride.pickupAt ?? ride.targetAt, ride.location.timezone)}). ` +
        `A ${money(ride.noShowFeeCents)} no-show fee comes out of your next paycheck. Think it's wrong? Report it in the Ride tab.`,
      category: 'transport',
      linkUrl: '/rides',
    }),
  );
  res.json({ ride: toRideView(updated) });
});

/** Undo a mark (a mis-tap) — while the run is still going, and only if
 *  payroll hasn't taken the charge. */
transportRouter.post('/driver/rides/:id/undo', DRIVE, async (req, res) => {
  const ride = await driverRide(req);
  if (ride.status !== 'BOARDED' && ride.status !== 'NO_SHOW') {
    throw new HttpError(409, 'not_marked', 'Nothing to undo.');
  }
  if (ride.chargedRunId) throw new HttpError(409, 'already_charged', 'Payroll has already taken this charge.');
  const updated = await prisma.ride.update({
    where: { id: ride.id },
    data: { status: 'SCHEDULED', boardedAt: null, noShowAt: null, chargeCents: 0 },
    select: rideSelect,
  });
  res.json({ ride: toRideView(updated) });
});

/* ===== The vans live (phase 2) ========================================= */

const PingInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullable().optional(),
  speed: z.number().min(0).max(90).nullable().optional(),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
});

/** The driver's phone: where the van is, every few seconds while on the road. */
transportRouter.post('/driver/runs/:id/location', DRIVE, async (req, res) => {
  const run = await ownRun(req, z.string().uuid().parse(req.params.id));
  if (run.status !== 'ACTIVE') {
    throw new HttpError(409, 'not_active', 'Start the run to share where the van is.');
  }
  const input = PingInput.parse(req.body);
  const now = new Date();
  if (run.lastLocationAt && now.getTime() - run.lastLocationAt.getTime() < MIN_PING_GAP_MS) {
    res.status(202).json({ ok: true, skipped: true });
    return;
  }
  const fields = {
    heading: input.heading === null || input.heading === undefined ? null : Math.round(input.heading),
    speedMps: input.speed ?? null,
    accuracyM: input.accuracy === null || input.accuracy === undefined ? null : Math.round(input.accuracy),
  };
  await prisma.$transaction([
    prisma.rideRun.update({
      where: { id: run.id },
      data: {
        lastLat: input.lat,
        lastLng: input.lng,
        lastHeading: fields.heading,
        lastSpeedMps: fields.speedMps,
        lastAccuracyM: fields.accuracyM,
        lastLocationAt: now,
      },
    }),
    prisma.rideRunPing.create({ data: { runId: run.id, lat: input.lat, lng: input.lng, ...fields, at: now } }),
  ]);
  await afterPing(run.id, now);
  res.status(202).json({ ok: true });
});

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** The whole run on the map — the desk's and the driver's view (they see
 *  every rider's pickup; a rider never does). */
async function runMapView(run: LiveRunRow, live: RunLive) {
  const riderName = (id: string) => {
    const r = run.rides.find((x) => x.id === id);
    return r ? `${r.associate.firstName} ${r.associate.lastName}` : '';
  };
  const trail =
    run.status === 'ACTIVE'
      ? (
          await prisma.rideRunPing.findMany({
            where: { runId: run.id },
            orderBy: { at: 'desc' },
            take: 120,
            select: { lat: true, lng: true },
          })
        )
          .reverse()
          .map((p) => [Number(p.lng), Number(p.lat)] as [number, number])
      : [];
  return {
    runId: run.id,
    status: run.status,
    direction: run.direction,
    serviceDate: run.serviceDate,
    departAt: run.departAt.toISOString(),
    timezone: run.rides[0]?.location.timezone ?? DEFAULT_TIMEZONE,
    van: run.van,
    driver: { userId: run.driver.id, name: personName(run.driver) },
    position: live.van,
    stale: live.stale,
    trail,
    waypoints: live.plan.waypoints.map((w) => ({
      kind: w.kind,
      point: w.point,
      etaAt: iso(w.etaAt),
      label: w.kind === 'store' ? (live.stores.get(w.locationId!)?.location.name ?? '') : w.rideIds.map(riderName).join(', '),
      rideIds: w.rideIds,
    })),
    stores: [...live.stores.values()].map((s) => ({ locationId: s.location.id, name: s.location.name, point: s.point })),
    late: [...live.plan.lateMinutes.entries()]
      .filter(([, m]) => m > 0)
      .map(([locationId, minutes]) => ({ locationId, store: live.stores.get(locationId)?.location.name ?? '', minutes })),
    riders: run.rides.map((r) => ({
      rideId: r.id,
      name: `${r.associate.firstName} ${r.associate.lastName}`,
      status: r.status,
      pickupAt: iso(r.pickupAt),
      point: live.homes.get(r.id) ?? null,
      pickupEtaAt: iso(live.plan.pickupEta.get(r.id)),
      dropEtaAt: iso(live.plan.dropEta.get(r.id)),
    })),
  };
}

/** The desk's live map: every van on the road, and the day's planned runs. */
transportRouter.get('/live', VIEW, async (req, res) => {
  const date = DateQuery.parse(req.query).date ?? dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
  const runs = await prisma.rideRun.findMany({
    where: { OR: [{ status: 'ACTIVE' }, { status: 'PLANNED', serviceDate: date }] },
    orderBy: { departAt: 'asc' },
    include: liveRunInclude,
  });
  const now = new Date();
  const views = [];
  for (const run of runs) views.push(await runMapView(run, await computeRunLive(run, now)));
  res.json({ date, generatedAt: now.toISOString(), runs: views });
});

/** The driver's own run on the map. */
transportRouter.get('/driver/runs/:id/live', DRIVE, async (req, res) => {
  const own = await ownRun(req, z.string().uuid().parse(req.params.id));
  const run = (await prisma.rideRun.findUnique({ where: { id: own.id }, include: liveRunInclude }))!;
  res.json({ run: await runMapView(run, await computeRunLive(run)) });
});

/**
 * The rider's live ride: the van (only while it's on the road), their own
 * pickup and where they're headed, the ETAs, and how many stops come first
 * — never anyone else's address. A run that hasn't left shows within 3
 * hours of departure, without a van position.
 */
transportRouter.get('/me/live', RIDE, async (req, res) => {
  const associateId = requireAssociate(req);
  const now = new Date();
  const mine = await prisma.ride.findMany({
    where: {
      associateId,
      status: { in: ['SCHEDULED', 'BOARDED'] },
      run: {
        OR: [{ status: 'ACTIVE' }, { status: 'PLANNED', departAt: { lte: new Date(now.getTime() + 3 * 3_600_000) } }],
      },
    },
    orderBy: [{ pickupAt: 'asc' }, { targetAt: 'asc' }],
    take: 1,
    select: { id: true, runId: true },
  });
  const ride = mine[0];
  if (!ride?.runId) {
    res.json({ live: null });
    return;
  }
  const run = (await prisma.rideRun.findUnique({ where: { id: ride.runId }, include: liveRunInclude }))!;
  const live = await computeRunLive(run, now);
  const r = run.rides.find((x) => x.id === ride.id)!;
  const home = live.homes.get(r.id) ?? null;
  const store = live.stores.get(r.location.id)!;
  const firstStop = live.plan.waypoints.findIndex((w) => w.rideIds.includes(r.id));
  const toWork = run.direction === 'TO_WORK';
  res.json({
    live: {
      rideId: r.id,
      direction: run.direction,
      status: r.status,
      runStatus: run.status,
      timezone: r.location.timezone,
      departAt: run.departAt.toISOString(),
      van: { name: run.van.name, plate: run.van.plate },
      driver: personName(run.driver).split(' ')[0] ?? '',
      position: live.van,
      stale: live.stale,
      pickup: {
        label: toWork ? (r.stop?.name ?? r.address ?? '') : r.location.name,
        point: toWork ? home : store.point,
        scheduledAt: iso(r.pickupAt),
        etaAt: iso(live.plan.pickupEta.get(r.id)),
      },
      destination: {
        label: toWork ? r.location.name : (r.stop?.name ?? r.address ?? ''),
        point: toWork ? store.point : home,
        dueAt: toWork ? r.targetAt.toISOString() : null,
        etaAt: iso(live.plan.dropEta.get(r.id)),
      },
      stopsBefore: firstStop > 0 ? firstStop : 0,
      lateMinutes: toWork ? (live.plan.lateMinutes.get(r.location.id) ?? 0) : 0,
      vanArrivedAt: iso(r.vanArrivedAt),
      riderSignal: r.riderSignal,
    },
  });
});

/* ===== The command center (Transportation Director) ===================== */

const DateQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

transportRouter.get('/board', VIEW, async (req, res) => {
  const date = DateQuery.parse(req.query).date ?? dateKeyInZone(new Date(), DEFAULT_TIMEZONE);
  const [rides, runs, vans, drivers, openIssues, settings] = await Promise.all([
    prisma.ride.findMany({ where: { serviceDate: date }, orderBy: { targetAt: 'asc' }, select: rideSelect }),
    prisma.rideRun.findMany({ where: { serviceDate: date }, orderBy: { departAt: 'asc' }, include: runInclude }),
    prisma.van.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.user.findMany({
      where: { role: { in: ['DRIVER', 'TRANSPORTATION_DIRECTOR'] }, status: 'ACTIVE', deletedAt: null },
      select: { id: true, email: true, role: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
    }),
    prisma.transportIssue.count({ where: { status: { not: 'RESOLVED' } } }),
    getTransportSettings(),
  ]);
  const count = (s: string) => rides.filter((r) => r.status === s).length;
  res.json({
    date,
    settings,
    kpis: {
      booked: rides.filter((r) => r.status !== 'CANCELLED').length,
      needsVan: count('REQUESTED'),
      scheduled: count('SCHEDULED'),
      onBoard: count('BOARDED'),
      completed: count('COMPLETED'),
      noShows: count('NO_SHOW'),
      cancelled: count('CANCELLED'),
      vansOut: runs.filter((r) => r.status === 'ACTIVE').length,
      runs: runs.filter((r) => r.status !== 'CANCELLED').length,
      openIssues,
    },
    rides: rides.map(toRideView),
    runs: runs.map(toRunView),
    vans: vans.map((v) => ({ id: v.id, name: v.name, plate: v.plate, capacity: v.capacity })),
    drivers: drivers
      .map((d) => ({ userId: d.id, name: personName(d), role: d.role, phone: d.associate?.phone ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

const RidesQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['REQUESTED', 'SCHEDULED', 'BOARDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']).optional(),
  q: z.string().trim().max(80).optional(),
});

transportRouter.get('/rides', VIEW, async (req, res) => {
  const q = RidesQuery.parse(req.query);
  const rides = await prisma.ride.findMany({
    where: {
      ...(q.from || q.to ? { serviceDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            associate: {
              OR: [
                { firstName: { contains: q.q, mode: 'insensitive' } },
                { lastName: { contains: q.q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    orderBy: { targetAt: 'desc' },
    take: 300,
    select: rideSelect,
  });
  res.json({ rides: rides.map(toRideView) });
});

const ReasonInput = z.object({ reason: z.string().trim().min(3).max(300) });

transportRouter.post('/rides/:id/cancel', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { reason } = ReasonInput.parse(req.body);
  const ride = await prisma.ride.findUnique({ where: { id }, select: rideSelect });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  if (!(OPEN_RIDE_STATUSES as readonly string[]).includes(ride.status)) {
    throw new HttpError(409, 'not_open', 'Only booked or scheduled rides can be cancelled.');
  }
  await prisma.ride.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: req.user!.id, cancelReason: reason },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.ride_cancelled', entityType: 'Ride', entityId: id, metadata: { reason } },
    'transport',
  );
  void trackNotificationWork(
    notifyAssociate(ride.associate.id, {
      subject: 'Your ride was cancelled',
      body: `Your ${ride.direction === 'TO_WORK' ? 'ride to' : 'ride home from'} ${ride.location.name} on ${fmtWhen(
        ride.targetAt,
        ride.location.timezone,
      )} was cancelled by transportation: ${reason}. There's no charge.`,
      category: 'transport',
      linkUrl: '/rides',
      emailFallback: true,
    }),
  );
  res.json({ ok: true });
});

transportRouter.post('/rides/:id/waive', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { reason } = ReasonInput.parse(req.body);
  const ride = await prisma.ride.findUnique({ where: { id }, select: rideSelect });
  if (!ride) throw new HttpError(404, 'not_found', 'Ride not found.');
  if (ride.chargeCents === 0 || ride.waivedAt) throw new HttpError(409, 'nothing_to_waive', 'Nothing is owed on this ride.');
  if (ride.chargedRunId) {
    throw new HttpError(409, 'already_charged', 'Payroll already took this charge — refund it as a reimbursement instead.');
  }
  await prisma.ride.update({ where: { id }, data: { waivedAt: new Date(), waivedById: req.user!.id, waiveReason: reason } });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.charge_waived', entityType: 'Ride', entityId: id, metadata: { reason, cents: ride.chargeCents } },
    'transport',
  );
  void trackNotificationWork(
    notifyAssociate(ride.associate.id, {
      subject: `${money(ride.chargeCents)} ride charge waived`,
      body: `The ${money(ride.chargeCents)} charge for your ride on ${fmtWhen(ride.targetAt, ride.location.timezone)} won't come out of your pay. ${reason}`,
      category: 'transport',
      linkUrl: '/rides',
    }),
  );
  res.json({ ok: true });
});

const RunInput = z.object({
  vanId: z.string().uuid(),
  driverUserId: z.string().uuid(),
  direction: z.enum(['TO_WORK', 'FROM_WORK']),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departAt: z.string().datetime(),
  notes: z.string().trim().max(500).optional(),
  /** In pickup order, each with its pickup time. */
  rides: z.array(z.object({ rideId: z.string().uuid(), pickupAt: z.string().datetime() })).min(1).max(60),
});

async function assertVanAndDriver(vanId: string, driverUserId: string, riders: number) {
  const [van, driver] = await Promise.all([
    prisma.van.findFirst({ where: { id: vanId, isActive: true } }),
    prisma.user.findFirst({
      where: { id: driverUserId, role: { in: ['DRIVER', 'TRANSPORTATION_DIRECTOR'] }, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    }),
  ]);
  if (!van) throw new HttpError(400, 'van_not_found', 'Pick an active van.');
  if (!driver) throw new HttpError(400, 'driver_not_found', 'Pick an active driver.');
  if (riders > van.capacity) {
    throw new HttpError(400, 'over_capacity', `${van.name} seats ${van.capacity} — this run has ${riders} riders.`);
  }
  return van;
}

async function tellRidersTheyreScheduled(runId: string, rideIds: string[]) {
  const run = await prisma.rideRun.findUnique({ where: { id: runId }, include: runInclude });
  if (!run) return;
  for (const r of run.rides.filter((x) => rideIds.includes(x.id))) {
    const tz = r.location.timezone;
    const where = r.direction === 'TO_WORK' ? (r.stop ? r.stop.name : r.address ?? 'your address') : r.location.name;
    void trackNotificationWork(
      notifyAssociate(r.associate.id, {
        subject: `Your van: ${run.van.name}, pickup ${r.pickupAt ? fmtTime(r.pickupAt, tz) : ''}`.trim(),
        body:
          `${fmtWhen(r.pickupAt ?? r.targetAt, tz)} at ${where} — ${run.van.name}` +
          `${run.van.plate ? ` (${run.van.plate})` : ''}, driver ${personName(run.driver).split(' ')[0]}. ` +
          `${r.direction === 'TO_WORK' ? `To ${r.location.name}.` : 'Home.'} Be ready a few minutes early.`,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }
  void trackNotificationWork(
    notifyUser(run.driver.id, {
      subject: `Run: ${run.van.name} · ${fmtWhen(run.departAt, DEFAULT_TIMEZONE)}`,
      body: `${run.rides.filter((x) => x.status === 'SCHEDULED').length} riders, ${run.direction === 'TO_WORK' ? 'to work' : 'home from work'}.`,
      category: 'transport',
      linkUrl: '/',
    }),
  );
}

transportRouter.post('/runs', MANAGE, async (req, res) => {
  const input = RunInput.parse(req.body);
  await assertVanAndDriver(input.vanId, input.driverUserId, input.rides.length);
  const ids = input.rides.map((r) => r.rideId);
  const rides = await prisma.ride.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, direction: true, serviceDate: true, runId: true } });
  if (rides.length !== ids.length) throw new HttpError(400, 'ride_not_found', 'A ride on this run no longer exists.');
  for (const r of rides) {
    if (r.status !== 'REQUESTED' || r.runId) throw new HttpError(409, 'ride_taken', 'A ride on this run is already on a van or closed.');
    if (r.direction !== input.direction || r.serviceDate !== input.serviceDate) {
      throw new HttpError(400, 'ride_mismatch', 'Every ride on a run goes the same way on the same day.');
    }
  }
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.rideRun.create({
      data: {
        vanId: input.vanId,
        driverUserId: input.driverUserId,
        direction: input.direction,
        serviceDate: input.serviceDate,
        departAt: new Date(input.departAt),
        notes: input.notes || null,
        createdById: req.user!.id,
      },
    });
    for (const [i, r] of input.rides.entries()) {
      await tx.ride.update({
        where: { id: r.rideId },
        data: { runId: created.id, pickupOrder: i + 1, pickupAt: new Date(r.pickupAt), status: 'SCHEDULED' },
      });
    }
    return created;
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.run_dispatched', entityType: 'RideRun', entityId: run.id, metadata: { rides: ids.length } },
    'transport',
  );
  await tellRidersTheyreScheduled(run.id, ids);
  res.status(201).json({ run: toRunView((await prisma.rideRun.findUnique({ where: { id: run.id }, include: runInclude }))!) });
});

const RunPatch = z.object({
  vanId: z.string().uuid().optional(),
  driverUserId: z.string().uuid().optional(),
  departAt: z.string().datetime().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  rides: z.array(z.object({ rideId: z.string().uuid(), pickupAt: z.string().datetime() })).min(1).max(60).optional(),
});

transportRouter.patch('/runs/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = RunPatch.parse(req.body);
  const run = await prisma.rideRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  if (run.status !== 'PLANNED') throw new HttpError(409, 'not_planned', 'Only a run that hasn’t left can be changed.');
  const current = run.rides.filter((r) => r.status === 'SCHEDULED');
  const nextRides = input.rides ?? current.map((r) => ({ rideId: r.id, pickupAt: r.pickupAt!.toISOString() }));
  await assertVanAndDriver(input.vanId ?? run.vanId, input.driverUserId ?? run.driverUserId, nextRides.length);
  const nextIds = nextRides.map((r) => r.rideId);
  const removed = current.filter((r) => !nextIds.includes(r.id)).map((r) => r.id);
  const added = nextIds.filter((rid) => !current.some((r) => r.id === rid));
  if (added.length) {
    const fresh = await prisma.ride.findMany({ where: { id: { in: added } }, select: { status: true, direction: true, serviceDate: true, runId: true } });
    if (fresh.length !== added.length || fresh.some((r) => r.status !== 'REQUESTED' || r.runId || r.direction !== run.direction || r.serviceDate !== run.serviceDate)) {
      throw new HttpError(409, 'ride_taken', 'A ride you added is already on a van, closed, or goes another way.');
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.rideRun.update({
      where: { id },
      data: {
        ...(input.vanId ? { vanId: input.vanId } : {}),
        ...(input.driverUserId ? { driverUserId: input.driverUserId } : {}),
        ...(input.departAt ? { departAt: new Date(input.departAt) } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    if (removed.length) {
      await tx.ride.updateMany({ where: { id: { in: removed } }, data: { runId: null, pickupOrder: null, pickupAt: null, status: 'REQUESTED' } });
    }
    for (const [i, r] of nextRides.entries()) {
      await tx.ride.update({ where: { id: r.rideId }, data: { runId: id, pickupOrder: i + 1, pickupAt: new Date(r.pickupAt), status: 'SCHEDULED' } });
    }
  });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.run_changed', entityType: 'RideRun', entityId: id, metadata: { added: added.length, removed: removed.length } },
    'transport',
  );
  // Everyone on it hears the (possibly new) pickup; anyone taken off hears
  // they're waiting for a van again.
  await tellRidersTheyreScheduled(id, nextIds);
  for (const r of current.filter((x) => removed.includes(x.id))) {
    void trackNotificationWork(
      notifyAssociate(r.associate.id, {
        subject: 'Your van changed',
        body: `You're off ${run.van.name} for ${fmtWhen(r.targetAt, r.location.timezone)} — transportation will confirm a new pickup soon.`,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }
  res.json({ run: toRunView((await prisma.rideRun.findUnique({ where: { id }, include: runInclude }))!) });
});

transportRouter.post('/runs/:id/cancel', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { reason } = ReasonInput.parse(req.body);
  const run = await prisma.rideRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  if (run.status !== 'PLANNED') throw new HttpError(409, 'not_planned', 'Only a run that hasn’t left can be cancelled.');
  const riders = run.rides.filter((r) => r.status === 'SCHEDULED');
  await prisma.$transaction([
    prisma.ride.updateMany({ where: { runId: id, status: 'SCHEDULED' }, data: { runId: null, pickupOrder: null, pickupAt: null, status: 'REQUESTED' } }),
    prisma.rideRun.update({ where: { id }, data: { status: 'CANCELLED', notes: reason } }),
  ]);
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.run_cancelled', entityType: 'RideRun', entityId: id, metadata: { reason } }, 'transport');
  for (const r of riders) {
    void trackNotificationWork(
      notifyAssociate(r.associate.id, {
        subject: 'Your van changed',
        body: `${run.van.name} for ${fmtWhen(r.targetAt, r.location.timezone)} was called off — your ride is still booked and transportation will confirm a new pickup.`,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }
  void trackNotificationWork(
    notifyUser(run.driver.id, { subject: `Run cancelled: ${run.van.name}`, body: reason, category: 'transport', linkUrl: '/' }),
  );
  res.json({ ok: true });
});

/**
 * Plan the day: every booking still waiting on a van, grouped and filled
 * into free vans and drivers with pickups in order and timed — a proposal
 * the director reviews and dispatches (nothing is saved here).
 */
transportRouter.post('/plan', MANAGE, async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
  res.json({ date, ...(await planDay(date)) });
});

/** One van's pickups in the shortest order, each with a pickup time. */
transportRouter.post('/route', MANAGE, async (req, res) => {
  const { rideIds } = z.object({ rideIds: z.array(z.string().uuid()).min(1).max(60) }).parse(req.body);
  const rides = await prisma.ride.findMany({ where: { id: { in: rideIds } }, select: planRideSelect });
  if (rides.length !== rideIds.length) throw new HttpError(400, 'ride_not_found', 'A ride on this run no longer exists.');
  if (new Set(rides.map((r) => r.direction)).size > 1) {
    throw new HttpError(400, 'ride_mismatch', 'Every ride on a run goes the same way.');
  }
  const planned = await orderAndTime(rides);
  res.json({
    direction: rides[0]!.direction,
    departAt: planned.departAt.toISOString(),
    arriveAt: planned.arriveAt?.toISOString() ?? null,
    rides: planned.order.map((x) => ({ rideId: x.ride.id, pickupAt: x.pickupAt.toISOString() })),
  });
});

/** A word to everyone on a van — its riders and its driver. */
transportRouter.post('/runs/:id/message', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { body } = z.object({ body: z.string().trim().min(2).max(500) }).parse(req.body);
  const run = await prisma.rideRun.findUnique({ where: { id }, include: runInclude });
  if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
  const riders = run.rides.filter((r) => r.status === 'SCHEDULED' || r.status === 'BOARDED');
  const subject = `${run.van.name}: a message from transportation`;
  for (const r of riders) {
    void trackNotificationWork(notifyAssociate(r.associate.id, { subject, body, category: 'transport', linkUrl: '/rides' }));
  }
  void trackNotificationWork(notifyUser(run.driver.id, { subject, body, category: 'transport', linkUrl: '/' }));
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'transport.run_messaged', entityType: 'RideRun', entityId: id, metadata: { riders: riders.length } },
    'transport',
  );
  res.json({ sent: riders.length + 1 });
});

/* ----- Vans, stops, drivers, issues, charges, fares ----------------------- */

transportRouter.get('/vans', VIEW, async (_req, res) => {
  const vans = await prisma.van.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  res.json({ vans: vans.map((v) => ({ id: v.id, name: v.name, plate: v.plate, capacity: v.capacity, isActive: v.isActive, notes: v.notes })) });
});

const VanInput = z.object({
  name: z.string().trim().min(1).max(60),
  plate: z.string().trim().max(20).nullable().optional(),
  capacity: z.number().int().min(1).max(60),
  notes: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

transportRouter.post('/vans', MANAGE, async (req, res) => {
  const input = VanInput.parse(req.body);
  const van = await prisma.van.create({ data: { name: input.name, plate: input.plate ?? null, capacity: input.capacity, notes: input.notes ?? null } });
  res.status(201).json({ van });
});

transportRouter.patch('/vans/:id', MANAGE, async (req, res) => {
  const input = VanInput.partial().parse(req.body);
  const van = await prisma.van.update({ where: { id: z.string().uuid().parse(req.params.id) }, data: input });
  res.json({ van });
});

transportRouter.get('/stops', VIEW, async (_req, res) => {
  const stops = await prisma.transportStop.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  res.json({ stops: stops.map((s) => ({ id: s.id, name: s.name, address: s.address, notes: s.notes, isActive: s.isActive })) });
});

const StopInput = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(5).max(300),
  notes: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  ...LatLng,
});

transportRouter.post('/stops', MANAGE, async (req, res) => {
  const input = StopInput.parse(req.body);
  const at = await pointFor(input.address, input.lat, input.lng);
  const stop = await prisma.transportStop.create({
    data: { name: input.name, address: input.address, notes: input.notes ?? null, lat: at?.lat ?? null, lng: at?.lng ?? null },
  });
  res.status(201).json({ stop });
});

transportRouter.patch('/stops/:id', MANAGE, async (req, res) => {
  const { lat, lng, ...input } = StopInput.partial().parse(req.body);
  // A new address (or a pin) moves the stop on the map.
  const at = input.address ? await pointFor(input.address, lat, lng) : lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
  const stop = await prisma.transportStop.update({
    where: { id: z.string().uuid().parse(req.params.id) },
    data: { ...input, ...(at !== undefined ? { lat: at?.lat ?? null, lng: at?.lng ?? null } : {}) },
  });
  res.json({ stop });
});

transportRouter.get('/issues', VIEW, async (req, res) => {
  const status = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional().parse(req.query.status);
  const issues = await prisma.transportIssue.findMany({
    where: status ? { status } : { status: { not: 'RESOLVED' } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      reportedBy: { select: { id: true, email: true, role: true, associate: { select: { firstName: true, lastName: true } } } },
      ride: { select: rideSelect },
      run: { select: { id: true, serviceDate: true, departAt: true, van: { select: { name: true } } } },
    },
  });
  res.json({
    issues: issues.map((i) => ({
      id: i.id,
      category: i.category,
      body: i.body,
      status: i.status,
      resolution: i.resolution,
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
      reportedBy: { userId: i.reportedBy.id, name: personName(i.reportedBy), role: i.reportedBy.role },
      ride: i.ride ? toRideView(i.ride) : null,
      run: i.run ? { id: i.run.id, serviceDate: i.run.serviceDate, departAt: i.run.departAt.toISOString(), van: i.run.van.name } : null,
    })),
  });
});

transportRouter.patch('/issues/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = z
    .object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']), resolution: z.string().trim().max(2000).optional() })
    .parse(req.body);
  if (input.status === 'RESOLVED' && !input.resolution) {
    throw new HttpError(400, 'resolution_required', 'Say how it was resolved.');
  }
  const issue = await prisma.transportIssue.update({
    where: { id },
    data: {
      status: input.status,
      ...(input.status === 'RESOLVED'
        ? { resolution: input.resolution, resolvedAt: new Date(), resolvedById: req.user!.id }
        : {}),
    },
  });
  if (input.status === 'RESOLVED') {
    void trackNotificationWork(
      notifyUser(issue.reportedById, {
        subject: 'Your transportation issue is resolved',
        body: input.resolution!,
        category: 'transport',
        linkUrl: '/rides',
      }),
    );
  }
  res.json({ ok: true });
});

transportRouter.get('/charges', VIEW, async (req, res) => {
  const q = z
    .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .parse(req.query);
  const rides = await prisma.ride.findMany({
    where: { serviceDate: { gte: q.from, lte: q.to }, chargeCents: { gt: 0 } },
    select: {
      chargeCents: true,
      status: true,
      waivedAt: true,
      chargedRunId: true,
      associate: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const byAssociate = new Map<string, { associateId: string; name: string; rides: number; noShows: number; owedCents: number; takenCents: number; waivedCents: number }>();
  for (const r of rides) {
    const row = byAssociate.get(r.associate.id) ?? {
      associateId: r.associate.id,
      name: `${r.associate.firstName} ${r.associate.lastName}`,
      rides: 0,
      noShows: 0,
      owedCents: 0,
      takenCents: 0,
      waivedCents: 0,
    };
    if (r.status === 'NO_SHOW') row.noShows += 1;
    else row.rides += 1;
    if (r.waivedAt) row.waivedCents += r.chargeCents;
    else if (r.chargedRunId) row.takenCents += r.chargeCents;
    else row.owedCents += owedCents(r);
    byAssociate.set(r.associate.id, row);
  }
  const rows = [...byAssociate.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json({
    from: q.from,
    to: q.to,
    rows,
    totals: rows.reduce(
      (t, r) => ({
        rides: t.rides + r.rides,
        noShows: t.noShows + r.noShows,
        owedCents: t.owedCents + r.owedCents,
        takenCents: t.takenCents + r.takenCents,
        waivedCents: t.waivedCents + r.waivedCents,
      }),
      { rides: 0, noShows: 0, owedCents: 0, takenCents: 0, waivedCents: 0 },
    ),
  });
});

transportRouter.get('/settings', VIEW, async (_req, res) => {
  res.json({ settings: await getTransportSettings() });
});

transportRouter.put('/settings', MANAGE, async (req, res) => {
  const input = z
    .object({
      fareCents: z.number().int().min(0).max(10_000),
      noShowFeeCents: z.number().int().min(0).max(10_000),
      cutoffHours: z.number().int().min(0).max(72),
    })
    .parse(req.body);
  await prisma.transportSettings.upsert({
    where: { id: 'default' },
    create: { id: 'default', ...input, updatedById: req.user!.id },
    update: { ...input, updatedById: req.user!.id },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'transport.settings_changed', entityType: 'TransportSettings', entityId: 'default', metadata: input }, 'transport');
  res.json({ settings: await getTransportSettings() });
});

/* ===== The store supervisors' heads-up ================================== */

/**
 * Who's arriving at the supervisor's stores by van today — heads-up only.
 * Rides never depend on the schedule, so this flags anyone coming in
 * without a shift there; the supervisor decides nothing here.
 */
transportRouter.get('/arrivals', requireAuth, async (req, res) => {
  const user = req.user!;
  const bounded = user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR';
  if (!bounded && !hasCapability(user.role, 'view:transport')) throw new HttpError(403, 'forbidden', 'Not allowed.');
  const clientId = bounded ? user.clientId : z.string().uuid().optional().parse(req.query.clientId);
  if (!clientId) {
    if (bounded) throw new HttpError(403, 'no_client', 'Your account is not assigned to a client.');
    throw new HttpError(400, 'client_required', 'Pass ?clientId=.');
  }
  const now = new Date();
  const rides = await prisma.ride.findMany({
    where: {
      direction: 'TO_WORK',
      status: { in: ['REQUESTED', 'SCHEDULED', 'BOARDED', 'COMPLETED'] },
      location: { clientId },
      targetAt: { gte: new Date(now.getTime() - 6 * 3_600_000), lt: new Date(now.getTime() + 18 * 3_600_000) },
    },
    orderBy: { targetAt: 'asc' },
    select: rideSelect,
  });
  // Scheduled at that store that day? (Heads-up only — no gate.)
  const shifts = rides.length
    ? await prisma.shift.findMany({
        where: {
          assignedAssociateId: { in: [...new Set(rides.map((r) => r.associate.id))] },
          clientId,
          status: { notIn: ['CANCELLED'] },
          startsAt: { gte: new Date(now.getTime() - 12 * 3_600_000), lt: new Date(now.getTime() + 24 * 3_600_000) },
        },
        select: { assignedAssociateId: true, startsAt: true },
      })
    : [];
  // Vans on the road: when each rider actually gets here.
  const eta = new Map<string, Date | null>();
  for (const runId of new Set(rides.filter((r) => r.run?.status === 'ACTIVE').map((r) => r.run!.id))) {
    const run = await prisma.rideRun.findUnique({ where: { id: runId }, include: liveRunInclude });
    if (!run) continue;
    const live = await computeRunLive(run, now);
    for (const [id, at] of live.plan.dropEta) eta.set(id, at);
  }
  res.json({
    arrivals: rides.map((r) => ({
      rideId: r.id,
      associateId: r.associate.id,
      name: `${r.associate.firstName} ${r.associate.lastName}`,
      store: { id: r.location.id, name: r.location.name },
      arriveBy: r.targetAt.toISOString(),
      etaAt: eta.get(r.id)?.toISOString() ?? null,
      lateMinutes: eta.get(r.id) ? Math.max(0, Math.round((eta.get(r.id)!.getTime() - r.targetAt.getTime()) / 60_000)) : 0,
      status: r.status,
      van: r.run?.van.name ?? null,
      hasShift: shifts.some(
        (s) =>
          s.assignedAssociateId === r.associate.id &&
          Math.abs(s.startsAt.getTime() - r.targetAt.getTime()) < 4 * 3_600_000,
      ),
    })),
  });
});
