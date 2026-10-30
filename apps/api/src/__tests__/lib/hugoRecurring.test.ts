import { describe, expect, it } from 'vitest';
import { nextRunAt, recurringKey, runsOn } from '../../lib/hugoRecurring.js';
import { timeOf } from '../../lib/hugoRecurringChat.js';
import { clockLabel, scheduleLabel } from '../../lib/hugoRecurringCopy.js';
import { normalizeHugoText } from '../../lib/hugo.js';
import { localDateKey, zonedWallClock } from '../../lib/timezone.js';

/**
 * Recurring briefs, the clock (lib/hugoRecurring): the next run is the
 * schedule's wall time on the next day it runs, on the person's own clock —
 * 7:00 AM stays 7:00 AM across a daylight-saving change, weekdays skip the
 * weekend, a weekly brief waits for its day. And the chat's reading of
 * "at 7", "7pm", "a las 7 de la tarde", "saat 7".
 */

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
const wall = (d: Date, tz: string) => {
  const w = zonedWallClock(d, tz);
  return `${localDateKey(d, tz)} ${String(Math.floor(w.minutes / 60)).padStart(2, '0')}:${String(w.minutes % 60).padStart(2, '0')}`;
};

describe('next run', () => {
  it('every day: the next 7:00 AM on the person’s clock', () => {
    // Fri Oct 30 2026, 8:00 AM in New York (EDT): today’s 7:00 has passed.
    const next = nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: NY }, at('2026-10-30T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-31T11:00:00.000Z');
    expect(wall(next, NY)).toBe('2026-10-31 07:00');
    // Before 7:00 it is today’s.
    expect(nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: NY }, at('2026-10-30T10:00:00Z')).toISOString()).toBe('2026-10-30T11:00:00.000Z');
  });

  it('stays at 7:00 AM across the fall-back change (Nov 1 2026) — the UTC hour moves, the wall time doesn’t', () => {
    const s = { cadence: 'DAILY' as const, weekday: null, time: '07:00', timezone: NY };
    const sat = nextRunAt(s, at('2026-10-30T12:00:00Z'));
    const sun = nextRunAt(s, sat);
    const mon = nextRunAt(s, sun);
    expect([sat, sun, mon].map((d) => d.toISOString())).toEqual(['2026-10-31T11:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z']);
    expect([sat, sun, mon].map((d) => wall(d, NY))).toEqual(['2026-10-31 07:00', '2026-11-01 07:00', '2026-11-02 07:00']);
    // The day itself is 25 hours long: Sat 7:00 → Sun 7:00.
    expect(sun.getTime() - sat.getTime()).toBe(25 * 3_600_000);
  });

  it('stays at 7:00 AM across the spring-forward change (Mar 14 2027)', () => {
    const s = { cadence: 'DAILY' as const, weekday: null, time: '07:00', timezone: NY };
    const sat = nextRunAt(s, at('2027-03-13T11:00:00Z'));
    const sun = nextRunAt(s, sat);
    expect(wall(sat, NY)).toBe('2027-03-13 07:00');
    expect(wall(sun, NY)).toBe('2027-03-14 07:00');
    expect(sun.getTime() - sat.getTime()).toBe(23 * 3_600_000);
  });

  it('a time inside the skipped hour lands on a real instant that day, and the next day is 2:30 again', () => {
    const s = { cadence: 'DAILY' as const, weekday: null, time: '02:30', timezone: NY };
    const skipped = nextRunAt(s, at('2027-03-14T05:00:00Z'));
    expect(localDateKey(skipped, NY)).toBe('2027-03-14');
    expect(wall(skipped, NY)).not.toBe('2027-03-14 02:30');
    expect(wall(nextRunAt(s, skipped), NY)).toBe('2027-03-15 02:30');
  });

  it('weekdays skip the weekend; weekly waits for its day', () => {
    // Friday 8:00 AM New York.
    const fri = at('2026-10-30T12:00:00Z');
    expect(wall(nextRunAt({ cadence: 'WEEKDAYS', weekday: null, time: '07:00', timezone: NY }, fri), NY)).toBe('2026-11-02 07:00');
    expect(wall(nextRunAt({ cadence: 'WEEKDAYS', weekday: null, time: '09:00', timezone: NY }, fri), NY)).toBe('2026-10-30 09:00');
    // Every Friday at 4 PM: today’s, then a week later.
    const first = nextRunAt({ cadence: 'WEEKLY', weekday: 5, time: '16:00', timezone: NY }, fri);
    expect(wall(first, NY)).toBe('2026-10-30 16:00');
    expect(wall(nextRunAt({ cadence: 'WEEKLY', weekday: 5, time: '16:00', timezone: NY }, first), NY)).toBe('2026-11-06 16:00');
    // Every Monday at 9: from a Wednesday.
    expect(wall(nextRunAt({ cadence: 'WEEKLY', weekday: 1, time: '09:00', timezone: NY }, at('2026-10-28T15:00:00Z')), NY)).toBe('2026-11-02 09:00');
    expect([0, 1, 5, 6].map((d) => runsOn({ cadence: 'WEEKDAYS', weekday: null }, d))).toEqual([false, true, true, false]);
  });

  it('reads the time on the zone it is given: the same 7:00 is three different instants on three coasts', () => {
    const after = at('2026-10-28T00:00:00Z');
    const times = ['America/New_York', 'America/Chicago', 'America/Los_Angeles'].map((tz) => nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: tz }, after).toISOString());
    expect(times).toEqual(['2026-10-28T11:00:00.000Z', '2026-10-28T12:00:00.000Z', '2026-10-28T14:00:00.000Z']);
    // No daylight saving in Istanbul: always UTC+3.
    expect(nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: 'Europe/Istanbul' }, at('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-02T04:00:00.000Z');
  });
});

describe('the same brief asked twice is one brief', () => {
  it('keys on what, how often, which day, what time and the question', () => {
    const base = { kind: 'RECURRING' as const, what: 'SCHEDULE' as const, cadence: 'DAILY' as const, time: '07:00' };
    expect(recurringKey(base)).toBe(recurringKey({ ...base }));
    expect(recurringKey(base)).not.toBe(recurringKey({ ...base, time: '08:00' }));
    // A weekday on a daily brief means nothing.
    expect(recurringKey({ ...base, weekday: 3 })).toBe(recurringKey(base));
    const ask = { ...base, what: 'ASK' as const };
    expect(recurringKey({ ...ask, question: 'What is new?' })).toBe(recurringKey({ ...ask, question: ' what is new? ' }));
    expect(recurringKey({ ...ask, question: 'What is new?' })).not.toBe(recurringKey({ ...ask, question: 'Anything else?' }));
  });
});

describe('the chat reads a time', () => {
  const read = (words: string, part: Parameters<typeof timeOf>[1] = null) => timeOf(normalizeHugoText(words), part);
  it('in the app’s languages, with the part of the day deciding AM or PM', () => {
    expect(read('remind me every day at 7 of my next shift')).toBe('07:00');
    expect(read('every day at 5 tell me my shifts')).toBe('17:00');
    expect(read('every day at 5 in the morning', 'morning')).toBe('05:00');
    expect(read('every friday at 4pm tell me my hours')).toBe('16:00');
    expect(read('daily at 7:30 am')).toBe('07:30');
    expect(read('every day at 16:00')).toBe('16:00');
    expect(read('every day at 12am')).toBe('00:00');
    expect(read('every day at 12 pm')).toBe('12:00');
    expect(read('cada día a las 7 de la tarde', 'afternoon')).toBe('19:00');
    expect(read('her sabah saat 7’de hatırlat', 'morning')).toBe('07:00');
    expect(read('todos os dias às 7h30')).toBe('07:30');
    expect(read('every friday tell me my hours')).toBeNull();
    expect(read('every day at 25')).toBeNull();
  });
});

describe('the schedule in words', () => {
  it('six languages, the reader’s clock format', () => {
    expect(scheduleLabel({ cadence: 'WEEKLY', weekday: 5, time: '16:00' }, 'en')).toBe('every Friday at 4:00 PM');
    expect(scheduleLabel({ cadence: 'DAILY', weekday: null, time: '07:00' }, 'en')).toBe('every day at 7:00 AM');
    expect(scheduleLabel({ cadence: 'WEEKDAYS', weekday: null, time: '07:00' }, 'en')).toBe('every weekday at 7:00 AM');
    expect(scheduleLabel({ cadence: 'WEEKLY', weekday: 5, time: '16:00' }, 'es')).toMatch(/^cada viernes a las 4:00/);
    expect(scheduleLabel({ cadence: 'WEEKLY', weekday: 5, time: '16:00' }, 'tr')).toBe('her Cuma saat 16:00');
    expect(scheduleLabel({ cadence: 'WEEKLY', weekday: 6, time: '09:00' }, 'pt')).toBe('todo sábado às 9:00');
    expect(scheduleLabel({ cadence: 'WEEKLY', weekday: 5, time: '09:00' }, 'uk')).toBe('кожної пʼятниці о 9:00');
    expect(clockLabel('00:30', 'en')).toBe('12:30 AM');
  });
});
