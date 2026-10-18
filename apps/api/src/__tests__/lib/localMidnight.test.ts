import { describe, expect, it } from 'vitest';
import { utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';

/** Local midnight as a UTC instant — cached per (day, zone) since payroll calls it per time entry. */
describe('utcInstantOfLocalMidnight', () => {
  it('handles both sides of a DST change', () => {
    // US spring-forward is 2026-03-08: midnight is still EST (UTC-5).
    expect(utcInstantOfLocalMidnight('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(utcInstantOfLocalMidnight('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(utcInstantOfLocalMidnight('2026-07-01', 'America/Chicago').toISOString()).toBe('2026-07-01T05:00:00.000Z');
  });

  it('gives the same answer from the cache, as a fresh Date each time', () => {
    const a = utcInstantOfLocalMidnight('2026-10-17', 'America/Los_Angeles');
    a.setUTCFullYear(1999);
    const b = utcInstantOfLocalMidnight('2026-10-17', 'America/Los_Angeles');
    expect(b.toISOString()).toBe('2026-10-17T07:00:00.000Z');
  });
});
