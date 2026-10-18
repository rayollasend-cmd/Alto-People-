import { describe, expect, it } from 'vitest';
import {
  computeGarnishmentDeductions,
  type GarnishmentRule,
} from '../../lib/garnishments.js';

const close = (a: number, b: number, eps = 0.02) => Math.abs(a - b) < eps;

const rule = (over: Partial<GarnishmentRule> = {}): GarnishmentRule => ({
  id: 'g',
  kind: 'CREDITOR',
  amountPerRun: null,
  percentOfDisp: null,
  totalCap: null,
  amountWithheld: 0,
  priority: 1,
  ...over,
});

describe('computeGarnishmentDeductions — empty + degenerate', () => {
  it('no rules → empty deductions, total 0', () => {
    const r = computeGarnishmentDeductions({ disposableEarnings: 1000, rules: [] });
    expect(r.deductions).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('zero disposable → no deductions even with active rules', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 0,
      rules: [rule({ id: 'a', amountPerRun: 100 })],
    });
    expect(r.total).toBe(0);
  });

  it('rule with neither amountPerRun nor percentOfDisp → skipped', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a' })],
    });
    expect(r.total).toBe(0);
  });
});

describe('CCPA caps by kind', () => {
  it('CREDITOR is capped at 25% of disposable', () => {
    // Asks for $500 but cap is 25% × 1000 = 250.
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CREDITOR', amountPerRun: 500 })],
    });
    expect(close(r.total, 250)).toBe(true);
  });

  it('OTHER is capped at 25% of disposable (treated like creditor)', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'OTHER', amountPerRun: 500 })],
    });
    expect(close(r.total, 250)).toBe(true);
  });

  it('CHILD_SUPPORT is capped at 60% of disposable', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CHILD_SUPPORT', amountPerRun: 800 })],
    });
    expect(close(r.total, 600)).toBe(true);
  });

  it('STUDENT_LOAN is capped at 15% of disposable', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'STUDENT_LOAN', amountPerRun: 500 })],
    });
    expect(close(r.total, 150)).toBe(true);
  });

  it('TAX_LEVY honors the agency-provided amount up to 100% of disposable', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'TAX_LEVY', amountPerRun: 800 })],
    });
    expect(close(r.total, 800)).toBe(true);
  });

  it('BANKRUPTCY honors the court-ordered amount up to 100% of disposable', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'BANKRUPTCY', amountPerRun: 950 })],
    });
    expect(close(r.total, 950)).toBe(true);
  });
});

describe('amountPerRun vs percentOfDisp', () => {
  it('flat amount honored when under cap', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CREDITOR', amountPerRun: 100 })],
    });
    expect(close(r.total, 100)).toBe(true);
  });

  it('percent of disposable honored when under cap', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CREDITOR', percentOfDisp: 0.10 })],
    });
    expect(close(r.total, 100)).toBe(true);
  });

  it('percentOfDisp respects the kind cap (creditor 25%)', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CREDITOR', percentOfDisp: 0.50 })],
    });
    expect(close(r.total, 250)).toBe(true);
  });
});

describe('lifetime totalCap', () => {
  it('caps at totalCap - amountWithheld remaining', () => {
    // $200 already withheld of $250 cap → only $50 left for this paycheck.
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({
          id: 'a',
          kind: 'CREDITOR',
          amountPerRun: 100,
          totalCap: 250,
          amountWithheld: 200,
        }),
      ],
    });
    expect(close(r.total, 50)).toBe(true);
    expect(r.deductions[0].reachedCap).toBe(true);
  });

  it('marks reachedCap=false when room remains', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({
          id: 'a',
          kind: 'CREDITOR',
          amountPerRun: 100,
          totalCap: 1000,
          amountWithheld: 200,
        }),
      ],
    });
    expect(r.deductions[0].reachedCap).toBe(false);
  });

  it('exhausted lifetime cap → 0 deduction', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({
          id: 'a',
          amountPerRun: 100,
          totalCap: 500,
          amountWithheld: 500,
        }),
      ],
    });
    expect(r.total).toBe(0);
  });
});

describe('priority ordering', () => {
  it('two creditors share one 25% limit, first in time first (15 U.S.C. §1673(a))', () => {
    // The CCPA limit is on the AGGREGATE garnished, not per order: the first
    // creditor (priority 1) takes the whole $250 and the second waits.
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({ id: 'second', priority: 2, amountPerRun: 500 }),
        rule({ id: 'first', priority: 1, amountPerRun: 500 }),
      ],
    });
    expect(r.deductions[0]?.garnishmentId).toBe('first');
    expect(close(r.deductions[0]!.amount, 250)).toBe(true);
    expect(r.deductions.find((d) => d.garnishmentId === 'second')?.amount ?? 0).toBe(0);
    expect(close(r.total, 250)).toBe(true);
  });

  it('support withheld counts against the creditor 25%: $400 of support leaves a creditor nothing', () => {
    // 29 CFR 870.11(b)(2): a creditor garnishment is allowed only to the
    // extent support has not already taken 25% of disposable earnings.
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({ id: 'cs', kind: 'CHILD_SUPPORT', priority: 1, amountPerRun: 400 }),
        rule({ id: 'c', kind: 'CREDITOR', priority: 2, amountPerRun: 200 }),
      ],
    });
    expect(close(r.deductions.find((d) => d.garnishmentId === 'cs')!.amount, 400)).toBe(true);
    expect(r.deductions.find((d) => d.garnishmentId === 'c')?.amount ?? 0).toBe(0);
    expect(close(r.total, 400)).toBe(true);
  });

  it('partial fill on disposable exhaustion', () => {
    // Tax levy takes 800 (under its 100% cap). Only 200 remains for the
    // creditor whose 25% cap would normally allow 250 — gets only 200.
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [
        rule({ id: 'levy', kind: 'TAX_LEVY', priority: 1, amountPerRun: 800 }),
        rule({ id: 'c', kind: 'CREDITOR', priority: 2, amountPerRun: 250 }),
      ],
    });
    expect(close(r.deductions.find((d) => d.garnishmentId === 'levy')!.amount, 800)).toBe(true);
    expect(close(r.deductions.find((d) => d.garnishmentId === 'c')!.amount, 200)).toBe(true);
  });
});

describe('rounding', () => {
  it('amounts round to 2 decimals', () => {
    const r = computeGarnishmentDeductions({
      disposableEarnings: 1000,
      rules: [rule({ id: 'a', kind: 'CREDITOR', percentOfDisp: 0.123 })],
    });
    // 1000 × 0.123 = 123 (under 25% cap of 250).
    expect(r.total).toBe(123);
  });
});
