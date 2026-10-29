import { apiFetch } from './api';

/** Mass update (HR pack 2026-10): filter → preview → apply, undo for 24 hours. */

export interface MassUpdateFilter {
  siteIds?: string[];
  departmentIds?: string[];
  managerIds?: string[];
  payrollScheduleIds?: string[];
  clientIds?: string[];
  associateIds?: string[];
  includeSeparated?: boolean;
}

export interface MassUpdateChanges {
  siteId?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
  payrollScheduleId?: string | null;
  costCenterId?: string | null;
  jobProfileId?: string | null;
}

export interface MassUpdatePreviewRow {
  associateId: string;
  name: string;
  changes: Array<{ field: 'site' | 'department' | 'manager' | 'paySchedule' | string; from: string | null; to: string | null }>;
}

export interface MassUpdateBatch {
  id: string;
  actorEmail: string | null;
  /** The actor's name (display name, else their person record, else the email's local part). */
  actorName?: string | null;
  changes: Record<string, unknown>;
  affectedCount: number;
  appliedAt: string;
  undoneAt: string | null;
  canUndo: boolean;
}

export const previewMassUpdate = (filter: MassUpdateFilter, changes: MassUpdateChanges) =>
  apiFetch<{ matched: number; willChange: number; rows: MassUpdatePreviewRow[] }>('/people/mass-update/preview', { method: 'POST', body: { filter, changes } });
export const applyMassUpdate = (filter: MassUpdateFilter, changes: MassUpdateChanges) =>
  apiFetch<{ batchId: string; affected: number; undoUntil: string }>('/people/mass-update', { method: 'POST', body: { filter, changes } });
export const listMassUpdateBatches = () => apiFetch<{ batches: MassUpdateBatch[] }>('/people/mass-update/batches');
export const undoMassUpdate = (id: string) => apiFetch<{ ok: true; restored: number }>(`/people/mass-update/${id}/undo`, { method: 'POST' });
