import { apiFetch } from './api';

/**
 * Access pack — access certification campaigns: every account in scope
 * reviewed by its manager (or the campaign's owner) with a decision and a
 * note; closing records the tally. A REVOKE is a finding the owner acts on
 * in Users & access, never an automatic change.
 */

export type CertificationScope = 'ALL' | 'INTERNAL' | 'CLIENT' | 'ASSOCIATE';
export type CertificationDecision = 'KEEP' | 'REVOKE' | 'CHANGE';

export interface CertificationSummary {
  id: string;
  name: string;
  scope: CertificationScope;
  status: 'OPEN' | 'CLOSED';
  dueAt: string;
  createdAt: string;
  closedAt: string | null;
  items: number;
  decided: number;
  revoke: number;
  change: number;
  /** Undecided items waiting on the signed-in person. */
  mine: number;
}

export interface CertificationPerson {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
  status: string | null;
}

export interface CertificationItem {
  id: string;
  subject: CertificationPerson | null;
  reviewer: CertificationPerson | null;
  snapshot: {
    role?: string;
    additionalRoles?: string[];
    clientId?: string | null;
    locationId?: string | null;
    regionId?: string | null;
    scopeSiteIds?: string[];
    scopeRegionIds?: string[];
    breakGlass?: boolean;
    lastSeenAt?: string | null;
  };
  decision: CertificationDecision | null;
  note: string | null;
  decidedBy: CertificationPerson | null;
  decidedAt: string | null;
  mine: boolean;
}

export interface CertificationDetail extends Omit<CertificationSummary, 'mine' | 'items'> {
  runs: boolean;
  items: CertificationItem[];
}

export const listCertifications = () => apiFetch<{ runs: boolean; certifications: CertificationSummary[] }>('/admin/access-certifications');
export const getCertification = (id: string) => apiFetch<CertificationDetail>(`/admin/access-certifications/${id}`);
export const openCertification = (input: { name: string; scope: CertificationScope; dueAt: string }) =>
  apiFetch<{ id: string; items: number }>('/admin/access-certifications', { method: 'POST', body: input });
export const decideCertificationItem = (id: string, itemId: string, input: { decision: CertificationDecision; note?: string }) =>
  apiFetch<void>(`/admin/access-certifications/${id}/items/${itemId}/decide`, { method: 'POST', body: input });
export const closeCertification = (id: string) => apiFetch<{ keep: number; revoke: number; change: number }>(`/admin/access-certifications/${id}/close`, { method: 'POST', body: {} });
export const certificationExportUrl = (id: string) => `/api/admin/access-certifications/${id}/export.csv`;
