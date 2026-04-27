import { apiFetch } from './api';

// ----- Garnishments ------------------------------------------------------

export type GarnishmentKind =
  | 'CHILD_SUPPORT'
  | 'TAX_LEVY'
  | 'STUDENT_LOAN'
  | 'BANKRUPTCY'
  | 'CREDITOR'
  | 'OTHER';

export type GarnishmentStatus =
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'COMPLETED'
  | 'TERMINATED';

export interface Garnishment {
  id: string;
  associateId: string;
  associateName: string;
  kind: GarnishmentKind;
  caseNumber: string | null;
  agencyName: string | null;
  amountPerRun: string | null;
  percentOfDisp: string | null;
  totalCap: string | null;
  amountWithheld: string;
  remitTo: string | null;
  remitAddress: string | null;
  startDate: string;
  endDate: string | null;
  status: GarnishmentStatus;
  priority: number;
  notes: string | null;
  deductionCount: number;
  createdAt: string;
}

export const listGarnishments = (params?: {
  associateId?: string;
  status?: GarnishmentStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ garnishments: Garnishment[] }>(`/garnishments${suffix}`);
};

export const createGarnishment = (input: {
  associateId: string;
  kind: GarnishmentKind;
  caseNumber?: string | null;
  agencyName?: string | null;
  amountPerRun?: number | null;
  percentOfDisp?: number | null;
  totalCap?: number | null;
  remitTo?: string | null;
  remitAddress?: string | null;
  startDate: string;
  endDate?: string | null;
  priority?: number;
  notes?: string | null;
}) => apiFetch<{ id: string }>('/garnishments', { method: 'POST', body: input });

export const setGarnishmentStatus = (id: string, status: GarnishmentStatus) =>
  apiFetch<{ ok: true }>(`/garnishments/${id}/status`, {
    method: 'POST',
    body: { status },
  });

// ----- Tax forms ---------------------------------------------------------

export type TaxFormKind = 'F941' | 'F940' | 'W2' | 'F1099_NEC';

export type TaxFormStatus = 'DRAFT' | 'FILED' | 'AMENDED' | 'VOIDED';

export interface TaxForm {
  id: string;
  kind: TaxFormKind;
  taxYear: number;
  quarter: number | null;
  associateId: string | null;
  associateName: string | null;
  amounts: Record<string, unknown>;
  status: TaxFormStatus;
  filedAt: string | null;
  ein: string | null;
  createdAt: string;
}

export const listTaxForms = (params?: {
  kind?: TaxFormKind;
  taxYear?: number;
  status?: TaxFormStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.kind) q.set('kind', params.kind);
  if (params?.taxYear) q.set('taxYear', String(params.taxYear));
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ forms: TaxForm[] }>(`/tax-forms${suffix}`);
};

export const createTaxForm = (input: {
  kind: TaxFormKind;
  taxYear: number;
  quarter?: number | null;
  associateId?: string | null;
  amounts: Record<string, unknown>;
  ein?: string | null;
}) => apiFetch<{ id: string }>('/tax-forms', { method: 'POST', body: input });

export const fileTaxForm = (id: string) =>
  apiFetch<{ ok: true }>(`/tax-forms/${id}/file`, { method: 'POST', body: {} });

export const voidTaxForm = (id: string) =>
  apiFetch<{ ok: true }>(`/tax-forms/${id}/void`, { method: 'POST', body: {} });

export const build941 = (taxYear: number, quarter: number) =>
  apiFetch<{
    suggestedAmounts: Record<string, string | number>;
    periodStart: string;
    periodEnd: string;
  }>(`/tax-forms/build/941?taxYear=${taxYear}&quarter=${quarter}`);
