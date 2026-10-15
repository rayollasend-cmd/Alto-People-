import { apiFetch } from './api';

// Brief 2-3 step 2 — a tenant's own sign-in (manage:org). Secrets are write-only.

export interface IdentityConnectionRow {
  id: string;
  kind: 'OIDC' | 'SAML';
  displayName: string;
  buttonLabel: string | null;
  issuerUrl: string;
  clientId: string;
  jitPolicy: 'NONE' | 'INVITED_ONLY';
  ssoRequiredForStaff: boolean;
  enabled: boolean;
  fromEnvironment: boolean;
  linkedPeople: number;
  createdAt: string;
}

export interface TenantDomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  txtRecord: string;
  lastCheckedAt: string | null;
}

export interface ScimTokenRow {
  id: string;
  name: string;
  last4: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const getIdentity = () => apiFetch<{ connections: IdentityConnectionRow[]; domains: TenantDomainRow[]; scimTokens: ScimTokenRow[] }>('/identity');

export interface ConnectionInput {
  displayName: string;
  buttonLabel?: string | null;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  jitPolicy: 'NONE' | 'INVITED_ONLY';
  ssoRequiredForStaff: boolean;
  enabled: boolean;
}

export const createConnection = (input: ConnectionInput) => apiFetch<{ id: string }>('/identity/connections', { method: 'POST', body: input });

export const updateConnection = (id: string, input: Partial<ConnectionInput>) => apiFetch<{ ok: true }>(`/identity/connections/${id}`, { method: 'PATCH', body: input });

export const addDomain = (domain: string) => apiFetch<{ id: string; domain: string; txtRecord: string }>('/identity/domains', { method: 'POST', body: { domain } });

export const verifyDomain = (id: string) => apiFetch<{ id: string; verified: boolean }>(`/identity/domains/${id}/verify`, { method: 'POST', body: {} });

export const releaseDomain = (id: string) => apiFetch<void>(`/identity/domains/${id}`, { method: 'DELETE' });

export const issueScimToken = (name: string) => apiFetch<{ id: string; token: string; last4: string }>('/identity/scim-tokens', { method: 'POST', body: { name } });

export const revokeScimToken = (id: string) => apiFetch<{ ok: true }>(`/identity/scim-tokens/${id}/revoke`, { method: 'POST', body: {} });
