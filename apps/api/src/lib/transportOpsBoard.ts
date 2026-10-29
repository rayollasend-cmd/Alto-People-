import type { Prisma } from '@prisma/client';
import type { FleetVan, FleetVanState, TransportException, TransportExceptionSeverity, TransportOpsBoard } from '@alto-people/shared';
import { prisma } from '../db.js';
import { companyWorkweek, dateKeyInZone } from './timeAnomalies.js';
import { fmtDay } from './humanDates.js';
import { STALE_MS, computeRunLive, liveRunInclude, type RunLive } from './transportLive.js';
import { STALL_MINUTES } from './transportSafety.js';
import { isRunStuck, lastWaypointAt } from './transportStuckRuns.js';
import { conflictPairs, isNotRun } from './transportConflicts.js';
import { credentialsEnforced, driverCredentialStatus, hosSettings, preTripLabel, vanDayKey, vanDayPreTrips } from './transportDrivers.js';
import { transportKpis } from './transportKpis.js';

/**
 * The dispatcher's live operations (transport upgrade 2026-10-28) —
 * GET /transport/ops: every van and what it is doing, the exceptions that
 * need a person (worst first), the four KPIs, and where the map opens.
 *
 * It reads what the board, the live map and the safety watch already keep
 * — the run's last ping (RideRun.lastLat…), the live plan's ETAs
 * (lib/transportLive computeRunLive), the safety stamps, the stuck-run and
 * double-booking rules — and words each problem once, with its number and
 * the one click that fixes it. Nothing here writes.
 */

const LATE_MEDIUM_MIN = 5;
const LATE_HIGH_MIN = 15;
/** A planned run this long past its departure without starting is a problem. */
const NOT_STARTED_AFTER_MS = 10 * 60_000;
/** No-shows stay on the queue (an FYI) this long. */
const NO_SHOW_WINDOW_MS = 2 * 3_600_000;
const HALF_HOUR = 1_800_000;

const opsRunSelect = {
  id: true,
  vanId: true,
  driverUserId: true,
  direction: true,
  serviceDate: true,
  status: true,
  departAt: true,
  startedAt: true,
  endedAt: true,
  autoClosedAt: true,
  lastLat: true,
  lastLng: true,
  lastHeading: true,
  lastLocationAt: true,
  sosAt: true,
  sosNote: true,
  sosAckAt: true,
  stallAlertedAt: true,
  stallEscalatedAt: true,
  van: { select: { name: true } },
  driver: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true, phone: true } } } },
  rides: { select: { id: true, status: true, targetAt: true, pickupAt: true, location: { select: { name: true, timezone: true } } } },
} satisfies Prisma.RideRunSelect;

type OpsRun = Prisma.RideRunGetPayload<{ select: typeof opsRunSelect }>;

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
const fullName = (u: { email: string; associate: { firstName: string; lastName: string } | null }) =>
  u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
const firstName = (u: { email: string; associate: { firstName: string } | null }) => u.associate?.firstName ?? u.email.split('@')[0] ?? u.email;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const zoneOf = (run: OpsRun) => run.rides[0]?.location.timezone ?? companyWorkweek().timezone;
const fmtTime = (d: Date, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const riding = (r: { status: string }) => r.status === 'SCHEDULED' || r.status === 'BOARDED';
/** "25 minutes" up to an hour and a half, then "17 hours". */
const span = (minutes: number) => (minutes < 90 ? plural(minutes, 'minute') : plural(Math.round(minutes / 60), 'hour'));

const SEVERITY_RANK: Record<TransportExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** The driver's phone as a tel: link, or the run itself when there is none to call. */
function callOrOpen(run: OpsRun): TransportException['action'] {
  const phone = run.driver.associate?.phone?.replace(/[^+\d]/g, '');
  return phone ? { label: `Call ${firstName(run.driver)}`, kind: 'call_driver', target: `tel:${phone}` } : { label: 'Open the run', kind: 'open_run', target: run.id };
}

interface NextStop {
  label: string;
  scheduledAt: Date | null;
  etaAt: Date | null;
}

/** The van's next stop from the live plan, with what the schedule says and when it should get there. */
function nextStopOf(run: OpsRun, live: RunLive, rideRows: Map<string, { name: string; stop: string | null; pickupAt: Date | null; targetAt: Date }>): NextStop | null {
  const w = live.plan.waypoints[0];
  if (!w) return null;
  const rides = w.rideIds.map((id) => rideRows.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  if (w.kind === 'store') {
    const name = live.stores.get(w.locationId!)?.location.name ?? '';
    const scheduledAt =
      run.direction === 'TO_WORK'
        ? (rides.map((r) => r.targetAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? null)
        : (rides.map((r) => r.pickupAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? run.departAt);
    return { label: name, scheduledAt, etaAt: w.etaAt };
  }
  const first = rides[0];
  const label = first ? (first.stop ?? first.name) : '';
  return { label, scheduledAt: w.kind === 'pickup' ? (first?.pickupAt ?? null) : null, etaAt: w.etaAt };
}

export async function computeOpsBoard(date: string, now = new Date()): Promise<TransportOpsBoard> {
  const today = dateKeyInZone(now, companyWorkweek().timezone);
  const isToday = date === today;

  const [runs, vansAll, waiting, noShows, issues, settings, enforced] = await Promise.all([
    prisma.rideRun.findMany({
      // A run left out past midnight is still on the road today.
      where: isToday ? { OR: [{ serviceDate: date }, { status: 'ACTIVE' }] } : { serviceDate: date },
      orderBy: { departAt: 'asc' },
      select: opsRunSelect,
    }),
    prisma.van.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, plate: true, capacity: true, isActive: true, outOfServiceAt: true, outOfServiceReason: true },
    }),
    prisma.ride.findMany({
      where: { serviceDate: date, status: 'REQUESTED', runId: null },
      orderBy: { targetAt: 'asc' },
      select: { id: true, direction: true, targetAt: true, createdAt: true, location: { select: { id: true, name: true, timezone: true } } },
    }),
    isToday
      ? prisma.ride.findMany({
          where: { status: 'NO_SHOW', noShowAt: { gte: new Date(now.getTime() - NO_SHOW_WINDOW_MS) } },
          orderBy: { noShowAt: 'asc' },
          select: {
            id: true,
            noShowAt: true,
            direction: true,
            chargeCents: true,
            waivedAt: true,
            address: true,
            stop: { select: { name: true } },
            associate: { select: { firstName: true, lastName: true } },
            location: { select: { name: true, timezone: true } },
            run: { select: { id: true, van: { select: { name: true } } } },
          },
        })
      : Promise.resolve([]),
    prisma.transportIssue.findMany({
      where: { status: { not: 'RESOLVED' } },
      orderBy: { createdAt: 'asc' },
      take: 30,
      select: { id: true, category: true, body: true, createdAt: true, rideId: true, runId: true, vanId: true, reportedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } } },
    }),
    hosSettings(),
    credentialsEnforced(),
  ]);

  const dayRuns = runs.filter((r) => r.serviceDate === date || r.status === 'ACTIVE');
  const liveRuns = dayRuns.filter((r) => r.status !== 'CANCELLED');
  const active = liveRuns.filter((r) => r.status === 'ACTIVE');
  const planned = liveRuns.filter((r) => r.status === 'PLANNED').sort((a, b) => a.departAt.getTime() - b.departAt.getTime());
  const vans = vansAll.filter((v) => v.isActive || dayRuns.some((r) => r.vanId === v.id));

  // The live plan for every van on the road (ETAs, the next stop).
  const activeRows = active.length ? await prisma.rideRun.findMany({ where: { id: { in: active.map((r) => r.id) } }, include: liveRunInclude }) : [];
  const [lives, lastSeen, preTrips, profiles, center] = await Promise.all([
    Promise.all(activeRows.map(async (row) => [row.id, { row, live: await computeRunLive(row, now) }] as const)).then((x) => new Map(x)),
    // Where an idle van was last seen: the last ping of its latest run.
    prisma.rideRun.findMany({
      where: { vanId: { in: vans.map((v) => v.id) }, lastLocationAt: { not: null }, status: { not: 'ACTIVE' } },
      orderBy: { lastLocationAt: 'desc' },
      distinct: ['vanId'],
      select: { vanId: true, lastLat: true, lastLng: true, lastHeading: true, lastLocationAt: true },
    }),
    vanDayPreTrips(planned.map((r) => ({ vanId: r.vanId, serviceDate: r.serviceDate }))),
    prisma.driverProfile.findMany({ where: { userId: { in: [...new Set(liveRuns.map((r) => r.driverUserId))] } } }),
    mapCenter(settings.driverShiftLocationId, date),
  ]);

  /*
   * One clock for the whole board: the zone of the places riders go that
   * day (the web shows departures and ETAs in `timezone`, and every time in
   * a sentence here reads the same). Places in more than one zone: the
   * company's zone for the web, and each sentence says its own zone
   * ("5:15 AM CDT").
   */
  const zones = new Set<string>([
    ...dayRuns.flatMap((r) => r.rides.map((x) => x.location.timezone)),
    ...waiting.map((r) => r.location.timezone),
    ...noShows.map((r) => r.location.timezone),
  ]);
  const mixed = zones.size > 1;
  const boardZone = zones.size === 1 ? [...zones][0]! : zones.size === 0 ? (center?.timezone ?? companyWorkweek().timezone) : companyWorkweek().timezone;
  const when = (d: Date, tz: string): string => (mixed ? `${fmtTime(d, tz)} ${zoneAbbr(d, tz)}` : fmtTime(d, boardZone));

  /* ----- the vans ----- */
  const rideRowsOf = (runId: string) => {
    const row = lives.get(runId)?.row;
    return new Map(
      (row?.rides ?? []).map((r) => [r.id, { name: `${r.associate.firstName} ${r.associate.lastName}`, stop: r.stop?.name ?? null, pickupAt: r.pickupAt, targetAt: r.targetAt }]),
    );
  };
  const lateOf = new Map<string, { minutes: number; stop: NextStop }>();
  const fleet: FleetVan[] = vans.map((v) => {
    const run = active.find((r) => r.vanId === v.id) ?? null;
    const next = planned.find((r) => r.vanId === v.id && r.id !== run?.id) ?? null;
    let state: FleetVanState;
    let position: FleetVan['position'] = null;
    if (run) {
      const fresh = !!run.lastLocationAt && now.getTime() - run.lastLocationAt.getTime() <= STALE_MS;
      state = fresh ? 'on_road' : 'no_signal';
      const lat = num(run.lastLat);
      const lng = num(run.lastLng);
      if (lat !== null && lng !== null && run.lastLocationAt) position = { lat, lng, heading: run.lastHeading, at: run.lastLocationAt.toISOString() };
    } else {
      state = v.outOfServiceAt ? 'out_of_service' : next ? 'planned' : 'idle';
      const seen = lastSeen.find((s) => s.vanId === v.id);
      const lat = seen ? num(seen.lastLat) : null;
      const lng = seen ? num(seen.lastLng) : null;
      if (seen?.lastLocationAt && lat !== null && lng !== null) position = { lat, lng, heading: seen.lastHeading, at: seen.lastLocationAt.toISOString() };
    }
    let runView: FleetVan['run'] = null;
    if (run) {
      const live = lives.get(run.id)?.live;
      const stop = live ? nextStopOf(run, live, rideRowsOf(run.id)) : null;
      const lateMinutes = stop?.scheduledAt && stop.etaAt ? Math.max(0, Math.round((stop.etaAt.getTime() - stop.scheduledAt.getTime()) / 60_000)) : 0;
      if (stop && lateMinutes > 0) lateOf.set(run.id, { minutes: lateMinutes, stop });
      runView = {
        runId: run.id,
        direction: run.direction,
        departAt: run.departAt.toISOString(),
        driverUserId: run.driverUserId,
        driverName: fullName(run.driver),
        driverPhone: run.driver.associate?.phone ?? null,
        onBoard: run.rides.filter((r) => r.status === 'BOARDED').length,
        toPickUp: run.rides.filter((r) => r.status === 'SCHEDULED').length,
        nextStop: stop ? { label: stop.label, scheduledAt: stop.scheduledAt?.toISOString() ?? null, etaAt: stop.etaAt?.toISOString() ?? null } : null,
        lateMinutes,
      };
    }
    return {
      vanId: v.id,
      name: v.name,
      plate: v.plate,
      capacity: v.capacity,
      state,
      position,
      positionAgeMinutes: position ? Math.max(0, Math.round((now.getTime() - Date.parse(position.at)) / 60_000)) : null,
      run: runView,
      nextRun: next ? { runId: next.id, departAt: next.departAt.toISOString(), driverName: fullName(next.driver), riders: next.rides.filter(riding).length } : null,
    };
  });

  /* ----- the exceptions ----- */
  const out: TransportException[] = [];
  const push = (e: TransportException) => out.push(e);
  const byId = new Map(runs.map((r) => [r.id, r]));

  for (const run of liveRuns) {
    const tz = zoneOf(run);
    const van = run.van.name;
    const who = firstName(run.driver);
    if (run.sosAt && !run.sosAckAt) {
      push({
        id: `sos:${run.id}`,
        kind: 'sos',
        severity: 'high',
        title: `SOS from ${who} in ${van}`,
        detail: `${who} pressed the emergency button at ${when(run.sosAt, tz)}${run.sosNote ? ` — “${run.sosNote}”` : ''}. Call now, then acknowledge.`,
        at: run.sosAt.toISOString(),
        runId: run.id,
        vanId: run.vanId,
        driverUserId: run.driverUserId,
        action: { label: 'Acknowledge', kind: 'ack_sos', target: run.id },
      });
    }
    if (run.status === 'ACTIVE') {
      const late = lateOf.get(run.id);
      if (late && late.minutes >= LATE_MEDIUM_MIN) {
        const due = late.stop.scheduledAt!;
        push({
          id: `late:${run.id}`,
          kind: 'late',
          severity: late.minutes >= LATE_HIGH_MIN ? 'high' : 'medium',
          title: `${van} is ${plural(late.minutes, 'minute')} late at ${late.stop.label}`,
          detail: `Due ${when(due, tz)}, now expected about ${when(late.stop.etaAt!, tz)}. Call ${who}, or warn ${late.stop.label}.`,
          at: (due.getTime() < now.getTime() ? due : now).toISOString(),
          runId: run.id,
          vanId: run.vanId,
          driverUserId: run.driverUserId,
          action: callOrOpen(run),
        });
      }
      if (isRunStuck(run, now)) {
        const hours = Math.max(1, Math.round((now.getTime() - lastWaypointAt(run).getTime()) / 3_600_000));
        push({
          id: `stalled:${run.id}`,
          kind: 'stalled',
          severity: 'high',
          title: `${van}'s run is still open ${plural(hours, 'hour')} after its last stop`,
          detail: `${who} never tapped Complete. Close the run so the van counts as parked.`,
          at: lastWaypointAt(run).toISOString(),
          runId: run.id,
          vanId: run.vanId,
          driverUserId: run.driverUserId,
          action: { label: 'Open the run', kind: 'open_run', target: run.id },
        });
      } else if (run.stallAlertedAt) {
        const mins = Math.max(1, Math.round((now.getTime() - run.stallAlertedAt.getTime()) / 60_000));
        push({
          id: `stalled:${run.id}`,
          kind: 'stalled',
          severity: 'high',
          title: run.stallEscalatedAt ? `${van} may be in trouble — ${who} hasn't answered for ${span(mins)}` : `${van} stopped off its route ${span(mins)} ago`,
          detail: run.stallEscalatedAt
            ? `The van sat still ${STALL_MINUTES}+ minutes away from any stop, or left its way, and ${who} hasn't answered “everything OK?”. Call now.`
            : `The van sat still ${STALL_MINUTES}+ minutes away from any stop, or left its way. ${who} was asked “everything OK?”.`,
          at: run.stallAlertedAt.toISOString(),
          runId: run.id,
          vanId: run.vanId,
          driverUserId: run.driverUserId,
          action: callOrOpen(run),
        });
      }
    }
    if (run.status === 'PLANNED' && isToday && now.getTime() > run.departAt.getTime() + NOT_STARTED_AFTER_MS) {
      const mins = Math.round((now.getTime() - run.departAt.getTime()) / 60_000);
      const riders = run.rides.filter(riding).length;
      push({
        id: `not_started:${run.id}`,
        kind: 'not_started',
        severity: 'high',
        title: `${van} hasn't left — ${span(mins)} past ${when(run.departAt, tz)}`,
        detail: `${who}'s ${run.direction === 'TO_WORK' ? 'run to work' : 'run home'} with ${plural(riders, 'rider')} hasn't started. Call ${who}.`,
        at: run.departAt.toISOString(),
        runId: run.id,
        vanId: run.vanId,
        driverUserId: run.driverUserId,
        action: callOrOpen(run),
      });
    }
  }

  // Double-bookings — the Gantt's rule (lib/transportConflicts).
  for (const p of conflictPairs(liveRuns)) {
    const a = byId.get(p.a)!;
    const b = byId.get(p.b)!;
    const tz = zoneOf(a);
    const soon = [a, b].some((r) => r.status === 'ACTIVE' || r.departAt.getTime() - now.getTime() < 3 * 3_600_000);
    const times = `${when(a.departAt, tz)} and ${when(b.departAt, tz)}`;
    if (p.kind === 'driver') {
      push({
        id: `driver_double_booked:${p.a}:${p.b}`,
        kind: 'driver_double_booked',
        severity: soon ? 'high' : 'medium',
        title: `${fullName(a.driver)} is on two runs at once — ${times}`,
        detail:
          a.vanId === b.vanId
            ? `Both runs are on ${a.van.name} and overlap by ${plural(p.overlapMinutes, 'minute')}. Move one to another van and driver.`
            : `${a.van.name}'s and ${b.van.name}'s runs overlap by ${plural(p.overlapMinutes, 'minute')}. Give one of them another driver.`,
        at: b.departAt.toISOString(),
        runId: b.id,
        driverUserId: a.driverUserId,
        action: { label: 'Open the run', kind: 'open_run', target: b.id },
      });
    } else {
      push({
        id: `van_double_booked:${p.a}:${p.b}`,
        kind: 'van_double_booked',
        severity: soon ? 'high' : 'medium',
        title: `${a.van.name} is on two runs at once — ${times}`,
        detail: `They overlap by ${plural(p.overlapMinutes, 'minute')}. Move one of them to another van.`,
        at: b.departAt.toISOString(),
        runId: b.id,
        vanId: a.vanId,
        action: { label: 'Open the run', kind: 'open_run', target: b.id },
      });
    }
  }

  // Riders booked with no van: one item per way, place and half hour (the board's groups).
  const groups = new Map<string, typeof waiting>();
  for (const r of waiting) {
    const k = `${r.direction}:${r.location.id}:${Math.floor(r.targetAt.getTime() / HALF_HOUR)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, rides] of groups) {
    const first = rides[0]!;
    const tz = first.location.timezone;
    const where = first.direction === 'TO_WORK' ? `to ${first.location.name}` : `home from ${first.location.name}`;
    push({
      id: `needs_van:${k}`,
      kind: 'needs_van',
      severity: 'medium',
      title: `${plural(rides.length, 'rider')} ${where} at ${when(first.targetAt, tz)} ${rides.length === 1 ? 'has' : 'have'} no van`,
      detail: `${rides.length === 1 ? 'They are' : 'They are all'} booked for ${fmtDay(date, { weekday: true })}. Put them on a run with seats, or plan a new one.`,
      at: new Date(Math.min(...rides.map((r) => r.createdAt.getTime()))).toISOString(),
      rideIds: rides.map((r) => r.id),
      action: { label: 'Assign a van', kind: 'assign_van', target: rides.map((r) => r.id).join(',') },
    });
  }

  // A van that failed its walk-around today: every planned run of it is parked.
  if (settings.preTripRequired) {
    for (const v of vans) {
      const runsOfVan = planned.filter((r) => r.vanId === v.id);
      const first = runsOfVan[0];
      if (!first) continue;
      const check = preTrips.get(vanDayKey(v.id, first.serviceDate));
      if (!check || check.passed) continue;
      const failed = check.failed.map(preTripLabel);
      push({
        id: `pre_trip_failed:${v.id}`,
        kind: 'pre_trip_failed',
        severity: 'high',
        title: `${v.name} failed its pre-trip check`,
        detail: `${failed.length ? `${failed.join(', ')} failed` : 'A safety item failed'} — ${plural(runsOfVan.length, 'run')} today can't leave until a check passes. Fix it, or move the runs to another van.`,
        at: check.at.toISOString(),
        runId: first.id,
        vanId: v.id,
        action: { label: 'Open the run', kind: 'open_run', target: first.id },
      });
    }
  }

  // A van out of service with runs still on it.
  for (const v of vans.filter((x) => x.outOfServiceAt)) {
    const runsOfVan = [...active, ...planned].filter((r) => r.vanId === v.id);
    const first = runsOfVan[0];
    if (!first) continue;
    push({
      id: `van_out_of_service:${v.id}`,
      kind: 'van_out_of_service',
      severity: 'high',
      title: `${v.name} is out of service with ${plural(runsOfVan.length, 'run')} today`,
      detail: `${v.outOfServiceReason ? `${v.outOfServiceReason.replace(/\.$/, '')}. ` : ''}Move ${runsOfVan.length === 1 ? 'the run' : 'its runs'} to another van.`,
      at: v.outOfServiceAt!.toISOString(),
      runId: first.id,
      vanId: v.id,
      action: { label: 'Open the run', kind: 'open_run', target: first.id },
    });
  }

  // A driver with a run today who can't drive (the board's canDrive rule).
  const byDriver = new Map<string, OpsRun[]>();
  for (const r of [...active, ...planned]) byDriver.set(r.driverUserId, [...(byDriver.get(r.driverUserId) ?? []), r]);
  for (const [driverUserId, list] of byDriver) {
    const profile = profiles.find((p) => p.userId === driverUserId) ?? null;
    if (!profile && !enforced) continue;
    const cred = driverCredentialStatus(profile, now);
    if (cred.ok) continue;
    const name = fullName(list[0]!.driver);
    const problem = profile ? cred.problems.map((p) => `${p.label.toLowerCase().replace(/^dot/, 'DOT')} ${p.expired ? 'lapsed' : 'not on file'}`).join(', ') : 'no licence on file';
    const lapsed = cred.problems.map((p) => p.expiresAt).filter((d): d is string => !!d).sort()[0];
    push({
      id: `credential_lapsed:${driverUserId}`,
      kind: 'credential_lapsed',
      severity: 'high',
      title: `${name} can't drive — ${problem}`,
      detail: `${name} has ${plural(list.length, 'run')} today. Update the driver record, or give ${list.length === 1 ? 'the run' : 'the runs'} another driver.`,
      at: lapsed ? new Date(`${lapsed}T00:00:00Z`).toISOString() : list[0]!.departAt.toISOString(),
      runId: list[0]!.id,
      driverUserId,
      action: { label: 'Open Drivers', kind: 'open_setup', target: 'drivers' },
    });
  }

  for (const r of noShows) {
    const tz = r.location.timezone;
    const place = r.direction === 'TO_WORK' ? (r.stop?.name ?? r.address ?? 'the pickup') : r.location.name;
    const fee = r.waivedAt ? 0 : r.chargeCents;
    push({
      id: `no_show:${r.id}`,
      kind: 'no_show',
      severity: 'low',
      title: `${r.associate.firstName} ${r.associate.lastName} was a no-show at ${place}`,
      detail: `Marked at ${when(r.noShowAt!, tz)}${r.run ? ` on ${r.run.van.name}` : ''} — ${fee > 0 ? `the ${money(fee)} no-show fee applies unless you waive it.` : 'no fee is charged.'}`,
      at: r.noShowAt!.toISOString(),
      runId: r.run?.id,
      rideIds: [r.id],
      action: { label: 'Open the ride', kind: 'open_ride', target: r.id },
    });
  }

  const ISSUE_TITLE: Record<string, string> = {
    LATE_VAN: 'Late van reported',
    MISSED_PICKUP: 'Missed pickup reported',
    CHARGE_DISPUTE: 'Charge disputed',
    SAFETY: 'Safety concern reported',
    VEHICLE: 'Vehicle problem reported',
    CONDUCT: 'Conduct reported',
    OTHER: 'Problem reported',
  };
  for (const i of issues) {
    const first = i.body.split(/(?<=[.!?])\s/)[0] ?? i.body;
    push({
      id: `open_issue:${i.id}`,
      kind: 'open_issue',
      severity: i.category === 'SAFETY' || i.category === 'VEHICLE' ? 'medium' : 'low',
      title: `${ISSUE_TITLE[i.category] ?? 'Problem reported'} by ${fullName(i.reportedBy)}`,
      detail: first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first,
      at: i.createdAt.toISOString(),
      ...(i.runId ? { runId: i.runId } : {}),
      ...(i.rideId ? { rideIds: [i.rideId] } : {}),
      ...(i.vanId ? { vanId: i.vanId } : {}),
      action: { label: 'Open the report', kind: 'open_issue', target: i.id },
    });
  }

  // The board's own day only: a run from another day the sweep closed lives on that day's board.
  for (const run of runs.filter((r) => r.serviceDate === date && isNotRun(r))) {
    const tz = zoneOf(run);
    const riders = run.rides.filter((r) => r.status === 'CANCELLED').length;
    push({
      id: `didnt_run:${run.id}`,
      kind: 'didnt_run',
      severity: 'medium',
      title: `${run.van.name}'s ${when(run.departAt, tz)} run didn't run`,
      detail: `It never started, so it was closed${riders ? ` and its ${plural(riders, 'rider')} told` : ''} — nobody was charged.`,
      at: (run.autoClosedAt ?? run.departAt).toISOString(),
      runId: run.id,
      vanId: run.vanId,
      driverUserId: run.driverUserId,
      action: { label: 'Open the run', kind: 'open_run', target: run.id },
    });
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  return {
    date,
    timezone: boardZone,
    generatedAt: now.toISOString(),
    vans: fleet,
    exceptions: out,
    kpis: await transportKpis(date),
    center: center?.point ?? null,
  };
}

/** Where the map opens with no van on it: the yard (the driver-shift site), else a place riders go that day, else the first site on the map — with that place's zone. */
async function mapCenter(yardId: string | null, date: string): Promise<{ point: { lat: number; lng: number } | null; timezone: string } | null> {
  const pick = (s: { latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null; timezone: string } | null) =>
    s && s.latitude !== null && s.longitude !== null ? { point: { lat: Number(s.latitude), lng: Number(s.longitude) }, timezone: s.timezone } : null;
  const siteSelect = { latitude: true, longitude: true, timezone: true } as const;
  if (yardId) {
    const yard = pick(await prisma.site.findUnique({ where: { id: yardId }, select: siteSelect }));
    if (yard) return yard;
  }
  const ridden = await prisma.ride.findFirst({
    where: { serviceDate: date, location: { latitude: { not: null }, longitude: { not: null } } },
    select: { location: { select: siteSelect } },
  });
  if (ridden) return pick(ridden.location);
  return pick(
    await prisma.site.findFirst({
      where: { deletedAt: null, isActive: true, latitude: { not: null }, longitude: { not: null } },
      orderBy: { name: 'asc' },
      select: siteSelect,
    }),
  );
}

/** "CDT" — the short name of a zone at an instant. */
function zoneAbbr(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}
