import { afterEach, describe, expect, it } from 'vitest';
import { fmtClock, opsTimeZone, opsTimeZoneCity, opsTimeZoneLabel, opsToday, setOpsTimeZone, shiftDayKey } from '@/pages/ops/opsTime';

/**
 * The ops pages read their clock from the zone the API names (F500 SH-4):
 * a store on Central time is shown on Central time, never a zone written
 * into the code.
 */
afterEach(() => setOpsTimeZone('America/New_York'));

describe('the ops clock', () => {
  it('follows the zone the API names, and says it', () => {
    const at = '2026-10-22T18:03:00.000Z';
    expect(opsTimeZone()).toBe('America/New_York');
    expect(fmtClock(at)).toBe('2:03 PM');
    setOpsTimeZone('America/Chicago');
    expect(opsTimeZone()).toBe('America/Chicago');
    expect(opsTimeZoneCity()).toBe('Chicago');
    expect(fmtClock(at)).toBe('1:03 PM');
    expect(opsToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps the last good zone when handed nothing or nonsense', () => {
    setOpsTimeZone('America/Chicago');
    setOpsTimeZone(undefined);
    setOpsTimeZone('Not/AZone');
    expect(opsTimeZone()).toBe('America/Chicago');
  });

  it('names the zone with its abbreviation, for the label beside the times (F500 G2)', () => {
    setOpsTimeZone('America/Chicago');
    expect(opsTimeZoneLabel(new Date('2026-10-22T18:03:00.000Z'))).toBe('Chicago (CDT)');
    expect(opsTimeZoneLabel(new Date('2026-12-22T18:03:00.000Z'))).toBe('Chicago (CST)');
  });
});

describe('shiftDayKey', () => {
  it('steps calendar days on the key, across a month, a year and the fall-back weekend', () => {
    expect(shiftDayKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDayKey('2026-11-01', 1)).toBe('2026-11-02');
    expect(shiftDayKey('2026-11-02', -7)).toBe('2026-10-26');
    expect(shiftDayKey('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDayKey('2026-03-08', 0)).toBe('2026-03-08');
  });
});
