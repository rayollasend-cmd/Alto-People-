import { describe, expect, it } from 'vitest';
import { TIMESHEET_QUEUE_WINDOW_DAYS, oldestPendingPeriod, timesheetQueuePath } from '../timesheetQueue.js';
import { isOpenShift, wentUnfilled } from '../openShift.js';

/**
 * The timesheet count and the queue share one link: the window the count
 * covered travels in the URL, so "6 timesheets to approve" never opens on
 * "Nothing to review" (role walk: ops 1, floor 1, HR 1).
 */
describe('timesheetQueuePath', () => {
  it('carries the pending status and the window the count covered', () => {
    expect(timesheetQueuePath({ from: '2026-09-18', to: '2026-10-21' })).toBe(
      '/time-attendance?tab=queue&status=COMPLETED&from=2026-09-18&to=2026-10-21',
    );
  });

  it('looks back 90 days, the same window every count uses', () => {
    expect(TIMESHEET_QUEUE_WINDOW_DAYS).toBe(90);
  });
});

describe('oldestPendingPeriod', () => {
  const periods = [
    { start: '2026-10-10', end: '2026-10-23', count: 0 },
    { start: '2026-09-26', end: '2026-10-09', count: 0 },
    { start: '2026-09-12', end: '2026-09-25', count: 6 },
    { start: '2026-08-29', end: '2026-09-11', count: 0 },
  ];

  it('opens on the oldest period that still has pending rows', () => {
    expect(oldestPendingPeriod(periods)?.start).toBe('2026-09-12');
  });

  it('picks the older of two pending periods, whatever the order given', () => {
    const two = [...periods, { start: '2026-08-15', end: '2026-08-28', count: 1 }];
    expect(oldestPendingPeriod(two)?.start).toBe('2026-08-15');
    expect(oldestPendingPeriod([...two].reverse())?.start).toBe('2026-08-15');
  });

  it('is null when nothing is pending', () => {
    expect(oldestPendingPeriod(periods.map((p) => ({ ...p, count: 0 })))).toBeNull();
    expect(oldestPendingPeriod([])).toBeNull();
  });
});

describe('one definition of an open shift', () => {
  const now = new Date('2026-10-21T15:00:00Z');
  it('a past OPEN shift went unfilled; it is not open', () => {
    const past = { status: 'OPEN', endsAt: '2026-10-20T22:00:00Z' };
    expect(isOpenShift(past, now)).toBe(false);
    expect(wentUnfilled(past, now)).toBe(true);
  });
  it('a future OPEN shift is open', () => {
    const future = { status: 'OPEN', endsAt: '2026-10-22T22:00:00Z' };
    expect(isOpenShift(future, now)).toBe(true);
    expect(wentUnfilled(future, now)).toBe(false);
  });
});
