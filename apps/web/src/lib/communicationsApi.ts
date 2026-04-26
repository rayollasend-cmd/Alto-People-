import type {
  Notification,
  NotificationBroadcastInput,
  NotificationListResponse,
  NotificationSendInput,
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

export function listAdmin(): Promise<NotificationListResponse> {
  return apiFetch<NotificationListResponse>('/communications/admin');
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
