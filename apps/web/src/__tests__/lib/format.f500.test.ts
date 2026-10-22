import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fmtCount,
  fmtDate,
  fmtDateOnly,
  fmtDateOnlyRange,
  fmtMoneyWhole,
  fmtMonth,
  fmtPhone,
  fmtStatementNo,
  fmtTimeZone,
  phoneHref,
} from '@/lib/format';
import { fmtTimeOnly } from '@/lib/dayGroup';
import { taxYearOptions } from '@/components/ui/TaxYearSelect';

/**
 * Formatting (F500 SH-2): one way to write a phone, a statement number, a
 * month, a date-only value and a time — the audit found each written two to
 * four ways, and date-only values a day early west of UTC.
 */

describe('date-only values', () => {
  const tz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterEach(() => {
    process.env.TZ = tz;
  });

  it('read as the calendar day they name, never the day before west of UTC', () => {
    // The Inbox chip: a Jan 31 deadline sent as UTC midnight read "Jan 30".
    expect(fmtDate('2026-01-31T00:00:00.000Z')).toBe('Jan 30, 2026');
    expect(fmtDateOnly('2026-01-31T00:00:00.000Z')).toBe('Jan 31, 2026');
    expect(fmtDateOnly('2026-01-31')).toBe('Jan 31, 2026');
    expect(fmtDateOnly('2026-10-16', { weekday: true, year: false })).toBe('Fri, Oct 16');
    // A US date some payloads send ("week ending 10/16/2026").
    expect(fmtDateOnly('10/16/2026', { weekday: true, year: false })).toBe('Fri, Oct 16');
    expect(fmtDateOnly(null)).toBe('—');
    expect(fmtDateOnly('not a date')).toBe('—');
  });

  it('a range says the month and the year once', () => {
    expect(fmtDateOnlyRange('2026-10-17', '2026-10-23')).toBe('Oct 17 – 23, 2026');
    expect(fmtDateOnlyRange('2026-08-29', '2026-09-11')).toBe('Aug 29 – Sep 11, 2026');
    expect(fmtDateOnlyRange('2025-12-27', '2026-01-09')).toBe('Dec 27, 2025 – Jan 9, 2026');
    // The org week arrives as UTC-midnight instants.
    expect(fmtDateOnlyRange('2026-10-17T00:00:00.000Z', '2026-10-23')).toBe('Oct 17 – 23, 2026');
  });

  it('a month is a month: "Nov 2025", "November 2025", "Nov ’25" on an axis', () => {
    expect(fmtMonth('2025-11')).toBe('Nov 2025');
    expect(fmtMonth('2026-10', 'long')).toBe('October 2026');
    expect(fmtMonth('2025-11-01T00:00:00.000Z', 'axis')).toBe('Nov ’25');
    expect(fmtMonth(undefined)).toBe('—');
  });
});

describe('times', () => {
  it('drop the seconds, except where they are the evidence (the audit log)', () => {
    const iso = new Date(2026, 9, 22, 10, 9, 22).toISOString();
    expect(fmtTimeOnly(iso)).toBe('10:09 AM');
    expect(fmtTimeOnly(iso, { seconds: true })).toBe('10:09:22 AM');
    expect(fmtTimeOnly('garbage')).toBe('—');
  });

  it('a time zone is named, not printed as its IANA id', () => {
    expect(fmtTimeZone('America/Chicago')).toBe('Central (Chicago)');
    expect(fmtTimeZone('America/Los_Angeles')).toBe('Pacific (Los Angeles)');
    expect(fmtTimeZone('UTC')).toBe('UTC');
    // Outside the app's list: the runtime's name, with the city.
    expect(fmtTimeZone('Europe/Berlin')).toMatch(/Berlin/);
    expect(fmtTimeZone('Europe/Berlin')).not.toBe('Europe/Berlin');
    expect(fmtTimeZone(null)).toBe('—');
  });
});

describe('phones', () => {
  it('one national format for every way a US number arrives', () => {
    for (const raw of ['850-555-0102', '+1-850-555-0102', '+18505550102', '8505550102', '(850) 555-0102', '850.555.0102', '1 850 555 0102']) {
      expect(fmtPhone(raw)).toBe('(850) 555-0102');
    }
    expect(fmtPhone('305-555-0101 ext 2')).toBe('(305) 555-0101 ext. 2');
    // A foreign number is shown as entered, not garbled by US rules.
    expect(fmtPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(fmtPhone('')).toBe('—');
    expect(fmtPhone(null)).toBe('—');
  });

  it('tel: links keep E.164 and the extension', () => {
    expect(phoneHref('850-555-0102')).toBe('tel:+18505550102');
    expect(phoneHref('+1 (850) 555-0102')).toBe('tel:+18505550102');
    expect(phoneHref('(305) 555-0101 ext 2')).toBe('tel:+13055550101;ext=2');
    expect(phoneHref('+44 20 7946 0958')).toBe('tel:+442079460958');
    expect(phoneHref('  ')).toBeNull();
  });
});

describe('numbers', () => {
  it('a statement number is "No. 0004" everywhere — the number on the PDF', () => {
    expect(fmtStatementNo(4)).toBe('No. 0004');
    expect(fmtStatementNo(412)).toBe('No. 0412');
    expect(fmtStatementNo(12345)).toBe('No. 12345');
    expect(fmtStatementNo(null)).toBe('Draft');
    expect(fmtStatementNo(undefined, 'Statement')).toBe('Statement');
  });

  it('whole dollars for a headline figure', () => {
    expect(fmtMoneyWhole(48210.4)).toBe('$48,210');
    expect(fmtMoneyWhole(-1250.5)).toBe('-$1,250');
    expect(fmtMoneyWhole('99.5')).toBe('$100');
    expect(fmtMoneyWhole(-0.4)).toBe('$0');
    expect(fmtMoneyWhole(null)).toBe('—');
  });

  it('a count says its noun in the singular when it is one ("1 cards" was a bug)', () => {
    expect(fmtCount(1, 'card')).toBe('1 card');
    expect(fmtCount(0, 'card')).toBe('0 cards');
    expect(fmtCount(1204, 'entry', 'entries')).toBe('1,204 entries');
    expect(fmtCount(2, 'item')).toBe('2 items');
  });

  it('the tax-year picker offers years newest first, bounded, and always the chosen one', () => {
    const now = new Date(2026, 9, 22);
    expect(taxYearOptions({ value: 2026, now })).toEqual([2026, 2025, 2024, 2023]);
    expect(taxYearOptions({ value: 2026, since: 2025, now })).toEqual([2026, 2025]);
    expect(taxYearOptions({ value: 2019, since: 2025, now })).toEqual([2026, 2025, 2019]);
    expect(taxYearOptions({ value: 2025, years: [2024, 2025], now })).toEqual([2025, 2024]);
  });
});
