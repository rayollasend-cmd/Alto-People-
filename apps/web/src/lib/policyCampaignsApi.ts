import { apiFetch } from './api';

/** Policy campaigns (HR pack 2026-10): one policy to an audience, signed per person. */

export type PolicyAudience =
  | { kind: 'ALL' }
  | { kind: 'DEPARTMENT'; ids: string[] }
  | { kind: 'CLIENT'; ids: string[] }
  | { kind: 'SITE'; ids: string[] }
  | { kind: 'ROLE'; roles: string[] };

export type PolicyCampaignStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';
export type PolicyRecipientStatus = 'PENDING' | 'SIGNED' | 'WAIVED';

export interface PolicyCompletion {
  total: number;
  signed: number;
  waived: number;
  pending: number;
  pct: number;
}

export interface PolicyCampaignRow {
  id: string;
  name: string;
  templateName: string;
  version: number;
  audience: PolicyAudience;
  dueOn: string;
  reminderEveryDays: number;
  status: PolicyCampaignStatus;
  launchedAt: string | null;
  lastReminderAt: string | null;
  completion: PolicyCompletion;
}

export interface PolicyRecipient {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string | null;
  status: PolicyRecipientStatus;
  signedAt: string | null;
  remindedAt: string | null;
  waiveReason: string | null;
}

export interface PolicyCampaignDetail extends PolicyCampaignRow {
  body: string;
  audienceSize: number;
  recipients: PolicyRecipient[];
}

export interface MyPolicy {
  id: string;
  campaignId: string;
  name: string;
  dueOn: string;
  status: PolicyRecipientStatus;
  body: string;
  signedAt: string | null;
  signature: string | null;
  contentSha256: string | null;
}

export const listPolicyCampaigns = () => apiFetch<{ campaigns: PolicyCampaignRow[] }>('/policy-campaigns');
export const getPolicyCampaign = (id: string) => apiFetch<PolicyCampaignDetail>(`/policy-campaigns/${id}`);
export const audienceSize = (audience: PolicyAudience) =>
  apiFetch<{ count: number }>('/policy-campaigns/audience-size', { method: 'POST', body: { audience } });
export const createPolicyCampaign = (input: { name: string; templateId: string; versionId?: string | null; audience: PolicyAudience; dueOn: string; reminderEveryDays: number }) =>
  apiFetch<{ id: string }>('/policy-campaigns', { method: 'POST', body: input });
export const launchPolicyCampaign = (id: string) => apiFetch<{ ok: true; recipients: number }>(`/policy-campaigns/${id}/launch`, { method: 'POST' });
export const closePolicyCampaign = (id: string) => apiFetch<{ ok: true }>(`/policy-campaigns/${id}/close`, { method: 'POST' });
export const waivePolicyRecipient = (campaignId: string, recipientId: string, reason: string) =>
  apiFetch<{ ok: true }>(`/policy-campaigns/${campaignId}/recipients/${recipientId}/waive`, { method: 'POST', body: { reason } });

export const listMyPolicies = () => apiFetch<{ policies: MyPolicy[] }>('/my/policies');
export const signMyPolicy = (recipientId: string, signature: string) =>
  apiFetch<{ ok: true; signedAt: string }>(`/my/policies/${recipientId}/sign`, { method: 'POST', body: { signature } });
