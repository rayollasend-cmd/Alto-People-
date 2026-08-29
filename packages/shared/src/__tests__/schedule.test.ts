import { describe, expect, it } from 'vitest';
import { paidMinutesForRange } from '../schedule.js';

describe('paidMinutesForRange (unpaid-break rule)', () => {
  it('a 9h overnight pays 8h (1h meal break)', () => {
    expect(
      paidMinutesForRange('2026-08-28T22:00:00Z', '2026-08-29T07:00:00Z'),
    ).toBe(8 * 60);
  });

  it('exactly 6h keeps 6h — the break applies only over the threshold', () => {
    expect(
      paidMinutesForRange('2026-08-28T09:00:00Z', '2026-08-28T15:00:00Z'),
    ).toBe(6 * 60);
  });

  it('short shifts are untouched and inverted ranges clamp to 0', () => {
    expect(
      paidMinutesForRange('2026-08-28T09:00:00Z', '2026-08-28T13:00:00Z'),
    ).toBe(4 * 60);
    expect(
      paidMinutesForRange('2026-08-28T13:00:00Z', '2026-08-28T09:00:00Z'),
    ).toBe(0);
  });
});
