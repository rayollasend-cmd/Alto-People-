import type { PaystubData } from './paystub.js';

/**
 * What each state requires on a wage statement (the paystub), and a checker
 * that says which required elements a statement would be missing.
 *
 * The stub always prints gross, each deduction, net, the period's dates, the
 * pay date, the person's name and employee ID, each earning line with its
 * hours and rate, and total hours. What can be missing is data the stub
 * reads from elsewhere: the employer's legal address and phone, and a paid
 * sick leave balance. The pre-run checks (payrollExceptions) flag those
 * before a run finalizes; a warning, not a block.
 *
 * Sources (statute text, checked 2026-10):
 *   CA  Labor Code §226(a)(1)–(9); paid sick leave available, §246(i)
 *   NY  Labor Law §195(3)
 *   WA  WAC 296-126-040 (itemized statement); paid sick leave balance at
 *       least monthly, WAC 296-128-760
 *   OR  ORS 652.610(3)
 *   CO  C.R.S. 8-4-103(4)
 *   IL  820 ILCS 115/10
 *   MA  M.G.L. c.149 §148
 * Federal law (FLSA) sets no wage-statement content; a state without a row
 * here has no element check.
 */

export type WageStatementElement =
  | 'GROSS_WAGES'
  | 'TOTAL_HOURS'
  | 'PIECE_RATE_UNITS'
  | 'DEDUCTIONS'
  | 'NET_WAGES'
  | 'PAY_PERIOD_DATES'
  | 'PAY_DATE'
  | 'EMPLOYEE_NAME'
  | 'EMPLOYEE_ID'
  | 'EMPLOYER_NAME'
  | 'EMPLOYER_ADDRESS'
  | 'EMPLOYER_PHONE'
  | 'RATES_AND_HOURS'
  | 'OVERTIME_RATE'
  | 'SICK_LEAVE_BALANCE';

export const ELEMENT_LABEL: Record<WageStatementElement, string> = {
  GROSS_WAGES: 'Gross wages',
  TOTAL_HOURS: 'Total hours worked',
  PIECE_RATE_UNITS: 'Piece-rate units and rate',
  DEDUCTIONS: 'Each deduction',
  NET_WAGES: 'Net wages',
  PAY_PERIOD_DATES: 'Pay period dates',
  PAY_DATE: 'Pay date',
  EMPLOYEE_NAME: 'Employee name',
  EMPLOYEE_ID: 'Employee ID or last 4 of SSN',
  EMPLOYER_NAME: 'Employer legal name',
  EMPLOYER_ADDRESS: 'Employer address',
  EMPLOYER_PHONE: 'Employer phone',
  RATES_AND_HOURS: 'Every rate with its hours',
  OVERTIME_RATE: 'Overtime rate and hours',
  SICK_LEAVE_BALANCE: 'Paid sick leave available',
};

/** Elements that apply only to non-exempt (hourly) employees. */
const NON_EXEMPT_ONLY = new Set<WageStatementElement>(['TOTAL_HOURS', 'RATES_AND_HOURS', 'OVERTIME_RATE']);

export interface WageStatementRule {
  state: string;
  citation: string;
  elements: WageStatementElement[];
}

export const WAGE_STATEMENT_RULES: Record<string, WageStatementRule> = {
  CA: {
    state: 'CA',
    citation: 'Cal. Labor Code §226(a), §246(i)',
    elements: [
      'GROSS_WAGES', 'TOTAL_HOURS', 'PIECE_RATE_UNITS', 'DEDUCTIONS', 'NET_WAGES', 'PAY_PERIOD_DATES',
      'EMPLOYEE_NAME', 'EMPLOYEE_ID', 'EMPLOYER_NAME', 'EMPLOYER_ADDRESS', 'RATES_AND_HOURS', 'SICK_LEAVE_BALANCE',
    ],
  },
  NY: {
    state: 'NY',
    citation: 'N.Y. Labor Law §195(3)',
    elements: [
      'PAY_PERIOD_DATES', 'EMPLOYEE_NAME', 'EMPLOYER_NAME', 'EMPLOYER_ADDRESS', 'EMPLOYER_PHONE',
      'RATES_AND_HOURS', 'GROSS_WAGES', 'DEDUCTIONS', 'NET_WAGES', 'OVERTIME_RATE', 'TOTAL_HOURS',
    ],
  },
  WA: {
    state: 'WA',
    citation: 'WAC 296-126-040; WAC 296-128-760',
    elements: ['RATES_AND_HOURS', 'TOTAL_HOURS', 'GROSS_WAGES', 'DEDUCTIONS', 'NET_WAGES', 'SICK_LEAVE_BALANCE'],
  },
  OR: {
    state: 'OR',
    citation: 'ORS 652.610(3)',
    elements: [
      'DEDUCTIONS', 'EMPLOYEE_NAME', 'EMPLOYER_NAME', 'EMPLOYER_ADDRESS', 'EMPLOYER_PHONE', 'GROSS_WAGES',
      'NET_WAGES', 'PAY_PERIOD_DATES', 'TOTAL_HOURS', 'RATES_AND_HOURS', 'PIECE_RATE_UNITS',
    ],
  },
  CO: {
    state: 'CO',
    citation: 'C.R.S. 8-4-103(4)',
    elements: ['GROSS_WAGES', 'DEDUCTIONS', 'NET_WAGES', 'TOTAL_HOURS', 'EMPLOYEE_NAME', 'EMPLOYEE_ID', 'EMPLOYER_NAME', 'EMPLOYER_ADDRESS', 'PAY_PERIOD_DATES'],
  },
  IL: {
    state: 'IL',
    citation: '820 ILCS 115/10',
    elements: ['TOTAL_HOURS', 'RATES_AND_HOURS', 'GROSS_WAGES', 'DEDUCTIONS', 'NET_WAGES', 'PAY_PERIOD_DATES', 'EMPLOYEE_NAME', 'EMPLOYER_NAME'],
  },
  MA: {
    state: 'MA',
    citation: 'M.G.L. c.149 §148',
    elements: ['EMPLOYER_NAME', 'EMPLOYEE_NAME', 'PAY_DATE', 'TOTAL_HOURS', 'RATES_AND_HOURS', 'DEDUCTIONS', 'GROSS_WAGES', 'NET_WAGES'],
  },
};

export function wageStatementRuleFor(state: string | null | undefined): WageStatementRule | null {
  if (!state) return null;
  return WAGE_STATEMENT_RULES[state.toUpperCase()] ?? null;
}

/** Whether each element is present (null = does not apply, e.g. no piece work). */
export type WageStatementFacts = Partial<Record<WageStatementElement, boolean | null>>;

export interface WageStatementCheck {
  state: string;
  citation: string | null;
  missing: WageStatementElement[];
}

/** The required elements a statement lacks, under the work state's rule. */
export function checkWageStatement(state: string | null | undefined, facts: WageStatementFacts, opts: { exempt?: boolean } = {}): WageStatementCheck {
  const rule = wageStatementRuleFor(state);
  if (!rule) return { state: (state ?? '').toUpperCase(), citation: null, missing: [] };
  const missing = rule.elements.filter((el) => {
    if (opts.exempt && NON_EXEMPT_ONLY.has(el)) return false;
    const v = facts[el];
    return v === false || v === undefined;
  });
  return { state: rule.state, citation: rule.citation, missing };
}

/** What the employer block can print. */
export interface EmployerBlock {
  legalName?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
}

/**
 * Facts for a statement that has not been printed yet — the elements the
 * paystub always carries are present; the employer's address and phone and
 * the sick leave balance depend on data on file.
 */
export function factsBeforeRun(input: { employer: EmployerBlock; employeeName: string; hasSickBalance: boolean; hasPieceWork?: boolean }): WageStatementFacts {
  const e = input.employer;
  return {
    GROSS_WAGES: true,
    TOTAL_HOURS: true,
    PIECE_RATE_UNITS: input.hasPieceWork ? false : null,
    DEDUCTIONS: true,
    NET_WAGES: true,
    PAY_PERIOD_DATES: true,
    PAY_DATE: true,
    EMPLOYEE_NAME: input.employeeName.trim().length > 0,
    EMPLOYEE_ID: true,
    EMPLOYER_NAME: !!e.legalName?.trim(),
    EMPLOYER_ADDRESS: !!(e.addressLine1?.trim() && e.city?.trim() && e.state?.trim() && e.zip?.trim()),
    EMPLOYER_PHONE: !!e.phone?.trim(),
    RATES_AND_HOURS: true,
    OVERTIME_RATE: true,
    SICK_LEAVE_BALANCE: input.hasSickBalance,
  };
}

/** Facts read off a built statement — the check on what the stub actually says. */
export function factsFromPaystub(d: PaystubData): WageStatementFacts {
  const hourly = d.earnings.filter((e) => e.hours != null && e.hours > 0);
  const overtime = d.earnings.filter((e) => /overtime|double/i.test(e.label));
  return {
    GROSS_WAGES: Number.isFinite(d.gross.current),
    TOTAL_HOURS: hourly.length === 0 ? null : (d.hoursTotal ?? 0) > 0,
    PIECE_RATE_UNITS: null,
    DEDUCTIONS: true,
    NET_WAGES: Number.isFinite(d.net.current),
    PAY_PERIOD_DATES: !!(d.period.start && d.period.end),
    PAY_DATE: !!(d.period.payDate ?? d.meta.issuedAt),
    EMPLOYEE_NAME: `${d.associate.firstName} ${d.associate.lastName}`.trim().length > 0,
    EMPLOYEE_ID: !!d.associate.employeeId,
    EMPLOYER_NAME: !!d.company.name?.trim(),
    EMPLOYER_ADDRESS: !!(d.company.addressLine1 && d.company.city && d.company.state && d.company.zip),
    EMPLOYER_PHONE: !!d.company.phone,
    RATES_AND_HOURS: hourly.length === 0 ? null : hourly.every((e) => e.rate != null),
    OVERTIME_RATE: overtime.length === 0 ? null : overtime.every((e) => e.rate != null && e.hours != null),
    SICK_LEAVE_BALANCE: !!d.sickLeave,
  };
}
