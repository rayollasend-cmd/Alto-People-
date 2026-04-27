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
}

export interface TeamDashboard {
  directReports: number;
  pendingTimesheets: number;
  pendingTimeOff: number;
  onboardingInProgress: number;
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
  payRate: string | null;
}

export interface TeamTimeOffRequest {
  id: string;
  associateId: string;
  associateName: string;
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

export function listTeamTimesheets(
  status: TeamTimeEntry['status'] = 'COMPLETED',
): Promise<{ entries: TeamTimeEntry[] }> {
  return apiFetch(`/team/timesheets?status=${status}`);
}

export function approveTeamTimesheet(id: string): Promise<{ ok: true }> {
  return apiFetch(`/team/timesheets/${id}/approve`, { method: 'POST' });
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
