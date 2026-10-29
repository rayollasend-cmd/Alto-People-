import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VanDayTimeline, conflictWords, firstFreeVan, groupWaitingRides, runConflicts, timelineBars } from '@/components/transport/VanDayTimeline';
import { resolveTransportKey } from '@/lib/transportKeyboard';
import type { Ride, RideRun, TransportBoard } from '@/lib/transportApi';

/**
 * Transport walk 6 (vans against the hours) and 12 (the board's keys): the
 * timeline's bars, its double-booking flag, the ghost that opens Dispatch
 * on the first free van, and the key map.
 */

const tz = 'America/Chicago';
const T0 = Date.parse('2026-09-21T10:00:00Z');
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

function run(id: string, vanId: string, driverUserId: string, departMin: number, status: RideRun['status'] = 'PLANNED'): RideRun {
  return {
    id,
    direction: 'TO_WORK',
    serviceDate: '2026-09-21',
    departAt: iso(departMin),
    status,
    startedAt: null,
    endedAt: null,
    notes: null,
    van: { id: vanId, name: vanId === 'v1' ? 'Van 1' : 'Van 2', plate: null, capacity: 12 },
    driver: { userId: driverUserId, name: driverUserId },
    seats: { taken: 3, capacity: 12 },
    rides: [],
  };
}

function waiting(id: string, targetMin: number): Ride {
  return {
    id,
    direction: 'TO_WORK',
    targetAt: iso(targetMin),
    serviceDate: '2026-09-21',
    status: 'REQUESTED',
    store: { id: 'l1', name: 'Front Beach 218', timezone: tz, clientId: 'c1', clientName: 'Coastal' },
    rider: { associateId: `a-${id}`, name: id, phone: null },
    run: null,
  } as Ride;
}

const vans: TransportBoard['vans'] = [
  { id: 'v1', name: 'Van 1', plate: null, capacity: 12, driverUserId: 'mike' },
  { id: 'v2', name: 'Van 2', plate: null, capacity: 12, driverUserId: null },
];

describe('runConflicts + conflictWords — the clash in words', () => {
  const named = (r: RideRun, driver: string) => ({ ...r, driver: { userId: r.driver.userId, name: driver } });
  it('the same driver on another van: who, which van, when, how long', () => {
    const a = named(run('a', 'v1', 'mike', 0), 'Mike Chen');
    const b = named(run('b', 'v2', 'mike', 30), 'Mike Chen');
    const [c] = runConflicts(a, [a, b]);
    // a holds its van -15..+120 min, b +15..+150: 105 minutes together.
    expect(c).toEqual({ kind: 'driver', runId: 'b', overlapMinutes: 105 });
    expect(conflictWords(a, c!, b, tz)).toBe('Mike is also on Van 2 at 5:30 AM — 1h 45m overlap');
  });

  it('the same van with another driver names that driver’s run; both at once is one line', () => {
    const a = named(run('a', 'v1', 'mike', 0), 'Mike Chen');
    const b = named(run('b', 'v1', 'tasha', 60), 'Tasha Grant');
    expect(conflictWords(a, runConflicts(a, [a, b])[0]!, b, tz)).toBe('Van 1 is also on Tasha’s 6:00 AM run — 1h 15m overlap');
    const c = named(run('c', 'v1', 'mike', 100), 'Mike Chen');
    const both = runConflicts(a, [a, c]);
    expect(both).toEqual([{ kind: 'both', runId: 'c', overlapMinutes: 35 }]);
    expect(conflictWords(a, both[0]!, c, tz)).toBe('Mike and Van 1 are also on the 6:40 AM run — 35 min overlap');
  });

  it('takes the server’s conflicts when it sends them, and none for a run alone', () => {
    const a = { ...run('a', 'v1', 'mike', 0), conflicts: [{ kind: 'van' as const, runId: 'z', overlapMinutes: 12 }] };
    expect(runConflicts(a, [a])).toEqual([{ kind: 'van', runId: 'z', overlapMinutes: 12 }]);
    const lone = run('l', 'v1', 'mike', 0);
    expect(runConflicts(lone, [lone])).toEqual([]);
  });
});

describe('timelineBars', () => {
  it('flags two runs that overlap on the same van, or with the same driver', () => {
    const bars = timelineBars([run('a', 'v1', 'mike', 0), run('b', 'v1', 'tasha', 3), run('c', 'v2', 'sam', 400)]);
    expect(bars.find((b) => b.runId === 'a')!.conflict).toBe(true);
    expect(bars.find((b) => b.runId === 'b')!.conflict).toBe(true);
    expect(bars.find((b) => b.runId === 'c')!.conflict).toBe(false);
    const sameDriver = timelineBars([run('a', 'v1', 'mike', 0), run('b', 'v2', 'mike', 30)]);
    expect(sameDriver.every((b) => b.conflict)).toBe(true);
  });

  it('a called-off run takes no time', () => {
    expect(timelineBars([run('a', 'v1', 'mike', 0, 'CANCELLED')])).toEqual([]);
  });
});

describe('firstFreeVan', () => {
  it('skips the van already out then, and finds none when all are', () => {
    const bars = timelineBars([run('a', 'v1', 'mike', 0)]);
    // Riders due at the store 60 minutes in: Van 1 is still on its run.
    expect(firstFreeVan(vans, bars, T0 + 60 * 60_000, 5)).toBe('v2');
    const both = timelineBars([run('a', 'v1', 'mike', 0), run('b', 'v2', 'tasha', 0)]);
    expect(firstFreeVan(vans, both, T0 + 60 * 60_000, 5)).toBeNull();
  });
});

describe('<VanDayTimeline>', () => {
  it('draws a row per van with the run’s seats, and a ghost for riders waiting that opens Dispatch on the free van', async () => {
    const board = {
      date: '2026-09-21',
      vans,
      runs: [run('a', 'v1', 'mike', 0)],
      rides: [waiting('w1', 60), waiting('w2', 70)],
    } as unknown as TransportBoard;
    expect(groupWaitingRides(board.rides)).toHaveLength(1);
    const onDispatch = vi.fn();
    render(<VanDayTimeline board={board} onDispatch={onDispatch} />);
    expect(screen.getByRole('region', { name: 'Vans by the hour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Van 1 run leaving .*3\/12 seats/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Dispatch 2 waiting for To Front Beach 218 .* on Van 2/ }));
    expect(onDispatch).toHaveBeenCalledWith(board.rides, 'v2');
  });

  it('a double-booking reads as one', () => {
    const board = { date: '2026-09-21', vans, runs: [run('a', 'v1', 'mike', 0), run('b', 'v1', 'tasha', 3)], rides: [] } as unknown as TransportBoard;
    render(<VanDayTimeline board={board} />);
    expect(screen.getAllByRole('button', { name: /double-booked/ })).toHaveLength(2);
  });
});

describe('the board’s keys (transport walk 12)', () => {
  it('maps [ ] t m j k x d p and nothing else', () => {
    expect(['[', ']', 't', 'm', 'j', 'k', 'x', 'd', 'p'].map(resolveTransportKey)).toEqual(['prevDay', 'nextDay', 'today', 'tomorrow', 'down', 'up', 'pick', 'dispatch', 'plan']);
    expect(resolveTransportKey('q')).toBeNull();
  });
});
