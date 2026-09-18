import { describe, expect, it } from 'vitest';
import { kpiWindow } from '@/pages/scheduling/kpiWindow';

// Thursday Sep 17, 2026 — its workweek runs Sat Sep 12 → Fri Sep 18.
const now = new Date(2026, 8, 17, 14, 0);
const day = (m: number, d: number) => new Date(2026, m - 1, d);

describe('kpiWindow — what the Scheduling strip counts and calls it', () => {
  it('the current workweek on the grid is "this week", asked for by its store days', () => {
    expect(kpiWindow({ view: 'week', weekStart: day(9, 12), weekDayCount: 7, now })).toEqual({
      query: { fromDay: '2026-09-12', toDay: '2026-09-18' },
      period: 'this week',
    });
  });

  it('another week, or a custom span, is named by its days', () => {
    expect(kpiWindow({ view: 'week', weekStart: day(9, 19), weekDayCount: 7, now })).toEqual({
      query: { fromDay: '2026-09-19', toDay: '2026-09-25' },
      period: 'Sep 19 – 25',
    });
    expect(kpiWindow({ view: 'week', weekStart: day(9, 26), weekDayCount: 7, now }).period).toBe('Sep 26 – Oct 2');
    // Starting mid-week isn't "this week", even when it includes today.
    expect(kpiWindow({ view: 'week', weekStart: day(9, 15), weekDayCount: 7, now }).period).toBe('Sep 15 – 21');
    expect(kpiWindow({ view: 'week', weekStart: day(9, 17), weekDayCount: 1, now }).period).toBe('Sep 17');
  });

  it('off the week grid it is the store workweek — what My floor and the portal read', () => {
    for (const view of ['day', 'month', 'list']) {
      expect(kpiWindow({ view, weekStart: day(9, 19), weekDayCount: 7, now })).toEqual({
        query: { week: 'this' },
        period: 'this week',
      });
    }
  });
});
