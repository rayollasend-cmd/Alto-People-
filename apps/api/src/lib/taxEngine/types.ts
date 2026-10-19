import type { PayFrequency } from '../payrollTax.js';
import type { StateW4Input } from '../stateWithholding.js';
import type { W4FilingStatus } from '@prisma/client';

/** One place a worker earned wages this period: the work site of their time entries. */
export interface WorkAllocation {
  state: string | null;
  city: string | null;
  county?: string | null;
  zip?: string | null;
  /** Payable hours here this period; wages are allocated in proportion. */
  hours: number;
}

/** Where the worker lives, and what payroll set by hand when the address can't decide. */
export interface Residence {
  state: string | null;
  city: string | null;
  zip?: string | null;
  county?: string | null;
  psdCode?: string | null;
  municipality?: string | null;
  schoolDistrict?: string | null;
  countyJan1?: string | null;
  localCode?: string | null;
}

export interface CertificateOnFile {
  kind: string;
  state: string | null;
  jurisdictionCode: string | null;
}

export interface EmployeePeriodInput {
  /** The FIT base (wages net of pre-tax deductions) for the whole check. */
  wages: number;
  payFrequency: PayFrequency;
  residence: Residence;
  work: WorkAllocation[];
  certificates: CertificateOnFile[];
  federalFilingStatus: W4FilingStatus | null;
  /** This cycle's federal withholding (AL and OR subtract it). */
  federalCycleWithholding: number;
  /** The state certificates on file, by state. */
  stateW4s: Record<string, StateW4Input>;
  /**
   * Wage bases that differ from `wages` because a deduction's tax treatment
   * differs by tax and by state (lib/deductionTaxability.ts). Each figure is
   * the WHOLE check's taxable wages under that rule, before allocation; the
   * engine allocates it across work states by hours exactly as it does
   * `wages`. Absent means "use `wages`".
   */
  bases?: {
    /** State income tax base, per state (PA and NJ tax 401(k) deferrals, CA and NJ tax HSA …). */
    stateIncome?: Record<string, number>;
    /** Wages subject to a state disability / paid-leave program, per state (CA SDI, NJ TDI/FLI, NY DBL/PFL, WA PFML …). */
    stateProgram?: Record<string, number>;
    /** Wages subject to state unemployment insurance, per state. */
    stateUi?: Record<string, number>;
    /** Wages for local income taxes (PA EIT includes 401(k) deferrals …). */
    local?: number;
  };
  /** Year-to-date wages already taxed by each state program code (e.g. "WA_PFML"), for wage-base caps. */
  ytdProgramWages?: Record<string, number>;
  /**
   * Withhold the state disability / paid-leave / employee-UI programs
   * (taxEngine/statePrograms.ts). Opt-in so a caller that doesn't yet
   * subtract `programTotal` from net pay never shows a contribution it
   * didn't take.
   */
  includePrograms?: boolean;
  /** Covered employees on the employer's payroll, for headcount-tiered programs (WA, OR, MA, CO, DE). Unknown = large. */
  employerSize?: number;
}

/** STATE_PROGRAM: a state disability or paid-leave contribution (CA SDI, NJ TDI/FLI, NY DBL/PFL, WA PFML / WA Cares, MA, OR, CO, CT, RI, HI, DE, MN …). */
export type TaxLineKind = 'STATE' | 'LOCAL' | 'SCHOOL' | 'TRANSIT' | 'OLT' | 'EMPLOYER' | 'SUI' | 'STATE_PROGRAM';

export interface TaxLine {
  code: string;
  kind: TaxLineKind;
  label: string;
  resident: boolean;
  workState: string | null;
  wages: number;
  amount: number;
  /** Employer-paid (not withheld from the paycheck). */
  employer: boolean;
  note: string | null;
}

export interface EmployeePeriodResult {
  lines: TaxLine[];
  /** Withheld state income tax, all states. */
  stateTotal: number;
  /** Withheld local taxes (local, school, OLT, transit), all jurisdictions. */
  localTotal: number;
  /** Employer-paid local payroll taxes. */
  employerLocalTotal: number;
  /** Withheld state program contributions (SDI, PFML, employee UI …): subtract from net pay. */
  programTotal: number;
  /** Employer-paid state program contributions. */
  employerProgramTotal: number;
  /** Wages per work state (allocation by hours). */
  wagesByState: Record<string, number>;
  /** The state unemployment insurance is reported to, and why (four-factor test). */
  sui: { state: string | null; reason: string };
  /** Local jurisdictions this check owes, for the review gate. */
  jurisdictionsUsed: string[];
  /** Questions the engine couldn't answer (a PA resident with no PSD code …). */
  unresolved: string[];
  /** Which engine answered. */
  engine: 'IN_HOUSE' | 'SYMMETRY_STE' | 'VERTEX_PAYROLL';
}

/** A tax engine: Alto's own, or a licensed one behind a tenant's connection. */
export interface TaxEngineProvider {
  readonly key: EmployeePeriodResult['engine'];
  calculate(input: EmployeePeriodInput): Promise<EmployeePeriodResult>;
  /** The local jurisdictions an address falls in. */
  resolveJurisdictions(address: { state: string | null; city: string | null; zip?: string | null; county?: string | null }): Promise<string[]>;
}
