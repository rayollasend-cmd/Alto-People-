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
