import { apiFetch } from './api';

export interface DirectReport {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employmentType: string;
  departmentName: string | null;
  jobTitle: string | null;
  /** When the last 1:1 with them was held (absent on an older API). */
  lastOneOnOneAt?: string | null;
  /** The next 1:1 on the calendar. */
  nextOneOnOne?: { id: string; scheduledFor: string; cadence: string | null } | null;
}

/** A manager books a 1:1 with their own report — repeating with a cadence. */
export function bookTeamOneOnOne(
  associateId: string,
  input: { scheduledFor: string; cadence?: 'WEEKLY' | 'BIWEEKLY' | null; agenda?: string | null },
): Promise<{ id: string; scheduledFor: string }> {
  return apiFetch(`/team/reports/${associateId}/one-on-ones`, { method: 'POST', body: input });
}

export interface TeamDashboard {
  directReports: number;
  pendingTimesheets: number;
  pendingTimeOff: number;
  pendingReimbursements: number;
  atRiskGoals: number;
  onboardingInProgress: number;
}

export interface InboxItem {
  id: string;
  kind: 'TIMESHEET' | 'TIME_OFF' | 'REIMBURSEMENT' | 'GOAL_AT_RISK';
  associateId: string;
  associateName: string;
  summary: string;
  link: string;
  pendingSince: string;
  ageDays: number;
}

export interface TeamInboxResponse {
  items: InboxItem[];
  categories: TeamDashboard;
}

export interface TeamTimeEntry {
  id: string;
  associateId: string;
  associateName: string;
  clientId: string | null;
  clientName: string | null;
  clockInAt: string;
  clockOutAt: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'APPROVED' | 'REJECTED';
  notes: string | null;
  rejectionReason: string | null;
  payRate: number | null;
}

export interface TeamTimeOffRequest {
  id: string;
  associateId: string;
  /** Null when the associate record was removed — the API returns null
   *  here and this was declared non-null, so string methods on it threw. */
  associateName: string | null;
  category: string;
  startDate: string;
  endDate: string;
  requestedMinutes: number;
  reason: string | null;
  status: string;
  reviewerEmail: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export function listReports(): Promise<{ reports: DirectReport[] }> {
  return apiFetch('/team/reports');
}

export function getTeamDashboard(): Promise<TeamDashboard> {
  return apiFetch('/team/dashboard');
}

export function getTeamInbox(): Promise<TeamInboxResponse> {
  return apiFetch('/team/inbox');
}

export function listTeamTimesheets(
  status: TeamTimeEntry['status'] = 'COMPLETED',
): Promise<{ entries: TeamTimeEntry[] }> {
  return apiFetch(`/team/timesheets?status=${status}`);
}

export function approveTeamTimesheet(id: string): Promise<{ ok: true }> {
  return apiFetch(`/team/timesheets/${id}/approve`, { method: 'POST' });
}

export interface BulkApproveResult {
  approved: number;
  skipped: { id: string; reason: string }[];
}

export function bulkApproveTeamTimesheets(
  ids: string[],
): Promise<BulkApproveResult> {
  return apiFetch('/team/timesheets/bulk-approve', {
    method: 'POST',
    body: { ids },
  });
}

export function bulkApproveTeamTimeOff(
  ids: string[],
): Promise<BulkApproveResult> {
  return apiFetch('/team/timeoff/bulk-approve', {
    method: 'POST',
    body: { ids },
  });
}

export function rejectTeamTimesheet(
  id: string,
  reason: string,
): Promise<{ ok: true }> {
  return apiFetch(`/team/timesheets/${id}/reject`, {
    method: 'POST',
    body: { reason },
  });
}

export function listTeamTimeOff(
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' = 'PENDING',
): Promise<{ requests: TeamTimeOffRequest[] }> {
  return apiFetch(`/team/timeoff?status=${status}`);
}

export function approveTeamTimeOff(
  id: string,
  note?: string,
): Promise<{ ok: true }> {
  return apiFetch(`/team/timeoff/${id}/approve`, {
    method: 'POST',
    body: note ? { note } : undefined,
  });
}

export function denyTeamTimeOff(
  id: string,
  note: string,
): Promise<{ ok: true }> {
  return apiFetch(`/team/timeoff/${id}/deny`, {
    method: 'POST',
    body: { note },
  });
}

/** The Manager's home beyond the approval queues (GET /team/home). */
export interface TeamHomePerson {
  associateId: string;
  associateName: string;
}
export interface TeamHome {
  due: {
    reviews: Array<TeamHomePerson & { lastPeriodEnd: string | null; overdueDays: number }>;
    oneOnOnes: Array<TeamHomePerson & { id: string; scheduledFor: string }>;
    probations: Array<TeamHomePerson & { id: string; endDate: string }>;
    rampMilestones: Array<TeamHomePerson & { id: string; planId: string; title: string; dueOn: string; status: string }>;
    documents: Array<TeamHomePerson & { id: string; kind: string; expiresAt: string; expired: boolean }>;
    credentials: Array<TeamHomePerson & { id: string; name: string; expiresAt: string; expired: boolean }>;
    pips: Array<TeamHomePerson & { id: string; endDate: string }>;
  };
  today: {
    shifts: Array<TeamHomePerson & { id: string; startsAt: string; endsAt: string; position: string; location: string | null }>;
    onClock: Array<TeamHomePerson & { since: string }>;
    out: Array<TeamHomePerson & { category: string; until: string }>;
    celebrations: Array<TeamHomePerson & { kind: 'BIRTHDAY' | 'ANNIVERSARY'; years: number | null }>;
  };
  suggestions: Array<{ key: string; text: string; link: string; count: number }>;
}

export const getTeamHome = () => apiFetch<TeamHome>('/team/home');
