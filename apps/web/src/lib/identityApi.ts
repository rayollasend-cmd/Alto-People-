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
  /** SAML only (Brief 2-3 step 5): what the IdP's admin enters. */
  allowIdpInitiated?: boolean;
  spEntityId?: string;
  acsUrl?: string;
  metadataUrl?: string;
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

/** `loginPath`: the organization's own sign-in address ("/login/acme"); absent from an older API. */
export const getIdentity = () => apiFetch<{ connections: IdentityConnectionRow[]; domains: TenantDomainRow[]; scimTokens: ScimTokenRow[]; loginPath?: string | null }>('/identity');

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

/** Brief 2-3 step 5 — a SAML connection: the IdP's SSO URL, entity id and signing certificate. */
export interface SamlConnectionInput {
  displayName: string;
  buttonLabel?: string | null;
  ssoUrl: string;
  idpEntityId: string;
  idpCert: string;
  allowIdpInitiated: boolean;
  jitPolicy: 'NONE' | 'INVITED_ONLY';
  ssoRequiredForStaff: boolean;
  enabled: boolean;
}

export const createSamlConnection = (input: SamlConnectionInput) => apiFetch<{ id: string; spEntityId: string; acsUrl: string }>('/identity/saml-connections', { method: 'POST', body: input });

export const updateSamlConnection = (id: string, input: Partial<SamlConnectionInput>) => apiFetch<{ ok: true }>(`/identity/saml-connections/${id}`, { method: 'PATCH', body: input });

/* ---------------------------------------------- Access pack: security policy */

export interface SecurityPolicy {
  sessionIdleMinutes: number | null;
  sessionAbsoluteHours: number | null;
  allowedCidrsInternal: string[];
  allowedCidrsClient: string[];
  allowedCidrsAssociate: string[];
  deviceTrustEnabled: boolean;
  deviceTrustDays: number;
  breakGlassEnabled: boolean;
}

export const getSecurityPolicy = () => apiFetch<SecurityPolicy>('/identity/security-policy');
export const putSecurityPolicy = (policy: SecurityPolicy) => apiFetch<SecurityPolicy>('/identity/security-policy', { method: 'PUT', body: policy });
