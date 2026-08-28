import { apiFetch } from './api';
import type {
  ExternalPayment,
  ExternalPaymentInput,
  ExternalPaymentListResponse,
} from '@alto-people/shared';

/**
 * External payments — audit documentation for externally-run payroll.
 * Pay periods per associate, each with evidence uploads (paystub, cleared
 * check, processor report) that land in the document vault as PAYSTUB
 * records. Evidence downloads reuse the regular documents download route.
 */

export function listExternalPayments(
  associateId: string,
): Promise<ExternalPaymentListResponse> {
  return apiFetch(`/external-payments/associates/${associateId}`);
}

export function createExternalPayment(
  associateId: string,
  input: ExternalPaymentInput,
): Promise<ExternalPayment> {
  return apiFetch(`/external-payments/associates/${associateId}`, {
    method: 'POST',
    body: input,
  });
}

export interface PeriodPrefillRow {
  associateId: string;
  fullName: string;
  clientName: string;
  regularHours: number;
  overtimeHours: number;
  suggestedGross: number | null;
  alreadyRecorded: boolean;
  recordedGross: number | null;
}

/** One row per associate with approved time in the period — the batch
 *  recorder's starting grid. Hours/gross use the bureau sheet's math. */
export function getPeriodPrefill(
  from: string,
  to: string,
): Promise<{ rows: PeriodPrefillRow[]; truncated: boolean }> {
  return apiFetch(
    `/external-payments/period-prefill?from=${from}&to=${to}`,
  );
}

/** Record (or update) the whole pay period in one call. */
export function recordPayPeriod(body: {
  periodStart: string;
  periodEnd: string;
  payDate?: string | null;
  method?: string;
  reference?: string | null;
  note?: string | null;
  rows: { associateId: string; grossAmount?: number | null; netAmount?: number | null }[];
}): Promise<{ created: number; updated: number; skipped: number }> {
  return apiFetch('/external-payments/record-period', { method: 'POST', body });
}

export function updateExternalPayment(
  paymentId: string,
  input: ExternalPaymentInput,
): Promise<ExternalPayment> {
  return apiFetch(`/external-payments/${paymentId}`, {
    method: 'PATCH',
    body: input,
  });
}

export function deleteExternalPayment(paymentId: string): Promise<void> {
  return apiFetch(`/external-payments/${paymentId}`, { method: 'DELETE' });
}

export async function uploadPaymentEvidence(
  paymentId: string,
  file: File,
): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  // apiFetch JSON-encodes; for multipart we hit fetch directly.
  const res = await fetch(`/api/external-payments/${paymentId}/evidence`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
}
