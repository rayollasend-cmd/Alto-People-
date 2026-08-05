import { describe, it, expect } from 'vitest';
import {
  browserTimeZone,
  fmtDayHeaderTz,
  fmtMonthYearTz,
  fmtRelativeDayTz,
  fmtShiftRangeTz,
  localInputToUtcIso,
  tzAbbrev,
  utcToZonedDatetimeInput,
  zonedDayKey,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
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

/**
 * The shared shift-display helpers: every associate-facing surface (schedule
 * list, dashboard card, swap cards) renders through these, so their behavior
 * IS the display contract.
 */
describe('fmtShiftRangeTz', () => {
  // 7am–3pm EDT on Jun 13 2026.
  const start = '2026-06-13T11:00:00.000Z';
  const end = '2026-06-13T19:00:00.000Z';

  it('renders the range in the store zone with times only (same store day)', () => {
    expect(fmtShiftRangeTz(start, end, 'America/New_York')).toContain(
      '7:00 AM – 3:00 PM',
    );
  });

  it('annotates a cross-midnight shift with the end date', () => {
    // 11pm Jun 13 → 7am Jun 14 Eastern.
    const r = fmtShiftRangeTz(
      '2026-06-14T03:00:00.000Z',
      '2026-06-14T11:00:00.000Z',
      'America/New_York',
    );
    expect(r).toContain('11:00 PM – 7:00 AM (Jun 14)');
  });

  it('appends the zone abbreviation only when the viewer is elsewhere', () => {
    // Pick a zone guaranteed to differ from wherever this test runs.
    const other =
      browserTimeZone() === 'America/New_York'
        ? 'America/Chicago'
        : 'America/New_York';
    expect(fmtShiftRangeTz(start, end, other)).toContain(tzAbbrev(other, start));
    // And the viewer's own zone gets no suffix noise.
    const local = fmtShiftRangeTz(start, end, browserTimeZone());
    expect(local).not.toContain(tzAbbrev(browserTimeZone(), start));
  });
});

/**
 * The calendar views' day/month headers. Before these helpers, the admin
 * views hand-rolled `toLocaleDateString([], …)` — browser locale AND
 * browser zone — so an admin's headers could read differently from the
 * associate surfaces (which render en-US through format.ts). These pin
 * both: en-US always, and the STORE zone when one is passed.
 */
describe('fmtDayHeaderTz', () => {
  // 11:30pm Eastern on Fri Jun 12 = 03:30 UTC Sat Jun 13 — a zone that
  // differs from any CI runner's clock on at least one side of midnight.
  const instant = '2026-06-13T03:30:00.000Z';

  it('renders the store-local day, not the runner-local one', () => {
    expect(fmtDayHeaderTz(instant, 'America/New_York')).toBe('Friday, Jun 12');
    expect(fmtDayHeaderTz(instant, 'UTC')).toBe('Saturday, Jun 13');
  });

  it('appends the year on request', () => {
    expect(fmtDayHeaderTz(instant, 'America/New_York', { year: true })).toBe(
      'Friday, Jun 12, 2026',
    );
  });

  it('formats a calendar anchor by its own local Y/M/D when no zone is given', () => {
    // Anchor Dates (local midnight) ARE the day identity the grids bucket
    // by — the label must match ymd(anchor) in every runner zone.
    expect(fmtDayHeaderTz(new Date(2026, 5, 13))).toBe('Saturday, Jun 13');
  });

  it('is en-US regardless of the runner locale, and dashes null', () => {
    expect(fmtDayHeaderTz(null)).toBe('—');
    expect(fmtDayHeaderTz('not a date')).toBe('—');
  });
});

describe('fmtMonthYearTz', () => {
  it('names the store-local month across a month boundary', () => {
    // 10pm Eastern Jun 30 = 02:00 UTC Jul 1.
    const instant = '2026-07-01T02:00:00.000Z';
    expect(fmtMonthYearTz(instant, 'America/New_York')).toBe('June 2026');
    expect(fmtMonthYearTz(instant, 'UTC')).toBe('July 2026');
  });

  it('formats a first-of-month anchor without a zone', () => {
    expect(fmtMonthYearTz(new Date(2026, 3, 1))).toBe('April 2026');
    expect(fmtMonthYearTz(null)).toBe('—');
  });
});

describe('fmtRelativeDayTz', () => {
  // "now" = Jun 13 2026, noon Eastern.
  const now = new Date('2026-06-13T16:00:00.000Z').getTime();

  it('labels the store-local day relative to now', () => {
    expect(fmtRelativeDayTz('2026-06-13T21:00:00.000Z', 'America/New_York', now)).toBe(
      'Today',
    );
    expect(fmtRelativeDayTz('2026-06-14T13:00:00.000Z', 'America/New_York', now)).toBe(
      'Tomorrow',
    );
    expect(fmtRelativeDayTz('2026-06-20T13:00:00.000Z', 'America/New_York', now)).toBe(
      'Sat, Jun 20',
    );
  });

  it('evaluates Today in the STORE zone, not the browser zone', () => {
    // 10pm Pacific Jun 13 = 1am Eastern Jun 14: Today for the Pacific store,
    // Tomorrow for an Eastern one — the store's answer is the right one.
    const instant = '2026-06-14T05:00:00.000Z';
    expect(fmtRelativeDayTz(instant, 'America/Los_Angeles', now)).toBe('Today');
    expect(fmtRelativeDayTz(instant, 'America/New_York', now)).toBe('Tomorrow');
  });

  // "Tomorrow" used to be computed as now + 86_400_000. US clocks fall back
  // on Nov 1 2026, so that local day runs 25 hours (00:00 EDT = 04:00Z
  // through 00:00 EST = 05:00Z next day). Within the first hour of it,
  // now + 24h is STILL today, so the label silently degraded to "Mon, Nov 2"
  // on the associate's schedule. Deriving it from today's calendar key
  // instead makes the length of the day irrelevant.
  //
  // The window matters: pick a `now` later in the day and the old code
  // happens to be right, which is why this bug survived. 00:30 local is
  // inside it.
  it('says Tomorrow in the first hour of a 25-hour fall-back day', () => {
    const fallBackNow = new Date('2026-11-01T04:30:00.000Z').getTime();
    expect(zonedDayKey(new Date(fallBackNow), 'America/New_York')).toBe(
      '2026-11-01',
    );
    // The old instant-based math landed back on Nov 1 from here:
    expect(
      zonedDayKey(new Date(fallBackNow + 86_400_000), 'America/New_York'),
    ).toBe('2026-11-01');
    // ...but noon Eastern on Nov 2 is still tomorrow.
    expect(
      fmtRelativeDayTz('2026-11-02T17:00:00.000Z', 'America/New_York', fallBackNow),
    ).toBe('Tomorrow');
    expect(
      fmtRelativeDayTz('2026-11-01T20:00:00.000Z', 'America/New_York', fallBackNow),
    ).toBe('Today');
  });

  // Spring-forward doesn't break the old arithmetic (a 23-hour day makes
  // now + 24h overshoot INTO tomorrow, which is the right answer by
  // accident). Pinned so the calendar-key rewrite doesn't regress it.
  it('still says Tomorrow across a 23-hour spring-forward day', () => {
    const springNow = new Date('2026-03-08T05:30:00.000Z').getTime();
    expect(
      fmtRelativeDayTz('2026-03-09T16:00:00.000Z', 'America/New_York', springNow),
    ).toBe('Tomorrow');
    expect(
      fmtRelativeDayTz('2026-03-08T22:00:00.000Z', 'America/New_York', springNow),
    ).toBe('Today');
  });

  it('rolls Tomorrow across a month and a year boundary', () => {
    const endOfMonth = new Date('2026-01-31T17:00:00.000Z').getTime();
    expect(
      fmtRelativeDayTz('2026-02-01T17:00:00.000Z', 'America/New_York', endOfMonth),
    ).toBe('Tomorrow');
    const endOfYear = new Date('2026-12-31T17:00:00.000Z').getTime();
    expect(
      fmtRelativeDayTz('2027-01-01T17:00:00.000Z', 'America/New_York', endOfYear),
    ).toBe('Tomorrow');
  });
});
