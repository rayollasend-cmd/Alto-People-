import { describe, expect, it } from 'vitest';
import {
  detectAnomalies,
  endOfWeekUTC,
  netWorkedMinutes,
  startOfWeekUTC,
  totalMealBreakMinutes,
} from '../../lib/timeAnomalies.js';

const HOUR = 60 * 60 * 1000;

describe('netWorkedMinutes', () => {
  it('subtracts break time from total', () => {
    const start = new Date('2026-04-13T08:00:00Z');
    const end = new Date('2026-04-13T16:00:00Z');  // 8h
    const breakStart = new Date('2026-04-13T12:00:00Z');
    const breakEnd = new Date('2026-04-13T12:30:00Z');  // 30min
    const m = netWorkedMinutes(
      { clockInAt: start, clockOutAt: end },
      [{ type: 'MEAL', startedAt: breakStart, endedAt: breakEnd }]
    );
    expect(m).toBe(8 * 60 - 30);
  });

  it('handles open break (uses clockOutAt as end)', () => {
    const start = new Date('2026-04-13T08:00:00Z');
    const end = new Date('2026-04-13T10:00:00Z');
    const m = netWorkedMinutes(
      { clockInAt: start, clockOutAt: end },
      [{ type: 'REST', startedAt: new Date('2026-04-13T09:30:00Z'), endedAt: null }]
    );
    expect(m).toBe(2 * 60 - 30);
  });
});

describe('totalMealBreakMinutes', () => {
  it('sums only completed MEAL breaks', () => {
    const breaks = [
      { type: 'MEAL' as const, startedAt: new Date('2026-04-13T12:00:00Z'), endedAt: new Date('2026-04-13T12:25:00Z') },
      { type: 'REST' as const, startedAt: new Date('2026-04-13T15:00:00Z'), endedAt: new Date('2026-04-13T15:10:00Z') },
      { type: 'MEAL' as const, startedAt: new Date('2026-04-13T17:00:00Z'), endedAt: null },
    ];
    expect(totalMealBreakMinutes(breaks)).toBe(25);
  });
});

describe('detectAnomalies', () => {
  it('flags GEOFENCE_VIOLATION_IN/OUT', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: new Date(),
        clockOutAt: new Date(Date.now() + HOUR),
        geofenceInOk: false,
        geofenceOutOk: false,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 60,
    });
    expect(a).toContain('GEOFENCE_VIOLATION_IN');
    expect(a).toContain('GEOFENCE_VIOLATION_OUT');
  });

  it('flags NO_BREAK after 6h of straight work', () => {
    const start = new Date('2026-04-13T08:00:00Z');
    const end = new Date('2026-04-13T15:00:00Z');  // 7h
    const a = detectAnomalies({
      entry: { clockInAt: start, clockOutAt: end, geofenceInOk: null, geofenceOutOk: null },
      breaks: [],
      weeklyMinutesIncludingThis: 7 * 60,
    });
    expect(a).toContain('NO_BREAK');
  });

  it('flags MEAL_BREAK_TOO_SHORT when meal < 30 min', () => {
    const start = new Date('2026-04-13T08:00:00Z');
    const end = new Date('2026-04-13T15:00:00Z');
    const a = detectAnomalies({
      entry: { clockInAt: start, clockOutAt: end, geofenceInOk: null, geofenceOutOk: null },
      breaks: [
        {
          type: 'MEAL',
          startedAt: new Date('2026-04-13T12:00:00Z'),
          endedAt: new Date('2026-04-13T12:20:00Z'),
        },
      ],
      weeklyMinutesIncludingThis: 7 * 60,
    });
    expect(a).toContain('MEAL_BREAK_TOO_SHORT');
  });

  it('does NOT flag NO_BREAK or MEAL_TOO_SHORT when a 30+ min meal is taken', () => {
    const start = new Date('2026-04-13T08:00:00Z');
    const end = new Date('2026-04-13T16:00:00Z');
    const a = detectAnomalies({
      entry: { clockInAt: start, clockOutAt: end, geofenceInOk: null, geofenceOutOk: null },
      breaks: [
        {
          type: 'MEAL',
          startedAt: new Date('2026-04-13T12:00:00Z'),
          endedAt: new Date('2026-04-13T12:35:00Z'),
        },
      ],
      weeklyMinutesIncludingThis: 8 * 60,
    });
    expect(a).not.toContain('NO_BREAK');
    expect(a).not.toContain('MEAL_BREAK_TOO_SHORT');
  });

  it('flags OVERTIME_UNAPPROVED when weekly minutes > 40h', () => {
    const a = detectAnomalies({
      entry: { clockInAt: new Date(), clockOutAt: new Date(Date.now() + HOUR), geofenceInOk: null, geofenceOutOk: null },
      breaks: [],
      weeklyMinutesIncludingThis: 41 * 60,
    });
    expect(a).toContain('OVERTIME_UNAPPROVED');
  });

  it('flags OUTSIDE_SHIFT_WINDOW when clock-in/out is >60 min from shift', () => {
    const shiftStart = new Date('2026-04-13T08:00:00Z');
    const shiftEnd = new Date('2026-04-13T16:00:00Z');
    const a = detectAnomalies({
      entry: {
        clockInAt: new Date('2026-04-13T06:00:00Z'),
        clockOutAt: new Date('2026-04-13T16:00:00Z'),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 10 * 60,
      matchedShift: { startsAt: shiftStart, endsAt: shiftEnd },
    });
    expect(a).toContain('OUTSIDE_SHIFT_WINDOW');
  });

  it('flags EARLY_OUT when clock-out is >15 min before shift end', () => {
    const shift = {
      startsAt: new Date('2026-04-13T08:00:00Z'),
      endsAt: new Date('2026-04-13T16:00:00Z'),
    };
    const a = detectAnomalies({
      entry: {
        clockInAt: new Date('2026-04-13T08:00:00Z'),
        clockOutAt: new Date('2026-04-13T15:30:00Z'), // 30 min early
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 8 * 60,
      matchedShift: shift,
    });
    expect(a).toContain('EARLY_OUT');
    // 30 min early is still inside the 60-min OUTSIDE_SHIFT_WINDOW drift.
    expect(a).not.toContain('OUTSIDE_SHIFT_WINDOW');
  });

  it('does NOT flag EARLY_OUT inside the 15-min grace or when staying late', () => {
    const shift = {
      startsAt: new Date('2026-04-13T08:00:00Z'),
      endsAt: new Date('2026-04-13T16:00:00Z'),
    };
    const graceful = detectAnomalies({
      entry: {
        clockInAt: new Date('2026-04-13T08:00:00Z'),
        clockOutAt: new Date('2026-04-13T15:50:00Z'), // 10 min early
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 8 * 60,
      matchedShift: shift,
    });
    expect(graceful).not.toContain('EARLY_OUT');

    const late = detectAnomalies({
      entry: {
        clockInAt: new Date('2026-04-13T08:00:00Z'),
        clockOutAt: new Date('2026-04-13T16:30:00Z'), // stayed late
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 8 * 60,
      matchedShift: shift,
    });
    expect(late).not.toContain('EARLY_OUT');
  });
});

describe('week boundaries — org workweek (Sat→Fri, Florida-local)', () => {
  it('startOfWeekUTC returns Saturday 00:00 America/New_York as a UTC instant', () => {
    // 2026-04-15 is a Wednesday. The org week containing it starts
    // Saturday 2026-04-11 00:00 EDT = 04:00 UTC.
    const wed = new Date('2026-04-15T15:30:00Z');
    const start = startOfWeekUTC(wed);
    expect(start.toISOString()).toBe('2026-04-11T04:00:00.000Z');
  });

  it('a Friday-night overnight punch belongs to the week ENDING that Friday', () => {
    // Friday 2026-04-17 10 PM EDT (= Sat 02:00 UTC) — the overnight crew.
    // Local-clock anchoring keeps it in the Sat Apr 11 → Fri Apr 17 week;
    // the old UTC math would have pushed it into the next week.
    const fridayNight = new Date('2026-04-18T02:00:00Z');
    expect(startOfWeekUTC(fridayNight).toISOString()).toBe(
      '2026-04-11T04:00:00.000Z',
    );
    // One hour later, Saturday 00:30 local = the NEW week.
    const saturdayNight = new Date('2026-04-18T04:30:00Z');
    expect(startOfWeekUTC(saturdayNight).toISOString()).toBe(
      '2026-04-18T04:00:00.000Z',
    );
  });

  it('endOfWeekUTC is the next local Saturday midnight (7 local days)', () => {
    const wed = new Date('2026-04-15T15:30:00Z');
    expect(endOfWeekUTC(wed).toISOString()).toBe('2026-04-18T04:00:00.000Z');
  });

  it('handles the DST fall-back week (169 real hours) without drifting', () => {
    // 2026-11-01 (Sun) is the fall-back date in America/New_York. The week
    // Sat Oct 31 → Fri Nov 6: starts at 04:00 UTC (EDT), ends the next
    // Saturday at 05:00 UTC (EST) — 169 hours, both boundaries at local
    // midnight.
    const midWeek = new Date('2026-11-03T12:00:00Z');
    expect(startOfWeekUTC(midWeek).toISOString()).toBe('2026-10-31T04:00:00.000Z');
    expect(endOfWeekUTC(midWeek).toISOString()).toBe('2026-11-07T05:00:00.000Z');
  });
});
