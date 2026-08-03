import type {
  DocumentKind,
  DocumentListResponse,
  DocumentRecord,
  DocumentRejectInput,
  DocumentStatus,
  DocumentVaultResponse,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listMyDocuments(): Promise<DocumentListResponse> {
  return apiFetch<DocumentListResponse>('/documents/me');
}

export function listAdminDocuments(filters: {
  status?: DocumentStatus;
  kind?: DocumentKind;
  associateId?: string;
} = {}): Promise<DocumentListResponse> {
  const p = new URLSearchParams();
  if (filters.status) p.set('status', filters.status);
  if (filters.kind) p.set('kind', filters.kind);
  if (filters.associateId) p.set('associateId', filters.associateId);
  const qs = p.toString();
  return apiFetch<DocumentListResponse>(`/documents/admin${qs ? `?${qs}` : ''}`);
}

/** Vault: every document + a compliance summary from each domain's ledger. */
export function getDocumentVault(associateId: string): Promise<DocumentVaultResponse> {
  return apiFetch<DocumentVaultResponse>(`/documents/admin/vault/${associateId}`);
}

export async function uploadMyDocument(
  file: File,
  kind: DocumentKind
): Promise<DocumentRecord> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  // apiFetch JSON-encodes; for multipart we hit fetch directly.
  const res = await fetch('/api/documents/me/upload', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return res.json();
}

// HR-side upload for result PDFs (background-check, drug-test, E-Verify).
// The created DocumentRecord lands as VERIFIED on the target associate's
// profile so it shows up immediately in their Documents tab.
export async function uploadAdminDocument(
  file: File,
  kind: DocumentKind,
  associateId: string
): Promise<DocumentRecord> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('kind', kind);
  fd.append('associateId', associateId);
  const res = await fetch('/api/documents/admin/upload', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
  }
  return res.json();
}

export function downloadDocumentUrl(id: string): string {
  return `/api/documents/${id}/download`;
}

// Streams a zip of every available document for one associate. Plain URL —
// consumed via an <a href> just like the per-document download route.
export function downloadAllDocumentsUrl(
  associateId: string,
  /**
   * Restrict the archive to these document kinds. Omit for the associate's
   * whole file. A reviewer working an I-9 or E-Verify case wants the identity
   * documents, not the offer letter and every signed policy — exporting more
   * PII than the task needs is worth designing out, and the archive is
   * audited either way.
   */
  kinds?: readonly string[],
): string {
  const params = new URLSearchParams({ associateId });
  if (kinds && kinds.length > 0) params.set('kinds', kinds.join(','));
  return `/api/documents/admin/all.zip?${params.toString()}`;
}

/** The kinds that make up an identity check — I-9 Section 2 and E-Verify. */
export const IDENTITY_DOC_KINDS = [
  'I9_SUPPORTING',
  'ID',
  'SSN_CARD',
  'J1_VISA',
  'J1_DS2019',
] as const;

// Same endpoint, but the API responds with `Content-Disposition: inline` so
// browsers render PDFs / images in an iframe or <img> instead of downloading.
// Only safe MIME types are allowed inline by the API.
export function previewDocumentUrl(id: string): string {
  return `/api/documents/${id}/download?inline=1`;
}

const PREVIEWABLE_PREFIXES = ['application/pdf', 'image/'];
export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE_PREFIXES.some((p) => mimeType.startsWith(p));
}

export function deleteMyDocument(id: string): Promise<void> {
  return apiFetch<void>(`/documents/me/${id}`, { method: 'DELETE' });
}

// `expiresAt` ('YYYY-MM-DD', optional) is captured at verification time and
// drives the daily expiry sweep that flips lapsed docs to EXPIRED.
export function verifyDocument(
  id: string,
  opts: { expiresAt?: string } = {}
): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(`/documents/admin/${id}/verify`, {
    method: 'POST',
    ...(opts.expiresAt ? { body: { expiresAt: opts.expiresAt } } : {}),
  });
}

export interface BulkVerifyResult {
  verified: number;
  skipped: { id: string; reason: string }[];
}

export function bulkVerifyDocuments(ids: string[]): Promise<BulkVerifyResult> {
  return apiFetch<BulkVerifyResult>('/documents/admin/bulk-verify', {
    method: 'POST',
    body: { ids },
  });
}

export function rejectDocument(
  id: string,
  body: DocumentRejectInput
): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(`/documents/admin/${id}/reject`, {
    method: 'POST',
    body,
  });
}
