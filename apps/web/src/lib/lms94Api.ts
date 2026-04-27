import { apiFetch } from './api';

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export type EnrollmentStatus =
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'WAIVED';

export type CourseModuleKind =
  | 'VIDEO'
  | 'READING'
  | 'QUIZ'
  | 'EXTERNAL_LINK'
  | 'POLICY_ACK';

export interface Course {
  id: string;
  clientId: string | null;
  title: string;
  description: string | null;
  isRequired: boolean;
  validityDays: number | null;
  status: CourseStatus;
  moduleCount: number;
  enrollmentCount: number;
  createdAt: string;
}

export interface CourseModule {
  id: string;
  kind: CourseModuleKind;
  title: string;
  content: Record<string, unknown>;
  order: number;
}

export interface Enrollment {
  id: string;
  courseId: string;
  courseTitle: string;
  associateId: string;
  associateName: string;
  status: EnrollmentStatus;
  completedAt: string | null;
  expiresAt: string | null;
  score: string | null;
  assignedAt: string;
}

export interface ExpiringEnrollment {
  id: string;
  courseTitle: string;
  isRequired: boolean;
  associateName: string;
  expiresAt: string;
  daysLeft: number;
}

export const listCourses = (status?: CourseStatus) =>
  apiFetch<{ courses: Course[] }>(status ? `/courses?status=${status}` : '/courses');

export const createCourse = (input: {
  clientId?: string | null;
  title: string;
  description?: string | null;
  isRequired?: boolean;
  validityDays?: number | null;
}) => apiFetch<{ id: string }>('/courses', { method: 'POST', body: input });

export const publishCourse = (id: string) =>
  apiFetch<{ ok: true }>(`/courses/${id}/publish`, { method: 'POST', body: {} });

export const archiveCourse = (id: string) =>
  apiFetch<{ ok: true }>(`/courses/${id}/archive`, { method: 'POST', body: {} });

export const deleteCourse = (id: string) =>
  apiFetch<void>(`/courses/${id}`, { method: 'DELETE' });

export const listModules = (courseId: string) =>
  apiFetch<{ modules: CourseModule[] }>(`/courses/${courseId}/modules`);

export const addModule = (
  courseId: string,
  input: {
    kind: CourseModuleKind;
    title: string;
    content?: Record<string, unknown>;
    order?: number;
  },
) =>
  apiFetch<{ id: string }>(`/courses/${courseId}/modules`, {
    method: 'POST',
    body: input,
  });

export const enrollAssociates = (courseId: string, associateIds: string[]) =>
  apiFetch<{ created: number; skipped: number }>(`/courses/${courseId}/enroll`, {
    method: 'POST',
    body: { associateIds },
  });

export const listEnrollments = (params?: {
  associateId?: string;
  courseId?: string;
  status?: EnrollmentStatus;
}) => {
  const q = new URLSearchParams();
  if (params?.associateId) q.set('associateId', params.associateId);
  if (params?.courseId) q.set('courseId', params.courseId);
  if (params?.status) q.set('status', params.status);
  const suffix = q.toString() ? `?${q.toString()}` : '';
  return apiFetch<{ enrollments: Enrollment[] }>(`/enrollments${suffix}`);
};

export const completeEnrollment = (id: string, score?: number) =>
  apiFetch<{ ok: true; expiresAt: string | null }>(
    `/enrollments/${id}/complete`,
    { method: 'POST', body: score != null ? { score } : {} },
  );

export const waiveEnrollment = (id: string) =>
  apiFetch<{ ok: true }>(`/enrollments/${id}/waive`, { method: 'POST', body: {} });

export const listExpiring = (days: number) =>
  apiFetch<{ expiring: ExpiringEnrollment[] }>(`/lms/expiring?days=${days}`);
