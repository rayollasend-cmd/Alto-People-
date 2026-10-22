import { describe, expect, it } from 'vitest';
import { paycheckStatusLabel, paycheckStatusTone, runStatusLabel, runStatusTone } from '@/lib/payrollRunStatus';

/** One word per payroll status (F500 SH-4): "Paid", never "Disbursed" on one page and "Paid" on the next. */
describe('payroll status words', () => {
  it('runs: Draft · Finalized · Paid · Cancelled', () => {
    expect(['DRAFT', 'FINALIZED', 'DISBURSED', 'CANCELLED'].map(runStatusLabel)).toEqual(['Draft', 'Finalized', 'Paid', 'Cancelled']);
    expect(runStatusTone('DISBURSED')).toBe('success');
    expect(runStatusTone('FINALIZED')).toBe('pending');
    expect(runStatusTone('CANCELLED')).toBe('outline');
  });

  it('paychecks, with a desk’s own words where it has them', () => {
    expect(['PENDING', 'DISBURSED', 'FAILED', 'HELD', 'VOIDED'].map((s) => paycheckStatusLabel(s))).toEqual(['Not paid yet', 'Paid', 'Failed', 'Held', 'Voided']);
    expect(paycheckStatusLabel('VOIDED', { VOIDED: 'Paid on the regular check' })).toBe('Paid on the regular check');
    expect(paycheckStatusTone('FAILED')).toBe('destructive');
  });

  it('an unknown code reads as words and never throws', () => {
    expect(runStatusLabel('ON_HOLD')).toBe('On hold');
    expect(runStatusLabel(undefined as never)).toBe('');
  });
});
