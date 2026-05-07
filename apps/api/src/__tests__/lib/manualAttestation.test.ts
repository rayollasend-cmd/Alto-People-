// Period boundary + status classifier tests for the manual compliance
// attestation lib. Doesn't touch the DB — purely date-arithmetic.

import { describe, expect, it } from 'vitest';
import {
  classifyStatus,
  dueDateFor,
  periodForNow,
  type AttestationConfig,
} from '../../lib/manualAttestation.js';

const monthly: AttestationConfig = {
  key: 'TEST_MONTHLY',
  label: 'Monthly test',
  description: '',
  cadence: 'MONTHLY',
  dueOffsetDays: 4, // by 5th
  reminderLeadDays: 3,
};

const weekly: AttestationConfig = {
  key: 'TEST_WEEKLY',
  label: 'Weekly test',
  description: '',
  cadence: 'WEEKLY',
  dueOffsetDays: 0, // Monday
  reminderLeadDays: 0,
};

describe('periodForNow', () => {
  it('snaps a mid-month date to month bounds (UTC)', () => {
    const now = new Date(Date.UTC(2026, 4, 14, 17, 30, 0)); // 2026-05-14
    const { periodStart, periodEnd } = periodForNow('MONTHLY', now);
    expect(periodStart.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  it('snaps a mid-week date to Mon→Sun bounds', () => {
    // 2026-05-07 is a Thursday in our calendar.
    const now = new Date(Date.UTC(2026, 4, 7, 19, 0, 0));
    const { periodStart, periodEnd } = periodForNow('WEEKLY', now);
    expect(periodStart.toISOString().slice(0, 10)).toBe('2026-05-04'); // Mon
    expect(periodEnd.toISOString().slice(0, 10)).toBe('2026-05-10'); // Sun
  });

  it('handles Sunday correctly (must land on previous Monday)', () => {
    const now = new Date(Date.UTC(2026, 4, 10, 12, 0, 0)); // 2026-05-10 Sun
    const { periodStart } = periodForNow('WEEKLY', now);
    expect(periodStart.toISOString().slice(0, 10)).toBe('2026-05-04');
  });

  it('handles Monday correctly (period starts today)', () => {
    const now = new Date(Date.UTC(2026, 4, 4, 1, 0, 0)); // 2026-05-04 Mon
    const { periodStart } = periodForNow('WEEKLY', now);
    expect(periodStart.toISOString().slice(0, 10)).toBe('2026-05-04');
  });
});

describe('dueDateFor', () => {
  it('adds dueOffsetDays to the period start', () => {
    const start = new Date(Date.UTC(2026, 4, 1));
    const due = dueDateFor(monthly, start);
    expect(due.toISOString().slice(0, 10)).toBe('2026-05-05');
  });
});

describe('classifyStatus', () => {
  const periodStart = new Date(Date.UTC(2026, 4, 1)); // May 2026
  // due = 2026-05-05; reminder window opens 3 days before = 2026-05-02

  it('returns attested when an attestation exists', () => {
    const r = classifyStatus(monthly, periodStart, true, new Date(Date.UTC(2026, 4, 10)));
    expect(r).toBe('attested');
  });

  it('upcoming before reminder window opens', () => {
    const r = classifyStatus(monthly, periodStart, false, new Date(Date.UTC(2026, 4, 1, 10, 0)));
    expect(r).toBe('upcoming');
  });

  it('due_soon during the reminder window', () => {
    const r = classifyStatus(monthly, periodStart, false, new Date(Date.UTC(2026, 4, 4, 10, 0)));
    expect(r).toBe('due_soon');
  });

  it('still due_soon on the due date itself', () => {
    const r = classifyStatus(monthly, periodStart, false, new Date(Date.UTC(2026, 4, 5, 23, 0)));
    expect(r).toBe('due_soon');
  });

  it('overdue once past the due date', () => {
    const r = classifyStatus(monthly, periodStart, false, new Date(Date.UTC(2026, 4, 6, 1, 0)));
    expect(r).toBe('overdue');
  });

  it('weekly: same Monday is due_soon (lead=0, due=Mon)', () => {
    const start = new Date(Date.UTC(2026, 4, 4));
    const r = classifyStatus(weekly, start, false, new Date(Date.UTC(2026, 4, 4, 10)));
    expect(r).toBe('due_soon');
  });
});
