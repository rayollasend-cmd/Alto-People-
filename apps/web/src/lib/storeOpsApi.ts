import { apiFetch } from './api';
import type { OpsHandoverKind, OpsPeriod, OpsPriority } from './opsApi';

/**
 * Store operations, one day — the store manager's and team leads' read of
 * every department's SOP (GET /client-portal/ops). Operations only: no
 * money anywhere in it.
 */

export type AttentionKind =
  | 'TEMP'
  | 'NOT_STARTED'
  | 'OVERDUE'
  | 'NOT_SUBMITTED'
  | 'BLOCKED'
  | 'EQUIPMENT'
  | 'COMPLIANCE'
  | 'INCOMPLETE';

export type BlockState = 'done' | 'late' | 'overdue' | 'open' | 'upcoming';

export interface StoreOpsBlock {
  section: string;
  dueAt: string;
  total: number;
  done: number;
  /** Items finished after the block was due. */
  late: number;
  state: BlockState;
  finishedAt: string | null;
}

export interface StoreOpsRun {
  id: string;
  department: string;
  period: OpsPeriod;
  windowLabel: string | null;
  storeName: string | null;
  templateName: string | null;
  status: 'ACTIVE' | 'CLOSED';
  runBy: string;
  openedAt: string;
  closedAt: string | null;
  dueAt: string | null;
  done: number;
  total: number;
  overdueItems: number;
  onTimePct: number | null;
  closedIncomplete: boolean;
  incompleteReason: string | null;
  summary: string | null;
  current: { section: string; dueAt: string; open: number } | null;
  blocks: StoreOpsBlock[];
  finalPhotoId: string | null;
}

export interface StoreOpsAttention {
  kind: AttentionKind;
  severity: 'high' | 'medium';
  shiftId: string | null;
  department: string;
  period: OpsPeriod;
  storeName: string | null;
  title: string;
  detail: string | null;
  at: string | null;
}

export interface StoreOpsTemp {
  taskId: string;
  shiftId: string;
  department: string;
  period: OpsPeriod;
  storeName: string | null;
  label: string;
  title: string;
  min: number | null;
  max: number | null;
  value: number | null;
  outOfRange: boolean;
  at: string | null;
  dueAt: string | null;
  recheck: { value: number | null; outOfRange: boolean; at: string | null } | null;
}

export interface StoreOpsMetric {
  key: string;
  label: string;
  unit: string | null;
  total: number;
  byDepartment: Record<string, number>;
}

export interface StoreOpsHandoff {
  id: string;
  shiftId: string;
  department: string;
  period: OpsPeriod;
  kind: OpsHandoverKind;
  body: string;
  priority: OpsPriority;
  status: 'PENDING' | 'CARRIED' | 'DISMISSED' | 'REVIEWED';
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface StoreOpsDay {
  scope: { client: { id: string; name: string }; location: { id: string; name: string } | null };
  date: string;
  tz: string;
  storeToday: string;
  summary: {
    sops: number;
    submitted: number;
    running: number;
    notStarted: number;
    completionPct: number | null;
    onTimePct: number | null;
    overdueBlocks: number;
    tempChecks: number;
    tempsDue: number;
    tempAlerts: number;
    tempOpen: number;
    needsAttention: number;
    photos: number;
  };
  periods: OpsPeriod[];
  grid: Array<{
    department: string;
    cells: Array<{
      period: OpsPeriod;
      runIds: string[];
      expected: Array<{ windowLabel: string; storeName: string; startsAt: string; endsAt: string; missed: boolean }>;
    }>;
  }>;
  runs: StoreOpsRun[];
  attention: StoreOpsAttention[];
  temps: StoreOpsTemp[];
  metrics: StoreOpsMetric[];
  handoffs: StoreOpsHandoff[];
  /** What the page is narrowed to right now, echoed back by the server. */
  filters: { period: OpsPeriod | null; department: string | null };
  /** Every department that ran that day — the department picker. */
  departments: string[];
  /** On the floor at this moment; null when reading a past day. */
  live: StoreOpsLive[] | null;
  /** The floor, photographed. Newest first. */
  photos: StoreOpsPhoto[];
}

/** A shift that is running right now. */
export interface StoreOpsLive {
  id: string;
  department: string;
  period: OpsPeriod;
  storeName: string | null;
  windowLabel: string | null;
  runBy: string;
  openedAt: string;
  dueAt: string | null;
  done: number;
  total: number;
  overdueItems: number;
  current: { section: string | null; dueAt: string; open: number } | null;
}

/** One photograph off the floor, and what it is of. */
export interface StoreOpsPhoto {
  id: string;
  at: string;
  title: string;
  section: string | null;
  shiftId: string;
  department: string | null;
  period: OpsPeriod | null;
  storeName: string | null;
}

/** `qs` carries the scope (?clientId= / ?locationId=) and ?date=. */
export function getStoreOps(qs: string): Promise<StoreOpsDay> {
  return apiFetch(`/client-portal/ops${qs}`);
}

export function storeOpsPhotoUrl(photoId: string, scopeQs: string): string {
  return `/api/client-portal/ops/photos/${photoId}${scopeQs}`;
}
