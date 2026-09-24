import type { ReleaseNote, ReleaseNoteInput, ReleaseNotesResponse } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Release notes come from the API, not the bundle: an admin writes one
 * and it is on every phone at the next open, no deploy involved. The
 * server already filters bullets to the reader's audience.
 */

export function listReleaseNotes(limit = 20): Promise<ReleaseNotesResponse> {
  return apiFetch<ReleaseNotesResponse>(`/release-notes?limit=${limit}`);
}

export function getLatestReleaseNote(): Promise<{ note: ReleaseNote | null }> {
  return apiFetch<{ note: ReleaseNote | null }>('/release-notes/latest');
}

export function createReleaseNote(input: ReleaseNoteInput): Promise<{ note: ReleaseNote }> {
  return apiFetch<{ note: ReleaseNote }>('/release-notes', { method: 'POST', body: JSON.stringify(input) });
}

export function updateReleaseNote(id: string, input: ReleaseNoteInput): Promise<{ note: ReleaseNote }> {
  return apiFetch<{ note: ReleaseNote }>(`/release-notes/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteReleaseNote(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/release-notes/${id}`, { method: 'DELETE' });
}
