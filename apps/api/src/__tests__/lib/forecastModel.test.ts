import { describe, expect, it } from 'vitest';
import { addWeeks, backtest, forecastSite, holidayFor, lastYearWeek, weeksBetween, type WeekSeries } from '../../lib/forecast/model.js';

/**
 * Brief 3-4 — the model on a synthetic two-year history with a known
 * shape: a summer peak, a mild year-over-year rise, and noise. The
 * acceptance bar is the brief's: under 15 percent error at the site-week
 * level for the summer season, at a four-week lead.
 */

/** A deterministic PRNG so the noise is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two years of Saturday-start weeks ending the week before `anchor`. */
function syntheticSite(anchor: string, opts: { base: number; amplitude: number; growth: number; noise: number; seed: number }): WeekSeries {
  const series = new Map<string, number>();
  const rand = rng(opts.seed);
  for (let i = 104; i >= 1; i--) {
    const week = addWeeks(anchor, -i);
    const month = Number(week.slice(5, 7));
    const day = Number(week.slice(8, 10));
    // A summer peak centered on mid-July, a shoulder in spring and fall, a winter trough.
    const doy = (month - 1) * 30.4 + day;
    const seasonal = 1 + opts.amplitude * Math.cos(((doy - 196) / 365) * 2 * Math.PI);
    const yearsAgo = i / 52;
    const level = opts.base * (1 + opts.growth * (2 - yearsAgo));
    const noise = 1 + (rand() - 0.5) * 2 * opts.noise;
    series.set(week, Math.max(0, level * seasonal * noise));
  }
  return series;
}

const ANCHOR = '2026-10-10'; // a Saturday

describe('calendar helpers', () => {
  it('moves by whole weeks and counts the distance', () => {
    expect(addWeeks('2026-10-10', 1)).toBe('2026-10-17');
    expect(addWeeks('2026-10-10', -52)).toBe('2025-10-11');
    expect(lastYearWeek('2026-10-10')).toBe('2025-10-11');
    expect(weeksBetween('2026-10-10', '2026-11-07')).toBe(4);
  });

  it('knows the weeks that move the Gulf Coast', () => {
    expect(holidayFor('2026-07-04')?.name).toBe('Independence Day');
    expect(holidayFor('2026-05-23')?.name).toBe('Memorial Day'); // May 25 2026 is the last Monday
    expect(holidayFor('2026-11-21')?.name).toBe('Thanksgiving week'); // Nov 26 2026
    expect(holidayFor('2026-10-10')).toBeNull();
  });
});

describe('forecastSite', () => {
  it('forecasts the horizon with a band and says why, floored at zero', () => {
    const series = syntheticSite(ANCHOR, { base: 400, amplitude: 0.35, growth: 0.05, noise: 0.05, seed: 7 });
    const points = forecastSite(series, { anchor: ANCHOR, horizonWeeks: 26, weights: { lastYearWeight: 0.5, bandLow: -0.12, bandHigh: 0.14 } });
    expect(points).toHaveLength(26);
    expect(points[0]!.weekStart).toBe(ANCHOR);
    expect(points[25]!.weekStart).toBe(addWeeks(ANCHOR, 25));
    for (const p of points) {
      expect(p.p10).toBeLessThanOrEqual(p.p50);
      expect(p.p50).toBeLessThanOrEqual(p.p90);
      expect(p.p10).toBeGreaterThanOrEqual(0);
      expect(p.drivers.lastYearScaled).not.toBeNull();
      expect(p.drivers.leadWeeks).toBe(points.indexOf(p) + 1);
    }
    // Mid-October to early April: the trough comes, the forecast falls with it.
    const october = points[0]!.p50;
    const january = points.find((p) => p.weekStart.startsWith('2027-01'))!.p50;
    expect(january).toBeLessThan(october);
  });

  it('with no last year it leans on the recent weeks alone and a signal multiplies the week', () => {
    const series = new Map<string, number>();
    for (let i = 10; i >= 1; i--) series.set(addWeeks(ANCHOR, -i), 300 + i); // gently falling toward the anchor
    const plain = forecastSite(series, { anchor: ANCHOR, horizonWeeks: 2, weights: { lastYearWeight: 0.75, bandLow: -0.15, bandHigh: 0.15 } });
    expect(plain[0]!.drivers.lastYearScaled).toBeNull();
    expect(plain[0]!.drivers.lastYearWeight).toBe(0);
    expect(plain[0]!.p50).toBeGreaterThan(290);
    expect(plain[0]!.p50).toBeLessThan(310);
    const signalled = forecastSite(series, {
      anchor: ANCHOR,
      horizonWeeks: 2,
      weights: { lastYearWeight: 0.75, bandLow: -0.15, bandHigh: 0.15 },
      signals: [{ weekStart: addWeeks(ANCHOR, 1), kind: 'TRUCKS', factor: 1.5, source: 'Client truck schedule' }],
    });
    expect(signalled[1]!.p50).toBeCloseTo(plain[1]!.p50 * 1.5, 0);
    expect(signalled[1]!.drivers.signals).toEqual([{ kind: 'TRUCKS', factor: 1.5, source: 'Client truck schedule' }]);
    expect(signalled[0]!.drivers.signalFactor).toBe(1);
  });

  it('caps the trend so one hot month cannot run away over 26 weeks', () => {
    const series = new Map<string, number>();
    for (let i = 8; i >= 1; i--) series.set(addWeeks(ANCHOR, -i), i > 4 ? 100 : 400); // a jump four weeks ago
    const points = forecastSite(series, { anchor: ANCHOR, horizonWeeks: 26, weights: { lastYearWeight: 0, bandLow: 0, bandHigh: 0 } });
    // recent mean 250, trend capped at 20% = 50 h/week; the far horizon is bounded, not 250 + 75 × 26.
    expect(points[0]!.drivers.trendPerWeek).toBe(50);
    expect(points[25]!.p50).toBeLessThanOrEqual(250 + 50 * 26 + 1);
  });
});

describe('backtest', () => {
  it('scores every site-week at a four-week lead, picks the weight on last year, and lands the summer under 15 percent', () => {
    const sites = new Map<string, WeekSeries>([
      ['beach', syntheticSite(ANCHOR, { base: 450, amplitude: 0.4, growth: 0.06, noise: 0.06, seed: 1 })],
      ['grocer', syntheticSite(ANCHOR, { base: 900, amplitude: 0.15, growth: 0.02, noise: 0.05, seed: 2 })],
      ['harbor', syntheticSite(ANCHOR, { base: 260, amplitude: 0.5, growth: 0.1, noise: 0.07, seed: 3 })],
    ]);
    const result = backtest(sites);
    expect(result.scoredWeeks).toBeGreaterThan(200);
    expect(result.mapePct).not.toBeNull();
    expect(result.summerMapePct).not.toBeNull();
    expect(result.summerMapePct!).toBeLessThan(15);
    expect(result.mapePct!).toBeLessThan(15);
    // A seasonal history earns last year a real weight.
    expect(result.weights.lastYearWeight).toBeGreaterThan(0);
    // The band is never narrower than the default.
    expect(result.weights.bandLow).toBeLessThanOrEqual(-0.15);
    expect(result.weights.bandHigh).toBeGreaterThanOrEqual(0.15);
    for (const p of result.points) {
      expect(p.leadWeeks).toBe(4);
      expect(p.actualHours).toBeGreaterThan(0);
    }
  });

  it('with too little history it scores nothing and keeps the defaults', () => {
    const series = new Map<string, number>();
    for (let i = 10; i >= 1; i--) series.set(addWeeks(ANCHOR, -i), 100);
    const result = backtest(new Map([['new', series]]));
    expect(result.scoredWeeks).toBe(0);
    expect(result.mapePct).toBeNull();
    expect(result.weights).toEqual({ lastYearWeight: 0.5, bandLow: -0.15, bandHigh: 0.15 });
  });
});
