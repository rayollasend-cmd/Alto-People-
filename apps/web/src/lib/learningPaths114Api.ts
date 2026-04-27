import { apiFetch } from './api';

export type LearningPathStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type LearningPathEnrollmentStatus =
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'WITHDRAWN';

export interface LearningPathSummary {
  id: string;
  title: string;
  description: string | null;
  clientId: string | null;
  clientName: string | null;
  status: LearningPathStatus;
  isRequired: boolean;
  stepCount: number;
  enrollmentCount: number;
  createdAt: string;
}

export interface LearningPathDetail {
  id: string;
  title: string;
  description: string | null;
  status: LearningPathStatus;
  isRequired: boolean;
  steps: {
    id: string;
    order: number;
    courseId: string;
    courseTitle: string;
    courseIsRequired: boolean;
  }[];
}

export interface LearningPathStatusResp {
  pathId: string;
  title: string;
  stepStatus: {
    courseId: string;
    courseTitle: string;
    order: number;
    status: string;
    completedAt: string | null;
  }[];
  nextStep: {
    courseId: string;
    courseTitle: string;
    order: number;
    status: string;
  } | null;
  allComplete: boolean;
}

export interface MyLearningPath {
  enrollmentId: string;
  pathId: string;
  title: string;
  description: string | null;
  stepCount: number;
  status: LearningPathEnrollmentStatus;
  assignedAt: string;
  completedAt: string | null;
}

export const listLearningPaths = (status?: LearningPathStatus) =>
  apiFetch<{ paths: LearningPathSummary[] }>(
    `/learning-paths${status ? `?status=${status}` : ''}`,
  );

export const getLearningPath = (id: string) =>
  apiFetch<LearningPathDetail>(`/learning-paths/${id}`);

export const createLearningPath = (input: {
  clientId?: string | null;
  title: string;
  description?: string | null;
  isRequired?: boolean;
}) =>
  apiFetch<{ id: string }>('/learning-paths', { method: 'POST', body: input });

export const updateLearningPath = (
  id: string,
  input: Partial<{
    title: string;
    description: string | null;
    isRequired: boolean;
    status: LearningPathStatus;
  }>,
) =>
  apiFetch<{ ok: true }>(`/learning-paths/${id}`, {
    method: 'PUT',
    body: input,
  });

export const deleteLearningPath = (id: string) =>
  apiFetch<void>(`/learning-paths/${id}`, { method: 'DELETE' });

export const addLearningPathStep = (input: {
  pathId: string;
  courseId: string;
}) =>
  apiFetch<{ id: string; order: number }>('/learning-path-steps', {
    method: 'POST',
    body: input,
  });

export const removeLearningPathStep = (id: string) =>
  apiFetch<void>(`/learning-path-steps/${id}`, { method: 'DELETE' });

export const reorderLearningPathSteps = (pathId: string, stepIds: string[]) =>
  apiFetch<{ ok: true }>(`/learning-paths/${pathId}/reorder`, {
    method: 'POST',
    body: { stepIds },
  });

export const enrollInLearningPath = (input: {
  pathId: string;
  associateId: string;
}) =>
  apiFetch<{ id: string }>('/learning-path-enrollments', {
    method: 'POST',
    body: input,
  });

export const withdrawLearningPathEnrollment = (id: string) =>
  apiFetch<void>(`/learning-path-enrollments/${id}`, { method: 'DELETE' });

export const getLearningPathStatus = (pathId: string, associateId: string) =>
  apiFetch<LearningPathStatusResp>(
    `/learning-paths/${pathId}/status?associateId=${associateId}`,
  );

export const listMyLearningPaths = () =>
  apiFetch<{ paths: MyLearningPath[] }>('/my/learning-paths');
