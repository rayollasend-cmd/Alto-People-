import { describe, expect, it } from 'vitest';
import { clsSessionMax, inpFromDurations, routePattern } from '@/lib/webVitals';

describe('web vitals — the arithmetic the beacon relies on', () => {
  it('sends route patterns, never ids', () => {
    expect(routePattern('/clients/9f2e8c1a-1b2c-4d5e-8f90-1234567890ab/statements')).toBe('/clients/:id/statements');
    expect(routePattern('/onboarding/applications/48213?tab=documents')).toBe('/onboarding/applications/:id');
    expect(routePattern('/people')).toBe('/people');
    expect(routePattern('/')).toBe('/');
  });

  it('INP is the worst interaction until a page is busy enough to forgive an outlier', () => {
    expect(inpFromDurations([])).toBeNull();
    expect(inpFromDurations([40, 900, 120])).toBe(900);
    // Fifty interactions: the single worst one is forgiven, the next counts.
    const fifty = [...Array.from({ length: 49 }, () => 80), 2000];
    expect(inpFromDurations(fifty)).toBe(80);
  });

  it('CLS is the largest session window of shifts, not the lifetime sum', () => {
    expect(clsSessionMax([])).toBe(0);
    // Three shifts inside a second add up; one a minute later is its own window.
    expect(
      clsSessionMax([
        { value: 0.05, startTime: 100 },
        { value: 0.05, startTime: 400 },
        { value: 0.05, startTime: 700 },
        { value: 0.02, startTime: 60_000 },
      ]),
    ).toBeCloseTo(0.15);
  });
});
