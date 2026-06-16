// Merges the payroll engine's per-associate earnings (rate, gross, taxes,
// net) onto the hours-only payroll sheet. The money comes from
// aggregatePayrollProjection — the same engine real payroll runs use — so
// the sheet reconciles with an actual run. Gross is driven by each
// associate's current compensation-record wage (via the aggregator's
// hourlyRateOverride); net is the full-engine figure (W-4, pre-tax benefits,
// garnishments, YTD Social-Security caps), with state income tax resolved
// from the client's work-site state (Florida → $0).

import type { ProjectedItem } from './payrollAggregator.js';
import type { PayrollSheet, PayrollSheetAssociate } from './payrollSheet.js';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AssociatePay {
  payType: 'HOURLY' | 'SALARY' | null;
  /** The rate used to compute gross (compensation-record wage). */
  hourlyRate: number;
  /** False when no hourly wage is on file — gross/net are not computed. */
  hasRate: boolean;
  grossPay: number;
  federalIncomeTax: number;
  socialSecurity: number;
  medicare: number;
  stateIncomeTax: number;
  netPay: number;
}

export interface PayrollSheetAssociatePaid extends PayrollSheetAssociate {
  pay: AssociatePay;
}

export interface PayrollSheetPaid {
  associates: PayrollSheetAssociatePaid[];
  totalRegularMinutes: number;
  totalOvertimeMinutes: number;
  totalMinutes: number;
  totalGross: number;
  totalFederalIncomeTax: number;
  totalSocialSecurity: number;
  totalMedicare: number;
  totalStateIncomeTax: number;
  totalNet: number;
  /** True if any associate is missing an hourly wage (gross/net left blank). */
  anyMissingRate: boolean;
}

export interface AssociatePayInfo {
  payType: 'HOURLY' | 'SALARY' | null;
}

export function attachEarnings(
  sheet: PayrollSheet,
  itemById: Map<string, ProjectedItem>,
  payInfoById: Map<string, AssociatePayInfo>,
): PayrollSheetPaid {
  const associates: PayrollSheetAssociatePaid[] = sheet.associates.map((a) => {
    const item = itemById.get(a.associateId);
    const info = payInfoById.get(a.associateId);
    const hourlyRate = item?.hourlyRate ?? 0;
    const hasRate = hourlyRate > 0;
    const pay: AssociatePay = {
      payType: info?.payType ?? null,
      hourlyRate,
      hasRate,
      grossPay: item?.grossPay ?? 0,
      federalIncomeTax: item?.federalIncomeTax ?? 0,
      socialSecurity: item?.fica ?? 0,
      medicare: item?.medicare ?? 0,
      stateIncomeTax: item?.stateIncomeTax ?? 0,
      netPay: item?.netPay ?? 0,
    };
    return { ...a, pay };
  });

  const sum = (pick: (p: AssociatePay) => number): number =>
    round2(associates.reduce((s, a) => s + pick(a.pay), 0));

  return {
    associates,
    totalRegularMinutes: sheet.totalRegularMinutes,
    totalOvertimeMinutes: sheet.totalOvertimeMinutes,
    totalMinutes: sheet.totalMinutes,
    totalGross: sum((p) => p.grossPay),
    totalFederalIncomeTax: sum((p) => p.federalIncomeTax),
    totalSocialSecurity: sum((p) => p.socialSecurity),
    totalMedicare: sum((p) => p.medicare),
    totalStateIncomeTax: sum((p) => p.stateIncomeTax),
    totalNet: sum((p) => p.netPay),
    anyMissingRate: associates.some((a) => !a.pay.hasRate),
  };
}

/** Minutes → decimal hours number (2dp), for renderers that want a number. */
export function minutesToHoursNum(min: number): number {
  return Math.round((min / 60) * 100) / 100;
}
