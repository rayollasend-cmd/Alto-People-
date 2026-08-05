import { describe, it, expect } from 'vitest';
import { fmtSize } from '@/lib/format';

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
