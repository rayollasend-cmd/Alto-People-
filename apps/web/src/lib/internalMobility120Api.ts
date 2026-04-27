import { apiFetch } from './api';

export type InternalApplicationStatus =
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'INTERVIEWING'
  | 'OFFERED'
  | 'HIRED'
  | 'REJECTED'
  | 'WITHDRAWN';

export interface JobRow {
  id: string;
  title: string;
  description: string;
  location: string | null;
  minSalary: string | null;
  maxSalary: string | null;
  currency: string;
  clientName: string | null;
  openedAt: string | null;
  applicantCount: number;
  myApplication: { id: string; status: InternalApplicationStatus } | null;
}

export interface JobDetail {
  id: string;
  title: string;
  description: string;
  location: string | null;
  minSalary: string | null;
  maxSalary: string | null;
  currency: string;
  clientName: string | null;
  openedAt: string | null;
  myApplication: { id: string; status: InternalApplicationStatus } | null;
}

export interface MyApplicationRow {
  id: string;
  status: InternalApplicationStatus;
  coverLetter: string | null;
  createdAt: string;
  posting: { id: string; title: string; location: string | null };
}

export interface ApplicationDetail {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  currentTitle: string | null;
  currentDepartment: string | null;
  status: InternalApplicationStatus;
  coverLetter: string | null;
  resumeUrl: string | null;
  reviewerNotes: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export const STATUS_LABELS: Record<InternalApplicationStatus, string> = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  INTERVIEWING: 'Interviewing',
  OFFERED: 'Offered',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

export const listInternalJobs = () =>
  apiFetch<{ jobs: JobRow[] }>('/internal-jobs');

export const getInternalJob = (id: string) =>
  apiFetch<JobDetail>(`/internal-jobs/${id}`);

export const applyToInternalJob = (
  id: string,
  input: { coverLetter?: string | null; resumeUrl?: string | null },
) =>
  apiFetch<{ id: string }>(`/internal-jobs/${id}/apply`, {
    method: 'POST',
    body: input,
  });

export const listMyApplications = () =>
  apiFetch<{ applications: MyApplicationRow[] }>('/my/internal-applications');

export const withdrawApplication = (id: string) =>
  apiFetch<{ ok: true }>(`/internal-applications/${id}/withdraw`, {
    method: 'POST',
    body: {},
  });

export const listApplicationsForJob = (postingId: string) =>
  apiFetch<{ applications: ApplicationDetail[] }>(
    `/internal-jobs/${postingId}/applications`,
  );

export const decideApplication = (
  id: string,
  input: { status: InternalApplicationStatus; reviewerNotes?: string | null },
) =>
  apiFetch<{ ok: true }>(`/internal-applications/${id}/decision`, {
    method: 'PATCH',
    body: input,
  });
