import { z } from 'zod';

/**
 * Brief 3-2: work as tasks, each assigned to a person, an agent or a robot.
 *
 * A Task is one unit of work at one site with a time window and a required
 * capability (from the worker capability catalog, WORKER_CAPABILITIES). The
 * assignment engine ranks every eligible worker and records WHY — every
 * assignment carries its ranking factors — so a supervisor can read the
 * decision, and a robot's or agent's stall hands the task to a named person
 * within the policy's seconds.
 */

export const WORK_TASK_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type WorkTaskRisk = (typeof WORK_TASK_RISKS)[number];

export const WORK_TASK_STATUSES = ['OPEN', 'QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'STALLED', 'FAILED', 'HANDED_OFF', 'DONE', 'CANCELLED'] as const;
export type WorkTaskStatus = (typeof WORK_TASK_STATUSES)[number];

export const WORK_TASK_EVENT_KINDS = ['ASSIGNED', 'QUEUED', 'STARTED', 'STALLED', 'FAILED', 'HANDED_OFF', 'DONE', 'CANCELLED'] as const;
export type WorkTaskEventKind = (typeof WORK_TASK_EVENT_KINDS)[number];

export const WORK_TASK_STATUS_LABELS: Record<WorkTaskStatus, string> = {
  OPEN: 'Open',
  QUEUED: 'Waiting for a person',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  STALLED: 'Stalled',
  FAILED: 'Failed',
  HANDED_OFF: 'Handed off',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

export const WORK_TASK_RISK_LABELS: Record<WorkTaskRisk, string> = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk' };

/** High-risk work: a person, or a robot a person on shift supervises. */
export const WORK_TASK_HIGH_RISK_POLICIES = ['PERSON_ONLY', 'PERSON_OR_SUPERVISED_ROBOT'] as const;
export type WorkTaskHighRiskPolicy = (typeof WORK_TASK_HIGH_RISK_POLICIES)[number];

/** The factors the engine scores. Each assignment lists every factor it weighed. */
export type AssignmentFactor = 'capability' | 'availability' | 'risk' | 'cost' | 'load' | 'battery' | 'handoff';

export interface AssignmentReason {
  factor: AssignmentFactor;
  /** Points this factor contributed (negative when it counted against). */
  points: number;
  /** One line a supervisor can read: "On shift 2:00–10:00 PM, free in the window". */
  note: string;
}

export interface RankedCandidate {
  workerId: string;
  workerType: 'PERSON' | 'AGENT' | 'ROBOT';
  name: string;
  eligible: boolean;
  /** Higher wins; equal scores break on cost, then name. */
  score: number;
  costCents: number;
  reasons: AssignmentReason[];
}

export const WorkTaskCreateSchema = /* @__PURE__ */ (() =>
  z.object({
    type: z.string().trim().min(2).max(80),
    locationId: z.string().uuid(),
    /** Where inside the site: "Dock 3", "Ballroom B", "Rooms 210–240". */
    area: z.string().trim().max(120).optional().nullable(),
    windowStart: z.string().datetime({ offset: true }),
    windowEnd: z.string().datetime({ offset: true }),
    /** A WORKER_CAPABILITIES code. */
    capability: z.string().trim().min(2).max(60),
    risk: z.enum(WORK_TASK_RISKS).default('LOW'),
    estimatedMinutes: z.number().int().min(5).max(24 * 60),
    /** The client's own reference: a truck number, a banquet, a room list. */
    reference: z.string().trim().max(160).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
  }))();
export type WorkTaskCreate = z.infer<typeof WorkTaskCreateSchema>;

export const WorkTaskEventCreateSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum(['STARTED', 'STALLED', 'FAILED', 'DONE', 'CANCELLED']),
    note: z.string().trim().max(2000).optional().nullable(),
  }))();
export type WorkTaskEventCreate = z.infer<typeof WorkTaskEventCreateSchema>;

export const WorkTaskAssignSchema = /* @__PURE__ */ (() =>
  z.object({
    workerId: z.string().uuid(),
    note: z.string().trim().max(500).optional().nullable(),
  }))();
export type WorkTaskAssignInput = z.infer<typeof WorkTaskAssignSchema>;

export const WorkTaskPolicyUpdateSchema = /* @__PURE__ */ (() =>
  z.object({
    /** Seconds a stalled or failed robot or agent task waits before a person gets it. */
    handoffSeconds: z.number().int().min(5).max(900).optional(),
    /** The engine assigns on its own up to this cost; dearer work queues for a person. Null = no cap. */
    maxAutoAssignCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
    highRiskPolicy: z.enum(WORK_TASK_HIGH_RISK_POLICIES).optional(),
    /** Cents per task for a robot, by capability code; the default applies to the rest. */
    robotCostPerTaskCents: z.record(z.string(), z.number().int().min(0).max(1_000_000)).optional(),
    robotDefaultCostCents: z.number().int().min(0).max(1_000_000).optional(),
    agentCostPerTaskCents: z.number().int().min(0).max(1_000_000).optional(),
    /** Brief 3-3 reads it; stored here so the two briefs share one policy row. */
    maxRobotsPerCrewLead: z.number().int().min(1).max(50).optional(),
    /** Brief 3-3: share of a robot's shift it can spend on tasks (the planner's capacity). */
    robotUtilizationPct: z.number().int().min(1).max(100).optional(),
    /** Brief 3-3: standby people per robot minute, as a percent (25 = one standby shift per four robot shifts). */
    backupCrewRatioPct: z.number().int().min(0).max(100).optional(),
  }))();
export type WorkTaskPolicyUpdate = z.infer<typeof WorkTaskPolicyUpdateSchema>;

export interface WorkTaskPolicyView {
  locationId: string | null;
  handoffSeconds: number;
  maxAutoAssignCents: number | null;
  highRiskPolicy: WorkTaskHighRiskPolicy;
  robotCostPerTaskCents: Record<string, number>;
  robotDefaultCostCents: number;
  agentCostPerTaskCents: number;
  maxRobotsPerCrewLead: number;
  robotUtilizationPct: number;
  backupCrewRatioPct: number;
}

export const DEFAULT_WORK_TASK_POLICY: WorkTaskPolicyView = {
  locationId: null,
  handoffSeconds: 30,
  maxAutoAssignCents: null,
  highRiskPolicy: 'PERSON_OR_SUPERVISED_ROBOT',
  robotCostPerTaskCents: {},
  robotDefaultCostCents: 400,
  agentCostPerTaskCents: 0,
  maxRobotsPerCrewLead: 4,
  robotUtilizationPct: 70,
  backupCrewRatioPct: 25,
};

export interface WorkTaskAssignmentView {
  id: string;
  workerId: string;
  workerType: 'PERSON' | 'AGENT' | 'ROBOT';
  workerName: string;
  state: 'ACTIVE' | 'RELEASED';
  /** Who or what decided: the engine, a person, or the handoff. */
  decidedBy: 'ENGINE' | 'PERSON' | 'HANDOFF';
  decidedByUserId: string | null;
  score: number;
  costCents: number;
  reasons: AssignmentReason[];
  /** Every candidate the engine weighed, best first (the explanation). */
  ranking: RankedCandidate[];
  createdAt: string;
  releasedAt: string | null;
}

export interface WorkTaskEventView {
  id: string;
  kind: WorkTaskEventKind;
  at: string;
  note: string | null;
  byUserId: string | null;
  workerId: string | null;
}

export interface WorkTaskView {
  id: string;
  type: string;
  locationId: string;
  locationName: string;
  area: string | null;
  windowStart: string;
  windowEnd: string;
  capability: string;
  risk: WorkTaskRisk;
  estimatedMinutes: number;
  reference: string | null;
  notes: string | null;
  status: WorkTaskStatus;
  assignment: WorkTaskAssignmentView | null;
  /** Why the engine could not assign on its own (QUEUED), in one line. */
  queuedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkTaskDetailView extends WorkTaskView {
  events: WorkTaskEventView[];
  /** Earlier assignments, newest first (a handed-off robot's, for instance). */
  history: WorkTaskAssignmentView[];
}

export interface WorkTaskSummary {
  open: number;
  queued: number;
  assigned: number;
  inProgress: number;
  exceptions: number;
  doneToday: number;
}

/* ------------------------------------------------------- Brief 3-3 */

/** Span of control at a site: robots on shift against the crew leads on the floor. */
export interface SpanOfControl {
  robots: number;
  leads: number;
  maxPerLead: number;
  allowed: number;
  exceeded: boolean;
  text: string;
}

/** The hybrid mix the planner proposes for one site-week from its task demand. */
export interface SeasonWeekMix {
  taskMinutes: number;
  robotMinutes: number;
  personMinutes: number;
  robotTasks: number;
  personTasks: number;
  /** Robots the robot minutes need at the policy's utilisation. */
  robotsNeeded: number;
  robotCapacityMinutes: number;
  /** People the person minutes need at the plan's hours per week. */
  peopleNeeded: number;
  /** Standby shifts a robot-dependent week needs. */
  backupCrew: number;
  laborCostCents: number;
  robotCostCents: number;
  totalCostCents: number;
}
