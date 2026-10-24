import { z } from 'zod';

/**
 * Brief 3-5: HR and VMS integrations — the shapes the API and the web
 * share. One adapter interface, five vendors, a per-tenant field mapping,
 * scheduled and event-driven sync, and a sync log the tenant admin reads.
 */

export const INTEGRATION_VENDORS = ['FIELDGLASS', 'ADP', 'WORKDAY', 'UKG', 'BEELINE'] as const;
export type IntegrationVendor = (typeof INTEGRATION_VENDORS)[number];

export const INTEGRATION_CAPABILITIES = [
  'pullWorkers',
  'pushWorkers',
  'pullSchedules',
  'pushSchedules',
  'pushTimesheets',
  'pushPayrollExport',
  'pullWorkOrders',
] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

export const INTEGRATION_CAPABILITY_LABELS: Record<IntegrationCapability, string> = {
  pullWorkers: 'Pull workers',
  pushWorkers: 'Push workers',
  pullSchedules: 'Pull schedules',
  pushSchedules: 'Push schedules',
  pushTimesheets: 'Submit timesheets',
  pushPayrollExport: 'Export payroll',
  pullWorkOrders: 'Pull work orders',
};

/** A pull reads the vendor into Alto; a push writes Alto's records out. */
export function capabilityDirection(c: IntegrationCapability): 'PULL' | 'PUSH' {
  return c.startsWith('pull') ? 'PULL' : 'PUSH';
}

export type IntegrationConnectionStatus = 'CONNECTED' | 'PAUSED' | 'ERROR';
export type IntegrationSyncStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

/** The mapping groups a vendor's fields are arranged in. */
export type IntegrationMappingGroup = 'worker' | 'schedule' | 'timesheet' | 'payroll' | 'workOrder';
/** { group: { altoField: vendorField } } */
export type IntegrationMapping = Partial<Record<IntegrationMappingGroup, Record<string, string>>>;

export interface IntegrationVendorInfo {
  vendor: IntegrationVendor;
  label: string;
  /** What the vendor is to a customer, in one line. */
  what: string;
  capabilities: IntegrationCapability[];
  /** The credential fields the live connection needs; each is a secret. */
  credentialFields: Array<{ key: string; label: string; secret: boolean }>;
  /** The vendor's default mapping; a tenant overrides field by field. */
  defaultMapping: IntegrationMapping;
  /** One line on the vendor API this adapter speaks, for the admin who sets it up. */
  apiNote: string;
}

export interface IntegrationSyncRunSummary {
  id: string;
  capability: IntegrationCapability;
  direction: 'PULL' | 'PUSH';
  status: IntegrationSyncStatus;
  trigger: string;
  eventType: string | null;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  succeeded: number;
  failed: number;
  summary: Record<string, unknown> | null;
}

export interface IntegrationConnectionSummary {
  id: string;
  vendor: IntegrationVendor;
  name: string;
  status: IntegrationConnectionStatus;
  sandbox: boolean;
  /** Whether live credentials are on file (never the credentials). */
  hasCredentials: boolean;
  capabilities: IntegrationCapability[];
  mapping: IntegrationMapping;
  scheduleMinutes: number | null;
  eventDriven: boolean;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastError: string | null;
  /** Errors across the last ten runs. */
  recentErrors: number;
  lastRun: IntegrationSyncRunSummary | null;
  createdAt: string;
}

export interface IntegrationSyncErrorRow {
  id: string;
  recordRef: string;
  message: string;
  excerpt: Record<string, unknown> | null;
  createdAt: string;
}

const MappingSchema = /* @__PURE__ */ (() =>
  z.partialRecord(z.enum(['worker', 'schedule', 'timesheet', 'payroll', 'workOrder']), z.record(z.string().min(1).max(80), z.string().min(1).max(120))))();

export const IntegrationConnectionCreateSchema = /* @__PURE__ */ (() =>
  z.object({
    vendor: z.enum(INTEGRATION_VENDORS),
    name: z.string().trim().min(1).max(120),
    sandbox: z.boolean().default(true),
    credentials: z.record(z.string().min(1).max(60), z.string().max(4000)).optional(),
    mapping: MappingSchema.optional(),
    capabilities: z.array(z.enum(INTEGRATION_CAPABILITIES)).max(7).optional(),
    scheduleMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
    eventDriven: z.boolean().optional(),
  }))();
export type IntegrationConnectionCreateInput = z.infer<typeof IntegrationConnectionCreateSchema>;

export const IntegrationConnectionPatchSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['CONNECTED', 'PAUSED']).optional(),
    sandbox: z.boolean().optional(),
    /** Replaces every credential; omit to keep what is on file. */
    credentials: z.record(z.string().min(1).max(60), z.string().max(4000)).optional(),
    mapping: MappingSchema.optional(),
    capabilities: z.array(z.enum(INTEGRATION_CAPABILITIES)).max(7).optional(),
    scheduleMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
    eventDriven: z.boolean().optional(),
  }))();
export type IntegrationConnectionPatchInput = z.infer<typeof IntegrationConnectionPatchSchema>;

export const IntegrationSyncRequestSchema = /* @__PURE__ */ (() =>
  z.object({
    capability: z.enum(INTEGRATION_CAPABILITIES),
    /** For timesheets and payroll: the period to send (YYYY-MM-DD). Defaults to the last closed period. */
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** For payroll export: the run to export. */
    payrollRunId: z.string().uuid().optional(),
  }))();
export type IntegrationSyncRequestInput = z.infer<typeof IntegrationSyncRequestSchema>;
