import { apiFetch } from './api';

export interface CelebrationItem {
  associateId: string;
  associateName: string;
  email: string;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  date: string;
  years: number | null;
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
