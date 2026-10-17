import { apiFetch } from './api';

/** People analytics (HR pack 2026-10): the canned reports (GET /people-analytics). */

export interface TurnoverGroup {
  key: string;
  label: string;
  separations: number;
  headcount: number;
  annualizedTurnoverPct: number | null;
}

export interface PeopleAnalytics {
  months: number;
  since: string;
  headcount: Array<{ month: string; headcount: number; hires: number; separations: number; voluntary: number; involuntary: number }>;
  turnover: {
    annualizedPct: number | null;
    separations: number;
    averageHeadcount: number;
    byTenure: Array<{ label: string; headcount: number; separations: number; annualizedTurnoverPct: number | null }>;
    bySite: TurnoverGroup[];
    byManager: TurnoverGroup[];
  };
  cohorts: Array<{ month: string; hires: number; s30: number | null; s60: number | null; s90: number | null; s180: number | null }>;
  timeToFill: {
    filled: number;
    medianDays: number | null;
    averageDays: number | null;
    byDepartment: Array<{ department: string; filled: number; medianDays: number | null; averageDays: number }>;
  };
  absence: {
    scheduledShiftDays: number;
    absenceDays: number;
    absenceRatePct: number | null;
    byCategory: Array<{ category: string; requests: number; days: number }>;
  };
}

export const getPeopleAnalytics = (months = 12) => apiFetch<PeopleAnalytics>(`/people-analytics?months=${months}`);
