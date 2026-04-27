import { apiFetch } from './api';

// ----- API keys ---------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  clientId: string | null;
  clientName: string | null;
  name: string;
  last4: string;
  capabilities: string[];
  createdByEmail: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const listApiKeys = (clientId?: string) =>
  apiFetch<{ keys: ApiKeyRecord[] }>(
    clientId ? `/api-keys?clientId=${clientId}` : '/api-keys',
  );

export const createApiKey = (input: {
  clientId?: string | null;
  name: string;
  capabilities?: string[];
  expiresAt?: string | null;
}) =>
  apiFetch<{ id: string; plaintext: string; last4: string }>('/api-keys', {
    method: 'POST',
    body: input,
  });

export const revokeApiKey = (id: string) =>
  apiFetch<{ ok: true }>(`/api-keys/${id}/revoke`, { method: 'POST', body: {} });

export const deleteApiKey = (id: string) =>
  apiFetch<void>(`/api-keys/${id}`, { method: 'DELETE' });

// ----- Webhooks ---------------------------------------------------------

export interface WebhookRecord {
  id: string;
  clientId: string | null;
  clientName: string | null;
  name: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  deliveryCount: number;
  createdAt: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  eventType: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attemptCount: number;
  responseStatus: number | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export const listWebhooks = (clientId?: string) =>
  apiFetch<{ webhooks: WebhookRecord[] }>(
    clientId ? `/webhooks?clientId=${clientId}` : '/webhooks',
  );

export const createWebhook = (input: {
  clientId?: string | null;
  name: string;
  url: string;
  eventTypes: string[];
}) =>
  apiFetch<{ id: string; secret: string }>('/webhooks', {
    method: 'POST',
    body: input,
  });

export const toggleWebhook = (id: string) =>
  apiFetch<{ ok: true; isActive: boolean }>(`/webhooks/${id}/toggle`, {
    method: 'POST',
    body: {},
  });

export const deleteWebhook = (id: string) =>
  apiFetch<void>(`/webhooks/${id}`, { method: 'DELETE' });

export const listWebhookDeliveries = (id: string) =>
  apiFetch<{ deliveries: WebhookDeliveryRecord[] }>(`/webhooks/${id}/deliveries`);

export const testWebhook = (id: string, eventType?: string) =>
  apiFetch<{ ok: boolean; responseStatus: number | null; responseBody: string | null }>(
    `/webhooks/${id}/test`,
    { method: 'POST', body: eventType ? { eventType } : {} },
  );
