import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '@prisma/client';
import { computePercent } from '../../lib/checklist.js';

const t = (status: TaskStatus) => ({ status });

describe('computePercent', () => {
  it('returns 0 for an empty list', () => {
    expect(computePercent([])).toBe(0);
  });

  it('returns 100 when every task is DONE', () => {
    expect(computePercent([t('DONE'), t('DONE'), t('DONE')])).toBe(100);
  });

  it('counts SKIPPED as complete (intentional invariant)', () => {
    expect(computePercent([t('DONE'), t('SKIPPED')])).toBe(100);
  });

  it('does not count IN_PROGRESS as complete', () => {
    expect(computePercent([t('DONE'), t('IN_PROGRESS')])).toBe(50);
  });

  it('does not count PENDING as complete', () => {
    expect(computePercent([t('DONE'), t('PENDING')])).toBe(50);
  });

  it('handles a mix of states', () => {
    expect(
      computePercent([
        t('DONE'),
        t('SKIPPED'),
        t('IN_PROGRESS'),
        t('PENDING'),
      ])
    ).toBe(50);
  });

  it('rounds to the nearest integer', () => {
    // 1 / 3 ≈ 33.33 → 33
    expect(computePercent([t('DONE'), t('PENDING'), t('PENDING')])).toBe(33);
    // 2 / 3 ≈ 66.66 → 67
    expect(computePercent([t('DONE'), t('DONE'), t('PENDING')])).toBe(67);
  });
});
