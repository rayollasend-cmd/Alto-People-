import { apiFetch } from './api';

export type ReportCategory =
  | 'HARASSMENT'
  | 'DISCRIMINATION'
  | 'ETHICS_VIOLATION'
  | 'FRAUD'
  | 'SAFETY'
  | 'RETALIATION'
  | 'OTHER';

export type ReportStatus =
  | 'RECEIVED'
  | 'TRIAGING'
  | 'INVESTIGATING'
  | 'RESOLVED'
  | 'CLOSED';

export interface PublicReportUpdate {
  id: string;
  body: string;
  isFromReporter: boolean;
  createdAt: string;
}

export interface PublicReport {
  trackingCode: string;
  category: ReportCategory;
  subject: string;
  description: string;
  status: ReportStatus;
  contactEmail: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updates: PublicReportUpdate[];
}

export interface QueueReport {
  id: string;
  trackingCode: string;
  category: ReportCategory;
  subject: string;
  status: ReportStatus;
  contactEmail: string | null;
  assignedToEmail: string | null;
  updateCount: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface HrReportUpdate {
  id: string;
  body: string;
  isFromReporter: boolean;
  internalOnly: boolean;
  authorEmail: string | null;
  createdAt: string;
}

export interface HrReportDetail {
  id: string;
  trackingCode: string;
  category: ReportCategory;
  subject: string;
  description: string;
  status: ReportStatus;
  contactEmail: string | null;
  assignedTo: { id: string; email: string } | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updates: HrReportUpdate[];
}

export interface HotlineSummary {
  newCount: number;
  triagingCount: number;
  investigatingCount: number;
  resolvedCount: number;
}

export const fileAnonymousReport = (input: {
  category: ReportCategory;
  subject: string;
  description: string;
  contactEmail?: string | null;
}) =>
  apiFetch<{ trackingCode: string }>('/anonymous-reports', {
    method: 'POST',
    body: input,
  });

export const lookupReportByCode = (code: string) =>
  apiFetch<{ report: PublicReport }>(
    `/anonymous-reports/code/${encodeURIComponent(code)}`,
  );

export const replyAsReporter = (code: string, body: string) =>
  apiFetch<{ ok: true }>(
    `/anonymous-reports/code/${encodeURIComponent(code)}/messages`,
    { method: 'POST', body: { body } },
  );

export const listReportQueue = (status?: ReportStatus) =>
  apiFetch<{ reports: QueueReport[] }>(
    `/anonymous-reports${status ? `?status=${status}` : ''}`,
  );

export const getReportDetail = (id: string) =>
  apiFetch<{ report: HrReportDetail }>(`/anonymous-reports/${id}`);

export const triageReport = (
  id: string,
  patch: {
    status?: ReportStatus;
    assignedToId?: string | null;
    resolution?: string | null;
  },
) =>
  apiFetch<{ ok: true }>(`/anonymous-reports/${id}`, {
    method: 'PATCH',
    body: patch,
  });

export const postHrMessage = (id: string, body: string, internalOnly: boolean) =>
  apiFetch<{ ok: true }>(`/anonymous-reports/${id}/messages`, {
    method: 'POST',
    body: { body, internalOnly },
  });

export const getHotlineSummary = () =>
  apiFetch<HotlineSummary>('/anonymous-reports-summary');
