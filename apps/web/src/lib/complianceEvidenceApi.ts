import type { ComplianceEvidenceResponse, EvidenceRow, EvidenceSignoffInput } from '@alto-people/shared';
import { apiFetch } from './api';

/**
 * Brief 2-5 — the Compliance evidence page. Every SOC 2 control in the
 * catalog with its latest evidence; a control's history; a sign-off.
 * Platform evidence: only the operator's own tenant is answered.
 */
export function getComplianceEvidence(): Promise<ComplianceEvidenceResponse> {
  return apiFetch<ComplianceEvidenceResponse>('/admin/compliance-evidence');
}

export function getControlHistory(control: string): Promise<{ control: string; evidence: EvidenceRow[] }> {
  return apiFetch<{ control: string; evidence: EvidenceRow[] }>(`/admin/compliance-evidence/${encodeURIComponent(control)}`);
}

export function signOffEvidence(evidenceId: string, body: EvidenceSignoffInput): Promise<{ id: string }> {
  return apiFetch<{ id: string }>(`/admin/compliance-evidence/${encodeURIComponent(evidenceId)}/signoff`, { method: 'POST', body });
}
