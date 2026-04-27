import { apiFetch } from './api';

export type EquityGrantType =
  | 'RSU'
  | 'NSO'
  | 'ISO'
  | 'PHANTOM'
  | 'PERFORMANCE_RSU';

export type EquityGrantStatus =
  | 'PROPOSED'
  | 'GRANTED'
  | 'CANCELLED'
  | 'EXERCISED'
  | 'EXPIRED';

export interface EquityGrant {
  id: string;
  associateId: string | null;
  associateName: string | null;
  associateEmail: string | null;
  grantType: EquityGrantType;
  status: EquityGrantStatus;
  totalShares: number;
  strikePrice: string | null;
  currency: string;
  grantDate: string;
  vestingStartDate: string;
  cliffMonths: number;
  vestingMonths: number;
  expirationDate: string | null;
  notes: string | null;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface EquityVestingEvent {
  id: string;
  eventIndex: number;
  vestDate: string;
  shares: number;
  isCliff: boolean;
  vested: boolean;
}

export interface EquityGrantDetail extends EquityGrant {
  events: EquityVestingEvent[];
  vestedShares: number;
  unvestedShares: number;
}

export interface MyEquityGrant {
  id: string;
  grantType: EquityGrantType;
  status: EquityGrantStatus;
  totalShares: number;
  vestedShares: number;
  unvestedShares: number;
  strikePrice: string | null;
  currency: string;
  grantDate: string;
  vestingStartDate: string;
  cliffMonths: number;
  vestingMonths: number;
  expirationDate: string | null;
  upcomingTranches: { vestDate: string; shares: number }[];
}

export interface EquitySummary {
  proposedCount: number;
  activeRecipients: number;
  sharesGranted: number;
  sharesVested: number;
}

export const createEquityGrant = (input: {
  associateId: string;
  grantType: EquityGrantType;
  totalShares: number;
  strikePrice?: number | null;
  currency?: string;
  grantDate: string;
  vestingStartDate: string;
  cliffMonths?: number;
  vestingMonths?: number;
  expirationDate?: string | null;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/equity-grants', {
    method: 'POST',
    body: input,
  });

export const listEquityGrants = (status?: EquityGrantStatus) =>
  apiFetch<{ grants: EquityGrant[] }>(
    `/equity-grants${status ? `?status=${status}` : ''}`,
  );

export const getEquityGrant = (id: string) =>
  apiFetch<{ grant: EquityGrantDetail }>(`/equity-grants/${id}`);

export const grantEquityGrant = (id: string) =>
  apiFetch<{ ok: true }>(`/equity-grants/${id}/grant`, {
    method: 'POST',
    body: {},
  });

export const cancelEquityGrant = (id: string) =>
  apiFetch<{ ok: true }>(`/equity-grants/${id}/cancel`, {
    method: 'POST',
    body: {},
  });

export const exerciseEquityGrant = (id: string) =>
  apiFetch<{ ok: true }>(`/equity-grants/${id}/exercise`, {
    method: 'POST',
    body: {},
  });

export const listMyEquity = () =>
  apiFetch<{ grants: MyEquityGrant[] }>('/my/equity-grants');

export const getEquitySummary = () =>
  apiFetch<EquitySummary>('/equity-grants-summary');
