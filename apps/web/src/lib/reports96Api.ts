import { apiFetch } from './api';

export type ReportEntity =
  | 'ASSOCIATE'
  | 'TIME_ENTRY'
  | 'PAYROLL_ITEM'
  | 'PAYROLL_RUN'
  | 'APPLICATION'
  | 'EXPENSE'
  | 'CANDIDATE';

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';

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
