import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { weekDays } from '@/components/MyPlanCard';

/**
 * CRAWL-13: "My plan" built its week by adding 24h of milliseconds per day.
 * Just after midnight in a week that crosses the Nov 1 fall-back, Nov 1
 * showed twice (both chips sharing one React key) and Nov 4 dropped off.
 */
describe('MyPlanCard week strip across a DST change', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = tz;
  });

  for (const zone of ['America/Chicago', 'America/Los_Angeles']) {
    describe(zone, () => {
      beforeEach(() => {
        process.env.TZ = zone;
      });

      it('Oct 29 00:10 local: seven distinct calendar days, Nov 1 once', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 29, 0, 10));
        const keys = weekDays().map((d) => d.key);
        expect(keys).toEqual([
          '2026-10-29',
          '2026-10-30',
          '2026-10-31',
          '2026-11-01',
          '2026-11-02',
          '2026-11-03',
          '2026-11-04',
        ]);
        expect(new Set(keys).size).toBe(7);
      });

      it('Oct 29 23:50 local (late evening) still starts today', () => {
        const days = weekDays(new Date(2026, 9, 29, 23, 50));
        expect(days[0].key).toBe('2026-10-29');
        expect(days[0].isToday).toBe(true);
        expect(days[6].key).toBe('2026-11-04');
        expect(days.map((d) => d.date)).toEqual([29, 30, 31, 1, 2, 3, 4]);
      });

      it('spring forward: Mar 5 23:30 never skips Mar 8', () => {
        const keys = weekDays(new Date(2026, 2, 5, 23, 30)).map((d) => d.key);
        expect(keys).toContain('2026-03-08');
        expect(keys[6]).toBe('2026-03-11');
        expect(new Set(keys).size).toBe(7);
      });
    });
  }
});
