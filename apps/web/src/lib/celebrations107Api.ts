import { apiFetch } from './api';

export interface CelebrationItem {
  associateId: string;
  associateName: string;
  email: string;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  date: string;
  years: number | null;
  /** Where they work now. */
  locationId?: string | null;
  siteName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  /** The headshot URL; null when none is on file (no request, initials). */
  photoUrl?: string | null;
}

export const listUpcomingCelebrations = (days = 60) =>
  apiFetch<{ items: CelebrationItem[] }>(
    `/celebrations/upcoming?days=${days}`,
  );

export const sendHighFive = (input: {
  associateId: string;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  message: string;
}) =>
  apiFetch<{ ok: true }>('/celebrations/high-five', {
    method: 'POST',
    body: input,
  });
