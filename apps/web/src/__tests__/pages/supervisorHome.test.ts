import { describe, expect, it } from 'vitest';
import { contractByStoreHour, groupWindows, nextWindows, windowsContractAt } from '@/pages/supervisorHome';

const CT = 'America/Chicago';
const w = (label: string, locationName: string, startMinute: number, endMinute: number, targetCount: number, timezone = CT) => ({
  label,
  locationName,
  locationId: locationName,
  startMinute,
  endMinute,
  targetCount,
  timezone,
});

describe('supervisor Home rules', () => {
  // 05:30Z Oct 29 = 10:30 PM Oct 28 in Los Angeles = 12:30 AM Oct 29 in Chicago:
  // a Pacific evening looking at Central stores.
  const pacificEvening = new Date('2026-10-29T05:30:00Z');

  it('nextWindows: every window starting next, on each store’s clock (FLOOR-2)', () => {
    const windows = [
      w('Morning', 'Front Beach 218', 360, 840, 3),
      w('Morning', 'Thomas Drive', 360, 840, 5),
      w('Morning', 'Destin Harbor 507', 360, 840, 3),
      w('Afternoon', 'Front Beach 218', 840, 1320, 4),
    ];
    const next = nextWindows(windows, pacificEvening);
    expect(next.map((x) => x.locationName)).toEqual(['Front Beach 218', 'Thomas Drive', 'Destin Harbor 507']);
    expect(next.reduce((n, x) => n + x.targetCount, 0)).toBe(11);
    // A 6 AM window in New York starts an hour before Chicago's: it alone is next.
    const east = w('Morning', 'Savannah', 360, 840, 6, 'America/New_York');
    expect(nextWindows([...windows, east], pacificEvening)).toEqual([east]);
    expect(nextWindows([], pacificEvening)).toEqual([]);
  });

  it('groupWindows: one line per window, its stores counted and targets summed (FLOOR-27)', () => {
    const g = groupWindows([
      w('Afternoon', 'Front Beach 218', 840, 1320, 4),
      w('Morning', 'Front Beach 218', 360, 840, 3),
      w('Morning', 'Thomas Drive', 360, 840, 5),
    ]);
    expect(g).toEqual([
      { label: 'Morning', startMinute: 360, endMinute: 840, stores: ['Front Beach 218', 'Thomas Drive'], targetCount: 8 },
      { label: 'Afternoon', startMinute: 840, endMinute: 1320, stores: ['Front Beach 218'], targetCount: 4 },
    ]);
  });

  it('contract by hour: per store-hour, never one number across the day (FLOOR-4)', () => {
    // A Chicago day: 05:00Z is midnight.
    const hours = Array.from({ length: 24 }, (_, h) => ({
      at: new Date(Date.parse('2026-10-29T05:00:00Z') + h * 3_600_000).toISOString(),
      target: h < 6 ? 2 : h < 14 ? 11 : 4,
    }));
    const byHour = contractByStoreHour(hours, CT);
    expect(byHour[1]).toBe(2);
    expect(byHour[6]).toBe(11);
    expect(byHour[20]).toBe(4);
    // From windows: overnight wraps midnight.
    const windows = [w('Overnight', 'A', 1320, 360, 2), w('Morning', 'A', 360, 840, 3), w('Morning', 'B', 360, 840, 8)];
    expect(windowsContractAt(windows, 60)).toBe(2);
    expect(windowsContractAt(windows, 6 * 60)).toBe(11);
    expect(windowsContractAt(windows, 15 * 60)).toBeNull();
  });
});
