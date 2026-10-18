import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACA_CONFIG,
  basisOn,
  codesForMonth,
  effectiveHireDate,
  exposure,
  initialWindowFor,
  measure,
  standardWindowFor,
  validateAcaConfig,
  type HourEntry,
} from '../../lib/acaMeasurement.js';

const c = DEFAULT_ACA_CONFIG; // 12-month SMP, 60-day admin, 12-month SP from Jan 1, 130 h/month
const d = (s: string) => new Date(`${s}T00:00:00Z`);

/** One shift a week of `hoursPerMonth / 4.345` hours from `from` to `to`. */
function weekly(from: string, to: string, hoursPerMonth: number): HourEntry[] {
  const out: HourEntry[] = [];
  for (let t = d(from).getTime(); t < d(to).getTime(); t += 7 * 86_400_000) out.push({ at: new Date(t + 9 * 3_600_000), hours: hoursPerMonth / 4.345 });
  return out;
}

describe('the periods', () => {
  it('the rules the settings must meet', () => {
    expect(validateAcaConfig(c)).toEqual([]);
    expect(validateAcaConfig({ ...c, measurementMonths: 2 })).toHaveLength(1);
    expect(validateAcaConfig({ ...c, adminDays: 120 })).toHaveLength(1);
    expect(validateAcaConfig({ ...c, stabilityMonths: 6 })).toHaveLength(1); // shorter than the 12-month measurement
  });
  it('the standard cycle: stability from Jan 1, measured over the 12 months ending 60 days before', () => {
    const w = standardWindowFor(c, d('2026-07-15'));
    expect(w.stabilityStart.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(w.stabilityEnd.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(w.measurementEnd.toISOString().slice(0, 10)).toBe('2025-11-02');
    expect(w.measurementStart.toISOString().slice(0, 10)).toBe('2024-11-02');
  });
  it('a new hire’s initial cycle starts the first of the next month', () => {
    const w = initialWindowFor(c, d('2026-03-10'));
    expect(w.measurementStart.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(w.measurementEnd.toISOString().slice(0, 10)).toBe('2027-04-01');
    expect(w.stabilityStart.toISOString().slice(0, 10)).toBe('2027-05-01'); // within 13 months + fraction
  });
});

describe('who is full-time', () => {
  it('an ongoing worker averaging 140 h/month in the measurement period is full-time for the stability period', () => {
    const p = { hireDate: d('2023-01-01'), classes: [], entries: weekly('2024-11-02', '2025-11-02', 140) };
    expect(basisOn(c, p, d('2026-03-01')).basis).toBe('full_time');
    const m = measure(c, p, d('2026-03-01'));
    expect(m.today).toBe('full_time');
    expect(m.offerDue).toMatchObject({ stabilityStart: '2026-01-01', reason: 'measured_full_time' });
  });
  it('125 h/month is approaching; 80 is on track', () => {
    const near = measure(c, { hireDate: d('2023-01-01'), classes: [], entries: weekly('2025-11-02', '2026-06-01', 125) }, d('2026-06-01'));
    expect(near.status).toBe('approaching');
    expect(near.offerDue).toBeNull();
    const low = measure(c, { hireDate: d('2023-01-01'), classes: [], entries: weekly('2025-11-02', '2026-06-01', 80) }, d('2026-06-01'));
    expect(low.status).toBe('on_track');
  });
  it('a worker running over 130 in the period in progress is projected full-time for the next stability period', () => {
    const m = measure(c, { hireDate: d('2023-01-01'), classes: [], entries: weekly('2025-11-02', '2026-06-01', 150) }, d('2026-06-01'));
    expect(m.offerDue).toMatchObject({ stabilityStart: '2027-01-01', reason: 'projected_full_time' });
  });
  it('a new variable-hour hire is in a limited non-assessment period until the initial stability period', () => {
    const p = { hireDate: d('2026-03-10'), classes: [], entries: weekly('2026-03-10', '2026-06-01', 150) };
    expect(basisOn(c, p, d('2026-06-01')).basis).toBe('lnap');
    expect(measure(c, p, d('2026-06-01')).inProgress?.kind).toBe('initial');
  });
  it('a worker hired full-time is full-time from the first day of the fourth month', () => {
    const p = { hireDate: d('2026-02-14'), classes: [{ classification: 'FULL_TIME' as const, effectiveFrom: d('2026-02-14') }], entries: [] };
    expect(basisOn(c, p, d('2026-04-30')).basis).toBe('lnap');
    expect(basisOn(c, p, d('2026-05-01')).basis).toBe('full_time');
    expect(measure(c, p, d('2026-03-01')).offerDue).toMatchObject({ dueBy: '2026-05-01', reason: 'hired_full_time' });
  });
  it('a 13-week break in service makes the return a new hire', () => {
    const entries = [...weekly('2025-01-06', '2025-03-01', 100), ...weekly('2025-07-01', '2025-08-01', 100)];
    expect(effectiveHireDate(c, d('2025-01-06'), entries, d('2025-09-01')).toISOString().slice(0, 10)).toBe('2025-07-01');
  });
});

describe('line 14 / 16 and exposure', () => {
  const offer = { offerCode: 'CODE_1E' as const, response: 'WAIVED' as const, lowestPremiumCents: 9_900 };
  it('codes each month from its basis and the offer', () => {
    expect(codesForMonth(c, 'not_employed', null)).toMatchObject({ offerOfCoverage: 'CODE_1H', safeHarbor: '2A' });
    expect(codesForMonth(c, 'lnap', null)).toMatchObject({ safeHarbor: '2D', isFullTime: false });
    expect(codesForMonth(c, 'not_full_time', null)).toMatchObject({ offerOfCoverage: 'CODE_1H', safeHarbor: '2B' });
    expect(codesForMonth(c, 'full_time', offer)).toMatchObject({ offerOfCoverage: 'CODE_1E', safeHarbor: '2H', isFullTime: true, lowestPremiumCents: 9_900 });
    expect(codesForMonth(c, 'full_time', { ...offer, response: 'ENROLLED' })).toMatchObject({ safeHarbor: '2C' });
    expect(codesForMonth(c, 'full_time', null)).toMatchObject({ offerOfCoverage: 'CODE_1H', safeHarbor: null });
  });
  it('4980H: under 95% offered exposes (a) on all full-time minus 30; (b) per person not offered', () => {
    expect(exposure(100, 96, 2026)).toMatchObject({ failsNinetyFive: false, a: 0, b: 4 * 5_010 });
    expect(exposure(100, 90, 2026)).toMatchObject({ failsNinetyFive: true, a: 70 * 3_340, b: 10 * 5_010 });
    expect(exposure(0, 0, 2025)).toMatchObject({ failsNinetyFive: false, a: 0, b: 0 });
  });
});
