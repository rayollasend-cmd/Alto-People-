import type { ReportPeriodToken } from '@alto-people/shared';
import { apiFetch } from './api';

export type ReportEntity =
  | 'ASSOCIATE'
  | 'TIME_ENTRY'
  | 'PAYROLL_ITEM'
  | 'PAYROLL_RUN'
  | 'APPLICATION'
  | 'EXPENSE'
  | 'CANDIDATE'
  | 'SEPARATION'
  | 'LEAVE_CASE'
  | 'HR_CASE'
  | 'OFFER'
  // Computed (api lib/reportComputed).
  | 'PAY_CHANGE'
  | 'TIME_TO_FILL'
  | 'OVERTIME';

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

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** One roll-up per group: `count` ignores the column; the alias is the output key. */
export interface ReportAggregate {
  fn: AggregateFn;
  column?: string | null;
  alias?: string | null;
}

export interface ReportSpec {
  columns: string[];
  filters: ReportFilter[];
  sort: ReportSort[];
  limit: number;
  /** Set when the report summarizes: one row per distinct combination, with `aggregates` per row. */
  groupBy?: string[];
  aggregates?: ReportAggregate[];
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
  /** Who saved it (null when the account is gone). */
  ownerName?: string | null;
  /** The caller saved it. */
  mine?: boolean;
  /** When it last ran — by hand from the list or by a schedule's delivery. */
  lastRunAt?: string | null;
  /** Active schedules and their cadences. */
  scheduleCount?: number;
  cadences?: string[];
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
