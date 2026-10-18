import { apiFetch } from './api';

export interface ExpirationItem {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  qualificationId: string;
  qualificationCode: string;
  qualificationName: string;
  isCert: boolean;
  expiresAt: string;
  daysUntilExpiry: number;
}

export interface ExpirationsResponse {
  days: number;
  counts: { expired: number; dueSoon: number; dueLater: number };
  expired: ExpirationItem[];
  dueSoon: ExpirationItem[];
  dueLater: ExpirationItem[];
}

export const getExpirations = (params?: { days?: number; isCert?: boolean }) => {
  const q = new URLSearchParams();
  if (params?.days) q.set('days', String(params.days));
  if (typeof params?.isCert === 'boolean') q.set('isCert', String(params.isCert));
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<ExpirationsResponse>(`/expirations${suffix}`);
};

/* ----- Expirations by the shift they block (GET /expirations/risk) ----- */

export interface RiskShift {
  id: string;
  startsAt: string;
  storeId: string | null;
  storeName: string | null;
  position: string;
}

export interface RiskItem extends ExpirationItem {
  storeId: string | null;
  storeName: string | null;
  clientId: string | null;
  clientName: string | null;
  nextShift: RiskShift | null;
  blockingShift: (RiskShift & { requiredBy: 'shift' | 'site' | 'client' }) | null;
}

export interface ExpirationTimelineRow {
  storeId: string | null;
  storeName: string;
  clientName: string | null;
  expired: number;
  perWeek: number[];
}

export interface ExpirationRisk {
  asOf: string;
  days: number;
  truncated: boolean;
  items: RiskItem[];
  atRisk: string[];
  weeks: string[];
  timeline: ExpirationTimelineRow[];
  filters: {
    clients: Array<{ id: string; name: string }>;
    stores: Array<{ id: string; name: string; clientId: string | null }>;
    qualifications: Array<{ id: string; name: string }>;
  };
}

export const getExpirationRisk = (days = 90) => apiFetch<ExpirationRisk>(`/expirations/risk?days=${days}`);
