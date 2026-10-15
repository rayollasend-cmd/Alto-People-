import { describe, expect, it } from 'vitest';
import { P95_BUDGET_MS, SCENARIOS, percentile, renderReport, summarize } from '../../lib/loadHarness.js';

describe('load harness (Brief 3-6)', () => {
  it('defines the top routes with a 2-second p95 budget each', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    const keys = new Set(SCENARIOS.map((s) => s.key));
    expect(keys.size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(s.budgetMs).toBe(P95_BUDGET_MS);
      expect(s.connections).toBeGreaterThan(0);
      expect(s.durationSeconds).toBeGreaterThan(0);
      expect(typeof s.path === 'string' ? s.path.startsWith('/') : s.path(1).startsWith('/')).toBe(true);
    }
    for (const key of ['login', 'schedule-week', 'clock-in', 'messages-send', 'people-directory', 'control-room-workers']) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it('computes nearest-rank percentiles', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
  });

  it('summarizes a run and judges it against the budget and the failure rate', () => {
    const fast = summarize({ key: 'a', title: 'A', budgetMs: 2000 }, [10, 20, 30, 40, 2500], { '200': 5 }, 0, 10);
    expect(fast.p95).toBe(2500);
    expect(fast.pass).toBe(false);
    const ok = summarize({ key: 'b', title: 'B', budgetMs: 2000 }, Array.from({ length: 200 }, (_, i) => 100 + i), { '200': 200 }, 1, 10);
    expect(ok.p95).toBe(289);
    expect(ok.rps).toBe(20);
    expect(ok.pass).toBe(true);
    const flaky = summarize({ key: 'c', title: 'C', budgetMs: 2000 }, Array.from({ length: 100 }, () => 50), { '200': 90, '500': 10 }, 10, 10);
    expect(flaky.pass).toBe(false);
  });

  it('renders a report that names the failing route and the verdict', () => {
    const results = [
      summarize({ key: 'a', title: 'Sign in', budgetMs: 2000 }, [120, 130, 140], { '200': 3 }, 0, 10),
      summarize({ key: 'b', title: 'People directory', budgetMs: 2000 }, [900, 2600, 2700], { '200': 3 }, 0, 10),
    ];
    const { markdown, pass } = renderReport({ results, scale: { workers: 50_000, sites: 1_000 }, startedAt: '2026-10-15T20:00:00Z', node: 'v24' });
    expect(pass).toBe(false);
    expect(markdown).toContain('50,000 workers across 1,000 sites');
    expect(markdown).toContain('| People directory |');
    expect(markdown).toContain('**FAIL**');
    expect(markdown).toContain('## Over budget');
    expect(markdown).toContain('People directory: p95 2700 ms');
  });
});
