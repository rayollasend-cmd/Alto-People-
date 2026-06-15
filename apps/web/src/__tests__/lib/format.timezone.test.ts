import { describe, it, expect } from 'vitest';
import {
  zonedWallTimeToUtc,
  localInputToUtcIso,
  utcToZonedDatetimeInput,
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
