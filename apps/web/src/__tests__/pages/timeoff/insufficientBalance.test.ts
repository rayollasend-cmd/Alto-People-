import { describe, expect, it } from 'vitest';
import type { TimeOffRequest } from '@alto-people/shared';
import { isInsufficient } from '@/pages/timeoff/AdminTimeOffView';

/**
 * This predicate does not just colour a number red — it disables both
 * approve buttons. So anything it returns true for is a request nobody
 * can action from the list, and it had better be a request that genuinely
 * needs hours behind it.
 */

const req = (over: Partial<TimeOffRequest>): TimeOffRequest =>
  ({
    id: 'r1',
    category: 'VACATION',
    status: 'PENDING',
    startDate: '2026-05-04',
    endDate: '2026-05-04',
    requestedMinutes: 480,
    balanceMinutes: 0,
    ...over,
  }) as TimeOffRequest;

describe('isInsufficient', () => {
  it('holds an accruing category that would over-draw', () => {
    expect(isInsufficient(req({ category: 'VACATION', balanceMinutes: 60 }))).toBe(true);
    expect(isInsufficient(req({ category: 'PTO', balanceMinutes: 0 }))).toBe(true);
  });

  it('lets an accruing category through when the hours are there', () => {
    expect(isInsufficient(req({ category: 'VACATION', balanceMinutes: 480 }))).toBe(false);
  });

  it('never blocks leave the event grants, banked or not', () => {
    // The approver was left with two disabled buttons and a tooltip
    // explaining that a bank nobody funds was empty.
    for (const category of ['BEREAVEMENT', 'JURY_DUTY'] as const) {
      expect(isInsufficient(req({ category, balanceMinutes: 0 }))).toBe(false);
      expect(isInsufficient(req({ category, balanceMinutes: null }))).toBe(false);
      // Even where an employer banks it and the request runs past it.
      expect(isInsufficient(req({ category, balanceMinutes: 60 }))).toBe(false);
    }
  });

  it('says nothing when the server sent no balance at all', () => {
    expect(isInsufficient(req({ balanceMinutes: null }))).toBe(false);
    expect(isInsufficient(req({ balanceMinutes: undefined }))).toBe(false);
  });
});
