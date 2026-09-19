import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { placedClientIds } from './openShiftEligibility.js';

/**
 * Transportation — the Alto vans.
 *
 *   book       an associate books a seat to or from work: a store, a time
 *              (arrive by / pick up at), their home address or a housing
 *              complex. Independent of the schedule — people come in
 *              without a shift too. At least `cutoffHours` (10) ahead, so
 *              dispatch can plan the vans.
 *   dispatch   the Transportation Director puts bookings on van runs: a
 *              van, a driver, a departure, the pickups in order with a
 *              time each. The rider hears their pickup time and van.
 *   ride       the driver marks each rider on board (the fare, $5) or a
 *              no-show (the fee, $1), then completes the run.
 *   pay        what's owed comes out of the paycheck of the pay period the
 *              ride was in (payroll's aggregate step — applyRideCharges).
 *
 * Money is in cents everywhere here; payroll converts at the boundary.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface TransportSettingsView {
  fareCents: number;
  noShowFeeCents: number;
  cutoffHours: number;
}

export async function getTransportSettings(db: Db = prisma): Promise<TransportSettingsView> {
  const row =
    (await db.transportSettings.findUnique({ where: { id: 'default' } })) ??
    (await db.transportSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    }));
  return { fareCents: row.fareCents, noShowFeeCents: row.noShowFeeCents, cutoffHours: row.cutoffHours };
}

/** The active stores an associate can ride to — every store of every client
 *  they work at: placed there (approved application or open assignment),
 *  on the schedule there (a shift in the last 30 days or ahead), or the
 *  client a supervisor's login is assigned to. */
export async function bookableStores(associateId: string, ownClientId: string | null = null, db: Db = prisma) {
  const [placed, scheduled] = await Promise.all([
    placedClientIds(associateId, db),
    db.shift.findMany({
      where: {
        assignedAssociateId: associateId,
        status: { notIn: ['CANCELLED'] },
        startsAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      select: { clientId: true },
      distinct: ['clientId'],
    }),
  ]);
  const clientIds = [
    ...new Set([...placed, ...scheduled.map((s) => s.clientId), ...(ownClientId ? [ownClientId] : [])]),
  ];
  if (clientIds.length === 0) return [];
  return db.location.findMany({
    where: { clientId: { in: clientIds }, deletedAt: null, isActive: true },
    select: {
      id: true,
      name: true,
      timezone: true,
      addressLine1: true,
      city: true,
      state: true,
      client: { select: { id: true, name: true } },
    },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
  });
}

export function serviceDateFor(targetAt: Date, timezone: string | null | undefined): string {
  return dateKeyInZone(targetAt, timezone ?? DEFAULT_TIMEZONE);
}

export const rideSelect = {
  id: true,
  associateId: true,
  direction: true,
  targetAt: true,
  serviceDate: true,
  status: true,
  shiftId: true,
  note: true,
  address: true,
  lat: true,
  lng: true,
  pickupOrder: true,
  pickupAt: true,
  fareCents: true,
  noShowFeeCents: true,
  chargeCents: true,
  waivedAt: true,
  waiveReason: true,
  chargedRunId: true,
  chargedAt: true,
  boardedAt: true,
  completedAt: true,
  noShowAt: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  location: { select: { id: true, name: true, timezone: true, client: { select: { id: true, name: true } } } },
  stop: { select: { id: true, name: true, address: true, lat: true, lng: true } },
  associate: { select: { id: true, firstName: true, lastName: true, phone: true } },
  run: {
    select: {
      id: true,
      status: true,
      departAt: true,
      van: { select: { id: true, name: true, plate: true } },
      driver: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
  },
} satisfies Prisma.RideSelect;

export type RideRow = Prisma.RideGetPayload<{ select: typeof rideSelect }>;

function personName(u: { email: string; associate: { firstName: string; lastName: string } | null }): string {
  return u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
}

function coords(lat: Prisma.Decimal | null, lng: Prisma.Decimal | null): { lat: number; lng: number } | null {
  return lat === null || lng === null ? null : { lat: Number(lat), lng: Number(lng) };
}

/** What the rider owes for this ride right now (0 when waived or not due). */
export function owedCents(r: { chargeCents: number; waivedAt: Date | null }): number {
  return r.waivedAt ? 0 : r.chargeCents;
}

export function toRideView(r: RideRow) {
  return {
    id: r.id,
    direction: r.direction,
    targetAt: r.targetAt.toISOString(),
    serviceDate: r.serviceDate,
    status: r.status,
    shiftId: r.shiftId,
    note: r.note,
    pickup: r.stop
      ? { kind: 'stop' as const, id: r.stop.id, name: r.stop.name, address: r.stop.address }
      : { kind: 'address' as const, id: null, name: null, address: r.address ?? '' },
    /** The home end's coordinates, when known (the rider's own, or a stop's). */
    point: coords(r.stop ? r.stop.lat : r.lat, r.stop ? r.stop.lng : r.lng),
    store: {
      id: r.location.id,
      name: r.location.name,
      timezone: r.location.timezone,
      clientId: r.location.client.id,
      clientName: r.location.client.name,
    },
    rider: { associateId: r.associate.id, name: `${r.associate.firstName} ${r.associate.lastName}`, phone: r.associate.phone },
    pickupOrder: r.pickupOrder,
    pickupAt: r.pickupAt?.toISOString() ?? null,
    run: r.run
      ? {
          id: r.run.id,
          status: r.run.status,
          departAt: r.run.departAt.toISOString(),
          van: r.run.van,
          driver: { userId: r.run.driver.id, name: personName(r.run.driver) },
        }
      : null,
    fareCents: r.fareCents,
    noShowFeeCents: r.noShowFeeCents,
    owedCents: owedCents(r),
    waived: !!r.waivedAt,
    waiveReason: r.waiveReason,
    charged: !!r.chargedRunId,
    boardedAt: r.boardedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    noShowAt: r.noShowAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Rides still waiting on the van or the rider — the ones that can be
 *  cancelled or dispatched. */
export const OPEN_RIDE_STATUSES = ['REQUESTED', 'SCHEDULED'] as const;

/**
 * Payroll's step: take every ride charge an associate owes into this run's
 * paycheck — whole rides, oldest first, never taking net pay below zero (a
 * ride that doesn't fit waits for the next check). Stamped with the run so
 * re-aggregating the run first releases them (releaseRideCharges) and
 * applies them again: the same idempotency rule as clawbacks.
 */
export async function applyRideCharges(
  tx: Prisma.TransactionClient,
  input: {
    associateId: string;
    availableNet: number;
    payrollRunId: string;
    payrollItemId: string;
    /** YYYY-MM-DD — rides on or before the period's last day. */
    periodEnd: string;
    /** A client-scoped run only takes its own client's rides. */
    clientId: string | null;
  },
): Promise<{ totalApplied: number; rides: number }> {
  const owed = await tx.ride.findMany({
    where: {
      associateId: input.associateId,
      chargeCents: { gt: 0 },
      waivedAt: null,
      chargedRunId: null,
      serviceDate: { lte: input.periodEnd },
      ...(input.clientId ? { location: { clientId: input.clientId } } : {}),
    },
    orderBy: [{ serviceDate: 'asc' }, { targetAt: 'asc' }],
    select: { id: true, chargeCents: true },
  });
  let budget = Math.max(0, Math.round(input.availableNet * 100));
  const taken: string[] = [];
  let totalCents = 0;
  for (const r of owed) {
    if (r.chargeCents > budget) continue;
    budget -= r.chargeCents;
    totalCents += r.chargeCents;
    taken.push(r.id);
  }
  if (taken.length > 0) {
    await tx.ride.updateMany({
      where: { id: { in: taken } },
      data: { chargedRunId: input.payrollRunId, chargedItemId: input.payrollItemId, chargedAt: new Date() },
    });
  }
  return { totalApplied: totalCents / 100, rides: taken.length };
}

/** Un-stamp this run's ride charges — before re-aggregating or deleting it. */
export async function releaseRideCharges(tx: Prisma.TransactionClient, payrollRunId: string): Promise<void> {
  await tx.ride.updateMany({
    where: { chargedRunId: payrollRunId },
    data: { chargedRunId: null, chargedItemId: null, chargedAt: null },
  });
}
