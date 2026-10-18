import { apiFetch } from './api';

/** Local and multi-state taxes (apps/api/src/routes/taxJurisdictions.ts). */

export type JurisdictionKind = 'LOCAL' | 'SCHOOL' | 'TRANSIT' | 'OLT' | 'EMPLOYER';
export type ReviewStatus = 'reviewed' | 'outdated' | 'awaiting';
export type TaxLineKind = JurisdictionKind | 'STATE' | 'SUI';

export interface JurisdictionRow {
  code: string;
  state: string;
  name: string;
  kind: JurisdictionKind;
  basis: string;
  rate: string;
  residentRate: number | null;
  nonresidentRate: number | null;
  annualAmount: number | null;
  administeredBy: string | null;
  taxYear: number;
  source: string;
  confidence: 'high' | 'medium' | 'low';
  note: string | null;
  workers: number;
  review: { status: ReviewStatus; taxYear: number | null; at: string | null; by: string | null; note: string | null };
}

export interface JurisdictionsResponse {
  engine: { key: string; label: string; environment: string | null };
  jurisdictions: JurisdictionRow[];
  counts: { inUse: number; awaitingInUse: number; reviewed: number; blockedWorkers: number; unresolvedWorkers: number };
  unresolved: Array<{ associateId: string; name: string; questions: string[] }>;
}

export interface TaxLine {
  code: string;
  kind: TaxLineKind;
  label: string;
  resident: boolean;
  workState: string | null;
  wages: number;
  amount: number;
  employer: boolean;
  note: string | null;
}

export interface CalcResponse {
  code: string;
  resident: boolean;
  wages: number;
  frequency: string;
  lines: TaxLine[];
  localTotal: number;
  stateTotal: number;
  employerLocalTotal: number;
  unresolved: string[];
}

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

export const getJurisdictions = () => apiFetch<JurisdictionsResponse>('/payroll/tax-jurisdictions');
export const acknowledgeJurisdiction = (code: string, note?: string) =>
  apiFetch<{ ok: true }>(`/payroll/tax-jurisdictions/${encodeURIComponent(code)}/acknowledge`, { method: 'POST', body: { confirm: true, ...(note ? { note } : {}) } });
export const revokeJurisdiction = (code: string) =>
  apiFetch<void>(`/payroll/tax-jurisdictions/${encodeURIComponent(code)}/acknowledge`, { method: 'DELETE' });
export function calculateJurisdiction(i: { code: string; wages: number; frequency: PayFrequency; resident: boolean }) {
  const qs = new URLSearchParams({ code: i.code, wages: String(i.wages), frequency: i.frequency, resident: String(i.resident) });
  return apiFetch<CalcResponse>(`/payroll/tax-jurisdictions/calculate?${qs.toString()}`);
}

export interface ReciprocityResponse {
  source: string;
  agreements: Array<{ workState: string; residentStates: string[]; form: string }>;
  convenienceOfEmployer: Array<{ state: string; name: string }>;
}
export const getReciprocity = () => apiFetch<ReciprocityResponse>('/payroll/tax-reciprocity');

export type CertificateKind = 'NONRESIDENCY' | 'LST_EXEMPTION' | 'PA_RESIDENCY' | 'OH_IT4' | 'NY_LOCAL';

export interface TaxProfile {
  associateId: string;
  name: string;
  employmentType: string;
  home: { state: string | null; city: string | null; zip: string | null };
  workSites: Array<{ name: string; state: string | null; city: string | null }>;
  profile: {
    residentPsdCode: string | null;
    residentMunicipality: string | null;
    residentSchoolDistrict: string | null;
    residentCountyJan1: string | null;
    residentLocalCode: string | null;
    notes: string | null;
    updatedAt: string | null;
  };
  certificates: Array<{
    id: string;
    kind: CertificateKind;
    state: string | null;
    jurisdictionCode: string | null;
    formName: string | null;
    signedOn: string | null;
    effectiveFrom: string | null;
    createdAt: string;
  }>;
  withholding: Array<{
    code: string;
    kind: TaxLineKind;
    label: string;
    resident: boolean;
    employer: boolean;
    rate: string | null;
    why: string;
    note: string | null;
    review: 'awaiting' | 'reviewed' | null;
  }>;
  unresolved: string[];
  manualLocalRule: string | null;
}

export type TaxProfileInput = Partial<Pick<TaxProfile['profile'], 'residentPsdCode' | 'residentMunicipality' | 'residentSchoolDistrict' | 'residentCountyJan1' | 'residentLocalCode' | 'notes'>>;

export interface CertificateInput {
  kind: CertificateKind;
  state: string;
  jurisdictionCode?: string | null;
  signedOn?: string | null;
  psdCode?: string;
  schoolDistrict?: string;
  municipality?: string;
}

export const getTaxProfile = (associateId: string) => apiFetch<TaxProfile>(`/payroll/tax-profile/${associateId}`);
export const saveTaxProfile = (associateId: string, body: TaxProfileInput) =>
  apiFetch<TaxProfile>(`/payroll/tax-profile/${associateId}`, { method: 'PUT', body });
export const addTaxCertificate = (associateId: string, body: CertificateInput) =>
  apiFetch<TaxProfile>(`/payroll/tax-profile/${associateId}/certificates`, { method: 'POST', body });
export const revokeTaxCertificate = (associateId: string, id: string) =>
  apiFetch<void>(`/payroll/tax-profile/${associateId}/certificates/${id}`, { method: 'DELETE' });

export interface RunTaxLines {
  jurisdictions: Array<{ code: string; kind: TaxLineKind; name: string; employer: boolean; wages: number; amount: number; people: number }>;
  totals: { state: number; local: number; employer: number };
}
export const getRunTaxLines = (runId: string) => apiFetch<RunTaxLines>(`/payroll/runs/${runId}/tax-lines`);
