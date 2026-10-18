import { apiFetch } from './api';

/** Leave of absence (apps/api/src/routes/leave.ts). */

export type LeaveType = 'FMLA' | 'STATE_PFML' | 'MILITARY_USERRA' | 'ADA_ACCOMMODATION' | 'PERSONAL' | 'COMPANY';
export type LeaveReason = 'OWN_HEALTH' | 'FAMILY_CARE' | 'BONDING' | 'PREGNANCY' | 'MILITARY_EXIGENCY' | 'MILITARY_CAREGIVER' | 'MILITARY_SERVICE' | 'ACCOMMODATION' | 'OTHER';
export type LeaveSchedule = 'CONTINUOUS' | 'INTERMITTENT' | 'REDUCED';
export type LeaveStatus = 'REQUESTED' | 'PENDING_CERTIFICATION' | 'APPROVED' | 'DENIED' | 'RETURNED' | 'CLOSED' | 'CANCELLED';
export type LeaveDocumentKind = 'MEDICAL_CERTIFICATION' | 'FITNESS_FOR_DUTY' | 'MILITARY_ORDERS' | 'OTHER';

export interface FmlaEligibility {
  eligible: boolean;
  coveredEmployer: boolean;
  monthsOfService: number;
  hoursLast12Months: number;
  worksiteMeets50In75: boolean;
  averageWeeklyHours: number;
  reasons: string[];
  asOf: string;
}

export interface FmlaBalance {
  periodStart: string;
  periodEnd: string;
  method: 'ROLLING_BACKWARD' | 'ROLLING_FORWARD' | 'CALENDAR' | 'FIXED';
  weeklyHours: number;
  entitlementHours: number;
  usedHours: number;
  remainingHours: number;
  remainingWeeks: number;
}

export interface NextStep {
  key: string;
  label: string;
  dueAt: string | null;
  overdue: boolean;
}

export interface LeaveCase {
  id: string;
  associateId: string;
  associateName: string;
  type: LeaveType;
  reason: LeaveReason;
  stateProgram: string | null;
  stateProgramName: string | null;
  schedule: LeaveSchedule;
  startDate: string;
  endDate: string | null;
  intermittentPattern: string | null;
  reducedHoursPerWeek: number | null;
  status: LeaveStatus;
  requestedBySelf: boolean;
  eligibility: FmlaEligibility | null;
  noticeSentAt: string | null;
  designationSentAt: string | null;
  designatedFmla: boolean | null;
  certificationRequired: boolean;
  certificationDueAt: string | null;
  certificationReceivedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  fitnessForDutyRequired: boolean;
  fitnessForDutyReceivedAt: string | null;
  expectedReturnDate: string | null;
  actualReturnDate: string | null;
  benefitsNote: string | null;
  shiftsReleased: number;
  jobProtected: boolean;
  notes: string | null;
  documents: Array<{ id: string; kind: LeaveDocumentKind; filename: string; mimeType: string; size: number; createdAt: string }>;
  usage: Array<{ id: string; date: string; hours: number; shiftId: string | null; note: string | null }>;
  usedHours: number;
  next: NextStep | null;
  createdAt: string;
}

export interface MyLeaveCase {
  id: string;
  type: LeaveType;
  reason: LeaveReason;
  stateProgramName: string | null;
  schedule: LeaveSchedule;
  startDate: string;
  endDate: string | null;
  status: LeaveStatus;
  certificationRequired: boolean;
  certificationDueAt: string | null;
  certificationReceived: boolean;
  fitnessForDutyRequired: boolean;
  fitnessForDutyReceived: boolean;
  noticeAvailable: boolean;
  designationAvailable: boolean;
  decisionNote: string | null;
  expectedReturnDate: string | null;
  jobProtected: boolean;
  documents: Array<{ id: string; kind: LeaveDocumentKind; filename: string; createdAt: string }>;
  createdAt: string;
}

export interface LeaveSummary {
  open: number;
  onLeave: number;
  certificationsDueThisWeek: number;
  noticesOwed: number;
  returningThisWeek: number;
}

export interface StateProgram {
  code: string;
  state: string;
  name: string;
  administrator: string;
}

export interface CaseInput {
  type: LeaveType;
  reason: LeaveReason;
  stateProgram?: string | null;
  schedule: LeaveSchedule;
  startDate: string;
  endDate?: string | null;
  intermittentPattern?: string | null;
  reducedHoursPerWeek?: number | null;
  notes?: string | null;
}

export const listLeavePrograms = () => apiFetch<{ programs: StateProgram[] }>('/leave/programs');
export const getLeaveSummary = () => apiFetch<LeaveSummary>('/leave/summary');
export const listLeaveCases = (q: { status?: string; type?: string; q?: string; page?: number } = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return apiFetch<{ cases: LeaveCase[]; total: number; page: number; pageSize: number; hasMore: boolean }>(`/leave/cases?${p.toString()}`);
};
export const getLeaveCase = (id: string) => apiFetch<{ case: LeaveCase; balance: FmlaBalance | null }>(`/leave/cases/${id}`);
export const getEligibility = (associateId: string, startDate?: string) =>
  apiFetch<{ eligibility: FmlaEligibility; balance: FmlaBalance }>(`/leave/eligibility/${associateId}${startDate ? `?startDate=${startDate}` : ''}`);
export const openLeaveCase = (body: CaseInput & { associateId: string }) => apiFetch<{ case: LeaveCase }>('/leave/cases', { method: 'POST', body });
export const sendLeaveNotice = (id: string) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/notice`, { method: 'POST' });
export const decideLeave = (
  id: string,
  body: { decision: 'APPROVE' | 'DENY'; designatedFmla?: boolean; note?: string; fitnessForDutyRequired?: boolean; benefitsNote?: string; expectedReturnDate?: string | null },
) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/decide`, { method: 'POST', body });
export const logLeaveUsage = (id: string, body: { date: string; hours: number; note?: string | null }) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/usage`, { method: 'POST', body });
export const recordReturn = (id: string, body: { actualReturnDate: string; overrideReason?: string }) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/return`, { method: 'POST', body });
export const closeLeave = (id: string) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/close`, { method: 'POST' });
export const cancelLeave = (id: string) => apiFetch<{ case: LeaveCase }>(`/leave/cases/${id}/cancel`, { method: 'POST' });
export const leaveNoticeUrl = (id: string, kind: 'eligibility' | 'designation') => `/api/leave/cases/${id}/notices/${kind}`;
export const myLeaveNoticeUrl = (id: string, kind: 'eligibility' | 'designation') => `/api/me/leave/${id}/notices/${kind}`;
export const leaveDocumentUrl = (docId: string) => `/api/leave/documents/${docId}`;

/** Multipart upload — apiFetch JSON-encodes, so this goes to fetch directly. */
export async function uploadLeaveDocument(id: string, kind: LeaveDocumentKind, file: File, mine = false): Promise<{ id: string }> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);
  const res = await fetch(mine ? `/api/me/leave/${id}/documents` : `/api/leave/cases/${id}/documents`, { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return res.json();
}

export const listMyLeave = () => apiFetch<{ cases: MyLeaveCase[]; linked: boolean }>('/me/leave');
export const requestMyLeave = (body: CaseInput) => apiFetch<{ case: MyLeaveCase }>('/me/leave', { method: 'POST', body });
export const getProtectedLeave = (associateId: string) =>
  apiFetch<{ protectedLeave: { caseId: string; type: LeaveType; schedule: LeaveSchedule; status: LeaveStatus; from: string; to: string | null; expectedReturnDate: string | null } | null }>(`/leave/people/${associateId}/status`);
