import { describe, expect, it } from 'vitest';
import {
  formatDateUTC,
  hoursToMinutes,
  minutesToHours,
  parseDateUTC,
} from '../../lib/timeOffRequests.js';

describe('hoursToMinutes / minutesToHours', () => {
  it('round-trips half-hour increments exactly', () => {
    for (const h of [0.5, 1, 1.5, 4, 8, 40]) {
      expect(minutesToHours(hoursToMinutes(h))).toBe(h);
    }
  });
  it('rounds 0.0166h (~1min) to 1min', () => {
    expect(hoursToMinutes(1 / 60)).toBe(1);
  });
});

describe('parseDateUTC / formatDateUTC', () => {
  it('parses YYYY-MM-DD as UTC midnight regardless of host TZ', () => {
    const d = parseDateUTC('2026-04-26');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3);
    expect(d.getUTCDate()).toBe(26);
    expect(d.getUTCHours()).toBe(0);
  });
  it('formatDateUTC pads month and day', () => {
    const d = new Date(Date.UTC(2026, 0, 5));
    expect(formatDateUTC(d)).toBe('2026-01-05');
  });
  it('rejects malformed input', () => {
    expect(() => parseDateUTC('2026/04/26')).toThrow();
    expect(() => parseDateUTC('not-a-date')).toThrow();
  });
});
