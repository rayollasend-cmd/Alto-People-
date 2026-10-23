import type { RobotConnectorStatus, SiteSafetyZoneSummary } from './robots.js';
import type { SpanOfControl } from './tasks.js';

/**
 * Brief 3-3 — the control room: one screen per site of every worker on
 * shift (person, agent, robot), the exceptions, what waits for a person,
 * the safety zones with their occupancy and the span of control. Read
 * every 15 seconds; every action goes through the record's own API.
 */

export interface ControlRoomPerson {
  associateId: string;
  workerId: string | null;
  name: string;
  position: string;
  shiftId: string;
  shiftStart: string;
  shiftEnd: string;
  /** Punched in at the site right now. */
  clockedIn: boolean;
  clockInAt: string | null;
  /** The shift started more than fifteen minutes ago with no punch. */
  late: boolean;
  /** Counts toward the span of control. */
  crewLead: boolean;
}

export interface ControlRoomRobot {
  id: string;
  name: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDED';
  fleetStatus: RobotConnectorStatus | null;
  batteryPct: number | null;
  currentTask: string | null;
  x: number | null;
  y: number | null;
  readAt: string | null;
  onShift: boolean;
  shift: { id: string; startsAt: string; endsAt: string; position: string } | null;
  checklistReady: boolean;
  commissioned: boolean;
  openIncidents: number;
}

export interface ControlRoomAgent {
  id: string;
  name: string;
  family: string | null;
  capability: string | null;
  status: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDED';
  lastActiveAt: string | null;
  pendingApprovals: number;
}

export type ControlRoomExceptionKind = 'TASK_STALLED' | 'TASK_FAILED' | 'TASK_HANDED_OFF' | 'ROBOT_ERROR' | 'ROBOT_STOPPED' | 'ROBOT_OFFLINE' | 'UNCONFIRMED_SHIFT' | 'NO_SHOW' | 'ZONE_OCCUPIED';

export interface ControlRoomException {
  kind: ControlRoomExceptionKind;
  id: string;
  title: string;
  detail: string;
  at: string | null;
  link: string | null;
  taskId?: string;
  robotId?: string;
}

export type ControlRoomWaitingKind = 'AGENT_APPROVAL' | 'TASK_QUEUED';

export interface ControlRoomWaiting {
  kind: ControlRoomWaitingKind;
  id: string;
  title: string;
  detail: string;
  at: string;
  link: string;
}

export interface ControlRoomSite {
  id: string;
  name: string;
  timezone: string;
  clientName: string | null;
}

export interface ControlRoomResponse {
  site: ControlRoomSite;
  asOf: string;
  strip: {
    onFloor: number;
    expectedNow: number;
    robotsRunning: number;
    robotsOnShift: number;
    exceptions: number;
    waiting: number;
  };
  people: ControlRoomPerson[];
  robots: ControlRoomRobot[];
  agents: ControlRoomAgent[];
  exceptions: ControlRoomException[];
  waiting: ControlRoomWaiting[];
  zones: SiteSafetyZoneSummary[];
  span: SpanOfControl;
  /** This organization's agent switch is thrown. */
  agentsSuspended: boolean;
  /** The robotics module is on for this organization. */
  roboticsOn: boolean;
}

export interface ControlRoomSiteOption {
  id: string;
  name: string;
  clientName: string | null;
  timezone: string;
  /** People on an assigned shift there right now — the page opens on the
   *  busiest site when the viewer has none of their own (F500 G2). */
  onShiftNow?: number;
}
