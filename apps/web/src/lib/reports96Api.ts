import type { ReportPeriodToken } from '@alto-people/shared';
import { apiFetch } from './api';

export type ReportEntity =
  | 'ASSOCIATE'
  | 'TIME_ENTRY'
  | 'PAYROLL_ITEM'
  | 'PAYROLL_RUN'
  | 'APPLICATION'
  | 'EXPENSE'
  | 'CANDIDATE';

// `period` pairs with a ReportPeriodToken value ('last-week', …); the
// server resolves the token to a concrete date window at run time.
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'period';

export interface ReportFilter {
  column: string;
  op: FilterOp;
  value: unknown;
}

export interface ReportSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface ReportSpec {
  columns: string[];
  filters: ReportFilter[];
  sort: ReportSort[];
  limit: number;
}

export interface ReportSummary {
  id: string;
  name: string;
  description: string | null;
  entity: ReportEntity;
  isPublic: boolean;
  /** First relative-period token in the spec, for the list's window label. */
  period: ReportPeriodToken | null;
  createdAt: string;
}

export interface ReportFull {
  id: string;
  name: string;
  description: string | null;
  entity: ReportEntity;
  spec: ReportSpec;
  isPublic: boolean;
  createdAt: string;
}

export interface ReportSchedule {
  id: string;
  cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  recipients: string;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
}

export const listReports = () =>
  apiFetch<{ reports: ReportSummary[] }>('/reports');

export const getReport = (id: string) =>
  apiFetch<ReportFull>(`/reports/${id}`);

export const createReport = (input: {
  name: string;
  description?: string | null;
  entity: ReportEntity;
  spec: ReportSpec;
  isPublic?: boolean;
}) => apiFetch<{ id: string }>('/reports', { method: 'POST', body: input });

/** Author-only in-place edit — authorship (createdById) is preserved. */
export const updateReport = (
  id: string,
  input: {
    name?: string;
    description?: string | null;
    entity?: ReportEntity;
    spec?: ReportSpec;
    isPublic?: boolean;
  },
) => apiFetch<{ id: string }>(`/reports/${id}`, { method: 'PATCH', body: input });

export const deleteReport = (id: string) =>
  apiFetch<void>(`/reports/${id}`, { method: 'DELETE' });

export const runReport = (id: string) =>
  apiFetch<{ entity: ReportEntity; columns: string[]; rows: unknown[] }>(
    `/reports/${id}/run`,
    { method: 'POST', body: {} },
  );

export const previewReport = (input: {
  name: string;
  entity: ReportEntity;
  spec: ReportSpec;
}) =>
  apiFetch<{ entity: ReportEntity; columns: string[]; rows: unknown[] }>(
    '/reports/preview',
    { method: 'POST', body: input },
  );

export const listColumns = (entity: ReportEntity) =>
  apiFetch<{ entity: ReportEntity; columns: string[] }>(
    `/reports/_columns/${entity}`,
  );

export const listSchedules = (reportId: string) =>
  apiFetch<{ schedules: ReportSchedule[] }>(`/reports/${reportId}/schedules`);

export const createSchedule = (
  reportId: string,
  input: { cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY'; recipients: string },
) =>
  apiFetch<{ id: string }>(`/reports/${reportId}/schedules`, {
    method: 'POST',
    body: input,
  });

// Server route is DELETE /report-schedules/:id (not nested under the report).
export const deleteSchedule = (scheduleId: string) =>
  apiFetch<void>(`/report-schedules/${scheduleId}`, { method: 'DELETE' });
