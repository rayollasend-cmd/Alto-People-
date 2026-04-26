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
});

describe('week boundaries', () => {
  it('startOfWeekUTC returns Sunday 00:00 UTC', () => {
    // 2026-04-15 is a Wednesday. Week starts 2026-04-12 (Sun).
    const wed = new Date('2026-04-15T15:30:00Z');
    const start = startOfWeekUTC(wed);
    expect(start.getUTCDay()).toBe(0);
    expect(start.toISOString()).toBe('2026-04-12T00:00:00.000Z');
  });

  it('endOfWeekUTC is exactly 7 days after start', () => {
    const wed = new Date('2026-04-15T15:30:00Z');
    const end = endOfWeekUTC(wed);
    expect(end.toISOString()).toBe('2026-04-19T00:00:00.000Z');
  });
});
