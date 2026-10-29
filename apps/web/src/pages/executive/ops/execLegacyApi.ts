import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * The executive endpoints that came before the portal's contract
 * (packages/shared/src/executivePortal.ts) and still answer the "right now"
 * questions: the week summary (rates, the store league, placements,
 * attendance), the morning briefing (today's coverage, the six days ahead,
 * the seasonal capacity), the work moving between teams and the client
 * portal's use. Operations pulse, Scenarios and Risk read them; the shapes
 * are the API's (routes/executive.ts).
 */

export interface LegacyWeek {
  start: string;
  end: string;
  workedHours: number;
  otHours: number;
  /** What the overtime multipliers add, in straight-time hours. */
  premiumHours?: number;
  headsWorked: number;
  estBilled: number;
  estLaborCost: number;
  estMargin: number;
}

export interface LegacySummary {
  generatedAt: string;
  trend: LegacyWeek[];
  rates: { payRate: number; billRate: number; burdenPct: number; overheadPerHour: number };
  league: Array<{ clientId: string; clientName: string; locationId: string; locationName: string; hours: number; otHours: number; estBilled: number; estMargin: number }>;
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>;
  attendance30d: Array<{ kind: string; count: number }>;
}

export interface LegacyBriefing {
  generatedAt: string;
  /** The company time zone "today" is read in (newer APIs). */
  timezone?: string;
  today: {
    dateKey: string;
    shiftsTotal: number;
    shiftsAssigned: number;
    shiftsOpen: number;
    openShifts: Array<{ clientName: string; locationName: string | null; position: string; startsAt: string; count: number }>;
    estBilledToday: number;
    incidents: Array<{ kind: string; associateName: string; clientName: string | null }>;
  };
  outlook: Array<{ dateKey: string; published: number; assigned: number; open: number }>;
  capacity: {
    bench: number;
    funnel: { inFlight: number; approved30d: number };
    j1Active: number;
    /** "YYYY-MM" → how many J-1 documents run out that month. */
    j1Cliff: Array<{ month: string; count: number }>;
  };
}

export interface LegacyBatons {
  generatedAt: string;
  batons: {
    fieldglass: { closeOuts: number; transfers: number; adds: number };
    readyToSchedule: number;
    unapprovedTimesheets: number;
    payrollCasesOpen: number;
    incidentsOpen: number;
  };
}

export interface LegacyPortalEngagement {
  accounts: Array<{
    id: string;
    email: string;
    status: string;
    scope: string;
    clientId: string | null;
    lastSeenAt: string | null;
    signIns7d: number;
    downloads: Array<{ at: string; from: string; to: string }>;
  }>;
  totals: { accounts: number; active7d: number; neverSignedIn: number; downloads7d: number };
}

export const legacyKeys = {
  summary: ['executive', 'legacy', 'summary'] as const,
  briefing: ['executive', 'legacy', 'briefing'] as const,
  batons: ['executive', 'legacy', 'batons'] as const,
  engagement: ['executive', 'legacy', 'portal-engagement'] as const,
};

export function useLegacySummary() {
  return useQuery({ queryKey: legacyKeys.summary, queryFn: () => apiFetch<LegacySummary>('/executive/summary'), staleTime: 60_000 });
}

export function useLegacyBriefing() {
  return useQuery({ queryKey: legacyKeys.briefing, queryFn: () => apiFetch<LegacyBriefing>('/executive/briefing'), staleTime: 60_000 });
}

export function useLegacyBatons() {
  return useQuery({ queryKey: legacyKeys.batons, queryFn: () => apiFetch<LegacyBatons>('/executive/batons'), staleTime: 60_000 });
}

export function useLegacyPortalEngagement(enabled: boolean) {
  return useQuery({ queryKey: legacyKeys.engagement, queryFn: () => apiFetch<LegacyPortalEngagement>('/executive/portal-engagement'), staleTime: 60_000, enabled });
}
