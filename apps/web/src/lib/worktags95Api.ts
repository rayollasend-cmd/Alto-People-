import { apiFetch } from './api';

export type WorktagEntityKind =
  | 'TIME_ENTRY'
  | 'PAYROLL_ITEM'
  | 'EXPENSE'
  | 'PURCHASE_ORDER';

export interface WorktagCategory {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isRequired: boolean;
  isActive: boolean;
  worktagCount: number;
}

export interface Worktag {
  id: string;
  categoryId: string;
  categoryKey: string;
  categoryLabel: string;
  value: string;
  code: string | null;
}

export interface WorktagAssignment {
  id: string;
  worktagId: string;
  categoryKey: string;
  categoryLabel: string;
  value: string;
  code: string | null;
  createdAt: string;
}

export const listCategories = () =>
  apiFetch<{ categories: WorktagCategory[] }>('/worktag-categories');

export const createCategory = (input: {
  key: string;
  label: string;
  description?: string | null;
  isRequired?: boolean;
}) =>
  apiFetch<{ id: string }>('/worktag-categories', { method: 'POST', body: input });

export const listWorktags = (categoryId?: string) =>
  apiFetch<{ worktags: Worktag[] }>(
    categoryId ? `/worktags?categoryId=${categoryId}` : '/worktags',
  );

export const createWorktag = (input: {
  categoryId: string;
  value: string;
  code?: string | null;
}) => apiFetch<{ id: string }>('/worktags', { method: 'POST', body: input });

export const deleteWorktag = (id: string) =>
  apiFetch<void>(`/worktags/${id}`, { method: 'DELETE' });

export const assignWorktags = (input: {
  entityKind: WorktagEntityKind;
  entityId: string;
  worktagIds: string[];
}) =>
  apiFetch<{ ok: true; assigned: number }>('/worktag-assignments', {
    method: 'POST',
    body: input,
  });

export const getAssignments = (entityKind: WorktagEntityKind, entityId: string) =>
  apiFetch<{ assignments: WorktagAssignment[] }>(
    `/worktag-assignments?entityKind=${entityKind}&entityId=${entityId}`,
  );

export const removeAssignment = (id: string) =>
  apiFetch<void>(`/worktag-assignments/${id}`, { method: 'DELETE' });

export const worktagsReport = (categoryKey: string, entityKind: WorktagEntityKind) =>
  apiFetch<{
    category: { key: string; label: string };
    entityKind: WorktagEntityKind;
    rows: Array<{ worktagId: string; value: string; count: number }>;
  }>(`/worktags/report?categoryKey=${categoryKey}&entityKind=${entityKind}`);
