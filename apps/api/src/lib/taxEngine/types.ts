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
}

export type TaxLineKind = 'STATE' | 'LOCAL' | 'SCHOOL' | 'TRANSIT' | 'OLT' | 'EMPLOYER' | 'SUI';

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
