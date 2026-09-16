/**
 * Group a day's roster into shift waves — the way a store manager reads
 * a day: the 6a–2p crew, the 2p–10p crew, overnight. A wave is every
 * shift sharing the same start and end instant, ordered by start.
 *
 * States come from the punch record (the /client-portal/day route):
 *   on-floor     clocked in right now (today only)
 *   worked       punched in, shift over (or clocked out)
 *   missed       shift over, no punch — or a no-call no-show stamped
 *   not-in       shift under way, no punch yet
 *   confirmed / unconfirmed   shift hasn't started
 *   open         an unfilled slot
 */

export type DayState =
  | 'open'
  | 'on-floor'
  | 'worked'
  | 'missed'
  | 'not-in'
  | 'confirmed'
  | 'unconfirmed';

export interface WaveRow {
  shiftId: string;
  associateId: string | null;
  name: string | null;
  position: string;
  isLead: boolean;
  clockInAt: string | null;
  clockOutAt: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  state: DayState;
}

export type WavePhase = 'upcoming' | 'live' | 'finished';

export interface Wave {
  key: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  phase: WavePhase;
  /** Assigned people (open slots excluded). */
  expected: number;
  /** On the floor right now. */
  clockedIn: WaveRow[];
  /** Punched in and done (past waves) — in/out on the row. */
  worked: WaveRow[];
  /** Expected, no punch: under way (not-in) or over (missed). */
  notIn: WaveRow[];
  /** Assigned, wave hasn't started yet. */
  upcoming: WaveRow[];
  /** Unfilled slots. */
  open: WaveRow[];
}

export function groupWaves(rows: WaveRow[], now: Date = new Date()): Wave[] {
  const byKey = new Map<string, Wave>();
  const nowMs = now.getTime();
  for (const r of rows) {
    const key = `${r.startsAt}|${r.endsAt}`;
    let w = byKey.get(key);
    if (!w) {
      const start = new Date(r.startsAt).getTime();
      const end = new Date(r.endsAt).getTime();
      w = {
        key,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        timezone: r.timezone,
        phase: nowMs < start ? 'upcoming' : nowMs >= end ? 'finished' : 'live',
        expected: 0,
        clockedIn: [],
        worked: [],
        notIn: [],
        upcoming: [],
        open: [],
      };
      byKey.set(key, w);
    }
    switch (r.state) {
      case 'open':
        w.open.push(r);
        break;
      case 'on-floor':
        w.expected += 1;
        w.clockedIn.push(r);
        break;
      case 'worked':
        w.expected += 1;
        w.worked.push(r);
        break;
      case 'missed':
      case 'not-in':
        w.expected += 1;
        w.notIn.push(r);
        break;
      case 'confirmed':
      case 'unconfirmed':
        w.expected += 1;
        w.upcoming.push(r);
        break;
    }
  }
  const waves = [...byKey.values()].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const byName = (a: WaveRow, b: WaveRow) => (a.name ?? '').localeCompare(b.name ?? '');
  const byPunch = (a: WaveRow, b: WaveRow) =>
    (a.clockInAt ?? '').localeCompare(b.clockInAt ?? '') || byName(a, b);
  for (const w of waves) {
    w.clockedIn.sort(byPunch);
    w.worked.sort(byPunch);
    w.notIn.sort(byName);
    w.upcoming.sort(byName);
  }
  return waves;
}

/** People on the floor for the wave, past or present. */
export function wavePresent(w: Wave): number {
  return w.clockedIn.length + w.worked.length;
}
