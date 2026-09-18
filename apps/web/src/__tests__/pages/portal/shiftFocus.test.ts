import { describe, expect, it } from 'vitest';
import { activeWindows, crewOnFloor, focusName, inWindows, windowOf } from '@/pages/portal/shiftFocus';

const TZ = 'America/New_York';
// 2026-09-20 in EDT (UTC−4): hh:mm New York wall clock.
const ny = (hh: number, mm = 0) => new Date(Date.UTC(2026, 8, 20, hh + 4, mm)).toISOString();

const morning = { locationId: 'l1', label: 'Morning', startMinute: 360, endMinute: 840, timezone: TZ };
const overnight = { locationId: 'l1', label: 'Overnight', startMinute: 1320, endMinute: 360, timezone: TZ };

describe('shift focus', () => {
  it('places a shift by where it STARTS, at its own store, wrapping midnight', () => {
    const at = (hh: number, locationId: string | null = 'l1') => ({ locationId, startsAt: ny(hh), timezone: TZ });
    expect(windowOf(at(23), [morning, overnight])?.label).toBe('Overnight');
    expect(windowOf(at(3), [morning, overnight])?.label).toBe('Overnight');
    expect(windowOf(at(6), [morning, overnight])?.label).toBe('Morning');
    expect(windowOf(at(15), [morning, overnight])).toBeNull();
    // Another store's shift, or a site-less one, is never in the window.
    expect(inWindows(at(7, 'l2'), [morning])).toBe(false);
    expect(inWindows(at(7, null), [morning])).toBe(false);
  });

  it('knows which windows are running now', () => {
    expect(activeWindows([morning, overnight], new Date(ny(2))).map((w) => w.label)).toEqual(['Overnight']);
    expect(activeWindows([morning, overnight], new Date(ny(16)))).toEqual([]);
  });

  it("counts the crew on the floor for the shift — scheduled by shift start, walk-ins by clock-in", () => {
    const roster = [
      { associateId: 'ann', locationId: 'l1', startsAt: ny(6), timezone: TZ, state: 'on-floor' },
      { associateId: 'ben', locationId: 'l1', startsAt: ny(14), timezone: TZ, state: 'on-floor' },
    ];
    const live = [
      { associateId: 'ann', clockInAt: ny(6) },
      { associateId: 'ben', clockInAt: ny(14) },
      // A walk-in 20 minutes before the morning starts counts for it.
      { associateId: 'wes', clockInAt: ny(5, 40) },
      // Last night's crew, off today's roster, still on at 6:30.
      { associateId: 'ola', clockInAt: ny(0, 10) },
    ];
    expect(crewOnFloor(live, roster, [morning]).map((p) => p.associateId)).toEqual(['ann', 'wes']);
    expect(crewOnFloor(live, roster, [overnight]).map((p) => p.associateId)).toEqual(['ola']);
  });

  it('names the focus', () => {
    expect(focusName([overnight])).toBe('Overnight');
    expect(focusName([morning, overnight])).toBe('Morning & Overnight');
    expect(focusName([morning, overnight, { label: 'Swing' }])).toBe('3 shifts');
  });
});
