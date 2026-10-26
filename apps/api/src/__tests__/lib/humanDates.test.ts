import { describe, expect, it } from 'vitest';
import { calendarDay, fmtDay, fmtDayInZone, fmtDayRange, fmtMomentInZone, sentenceFromCode } from '../../lib/humanDates.js';
import { displayValues, payChangeReasonLabel } from '../../lib/approvalRequests.js';

/** Dates in text the API writes itself (bells, emails, approval summaries) — never "2026-10-26". */
const NOW = new Date('2026-10-26T15:00:00.000Z');

describe('humanDates', () => {
  it('reads a calendar day without a time zone moving it', () => {
    expect(calendarDay('2026-10-26')?.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(calendarDay('2026-10-26T00:00:00.000Z')?.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(calendarDay(new Date('2026-10-26T00:00:00.000Z'))?.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(calendarDay('not a date')).toBeNull();
    expect(calendarDay(null)).toBeNull();
  });

  it('says a day the way people do, with the year only when it is not this year', () => {
    expect(fmtDay('2026-10-26', { now: NOW })).toBe('Oct 26');
    expect(fmtDay('2027-01-31', { now: NOW })).toBe('Jan 31, 2027');
    expect(fmtDay('2026-10-26', { year: true, now: NOW })).toBe('Oct 26, 2026');
    expect(fmtDay('2026-10-30', { weekday: true, now: NOW })).toBe('Fri, Oct 30');
    expect(fmtDay(null)).toBe('—');
    // Already words: left alone.
    expect(fmtDay('Oct 26')).toBe('Oct 26');
  });

  it('says a span once', () => {
    expect(fmtDayRange('2026-10-17', '2026-10-23', { now: NOW })).toBe('Oct 17 – 23');
    expect(fmtDayRange('2026-10-30', '2026-11-05', { now: NOW })).toBe('Oct 30 – Nov 5');
    expect(fmtDayRange('2026-12-28', '2027-01-03', { now: NOW })).toBe('Dec 28, 2026 – Jan 3, 2027');
    expect(fmtDayRange('2025-10-17', '2025-10-23', { now: NOW })).toBe('Oct 17 – 23, 2025');
    expect(fmtDayRange('2026-10-17', '2026-10-17', { now: NOW })).toBe('Oct 17');
    expect(fmtDayRange('2026-10-17', '2026-10-23', { year: true, now: NOW })).toBe('Oct 17 – 23, 2026');
  });

  it('tells an instant as the day it fell on in the zone', () => {
    // 02:00 UTC on the 27th is still the 26th in New York.
    expect(fmtDayInZone(new Date('2026-10-27T02:00:00.000Z'), 'America/New_York', { now: NOW })).toBe('Oct 26');
  });

  it('turns a code into words', () => {
    expect(sentenceFromCode('MARKET_ADJUSTMENT')).toBe('Market adjustment');
    expect(sentenceFromCode('IN_PROGRESS')).toBe('In progress');
  });
});

describe('approval request display values', () => {
  it('names pay-change reasons and dates, leaves everything else alone', () => {
    expect(payChangeReasonLabel('HIRE')).toBe('New hire');
    expect(payChangeReasonLabel('PROMOTION')).toBe('Promotion');
    expect(displayValues('PAY_RATE_CHANGE', { effectiveFrom: '2026-10-26T00:00:00.000Z', reason: 'HIRE', payType: 'SALARY', amount: 50000, associateId: 'x' })).toEqual({
      effectiveFrom: 'Oct 26, 2026',
      reason: 'New hire',
      payType: 'Salary',
    });
    expect(displayValues('ROLE_CHANGE', { role: 'HR_ADMINISTRATOR', additionalRoles: [] })).toMatchObject({ additionalRoles: 'Nothing' });
    expect(displayValues('ROLE_CHANGE', { role: 'HR_ADMINISTRATOR' }).role).not.toMatch(/_/);
    expect(displayValues('REQUISITION', { status: 'DRAFT' })).toEqual({ status: 'Draft' });
    expect(displayValues('PAY_RATE_CHANGE', null)).toEqual({});
  });
});

describe('fmtMomentInZone', () => {
  it('says an instant in the company zone with the zone named — never "2026-10-26 18:00 UTC"', () => {
    expect(fmtMomentInZone(new Date('2026-10-26T22:00:00.000Z'))).toBe('Mon, Oct 26, 6:00 PM EDT');
    expect(fmtMomentInZone(new Date('2026-12-01T15:30:00.000Z'), 'America/Chicago')).toBe('Tue, Dec 1, 9:30 AM CST');
  });
});
