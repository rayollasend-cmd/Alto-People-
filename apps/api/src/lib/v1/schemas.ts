// define.ts extends zod with .openapi(); it must run before these schemas are built.
import './define.js';
import { z } from 'zod';
import { WEBHOOK_EVENTS } from '@alto-people/shared';

/**
 * Brief 2-4 — the public shapes of /v1 (report §5.3). Never the internal
 * schemas: every field here was chosen, and the excluded ones (SSN, date of
 * birth, address, bank, tax, pay rates without pay:read, clock-in
 * coordinates ever, document files and numbers, SEVIS / DS-2019 / visa /
 * passport numbers, billing data, geofences) have no field to land in.
 * defineRoute parses every response through these, so anything else is
 * stripped on the way out.
 */

const id = z.string().uuid();
const ts = z.string().datetime().nullable();

export const WorkerSchema = z
  .object({
    id,
    type: z.enum(['PERSON', 'AGENT', 'ROBOT']),
    name: z.string(),
    status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED']),
    /** The accountable owner of an agent or robot. */
    owner: z.object({ id, name: z.string() }).nullable(),
    employmentType: z.enum(['W2_EMPLOYEE', 'CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS']).nullable(),
    siteId: id.nullable(),
    hireDate: z.string().date().nullable(),
    separatedAt: ts,
    /** Only under workers:contact. */
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
    /** An agent's or robot's capabilities. */
    capabilities: z.array(z.string()),
  })
  .openapi('Worker');

export const SiteSchema = z
  .object({
    id,
    name: z.string(),
    type: z.enum(['STORE', 'PROPERTY', 'OFFICE', 'WAREHOUSE', 'OTHER']),
    timezone: z.string(),
    state: z.string().nullable(),
    orgUnitId: id.nullable(),
    active: z.boolean(),
  })
  .openapi('Site');

export const ShiftSchema = z
  .object({
    id,
    siteId: id.nullable(),
    position: z.string(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    timezone: z.string(),
    status: z.enum(['DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED']),
    assignedWorkerId: id.nullable(),
    publishedAt: ts,
    acknowledgedAt: ts,
    /** Only under pay:read. */
    payRate: z.number().nullable().optional(),
  })
  .openapi('Shift');

export const TimeEntrySchema = z
  .object({
    id,
    workerId: id.nullable(),
    siteId: id.nullable(),
    shiftId: id.nullable(),
    clockInAt: z.string().datetime(),
    clockOutAt: ts,
    status: z.enum(['ACTIVE', 'COMPLETED', 'APPROVED', 'REJECTED']),
    netMinutes: z.number().int().nullable(),
    breaks: z.array(z.object({ startedAt: z.string().datetime(), endedAt: ts })),
    approvedAt: ts,
    /** Only under pay:read. Clock-in coordinates are never exposed. */
    payRate: z.number().nullable().optional(),
  })
  .openapi('TimeEntry');

export const DocumentSchema = z
  .object({
    id,
    workerId: id.nullable(),
    kind: z.string(),
    status: z.enum(['UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED']),
    expiresAt: ts,
    uploadedAt: z.string().datetime(),
    verifiedAt: ts,
  })
  .openapi('Document');

export const ProgramSchema = z
  .object({
    id,
    workerId: id.nullable(),
    type: z.enum(['J1_SWT', 'H2B', 'DOMESTIC']),
    sponsorName: z.string().nullable(),
    programStart: z.string().date(),
    programEnd: z.string().date(),
    status: z.enum(['UPCOMING', 'ACTIVE', 'ENDED', 'CLOSED']),
  })
  .openapi('Program');

export const AgentSchema = z
  .object({
    id,
    name: z.string(),
    status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED']),
    owner: z.object({ id, name: z.string() }).nullable(),
    family: z.string().nullable(),
    purpose: z.string().nullable(),
    scopes: z.array(z.string()),
    capabilities: z.array(z.object({ key: z.string(), enabled: z.boolean(), suspended: z.boolean() })),
  })
  .openapi('Agent');

export const TokenRequestSchema = z.object({
  grant_type: z.literal('client_credentials'),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
});

export const TokenResponseSchema = z
  .object({ access_token: z.string(), token_type: z.literal('Bearer'), expires_in: z.number().int(), scope: z.string() })
  .openapi('Token');

export const WorkerCreateSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(40).nullable().optional(),
    siteId: id,
    employmentType: z.enum(['W2_EMPLOYEE', 'CONTRACTOR_1099_INDIVIDUAL', 'CONTRACTOR_1099_BUSINESS']).optional(),
    hireDate: z.string().date().nullable().optional(),
  })
  .strict()
  .openapi('WorkerCreate', { description: 'No SSN, bank, tax or date of birth is accepted here: those are collected in onboarding, by the person.' });

export const WorkerUpdateSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    status: z.literal('INACTIVE').optional(),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .strict()
  .openapi('WorkerUpdate', { description: 'status INACTIVE deactivates the person (released from future shifts, login disabled) and needs a reason. Reactivation is done in the app.' });

export const ShiftCreateSchema = z
  .object({
    siteId: id,
    position: z.string().trim().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    publish: z.boolean().default(false),
    lateNoticeReason: z.string().trim().min(3).max(500).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .openapi('ShiftCreate');

export const ShiftUpdateSchema = z
  .object({
    position: z.string().trim().min(1).max(120).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  })
  .strict()
  .openapi('ShiftUpdate', { description: 'Changes a draft (unpublished) shift. A published shift is changed in the app, where the notice rules and the people on it are handled.' });

export const ShiftAssignSchema = z.object({ workerId: id }).strict().openapi('ShiftAssign');
export const ShiftCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict().openapi('ShiftCancel');

/* Webhooks (scope webhooks:manage). The signing secret is shown once, at create. */
const WebhookEventSchema = z.enum(WEBHOOK_EVENTS);

export const WebhookSchema = z
  .object({
    id,
    name: z.string(),
    url: z.string(),
    events: z.array(WebhookEventSchema).openapi({ description: 'Empty: every event.' }),
    active: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('Webhook');

export const WebhookCreatedSchema = WebhookSchema.extend({
  secret: z.string().openapi({ description: 'The signing secret. Shown once; store it. Verify Alto-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">.' }),
}).openapi('WebhookCreated');

export const WebhookCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().url().max(2000),
    events: z.array(WebhookEventSchema).max(50).default([]),
  })
  .strict()
  .openapi('WebhookCreate', { description: 'https only, and a publicly routable host.' });

export const WebhookUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: z.string().url().max(2000).optional(),
    events: z.array(WebhookEventSchema).max(50).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .openapi('WebhookUpdate');

export const WebhookDeliverySchema = z
  .object({
    id,
    event: z.string(),
    status: z.enum(['PENDING', 'RETRYING', 'DELIVERED', 'FAILED']),
    attempts: z.number().int(),
    responseStatus: z.number().int().nullable(),
    lastAttemptAt: ts,
    deliveredAt: ts,
    createdAt: z.string().datetime(),
  })
  .openapi('WebhookDelivery');

export const DeliveryParams = z.object({ id, deliveryId: id });
