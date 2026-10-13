import type { WhatsAppConsentInput, WhatsAppMeResponse, WhatsAppMessageRow, WhatsAppOverview } from '@alto-people/shared';
import { apiFetch } from './api';

/** The associate's side: consent and the phone on file. */
export function getMyWhatsApp(): Promise<WhatsAppMeResponse> {
  return apiFetch<WhatsAppMeResponse>('/whatsapp/me');
}

export function setWhatsAppConsent(body: WhatsAppConsentInput): Promise<WhatsAppMeResponse> {
  return apiFetch<WhatsAppMeResponse>('/whatsapp/me/consent', { method: 'POST', body });
}

/** The admin side (view:communications). */
export function getWhatsAppOverview(): Promise<WhatsAppOverview> {
  return apiFetch<WhatsAppOverview>('/whatsapp/admin/overview');
}

export function listWhatsAppMessages(opts: { associateId?: string; limit?: number } = {}): Promise<{ messages: WhatsAppMessageRow[] }> {
  const p = new URLSearchParams();
  if (opts.associateId) p.set('associateId', opts.associateId);
  if (opts.limit) p.set('limit', String(opts.limit));
  const qs = p.toString();
  return apiFetch<{ messages: WhatsAppMessageRow[] }>(`/whatsapp/admin/messages${qs ? `?${qs}` : ''}`);
}
