import { describe, expect, it } from 'vitest';
import { judge, lastCompleteWeeks, parseExecQuery, prorateTarget, quarterOf, resolveExecWindow } from '../../lib/execPeriods.js';

/**
 * The executive frame (lib/execPeriods): which days "the week", "October to
 * date" and "Q4 to date" cover, what each is read against, and how a
 * quarter's plan is spread over a span. The company calendar is the default
 * branding's: weeks Saturday → Friday, America/New_York.
 */

// Tuesday 2026-10-27, 12:00 New York.
const NOW = new Date('2026-10-27T16:00:00.000Z');

describe('the executive period frame', () => {
  it('reads unknown query values as the defaults instead of failing', () => {
    expect(parseExecQuery({})).toEqual({ period: 'quarter', compare: 'prior' });
    expect(parseExecQuery({ period: 'decade', compare: 'vibes' })).toEqual({ period: 'quarter', compare: 'prior' });
    expect(parseExecQuery({ period: 'quarter', compare: 'plan' })).toEqual({ period: 'quarter', compare: 'plan' });
  });

  it('the week is the last complete Saturday-to-Friday week, read against the one before', () => {
    const w = resolveExecWindow('week', 'prior', NOW, { planSet: false });
    expect(w.period).toMatchObject({ start: '2026-10-17', end: '2026-10-23', complete: true, elapsedPct: 100, label: 'Week of Oct 17' });
    expect(w.comparison).toMatchObject({ start: '2026-10-10', end: '2026-10-16', available: true, label: 'vs the week of Oct 10' });
  });

  it('a to-date period is read against the previous period, the same number of days in', () => {
    const m = resolveExecWindow('month', 'prior', NOW, { planSet: false });
    expect(m.period).toMatchObject({ start: '2026-10-01', end: '2026-10-27', complete: false, label: 'October to date' });
    expect(m.comparison).toMatchObject({ start: '2026-09-01', end: '2026-09-27', label: 'vs September, same days' });
    const q = resolveExecWindow('quarter', 'prior', NOW, { planSet: false });
    expect(q.period).toMatchObject({ start: '2026-10-01', label: 'Q4 to date' });
    expect(q.period.elapsedPct).toBe(29);
    expect(q.comparison).toMatchObject({ start: '2026-07-01', end: '2026-07-27', label: 'vs Q3, same days' });
  });

  it('the year comparison is the same span a year earlier; the plan needs a plan', () => {
    const y = resolveExecWindow('quarter', 'year', NOW, { planSet: false });
    expect(y.comparison).toMatchObject({ start: '2025-10-01', end: '2025-10-27', label: 'vs the same span of 2025' });
    const none = resolveExecWindow('quarter', 'plan', NOW, { planSet: false });
    expect(none.comparison).toMatchObject({ available: false, reason: 'No plan is set for Q4 2026.', start: null });
    expect(resolveExecWindow('quarter', 'plan', NOW, { planSet: true }).comparison.available).toBe(true);
  });

  it('spreads a quarter’s plan evenly over its days, and needs every touched quarter set', () => {
    const q4 = quarterOf(NOW);
    expect(q4.key).toBe('2026-Q4');
    const w = resolveExecWindow('quarter', 'plan', NOW, { planSet: true });
    const plan = prorateTarget(new Map([['2026-Q4', 920_000]]), w.from, w.to)!;
    // 26.67 of Q4's 92 days.
    expect(plan).toBeGreaterThan(260_000);
    expect(plan).toBeLessThan(270_000);
    const year = resolveExecWindow('year', 'plan', NOW, { planSet: true });
    expect(prorateTarget(new Map([['2026-Q4', 920_000]]), year.from, year.to)).toBeNull();
  });

  it('judges against the plan with a 5% band, else against thresholds', () => {
    expect(judge(100, 'up', { target: 100 })).toEqual({ status: 'good', label: 'On plan' });
    expect(judge(96, 'up', { target: 100 }).status).toBe('watch');
    expect(judge(90, 'up', { target: 100 }).status).toBe('bad');
    expect(judge(28, 'down', { good: 30, watch: 45 }).status).toBe('good');
    expect(judge(50, 'down', { good: 30, watch: 45 }).status).toBe('bad');
    expect(judge(5, 'up', {})).toEqual({ status: 'none', label: 'No plan set' });
    expect(judge(null, 'up', { target: 1 }).status).toBe('none');
  });

  it('lists complete weeks oldest first, ending with the last complete one', () => {
    const weeks = lastCompleteWeeks(NOW, 3).map((d) => d.toISOString().slice(0, 10));
    expect(weeks).toEqual(['2026-10-03', '2026-10-10', '2026-10-17']);
  });
});
