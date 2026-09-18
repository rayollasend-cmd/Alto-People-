import { describe, expect, it } from 'vitest';
import { fmtShiftWindow, inShiftWindow, minuteOfDayInZone } from '../shiftWindow.js';

describe('shift windows', () => {
  it('a daytime window holds shifts that start inside it', () => {
    const morning = { startMinute: 6 * 60, endMinute: 14 * 60 };
    expect(inShiftWindow(6 * 60, morning)).toBe(true);
    expect(inShiftWindow(13 * 60 + 59, morning)).toBe(true);
    expect(inShiftWindow(14 * 60, morning)).toBe(false);
    expect(inShiftWindow(5 * 60 + 59, morning)).toBe(false);
  });

  it('an overnight window wraps past midnight', () => {
    const overnight = { startMinute: 22 * 60, endMinute: 6 * 60 };
    expect(inShiftWindow(22 * 60, overnight)).toBe(true);
    expect(inShiftWindow(2 * 60, overnight)).toBe(true);
    expect(inShiftWindow(6 * 60, overnight)).toBe(false);
    expect(inShiftWindow(14 * 60, overnight)).toBe(false);
  });

  it('reads the store clock, not the server clock', () => {
    // 03:30 UTC is 11:30 PM the previous evening in New York (EDT).
    expect(minuteOfDayInZone('2026-09-18T03:30:00Z', 'America/New_York')).toBe(23 * 60 + 30);
    expect(minuteOfDayInZone('2026-09-18T03:30:00Z', 'America/Los_Angeles')).toBe(20 * 60 + 30);
  });

  it('says the span the way a schedule does', () => {
    expect(fmtShiftWindow({ startMinute: 22 * 60, endMinute: 6 * 60 })).toBe('10:00 PM – 6:00 AM');
  });
});
