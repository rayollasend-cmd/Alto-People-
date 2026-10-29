import { runBusyWindow } from './transportDrivers.js';

/**
 * Double-bookings, the one rule (transport upgrade 2026-10-28).
 *
 * A run keeps its van and its driver busy from 15 minutes before it leaves
 * until it ends — or RUN_SPAN_MS (two hours) after it started, while it
 * hasn't (lib/transportDrivers runBusyWindow). Two runs that share a van or
 * a driver and whose windows overlap are double-booked. It is the web
 * Gantt's rule (components/transport/VanDayTimeline timelineBars) and the
 * one dispatch refuses (assertVanDriverFree), so the board's red bar, the
 * ops board's exception, readiness and every run's `conflicts` agree.
 *
 * Cancelled runs keep nobody busy.
 */

export interface ConflictRun {
  id: string;
  vanId: string;
  driverUserId: string;
  status: string;
  departAt: Date;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

export interface RunConflict {
  kind: 'driver' | 'van';
  /** The other run. */
  runId: string;
  overlapMinutes: number;
}

export interface ConflictPair {
  kind: 'driver' | 'van';
  /** The earlier-leaving run first. */
  a: string;
  b: string;
  overlapMinutes: number;
}

/** Every overlapping pair among `runs`, once each (a van pair and a driver pair are separate). */
export function conflictPairs(runs: ConflictRun[]): ConflictPair[] {
  const live = runs
    .filter((r) => r.status !== 'CANCELLED')
    .map((r) => ({ run: r, ...runBusyWindow(r) }))
    .sort((x, y) => x.run.departAt.getTime() - y.run.departAt.getTime() || x.run.id.localeCompare(y.run.id));
  const out: ConflictPair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const overlap = Math.min(a.to, b.to) - Math.max(a.from, b.from);
      if (overlap <= 0) continue;
      const minutes = Math.max(1, Math.round(overlap / 60_000));
      if (a.run.vanId === b.run.vanId) out.push({ kind: 'van', a: a.run.id, b: b.run.id, overlapMinutes: minutes });
      if (a.run.driverUserId === b.run.driverUserId) out.push({ kind: 'driver', a: a.run.id, b: b.run.id, overlapMinutes: minutes });
    }
  }
  return out;
}

/** Each run's conflicts, keyed by run id (a run with none maps to []). */
export function runConflicts(runs: ConflictRun[]): Map<string, RunConflict[]> {
  const out = new Map<string, RunConflict[]>(runs.map((r) => [r.id, []]));
  for (const p of conflictPairs(runs)) {
    out.get(p.a)?.push({ kind: p.kind, runId: p.b, overlapMinutes: p.overlapMinutes });
    out.get(p.b)?.push({ kind: p.kind, runId: p.a, overlapMinutes: p.overlapMinutes });
  }
  return out;
}

/**
 * A planned run that never started: the "didn't run" sweep
 * (lib/transportNotRun) closed it — CANCELLED, stamped autoClosedAt, never
 * started. A run the desk cancelled has no stamp; a stuck run the other
 * sweep closed is COMPLETED.
 */
export function isNotRun(run: { status: string; autoClosedAt?: Date | null; startedAt?: Date | null }): boolean {
  return run.status === 'CANCELLED' && !!run.autoClosedAt && !run.startedAt;
}
