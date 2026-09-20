import { describe, it, expect } from 'vitest';
import { fmtSize, fmtMinutes } from '@/lib/format';

/**
 * fmtSize consolidates six identical per-page byte-size formatters
 * (documents views, onboarding upload tasks, DocumentPreview) into
 * lib/format. Pin the exact output shape so a future tweak can't silently
 * fork the sizes shown next to uploads from what those pages used to show.
 */
describe('fmtSize', () => {
  it('renders sub-KB values as whole bytes', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1023)).toBe('1023 B');
  });

  it('renders KB with one decimal (binary 1024 base)', () => {
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(1536)).toBe('1.5 KB');
    expect(fmtSize(1024 * 1024 - 1)).toBe('1024.0 KB');
  });

  it('renders MB with two decimals', () => {
    expect(fmtSize(1024 * 1024)).toBe('1.00 MB');
    expect(fmtSize(2.5 * 1024 * 1024)).toBe('2.50 MB');
    // No GB tier by design — upload caps keep files in the MB range.
    expect(fmtSize(1500 * 1024 * 1024)).toBe('1500.00 MB');
  });

  it('returns the em dash for absent or non-finite input', () => {
    expect(fmtSize(null)).toBe('—');
    expect(fmtSize(undefined)).toBe('—');
    expect(fmtSize(Number.NaN)).toBe('—');
    expect(fmtSize(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

/**
 * The vans board printed raw minutes — "running about 1068 min late",
 * "seen 1529 min ago". True, and unreadable: nobody converts that in
 * their head at 6am, and a number that large means something is stuck
 * rather than merely late.
 */
describe('fmtMinutes', () => {
  it('says it the way a dispatcher would', () => {
    expect(fmtMinutes(4)).toBe('4 min');
    expect(fmtMinutes(59)).toBe('59 min');
    expect(fmtMinutes(60)).toBe('1h');
    expect(fmtMinutes(95)).toBe('1h 35m');
    expect(fmtMinutes(1068)).toBe('17h 48m');
    expect(fmtMinutes(1440)).toBe('1d');
    expect(fmtMinutes(3000)).toBe('2d 2h');
    // A whole number of days drops the trailing zero rather than saying '2d 0h'.
    expect(fmtMinutes(2900)).toBe('2d');
  });

  it('rounds to something sayable at the edges', () => {
    expect(fmtMinutes(0)).toBe('under a minute');
    expect(fmtMinutes(0.4)).toBe('under a minute');
    // A negative span is a clock-skew artefact, not time travel.
    expect(fmtMinutes(-5)).toBe('under a minute');
  });

  it('is a dash when there is no number, like the rest of the module', () => {
    expect(fmtMinutes(null)).toBe('—');
    expect(fmtMinutes(undefined)).toBe('—');
    expect(fmtMinutes(Number.NaN)).toBe('—');
  });
});
