import { apiFetch } from './api';

export type AgreementKind =
  | 'NDA'
  | 'NON_COMPETE'
  | 'IP_ASSIGNMENT'
  | 'ARBITRATION'
  | 'EMPLOYMENT_OFFER'
  | 'SEPARATION_AGREEMENT'
  | 'EQUITY_GRANT'
  | 'OTHER';

export type AgreementStatus =
  | 'PENDING_SIGNATURE'
  | 'SIGNED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface AgreementRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  kind: AgreementKind;
  customLabel: string | null;
  status: AgreementStatus;
  documentUrl: string | null;
  effectiveDate: string | null;
  expiresOn: string | null;
  signedAt: string | null;
  signature: string | null;
  supersedesId: string | null;
  notes: string | null;
  issuedByEmail: string | null;
}

export interface MyAgreement {
  id: string;
  kind: AgreementKind;
  customLabel: string | null;
  status: AgreementStatus;
  documentUrl: string | null;
  effectiveDate: string | null;
  expiresOn: string | null;
  signedAt: string | null;
  notes: string | null;
}

export const KIND_LABELS: Record<AgreementKind, string> = {
  NDA: 'NDA',
  NON_COMPETE: 'Non-compete',
  IP_ASSIGNMENT: 'IP assignment',
  ARBITRATION: 'Arbitration',
  EMPLOYMENT_OFFER: 'Employment offer',
  SEPARATION_AGREEMENT: 'Separation agreement',
  EQUITY_GRANT: 'Equity grant',
  OTHER: 'Other',
};

export const STATUS_LABELS: Record<AgreementStatus, string> = {
  PENDING_SIGNATURE: 'Pending signature',
  SIGNED: 'Signed',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
};

export const listAgreements = (params: {
  associateId?: string;
  kind?: AgreementKind;
  status?: AgreementStatus;
}) => {
  const q = new URLSearchParams();
  if (params.associateId) q.set('associateId', params.associateId);
  if (params.kind) q.set('kind', params.kind);
  if (params.status) q.set('status', params.status);
  const qs = q.toString();
  return apiFetch<{ agreements: AgreementRow[] }>(
    `/agreements${qs ? `?${qs}` : ''}`,
  );
};

export const listMyAgreements = () =>
  apiFetch<{ agreements: MyAgreement[] }>('/my/agreements');

export const issueAgreement = (input: {
  associateId: string;
  kind: AgreementKind;
  customLabel?: string | null;
  documentUrl?: string | null;
  effectiveDate?: string | null;
  expiresOn?: string | null;
  supersedesId?: string | null;
  notes?: string | null;
}) =>
  apiFetch<{ id: string }>('/agreements', { method: 'POST', body: input });

export const signAgreement = (id: string, signature: string) =>
  apiFetch<{ ok: true }>(`/agreements/${id}/sign`, {
    method: 'POST',
    body: { signature },
  });

export const expireAgreement = (id: string) =>
  apiFetch<{ ok: true }>(`/agreements/${id}/expire`, {
    method: 'POST',
    body: {},
  });

export const deleteAgreement = (id: string) =>
  apiFetch<void>(`/agreements/${id}`, { method: 'DELETE' });
