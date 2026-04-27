import { apiFetch } from './api';

export interface HeadcountSnapshot {
  total: number;
  byDepartment: { departmentId: string | null; departmentName: string; count: number }[];
  byClient: { clientId: string; clientName: string; count: number }[];
  byEmploymentType: { employmentType: string; count: number }[];
}

export interface TurnoverSummary {
  days: number;
  hires: number;
  terminations: number;
  netChange: number;
  annualizedTurnoverRate: number;
  currentActive: number;
}

export const getHeadcountSnapshot = () =>
  apiFetch<HeadcountSnapshot>('/headcount/snapshot');

export const getTurnover = (days: number) =>
  apiFetch<TurnoverSummary>(`/headcount/turnover?days=${days}`);
