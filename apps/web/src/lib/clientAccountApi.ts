import type {
  ClientContact,
  ClientContactInput,
  ClientContactUpdateInput,
  ClientOverview,
  ClientOwnerOption,
} from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * The client's account page (CL-A): the overview, the people at the
 * client, and who may own the account. Kept apart from clientsApi so the
 * list and the record evolve without stepping on each other.
 */

/** One query key per client: the header and the Overview tab share it. */
export const clientOverviewKey = (clientId: string) => ['clients', clientId, 'overview'] as const;

export function getClientOverview(clientId: string): Promise<ClientOverview> {
  return apiFetch<ClientOverview>(`/clients/${clientId}/overview`);
}

export function listClientContacts(clientId: string): Promise<{ contacts: ClientContact[] }> {
  return apiFetch(`/clients/${clientId}/contacts`);
}

export function createClientContact(clientId: string, body: ClientContactInput): Promise<{ contact: ClientContact }> {
  return apiFetch(`/clients/${clientId}/contacts`, { method: 'POST', body });
}

export function updateClientContact(clientId: string, contactId: string, body: ClientContactUpdateInput): Promise<{ contact: ClientContact }> {
  return apiFetch(`/clients/${clientId}/contacts/${contactId}`, { method: 'PATCH', body });
}

export function deleteClientContact(clientId: string, contactId: string): Promise<void> {
  return apiFetch<void>(`/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' });
}

export function listOwnerOptions(clientId: string): Promise<{ options: ClientOwnerOption[] }> {
  return apiFetch(`/clients/${clientId}/owner-options`);
}
