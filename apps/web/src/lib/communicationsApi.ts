import type {
  EmailSuppressionListResponse,
  Notification,
  NotificationBroadcastInput,
  NotificationChannel,
  NotificationListResponse,
  NotificationSendInput,
  NotificationStatus,
} from '@alto-people/shared';
import { apiFetch } from './api';

export function listMyInbox(): Promise<NotificationListResponse> {
  return apiFetch<NotificationListResponse>('/communications/me/inbox');
}

export function markRead(id: string): Promise<Notification> {
  return apiFetch<Notification>(`/communications/me/inbox/${id}/read`, {
    method: 'POST',
  });
}

/** Panel-open stamp: marks everything currently unseen as seen so the
 *  bell badge clears — read state (row highlight) is untouched. */
export function markAllSeen(): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>('/communications/me/inbox/seen', {
    method: 'POST',
  });
}

/** One request instead of N single-row /read calls. */
export function markAllRead(): Promise<{ updated: number }> {
  return apiFetch<{ updated: number }>('/communications/me/inbox/read-all', {
    method: 'POST',
  });
}

export function listAdmin(filters?: {
  channel?: NotificationChannel;
  status?: NotificationStatus;
}): Promise<NotificationListResponse> {
  const params = new URLSearchParams();
  if (filters?.channel) params.set('channel', filters.channel);
  if (filters?.status) params.set('status', filters.status);
  const qs = params.toString();
  return apiFetch<NotificationListResponse>(
    `/communications/admin${qs ? `?${qs}` : ''}`,
  );
}

export function sendNotification(body: NotificationSendInput): Promise<Notification> {
  return apiFetch<Notification>('/communications/admin/send', {
    method: 'POST',
    body,
  });
}

export function broadcast(body: NotificationBroadcastInput): Promise<{ count: number }> {
  return apiFetch<{ count: number }>('/communications/admin/broadcast', {
    method: 'POST',
    body,
  });
}

export function listSuppressions(): Promise<EmailSuppressionListResponse> {
  return apiFetch<EmailSuppressionListResponse>('/communications/admin/suppressions');
}

export function deleteSuppression(email: string): Promise<void> {
  return apiFetch<void>(
    `/communications/admin/suppressions/${encodeURIComponent(email)}`,
    { method: 'DELETE' },
  );
}
