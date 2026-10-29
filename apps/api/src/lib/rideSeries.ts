import type { Prisma, PrismaClient, RideDirection } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { tenantJob } from './tenantJobs.js';
import { armJob } from './jobs.js';
import { tenantIdForWrite } from './tenant.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { zonedWallTimeToUtcInstant } from './timezone.js';
import { rideAuthorizationStatus, rideRateOn } from './rideAuthorization.js';
import { shiftTargetAt, storeShiftWindows } from './transportSeats.js';
import { OPEN_RIDE_STATUSES, bookableStores, getTransportSettings, noticeFor, serviceDateFor } from './transport.js';

/**
 * Standing bookings — a rider on the same shift pattern books once.
 *
 * A RideSeries names the way, the store, the pickup, the days of the week
 * and either the store shift ("Morning") or a fixed time. The generator
 * books the next GENERATE_DAYS_AHEAD days of it as ordinary rides, each
 * priced at the rate in force and subject to the cutoff, the duplicate
 * guard and the signed authorization exactly as a hand booking is — a
 * rider whose authorization lapsed gets no rides until they sign again.
 * Seats go first-come, so a standing booking stands in line like anyone
 * else; it simply never forgets to ask.
 *
 * Cancelling a series stops the generator. Rides it already booked stay —
 * the rider cancels those one by one, as with any ride.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const GENERATE_DAYS_AHEAD = 7;
const DUPLICATE_WINDOW_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: only @db.Date columns and UTC-midnight day anchors come through here
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => ymd(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export interface SeriesRow {
  id: string;
  associateId: string;
  direction: RideDirection;
  locationId: string;
  stopId: string | null;
  address: string | null;
  lat: Prisma.Decimal | null;
  lng: Prisma.Decimal | null;
  windowLabel: string | null;
  timeOfDay: string | null;
  daysOfWeek: number[];
  startsOn: Date;
  endsOn: Date | null;
  note: string | null;
  generatedThrough: Date | null;
  cancelledAt: Date | null;
  createdById: string;
}

/** When the series' ride is on store day `date`, or null when the shift no longer exists. */
export async function seriesTargetAt(s: Pick<SeriesRow, 'locationId' | 'direction' | 'windowLabel' | 'timeOfDay'>, date: string, tz: string): Promise<Date | null> {
  if (s.windowLabel) {
    const w = (await storeShiftWindows([s.locationId])).get(s.locationId)?.find((x) => x.label === s.windowLabel);
    return w ? shiftTargetAt(w, date, s.direction, tz) : null;
  }
  if (!s.timeOfDay) return null;
  const [h, m] = s.timeOfDay.split(':').map(Number) as [number, number];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return zonedWallTimeToUtcInstant(y, mo, d, h * 60 + m, tz);
}

export interface GenerateResult {
  booked: number;
  skipped: number;
}

/** Book one series forward from today through the horizon. */
export async function generateSeries(series: SeriesRow, now = new Date(), db: Db = prisma): Promise<GenerateResult> {
  const out: GenerateResult = { booked: 0, skipped: 0 };
  if (series.cancelledAt) return out;
  const store = await db.site.findUnique({ where: { id: series.locationId }, select: { id: true, name: true, timezone: true, deletedAt: true } });
  if (!store || store.deletedAt) return out;
  const tz = store.timezone;
  const today = dateKeyInZone(now, tz);
  const from = series.generatedThrough ? addDays(ymd(series.generatedThrough), 1) : today;
  const start = from < today ? today : from;
  const horizon = addDays(today, GENERATE_DAYS_AHEAD);
  const last = series.endsOn && ymd(series.endsOn) < horizon ? ymd(series.endsOn) : horizon;
  if (start > last) return out;

  const [settings, authorization, user, stores] = await Promise.all([
    getTransportSettings(db),
    rideAuthorizationStatus(db, { id: series.associateId }, now),
    db.user.findFirst({ where: { associateId: series.associateId, status: 'ACTIVE', deletedAt: null }, select: { clientId: true } }),
    bookableStores(series.associateId, null, db),
  ]);
  // No authorization, or the store is no longer theirs: the series waits
  // (nothing is marked generated, so it catches up once they sign).
  if (!authorization.current || !stores.some((s) => s.id === store.id)) return out;
  void user;

  let through: string | null = null;
  for (let date = start; date <= last; date = addDays(date, 1)) {
    through = date;
    if (ymd(series.startsOn) > date) continue;
    if (!series.daysOfWeek.includes(dow(date))) continue;
    const targetAt = await seriesTargetAt(series, date, tz);
    if (!targetAt) {
      out.skipped += 1;
      continue;
    }
    const { notice } = noticeFor(settings, targetAt, now);
    if (notice === 'closed' || notice === 'too_far') {
      out.skipped += 1;
      continue;
    }
    const clash = await db.ride.findFirst({
      where: {
        associateId: series.associateId,
        direction: series.direction,
        status: { in: [...OPEN_RIDE_STATUSES] },
        targetAt: { gt: new Date(targetAt.getTime() - DUPLICATE_WINDOW_MS), lt: new Date(targetAt.getTime() + DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (clash) {
      out.skipped += 1;
      continue;
    }
    const rateThen = await rideRateOn(db, targetAt);
    const ride = await db.ride.create({
      data: {
        associateId: series.associateId,
        direction: series.direction,
        locationId: store.id,
        stopId: series.stopId,
        address: series.address,
        lat: series.lat,
        lng: series.lng,
        targetAt,
        serviceDate: serviceDateFor(targetAt, tz),
        windowLabel: series.windowLabel,
        shortNotice: notice === 'short_notice',
        note: series.note,
        // The fare in force on that ride's day, not today's.
        fareCents: rateThen?.fareCents ?? settings.fareCents,
        noShowFeeCents: rateThen?.noShowFeeCents ?? settings.noShowFeeCents,
        seriesId: series.id,
        createdById: series.createdById,
        tenantId: tenantIdForWrite(),
      },
      select: { id: true },
    });
    enqueueAudit(
      { actorUserId: series.createdById, action: 'transport.ride_booked', entityType: 'Ride', entityId: ride.id, metadata: { seriesId: series.id, direction: series.direction, locationId: store.id, targetAt: targetAt.toISOString() } },
      'rideSeries',
    );
    out.booked += 1;
  }
  if (through) await db.rideSeries.update({ where: { id: series.id }, data: { generatedThrough: new Date(`${through}T00:00:00Z`) } });
  return out;
}

/** Every active series, forward to the horizon. Daily, and on creation. */
export async function generateAllSeries(now = new Date(), db: Db = prisma): Promise<GenerateResult> {
  const rows = await db.rideSeries.findMany({
    where: { cancelledAt: null, OR: [{ endsOn: null }, { endsOn: { gte: new Date(now.getTime() - DAY_MS) } }], associate: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
  });
  const total: GenerateResult = { booked: 0, skipped: 0 };
  for (const s of rows) {
    try {
      const r = await generateSeries(s, now, db);
      total.booked += r.booked;
      total.skipped += r.skipped;
    } catch (err) {
      console.error(`[alto-people/api] ride series ${s.id} failed:`, err);
    }
  }
  return total;
}

/** Through the jobs registry (in-flight guard, Scheduled jobs panel); per tenant with transportation on. */
export function startRideSeriesCron(): void {
  armJob({
    name: 'rideSeries',
    label: 'Standing ride bookings (booked a week ahead)',
    intervalSeconds: Math.max(0, env.RIDE_SERIES_INTERVAL_SECONDS),
    run: tenantJob('rideSeries', () => generateAllSeries(), { module: 'transportation' }),
  });
}
