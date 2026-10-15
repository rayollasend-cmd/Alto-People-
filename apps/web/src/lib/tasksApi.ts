import type { WorkTaskAssignInput, WorkTaskCreate, WorkTaskDetailView, WorkTaskEventCreate, WorkTaskPolicyUpdate, WorkTaskPolicyView, WorkTaskSummary, WorkTaskView } from '@alto-people/shared';
import { apiFetch } from './api';

/** Brief 3-2: tasks, their assignment and the engine's policy. */

export interface TaskListFilter {
  locationId?: string | null;
  from?: string | null;
  to?: string | null;
  status?: string | null;
}

const qs = (params: Record<string, string | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
};

export const listTasks = (f: TaskListFilter) => apiFetch<{ tasks: WorkTaskView[] }>(`/tasks${qs({ locationId: f.locationId, from: f.from, to: f.to, status: f.status })}`);
export const getTaskSummary = (locationId?: string | null) => apiFetch<WorkTaskSummary>(`/tasks/summary${qs({ locationId })}`);
export const getTask = (id: string) => apiFetch<WorkTaskDetailView>(`/tasks/${id}`);
export const createTask = (body: WorkTaskCreate) => apiFetch<WorkTaskDetailView>('/tasks', { method: 'POST', body });
export const assignTask = (id: string, body: WorkTaskAssignInput) => apiFetch<WorkTaskDetailView>(`/tasks/${id}/assign`, { method: 'POST', body });
export const autoAssignTask = (id: string) => apiFetch<WorkTaskDetailView>(`/tasks/${id}/auto`, { method: 'POST' });
export const handOffTask = (id: string) => apiFetch<WorkTaskDetailView>(`/tasks/${id}/handoff`, { method: 'POST' });
export const recordTaskEvent = (id: string, body: WorkTaskEventCreate) => apiFetch<WorkTaskDetailView>(`/tasks/${id}/events`, { method: 'POST', body });
export const getTaskPolicy = (locationId?: string | null) => apiFetch<WorkTaskPolicyView>(`/tasks/policy${qs({ locationId })}`);
export const updateTaskPolicy = (body: WorkTaskPolicyUpdate, locationId?: string | null) => apiFetch<WorkTaskPolicyView>(`/tasks/policy${qs({ locationId })}`, { method: 'PUT', body });
