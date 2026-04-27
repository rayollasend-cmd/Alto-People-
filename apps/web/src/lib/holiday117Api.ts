import { apiFetch } from './api';

export type HolidayType = 'FEDERAL' | 'STATE' | 'COMPANY' | 'CLIENT_SPECIFIC';

export interface HolidayRow {
  id: string;
  name: string;
  date: string;
  type: HolidayType;
  state: string | null;
  paid: boolean;
  notes: string | null;
  clientId: string | null;
  clientName: string | null;
  scope: 'company' | 'client';
}

export interface UpcomingHoliday {
  id: string;
  name: string;
  date: string;
  type: HolidayType;
  paid: boolean;
  clientName: string | null;
  daysUntil: number;
}

export const listHolidays = (params: {
  year?: number;
  clientId?: string;
  type?: HolidayType;
}) => {
  const q = new URLSearchParams();
  if (params.year) q.set('year', String(params.year));
  if (params.clientId) q.set('clientId', params.clientId);
  if (params.type) q.set('type', params.type);
  const qs = q.toString();
  return apiFetch<{ holidays: HolidayRow[] }>(
    `/holidays${qs ? `?${qs}` : ''}`,
  );
};

export const listUpcomingHolidays = (days = 30) =>
  apiFetch<{ days: number; holidays: UpcomingHoliday[] }>(
    `/holidays/upcoming?days=${days}`,
  );

export const createHoliday = (input: {
  clientId?: string | null;
  name: string;
  date: string;
  type: HolidayType;
  state?: string | null;
  paid?: boolean;
  notes?: string | null;
}) => apiFetch<{ id: string }>('/holidays', { method: 'POST', body: input });

export const updateHoliday = (
  id: string,
  input: Partial<{
    name: string;
    paid: boolean;
    notes: string | null;
    state: string | null;
  }>,
) =>
  apiFetch<{ ok: true }>(`/holidays/${id}`, { method: 'PATCH', body: input });

export const deleteHoliday = (id: string) =>
  apiFetch<void>(`/holidays/${id}`, { method: 'DELETE' });

export const importUsFederalHolidays2026 = () =>
  apiFetch<{ inserted: number; skipped: number }>(
    '/holidays/import-us-federal-2026',
    { method: 'POST', body: {} },
  );
