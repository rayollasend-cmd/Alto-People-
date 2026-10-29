import { describe, expect, it } from 'vitest';
import { niceAxis } from '@/components/ui/charts/coverage';

/**
 * Hours axes read round numbers (deep audit LEAD-26): the portal's "Hours
 * scheduled vs worked" ticked 0h, 25h, 50h, 88h — the domain's top drawn as
 * the last tick.
 */
describe('niceAxis', () => {
  it('a 76h peak reads 0 / 25 / 50 / 75 / 100', () => {
    expect(niceAxis(76)).toEqual({ domain: [0, 100], ticks: [0, 25, 50, 75, 100] });
  });

  it('every tick is a round step, evenly spaced, the top clears the peak, and steps are whole hours', () => {
    for (const peak of [0, 0.4, 3, 7.5, 12, 19, 40, 88, 120, 489, 1065]) {
      const { domain, ticks } = niceAxis(peak);
      const step = ticks[1]! - ticks[0]!;
      expect(step).toBeGreaterThanOrEqual(1);
      expect(ticks[0]).toBe(0);
      ticks.forEach((t, i) => expect(t).toBeCloseTo(i * step, 6));
      expect(domain[1]).toBe(ticks.at(-1));
      expect(domain[1]).toBeGreaterThanOrEqual(peak);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 2.5, 5]).toContain(Math.round(mantissa * 100) / 100);
    }
  });
});
