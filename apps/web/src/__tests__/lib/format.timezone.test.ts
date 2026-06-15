import { describe, it, expect } from 'vitest';
import {
  zonedWallTimeToUtc,
  localInputToUtcIso,
  utcToZonedDatetimeInput,
  zonedDayKey,
  zonedMinutesOfDay,
} from '@/lib/format';

/**
 * Regression for the "shift time shifts by the admin↔site offset" bug.
 *
 * The scheduling grid renders every shift in its WORK SITE's zone. Before the
 * fix, the create/edit dialogs interpreted the times an admin TYPED in the
 * admin's BROWSER zone, then stored UTC — so a CA admin entering "4am" for a
 * FL (Eastern) store stored 4am Pacific (= 7am Eastern), and both the admin's
 * published view and the associate's app showed the shift 3h late.
 *
 * The helpers below interpret typed wall-clock in the SITE zone, killing the
 * skew regardless of where the admin sits.
 */
describe('zone-aware shift time entry', () => {
  it('interprets a typed wall-clock in the work-site zone, not the browser', () => {
    // 4:00 AM at an Eastern store on a summer (EDT, UTC-4) day → 08:00 UTC.
    const utc = zonedWallTimeToUtc(2026, 6, 13, 4, 0, 'America/New_York');
    expect(utc.toISOString()).toBe('2026-06-13T08:00:00.000Z');
  });

  it('localInputToUtcIso round-trips a datetime-local value through the site zone', () => {
    expect(localInputToUtcIso('2026-06-13T04:00', 'America/New_York')).toBe(
      '2026-06-13T08:00:00.000Z',
    );
    // A Pacific store: 4am PDT (UTC-7) → 11:00 UTC. Same wall-clock, different
    // instant — exactly what makes the site zone (not the browser) the source
    // of truth.
    expect(localInputToUtcIso('2026-06-13T04:00', 'America/Los_Angeles')).toBe(
      '2026-06-13T11:00:00.000Z',
    );
  });

  it('seeds the editor with the site-local wall-clock (symmetric round-trip)', () => {
    // The instant we stored for 4am Eastern must render back as 04:00 in the
    // editor when shown in the store zone — what the admin originally typed.
    expect(
      utcToZonedDatetimeInput('2026-06-13T08:00:00.000Z', 'America/New_York'),
    ).toBe('2026-06-13T04:00');
  });

  it('handles winter (standard time) offsets too', () => {
    // Jan 13 is EST (UTC-5): 9am EST → 14:00 UTC.
    expect(localInputToUtcIso('2026-01-13T09:00', 'America/New_York')).toBe(
      '2026-01-13T14:00:00.000Z',
    );
  });

  it('falls back to browser-local when no zone is given (location-less shift)', () => {
    // No timezone → the wall-clock is the browser's local time. We can't assert
    // a fixed UTC (CI zone varies), but the round-trip through the same path
    // must be stable.
    const iso = localInputToUtcIso('2026-06-13T04:00', null);
    expect(utcToZonedDatetimeInput(iso, null)).toBe('2026-06-13T04:00');
  });
});

/**
 * Regression for the grid "wrong day column / wrong vertical position" class:
 * a shift near midnight buckets and positions by the STORE zone, not the
 * browser zone, so it lands in its real column at its real hour.
 */
describe('zone-aware grid bucketing & placement', () => {
  it('buckets a late-night shift into its store-local day, not the browser day', () => {
    // 11:30pm Eastern on Jun 12 = 03:30 UTC Jun 13. In Pacific that instant is
    // 8:30pm Jun 12. The grid must file it under the STORE day (Jun 12 ET).
    const instant = '2026-06-13T03:30:00.000Z';
    expect(zonedDayKey(instant, 'America/New_York')).toBe('2026-06-12');
    // And a just-after-midnight Eastern shift lands on the NEXT store day even
    // though it's still "yesterday" for a Pacific viewer.
    const past = '2026-06-13T04:15:00.000Z'; // 12:15am ET Jun 13 (= 9:15pm PT Jun 12)
    expect(zonedDayKey(past, 'America/New_York')).toBe('2026-06-13');
    expect(zonedDayKey(past, 'America/Los_Angeles')).toBe('2026-06-12');
  });

  it('positions a chip by its store-local minutes-from-midnight', () => {
    // 12:15am ET → 15 minutes past midnight in the Eastern grid.
    expect(zonedMinutesOfDay('2026-06-13T04:15:00.000Z', 'America/New_York')).toBe(15);
    // Same instant in Pacific → 21:15 = 1275 minutes.
    expect(zonedMinutesOfDay('2026-06-13T04:15:00.000Z', 'America/Los_Angeles')).toBe(
      21 * 60 + 15,
    );
  });
});
