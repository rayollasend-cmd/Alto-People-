import { apiFetch } from './api';

// Brief 2-2 step 2 — the labor rules in force per site (read-only).

export interface LaborRuleSummary {
  weeklyOvertimeHours: number | null;
  dailyOvertimeHours: number | null;
  doubleTimeHours: number | null;
  seventhDayRule: boolean;
  minimumWageCents: number | null;
  mealRequiredAfterHours: number | null;
  restPerHours: number | null;
  restBetweenShiftsHours: number | null;
  predictiveNoticeDays: number | null;
  minorBands: number;
}

export interface LaborRuleSite {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  active: boolean;
  jurisdictions: string[];
  layers: string[];
  payable: boolean;
  fingerprint: string;
  summary: LaborRuleSummary;
}

export interface LaborRuleSet {
  id: string;
  jurisdiction: string;
  level: 'FEDERAL' | 'STATE' | 'CITY' | 'TENANT' | 'SITE';
  siteId: string | null;
  effectiveFrom: string;
  version: number;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  shipped: boolean;
  params: Record<string, unknown>;
  source: string;
  sourceDate: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
}

export interface LaborRuleSiteDetail {
  date: string;
  site: { id: string; name: string; city: string | null; state: string | null; timezone: string };
  jurisdictions: string[];
  layers: string[];
  payable: boolean;
  fingerprint: string;
  params: Record<string, unknown>;
  origin: Record<string, string>;
  summary: LaborRuleSummary;
  sets: LaborRuleSet[];
}

export const listLaborRuleSites = (date: string) => apiFetch<{ date: string; sites: LaborRuleSite[] }>(`/labor-rules/sites?date=${date}`);

export const getLaborRuleSite = (id: string, date: string) => apiFetch<LaborRuleSiteDetail>(`/labor-rules/sites/${id}?date=${date}`);

// Brief 2-2 step 3 — the engine in shadow beside each finalized run.

export interface LaborShadowRun {
  id: string;
  payrollRunId: string;
  periodStart: string;
  periodEnd: string;
  associates: number;
  differences: number;
  amountDifference: number;
  penaltyHours: number;
  ranAt: string;
}

export interface LaborShadowDifference {
  associateId: string;
  name: string;
  paid: { regularHours: number; overtimeHours: number };
  engine: { regularHours: number; overtimeHours: number; doubleTimeHours: number };
  hourlyRate: number;
  amountDifference: number;
  penaltyHours: number;
  reasons: string[];
}

export const listLaborShadowRuns = () => apiFetch<{ runs: LaborShadowRun[] }>('/labor-rules/shadow');

export const getLaborShadowRun = (id: string) =>
  apiFetch<{ id: string; periodStart: string; periodEnd: string; associates: number; differences: LaborShadowDifference[] }>(`/labor-rules/shadow/${id}`);

// Brief 2-2 step 6 — the organization's and each site's own rules (manage:org).

export const listLaborRuleSets = () => apiFetch<{ sets: LaborRuleSet[] }>('/labor-rules/sets');

export interface LaborOverrideInput {
  level: 'TENANT' | 'SITE';
  siteId?: string | null;
  effectiveFrom: string;
  params: Record<string, unknown>;
  source: string;
}

export const createLaborOverride = (input: LaborOverrideInput) =>
  apiFetch<{ id: string; status: string; version: number }>('/labor-rules/overrides', { method: 'POST', body: input });

export const activateLaborRuleSet = (id: string, note: string) =>
  apiFetch<{ id: string; status: string }>(`/labor-rules/sets/${id}/activate`, { method: 'POST', body: { note } });

export const retireLaborRuleSet = (id: string) => apiFetch<{ id: string; status: string }>(`/labor-rules/sets/${id}/retire`, { method: 'POST', body: {} });
