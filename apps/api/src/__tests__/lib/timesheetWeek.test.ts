import { describe, it, expect } from 'vitest';
import {
  saturdayWeek,
  aggregateTimesheetRows,
  buildAssociateDays,
  buildScheduleComparison,
  computeTimesheetIssues,
  toUsDate,
  type TimesheetSourceEntry,
} from '../../lib/timesheetWeek.js';
import type { TimesheetRow } from '@alto-people/shared';

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

  it('buildAssociateDays lays out an overnight shift under its clock-in day', () => {
    // Overnight: in Sat 7/11 10pm ET, meal 3–4am, out Sun 7/12 7am ET → 8h net,
    // all attributed to Saturday (the clock-in day), matching Fieldglass.
    const { days, totalHours } = buildAssociateDays(
      [
        entry({
          clockInAt: new Date('2026-07-12T02:00:00Z'), // Sat 10pm ET
          clockOutAt: new Date('2026-07-12T11:00:00Z'), // Sun 7am ET
          breaks: [
            {
              type: 'MEAL',
              startedAt: new Date('2026-07-12T07:00:00Z'), // 3am ET
              endedAt: new Date('2026-07-12T08:00:00Z'), // 4am ET
            },
          ],
        }),
      ],
      WEEK.dateKeys,
      TZ,
    );

    const sat = days[0];
    expect(sat.weekday).toBe('Sat');
    expect(sat.monthDay).toBe('7/11');
    expect(sat.timeIn).toBe('10:00 PM');
    expect(sat.timeOut).toBe('7:00 AM');
    expect(sat.breaks).toEqual(['3:00 AM – 4:00 AM (1h)']);
    expect(sat.netHours).toBe(8);
    // Sunday (the clock-out day) shows nothing — the shift belongs to Saturday.
    expect(days[1].timeIn).toBeNull();
    expect(days[1].netHours).toBe(0);
    expect(totalHours).toBe(8);
  });

  it('computeTimesheetIssues flags missing clock-out, pending approval, and over-hours', () => {
    const approved = entry({
      clockInAt: new Date('2026-07-13T13:00:00Z'),
      clockOutAt: new Date('2026-07-13T21:00:00Z'),
      status: 'APPROVED',
    });
    const stillIn = entry({
      associateId: 'a2',
      firstName: 'Ana',
      lastName: 'Ramirez',
      clockInAt: new Date('2026-07-14T13:00:00Z'),
      clockOutAt: null,
      status: 'ACTIVE',
    });
    const pending = entry({
      associateId: 'a3',
      firstName: 'Jayda',
      lastName: 'Wright',
      clockInAt: new Date('2026-07-15T13:00:00Z'),
      clockOutAt: new Date('2026-07-15T21:00:00Z'),
      status: 'COMPLETED',
    });
    const { rows } = aggregateTimesheetRows([approved], KEYS, TZ);
    // A synthetic over-hours row (net > 60) alongside the real one.
    const over = { ...rows[0], worker: 'Doe, Big', total: 65 };

    const issues = computeTimesheetIssues(
      [approved, stillIn, pending],
      [...rows, over],
      KEYS,
      TZ,
    );
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('MISSING_CLOCKOUT');
    expect(kinds).toContain('PENDING_APPROVAL');
    expect(kinds).toContain('OVER_HOURS');
    // Missing clock-out is listed first (most blocking).
    expect(issues[0].kind).toBe('MISSING_CLOCKOUT');
    expect(issues.find((i) => i.kind === 'MISSING_CLOCKOUT')?.worker).toBe('Ramirez, Ana');
    expect(issues.find((i) => i.kind === 'OVER_HOURS')?.worker).toBe('Doe, Big');
  });

  it('buildScheduleComparison unions scheduled + actual, flagging a no-show', () => {
    const row = (over: Partial<TimesheetRow> & Pick<TimesheetRow, 'associateId' | 'worker' | 'total'>): TimesheetRow => ({
      st: 0, ot: 0, dt: 0, others: over.total, nb: 0, site: '—', status: 'READY', ...over,
    });
    const rows: TimesheetRow[] = [
      row({ associateId: 'a1', worker: 'Nelson, Aaliyah', total: 40 }), // worked, matches sched
      row({ associateId: 'a3', worker: 'Wright, Jayda', total: 12 }), // worked unscheduled
    ];
    const scheduled = new Map([
      ['a1', { hours: 40, worker: 'Nelson, Aaliyah' }],
      ['a2', { hours: 32, worker: 'Ramirez, Ana' }], // scheduled, never worked → no-show
    ]);

    const cmp = buildScheduleComparison(rows, scheduled);
    // Sorted by worker: Nelson, Ramirez, Wright.
    expect(cmp.map((c) => c.worker)).toEqual(['Nelson, Aaliyah', 'Ramirez, Ana', 'Wright, Jayda']);
    const ana = cmp.find((c) => c.associateId === 'a2')!;
    expect(ana.scheduledHours).toBe(32);
    expect(ana.actualHours).toBe(0);
    expect(ana.delta).toBe(-32); // no-show
    const jayda = cmp.find((c) => c.associateId === 'a3')!;
    expect(jayda.scheduledHours).toBe(0);
    expect(jayda.delta).toBe(12); // worked unscheduled
    expect(cmp.find((c) => c.associateId === 'a1')!.delta).toBe(0); // scheduled == actual
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
