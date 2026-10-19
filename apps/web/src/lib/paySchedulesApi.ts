import type {
  AssociatePaySchedule,
  MembershipChangeInput,
  MembershipImpact,
  MoveInput,
  PayCalendarResponse,
  PayFrequencyKind,
  PayScheduleCreateInput,
  PayScheduleDetail,
  PayScheduleHistoryResponse,
  PayScheduleListResponse,
  PayScheduleRosterResponse,
  PayScheduleUpdateInput,
  ScheduleCandidatesResponse,
  UnassignedResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Pay schedules (packages/shared/src/paySchedules.ts): who is paid on which
 * schedule, decided by rules from an effective date.
 */

const B = '/payroll/pay-schedules';

export const listPaySchedules = () => apiFetch<PayScheduleListResponse>(B);

export const getPaySchedule = (id: string) => apiFetch<{ schedule: PayScheduleDetail }>(`${B}/${id}`);

export const createPaySchedule = (body: PayScheduleCreateInput) =>
  apiFetch<{ schedule: PayScheduleDetail }>(B, { method: 'POST', body });

export const updatePaySchedule = (id: string, body: PayScheduleUpdateInput) =>
  apiFetch<{ schedule: PayScheduleDetail }>(`${B}/${id}`, { method: 'PATCH', body });

export const deletePaySchedule = (id: string) => apiFetch<{ ok: true }>(`${B}/${id}`, { method: 'DELETE' });

export const getPayCalendar = (id: string, months = 12) =>
  apiFetch<PayCalendarResponse>(`${B}/${id}/calendar?months=${months}`);

/** `all` = on it today plus everyone joining from a future date. */
export type RosterView = 'current' | 'joining' | 'leaving' | 'blocked' | 'attention' | 'ready' | 'all';
export const getPayScheduleRoster = (id: string, view: RosterView = 'all') => apiFetch<PayScheduleRosterResponse>(`${B}/${id}/people?view=${view}`);

export const getPayScheduleHistory = (id: string) => apiFetch<PayScheduleHistoryResponse>(`${B}/${id}/history`);

export const previewMembership = (id: string, body: MembershipChangeInput) =>
  apiFetch<MembershipImpact>(`${B}/${id}/membership/preview`, { method: 'POST', body });

export const applyMembership = (id: string, body: MembershipChangeInput) =>
  apiFetch<{ impact: MembershipImpact }>(`${B}/${id}/membership`, { method: 'POST', body });

export const endScheduleRule = (id: string, ruleId: string, effectiveFrom: string) =>
  apiFetch<{ impact: MembershipImpact }>(`${B}/${id}/rules/${ruleId}`, { method: 'DELETE', body: { effectiveFrom } });

export const previewMove = (body: MoveInput) => apiFetch<MembershipImpact>(`${B}/move/preview`, { method: 'POST', body });

export const applyMove = (body: MoveInput) => apiFetch<{ impact: MembershipImpact }>(`${B}/move`, { method: 'POST', body });

export const listUnassigned = () => apiFetch<UnassignedResponse>(`${B}/unassigned`);

export interface CandidateFilters {
  clientId?: string;
  siteId?: string;
  departmentId?: string;
  payType?: 'HOURLY' | 'SALARY';
  /** A schedule's id, or 'none' for people on no schedule. */
  scheduleId?: string;
  q?: string;
  /** Inactive people come back only for status=INACTIVE. */
  status?: 'ACTIVE' | 'NEW_HIRE' | 'INACTIVE';
  cursor?: string;
  /** Page size, 1–500 (the API's default is 100). */
  limit?: number;
}

export function listScheduleCandidates(f: CandidateFilters = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  const qs = p.toString();
  return apiFetch<ScheduleCandidatesResponse>(`${B}/candidates${qs ? `?${qs}` : ''}`);
}

/** A new pattern's periods; with scheduleId + effectiveFrom, a change to that schedule from that date (a bridge period first, if one is needed). */
export function previewPattern(input: { frequency: PayFrequencyKind; anchorDate: string; payDateOffsetDays: number; months?: number; scheduleId?: string; effectiveFrom?: string }) {
  const p = new URLSearchParams({
    frequency: input.frequency,
    anchorDate: input.anchorDate,
    payDateOffsetDays: String(input.payDateOffsetDays),
    months: String(input.months ?? 12),
  });
  if (input.scheduleId && input.effectiveFrom) {
    p.set('scheduleId', input.scheduleId);
    p.set('effectiveFrom', input.effectiveFrom);
  }
  return apiFetch<PayCalendarResponse>(`${B}/preview-pattern?${p.toString()}`);
}

export const getAssociatePaySchedule = (associateId: string) =>
  apiFetch<AssociatePaySchedule>(`/associates/${associateId}/pay-schedule`);
