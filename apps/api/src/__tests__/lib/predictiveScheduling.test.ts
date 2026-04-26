import { describe, expect, it } from 'vitest';
import {
  PREDICTIVE_NOTICE_WINDOW_HOURS,
  evaluateShiftNotice,
  isPublishingTransition,
} from '../../lib/predictiveScheduling.js';

const NOW = new Date('2026-04-26T12:00:00.000Z');

function plusHours(h: number): Date {
  return new Date(NOW.getTime() + h * 60 * 60 * 1000);
}

describe('evaluateShiftNotice', () => {
  it('null state never requires a reason (federal default)', () => {
    const e = evaluateShiftNotice({ state: null, startsAt: plusHours(1), publishAt: NOW });
    expect(e.stateRequiresNotice).toBe(false);
    expect(e.requiresReason).toBe(false);
  });

  it('CA never requires a reason (no fair-workweek law)', () => {
    const e = evaluateShiftNotice({ state: 'CA', startsAt: plusHours(1), publishAt: NOW });
    expect(e.stateRequiresNotice).toBe(false);
    expect(e.requiresReason).toBe(false);
  });

  it('NY shift 1 hour out → requires reason', () => {
    const e = evaluateShiftNotice({ state: 'NY', startsAt: plusHours(1), publishAt: NOW });
    expect(e.stateRequiresNotice).toBe(true);
    expect(e.withinNoticeWindow).toBe(true);
    expect(e.requiresReason).toBe(true);
  });

  it('NY shift 15 days out → does NOT require reason (outside window)', () => {
    const e = evaluateShiftNotice({ state: 'NY', startsAt: plusHours(15 * 24), publishAt: NOW });
    expect(e.stateRequiresNotice).toBe(true);
    expect(e.withinNoticeWindow).toBe(false);
    expect(e.requiresReason).toBe(false);
  });

  it('exactly 14*24 hours out → boundary is "outside" (strictly less than wins)', () => {
    const e = evaluateShiftNotice({
      state: 'NY',
      startsAt: plusHours(PREDICTIVE_NOTICE_WINDOW_HOURS),
      publishAt: NOW,
    });
    expect(e.hoursToShift).toBe(PREDICTIVE_NOTICE_WINDOW_HOURS);
    expect(e.withinNoticeWindow).toBe(false);
    expect(e.requiresReason).toBe(false);
  });

  it('lowercase state is normalized', () => {
    const e = evaluateShiftNotice({ state: 'or', startsAt: plusHours(1), publishAt: NOW });
    expect(e.state).toBe('OR');
    expect(e.requiresReason).toBe(true);
  });

  it('all five fair-workweek states (NY, IL, WA, PA, OR) require notice', () => {
    for (const code of ['NY', 'IL', 'WA', 'PA', 'OR']) {
      const e = evaluateShiftNotice({ state: code, startsAt: plusHours(48), publishAt: NOW });
      expect(e.stateRequiresNotice, `${code}`).toBe(true);
      expect(e.requiresReason, `${code}`).toBe(true);
    }
  });

  it('non-covered states (FL, TX, GA, NC, VA, AZ, NJ, MA, CO) never require reason', () => {
    for (const code of ['FL', 'TX', 'GA', 'NC', 'VA', 'AZ', 'NJ', 'MA', 'CO']) {
      const e = evaluateShiftNotice({ state: code, startsAt: plusHours(2), publishAt: NOW });
      expect(e.stateRequiresNotice, `${code}`).toBe(false);
      expect(e.requiresReason, `${code}`).toBe(false);
    }
  });

  it('past start time → still inside window (negative hoursToShift)', () => {
    const e = evaluateShiftNotice({ state: 'NY', startsAt: plusHours(-3), publishAt: NOW });
    expect(e.hoursToShift).toBeLessThan(0);
    expect(e.withinNoticeWindow).toBe(true);
    expect(e.requiresReason).toBe(true);
  });
});

describe('isPublishingTransition', () => {
  it('undefined → OPEN counts (fresh create defaulting to OPEN)', () => {
    expect(isPublishingTransition(undefined, 'OPEN')).toBe(true);
    expect(isPublishingTransition(undefined, 'ASSIGNED')).toBe(true);
  });

  it('DRAFT → OPEN/ASSIGNED is publishing', () => {
    expect(isPublishingTransition('DRAFT', 'OPEN')).toBe(true);
    expect(isPublishingTransition('DRAFT', 'ASSIGNED')).toBe(true);
  });

  it('DRAFT → DRAFT is NOT publishing (still a draft)', () => {
    expect(isPublishingTransition('DRAFT', 'DRAFT')).toBe(false);
  });

  it('OPEN → ASSIGNED is NOT a re-publish (notice was already given)', () => {
    expect(isPublishingTransition('OPEN', 'ASSIGNED')).toBe(false);
  });

  it('OPEN → CANCELLED / COMPLETED is not publishing', () => {
    expect(isPublishingTransition('OPEN', 'CANCELLED')).toBe(false);
    expect(isPublishingTransition('OPEN', 'COMPLETED')).toBe(false);
  });

  it('fresh create as DRAFT is not publishing', () => {
    expect(isPublishingTransition(undefined, 'DRAFT')).toBe(false);
  });
});
