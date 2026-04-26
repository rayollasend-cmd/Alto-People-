import { describe, expect, it } from 'vitest';
import {
  getLaborPolicy,
  listLaborPolicyStates,
} from '../../lib/stateLaborPolicy.js';
import { detectAnomalies } from '../../lib/timeAnomalies.js';

describe('getLaborPolicy', () => {
  it('returns FEDERAL for unknown / null state', () => {
    expect(getLaborPolicy(null).state).toBe('FEDERAL');
    expect(getLaborPolicy('XX').state).toBe('FEDERAL');
    expect(getLaborPolicy('').state).toBe('FEDERAL');
    expect(getLaborPolicy(undefined).state).toBe('FEDERAL');
  });

  it('lowercase state codes are normalized', () => {
    expect(getLaborPolicy('ca').state).toBe('CA');
    expect(getLaborPolicy('Ca').state).toBe('CA');
  });

  it('CA has the daily-OT 8h threshold and 30-min meal break required after 5h', () => {
    const ca = getLaborPolicy('CA');
    expect(ca.dailyOTHoursThreshold).toBe(8);
    expect(ca.weeklyOTHoursThreshold).toBe(40);
    expect(ca.mealBreakMinMinutes).toBe(30);
    expect(ca.mealBreakRequiredAfterHours).toBe(5);
    expect(ca.minimumWageCents).toBeGreaterThanOrEqual(1500);
  });

  it('FL/TX/GA have NO mandatory meal break (federal default)', () => {
    for (const code of ['FL', 'TX', 'GA']) {
      const p = getLaborPolicy(code);
      expect(p.mealBreakRequiredAfterHours).toBeNull();
      expect(p.dailyOTHoursThreshold).toBeNull();
    }
  });

  it('listLaborPolicyStates includes the major hospitality states', () => {
    const list = listLaborPolicyStates();
    for (const s of ['CA', 'NY', 'FL', 'TX', 'NJ', 'IL', 'MA', 'WA', 'OR', 'CO', 'AZ', 'GA', 'NC', 'VA']) {
      expect(list).toContain(s);
    }
  });

  it('paid sick leave accrual is non-zero where the law requires it (CA, NY, IL, WA, MA, NJ, OR, AZ, CO)', () => {
    for (const s of ['CA', 'NY', 'IL', 'WA', 'MA', 'NJ', 'OR', 'AZ', 'CO']) {
      expect(getLaborPolicy(s).paidSickLeaveAccrualPerHour).toBeGreaterThan(0);
    }
    for (const s of ['FL', 'TX', 'GA', 'NC']) {
      expect(getLaborPolicy(s).paidSickLeaveAccrualPerHour).toBe(0);
    }
  });
});

describe('detectAnomalies × state policy', () => {
  const baseTime = (h: number) => new Date(Date.UTC(2026, 3, 1, 13 + h, 0, 0));

  it('CA: a 9-hour day fires daily OT (no weekly threshold needed)', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: baseTime(0),
        clockOutAt: baseTime(9),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 9 * 60, // single day, well under 40h
      state: 'CA',
    });
    expect(a).toContain('OVERTIME_UNAPPROVED');
  });

  it('FL: same 9-hour day does NOT fire OT (no daily threshold)', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: baseTime(0),
        clockOutAt: baseTime(9),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 9 * 60,
      state: 'FL',
    });
    expect(a).not.toContain('OVERTIME_UNAPPROVED');
  });

  it('CA: 25-min meal break on a 6-hour day fires MEAL_BREAK_TOO_SHORT', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: baseTime(0),
        clockOutAt: baseTime(6),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [
        { type: 'MEAL', startedAt: baseTime(3), endedAt: new Date(baseTime(3).getTime() + 25 * 60 * 1000) },
      ],
      weeklyMinutesIncludingThis: 6 * 60,
      state: 'CA',
    });
    expect(a).toContain('MEAL_BREAK_TOO_SHORT');
  });

  it('weekly OT > 40h still fires regardless of state', () => {
    for (const s of ['CA', 'FL', 'TX']) {
      const a = detectAnomalies({
        entry: {
          clockInAt: baseTime(0),
          clockOutAt: baseTime(7),
          geofenceInOk: null,
          geofenceOutOk: null,
        },
        breaks: [],
        weeklyMinutesIncludingThis: 41 * 60,
        state: s,
      });
      expect(a).toContain('OVERTIME_UNAPPROVED');
    }
  });

  it('null state behaves like the pre-Phase-23 federal default (no daily OT)', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: baseTime(0),
        clockOutAt: baseTime(11),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 11 * 60,
      state: null,
    });
    expect(a).not.toContain('OVERTIME_UNAPPROVED');
  });

  it('OT anomaly is deduped when both daily and weekly fire (CA × 41h week)', () => {
    const a = detectAnomalies({
      entry: {
        clockInAt: baseTime(0),
        clockOutAt: baseTime(9),
        geofenceInOk: null,
        geofenceOutOk: null,
      },
      breaks: [],
      weeklyMinutesIncludingThis: 41 * 60,
      state: 'CA',
    });
    const ot = a.filter((x) => x === 'OVERTIME_UNAPPROVED');
    expect(ot).toHaveLength(1);
  });
});
