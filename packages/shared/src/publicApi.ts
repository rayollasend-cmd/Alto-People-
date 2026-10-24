import { z } from 'zod';

/**
 * Brief 2-4 — the public /v1 API's scopes and the admin shapes for its
 * OAuth clients. A /v1 route declares the scopes it needs once; a client's
 * token must carry all of them.
 *
 * pay:read is off by default (a tenant admin grants it explicitly) and
 * clock-in coordinates never leave the API at all (owner's decision 4).
 */

export const API_SCOPES = [
  'workers:read',
  'workers:write',
  'workers:contact',
  'sites:read',
  'schedules:read',
  'schedules:write',
  'time:read',
  'documents:read',
  'programs:read',
  'agents:read',
  'webhooks:manage',
  'pay:read',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
// Pure: the web's main chunk ships this barrel and must drop what no first-paint page uses.
export const ApiScopeSchema = /* @__PURE__ */ (() => z.enum(API_SCOPES))();

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  'workers:read': 'Read workers',
  'workers:write': 'Create and update workers',
  'workers:contact': 'See workers’ email and phone',
  'sites:read': 'Read sites',
  'schedules:read': 'Read shifts',
  'schedules:write': 'Create, change, assign and cancel shifts',
  'time:read': 'Read time entries',
  'documents:read': 'Read document metadata (never the files)',
  'programs:read': 'Read J-1 and H-2B program dates',
  'agents:read': 'Read the agent registry',
  'webhooks:manage': 'Manage webhooks',
  'pay:read': 'Read pay rates (granted explicitly)',
};

export const ApiClientInputSchema = /* @__PURE__ */ (() =>
  z
    .object({
      name: z.string().trim().min(2).max(120),
      scopes: z.array(ApiScopeSchema).min(1),
      ownerUserId: z.string().uuid(),
      expiresAt: z.string().datetime().nullable().optional(),
    })
    .strict())();
export type ApiClientInput = z.infer<typeof ApiClientInputSchema>;

export interface ApiClientSummary {
  id: string;
  clientId: string;
  name: string;
  scopes: ApiScope[];
  owner: { id: string; name: string } | null;
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Shown once, at creation and at rotation. */
export interface ApiClientIssued {
  client: ApiClientSummary;
  clientSecret: string;
}

/**
 * Every outbound webhook event, one list for the Integrations page and the
 * API documentation (Brief 2-4). Payloads carry the /v1 public shapes,
 * never internal rows.
 */
export const WEBHOOK_EVENTS = [
  'shift.created',
  'shift.changed',
  'time_entry.approved',
  'worker.status_changed',
  'program.alert',
  'agent.approval_requested',
  'agent.approval_decided',
  'associate.hired',
  'associate.terminated',
  'time_off.requested',
  'time_off.approved',
  'time_off.denied',
  'position.opened',
  'position.filled',
  'payroll.finalized',
  'onboarding.completed',
  'compliance.expiring',
  'test.ping',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
