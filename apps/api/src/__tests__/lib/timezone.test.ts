import { describe, expect, it } from 'vitest';
import {
  zonedDayOfWeek,
  zonedMinutes,
  zonedWallClock,
  formatTimeInZone,
  formatDateInZone,
} from '../../lib/timezone.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

describe('zonedWallClock', () => {
  it('converts a UTC instant to Eastern wall-clock day + minute (the Florida store case)', () => {
    // 2026-06-15 13:00 UTC is Monday 9:00 AM in New York (EDT, UTC-4).
    const utc = new Date('2026-06-15T13:00:00Z');
    const wc = zonedWallClock(utc, NY);
    expect(wc.dayOfWeek).toBe(1); // Monday
    expect(wc.minutes).toBe(9 * 60); // 9:00 AM = 540
  });

  it('rolls the weekday back for an evening shift that is the NEXT day in UTC', () => {
    // The exact bug the audit caught: a Friday 9:00 PM Eastern shift is
    // 01:00 UTC SATURDAY. The old getUTCDay() returned Saturday and matched
    // the wrong availability window; the zoned value must read Friday.
    const utc = new Date('2026-06-20T01:00:00Z'); // Sat 01:00 UTC
    const wc = zonedWallClock(utc, NY);
    expect(wc.dayOfWeek).toBe(5); // Friday, not Saturday
    expect(wc.minutes).toBe(21 * 60); // 9:00 PM = 1260
  });

  it('handles midnight as minute 0, not 1440', () => {
    // 2026-06-15 04:00 UTC = midnight EDT.
    const wc = zonedWallClock(new Date('2026-06-15T04:00:00Z'), NY);
    expect(wc.minutes).toBe(0);
  });

  it('gives a different wall-clock for the same instant in two zones', () => {
    const utc = new Date('2026-06-15T20:00:00Z');
    expect(zonedMinutes(utc, NY)).toBe(16 * 60); // 4 PM Eastern
    expect(zonedMinutes(utc, LA)).toBe(13 * 60); // 1 PM Pacific
  });

  it('respects DST: 14:00 UTC is 9 AM in summer (EDT) but the helper tracks the offset', () => {
    // January is EST (UTC-5): 14:00 UTC = 9:00 AM. June is EDT (UTC-4):
    // 14:00 UTC = 10:00 AM. Same UTC clock, different wall-clock — proving
    // the helper isn't using a fixed offset.
    expect(zonedMinutes(new Date('2026-01-15T14:00:00Z'), NY)).toBe(9 * 60);
    expect(zonedMinutes(new Date('2026-06-15T14:00:00Z'), NY)).toBe(10 * 60);
  });
});

describe('zonedDayOfWeek', () => {
  it('matches Date.getDay() convention (0=Sunday)', () => {
    // 2026-06-14 is a Sunday; 16:00 UTC is noon Eastern, safely same day.
    expect(zonedDayOfWeek(new Date('2026-06-14T16:00:00Z'), NY)).toBe(0);
  });
});

describe('display formatters', () => {
  it('formats time in the target zone, not UTC', () => {
    const utc = new Date('2026-06-15T13:00:00Z'); // 9 AM Eastern
    expect(formatTimeInZone(utc, NY)).toBe('9:00 AM');
  });

  it('formats the store-local date', () => {
    const utc = new Date('2026-06-15T13:00:00Z');
    expect(formatDateInZone(utc, NY)).toBe('Mon, Jun 15');
  });
});
