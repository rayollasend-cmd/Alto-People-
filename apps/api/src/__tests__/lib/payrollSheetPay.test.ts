import { describe, expect, it } from 'vitest';
import { attachEarnings } from '../../lib/payrollSheetPay.js';
import type { ProjectedItem } from '../../lib/payrollAggregator.js';
import type { PayrollSheet } from '../../lib/payrollSheet.js';

function item(partial: Partial<ProjectedItem> & { associateId: string }): ProjectedItem {
  return {
    associateName: 'x',
    hoursWorked: 0,
    hourlyRate: 0,
    regularHours: 0,
    overtimeHours: 0,
    earnings: [],
    grossPay: 0,
    preTaxDeductions: 0,
    preTaxRetirement: 0,
    federalIncomeTax: 0,
    fica: 0,
    medicare: 0,
    stateIncomeTax: 0,
    taxState: null,
    payFrequency: 'BIWEEKLY',
    disposableEarnings: 0,
    garnishments: [],
    postTaxDeductions: 0,
    reimbursementsTotal: 0,
    reimbursementIds: [],
    netPay: 0,
    employerFica: 0,
    employerMedicare: 0,
    employerFuta: 0,
    employerSuta: 0,
    ytdWages: 0,
    ytdMedicareWages: 0,
    ...partial,
  };
}

const SHEET: PayrollSheet = {
  associates: [
    {
      associateId: 'a1',
      name: 'Ann Lee',
      days: [{ date: '2026-06-15', minutes: 540 }],
      regularMinutes: 2400,
      overtimeMinutes: 300,
      totalMinutes: 2700,
    },
    {
      associateId: 'a2',
      name: 'Bob Ortiz',
      days: [{ date: '2026-06-15', minutes: 480 }],
      regularMinutes: 2400,
      overtimeMinutes: 0,
      totalMinutes: 2400,
    },
  ],
  totalRegularMinutes: 4800,
  totalOvertimeMinutes: 300,
  totalMinutes: 5100,
};

describe('attachEarnings', () => {
  it('merges engine money onto associates and totals it', () => {
    const itemById = new Map<string, ProjectedItem>([
      [
        'a1',
        item({
          associateId: 'a1',
          hourlyRate: 20,
          grossPay: 950,
          federalIncomeTax: 10,
          fica: 58.9,
          medicare: 13.78,
          stateIncomeTax: 0,
          netPay: 867.32,
        }),
      ],
      [
        'a2',
        item({
          associateId: 'a2',
          hourlyRate: 18,
          grossPay: 720,
          federalIncomeTax: 5,
          fica: 44.64,
          medicare: 10.44,
          stateIncomeTax: 0,
          netPay: 659.92,
        }),
      ],
    ]);
    const payInfo = new Map([
      ['a1', { payType: 'HOURLY' as const }],
      ['a2', { payType: 'HOURLY' as const }],
    ]);

    const paid = attachEarnings(SHEET, itemById, payInfo);
    expect(paid.associates[0].pay).toMatchObject({
      hourlyRate: 20,
      hasRate: true,
      grossPay: 950,
      socialSecurity: 58.9,
      medicare: 13.78,
      stateIncomeTax: 0,
      netPay: 867.32,
    });
    expect(paid.totalGross).toBe(1670);
    expect(paid.totalNet).toBeCloseTo(1527.24, 2);
    expect(paid.totalSocialSecurity).toBeCloseTo(103.54, 2);
    expect(paid.anyMissingRate).toBe(false);
    // Hours totals pass through unchanged.
    expect(paid.totalMinutes).toBe(5100);
  });

  it('flags associates with no wage on file and excludes them from money', () => {
    const itemById = new Map<string, ProjectedItem>([
      ['a1', item({ associateId: 'a1', hourlyRate: 20, grossPay: 950, netPay: 900 })],
      // a2 has no engine item (no rate, gross 0)
      ['a2', item({ associateId: 'a2', hourlyRate: 0, grossPay: 0, netPay: 0 })],
    ]);
    const payInfo = new Map([['a1', { payType: 'HOURLY' as const }]]);

    const paid = attachEarnings(SHEET, itemById, payInfo);
    expect(paid.associates[0].pay.hasRate).toBe(true);
    expect(paid.associates[1].pay.hasRate).toBe(false);
    expect(paid.anyMissingRate).toBe(true);
    expect(paid.totalGross).toBe(950);
  });
});
