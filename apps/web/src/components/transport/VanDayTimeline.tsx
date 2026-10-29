import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { fmtMinutes, fmtTimeTz } from '@/lib/format';
import type { Ride, RideRun, TransportBoard } from '@/lib/transportApi';

/**
 * Transport walk 6 — the day's vans against the hours.
 *
 * One row per van (and one for riders still waiting on a van), the hours
 * across. A run is a bar from when it leaves to RUN_SPAN after, labelled
 * seats taken / capacity; on the road it's green, planned gold, finished
 * quiet. Two runs that overlap on the same van (or the same driver, in
 * another row) draw red — the double-booking transport walk 1 refuses.
 * A group of riders still waiting is a dashed ghost at its target time on
 * the first van free then; clicking it opens Dispatch pre-set to that
 * van. Pure layout: everything comes from the board already loaded.
 */

/** How long a run keeps its van after it leaves (the same span the server plans with). */
export const RUN_SPAN_MS = 2 * 3_600_000;
const BUSY_LEAD_MS = 15 * 60_000;
const HALF_HOUR = 1_800_000;

export interface WaitingGroup {
  key: string;
  rides: Ride[];
  at: string;
  label: string;
}

export function groupWaitingRides(rides: Ride[]): WaitingGroup[] {
  const groups = new Map<string, WaitingGroup>();
  for (const r of rides) {
    if (r.status !== 'REQUESTED' || r.run) continue;
    const bucket = Math.floor(Date.parse(r.targetAt) / HALF_HOUR);
    const key = `${r.direction}|${r.store.id}|${bucket}`;
    const g = groups.get(key) ?? { key, rides: [], at: r.targetAt, label: `${r.direction === 'TO_WORK' ? 'To' : 'Home from'} ${r.store.name}` };
    g.rides.push(r);
    if (r.targetAt < g.at) g.at = r.targetAt;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export interface TimelineBar {
  runId: string;
  vanId: string;
  driverUserId: string;
  from: number;
  to: number;
  label: string;
  status: RideRun['status'];
  conflict: boolean;
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from < b.to && b.from < a.to;

/** Runs as bars, with the double-bookings flagged. Exported for tests. */
export function timelineBars(runs: RideRun[]): TimelineBar[] {
  const live = runs.filter((r) => r.status !== 'CANCELLED');
  const bars: TimelineBar[] = live.map((r) => {
    const depart = Date.parse(r.departAt);
    const start = r.startedAt ? Date.parse(r.startedAt) : depart;
    return {
      runId: r.id,
      vanId: r.van.id,
      driverUserId: r.driver.userId,
      from: depart - BUSY_LEAD_MS,
      to: r.endedAt ? Date.parse(r.endedAt) : start + RUN_SPAN_MS,
      label: `${r.seats.taken}/${r.seats.capacity}`,
      status: r.status,
      conflict: false,
    };
  });
  for (const a of bars) {
    for (const b of bars) {
      if (a === b) continue;
      if ((a.vanId === b.vanId || a.driverUserId === b.driverUserId) && overlaps(a, b)) {
        a.conflict = true;
        b.conflict = true;
      }
    }
  }
  return bars;
}

/** One overlap of a run with another: the same driver, the same van, or both. */
export interface RunConflict {
  kind: 'driver' | 'van' | 'both';
  runId: string;
  overlapMinutes: number;
}

/**
 * A run's double-bookings — the server's `conflicts` when it sends them,
 * otherwise the same rule the bars draw red by (one van or one driver on two
 * runs whose windows overlap). A driver AND van clash with one run is one line.
 */
export function runConflicts(run: RideRun, runs: RideRun[]): RunConflict[] {
  const merged = new Map<string, RunConflict>();
  const add = (kind: 'driver' | 'van', runId: string, overlapMinutes: number) => {
    const had = merged.get(runId);
    merged.set(runId, had ? { kind: had.kind === kind ? kind : 'both', runId, overlapMinutes: Math.max(had.overlapMinutes, overlapMinutes) } : { kind, runId, overlapMinutes });
  };
  if (run.conflicts) {
    for (const c of run.conflicts) add(c.kind, c.runId, c.overlapMinutes);
    return [...merged.values()];
  }
  const bars = timelineBars(runs);
  const me = bars.find((b) => b.runId === run.id);
  if (!me) return [];
  for (const b of bars) {
    if (b.runId === me.runId) continue;
    const overlap = Math.min(me.to, b.to) - Math.max(me.from, b.from);
    if (overlap <= 0) continue;
    const minutes = Math.max(1, Math.round(overlap / 60_000));
    if (b.driverUserId === me.driverUserId) add('driver', b.runId, minutes);
    if (b.vanId === me.vanId) add('van', b.runId, minutes);
  }
  return [...merged.values()];
}

const firstName = (name: string) => name.split(' ')[0] ?? name;

/**
 * The clash in words, naming the other run by its van and time:
 * "Mike is also on Van 1 at 2:10 PM — 25 min overlap".
 */
export function conflictWords(run: Pick<RideRun, 'van' | 'driver'>, c: RunConflict, other: Pick<RideRun, 'van' | 'driver' | 'departAt'> | undefined, tz?: string): string {
  const at = other ? fmtTimeTz(other.departAt, tz) : null;
  const overlap = `${fmtMinutes(c.overlapMinutes)} overlap`;
  const driver = firstName(run.driver.name);
  if (c.kind === 'both') return `${driver} and ${run.van.name} are also on the ${at ?? 'other'} run — ${overlap}`;
  if (c.kind === 'driver') return `${driver} is also on ${other ? `${other.van.name} at ${at}` : 'another run'} — ${overlap}`;
  return `${run.van.name} is also on ${other ? `${firstName(other.driver.name)}’s ${at} run` : 'another run'} — ${overlap}`;
}

/** The first van free at `at` for `riders` seats, in the board's order. */
export function firstFreeVan(vans: TransportBoard['vans'], bars: TimelineBar[], at: number, riders: number): string | null {
  const window = { from: at - RUN_SPAN_MS - BUSY_LEAD_MS, to: at + BUSY_LEAD_MS };
  const fits = vans.filter((v) => v.capacity >= riders);
  const free = (fits.length ? fits : vans).find((v) => !bars.some((b) => b.vanId === v.id && overlaps(b, window)));
  return free?.id ?? null;
}

export function VanDayTimeline({
  board,
  onDispatch,
  onRun,
}: {
  board: TransportBoard;
  /** A ghost was clicked: these riders, pre-set to this van. */
  onDispatch?: (rides: Ride[], vanId: string | null) => void;
  onRun?: (run: RideRun) => void;
}) {
  const bars = useMemo(() => timelineBars(board.runs), [board.runs]);
  const groups = useMemo(() => groupWaitingRides(board.rides), [board.rides]);
  const tz = board.rides[0]?.store.timezone ?? board.runs[0]?.rides[0]?.store.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (bars.length === 0 && groups.length === 0) return null;

  // Rows: every van the board offers, plus any van a run sits on that the
  // board no longer offers (parked since), plus the waiting row.
  const rows: Array<{ id: string; name: string }> = board.vans.map((v) => ({ id: v.id, name: v.name }));
  for (const r of board.runs) if (!rows.some((x) => x.id === r.van.id)) rows.push({ id: r.van.id, name: `${r.van.name} (off the road)` });
  const ghosts = groups.map((g) => {
    const at = Date.parse(g.at);
    const vanId = firstFreeVan(board.vans, bars, at, g.rides.length);
    return { ...g, atMs: at, vanId };
  });
  if (ghosts.some((g) => !g.vanId)) rows.push({ id: '', name: 'No van free' });

  const times = [...bars.flatMap((b) => [b.from, b.to]), ...ghosts.flatMap((g) => [g.atMs - 45 * 60_000, g.atMs + 30 * 60_000])];
  const start = Math.floor(Math.min(...times) / 3_600_000) * 3_600_000;
  const end = Math.ceil(Math.max(...times) / 3_600_000) * 3_600_000;
  const span = Math.max(end - start, 3_600_000);
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / span) * 100))}%`;
  const hours: number[] = [];
  for (let t = start; t <= end; t += 3_600_000) hours.push(t);
  const stepEvery = hours.length > 9 ? 2 : 1;
  const runById = new Map(board.runs.map((r) => [r.id, r]));

  return (
    <section aria-label="Vans by the hour" className="rounded-lg border border-navy-secondary bg-navy p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-2xs font-semibold uppercase tracking-wider text-silver">
        <span>Vans by the hour</span>
        <span className="flex items-center gap-3 normal-case tracking-normal">
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-gold/70" aria-hidden="true" /> planned</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-success/70" aria-hidden="true" /> on the road</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-alert/80" aria-hidden="true" /> double-booked</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm border border-dashed border-silver" aria-hidden="true" /> waiting</span>
        </span>
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: 'minmax(5rem, 8rem) 1fr' }}>
        <div />
        <div className="relative h-4 text-2xs tabular-nums text-silver">
          {hours.map((h, i) =>
            i % stepEvery === 0 ? (
              <span key={h} className="absolute -translate-x-1/2" style={{ left: x(h) }}>
                {fmtTimeTz(new Date(h).toISOString(), tz)}
              </span>
            ) : null,
          )}
        </div>
        {rows.map((row) => {
          const mine = bars.filter((b) => b.vanId === row.id);
          const ghostsHere = ghosts.filter((g) => (g.vanId ?? '') === row.id);
          return (
            <div key={row.id || 'none'} className="contents">
              <div className="truncate pr-2 text-xs text-ink" title={row.name}>
                {row.name}
              </div>
              <div className="relative h-7 rounded bg-navy-secondary/30">
                {hours.map((h) => (
                  <span key={h} className="absolute inset-y-0 border-l border-navy-secondary/60" style={{ left: x(h) }} aria-hidden="true" />
                ))}
                {mine.map((b) => {
                  const run = runById.get(b.runId);
                  // The same words the run's card carries: who else, when, how long.
                  const clash = b.conflict && run ? runConflicts(run, board.runs).map((c) => conflictWords(run, c, runById.get(c.runId), tz)).join('; ') : '';
                  return (
                    <button
                      key={b.runId}
                      type="button"
                      onClick={() => run && onRun?.(run)}
                      title={`${row.name} · leaves ${run ? fmtTimeTz(run.departAt, tz) : ''} · ${b.label} seats${b.conflict ? ` · double-booked: ${clash || 'overlaps another run'}` : ''}`}
                      aria-label={`${row.name} run leaving ${run ? fmtTimeTz(run.departAt, tz) : ''}, ${b.label} seats${b.conflict ? `, double-booked: ${clash || 'overlaps another run'}` : ''}`}
                      className={cn(
                        'absolute inset-y-0.5 flex items-center overflow-hidden rounded px-1.5 text-2xs font-semibold tabular-nums',
                        // Fills paired with their own ink tokens: 11px labels need 4.5:1 in both themes.
                        b.conflict ? 'bg-alert text-on-alert' : b.status === 'ACTIVE' ? 'bg-success/70 text-navy' : b.status === 'COMPLETED' ? 'bg-navy-secondary text-silver' : 'bg-accent-fill text-accent-on',
                      )}
                      style={{ left: x(b.from), width: `calc(${x(b.to)} - ${x(b.from)})` }}
                    >
                      {b.label}
                    </button>
                  );
                })}
                {ghostsHere.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => onDispatch?.(g.rides, g.vanId)}
                    title={`${g.label} · ${g.rides.length} waiting · ${fmtTimeTz(g.at, tz)}`}
                    aria-label={`Dispatch ${g.rides.length} waiting for ${g.label} at ${fmtTimeTz(g.at, tz)}${g.vanId ? ` on ${row.name}` : ''}`}
                    className="absolute inset-y-0.5 flex items-center rounded border border-dashed border-silver bg-navy/60 px-1.5 text-2xs tabular-nums text-silver hover:border-gold hover:text-ink"
                    style={{ left: x(g.atMs - 45 * 60_000), width: `calc(${x(g.atMs + 30 * 60_000)} - ${x(g.atMs - 45 * 60_000)})` }}
                  >
                    +{g.rides.length}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
