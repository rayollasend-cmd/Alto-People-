import type { DocumentKind } from '@alto-people/shared';
import { apiFetch } from './api';

/** Document retention by kind (HR pack 2026-10). */

export interface RetentionPolicyRow {
  kind: DocumentKind;
  /** Null = kept forever. */
  retainYearsAfterSeparation: number | null;
  /** The legal floor in years, where the law sets one. */
  floorYears: number | null;
}

export interface PurgeCandidate {
  id: string;
  kind: DocumentKind;
  filename: string;
  associateId: string;
  associateName: string;
  separatedAt: string;
  retainYears: number;
}

export const getRetentionPolicies = () => apiFetch<{ policies: RetentionPolicyRow[] }>('/document-retention');
export const updateRetentionPolicies = (policies: Array<{ kind: DocumentKind; retainYearsAfterSeparation: number | null }>) =>
  apiFetch<{ policies: RetentionPolicyRow[] }>('/document-retention', { method: 'PUT', body: { policies } });
export const previewRetention = () => apiFetch<{ count: number; candidates: PurgeCandidate[] }>('/document-retention/preview');
