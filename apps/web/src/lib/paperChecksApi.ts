import { apiFetch } from './api';

/** Paper checks (apps/api/src/routes/paperChecks.ts). */

export interface PayByCheckOverride {
  itemId: string;
  associateId: string;
  name: string;
  reason: string;
  source: 'PAYROLL' | 'ASSOCIATE';
  setAt: string;
  setByUserId: string | null;
}

export type CheckStatus = 'ISSUED' | 'PRINTED' | 'VOID' | 'STOPPED';

export interface RunCheck {
  id: string;
  checkNumber: number;
  itemId: string;
  associateId: string;
  payeeName: string;
  amount: number;
  issuedAt: string;
  status: CheckStatus;
  printedAt: string | null;
  printCount: number;
  voidedAt: string | null;
  voidReason: string | null;
  stopPaymentAt: string | null;
  stopPaymentRef: string | null;
  replacesCheckNumber: number | null;
  positivePayAt: string | null;
}

export interface CheckSettings {
  bankAccountId: string | null;
  bankAccountLabel: string | null;
  bankName: string | null;
  bankAddress: string | null;
  fractionalRouting: string | null;
  offsetXPt: number;
  offsetYPt: number;
  hasSignature: boolean;
  signatureSignerName: string | null;
  twoSignatureOver: number | null;
  voidAfterDays: number;
  micrFontInstalled: boolean;
  ready: boolean;
  gaps: string[];
}

export interface RunChecks {
  run: { id: string; status: 'DRAFT' | 'FINALIZED' | 'DISBURSED' | 'CANCELLED'; kind: string; periodStart: string; periodEnd: string };
  checks: RunCheck[];
  overrides: PayByCheckOverride[];
  requests: Array<{ id: string; title: string; reason: string | null; itemId: string; createdAt: string }>;
  settings: CheckSettings;
}

export interface BankAccountOption {
  id: string;
  label: string;
  bankName: string | null;
  accountLast4: string;
  status: string;
}

export interface MyPayByCheck {
  openPaycheck: { itemId: string; periodStart: string; periodEnd: string } | null;
  override: { reason: string; source: 'PAYROLL' | 'ASSOCIATE' } | null;
  request: { id: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; reason: string | null; decidedReason: string | null; createdAt: string } | null;
}

export const getRunChecks = (runId: string) => apiFetch<RunChecks>(`/payroll/runs/${runId}/checks`);
export const setPayByCheck = (itemId: string, reason: string) => apiFetch<{ override: PayByCheckOverride }>(`/payroll/items/${itemId}/pay-by-check`, { method: 'PUT', body: { reason } });
export const clearPayByCheck = (itemId: string, reason?: string | null) => apiFetch<void>(`/payroll/items/${itemId}/pay-by-check`, { method: 'DELETE', body: { reason: reason ?? null } });
export const voidCheck = (checkId: string, reason: string) => apiFetch<{ id: string }>(`/payroll/checks/${checkId}/void`, { method: 'POST', body: { reason } });
export const reissueCheck = (checkId: string, reason: string) => apiFetch<{ id: string; checkNumber: number }>(`/payroll/checks/${checkId}/reissue`, { method: 'POST', body: { reason } });
export const stopCheckPayment = (checkId: string, reason: string, bankRef?: string | null) => apiFetch<{ id: string }>(`/payroll/checks/${checkId}/stop-payment`, { method: 'POST', body: { reason, bankRef: bankRef ?? null } });
export const getCheckSettings = () => apiFetch<{ settings: CheckSettings; accounts: BankAccountOption[] }>('/payroll/check-settings');
export const updateCheckSettings = (body: Partial<{ bankAccountId: string | null; bankName: string | null; bankAddress: string | null; fractionalRouting: string | null; offsetXPt: number; offsetYPt: number; signatureSignerName: string | null; twoSignatureOver: number | null; voidAfterDays: number }>) =>
  apiFetch<{ settings: CheckSettings }>('/payroll/check-settings', { method: 'PUT', body });
export const uploadCheckSignature = (imageBase64: string, contentType: 'image/png' | 'image/jpeg', signerName?: string | null) =>
  apiFetch<{ settings: CheckSettings }>('/payroll/check-settings/signature', { method: 'PUT', body: { imageBase64, contentType, signerName: signerName ?? null } });
export const removeCheckSignature = () => apiFetch<{ settings: CheckSettings }>('/payroll/check-settings/signature', { method: 'DELETE' });
export const getMyPayByCheck = () => apiFetch<MyPayByCheck>('/me/pay-by-check');
export const requestPayByCheck = (reason: string) => apiFetch<MyPayByCheck>('/me/pay-by-check', { method: 'POST', body: { reason } });
export const decidePayByCheckRequest = (id: string, decision: 'APPROVE' | 'REJECT', reason?: string | null) =>
  apiFetch<unknown>(`/approvals/requests/${id}/decide`, { method: 'POST', body: { decision, reason: reason ?? null } });

/** Download a file from the API with the server's file name. */
export async function downloadFrom(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'GET', credentials: 'include' });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = url;
  a.download = m?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
