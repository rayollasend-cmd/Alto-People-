/**
 * Group today's roster into shift waves — the way a store manager reads
 * a day: the 6a–2p crew, the 2p–10p crew, overnight. A wave is every
 * shift sharing the same start and end instant, ordered by start.
 */

export interface WaveRow {
  shiftId: string;
  associateId: string | null;
  name: string | null;
  position: string;
  isLead: boolean;
  clockInAt: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
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
  /** Clocked in right now. */
  clockedIn: WaveRow[];
  /** Assigned, wave is live or finished, no punch on record right now. */
  notIn: WaveRow[];
  /** Assigned, wave hasn't started yet. */
  upcoming: WaveRow[];
  /** Finished the shift (or still clocked in past the end). */
  worked: number;
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
        notIn: [],
        upcoming: [],
        worked: 0,
        open: [],
      };
      byKey.set(key, w);
    }
    if (r.state === 'open') {
      w.open.push(r);
      continue;
    }
    w.expected += 1;
    if (r.state === 'on-floor') {
      w.clockedIn.push(r);
      w.worked += 1;
    } else if (r.state === 'done') {
      w.worked += 1;
    } else if (w.phase === 'upcoming') {
      w.upcoming.push(r);
    } else {
      w.notIn.push(r);
    }
  }
  const waves = [...byKey.values()].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  for (const w of waves) {
    const byName = (a: WaveRow, b: WaveRow) => (a.name ?? '').localeCompare(b.name ?? '');
    w.clockedIn.sort((a, b) => (a.clockInAt ?? '').localeCompare(b.clockInAt ?? '') || byName(a, b));
    w.notIn.sort(byName);
    w.upcoming.sort(byName);
  }
  return waves;
}
