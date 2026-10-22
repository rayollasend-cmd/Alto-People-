import type { TrustDocumentKind, TrustDocumentSummary, TrustDownloadRequestInput, TrustDownloadRequestSummary, TrustSummary, TrustSummaryPublic } from '@alto-people/shared';
import { apiFetch } from './api';

/** The Trust Center (UX upgrade step 4; gated downloads and SOC 2 progress, audit 2026-10-21). */
export const getTrustPublic = () => apiFetch<TrustSummaryPublic>('/trust/public');
export const getTrust = () => apiFetch<TrustSummary>('/trust');

/** The public form: ask for a report. 202 with the request id (an open ask by the same person is returned again). */
export const requestTrustDocument = (input: TrustDownloadRequestInput) => apiFetch<{ id: string; status: 'PENDING' }>('/trust/public/requests', { method: 'POST', body: input });

export const listTrustRequests = () => apiFetch<{ requests: TrustDownloadRequestSummary[] }>('/trust/requests');
export const decideTrustRequest = (id: string, decision: 'APPROVED' | 'DECLINED') => apiFetch<TrustDownloadRequestSummary>(`/trust/requests/${id}`, { method: 'POST', body: { decision } });
export const listTrustDocuments = () => apiFetch<{ documents: TrustDocumentSummary[] }>('/trust/documents');
export async function uploadTrustDocument(input: { kind: TrustDocumentKind; title: string; file: File }): Promise<TrustDocumentSummary> {
  const fd = new FormData();
  fd.append('kind', input.kind);
  fd.append('title', input.title);
  fd.append('file', input.file);
  // apiFetch JSON-encodes; multipart goes to fetch directly so the browser sets the boundary.
  const res = await fetch('/api/trust/documents', { method: 'POST', credentials: 'include', body: fd });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return (await res.json()) as TrustDocumentSummary;
}
export const setSoc2ReportDate = (reportIssuedOn: string | null) => apiFetch<{ reportIssuedOn: string | null }>('/trust/soc2', { method: 'PUT', body: { reportIssuedOn } });
