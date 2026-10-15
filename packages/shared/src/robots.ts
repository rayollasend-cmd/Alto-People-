import { z } from 'zod';

/**
 * Brief 3-1 — Robot registry and fleet connectors.
 *
 * A robot is a Worker of type ROBOT. These are the shapes the API and the
 * web share for the robot's profile, its live status from the fleet
 * connector, the site's safety zones, the pre-shift checklist, the event
 * log, maintenance and incident evidence.
 */

export type RobotOwnership = 'OWNED' | 'LEASED';
export type RobotConnectorStatus = 'IDLE' | 'WORKING' | 'CHARGING' | 'ERROR' | 'OFFLINE' | 'STOPPED';
export type RobotEventKind = 'E_STOP' | 'RESUME' | 'ERROR' | 'SHIFT_STARTED' | 'SHIFT_ENDED' | 'CHECKLIST_COMPLETED' | 'COMMISSIONED' | 'MAINTENANCE';
export type RobotIncidentKind = 'NEAR_MISS' | 'INJURY' | 'PROPERTY_DAMAGE' | 'MALFUNCTION';
export type FleetProvider = 'SIMULATED' | 'BEAR' | 'PUDU';

export const FLEET_PROVIDERS: readonly { key: FleetProvider; label: string }[] = [
  { key: 'SIMULATED', label: 'Simulated fleet' },
  { key: 'BEAR', label: 'Bear Robotics' },
  { key: 'PUDU', label: 'Pudu Robotics' },
];

export const ROBOT_STATUS_LABELS: Record<RobotConnectorStatus, string> = {
  IDLE: 'Idle',
  WORKING: 'Working',
  CHARGING: 'Charging',
  ERROR: 'Error',
  OFFLINE: 'Offline',
  STOPPED: 'Stopped',
};

export const ROBOT_EVENT_LABELS: Record<RobotEventKind, string> = {
  E_STOP: 'Emergency stop',
  RESUME: 'Resumed',
  ERROR: 'Error',
  SHIFT_STARTED: 'Shift started',
  SHIFT_ENDED: 'Shift ended',
  CHECKLIST_COMPLETED: 'Checklist completed',
  COMMISSIONED: 'Commissioned',
  MAINTENANCE: 'Maintenance',
};

export const ROBOT_INCIDENT_LABELS: Record<RobotIncidentKind, string> = {
  NEAR_MISS: 'Near miss',
  INJURY: 'Injury',
  PROPERTY_DAMAGE: 'Property damage',
  MALFUNCTION: 'Malfunction',
};

export interface RobotCertification {
  name: string;
  issuedOn: string | null;
  expiresOn: string | null;
}

export interface RobotProfileSummary {
  manufacturer: string;
  model: string;
  serial: string;
  firmware: string | null;
  ownership: RobotOwnership;
  leaseEndsOn: string | null;
  connectorProvider: FleetProvider;
  connectorExternalId: string | null;
  certifications: RobotCertification[];
  notes: string | null;
}

export interface RobotStatusSampleSummary {
  at: string;
  status: RobotConnectorStatus;
  batteryPct: number | null;
  x: number | null;
  y: number | null;
  currentTask: string | null;
  errorCode: string | null;
}

export interface RobotEventSummary {
  id: string;
  kind: RobotEventKind;
  at: string;
  by: { id: string; name: string } | null;
  shiftId: string | null;
  note: string | null;
}

export interface ChargingStation {
  label: string;
  x: number;
  y: number;
}

export interface RobotCommissioningSummary {
  id: string;
  locationId: string;
  locationName: string;
  mapUrl: string | null;
  mapNotes: string | null;
  chargingStations: ChargingStation[];
  safetyLead: { id: string; name: string } | null;
  signedOffAt: string | null;
  notes: string | null;
}

export type ZoneShape = { type: 'rect'; x: number; y: number; w: number; h: number } | { type: 'polygon'; points: [number, number][] };

export interface SiteSafetyZoneSummary {
  id: string;
  locationId: string;
  name: string;
  shape: ZoneShape;
  guestOccupied: boolean;
  robotsAllowedWhenOccupied: boolean;
  occupiedSince: string | null;
}

export interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
}

export interface RobotChecklistTemplateSummary {
  id: string;
  locationId: string | null;
  name: string;
  items: ChecklistItem[];
  active: boolean;
}

export interface ChecklistAnswer {
  key: string;
  ok: boolean;
  note?: string | null;
}

export interface RobotChecklistRunSummary {
  id: string;
  shiftId: string | null;
  templateId: string;
  templateName: string;
  completedBy: { id: string; name: string };
  completedAt: string;
  answers: ChecklistAnswer[];
  allPassed: boolean;
}

export interface RobotMaintenanceSummary {
  id: string;
  performedOn: string;
  kind: string;
  description: string;
  performedBy: string | null;
  costCents: number | null;
  nextDueOn: string | null;
}

export interface RobotIncidentSummary {
  id: string;
  kind: RobotIncidentKind;
  occurredAt: string;
  description: string;
  locationId: string | null;
  locationName: string | null;
  reportedBy: { id: string; name: string } | null;
  oshaIncidentId: string | null;
  peopleOnShift: Array<{ associateId: string; name: string; shiftId: string }>;
  sampleCount: number;
  eventCount: number;
  retainUntil: string;
}

export interface RobotIncidentDetail extends RobotIncidentSummary {
  samples: RobotStatusSampleSummary[];
  events: RobotEventSummary[];
}

/** One row on the Robots page. */
export interface RobotRow {
  id: string;
  name: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDED';
  owner: { id: string; name: string } | null;
  capabilities: string[];
  profile: RobotProfileSummary | null;
  site: { id: string; name: string } | null;
  latest: RobotStatusSampleSummary | null;
  /** The commissioning at its current site is signed off. */
  commissioned: boolean;
  /** A passing checklist run in the last twelve hours. */
  checklistReady: boolean;
  openIncidents: number;
}

export interface RobotsResponse {
  robots: RobotRow[];
  counts: {
    total: number;
    working: number;
    charging: number;
    idle: number;
    errors: number;
    offline: number;
    stopped: number;
    avgBatteryPct: number | null;
  };
  provider: FleetProvider;
}

export interface RobotDetail extends RobotRow {
  notes: string | null;
  createdAt: string;
  commissionings: RobotCommissioningSummary[];
  recentEvents: RobotEventSummary[];
  upcomingShifts: Array<{ id: string; startsAt: string; endsAt: string; position: string; locationName: string | null; status: string; checklistDone: boolean }>;
}

/* ------------------------------------------------------------ input ---- */

const DateKey = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();

export const RobotProfileInputSchema = /* @__PURE__ */ (() =>
  z.object({
    manufacturer: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(80),
    serial: z.string().trim().min(1).max(120),
    firmware: z.string().trim().max(60).nullable().optional(),
    ownership: z.enum(['OWNED', 'LEASED']).optional(),
    leaseEndsOn: DateKey.nullable().optional(),
    connectorProvider: z.enum(['SIMULATED', 'BEAR', 'PUDU']).optional(),
    connectorExternalId: z.string().trim().max(120).nullable().optional(),
    certifications: z
      .array(z.object({ name: z.string().trim().min(1).max(120), issuedOn: DateKey.nullable().optional(), expiresOn: DateKey.nullable().optional() }))
      .max(50)
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  }))();
export type RobotProfileInput = z.infer<typeof RobotProfileInputSchema>;

export const ZoneShapeSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('rect'), x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
    z.object({ type: z.literal('polygon'), points: z.array(z.tuple([z.number(), z.number()])).min(3).max(64) }),
  ]))();

export const SafetyZoneInputSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string().trim().min(1).max(120),
    shape: ZoneShapeSchema,
    robotsAllowedWhenOccupied: z.boolean().optional(),
  }))();
export type SafetyZoneInput = z.infer<typeof SafetyZoneInputSchema>;

export const ZoneOccupiedInputSchema = /* @__PURE__ */ (() => z.object({ occupied: z.boolean() }))();

export const ChecklistTemplateInputSchema = /* @__PURE__ */ (() =>
  z.object({
    locationId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120),
    items: z.array(z.object({ key: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(200), required: z.boolean() })).min(1).max(40),
    active: z.boolean().optional(),
  }))();
export type ChecklistTemplateInput = z.infer<typeof ChecklistTemplateInputSchema>;

export const ChecklistRunInputSchema = /* @__PURE__ */ (() =>
  z.object({
    templateId: z.string().uuid(),
    shiftId: z.string().uuid().nullable().optional(),
    answers: z.array(z.object({ key: z.string().trim().min(1).max(60), ok: z.boolean(), note: z.string().trim().max(500).nullable().optional() })).min(1).max(40),
  }))();
export type ChecklistRunInput = z.infer<typeof ChecklistRunInputSchema>;

export const CommissioningInputSchema = /* @__PURE__ */ (() =>
  z.object({
    locationId: z.string().uuid(),
    mapUrl: z.string().trim().url().max(500).nullable().optional(),
    mapNotes: z.string().trim().max(2000).nullable().optional(),
    chargingStations: z.array(z.object({ label: z.string().trim().min(1).max(60), x: z.number(), y: z.number() })).max(20).optional(),
    safetyLeadUserId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  }))();
export type CommissioningInput = z.infer<typeof CommissioningInputSchema>;

export const MaintenanceInputSchema = /* @__PURE__ */ (() =>
  z.object({
    performedOn: DateKey,
    kind: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(2000),
    performedBy: z.string().trim().max(120).nullable().optional(),
    costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    nextDueOn: DateKey.nullable().optional(),
  }))();
export type MaintenanceInput = z.infer<typeof MaintenanceInputSchema>;

export const RobotIncidentInputSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum(['NEAR_MISS', 'INJURY', 'PROPERTY_DAMAGE', 'MALFUNCTION']),
    occurredAt: z.string().datetime({ offset: true }),
    description: z.string().trim().min(1).max(4000),
    locationId: z.string().uuid().nullable().optional(),
    /** For an injury at a client site: the OSHA severity the log needs. */
    oshaSeverity: z.enum(['FIRST_AID', 'MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY', 'FATAL']).optional(),
  }))();
export type RobotIncidentInput = z.infer<typeof RobotIncidentInputSchema>;

export const RobotStopInputSchema = /* @__PURE__ */ (() => z.object({ note: z.string().trim().max(500).nullable().optional() }))();
