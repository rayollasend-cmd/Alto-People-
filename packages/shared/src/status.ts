import { z } from 'zod';

/**
 * The public status page (UX upgrade, beside the Trust Center): is the
 * platform up, component by component, with the incidents the team has
 * posted. The public shape carries states, percentages and the incident
 * timeline only; never a tenant, a route, an address or a count that
 * could identify a customer's traffic.
 */

export type StatusComponentKey = 'API' | 'WEB' | 'KIOSK' | 'MESSAGING' | 'PAYROLL_WEBHOOK' | 'EMAIL';

export const STATUS_COMPONENTS: readonly { key: StatusComponentKey; label: string; what: string }[] = [
  { key: 'API', label: 'Platform API', what: 'Every screen and integration talks to it.' },
  { key: 'WEB', label: 'Web app', what: 'The signed-in app on desktop and phone.' },
  { key: 'KIOSK', label: 'Kiosk clock-in', what: 'PIN and face punches on the worksite tablet.' },
  { key: 'MESSAGING', label: 'WhatsApp messaging', what: 'Shift confirmations, reminders and the assistant.' },
  { key: 'PAYROLL_WEBHOOK', label: 'Payroll disbursement', what: 'The provider’s confirmations that pay went out.' },
  { key: 'EMAIL', label: 'Email delivery', what: 'Invitations, reminders and alerts by email.' },
];

/** `UNMEASURED` is honest, never a zero: nothing in the window to grade. */
export type StatusState = 'OPERATIONAL' | 'DEGRADED' | 'OUTAGE' | 'UNMEASURED';

export type StatusImpact = 'DEGRADED' | 'OUTAGE';
export type StatusIncidentState = 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';

export interface StatusComponentPublic {
  key: StatusComponentKey;
  label: string;
  what: string;
  state: StatusState;
  /** One sentence on how the state was measured, or why it was not. */
  note: string;
  /** Percent of measured days in the last 90 without a bad day; null when the component has no daily measure. */
  uptime90d: number | null;
}

export interface StatusIncidentUpdatePublic {
  at: string;
  state: StatusIncidentState;
  note: string;
}

export interface StatusIncidentPublic {
  id: string;
  title: string;
  component: StatusComponentKey;
  impact: StatusImpact;
  state: StatusIncidentState;
  startedAt: string;
  resolvedAt: string | null;
  updates: StatusIncidentUpdatePublic[];
}

export interface PublicStatus {
  generatedAt: string;
  product: string;
  overall: StatusState;
  components: StatusComponentPublic[];
  /** Open incidents first, then the resolved ones of the last 90 days. */
  incidents: StatusIncidentPublic[];
}

export const STATUS_COMPONENT_KEYS = /* @__PURE__ */ (() =>
  ['API', 'WEB', 'KIOSK', 'MESSAGING', 'PAYROLL_WEBHOOK', 'EMAIL'] as const)();

export const StatusIncidentCreateSchema = /* @__PURE__ */ (() =>
  z.object({
    title: z.string().trim().min(3).max(160),
    component: z.enum(STATUS_COMPONENT_KEYS),
    impact: z.enum(['DEGRADED', 'OUTAGE']),
    state: z.enum(['INVESTIGATING', 'IDENTIFIED', 'MONITORING']).default('INVESTIGATING'),
    note: z.string().trim().min(3).max(2000),
    /** Defaults to now; an incident noticed late can be dated back. */
    startedAt: z.string().datetime().optional(),
  }))();
export type StatusIncidentCreate = z.infer<typeof StatusIncidentCreateSchema>;

export const StatusIncidentUpdateSchema = /* @__PURE__ */ (() =>
  z.object({
    state: z.enum(['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED']),
    note: z.string().trim().min(3).max(2000),
  }))();
export type StatusIncidentUpdateInput = z.infer<typeof StatusIncidentUpdateSchema>;

export const STATUS_STATE_LABELS: Record<StatusState, string> = {
  OPERATIONAL: 'Operational',
  DEGRADED: 'Degraded',
  OUTAGE: 'Outage',
  UNMEASURED: 'No recent activity',
};

export const STATUS_INCIDENT_STATE_LABELS: Record<StatusIncidentState, string> = {
  INVESTIGATING: 'Investigating',
  IDENTIFIED: 'Identified',
  MONITORING: 'Monitoring',
  RESOLVED: 'Resolved',
};
