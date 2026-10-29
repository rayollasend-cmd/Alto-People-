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
  locationId?: string | null;
  locationName?: string | null;
  /** The store's street address and point — what "Directions" opens (ASSOC-10). */
  locationAddress?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  /** The store's IANA zone: the shift is shown on its clock (fmtShiftTz). */
  timezone?: string | null;
  /** A site they have not worked at — the feed says so before they tap. */
  newForYou?: boolean;
  /** They said "Not for me" — the feed folds it away (Undo brings it back). */
  declinedByMe?: boolean;
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
  /** The store's IANA zone. */
  timezone?: string | null;
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

export const listOpenShifts = () =>
  apiFetch<{ shifts: OpenShiftListItem[] }>('/shifts/open');
// alreadyClaimed comes back (200, not 201) when a duplicate request lands
// on a claim that already exists — the id is that existing claim's.
export const claimShift = (shiftId: string) =>
  apiFetch<{ id: string; alreadyClaimed?: boolean }>(
    `/shifts/${shiftId}/claim`,
    { method: 'POST', body: {} },
  );
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
