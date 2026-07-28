import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  evaluateEVerifyReadiness,
  isEVerifyOverdue,
  type EVerifyReadinessInput,
} from '../../lib/everifyReadiness.js';

/** A case with nothing missing — each test knocks out one thing. */
const COMPLETE: EVerifyReadinessInput = {
  hasI9: true,
  section1CompletedAt: new Date('2026-06-01T00:00:00.000Z'),
  section2CompletedAt: new Date('2026-06-02T00:00:00.000Z'),
  citizenshipStatus: 'US_CITIZEN',
  hasReadableSsn: true,
  dob: new Date('1990-03-04'),
  hireDate: new Date('2026-06-01'),
};

describe('evaluateEVerifyReadiness', () => {
  it('reports ready when nothing is missing', () => {
    const r = evaluateEVerifyReadiness(COMPLETE);
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it.each([
    ['section1CompletedAt', 'SECTION1_INCOMPLETE'],
    ['section2CompletedAt', 'SECTION2_INCOMPLETE'],
    ['citizenshipStatus', 'NO_CITIZENSHIP'],
    ['dob', 'NO_DOB'],
    ['hireDate', 'NO_HIRE_DATE'],
  ] as const)('flags %s as %s', (field, blocker) => {
    const r = evaluateEVerifyReadiness({ ...COMPLETE, [field]: null });
    expect(r.blockers).toContain(blocker);
    expect(r.ready).toBe(false);
  });

  it('flags an unreadable SSN', () => {
    const r = evaluateEVerifyReadiness({ ...COMPLETE, hasReadableSsn: false });
    expect(r.blockers).toContain('NO_SSN');
  });

  // Without this collapse the queue would show four blockers for someone who
  // simply hasn't started, which buries the one fact that matters.
  it('collapses a missing I-9 to a single blocker', () => {
    const r = evaluateEVerifyReadiness({
      ...COMPLETE,
      hasI9: false,
      section1CompletedAt: null,
      section2CompletedAt: null,
      citizenshipStatus: null,
    });
    expect(r.blockers).toEqual(['NO_I9']);
  });

  it('reports every independent gap at once', () => {
    const r = evaluateEVerifyReadiness({
      ...COMPLETE,
      hasReadableSsn: false,
      dob: null,
      hireDate: null,
    });
    expect(r.blockers).toEqual(['NO_SSN', 'NO_DOB', 'NO_HIRE_DATE']);
  });
});

describe('addBusinessDays', () => {
  // The federal deadline is 3 BUSINESS days. Counting calendar days would
  // make a Thursday hire look overdue on Sunday, when the deadline is
  // actually Tuesday.
  it('skips the weekend', () => {
    // Thursday 2026-06-04 + 3 business days → Tuesday 2026-06-09.
    const due = addBusinessDays(new Date('2026-06-04T00:00:00'), 3);
    expect(due.getFullYear()).toBe(2026);
    expect(due.getMonth()).toBe(5);
    expect(due.getDate()).toBe(9);
  });

  it('counts a clean mid-week span without skipping', () => {
    // Monday 2026-06-01 + 3 → Thursday 2026-06-04.
    const due = addBusinessDays(new Date('2026-06-01T00:00:00'), 3);
    expect(due.getDate()).toBe(4);
  });

  it('handles a Friday hire', () => {
    // Friday 2026-06-05 + 3 → Wednesday 2026-06-10.
    const due = addBusinessDays(new Date('2026-06-05T00:00:00'), 3);
    expect(due.getDate()).toBe(10);
  });
});

describe('evaluateEVerifyReadiness — dueBy', () => {
  it('derives the deadline from the hire date', () => {
    const r = evaluateEVerifyReadiness({
      ...COMPLETE,
      hireDate: new Date('2026-06-04T00:00:00'),
    });
    expect(r.dueBy?.getDate()).toBe(9);
  });

  it('has no deadline without a hire date', () => {
    const r = evaluateEVerifyReadiness({ ...COMPLETE, hireDate: null });
    expect(r.dueBy).toBeNull();
  });
});

describe('isEVerifyOverdue', () => {
  const due = new Date('2026-06-09T00:00:00');

  it('is overdue past the deadline with no case opened', () => {
    expect(isEVerifyOverdue(due, null, new Date('2026-06-10T00:00:00'))).toBe(true);
  });

  it('is not overdue before the deadline', () => {
    expect(isEVerifyOverdue(due, null, new Date('2026-06-08T00:00:00'))).toBe(false);
  });

  // The deadline is about CREATING the case. Without this, every historical
  // hire whose case was filed late would sit in the queue permanently red,
  // and the overdue count would stop meaning "needs action today".
  it('stops being overdue once a case exists, even if opened late', () => {
    expect(
      isEVerifyOverdue(due, new Date('2026-06-30T00:00:00'), new Date('2026-07-01T00:00:00')),
    ).toBe(false);
  });

  it('is never overdue without a deadline', () => {
    expect(isEVerifyOverdue(null, null, new Date('2030-01-01T00:00:00'))).toBe(false);
  });
});
