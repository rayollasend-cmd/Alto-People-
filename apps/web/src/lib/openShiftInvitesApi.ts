import { apiFetch } from './api';

/**
 * Open-shift invitations (role walk, ops 11; apps/api lib/openShiftInvites):
 * how many on a shift's bench were asked and how many passed, the
 * manager's Rebroadcast, and the associate's "Not for me".
 */

export interface InviteCounts {
  shiftId: string;
  /** People asked at least once. */
  sent: number;
  /** People who said "Not for me". */
  declined: number;
  lastSentAt: string | null;
}

export interface RebroadcastResult {
  shiftId: string;
  sent: number;
  /** Of `sent`, inside their quiet hours: the bell now, email and push in the morning. */
  held: number;
  skipped: { declined: number; timeOff: number; unavailable: number; unqualified: number; recent: number };
  benchSize: number;
  counts: InviteCounts;
}

export const listInviteCounts = (days: number) =>
  apiFetch<{ counts: InviteCounts[] }>(`/open-shifts/invite-counts?days=${days}`);

export const rebroadcastShift = (shiftId: string) =>
  apiFetch<RebroadcastResult>(`/open-shifts/${shiftId}/rebroadcast`, { method: 'POST', body: {} });

export const declineOpenShift = (shiftId: string) =>
  apiFetch<{ ok: true }>(`/open-shifts/${shiftId}/decline`, { method: 'POST', body: {} });

export const undoDeclineOpenShift = (shiftId: string) =>
  apiFetch<{ ok: true }>(`/open-shifts/${shiftId}/decline`, { method: 'DELETE' });
