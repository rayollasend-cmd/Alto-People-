import { apiFetch } from './api';

export type CaseCategory =
  | 'BENEFITS'
  | 'PAYROLL'
  | 'TIME_OFF'
  | 'PERSONAL_INFO'
  | 'WORKPLACE_CONCERN'
  | 'HARASSMENT'
  | 'PERFORMANCE'
  | 'OTHER';

export type CasePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export type CaseStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'WAITING_ASSOCIATE'
  | 'RESOLVED'
  | 'CLOSED';

export interface MyCaseRow {
  id: string;
  category: CaseCategory;
  subject: string;
  status: CaseStatus;
  priority: CasePriority;
  assignedToEmail: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface QueueCaseRow {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  category: CaseCategory;
  subject: string;
  priority: CasePriority;
  status: CaseStatus;
  assignedToEmail: string | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaseDetail {
  id: string;
  associateId: string;
  associateName: string;
  associateEmail: string;
  category: CaseCategory;
  subject: string;
  description: string;
  priority: CasePriority;
  status: CaseStatus;
  assignedToEmail: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  comments: CaseComment[];
}

export interface CaseComment {
  id: string;
  body: string;
  internalNote: boolean;
  createdAt: string;
  authorEmail: string | null;
  authorName: string | null;
}

export interface CaseSummary {
  openTotal: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
}

export const CATEGORY_LABELS: Record<CaseCategory, string> = {
  BENEFITS: 'Benefits',
  PAYROLL: 'Payroll',
  TIME_OFF: 'Time off',
  PERSONAL_INFO: 'Personal info',
  WORKPLACE_CONCERN: 'Workplace concern',
  HARASSMENT: 'Harassment',
  PERFORMANCE: 'Performance',
  OTHER: 'Other',
};

export const STATUS_LABELS: Record<CaseStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_ASSOCIATE: 'Waiting on associate',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export const fileCase = (input: {
  category: CaseCategory;
  subject: string;
  description: string;
  priority?: CasePriority;
}) => apiFetch<{ id: string }>('/hr-cases', { method: 'POST', body: input });

export const listMyCases = () =>
  apiFetch<{ cases: MyCaseRow[] }>('/my/hr-cases');

export const listCaseQueue = (params: {
  status?: CaseStatus;
  category?: CaseCategory;
  assignedToMe?: boolean;
}) => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.category) q.set('category', params.category);
  if (params.assignedToMe) q.set('assignedToMe', 'true');
  const qs = q.toString();
  return apiFetch<{ cases: QueueCaseRow[] }>(
    `/hr-cases${qs ? `?${qs}` : ''}`,
  );
};

export const getCase = (id: string) =>
  apiFetch<CaseDetail>(`/hr-cases/${id}`);

export const addComment = (
  id: string,
  body: string,
  internalNote = false,
) =>
  apiFetch<{ id: string }>(`/hr-cases/${id}/comments`, {
    method: 'POST',
    body: { body, internalNote },
  });

export const triageCase = (
  id: string,
  input: {
    status?: CaseStatus;
    priority?: CasePriority;
    assignedToId?: string | null;
    resolution?: string | null;
  },
) => apiFetch<{ ok: true }>(`/hr-cases/${id}`, { method: 'PATCH', body: input });

export const getCaseSummary = () =>
  apiFetch<CaseSummary>('/hr-cases-summary');
