import type {
  DocumentKind,
  DocumentListResponse,
  DocumentRecord,
  DocumentRejectInput,
  DocumentStatus,
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

export function downloadDocumentUrl(id: string): string {
  return `/api/documents/${id}/download`;
}

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

export function verifyDocument(id: string): Promise<DocumentRecord> {
  return apiFetch<DocumentRecord>(`/documents/admin/${id}/verify`, { method: 'POST' });
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
