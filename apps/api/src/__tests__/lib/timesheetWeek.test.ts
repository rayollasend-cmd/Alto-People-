import { describe, it, expect } from 'vitest';
import {
  saturdayWeek,
  aggregateTimesheetRows,
  toUsDate,
  type TimesheetSourceEntry,
} from '../../lib/timesheetWeek.js';

const TZ = 'America/New_York';

// The sample Fieldglass week: Sat 2026-07-11 → Fri 2026-07-17.
const WEEK = saturdayWeek(new Date('2026-07-15T12:00:00Z'), TZ);
const KEYS = new Set(WEEK.dateKeys);

function entry(
  over: Partial<TimesheetSourceEntry> & Pick<TimesheetSourceEntry, 'clockInAt'>,
): TimesheetSourceEntry {
  return {
    associateId: 'a1',
    firstName: 'Aaliyah',
    lastName: 'Nelson',
    clientId: 'c1',
    site: '1 - Onsite - FL - Destin',
    clockOutAt: null,
    status: 'APPROVED',
    breaks: [],
    ...over,
  };
}

describe('saturdayWeek', () => {
  it('snaps any weekday instant to its Sat→Fri window', () => {
    expect(WEEK.weekStart).toBe('2026-07-11'); // Saturday
    expect(WEEK.weekEnd).toBe('2026-07-17'); // Friday
    expect(WEEK.dateKeys).toHaveLength(7);
  });

  it('a Saturday belongs to the week it starts', () => {
    const w = saturdayWeek(new Date('2026-07-11T13:00:00Z'), TZ); // Sat 9am ET
    expect(w.weekStart).toBe('2026-07-11');
    expect(w.weekEnd).toBe('2026-07-17');
  });

  it('a Friday belongs to the week it ends', () => {
    const w = saturdayWeek(new Date('2026-07-17T23:00:00Z'), TZ); // Fri 7pm ET
    expect(w.weekStart).toBe('2026-07-11');
  });
});

describe('toUsDate', () => {
  it('renders MM/DD/YYYY', () => {
    expect(toUsDate('2026-07-17')).toBe('07/17/2026');
  });
});

describe('aggregateTimesheetRows', () => {
  it('sums NET hours (breaks subtracted) into the Others bucket, name as "Last, First"', () => {
    // Mon 9am–5pm ET (8h) minus a 1h break = 7h net.
    const rows = aggregateTimesheetRows(
      [
        entry({
          clockInAt: new Date('2026-07-13T13:00:00Z'),
          clockOutAt: new Date('2026-07-13T21:00:00Z'),
          breaks: [
            {
              type: 'MEAL',
              startedAt: new Date('2026-07-13T16:00:00Z'),
              endedAt: new Date('2026-07-13T17:00:00Z'),
            },
          ],
        }),
      ],
      KEYS,
      TZ,
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].worker).toBe('Nelson, Aaliyah');
    expect(rows[0].site).toBe('1 - Onsite - FL - Destin');
    expect(rows[0].others).toBe(7);
    expect(rows[0].total).toBe(7);
    expect(rows[0].st).toBe(0);
    expect(rows[0].ot).toBe(0);
    expect(rows[0].dt).toBe(0);
    expect(rows[0].nb).toBe(0);
    expect(rows[0].status).toBe('READY');
  });

  it('does NOT split overtime — a 45h week stays entirely in Others', () => {
    const entries: TimesheetSourceEntry[] = [];
    // Mon–Fri, 9h each (9am–6pm ET), no breaks → 45h net.
    for (const day of ['13', '14', '15', '16', '17']) {
      entries.push(
        entry({
          clockInAt: new Date(`2026-07-${day}T13:00:00Z`),
          clockOutAt: new Date(`2026-07-${day}T22:00:00Z`),
        }),
      );
    }
    const { rows, totalHours } = aggregateTimesheetRows(entries, KEYS, TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0].others).toBe(45);
    expect(rows[0].ot).toBe(0);
    expect(totalHours).toBe(45);
  });

  it('excludes entries whose local day falls outside the week', () => {
    const { rows } = aggregateTimesheetRows(
      [
        entry({
          // Sat 2026-07-18 — the NEXT week.
          clockInAt: new Date('2026-07-18T13:00:00Z'),
          clockOutAt: new Date('2026-07-18T21:00:00Z'),
        }),
      ],
      KEYS,
      TZ,
    );
    expect(rows).toHaveLength(0);
  });

  it('flags a worker with pending (COMPLETED) time and omits it from hours', () => {
    const { rows, pendingCount } = aggregateTimesheetRows(
      [
        entry({
          clockInAt: new Date('2026-07-13T13:00:00Z'),
          clockOutAt: new Date('2026-07-13T21:00:00Z'),
          status: 'APPROVED',
        }),
        entry({
          clockInAt: new Date('2026-07-14T13:00:00Z'),
          clockOutAt: new Date('2026-07-14T21:00:00Z'),
          status: 'COMPLETED', // awaiting approval
        }),
      ],
      KEYS,
      TZ,
    );
    expect(pendingCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].others).toBe(8); // only the approved day counts
  });

  it('separates the same associate at different clients into two rows', () => {
    const { rows } = aggregateTimesheetRows(
      [
        entry({
          clientId: 'c1',
          site: 'Destin',
          clockInAt: new Date('2026-07-13T13:00:00Z'),
          clockOutAt: new Date('2026-07-13T21:00:00Z'),
        }),
        entry({
          clientId: 'c2',
          site: 'Miramar',
          clockInAt: new Date('2026-07-14T13:00:00Z'),
          clockOutAt: new Date('2026-07-14T21:00:00Z'),
        }),
      ],
      KEYS,
      TZ,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.site).sort()).toEqual(['Destin', 'Miramar']);
  });
});
