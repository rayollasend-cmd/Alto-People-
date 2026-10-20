import { apiFetch } from './api';

/** Service providers (apps/api/src/lib/providers): E-Verify, screening, drug tests, tax filing, payouts. */

export type ProviderKind = 'EVERIFY' | 'BACKGROUND_CHECK' | 'DRUG_TEST' | 'TAX_FILING' | 'PAYOUT' | 'EMBEDDED_PAYROLL' | 'TAX_ENGINE' | 'ORIGINATION' | 'BANK_FEED';
export type ProviderHealth = 'not_tested' | 'healthy' | 'failing' | 'paused';

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  hint?: string;
  optional?: boolean;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  label: string;
  what: string;
  credentialFields: ProviderField[];
  settingFields: ProviderField[];
  webhook: { supported: boolean; how: string };
  steps: string[];
  confidence: 'documented' | 'partner';
}

export interface ProviderConnection {
  id: string;
  kind: ProviderKind;
  provider: string;
  providerLabel: string;
  name: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  active: boolean;
  health: ProviderHealth;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  credentialsSet: Record<string, boolean>;
  credentialValues: Record<string, string>;
  settings: Record<string, unknown>;
  webhookUrl: string | null;
  webhookSecretSet: boolean;
  createdAt: string;
}

export interface ProviderKindSummary {
  kind: ProviderKind;
  label: string;
  active: ProviderConnection | null;
  connections: ProviderConnection[];
}

export interface ProviderEventRow {
  id: string;
  direction: 'IN' | 'OUT';
  eventType: string;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  error: string | null;
  subjectType: string | null;
  createdAt: string;
}

export const listProviderConnections = () => apiFetch<{ kinds: ProviderKindSummary[] }>('/provider-connections');
export const providerCatalog = () => apiFetch<{ providers: ProviderInfo[] }>('/provider-connections/catalog');
export const createProviderConnection = (body: { kind: ProviderKind; provider: string; name?: string; environment: 'SANDBOX' | 'PRODUCTION'; credentials: Record<string, string>; settings: Record<string, unknown> }) =>
  apiFetch<{ connection: ProviderConnection; webhookSecret: string | null }>('/provider-connections', { method: 'POST', body });
export const patchProviderConnection = (id: string, body: Partial<{ name: string; environment: 'SANDBOX' | 'PRODUCTION'; active: boolean; credentials: Record<string, string>; settings: Record<string, unknown> }>) =>
  apiFetch<{ connection: ProviderConnection }>(`/provider-connections/${id}`, { method: 'PATCH', body });
export const testProviderConnection = (id: string) => apiFetch<{ ok: boolean; message: string | null; connection: ProviderConnection }>(`/provider-connections/${id}/test`, { method: 'POST' });
export const rotateProviderSecret = (id: string) => apiFetch<{ webhookSecret: string }>(`/provider-connections/${id}/rotate-secret`, { method: 'POST' });
export const deleteProviderConnection = (id: string) => apiFetch<void>(`/provider-connections/${id}`, { method: 'DELETE' });
export const providerEvents = (id: string) => apiFetch<{ events: ProviderEventRow[] }>(`/provider-connections/${id}/events?limit=30`);

export interface ConnectedSummary {
  connected: Partial<Record<ProviderKind, { provider: string; label: string; environment: string; failing: boolean }>>;
  canManageIntegrations: boolean;
}
export const providerSummary = () => apiFetch<ConnectedSummary>('/provider-actions/summary');

/* ----- Actions ----- */

export interface ConnectedTo {
  provider: string;
  label: string;
  environment: string;
}

export interface EVerifyProviderView {
  connected: ConnectedTo | null;
  sentThroughProvider: boolean;
  caseNumber: string | null;
  status: 'PENDING' | 'EMPLOYMENT_AUTHORIZED' | 'TENTATIVE_NONCONFIRMATION' | 'FINAL_NONCONFIRMATION' | 'CLOSE_CASE_AND_RESUBMIT' | null;
  rawStatus: string | null;
  openedAt: string | null;
  closedAt: string | null;
  dueBy: string | null;
  section2Done: boolean;
  tnc: { notifiedAt: string | null; decision: 'CONTEST' | 'NO_CONTEST' | null; referredAt: string | null; referralDeadline: string | null };
  closureReason: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export const everifyProviderView = (associateId: string) => apiFetch<EVerifyProviderView>(`/provider-actions/everify/${associateId}`);
export const submitEVerify = (associateId: string, firstDayOfEmployment?: string) =>
  apiFetch<EVerifyProviderView>(`/provider-actions/everify/${associateId}/submit`, { method: 'POST', body: firstDayOfEmployment ? { firstDayOfEmployment } : {} });
export const refreshEVerify = (associateId: string) => apiFetch<EVerifyProviderView>(`/provider-actions/everify/${associateId}/refresh`, { method: 'POST' });
export const recordEVerifyDecision = (associateId: string, decision: 'CONTEST' | 'NO_CONTEST') =>
  apiFetch<EVerifyProviderView>(`/provider-actions/everify/${associateId}/notice`, { method: 'POST', body: { decision } });
export type EVerifyClosure = 'EMPLOYEE_CONTINUES_TO_WORK' | 'EMPLOYEE_NO_LONGER_EMPLOYED' | 'INCORRECT_DATA' | 'DUPLICATE_CASE' | 'TERMINATED_FOR_FINAL_NONCONFIRMATION';
export const closeEVerify = (associateId: string, reason: EVerifyClosure) =>
  apiFetch<EVerifyProviderView>(`/provider-actions/everify/${associateId}/close`, { method: 'POST', body: { reason } });

export interface BackgroundProviderView {
  id: string;
  connected: ConnectedTo | null;
  ordered: boolean;
  provider: string;
  packageCode: string | null;
  invitationUrl: string | null;
  status: 'INITIATED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED' | 'NEEDS_REVIEW';
  rawStatus: string | null;
  result: 'clear' | 'consider' | null;
  adjudication: 'ENGAGED' | 'PRE_ADVERSE' | 'ADVERSE' | null;
  preAdverseSentAt: string | null;
  adverseWaitUntil: string | null;
  canSendFinal: boolean;
  adverseSentAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export const backgroundProviderView = (id: string) => apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}`);
export const orderBackground = (id: string, packageCode?: string) =>
  apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}/order`, { method: 'POST', body: packageCode ? { packageCode } : {} });
export const refreshBackground = (id: string) => apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}/refresh`, { method: 'POST' });
export const startPreAdverse = (id: string) => apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}/pre-adverse`, { method: 'POST', body: { confirm: true } });
export const sendFinalAdverse = (id: string) => apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}/adverse`, { method: 'POST', body: { confirm: true } });
export const withdrawAdverse = (id: string) => apiFetch<BackgroundProviderView>(`/provider-actions/background/${id}/withdraw`, { method: 'POST' });

export interface DrugProviderView {
  id: string;
  connected: ConnectedTo | null;
  ordered: boolean;
  provider: string;
  panelCode: string | null;
  reason: string | null;
  donorPassUrl: string | null;
  donorPassExpiresAt: string | null;
  collectionSite: string | null;
  status: 'INITIATED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED' | 'NEEDS_REVIEW';
  rawStatus: string | null;
  resultCode: 'NEGATIVE' | 'POSITIVE' | 'DILUTE' | 'CANCELLED' | null;
  mroVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export type DrugReason = 'PRE_EMPLOYMENT' | 'RANDOM' | 'POST_ACCIDENT' | 'REASONABLE_SUSPICION' | 'RETURN_TO_DUTY' | 'FOLLOW_UP';
export const drugProviderView = (id: string) => apiFetch<DrugProviderView>(`/provider-actions/drug-tests/${id}`);
export const orderDrug = (id: string, body: { panel?: string; reason?: DrugReason }) => apiFetch<DrugProviderView>(`/provider-actions/drug-tests/${id}/order`, { method: 'POST', body });
export const refreshDrug = (id: string) => apiFetch<DrugProviderView>(`/provider-actions/drug-tests/${id}/refresh`, { method: 'POST' });

export interface EfileView {
  id: string;
  status: 'DRAFT' | 'FILED' | 'AMENDED' | 'VOIDED';
  efileStatus: 'SUBMITTED' | 'SENT_TO_AGENCY' | 'ACCEPTED' | 'REJECTED' | null;
  efileSubmissionId: string | null;
  efileSubmittedAt: string | null;
  efileStatusAt: string | null;
  efileRejectionReason: string | null;
  filingConfirmation: string | null;
  filedAt: string | null;
}
export const efileForm = (id: string) => apiFetch<EfileView>(`/provider-actions/tax-forms/${id}/efile`, { method: 'POST' });
export const refreshEfile = (id: string) => apiFetch<EfileView>(`/provider-actions/tax-forms/${id}/refresh`, { method: 'POST' });
