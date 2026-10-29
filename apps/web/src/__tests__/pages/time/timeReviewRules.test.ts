import { describe, expect, it } from 'vitest';
import { approveAtShiftEndUseful, reviewActions } from '@/pages/time/entryActions';
import { timesheetStage } from '@/pages/time/timesheetStage';

type Entry = Parameters<typeof reviewActions>[0];

describe('one action set for a punch under review (deep audit FLOOR-22)', () => {
  const forgot: Entry = {
    status: 'COMPLETED',
    anomalies: ['FORGOT_CLOCKOUT'],
    clockOutAt: '2026-10-28T03:00:00.000Z',
    shiftEndsAt: '2026-10-27T19:00:00.000Z',
  };

  it('a forgotten clock-out left running gets Fix time, Approve at shift end, Approve, Reject', () => {
    expect(reviewActions({ ...forgot }, { own: false })).toEqual([
      'fix',
      'approveAtShiftEnd',
      'approve',
      'reject',
    ]);
  });

  it('no "approve at shift end" when the auto clock-out already set it there', () => {
    const auto: Entry = { ...forgot, clockOutAt: forgot.shiftEndsAt ?? null };
    expect(approveAtShiftEndUseful(auto)).toBe(false);
    expect(reviewActions(auto, { own: false })).toEqual(['fix', 'approve', 'reject']);
    // A few seconds apart is still the same minute.
    expect(approveAtShiftEndUseful({ ...auto, clockOutAt: '2026-10-27T19:00:20.000Z' })).toBe(false);
  });

  it('needs a scheduled end and the forgot-clock-out flag', () => {
    expect(approveAtShiftEndUseful({ ...forgot, anomalies: ['NO_BREAK'] })).toBe(false);
    expect(approveAtShiftEndUseful({ ...forgot, shiftEndsAt: null })).toBe(false);
    expect(approveAtShiftEndUseful({ ...forgot, status: 'APPROVED' })).toBe(false);
  });

  it('your own entry gets no decision', () => {
    expect(reviewActions({ ...forgot }, { own: true })).toEqual([]);
  });

  it('an approved entry can only be fixed or rejected', () => {
    expect(reviewActions({ status: 'APPROVED', anomalies: [], clockOutAt: forgot.clockOutAt }, { own: false })).toEqual(['fix', 'reject']);
  });
});

describe('Client hours status follows the week end to end (deep audit FLOOR-21)', () => {
  const fg = {
    registered: true,
    workerId: null,
    enteredAt: null,
    enteredBy: null,
    enteredHours: null,
    status: null,
    timesheetId: null,
    revision: null,
    hours: null,
    syncedAt: null,
  };

  it('Fieldglass says Submitted — the row says Submitted, not "Ready to submit"', () => {
    expect(timesheetStage({ status: 'READY', fieldglass: { ...fg, status: 'SUBMITTED' } })).toMatchObject({ label: 'Submitted', variant: 'info' });
    expect(timesheetStage({ status: 'READY', fieldglass: { ...fg, status: 'SUBMITTED', resubmittedAt: '2026-10-20T00:00:00Z' } }).label).toBe('Resubmitted');
    expect(timesheetStage({ status: 'READY', fieldglass: { ...fg, status: 'APPROVED' } }).label).toBe('Approved');
    expect(timesheetStage({ status: 'READY', fieldglass: { ...fg, status: 'REJECTED' } }).variant).toBe('destructive');
  });

  it('time still waiting in Alto reads Pending approval whatever Fieldglass holds', () => {
    expect(timesheetStage({ status: 'PENDING', fieldglass: { ...fg, status: 'SUBMITTED' } }).label).toBe('Pending approval');
  });

  it('approved and not in Fieldglass yet is Ready to submit; ticked is Entered', () => {
    expect(timesheetStage({ status: 'READY', fieldglass: fg }).label).toBe('Ready to submit');
    expect(timesheetStage({ status: 'READY', fieldglass: null }).label).toBe('Ready to submit');
    expect(timesheetStage({ status: 'READY', fieldglass: { ...fg, enteredAt: '2026-10-20T00:00:00Z' } }).label).toBe('Entered');
  });
});
