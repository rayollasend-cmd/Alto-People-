import type {
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
