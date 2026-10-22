import { afterEach, describe, expect, it } from 'vitest';
import { fmtClock, opsTimeZone, opsTimeZoneCity, opsToday, setOpsTimeZone } from '@/pages/ops/opsTime';

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
});
