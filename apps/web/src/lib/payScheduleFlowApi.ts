import type {
  AssociatePaySchedule,
  PayCalendarResponse,
  PayScheduleChoicesResponse,
  PayScheduleListResponse,
  PayScheduleSummary,
  PayrollUpcomingSummary,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The pay-schedule calls the payroll flow needs outside the schedules pages:
 * the run wizard (which schedule, which period), the payroll home (every
 * schedule's next payday), onboarding and the person record (which schedule
 * this person is on). Contract: packages/shared/src/paySchedules.ts.
 */

export function listPaySchedulesForFlow(): Promise<PayScheduleListResponse> {
  return apiFetch<PayScheduleListResponse>('/payroll/pay-schedules');
}

/** The schedule's periods from the one containing `from` (default: today's). */
export function getPayScheduleCalendarForFlow(id: string, months = 3, from?: string): Promise<PayCalendarResponse> {
  const qs = new URLSearchParams({ months: String(months), ...(from ? { from } : {}) });
  return apiFetch<PayCalendarResponse>(`/payroll/pay-schedules/${id}/calendar?${qs}`);
}

export function getAssociatePaySchedule(associateId: string): Promise<AssociatePaySchedule> {
  return apiFetch<AssociatePaySchedule>(`/associates/${associateId}/pay-schedule`);
}

/** The schedules this person could be put on — for a picker whose user cannot read the payroll list (the onboarding desk). */
export function listPayScheduleChoices(associateId: string): Promise<PayScheduleChoicesResponse> {
  return apiFetch<PayScheduleChoicesResponse>(`/associates/${associateId}/pay-schedule/choices`);
}

export function setAssociatePaySchedule(associateId: string, body: { scheduleId: string; effectiveFrom?: string }): Promise<AssociatePaySchedule> {
  return apiFetch<AssociatePaySchedule>(`/associates/${associateId}/pay-schedule`, { method: 'PUT', body });
}

/** The pay-schedule list, shared by the run wizard, the payroll home and the person panels. */
export const PAY_SCHEDULES_FLOW_KEY = ['payScheduleFlow', 'list'] as const;

/** The next due run of one schedule, as the payroll home lists them. */
export type UpcomingBySchedule = NonNullable<PayrollUpcomingSummary['bySchedule']>[number];

export type PayrollUpcomingWithSchedules = PayrollUpcomingSummary;

export type FlowSchedule = PayScheduleSummary;
