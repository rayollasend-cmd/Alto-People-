import type { FleetVan, TransportException, TransportKpi, TransportOpsBoard } from '@alto-people/shared';
import type { RunMap } from '@/lib/transportApi';

/**
 * A busy morning on the desk: six vans — two on the road (one on time, one
 * 9 minutes late), one 17 minutes late, one gone quiet, one leaving later,
 * one parked, one out of service — an SOS, and the day's exceptions.
 * Times are relative to `now`, so the "ago"s and ETAs read the same on
 * every run.
 */

const TZ = 'America/Chicago';
const at = (now: number, min: number) => new Date(now + min * 60_000).toISOString();

export function van(over: Partial<FleetVan> & { vanId: string; name: string }): FleetVan {
  return {
    plate: null,
    capacity: 12,
    state: 'idle',
    position: null,
    positionAgeMinutes: null,
    run: null,
    nextRun: null,
    ...over,
  };
}

export function runOf(now: number, over: Partial<NonNullable<FleetVan['run']>> & { runId: string }): NonNullable<FleetVan['run']> {
  return {
    direction: 'TO_WORK',
    departAt: at(now, -25),
    driverUserId: `d-${over.runId}`,
    driverName: 'Mike Chen',
    driverPhone: '+1 850-555-0101',
    onBoard: 3,
    toPickUp: 2,
    nextStop: { label: 'Gulf Pines', scheduledAt: at(now, 4), etaAt: at(now, 4) },
    lateMinutes: 0,
    ...over,
  };
}

export function exception(over: Partial<TransportException> & { id: string; kind: TransportException['kind'] }, now = Date.now()): TransportException {
  return {
    severity: 'medium',
    title: 'Something needs you',
    detail: 'One sentence about what fixes it.',
    at: at(now, -6),
    action: { label: 'Open run', kind: 'open_run' },
    ...over,
  };
}

export function kpi(over: Partial<TransportKpi> & { id: TransportKpi['id'] }): TransportKpi {
  return {
    label: 'On-time pickups',
    unit: 'pct',
    value: 92.4,
    compare: 89.1,
    delta: 3.3,
    betterWhen: 'up',
    status: 'good',
    statusLabel: 'On track',
    trend: [88, 90, 87, 91, 89, 90, 89.1, 92.4],
    definition: 'Pickups within 5 minutes of the scheduled time. Good at 90% or better; watch under 90%; bad under 80%.',
    ...over,
  };
}

export const KPIS: TransportKpi[] = [
  kpi({ id: 'onTime' }),
  kpi({
    id: 'utilization',
    label: 'Seat use',
    value: 71.8,
    compare: 74,
    delta: -2.2,
    status: 'watch',
    statusLabel: 'Watch',
    trend: [70, 72, 75, 74, 73, 76, 74, 71.8],
    definition: 'Riders carried over seats driven, across every run that left. Good at 75% or better; watch from 60%.',
  }),
  kpi({
    id: 'costPerRide',
    label: 'Cost per ride',
    unit: 'money',
    value: 14.2,
    compare: 15.05,
    delta: -0.85,
    betterWhen: 'down',
    status: 'good',
    statusLabel: 'Under target',
    trend: [16.1, 15.8, 15.4, 15.9, 15.2, 15.3, 15.05, 14.2],
    definition: 'Fuel, driver hours and van costs over the rides completed. Good under $15.',
  }),
  kpi({
    id: 'noShowRate',
    label: 'No-show rate',
    value: 4,
    compare: 4,
    delta: 0,
    betterWhen: 'down',
    status: 'watch',
    statusLabel: 'Watch',
    trend: [3, 5, 4, 6, 4, 3, 4, 4],
    definition: 'Riders marked no-show over rides due. Good under 3%; watch from 3%; bad from 8%.',
  }),
];

export function busyMorning(now = Date.now()): TransportOpsBoard {
  const vans: FleetVan[] = [
    van({
      vanId: 'v1',
      name: 'Van 1',
      plate: 'ALT 101',
      state: 'on_road',
      position: { lat: 30.2361, lng: -85.9078, heading: 80, at: at(now, -0.3) },
      positionAgeMinutes: 0,
      run: runOf(now, { runId: 'run1', driverName: 'Mike Chen', onBoard: 4, toPickUp: 1, nextStop: { label: 'Gulf Pines', scheduledAt: at(now, 5), etaAt: at(now, 5) } }),
    }),
    van({
      vanId: 'v2',
      name: 'Van 2',
      plate: 'ALT 102',
      state: 'on_road',
      position: { lat: 30.2012, lng: -85.8601, heading: 135, at: at(now, -0.2) },
      positionAgeMinutes: 0,
      run: runOf(now, {
        runId: 'run2',
        driverName: 'Rosa Diaz',
        driverPhone: '+1 850-555-0102',
        onBoard: 6,
        toPickUp: 2,
        lateMinutes: 9,
        nextStop: { label: 'Seaside Housing', scheduledAt: at(now, -3), etaAt: at(now, 6) },
      }),
    }),
    van({
      vanId: 'v3',
      name: 'Van 3',
      plate: 'ALT 103',
      state: 'on_road',
      position: { lat: 30.1903, lng: -85.8212, heading: 270, at: at(now, -0.5) },
      positionAgeMinutes: 0,
      run: runOf(now, {
        runId: 'run3',
        driverName: 'Andre Baptiste',
        driverPhone: '+1 850-555-0103',
        onBoard: 0,
        toPickUp: 5,
        lateMinutes: 17,
        nextStop: { label: 'Bay Point Apartments', scheduledAt: at(now, -12), etaAt: at(now, 5) },
      }),
    }),
    van({
      vanId: 'v4',
      name: 'Van 4',
      plate: 'ALT 104',
      state: 'no_signal',
      position: { lat: 30.2201, lng: -85.8803, heading: null, at: at(now, -6) },
      positionAgeMinutes: 6,
      run: runOf(now, { runId: 'run4', driverName: 'Tom Price', driverPhone: '+1 850-555-0104', onBoard: 2, toPickUp: 0, nextStop: { label: 'Front Beach 218', scheduledAt: at(now, 8), etaAt: null } }),
    }),
    van({
      vanId: 'v5',
      name: 'Van 5',
      plate: 'ALT 105',
      state: 'planned',
      position: { lat: 30.1766, lng: -85.8055, heading: null, at: at(now, -600) },
      positionAgeMinutes: 600,
      nextRun: { runId: 'run5', departAt: at(now, 95), driverName: 'Mike Chen', riders: 8 },
    }),
    van({
      vanId: 'v6',
      name: 'Van 6',
      plate: 'ALT 106',
      state: 'idle',
      position: { lat: 30.1766, lng: -85.8055, heading: null, at: at(now, -180) },
      positionAgeMinutes: 180,
    }),
    van({ vanId: 'v7', name: 'Van 7', plate: 'ALT 107', state: 'out_of_service' }),
  ];
  const exceptions: TransportException[] = [
    exception(
      {
        id: 'sos-run3',
        kind: 'sos',
        severity: 'high',
        title: 'SOS — Andre Baptiste in Van 3',
        detail: '“Flat tire on Back Beach Rd.” Call him, then send help.',
        at: at(now, -2),
        runId: 'run3',
        vanId: 'v3',
        driverUserId: 'd-run3',
        action: { label: 'I’m on it', kind: 'ack_sos' },
      },
      now,
    ),
    exception({ id: 'late-run3', kind: 'late', severity: 'high', title: 'Van 3 is 17 minutes late at Bay Point Apartments', detail: 'Five riders are waiting. Message them or send another van.', at: at(now, -12), runId: 'run3', vanId: 'v3', action: { label: 'Open run', kind: 'open_run' } }, now),
    exception({ id: 'nosig-run4', kind: 'stalled', severity: 'high', title: 'Van 4 has had no signal for 6 minutes', detail: 'Its phone stopped reporting. Call Tom to check in.', at: at(now, -6), runId: 'run4', vanId: 'v4', driverUserId: 'd-run4', action: { label: 'Call driver', kind: 'call_driver' } }, now),
    exception({ id: 'late-run2', kind: 'late', severity: 'medium', title: 'Van 2 is 9 minutes late at Seaside Housing', detail: 'Two riders are waiting at the stop.', at: at(now, -3), runId: 'run2', vanId: 'v2', action: { label: 'Open run', kind: 'open_run' } }, now),
    exception({ id: 'needs-van', kind: 'needs_van', severity: 'medium', title: '3 riders booked for today have no van', detail: 'They ride to Front Beach 218 at 1:00 PM. Put them on a run.', at: at(now, -40), rideIds: ['r1', 'r2', 'r3'], action: { label: 'Assign a van', kind: 'assign_van' } }, now),
    exception({ id: 'cred-d9', kind: 'credential_lapsed', severity: 'medium', title: 'Mike Chen’s DOT card lapsed 2 days ago', detail: 'He drives at 2:10 PM. Renew it or swap the driver.', at: at(now, -90), driverUserId: 'd9', action: { label: 'Open drivers', kind: 'open_setup', target: 'drivers' } }, now),
    exception({ id: 'issue-17', kind: 'open_issue', severity: 'low', title: 'Issue 17: “Van was late twice this week”', detail: 'Maria Lopez reported it this morning.', at: at(now, -150), action: { label: 'Open issue', kind: 'open_issue', target: 'iss-17' } }, now),
  ];
  return {
    date: new Date(now).toISOString().slice(0, 10),
    timezone: TZ,
    generatedAt: new Date(now).toISOString(),
    vans,
    exceptions,
    kpis: KPIS,
    center: { lat: 30.1766, lng: -85.8055 },
  };
}

/** The live board's runs for the same morning — the routes' stops. */
export function busyLiveRuns(now = Date.now()): RunMap[] {
  const base = (runId: string, vanId: string, name: string, pos: { lat: number; lng: number }, stops: Array<{ lat: number; lng: number; label: string; kind?: 'pickup' | 'store' }>, over: Partial<RunMap> = {}): RunMap => ({
    runId,
    status: 'ACTIVE',
    direction: 'TO_WORK',
    serviceDate: new Date(now).toISOString().slice(0, 10),
    departAt: at(now, -25),
    timezone: TZ,
    van: { id: vanId, name, plate: null, capacity: 12 },
    driver: { userId: `d-${runId}`, name: 'Driver' },
    position: { ...pos, heading: 90, speedMps: 10, at: at(now, 0) },
    stale: false,
    trail: [[pos.lng - 0.01, pos.lat - 0.004], [pos.lng, pos.lat]],
    waypoints: stops.map((s, i) => ({ kind: s.kind ?? 'pickup', point: { lat: s.lat, lng: s.lng }, etaAt: at(now, 5 + i * 6), label: s.label, rideIds: [`${runId}-r${i}`] })),
    stores: [],
    late: [],
    riders: [],
    ...over,
  });
  const store = { lat: 30.1766, lng: -85.8055, label: 'Front Beach 218', kind: 'store' as const };
  return [
    base('run1', 'v1', 'Van 1', { lat: 30.2361, lng: -85.9078 }, [{ lat: 30.2281, lng: -85.8911, label: 'Gulf Pines' }, store]),
    base('run2', 'v2', 'Van 2', { lat: 30.2012, lng: -85.8601 }, [{ lat: 30.2061, lng: -85.8452, label: 'Seaside Housing' }, { lat: 30.1952, lng: -85.8302, label: 'Lagoon Court' }, store]),
    base('run3', 'v3', 'Van 3', { lat: 30.1903, lng: -85.8212 }, [{ lat: 30.2113, lng: -85.8711, label: 'Bay Point Apartments' }, store]),
    base('run4', 'v4', 'Van 4', { lat: 30.2201, lng: -85.8803 }, [store], { stale: true }),
  ];
}
