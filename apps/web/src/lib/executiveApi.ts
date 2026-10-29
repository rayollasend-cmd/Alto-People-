import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EXEC_COMPARE_KEYS,
  EXEC_PERIOD_KEYS,
  type ExecClients,
  type ExecCompareKey,
  type ExecFinancials,
  type ExecOverview,
  type ExecPeople,
  type ExecPeriodKey,
  type ExecRisks,
} from '@alto-people/shared';
import { apiFetch } from '@/lib/api';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * The executive portal's data (2026-10-27). One frame for every page — a
 * period read against a comparison — kept in the URL (?period=&compare=), so
 * a drill-down opens on the same frame, Back returns to it and a link sends
 * it. The clean URL is the default: the quarter to date against the prior
 * quarter's same days. Shapes: packages/shared/src/executivePortal.ts.
 */

export const EXEC_DEFAULT_PERIOD: ExecPeriodKey = 'quarter';
export const EXEC_DEFAULT_COMPARE: ExecCompareKey = 'prior';

export interface ExecFrame {
  period: ExecPeriodKey;
  compare: ExecCompareKey;
  setPeriod: (p: ExecPeriodKey) => void;
  setCompare: (c: ExecCompareKey) => void;
  /** "period=quarter&compare=prior" — always both, for the API. */
  query: string;
}

export function useExecFrame(): ExecFrame {
  const [period, setPeriod] = useUrlParam<ExecPeriodKey>('period', EXEC_DEFAULT_PERIOD, EXEC_PERIOD_KEYS);
  const [compare, setCompare] = useUrlParam<ExecCompareKey>('compare', EXEC_DEFAULT_COMPARE, EXEC_COMPARE_KEYS);
  return { period, compare, setPeriod, setCompare, query: `period=${period}&compare=${compare}` };
}

/** Whether a path is read in the executive frame: the executive home and the /executive pages. */
export function readsExecFrame(path: string): boolean {
  const p = path.split(/[?#]/)[0]!;
  return p === '/' || p === '' || p === '/executive' || p.startsWith('/executive/');
}

/**
 * A drill-down link that keeps the frame (defaults left out, so the clean
 * URL stays clean). Only pages that read the frame get it: a client's
 * record, the leave desk or the books keep their own windows, so a
 * `?period=month` on them would only promise a frame they don't honour.
 */
export function execHref(path: string, frame: Pick<ExecFrame, 'period' | 'compare'>): string {
  if (!readsExecFrame(path)) return path;
  const q = new URLSearchParams();
  if (frame.period !== EXEC_DEFAULT_PERIOD) q.set('period', frame.period);
  if (frame.compare !== EXEC_DEFAULT_COMPARE) q.set('compare', frame.compare);
  const s = q.toString();
  if (!s) return path;
  const hashAt = path.indexOf('#');
  const base = hashAt >= 0 ? path.slice(0, hashAt) : path;
  const hash = hashAt >= 0 ? path.slice(hashAt) : '';
  return `${base}${base.includes('?') ? '&' : '?'}${s}${hash}`;
}

export const execKeys = {
  all: ['executive'] as const,
  overview: (q: string) => ['executive', 'overview', q] as const,
  financials: (q: string) => ['executive', 'financials', q] as const,
  clients: (q: string) => ['executive', 'clients', q] as const,
  people: (q: string) => ['executive', 'people', q] as const,
  risks: () => ['executive', 'risks'] as const,
  targets: () => ['executive', 'targets'] as const,
};

const FRAME_QUERY = { staleTime: 60_000, placeholderData: keepPreviousData } as const;

export function useExecOverview(frame: Pick<ExecFrame, 'query'>) {
  return useQuery({ queryKey: execKeys.overview(frame.query), queryFn: () => apiFetch<ExecOverview>(`/executive/overview?${frame.query}`), ...FRAME_QUERY });
}

export function useExecFinancials(frame: Pick<ExecFrame, 'query'>) {
  return useQuery({ queryKey: execKeys.financials(frame.query), queryFn: () => apiFetch<ExecFinancials>(`/executive/financials?${frame.query}`), ...FRAME_QUERY });
}

export function useExecClients(frame: Pick<ExecFrame, 'query'>) {
  return useQuery({ queryKey: execKeys.clients(frame.query), queryFn: () => apiFetch<ExecClients>(`/executive/clients?${frame.query}`), ...FRAME_QUERY });
}

export function useExecPeople(frame: Pick<ExecFrame, 'query'>) {
  return useQuery({ queryKey: execKeys.people(frame.query), queryFn: () => apiFetch<ExecPeople>(`/executive/people?${frame.query}`), ...FRAME_QUERY });
}

export function useExecRisks() {
  return useQuery({ queryKey: execKeys.risks(), queryFn: () => apiFetch<ExecRisks>('/executive/risks'), staleTime: 60_000 });
}

/** GET /executive/targets — the current quarter's plan and its quarter-to-date actuals. */
export interface ExecTargetsResponse {
  quarter: string;
  elapsedPct: number;
  targets: {
    revenueTarget: number | null;
    marginTarget: number | null;
    headcountTarget: number | null;
    turnoverPctTarget: number | null;
    fillRatePctTarget: number | null;
  } | null;
  actuals: {
    revenueQtd: number;
    marginQtd: number;
    headcount: number;
    turnoverAnnualizedPct: number;
    fillRatePct: number | null;
  };
}

export type ExecTargetsInput = { quarter: string } & Partial<NonNullable<ExecTargetsResponse['targets']>>;

export function useExecTargets() {
  return useQuery({ queryKey: execKeys.targets(), queryFn: () => apiFetch<ExecTargetsResponse>('/executive/targets'), staleTime: 60_000 });
}

/** PUT /executive/targets — the chairman (set:exec-targets) or an admin (manage:org) sets the quarter's plan. */
export function useSetExecTargets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ExecTargetsInput) => apiFetch<{ ok: true }>('/executive/targets', { method: 'PUT', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: execKeys.all }),
  });
}

/** The board pack for a frame — a link, so the browser downloads it. */
export function boardPackUrl(frame: Pick<ExecFrame, 'period' | 'compare'>): string {
  return `/api/executive/board-pack.pdf?period=${frame.period}&compare=${frame.compare}`;
}
