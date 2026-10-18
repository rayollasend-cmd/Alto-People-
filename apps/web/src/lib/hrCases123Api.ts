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

/** How a case stands against its SLA (lib/hrCaseSla on the API). */
export type SlaState = 'MET' | 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'NONE';
export interface SlaView {
  dueAt: string | null;
  state: SlaState;
  /** Minutes until due (negative when overdue); null when paused, done or unset. */
  minutesLeft: number | null;
}

export interface SlaTarget {
  category: CaseCategory;
  priority: CasePriority;
  targetHours: number;
  custom: boolean;
}

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
  sla: SlaView;
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
  sla: SlaView;
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
  sla: SlaView;
  comments: CaseComment[];
}

export interface CaseComment {
  id: string;
  body: string;
  internalNote: boolean;
  createdAt: string;
  authorEmail: string | null;
  authorName: string | null;
  /** The author's face — cache-busted; null when the author is unknown. */
  authorPhotoUrl: string | null;
}

export interface CaseSummary {
  openTotal: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
  sla: { breached: number; atRisk: number };
}

export const getSlaTargets = () => apiFetch<{ targets: SlaTarget[] }>('/hr-cases-sla');
export const updateSlaTargets = (targets: Array<{ category: CaseCategory; priority: CasePriority; targetHours: number | null }>) =>
  apiFetch<{ targets: SlaTarget[] }>('/hr-cases-sla', { method: 'PUT', body: { targets } });

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
  /** One person's cases (the person record's Cases tab). */
  associateId?: string;
  /** Only open cases past their SLA. */
  sla?: 'breached';
}, page = 0) => {
  const q = new URLSearchParams();
  if (page) q.set('page', String(page));
  if (params.status) q.set('status', params.status);
  if (params.category) q.set('category', params.category);
  if (params.assignedToMe) q.set('assignedToMe', 'true');
  if (params.associateId) q.set('associateId', params.associateId);
  if (params.sla) q.set('sla', params.sla);
  const qs = q.toString();
  // One page; `hasMore` says the server holds more than it sent.
  return apiFetch<{ cases: QueueCaseRow[]; total?: number; hasMore?: boolean }>(
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

export interface CaseStaffRow {
  userId: string;
  email: string;
  role: string;
  name: string;
  /** Which slice of the desk they can work: every case, or PAYROLL only. */
  desk: 'all' | 'payroll';
}

export const listCaseStaff = () =>
  apiFetch<{ staff: CaseStaffRow[] }>('/hr-cases-staff');
