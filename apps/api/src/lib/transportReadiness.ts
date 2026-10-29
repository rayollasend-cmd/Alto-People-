import type { TransportReadiness, TransportReadinessItem } from '@alto-people/shared';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import { dateKeyInZone } from './timeAnomalies.js';
import { fmtDay } from './humanDates.js';
import { conflictPairs } from './transportConflicts.js';
import { DRIVER_POSITION, RUN_SPAN_MS, credentialsEnforced, dayBounds, driverCredentialStatus, hosSettings, runBusyWindow } from './transportDrivers.js';

/**
 * Is tomorrow ready? (transport upgrade 2026-10-28) — GET
 * /transport/readiness: six checks the desk runs in its head before going
 * home, each ok or not with how many things are wrong, one sentence, and
 * where to fix it:
 *
 *   riders_placed       every booked ride is on a run
 *   seats               no run carries more riders than its van seats
 *   drivers_assigned_ok no driver on two runs at once, none over the day's
 *                       hours, every one rested since yesterday (transport
 *                       settings: driverMaxHoursPerDay / driverMinRestHours)
 *   credentials         every assigned driver's licence, DOT card and
 *                       training current on the day
 *   vans_ready          every van with a run in service, its registration,
 *                       insurance and inspection current on the day
 *   vans_double_booked  no van on two runs at once
 *
 * The same rules dispatch enforces (lib/transportDrivers, lib/transportConflicts);
 * this only reads.
 */

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtTime = (d: Date, tz = DEFAULT_TIMEZONE) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
const nameOf = (u: { email: string; associate: { firstName: string; lastName: string } | null }) =>
  u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : (u.email.split('@')[0] ?? u.email);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const more = (n: number, one: string, many = `${one}s`) => (n > 0 ? ` ${plural(n, `more ${one}`, `more ${many}`)} too.` : '');

/** Tomorrow in the company calendar. */
export function tomorrowKey(now = new Date()): string {
  return addDays(dateKeyInZone(now, DEFAULT_TIMEZONE), 1);
}

export async function computeReadiness(date: string): Promise<TransportReadiness> {
  const prev = addDays(date, -1);
  const { from: dayFrom, to: dayTo } = dayBounds(date);
  const onDay = new Date(`${date}T12:00:00Z`);
  const [rides, runs, settings, enforced] = await Promise.all([
    prisma.ride.findMany({ where: { serviceDate: date, status: { not: 'CANCELLED' } }, select: { id: true, status: true, runId: true } }),
    prisma.rideRun.findMany({
      where: { serviceDate: date, status: { not: 'CANCELLED' } },
      orderBy: { departAt: 'asc' },
      select: {
        id: true,
        vanId: true,
        driverUserId: true,
        status: true,
        departAt: true,
        startedAt: true,
        endedAt: true,
        van: { select: { name: true, capacity: true, outOfServiceAt: true, outOfServiceReason: true, registrationExpiresAt: true, insuranceExpiresAt: true, inspectionDueAt: true } },
        driver: { select: { id: true, email: true, associateId: true, associate: { select: { firstName: true, lastName: true } } } },
        rides: { where: { status: { not: 'CANCELLED' } }, select: { id: true, location: { select: { timezone: true } } } },
      },
    }),
    hosSettings(),
    credentialsEnforced(),
  ]);
  const driverIds = [...new Set(runs.map((r) => r.driverUserId))];
  const assocIds = [...new Set(runs.map((r) => r.driver.associateId).filter((x): x is string => !!x))];
  const [profiles, yesterday, shifts] = await Promise.all([
    driverIds.length ? prisma.driverProfile.findMany({ where: { userId: { in: driverIds } } }) : Promise.resolve([]),
    driverIds.length
      ? prisma.rideRun.findMany({
          where: { serviceDate: prev, status: { not: 'CANCELLED' }, driverUserId: { in: driverIds } },
          select: { driverUserId: true, departAt: true, startedAt: true, endedAt: true },
        })
      : Promise.resolve([]),
    assocIds.length
      ? prisma.shift.findMany({
          where: { position: DRIVER_POSITION, assignedAssociateId: { in: assocIds }, status: { not: 'CANCELLED' }, startsAt: { lt: dayTo }, endsAt: { gt: dayFrom } },
          select: { assignedAssociateId: true, startsAt: true, endsAt: true },
        })
      : Promise.resolve([]),
  ]);
  const tzOf = (r: (typeof runs)[number]) => r.rides[0]?.location.timezone ?? DEFAULT_TIMEZONE;
  const pairs = conflictPairs(runs);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const items: TransportReadinessItem[] = [];

  /* 1. Every booked rider on a van. */
  const unplaced = rides.filter((r) => r.status === 'REQUESTED' && !r.runId).length;
  items.push({
    id: 'riders_placed',
    label: 'Every rider has a van',
    ok: unplaced === 0,
    count: unplaced,
    detail: unplaced === 0 ? 'Every booked rider has a van.' : `${plural(unplaced, 'rider')} ${unplaced === 1 ? 'has' : 'have'} no van yet.`,
    action: unplaced === 0 ? null : { label: 'Plan the vans', kind: 'plan', target: date },
  });

  /* 2. Seats. */
  const over = runs.filter((r) => r.rides.length > r.van.capacity);
  const o = over[0];
  items.push({
    id: 'seats',
    label: 'No van over its seats',
    ok: over.length === 0,
    count: over.length,
    detail: !o ? 'No van is booked past its seats.' : `${o.van.name}'s ${fmtTime(o.departAt, tzOf(o))} run has ${plural(o.rides.length, 'rider')} for ${plural(o.van.capacity, 'seat')}.${more(over.length - 1, 'run')}`,
    action: o ? { label: 'Open the run', kind: 'open_board', target: o.id } : null,
  });

  /* 3. Drivers: free for each run, under the day's hours, rested. */
  const driverProblems = new Map<string, string>();
  for (const p of pairs.filter((x) => x.kind === 'driver')) {
    const a = runById.get(p.a)!;
    const b = runById.get(p.b)!;
    if (!driverProblems.has(a.driverUserId)) {
      driverProblems.set(a.driverUserId, `${nameOf(a.driver)} is on two runs at once — ${fmtTime(a.departAt, tzOf(a))} and ${fmtTime(b.departAt, tzOf(b))}.`);
    }
  }
  for (const id of driverIds) {
    if (driverProblems.has(id)) continue;
    const mine = runs.filter((r) => r.driverUserId === id);
    const who = mine[0]!.driver;
    const myShifts = shifts.filter((s) => s.assignedAssociateId === who.associateId);
    // Shifts bound the day when they exist; otherwise the runs do (assertDriverFit's rule).
    const clip = (a: Date, b: Date) => Math.max(0, Math.min(b.getTime(), dayTo.getTime()) - Math.max(a.getTime(), dayFrom.getTime()));
    const shiftMs = myShifts.reduce((t, s) => t + clip(s.startsAt, s.endsAt), 0);
    const runMs = mine.reduce((t, r) => {
      const start = r.startedAt ?? r.departAt;
      return t + ((r.endedAt ?? new Date(start.getTime() + RUN_SPAN_MS)).getTime() - start.getTime());
    }, 0);
    const hours = (shiftMs > 0 ? shiftMs : runMs) / 3_600_000;
    if (hours > settings.driverMaxHoursPerDay + 1e-9) {
      driverProblems.set(id, `${nameOf(who)} is down for ${hours.toFixed(1)} hours — the most is ${settings.driverMaxHoursPerDay}.`);
      continue;
    }
    const lastEnd = Math.max(0, ...yesterday.filter((r) => r.driverUserId === id).map((r) => runBusyWindow(r).to));
    const firstStart = Math.min(...mine.map((r) => r.departAt.getTime()));
    if (lastEnd > 0 && firstStart - lastEnd < settings.driverMinRestHours * 3_600_000) {
      const rest = Math.max(0, (firstStart - lastEnd) / 3_600_000);
      driverProblems.set(id, `${nameOf(who)} gets ${rest.toFixed(1)} hours' rest before the first run — the least is ${settings.driverMinRestHours}.`);
    }
  }
  const dp = [...driverProblems.values()];
  items.push({
    id: 'drivers_assigned_ok',
    label: 'Drivers free, rested, under hours',
    ok: dp.length === 0,
    count: dp.length,
    detail: dp.length === 0 ? `Every driver is free for each run, under ${settings.driverMaxHoursPerDay} hours, with ${settings.driverMinRestHours} hours' rest.` : `${dp[0]}${more(dp.length - 1, 'driver')}`,
    action: dp.length === 0 ? null : { label: 'Open the board', kind: 'open_board' },
  });

  /* 4. Drivers' papers, as of the day. */
  const credProblems: string[] = [];
  for (const id of driverIds) {
    const profile = profiles.find((p) => p.userId === id) ?? null;
    if (!profile && !enforced) continue;
    const cred = driverCredentialStatus(profile, onDay);
    if (cred.ok) continue;
    const who = nameOf(runs.find((r) => r.driverUserId === id)!.driver);
    const p = cred.problems[0]!;
    const what = p.key === 'dot' ? 'DOT medical card' : p.label.charAt(0).toLowerCase() + p.label.slice(1);
    credProblems.push(p.expired && p.expiresAt ? `${who}'s ${what} lapsed ${fmtDay(p.expiresAt)}.` : `${who} has no ${what} on file.`);
  }
  items.push({
    id: 'credentials',
    label: "Drivers' papers current",
    ok: credProblems.length === 0,
    count: credProblems.length,
    detail: credProblems.length === 0 ? "Every driver's papers are current." : `${credProblems[0]}${more(credProblems.length - 1, 'driver')}`,
    action: credProblems.length === 0 ? null : { label: 'Open Drivers', kind: 'open_setup_drivers' },
  });

  /* 5. Vans in service with their papers current. */
  const vanProblems: string[] = [];
  for (const vanId of [...new Set(runs.map((r) => r.vanId))]) {
    const v = runs.find((r) => r.vanId === vanId)!.van;
    if (v.outOfServiceAt) {
      vanProblems.push(`${v.name} is out of service${v.outOfServiceReason ? ` — ${v.outOfServiceReason.replace(/\.$/, '')}` : ''}.`);
      continue;
    }
    const lapsed = (
      [
        ['registration', v.registrationExpiresAt],
        ['insurance', v.insuranceExpiresAt],
        ['inspection', v.inspectionDueAt],
      ] as const
    ).find(([, at]) => at && ymd(at) < date);
    if (lapsed) vanProblems.push(`${v.name}'s ${lapsed[0]} ${lapsed[0] === 'inspection' ? 'was due' : 'lapsed'} ${fmtDay(ymd(lapsed[1]!))}.`);
  }
  items.push({
    id: 'vans_ready',
    label: 'Vans ready',
    ok: vanProblems.length === 0,
    count: vanProblems.length,
    detail: vanProblems.length === 0 ? 'Every van with a run is in service with its papers current.' : `${vanProblems[0]}${more(vanProblems.length - 1, 'van')}`,
    action: vanProblems.length === 0 ? null : { label: 'Open Vans', kind: 'open_setup_vans' },
  });

  /* 6. No van on two runs at once. */
  const vanPairs = pairs.filter((x) => x.kind === 'van');
  const vp = vanPairs[0];
  const va = vp ? runById.get(vp.a)! : null;
  const vb = vp ? runById.get(vp.b)! : null;
  items.push({
    id: 'vans_double_booked',
    label: 'No van double-booked',
    ok: vanPairs.length === 0,
    count: vanPairs.length,
    detail: !va || !vb ? 'No van is on two runs at once.' : `${va.van.name} is on two runs at once — ${fmtTime(va.departAt, tzOf(va))} and ${fmtTime(vb.departAt, tzOf(vb))}.${more(vanPairs.length - 1, 'clash', 'clashes')}`,
    action: vb ? { label: 'Open the run', kind: 'open_board', target: vb.id } : null,
  });

  return {
    date,
    ready: items.every((i) => i.ok),
    items,
    riders: rides.length,
    runs: runs.length,
  };
}
