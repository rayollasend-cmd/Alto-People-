import type { PayFrequency } from '../payrollTax.js';
import type { EmployeePeriodInput, TaxLine } from './types.js';

/**
 * State disability, paid-leave and employee unemployment contributions for
 * 2026: the money a state requires withheld from the paycheck (and what
 * the employer owes on top) for CA SDI, NJ TDI / FLI and the NJ and PA
 * and AK employee unemployment shares, NY DBL and PFL, WA PFML and WA
 * Cares, MA PFML, Oregon Paid Leave, Colorado FAMLI, CT Paid Leave, RI
 * TDI, HI TDI, Delaware Paid Leave, Minnesota Paid Leave and DC's
 * employer-paid Universal Paid Leave.
 *
 * Which state's programs apply: the state the worker's unemployment
 * insurance is reported to (the four-factor localization the engine
 * already runs for SUI). Every one of these programs follows the UI
 * coverage rules for who is a covered employee.
 *
 * The wage base is the state's own: `bases.stateProgram[state]` (or
 * `bases.stateUi[state]` for the UI-type shares) from the deduction
 * taxability rules — a 401(k) deferral is in the base, a §125 premium
 * generally isn't — falling back to the check's wages. Annual caps use
 * `ytdProgramWages[code]`, the wages already contributed on this year.
 *
 * Employer shares that depend on headcount (WA 50+, OR and MA 25+, CO 10+,
 * DE and MN tiers) use `employerSize`; unknown size is treated as large,
 * so the employer cost is never understated. Employee shares that change
 * with size (DE, MN) do too, and the line's note says so.
 *
 * Every row cites its agency source and was verified for 2026. A row with
 * `verified: false` (none at the time of writing) keeps its state out of
 * coverage until a payroll admin reviews it — see programsAwaitingReview.
 */

export interface StateProgram {
  code: string;
  state: string;
  label: string;
  /** Employee rate on the program base (0 when employer-only). */
  employeeRate: number;
  /** Employer rate on the program base for a large employer (0 when none). */
  employerRate: number;
  /** Annual wage cap on contributions (null: every dollar). */
  wageCap: number | null;
  /** A per-week ceiling on the employee contribution (NY DBL, HI TDI). */
  weeklyEmployeeMax?: number;
  /** The base the program reads: its own (disability/leave) or the UI base. */
  base: 'program' | 'ui';
  taxYear: number;
  source: string;
  verified: boolean;
  /** Headcount rules; returns the shares for an employer of `size` people. */
  bySize?: (size: number) => { employeeRate: number; employerRate: number; note: string };
  /** A certificate on file (EmployeePeriodInput.certificates kind) that exempts the worker. */
  exemptCertificate?: string;
  note?: string;
}

const SS_WAGE_BASE_2026 = 184_500;

export const STATE_PROGRAMS_2026: readonly StateProgram[] = [
  {
    code: 'CA_SDI', state: 'CA', label: 'CA SDI (disability & paid family leave)', employeeRate: 0.013, employerRate: 0, wageCap: null, base: 'program', taxYear: 2026, verified: true,
    source: 'California EDD, 2026 Rates, Withholding Schedules and Meals and Lodging Values (DE 44); SB 951 removed the wage ceiling from 2024',
  },
  {
    code: 'NJ_TDI', state: 'NJ', label: 'NJ disability insurance (TDI)', employeeRate: 0.0019, employerRate: 0, wageCap: 171_100, base: 'program', taxYear: 2026, verified: true,
    source: 'NJ Department of Labor, Rate information, contributions and due dates (2026): worker TDI 0.19% on $171,100',
    note: 'The employer TDI contribution (an assigned rate on the $44,800 UI base) is billed on the NJ-927 at the employer’s own rate.',
  },
  {
    code: 'NJ_FLI', state: 'NJ', label: 'NJ family leave insurance (FLI)', employeeRate: 0.0023, employerRate: 0, wageCap: 171_100, base: 'program', taxYear: 2026, verified: true,
    source: 'NJ Department of Labor, Rate information, contributions and due dates (2026): worker FLI 0.23% on $171,100',
  },
  {
    code: 'NJ_UI_WF', state: 'NJ', label: 'NJ unemployment & workforce (worker share)', employeeRate: 0.00425, employerRate: 0, wageCap: 44_800, base: 'ui', taxYear: 2026, verified: true,
    source: 'NJ Department of Labor, Rate information (2026): worker UI/WF/SWF 0.425% on $44,800',
  },
  {
    code: 'NY_DBL', state: 'NY', label: 'NY disability benefits (DBL)', employeeRate: 0.005, employerRate: 0, wageCap: null, weeklyEmployeeMax: 0.6, base: 'program', taxYear: 2026, verified: true,
    source: 'NY Workers’ Compensation Law §209: 0.5% of wages, not more than $0.60 a week',
    note: 'The employer pays the rest of the DBL policy premium to its carrier.',
  },
  {
    code: 'NY_PFL', state: 'NY', label: 'NY paid family leave (PFL)', employeeRate: 0.00432, employerRate: 0, wageCap: Math.round((411.91 / 0.00432) * 100) / 100, base: 'program', taxYear: 2026, verified: true,
    source: 'NY Department of Financial Services, 2026 PFL rate decision: 0.432% of wages, annual maximum $411.91',
  },
  {
    code: 'WA_PFML', state: 'WA', label: 'WA paid family & medical leave', employeeRate: 0.0113 * 0.7143, employerRate: 0.0113 * 0.2857, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Washington ESD, “Paid Family & Medical Leave premium rate increases to 1.13% in 2026” (employee 71.43%, employer 28.57%)',
    bySize: (n) => (n >= 50 ? { employeeRate: 0.0113 * 0.7143, employerRate: 0.0113 * 0.2857, note: '50 or more employees: the employer pays 28.57%.' } : { employeeRate: 0.0113 * 0.7143, employerRate: 0, note: 'Fewer than 50 employees: no employer share.' }),
  },
  {
    code: 'WA_CARES', state: 'WA', label: 'WA Cares (long-term care)', employeeRate: 0.0058, employerRate: 0, wageCap: null, base: 'program', taxYear: 2026, verified: true, exemptCertificate: 'WA_CARES_EXEMPT',
    source: 'WA Cares Fund (RCW 50B.04.080): 0.58% of all wages; approved exemptions and, from 2026 (SB 5291), automatic exemptions for active-duty military and temporary-visa holders',
  },
  {
    code: 'MA_PFML', state: 'MA', label: 'MA paid family & medical leave', employeeRate: 0.0046, employerRate: 0.0042, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Massachusetts DFML, 2026 contribution rates: 0.88% (25+ covered individuals): employee 0.28% medical + 0.18% family; employer 0.42% medical',
    bySize: (n) => (n >= 25 ? { employeeRate: 0.0046, employerRate: 0.0042, note: '25 or more covered individuals: the employer pays 0.42% (medical).' } : { employeeRate: 0.0046, employerRate: 0, note: 'Fewer than 25 covered individuals: no employer share.' }),
  },
  {
    code: 'OR_PAID_LEAVE', state: 'OR', label: 'Paid Leave Oregon', employeeRate: 0.006, employerRate: 0.004, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Oregon Employment Department, Current Tax Rate (2026): 1% on wages up to $184,500; employee 60%, employer 40% (25+ employees)',
    bySize: (n) => (n >= 25 ? { employeeRate: 0.006, employerRate: 0.004, note: '25 or more employees: the employer pays 0.4%.' } : { employeeRate: 0.006, employerRate: 0, note: 'Fewer than 25 employees: no employer share.' }),
  },
  {
    code: 'CO_FAMLI', state: 'CO', label: 'Colorado FAMLI', employeeRate: 0.0044, employerRate: 0.0044, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Colorado FAMLI Division, 2026 premium 0.88% split 0.44% / 0.44%, wages up to the Social Security cap',
    bySize: (n) => (n >= 10 ? { employeeRate: 0.0044, employerRate: 0.0044, note: '10 or more employees: the employer pays half.' } : { employeeRate: 0.0044, employerRate: 0, note: 'Fewer than 10 employees: no employer share.' }),
  },
  {
    code: 'CT_PFML', state: 'CT', label: 'CT Paid Leave', employeeRate: 0.005, employerRate: 0, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'CT Paid Leave Authority: 0.5% of wages up to the Social Security contribution base, employee-funded',
  },
  {
    code: 'RI_TDI', state: 'RI', label: 'RI temporary disability (TDI)', employeeRate: 0.011, employerRate: 0, wageCap: 100_000, base: 'program', taxYear: 2026, verified: true,
    source: 'RI Department of Labor and Training, 2026 tax rates: TDI 1.1% on $100,000',
  },
  {
    code: 'HI_TDI', state: 'HI', label: 'HI temporary disability (TDI)', employeeRate: 0.005, employerRate: 0, wageCap: null, weeklyEmployeeMax: 7.5, base: 'program', taxYear: 2026, verified: true,
    source: 'Hawaii DLIR Disability Compensation Division, 2026 Maximum Weekly Wage Base $1,500.21: employee 0.5%, not more than $7.50 a week',
    note: 'The employer pays the rest of the TDI plan premium to its carrier.',
  },
  {
    code: 'DE_PFML', state: 'DE', label: 'Delaware Paid Leave', employeeRate: 0.004, employerRate: 0.004, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Delaware Paid Leave (19 Del. C. ch. 37): 0.8% (parental 0.32, medical 0.40, caregiving 0.08); the employee may be charged up to half; wages up to the Social Security base',
    bySize: (n) =>
      n >= 25
        ? { employeeRate: 0.004, employerRate: 0.004, note: '25 or more employees: full program, half deducted from pay.' }
        : n >= 10
          ? { employeeRate: 0.0016, employerRate: 0.0016, note: '10–24 employees: parental leave only (0.32%), half deducted from pay.' }
          : { employeeRate: 0, employerRate: 0, note: 'Fewer than 10 employees: not covered.' },
  },
  {
    code: 'MN_PFML', state: 'MN', label: 'Minnesota Paid Leave', employeeRate: 0.0044, employerRate: 0.0044, wageCap: SS_WAGE_BASE_2026, base: 'program', taxYear: 2026, verified: true,
    source: 'Minnesota DEED Paid Leave, Premiums (2026): 0.88% (medical 0.61, family 0.27); the employee may be charged up to half; wages up to the Social Security base',
  },
  {
    code: 'PA_UC_EE', state: 'PA', label: 'PA unemployment (worker share)', employeeRate: 0.0007, employerRate: 0, wageCap: null, base: 'ui', taxYear: 2026, verified: true,
    source: 'PA Department of Labor & Industry, UC employee withholding 0.07% of all wages for 2026',
  },
  {
    code: 'AK_UI_EE', state: 'AK', label: 'AK unemployment (worker share)', employeeRate: 0.005, employerRate: 0, wageCap: 54_200, base: 'ui', taxYear: 2026, verified: true,
    source: 'Alaska Department of Labor, 2026 Unemployment Insurance Tax Rates: employee 0.50% on $54,200',
  },
  {
    code: 'DC_UPL', state: 'DC', label: 'DC Universal Paid Leave (employer)', employeeRate: 0, employerRate: 0.0075, wageCap: null, base: 'program', taxYear: 2026, verified: true,
    source: 'DC Code §32-541.04a: employer contribution 0.75% of wages, no employee deduction',
  },
];

/**
 * Maryland FAMLI contributions start January 1, 2027 (HB 102, 2025): not
 * withheld in 2026. Listed so the coverage page can say so.
 */
export const PROGRAMS_NOT_YET_LIVE: ReadonlyArray<{ state: string; label: string; startsOn: string; source: string }> = [
  { state: 'MD', label: 'Maryland FAMLI', startsOn: '2027-01-01', source: 'HB 102 (2025), signed May 6, 2025: contributions delayed to January 1, 2027' },
];

export function programsFor(state: string | null): StateProgram[] {
  if (!state) return [];
  return STATE_PROGRAMS_2026.filter((p) => p.state === state.toUpperCase());
}

const WEEKS_PER_PERIOD: Record<PayFrequency, number> = { WEEKLY: 1, BIWEEKLY: 2, SEMIMONTHLY: 52 / 24, MONTHLY: 52 / 12, DAILY: 1 / 5 };
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * This check's contributions for every program of `state`. Employee lines
 * are withheld; employer lines carry `employer: true`.
 */
export function programLines(input: EmployeePeriodInput, state: string | null): TaxLine[] {
  const out: TaxLine[] = [];
  for (const p of programsFor(state)) {
    if (p.exemptCertificate && input.certificates.some((c) => c.kind === p.exemptCertificate && (!c.state || c.state.toUpperCase() === p.state))) {
      out.push({ code: p.code, kind: 'STATE_PROGRAM', label: p.label, resident: false, workState: p.state, wages: 0, amount: 0, employer: false, note: 'Exemption on file.' });
      continue;
    }
    const st = p.state;
    const baseWages = Math.max(0, (p.base === 'ui' ? input.bases?.stateUi?.[st] : input.bases?.stateProgram?.[st]) ?? input.bases?.stateProgram?.[st] ?? input.wages);
    const ytd = Math.max(0, input.ytdProgramWages?.[p.code] ?? 0);
    const subject = p.wageCap === null ? baseWages : Math.max(0, Math.min(baseWages, p.wageCap - ytd));
    const size = input.employerSize;
    const shares = p.bySize && typeof size === 'number' ? p.bySize(size) : null;
    const eeRate = shares?.employeeRate ?? p.employeeRate;
    const erRate = shares?.employerRate ?? p.employerRate;
    const sizeNote = shares?.note ?? (p.bySize ? 'Employer headcount not set: treated as a large employer.' : null);
    if (eeRate > 0) {
      let amount = subject * eeRate;
      let capNote: string | null = null;
      if (p.weeklyEmployeeMax !== undefined) {
        const max = p.weeklyEmployeeMax * WEEKS_PER_PERIOD[input.payFrequency];
        if (amount > max) {
          amount = max;
          capNote = `Capped at $${p.weeklyEmployeeMax.toFixed(2)} a week.`;
        }
      }
      if (p.wageCap !== null && subject < baseWages) capNote = subject === 0 ? `Annual wage cap of $${p.wageCap.toLocaleString('en-US')} reached.` : `Reaches the annual wage cap of $${p.wageCap.toLocaleString('en-US')} on this check.`;
      out.push({
        code: p.code,
        kind: 'STATE_PROGRAM',
        label: p.label,
        resident: false,
        workState: st,
        wages: round2(subject),
        amount: round2(amount),
        employer: false,
        note: [capNote, sizeNote, p.note ?? null].filter(Boolean).join(' ') || null,
      });
    }
    if (erRate > 0) {
      out.push({
        code: `${p.code}_ER`,
        kind: 'STATE_PROGRAM',
        label: `${p.label} (employer)`,
        resident: false,
        workState: st,
        wages: round2(subject),
        amount: round2(subject * erRate),
        employer: true,
        note: ['Employer-paid; not taken from the paycheck.', sizeNote].filter(Boolean).join(' '),
      });
    }
  }
  return out;
}

/** Program codes of a state that aren't verified for the current year (none today). */
export function programsAwaitingReview(state: string | null): StateProgram[] {
  return programsFor(state).filter((p) => !p.verified);
}
