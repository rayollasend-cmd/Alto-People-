import type { OrgBranding, UpdateOrgBrandingInput } from '@alto-people/shared';
import { apiFetch } from './api';

export function getOrgBranding(): Promise<OrgBranding> {
  return apiFetch<OrgBranding>('/admin/org/settings');
}

export function patchOrgBranding(body: UpdateOrgBrandingInput): Promise<OrgBranding> {
  return apiFetch<OrgBranding>('/admin/org/settings', {
    method: 'PATCH',
    body,
  });
}

export async function uploadOrgLogo(file: File): Promise<OrgBranding> {
  const fd = new FormData();
  fd.append('file', file);
  // apiFetch insists on JSON; use fetch directly for multipart so the
  // browser sets the multipart boundary automatically.
  const res = await fetch('/api/admin/org/settings/logo', {
    method: 'POST',
    body: fd,
    credentials: 'include',
  });
  if (!res.ok) {
    let msg = `Upload failed (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j?.error?.message) msg = j.error.message;
    } catch {
      /* swallow */
    }
    throw new Error(msg);
  }
  return (await res.json()) as OrgBranding;
}

export function deleteOrgLogo(): Promise<void> {
  return apiFetch<void>('/admin/org/settings/logo', { method: 'DELETE' });
}
