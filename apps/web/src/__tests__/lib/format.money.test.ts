import { describe, it, expect } from 'vitest';
import { fmtMoney, fmtMoneyCompact, fmtPayRate } from '@/lib/format';

/**
 * fmtMoneyCompact is the ONE compact-currency formatter — the scheduling
 * KPI strip and the week view's day-total row used to carry private
 * near-copies whose tier behavior had already drifted (one had an $M tier,
 * the other didn't). These tests pin the shared tiers.
 */
describe('fmtMoneyCompact', () => {
  it('passes small amounts through, rounded and grouped', () => {
    expect(fmtMoneyCompact(0)).toBe('$0');
    expect(fmtMoneyCompact(840)).toBe('$840');
    expect(fmtMoneyCompact(840.49)).toBe('$840');
    // Rounding can carry into the grouping range.
    expect(fmtMoneyCompact(999.6)).toBe('$1,000');
  });

  it('compacts thousands with one decimal under $10k, none above', () => {
    expect(fmtMoneyCompact(1_234)).toBe('$1.2k');
    expect(fmtMoneyCompact(4_567)).toBe('$4.6k');
    expect(fmtMoneyCompact(24_000)).toBe('$24k');
    expect(fmtMoneyCompact(24_499)).toBe('$24k');
  });

  it('compacts millions with one decimal under $10M, none above', () => {
    expect(fmtMoneyCompact(1_400_000)).toBe('$1.4M');
    expect(fmtMoneyCompact(3_440_000)).toBe('$3.4M');
    expect(fmtMoneyCompact(12_000_000)).toBe('$12M');
  });

  it('keeps the sign in front of the $', () => {
    expect(fmtMoneyCompact(-1_234)).toBe('-$1.2k');
    expect(fmtMoneyCompact(-840)).toBe('-$840');
  });

  it('dashes null/undefined/empty/non-numeric like the other formatters', () => {
    expect(fmtMoneyCompact(null)).toBe('—');
    expect(fmtMoneyCompact(undefined)).toBe('—');
    expect(fmtMoneyCompact('')).toBe('—');
    expect(fmtMoneyCompact(Number.NaN)).toBe('—');
    expect(fmtMoneyCompact('abc')).toBe('—');
  });

  it('accepts numeric strings (decimal columns arrive as strings)', () => {
    expect(fmtMoneyCompact('1234')).toBe('$1.2k');
  });
});

// The hover card's pay line renders through these — pinned here so the
// "$24.50/hr · projected $196.00" shape can't drift back to bare toFixed.
describe('fmtMoney / fmtPayRate (hover-card shapes)', () => {
  it('always shows two grouped decimals', () => {
    expect(fmtMoney(1234)).toBe('$1,234.00');
    expect(fmtMoney(24.5)).toBe('$24.50');
  });

  it('suffixes hourly rates', () => {
    expect(fmtPayRate(24.5, 'HOURLY')).toBe('$24.50/hr');
  });
});
