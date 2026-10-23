import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  currentPeriod,
  daysInRange,
  everyDay,
  presetRange,
  previousPeriod,
  resolveRange,
} from '@/pages/scheduling/laborCostRange';

/** Alto's biweekly Sat→Fri periods, newest first, as the API sends them. */
const PERIODS = [
  { start: '2026-10-10', end: '2026-10-23' },
  { start: '2026-09-26', end: '2026-10-09' },
  { start: '2026-09-12', end: '2026-09-25' },
];
const TODAY = '2026-10-22';

describe('the labor-cost range', () => {
  it('opens on the current pay period to date', () => {
    expect(resolveRange({}, TODAY, PERIODS)).toEqual({
      from: '2026-10-10',
      to: '2026-10-22',
      preset: 'period',
      defaultPreset: 'period',
    });
  });

  it('knows last period and 30 days, and lights the preset a URL matches', () => {
    expect(presetRange('last', TODAY, PERIODS)).toEqual({ from: '2026-09-26', to: '2026-10-09' });
    expect(presetRange('30d', TODAY, PERIODS)).toEqual({ from: '2026-09-23', to: '2026-10-22' });
    expect(resolveRange({ from: '2026-09-26', to: '2026-10-09' }, TODAY, PERIODS).preset).toBe('last');
    expect(resolveRange({ from: '2026-09-23', to: '2026-10-22' }, TODAY, PERIODS).preset).toBe('30d');
    expect(resolveRange({ from: '2026-10-01', to: '2026-10-05' }, TODAY, PERIODS)).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-05',
      preset: 'custom',
    });
  });

  it('reads a broken or half URL sensibly (bad dates are ignored, an inverted pair is swapped)', () => {
    expect(resolveRange({ from: 'nonsense', to: '2026-13-45' }, TODAY, PERIODS).preset).toBe('period');
    expect(resolveRange({ from: '2026-10-05' }, TODAY, PERIODS)).toMatchObject({ from: '2026-10-05', to: '2026-10-05' });
    expect(resolveRange({ from: '2026-10-09', to: '2026-10-01' }, TODAY, PERIODS)).toMatchObject({ from: '2026-10-01', to: '2026-10-09' });
  });

  it('without a pay schedule, opens on 30 days and offers no period presets', () => {
    expect(resolveRange({}, TODAY, [])).toEqual({ from: '2026-09-23', to: '2026-10-22', preset: '30d', defaultPreset: '30d' });
    expect(presetRange('period', TODAY, [])).toBeNull();
    expect(presetRange('last', TODAY, [])).toBeNull();
  });

  it('picks the period by the reader’s day, on the first and last day too', () => {
    expect(currentPeriod(PERIODS, '2026-10-10')).toEqual(PERIODS[0]);
    expect(currentPeriod(PERIODS, '2026-10-09')).toEqual(PERIODS[1]);
    expect(previousPeriod(PERIODS, '2026-10-10')).toEqual(PERIODS[1]);
  });

  it('lists every day of a range, so the chart axis is continuous', () => {
    expect(everyDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(daysInRange('2026-09-23', '2026-10-22')).toBe(30);
    expect(daysInRange('2026-10-22', '2026-10-21')).toBe(0);
    expect(addDaysYmd('2026-03-07', 1)).toBe('2026-03-08');
  });
});
