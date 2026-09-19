import { apiFetch } from '@/lib/api';

/** The three desks every handoff moves between. */
export type Desk = 'HR' | 'FINANCE' | 'WORKFORCE';
export const DESKS: Desk[] = ['HR', 'WORKFORCE', 'FINANCE'];

export type StageKey = 'approved' | 'scheduled' | 'fieldglass' | 'firstShift' | 'hoursApproved' | 'paycheck';

export interface LaneStage {
  key: StageKey;
  desk: Desk;
  done: boolean;
  at: string | null;
  dueAt: string | null;
  overdue: boolean;
}

export interface Lane {
  associateId: string;
  name: string;
  clientName: string | null;
  approvedAt: string;
  stages: LaneStage[];
  currentStage: StageKey | null;
  stalled: boolean;
  completed: boolean;
  cohortId: string | null;
  /** Notes in this person's thread. */
  notes?: number;
}

export interface CohortSummary {
  id: string;
  name: string;
  clientName: string | null;
  targetHeadcount: number;
  landByDate: string;
  daysLeft: number;
  members: number;
  completed: number;
  inFlight: number;
  stalled: number;
}

export interface Baton {
  key: string;
  label: string;
  desk: Desk;
  count: number;
  oldestAt: string | null;
  dueOn: string | null;
  status: 'quiet' | 'atRisk' | 'overdue';
  link: string;
}

export interface AgendaItem {
  severity: 'red' | 'amber' | 'info';
  desk: Desk | null;
  text: string;
  link: string;
}

/** Someone on a desk — the names on the relay. */
export interface DeskPerson {
  userId: string;
  name: string;
  photoUrl: string | null;
}

/** Who holds a lane, a baton or a client request. */
export interface Claim {
  userId: string;
  name: string;
  photoUrl: string | null;
  claimedAt: string;
  claimedByName: string | null;
}

export type ClaimSubject = 'LANE' | 'BATON' | 'REQUEST';
export const claimKey = (type: ClaimSubject, key: string) => `${type}:${key}`;

export interface RelayBoardData {
  generatedAt: string;
  promise: { keptPct: number | null; completed: number; medianDays: number | null; windowDays: number };
  lanes: Lane[];
  cohorts: CohortSummary[];
  recentKept: Array<{ associateId: string; name: string; days: number; kept: boolean }>;
  batons: Baton[];
  agenda: AgendaItem[];
  /** The people on each desk. */
  desks?: Record<Desk, DeskPerson[]>;
  /** Who holds what, keyed `${type}:${key}`. */
  claims?: Record<string, Claim>;
  /** The viewer — and the desk they answer for. */
  me?: { userId: string; desk: Desk | null };
}

export interface ClientRequestRow {
  id: string;
  clientId: string;
  clientName: string;
  kind: 'STAFFING' | 'FEEDBACK' | 'ISSUE' | 'BILLING';
  desk: Desk;
  subject: string;
  body: string;
  status: 'RECEIVED' | 'IN_PROGRESS';
  createdAt: string;
  dueAt: string | null;
  overdue: boolean;
  associateId: string | null;
  associateName: string | null;
}

export interface ActivityNote {
  id: string;
  body: string;
  mentions: Desk[];
  createdAt: string;
  author: { name: string; photoUrl: string | null } | null;
  subject: { associateId: string; name: string };
  decisionDesk: Desk | null;
  decisionStatus: 'PENDING' | 'APPROVED' | 'DECLINED' | null;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
}

export interface RelayActivity {
  /** Rulings still owed, oldest first. */
  decisions: ActivityNote[];
  /** The latest on every thread, newest first. */
  notes: ActivityNote[];
}

export const DESK_LABELS: Record<Desk, string> = { HR: 'HR', FINANCE: 'Finance', WORKFORCE: 'Workforce' };

/** Each desk's color, everywhere it appears. */
export const DESK_CHIP: Record<Desk, string> = {
  HR: 'bg-steel/20 text-sky',
  FINANCE: 'bg-gold/15 text-gold',
  WORKFORCE: 'bg-success/15 text-success',
};
export const DESK_BAR: Record<Desk, string> = { HR: 'bg-sky', FINANCE: 'bg-gold', WORKFORCE: 'bg-success' };
export const DESK_RING: Record<Desk, string> = { HR: 'ring-sky/60', FINANCE: 'ring-gold/60', WORKFORCE: 'ring-success/60' };

export const STAGE_LABELS: Record<StageKey, string> = {
  approved: 'Approved',
  scheduled: 'Scheduled',
  fieldglass: 'Fieldglass',
  firstShift: 'First shift',
  hoursApproved: 'Hours approved',
  paycheck: 'First paycheck',
};

/** What moves a lane off its current stage, and where. */
export const STAGE_ACTION: Record<StageKey, { label: string; to: (associateId: string) => string } | null> = {
  approved: null,
  scheduled: { label: 'Schedule their first shift', to: () => '/scheduling' },
  fieldglass: { label: 'Register them in Fieldglass', to: () => '/fieldglass' },
  firstShift: { label: 'See their shift', to: () => '/scheduling' },
  hoursApproved: { label: 'Approve their hours', to: () => '/time-attendance' },
  paycheck: { label: 'Open payroll', to: () => '/payroll' },
};

/** Which desk a role answers for. */
export function deskOf(role: string | undefined | null): Desk | null {
  if (role === 'FINANCE_ACCOUNTANT') return 'FINANCE';
  if (role === 'WORKFORCE_MANAGER') return 'WORKFORCE';
  if (role === 'HR_ADMINISTRATOR' || role === 'OPERATIONS_MANAGER') return 'HR';
  return null;
}

export const relayApi = {
  board: () => apiFetch<RelayBoardData>('/relay/board'),
  activity: () => apiFetch<RelayActivity>('/relay/activity'),
  requests: () => apiFetch<{ requests: ClientRequestRow[] }>('/client-requests'),
  claim: (subjectType: ClaimSubject, subjectKey: string, userId?: string) =>
    apiFetch<{ claim: Claim }>('/relay/claims', { method: 'POST', body: { subjectType, subjectKey, ...(userId ? { userId } : {}) } }),
  release: (subjectType: ClaimSubject, subjectKey: string) =>
    apiFetch<{ ok: true }>(`/relay/claims?subjectType=${subjectType}&subjectKey=${encodeURIComponent(subjectKey)}`, { method: 'DELETE' }),
  decide: (noteId: string, approve: boolean, note: string) =>
    apiFetch<{ ok: true }>(`/work-notes/${noteId}/decide`, { method: 'POST', body: { approve, note } }),
};
