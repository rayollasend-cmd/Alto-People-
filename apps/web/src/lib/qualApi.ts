import { apiFetch } from './api';

export interface Qualification {
  id: string;
  clientId: string | null;
  code: string;
  name: string;
  description: string | null;
  isCert: boolean;
}

export interface AssociateQualification {
  id: string;
  qualificationId: string;
  code: string;
  name: string;
  isCert: boolean;
  acquiredAt: string | null;
  expiresAt: string | null;
  evidenceKey: string | null;
}

export interface OpenShiftListItem {
  id: string;
  clientId: string;
  clientName: string;
  position: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  payRate: string | null;
  requirements: { id: string; code: string; name: string }[];
  myPendingClaim: string | null;
}

export interface PendingClaim {
  id: string;
  shiftId: string;
  associateId: string;
  associateName: string;
  position: string;
  clientName: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export const listQualifications = (clientId?: string) =>
  apiFetch<{ qualifications: Qualification[] }>(
    clientId ? `/qualifications?clientId=${clientId}` : '/qualifications',
  );
export const createQualification = (input: {
  clientId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  isCert?: boolean;
}) => apiFetch<{ id: string }>('/qualifications', { method: 'POST', body: input });
export const deleteQualification = (id: string) =>
  apiFetch<void>(`/qualifications/${id}`, { method: 'DELETE' });

export const listAssociateQuals = (associateId: string) =>
  apiFetch<{ qualifications: AssociateQualification[] }>(
    `/qualifications/associates/${associateId}`,
  );
export const grantAssociateQual = (
  associateId: string,
  input: {
    qualificationId: string;
    acquiredAt?: string | null;
    expiresAt?: string | null;
    evidenceKey?: string | null;
  },
) =>
  apiFetch<{ id: string }>(`/qualifications/associates/${associateId}`, {
    method: 'POST',
    body: input,
  });
export const revokeAssociateQual = (associateId: string, assocQualId: string) =>
  apiFetch<void>(`/qualifications/associates/${associateId}/${assocQualId}`, {
    method: 'DELETE',
  });

export const listShiftRequirements = (shiftId: string) =>
  apiFetch<{ requirements: { id: string; qualificationId: string; code: string; name: string }[] }>(
    `/shifts/${shiftId}/qualifications`,
  );
export const addShiftRequirement = (shiftId: string, qualificationId: string) =>
  apiFetch<{ id: string }>(`/shifts/${shiftId}/qualifications`, {
    method: 'POST',
    body: { qualificationId },
  });
export const removeShiftRequirement = (shiftId: string, reqId: string) =>
  apiFetch<void>(`/shifts/${shiftId}/qualifications/${reqId}`, { method: 'DELETE' });

export const listOpenShifts = () =>
  apiFetch<{ shifts: OpenShiftListItem[] }>('/shifts/open');
export const claimShift = (shiftId: string) =>
  apiFetch<{ id: string }>(`/shifts/${shiftId}/claim`, { method: 'POST', body: {} });
export const updateClaim = (
  shiftId: string,
  claimId: string,
  status: 'APPROVED' | 'REJECTED' | 'WITHDRAWN',
  decisionNote?: string | null,
) =>
  apiFetch<{ ok: true }>(`/shifts/${shiftId}/claims/${claimId}`, {
    method: 'PUT',
    body: { status, decisionNote },
  });
export const listPendingClaims = () =>
  apiFetch<{ claims: PendingClaim[] }>('/shifts/claims/pending');
