import type { TransportKpi, TransportKpiId } from '@alto-people/shared';
import { prisma } from '../db.js';
import { driverHourlyRates, runDriverCents } from './transportCosts.js';

/**
 * The dispatcher's four numbers (transport upgrade 2026-10-28) — the last
 * 7 days against the 7 before, each with eight complete weeks behind it
 * (Saturday to Friday, the org week the trends tab and payroll use):
 *
 *   onTime       pickups the van reached within 5 minutes of the planned
 *                time ÷ pickups with both times — the trends tab's own
 *                definition (Arrived, else the boarding tap)
 *   utilization  riders carried ÷ seats offered, on runs that finished
 *   costPerRide  what the vans cost (lib/transportCosts: driver hours at
 *                each driver's rate + fuel and upkeep from the service
 *                log) ÷ rides completed
 *   noShowRate   no-shows ÷ (rides completed + no-shows)
 *
 * Percentages are 0–100 with one decimal; money is dollars to the cent.
 */

const ON_TIME_GRACE_MS = 5 * 60_000;

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The Saturday that starts the org week a day falls in (routes/transportOps orgWeekStartOf). */
const weekStartOf = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
};

interface Tally {
  timed: number;
  onTime: number;
  carried: number;
  seats: number;
  completed: number;
  noShows: number;
  costCents: number;
}
const empty = (): Tally => ({ timed: 0, onTime: 0, carried: 0, seats: 0, completed: 0, noShows: 0, costCents: 0 });
const add = (a: Tally, b: Tally): Tally => ({
  timed: a.timed + b.timed,
  onTime: a.onTime + b.onTime,
  carried: a.carried + b.carried,
  seats: a.seats + b.seats,
  completed: a.completed + b.completed,
  noShows: a.noShows + b.noShows,
  costCents: a.costCents + b.costCents,
});

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const round2 = (n: number) => Math.round(n * 100) / 100;

function measure(id: TransportKpiId, t: Tally): number | null {
  switch (id) {
    case 'onTime':
      return pct(t.onTime, t.timed);
    case 'utilization':
      return pct(t.carried, t.seats);
    case 'costPerRide':
      return t.completed > 0 ? round2(t.costCents / 100 / t.completed) : null;
    case 'noShowRate':
      return pct(t.noShows, t.completed + t.noShows);
  }
}

const SPEC: Record<TransportKpiId, { label: string; unit: 'pct' | 'money'; betterWhen: 'up' | 'down'; definition: string }> = {
  onTime: {
    label: 'On-time pickups',
    unit: 'pct',
    betterWhen: 'up',
    definition: 'Pickups the van reached (Arrived, or the rider boarded) within 5 minutes of the planned time, of all pickups with both times. 95% or better is good; 85% is the line to watch.',
  },
  utilization: {
    label: 'Seats filled',
    unit: 'pct',
    betterWhen: 'up',
    definition: 'Riders carried ÷ seats offered, on runs that finished. 60% or more is good; under 40% means too many vans for the riders.',
  },
  costPerRide: {
    label: 'Cost per ride',
    unit: 'money',
    betterWhen: 'down',
    definition: 'Driver hours at each driver’s rate plus fuel and upkeep from the service log, ÷ rides completed — the same cost as the Costs tab. Judged against the week before: 10% higher is worth a look, 25% higher is a problem.',
  },
  noShowRate: {
    label: 'No-shows',
    unit: 'pct',
    betterWhen: 'down',
    definition: 'Riders marked no-show ÷ (rides completed + no-shows). 3% or less is good; over 8% needs a word with riders.',
  },
};

/** A KPI's status and its words. Exported for the tests. */
export function judgeKpi(id: TransportKpiId, value: number | null, compare: number | null): { status: TransportKpi['status']; statusLabel: string } {
  if (value === null) return { status: 'none', statusLabel: 'No rides yet' };
  if (id === 'onTime') return value >= 95 ? { status: 'good', statusLabel: 'On target' } : value >= 85 ? { status: 'watch', statusLabel: 'Watch' } : { status: 'bad', statusLabel: 'Below target' };
  if (id === 'utilization') return value >= 60 ? { status: 'good', statusLabel: 'Healthy' } : value >= 40 ? { status: 'watch', statusLabel: 'Watch' } : { status: 'bad', statusLabel: 'Too many empty seats' };
  if (id === 'noShowRate') return value <= 3 ? { status: 'good', statusLabel: 'Healthy' } : value <= 8 ? { status: 'watch', statusLabel: 'Watch' } : { status: 'bad', statusLabel: 'Too many no-shows' };
  // Cost per ride has no fixed line: the week before is the yardstick.
  if (compare === null || compare <= 0) return { status: 'none', statusLabel: 'Nothing to compare yet' };
  const change = (value - compare) / compare;
  if (change > 0.25) return { status: 'bad', statusLabel: `Up ${Math.round(change * 100)}% on the week before` };
  if (change > 0.1) return { status: 'watch', statusLabel: `Up ${Math.round(change * 100)}% on the week before` };
  // Within the band a rise is still named: "Steady" beside a red +$0.50 reads as a contradiction.
  if (change > 0.005) return { status: 'good', statusLabel: `Up ${Math.round(change * 100)}% on the week before` };
  return { status: 'good', statusLabel: change < -0.005 ? `Down ${Math.round(-change * 100)}% on the week before` : 'Steady' };
}

/** The four KPIs for the 7 days ending `date` (YYYY-MM-DD, the company calendar). */
export async function transportKpis(date: string): Promise<TransportKpi[]> {
  const curFrom = addDays(date, -6);
  const prevFrom = addDays(date, -13);
  const prevTo = addDays(date, -7);
  const thisWeek = weekStartOf(date);
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(thisWeek, (i - 8) * 7));
  const from = weeks[0]! < prevFrom ? weeks[0]! : prevFrom;
  const to = date;
  const [rides, runs, service] = await Promise.all([
    prisma.ride.findMany({
      where: { serviceDate: { gte: from, lte: to }, status: { in: ['BOARDED', 'COMPLETED', 'NO_SHOW'] } },
      select: { serviceDate: true, status: true, pickupAt: true, vanArrivedAt: true, boardedAt: true },
    }),
    prisma.rideRun.findMany({
      where: { serviceDate: { gte: from, lte: to }, status: 'COMPLETED' },
      select: { serviceDate: true, driverUserId: true, startedAt: true, endedAt: true, van: { select: { capacity: true } }, _count: { select: { rides: { where: { status: 'COMPLETED' } } } } },
    }),
    prisma.vanServiceEntry.findMany({
      where: { occurredAt: { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${addDays(to, 1)}T00:00:00Z`) } },
      select: { occurredAt: true, costCents: true },
    }),
  ]);
  const rates = await driverHourlyRates(runs.map((r) => r.driverUserId));
  const days = new Map<string, Tally>();
  const day = (ymd: string) => {
    let t = days.get(ymd);
    if (!t) days.set(ymd, (t = empty()));
    return t;
  };
  for (const r of rides) {
    const t = day(r.serviceDate);
    if (r.status === 'NO_SHOW') t.noShows += 1;
    if (r.status === 'COMPLETED') t.completed += 1;
    const reached = r.vanArrivedAt ?? r.boardedAt;
    if (r.status !== 'NO_SHOW' && r.pickupAt && reached) {
      t.timed += 1;
      if (reached.getTime() <= r.pickupAt.getTime() + ON_TIME_GRACE_MS) t.onTime += 1;
    }
  }
  for (const run of runs) {
    const t = day(run.serviceDate);
    t.carried += run._count.rides;
    t.seats += run.van.capacity;
    t.costCents += runDriverCents(run, rates);
  }
  for (const s of service) day(s.occurredAt.toISOString().slice(0, 10)).costCents += s.costCents;

  const sum = (a: string, b: string) => {
    let t = empty();
    for (const [k, v] of days) if (k >= a && k <= b) t = add(t, v);
    return t;
  };
  const cur = sum(curFrom, date);
  const prev = sum(prevFrom, prevTo);
  const weekly = weeks.map((w) => sum(w, addDays(w, 6)));
  return (Object.keys(SPEC) as TransportKpiId[]).map((id) => {
    const value = measure(id, cur);
    const compare = measure(id, prev);
    const spec = SPEC[id];
    return {
      id,
      label: spec.label,
      unit: spec.unit,
      value,
      compare,
      delta: value !== null && compare !== null ? round2(value - compare) : null,
      betterWhen: spec.betterWhen,
      ...judgeKpi(id, value, compare),
      trend: weekly.map((w) => measure(id, w)),
      definition: spec.definition,
    };
  });
}
