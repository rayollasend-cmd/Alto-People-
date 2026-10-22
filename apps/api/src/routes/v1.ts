import express, { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { WEBHOOK_EVENTS, type ApiScope, type TenantModule, type WebhookEvent } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { issueToken } from '../lib/apiClients.js';
import { enqueueAudit, recordShiftEvent } from '../lib/audit.js';
import { executeDeactivation } from '../lib/deactivation.js';
import { assignWithinRules } from '../lib/shiftAssign.js';
import { assertSaneShiftDuration, cancelShiftWithinRules, createShiftWithinRules } from '../lib/shiftCreate.js';
import { assertSafeOutboundUrl } from '../lib/safeOutboundUrl.js';
import { newWebhookSecret, sealWebhookSecret } from '../lib/webhookSecrets.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { moduleOn } from '../lib/tenantProfile.js';
import { ensureWorkerForAssociate, syncPersonWorkerStatus } from '../lib/workers.js';
import { IdParams, PageQuery, defineRoute, page, toPage, v1OpenApiDocument } from '../lib/v1/define.js';
import { ENTRY_PUBLIC_INCLUDE, SHIFT_PUBLIC_INCLUDE, entryPublic, shiftPublic, type PublicEntryRow, type PublicShiftRow } from '../lib/v1/mappers.js';
import {
  AgentSchema,
  DeliveryParams,
  DocumentSchema,
  ProgramSchema,
  ShiftAssignSchema,
  ShiftCancelSchema,
  ShiftCreateSchema,
  ShiftSchema,
  ShiftUpdateSchema,
  SiteSchema,
  TimeEntrySchema,
  TokenRequestSchema,
  TokenResponseSchema,
  WebhookCreateSchema,
  WebhookCreatedSchema,
  WebhookDeliverySchema,
  WebhookSchema,
  WebhookUpdateSchema,
  WorkerCreateSchema,
  WorkerSchema,
  WorkerUpdateSchema,
} from '../lib/v1/schemas.js';

/**
 * Brief 2-4 — the public API, /v1 (docs/public-api-investigation.md, every
 * decision approved 2026-10-13).
 *
 *   OAuth 2 client credentials (lib/apiClients), 15-minute tokens, scopes
 *   per route, cursor pagination, Idempotency-Key on every POST, 600 req/min
 *   per client and 3,000 per tenant. Every route is declared once through
 *   defineRoute, which mounts it and registers it in the generated OpenAPI
 *   document at /v1/openapi.json. Reads filter the client's tenant
 *   explicitly; a resource whose module is off answers 404. Writes go
 *   through the same domain code as the app (lib/shiftCreate, shiftAssign,
 *   deactivation, workers) and are audited under the client with its named
 *   owner. /integrations/v1 stays as it is for the ASN bridge.
 */

export const v1Router = Router();
v1Router.use(express.urlencoded({ extended: false, limit: '16kb' }));

const has = (req: Request, scope: ApiScope) => !!req.apiClient?.scopes.includes(scope);
const client = (req: Request) => req.apiClient!;

async function needModule(module: TenantModule): Promise<void> {
  if (!(await moduleOn(module, tenantIdForWrite()))) throw new HttpError(404, 'not_found', 'Not found.');
}

const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const ownerName = (o: { email: string; associate: { firstName: string; lastName: string } | null } | null) =>
  o ? (o.associate ? `${o.associate.firstName} ${o.associate.lastName}` : o.email) : null;

/* ---------------------------------------------------------------- token */

defineRoute(v1Router, {
  method: 'post',
  path: '/oauth/token',
  scopes: null,
  tag: 'Authentication',
  summary: 'Trade client credentials for a 15-minute bearer token',
  description: 'grant_type=client_credentials, with the client id and secret as HTTP Basic or as form/JSON fields. The token carries the client’s scopes and tenant.',
  body: TokenRequestSchema,
  response: TokenResponseSchema,
  status: 200,
  handler: async ({ req, body }) => {
    let id = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic\s+(\S+)$/i.exec(req.header('authorization') ?? '');
    if (basic) {
      const [u, p] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    if (!id || !secret) throw new HttpError(401, 'invalid_client', 'Client credentials are required.');
    const token = await issueToken(prisma, id, secret);
    if (!token) throw new HttpError(401, 'invalid_client', 'The client credentials are invalid, revoked or expired.');
    return token;
  },
});

v1Router.get('/openapi.json', (_req, res) => {
  res.json(v1OpenApiDocument());
});

/* -------------------------------------------------------------- workers */

const WORKER_INCLUDE = {
  owner: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  associate: {
    select: {
      email: true,
      phone: true,
      employmentType: true,
      hireDate: true,
      separatedAt: true,
      assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' as const }, take: 1, select: { locationId: true } },
    },
  },
} satisfies Prisma.WorkerInclude;

type WorkerRow = Prisma.WorkerGetPayload<{ include: typeof WORKER_INCLUDE }>;

function workerOut(req: Request, w: WorkerRow) {
  const person = w.type === 'PERSON';
  return {
    id: w.id,
    type: w.type,
    name: w.name,
    status: w.status,
    owner: person ? null : { id: w.owner.id, name: ownerName(w.owner)! },
    employmentType: w.associate?.employmentType ?? null,
    siteId: w.associate?.assignments[0]?.locationId ?? null,
    hireDate: dateOnly(w.associate?.hireDate),
    separatedAt: isoOrNull(w.associate?.separatedAt),
    ...(person && has(req, 'workers:contact') ? { email: w.associate?.email ?? null, phone: w.associate?.phone ?? null } : {}),
    capabilities: person ? [] : w.capabilities,
  };
}

defineRoute(v1Router, {
  method: 'get',
  path: '/workers',
  scopes: ['workers:read'],
  tag: 'Workers',
  summary: 'List workers: people, agents and robots',
  description: 'Email and phone appear only with workers:contact. No SSN, date of birth, address, bank, tax or pay data, ever.',
  query: PageQuery.extend({ type: z.enum(['PERSON', 'AGENT', 'ROBOT']).optional(), status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED']).optional() }),
  response: page(WorkerSchema),
  handler: async ({ req, query }) => {
    const rows = await prisma.worker.findMany({
      where: { tenantId: tenantIdForWrite(), ...(query.type ? { type: query.type } : {}), ...(query.status ? { status: query.status } : {}) },
      include: WORKER_INCLUDE,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map((w) => workerOut(req, w)), nextCursor: p.nextCursor };
  },
});

async function findWorker(id: string): Promise<WorkerRow> {
  const w = await prisma.worker.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: WORKER_INCLUDE });
  if (!w) throw new HttpError(404, 'worker_not_found', 'Worker not found.');
  return w;
}

defineRoute(v1Router, {
  method: 'get',
  path: '/workers/:id',
  scopes: ['workers:read'],
  tag: 'Workers',
  summary: 'One worker',
  params: IdParams,
  response: WorkerSchema,
  handler: async ({ req, params }) => workerOut(req, await findWorker(params.id)),
});

defineRoute(v1Router, {
  method: 'post',
  path: '/workers',
  scopes: ['workers:write'],
  tag: 'Workers',
  summary: 'Add a person, placed at a site',
  description: 'Creates the person and their worker record, placed at the site. Onboarding (identity, tax, I-9) is done by the person in the app; nothing sensitive is accepted here.',
  body: WorkerCreateSchema,
  response: WorkerSchema,
  handler: async ({ req, body }) => {
    const tenantId = tenantIdForWrite();
    const site = await prisma.site.findFirst({ where: { id: body.siteId, tenantId, deletedAt: null, isActive: true }, select: { id: true } });
    if (!site) throw new HttpError(404, 'site_not_found', 'Site not found.');
    if (await prisma.associate.findUnique({ where: { tenantId_email: { tenantId, email: body.email } }, select: { id: true } })) {
      throw new HttpError(409, 'worker_exists', 'Someone with this email is already on file.');
    }
    const workerId = await prisma.$transaction(async (tx) => {
      const a = await tx.associate.create({
        data: {
          tenantId,
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone ?? null,
          ...(body.employmentType ? { employmentType: body.employmentType } : {}),
          hireDate: body.hireDate ? new Date(`${body.hireDate}T00:00:00Z`) : null,
        },
        select: { id: true },
      });
      // Every person is a PERSON worker; the client's accountable owner owns it.
      const wid = await ensureWorkerForAssociate(tx, a.id, client(req).ownerUserId);
      await tx.associateAssignment.create({ data: { tenantId, associateId: a.id, locationId: site.id, startedAt: body.hireDate ? new Date(`${body.hireDate}T00:00:00Z`) : new Date(), reason: 'Added through the API' } });
      return { associateId: a.id, workerId: wid! };
    });
    enqueueAudit({ actorUserId: null, apiClientId: client(req).id, clientId: null, workerId: workerId.workerId, action: 'worker.created', entityType: 'Associate', entityId: workerId.associateId, metadata: { siteId: site.id, ownerUserId: client(req).ownerUserId, via: 'api' } }, 'v1');
    return workerOut(req, await findWorker(workerId.workerId));
  },
});

defineRoute(v1Router, {
  method: 'patch',
  path: '/workers/:id',
  scopes: ['workers:write'],
  tag: 'Workers',
  summary: 'Change a person’s name or phone, or deactivate them',
  params: IdParams,
  body: WorkerUpdateSchema,
  response: WorkerSchema,
  handler: async ({ req, params, body }) => {
    const w = await findWorker(params.id);
    if (w.type !== 'PERSON' || !w.associateId) throw new HttpError(400, 'not_a_person', 'Only a person can be changed here; agents and robots are managed in the app.');
    const changes: Prisma.AssociateUpdateInput = {
      ...(body.firstName ? { firstName: body.firstName } : {}),
      ...(body.lastName ? { lastName: body.lastName } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
    };
    if (Object.keys(changes).length) {
      const a = await prisma.associate.update({ where: { id: w.associateId }, data: changes, select: { firstName: true, lastName: true } });
      await prisma.worker.update({ where: { id: w.id }, data: { name: `${a.firstName} ${a.lastName}`.trim().slice(0, 160) } });
      enqueueAudit({ actorUserId: null, apiClientId: client(req).id, clientId: null, workerId: w.id, action: 'worker.updated', entityType: 'Associate', entityId: w.associateId, metadata: { fields: Object.keys(changes), via: 'api' } }, 'v1');
    }
    if (body.status === 'INACTIVE') {
      if (!body.reason) throw new HttpError(400, 'reason_required', 'Deactivating someone needs a reason.');
      const a = await prisma.associate.findUnique({ where: { id: w.associateId }, select: { deactivatedAt: true, separatedAt: true } });
      if (a?.deactivatedAt || a?.separatedAt) throw new HttpError(409, 'already_inactive', 'This person is already inactive.');
      await executeDeactivation(prisma, { associateId: w.associateId, byUserId: null, reason: `${body.reason} (through the API: ${client(req).name})` });
      await syncPersonWorkerStatus(prisma, w.associateId);
      enqueueAudit({ actorUserId: null, apiClientId: client(req).id, clientId: null, workerId: w.id, action: 'associate.deactivated', entityType: 'Associate', entityId: w.associateId, metadata: { reason: body.reason, ownerUserId: client(req).ownerUserId, via: 'api' } }, 'v1');
    }
    return workerOut(req, await findWorker(w.id));
  },
});

/* ---------------------------------------------------------------- sites */

const siteOut = (s: { id: string; name: string; type: 'STORE' | 'PROPERTY' | 'OFFICE' | 'WAREHOUSE' | 'OTHER'; timezone: string; state: string | null; orgUnitId: string | null; isActive: boolean }) => ({
  id: s.id,
  name: s.name,
  type: s.type,
  timezone: s.timezone,
  state: s.state,
  orgUnitId: s.orgUnitId,
  active: s.isActive,
});
const SITE_SELECT = { id: true, name: true, type: true, timezone: true, state: true, orgUnitId: true, isActive: true } as const;

defineRoute(v1Router, {
  method: 'get',
  path: '/sites',
  scopes: ['sites:read'],
  tag: 'Sites',
  summary: 'List sites',
  query: PageQuery,
  response: page(SiteSchema),
  handler: async ({ query }) => {
    const rows = await prisma.site.findMany({ where: { tenantId: tenantIdForWrite(), deletedAt: null }, select: SITE_SELECT, orderBy: { id: 'asc' }, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(siteOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/sites/:id',
  scopes: ['sites:read'],
  tag: 'Sites',
  summary: 'One site',
  params: IdParams,
  response: SiteSchema,
  handler: async ({ params }) => {
    const s = await prisma.site.findFirst({ where: { id: params.id, tenantId: tenantIdForWrite(), deletedAt: null }, select: SITE_SELECT });
    if (!s) throw new HttpError(404, 'site_not_found', 'Site not found.');
    return siteOut(s);
  },
});

/* --------------------------------------------------------------- shifts */

const SHIFT_V1_INCLUDE = SHIFT_PUBLIC_INCLUDE;
type ShiftRow = PublicShiftRow;
const shiftOut = (req: Request, s: ShiftRow) => shiftPublic(s, { pay: has(req, 'pay:read') });

async function findShift(id: string): Promise<ShiftRow> {
  const s = await prisma.shift.findFirst({ where: { id, tenantId: tenantIdForWrite() }, include: SHIFT_V1_INCLUDE });
  if (!s) throw new HttpError(404, 'shift_not_found', 'Shift not found.');
  return s;
}

defineRoute(v1Router, {
  method: 'get',
  path: '/shifts',
  scopes: ['schedules:read'],
  tag: 'Schedules',
  summary: 'List shifts in a window (at most 62 days)',
  description: 'Pay rates only with pay:read.',
  query: PageQuery.extend({
    siteId: z.string().uuid().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.enum(['DRAFT', 'OPEN', 'ASSIGNED', 'COMPLETED', 'CANCELLED']).optional(),
  }),
  response: page(ShiftSchema),
  handler: async ({ req, query }) => {
    await needModule('scheduling');
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 86_400_000);
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + 14 * 86_400_000);
    if (to <= from || to.getTime() - from.getTime() > 62 * 86_400_000) throw new HttpError(400, 'invalid_window', 'from must precede to, at most 62 days apart.');
    const rows = await prisma.shift.findMany({
      where: { tenantId: tenantIdForWrite(), startsAt: { gte: from, lt: to }, ...(query.siteId ? { locationId: query.siteId } : {}), ...(query.status ? { status: query.status } : {}) },
      include: SHIFT_V1_INCLUDE,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map((s) => shiftOut(req, s)), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/shifts/:id',
  scopes: ['schedules:read'],
  tag: 'Schedules',
  summary: 'One shift',
  params: IdParams,
  response: ShiftSchema,
  handler: async ({ req, params }) => {
    await needModule('scheduling');
    return shiftOut(req, await findShift(params.id));
  },
});

defineRoute(v1Router, {
  method: 'post',
  path: '/shifts',
  scopes: ['schedules:write'],
  tag: 'Schedules',
  summary: 'Create a shift at a site',
  description: 'The schedule’s own rules apply (lib/shiftCreate): the site decides the client, no shift spans more than 16 hours, and publishing inside a fair-workweek notice window needs lateNoticeReason. publish=false leaves a draft.',
  body: ShiftCreateSchema,
  response: ShiftSchema,
  handler: async ({ req, body }) => {
    await needModule('scheduling');
    const site = await prisma.site.findFirst({ where: { id: body.siteId, tenantId: tenantIdForWrite(), deletedAt: null }, select: { id: true, clientId: true } });
    if (!site) throw new HttpError(404, 'site_not_found', 'Site not found.');
    const created = await createShiftWithinRules(
      prisma,
      { clientId: site.clientId, locationId: site.id, position: body.position, startsAt: body.startsAt, endsAt: body.endsAt, status: body.publish ? 'OPEN' : 'DRAFT', lateNoticeReason: body.lateNoticeReason ?? null, notes: body.notes ?? null },
      { userId: null, apiClientId: client(req).id, hideBillRate: true, req },
      SHIFT_V1_INCLUDE,
    );
    return shiftOut(req, created);
  },
});

defineRoute(v1Router, {
  method: 'patch',
  path: '/shifts/:id',
  scopes: ['schedules:write'],
  tag: 'Schedules',
  summary: 'Change a draft shift',
  params: IdParams,
  body: ShiftUpdateSchema,
  response: ShiftSchema,
  handler: async ({ req, params, body }) => {
    await needModule('scheduling');
    const s = await findShift(params.id);
    if (s.status !== 'DRAFT') throw new HttpError(409, 'published_shift', 'A published shift is changed in the app, where its notice rules and the people on it are handled.');
    const startsAt = body.startsAt ? new Date(body.startsAt) : s.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : s.endsAt;
    if (endsAt <= startsAt) throw new HttpError(400, 'invalid_times', 'A shift ends after it starts.');
    assertSaneShiftDuration(startsAt, endsAt);
    await prisma.shift.update({ where: { id: s.id }, data: { ...(body.position ? { position: body.position } : {}), startsAt, endsAt } });
    await recordShiftEvent({ actorUserId: null, apiClientId: client(req).id, action: 'shift.updated', shiftId: s.id, clientId: s.clientId, metadata: { fields: Object.keys(body), via: 'api' }, req });
    return shiftOut(req, await findShift(s.id));
  },
});

defineRoute(v1Router, {
  method: 'post',
  path: '/shifts/:id/assign',
  scopes: ['schedules:write'],
  tag: 'Schedules',
  summary: 'Assign a person to a shift',
  description: 'The supervisor’s rules apply (lib/shiftAssign): no overlap, no approved time off or declared day off, the rest gap, the H-2B petition’s client.',
  params: IdParams,
  body: ShiftAssignSchema,
  response: ShiftSchema,
  status: 200,
  handler: async ({ req, params, body }) => {
    await needModule('scheduling');
    const s = await findShift(params.id);
    if (s.status === 'CANCELLED' || s.status === 'COMPLETED') throw new HttpError(409, 'shift_closed', `Cannot assign a ${s.status.toLowerCase()} shift.`);
    const w = await prisma.worker.findFirst({ where: { id: body.workerId, tenantId: tenantIdForWrite(), type: 'PERSON' }, select: { associateId: true } });
    const associate = w?.associateId ? await prisma.associate.findFirst({ where: { id: w.associateId, deletedAt: null } }) : null;
    if (!associate) throw new HttpError(404, 'worker_not_found', 'Worker not found.');
    await assignWithinRules(prisma, s, associate, { actorUserId: null, via: 'api_client' });
    await recordShiftEvent({ actorUserId: null, apiClientId: client(req).id, action: 'shift.assigned', shiftId: s.id, clientId: s.clientId, metadata: { associateId: associate.id, via: 'api' }, req });
    return shiftOut(req, await findShift(s.id));
  },
});

defineRoute(v1Router, {
  method: 'post',
  path: '/shifts/:id/cancel',
  scopes: ['schedules:write'],
  tag: 'Schedules',
  summary: 'Cancel a shift',
  description: 'As in the app: live swaps close and the person on a published shift is told.',
  params: IdParams,
  body: ShiftCancelSchema,
  response: ShiftSchema,
  status: 200,
  handler: async ({ req, params, body }) => {
    await needModule('scheduling');
    const s = await findShift(params.id);
    if (s.status === 'COMPLETED') throw new HttpError(409, 'shift_completed', 'Cannot cancel a completed shift.');
    if (s.status === 'CANCELLED') return shiftOut(req, s);
    const updated = await cancelShiftWithinRules(prisma, s, body.reason, { userId: null, apiClientId: client(req).id, req }, SHIFT_V1_INCLUDE);
    return shiftOut(req, updated);
  },
});

/* --------------------------------------------------------- time entries */

const ENTRY_INCLUDE = ENTRY_PUBLIC_INCLUDE;
const entryOut = (req: Request, e: PublicEntryRow) => entryPublic(e, { pay: has(req, 'pay:read') });

defineRoute(v1Router, {
  method: 'get',
  path: '/time-entries',
  scopes: ['time:read'],
  tag: 'Time',
  summary: 'List time entries',
  description: 'Clock-in and clock-out coordinates are never exposed; pay rates only with pay:read.',
  query: PageQuery.extend({
    workerId: z.string().uuid().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    status: z.enum(['ACTIVE', 'COMPLETED', 'APPROVED', 'REJECTED']).optional(),
  }),
  response: page(TimeEntrySchema),
  handler: async ({ req, query }) => {
    await needModule('time');
    let associateId: string | undefined;
    if (query.workerId) {
      const w = await prisma.worker.findFirst({ where: { id: query.workerId, tenantId: tenantIdForWrite() }, select: { associateId: true } });
      if (!w?.associateId) return { data: [], nextCursor: null };
      associateId = w.associateId;
    }
    const rows = await prisma.timeEntry.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        ...(associateId ? { associateId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to ? { clockInAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } : {}),
      },
      include: ENTRY_INCLUDE,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map((e) => entryOut(req, e)), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/time-entries/:id',
  scopes: ['time:read'],
  tag: 'Time',
  summary: 'One time entry',
  params: IdParams,
  response: TimeEntrySchema,
  handler: async ({ req, params }) => {
    await needModule('time');
    const e = await prisma.timeEntry.findFirst({ where: { id: params.id, tenantId: tenantIdForWrite() }, include: ENTRY_INCLUDE });
    if (!e) throw new HttpError(404, 'time_entry_not_found', 'Time entry not found.');
    return entryOut(req, e);
  },
});

/* ------------------------------------------------------------ documents */

/** I-9, E-Verify, W-4 and SSN-card kinds are never listed (owner's decision 5). */
const HIDDEN_KINDS = ['I9_SUPPORTING', 'I9_VERIFICATION_RESULT', 'W4_PDF', 'SSN_CARD'] as const;
const DOC_SELECT = { id: true, associateId: true, kind: true, status: true, expiresAt: true, createdAt: true, verifiedAt: true, associate: { select: { worker: { select: { id: true } } } } } as const;
type DocRow = Prisma.DocumentRecordGetPayload<{ select: typeof DOC_SELECT }>;
const docOut = (d: DocRow) => ({ id: d.id, workerId: d.associate?.worker?.id ?? null, kind: d.kind, status: d.status, expiresAt: isoOrNull(d.expiresAt), uploadedAt: d.createdAt.toISOString(), verifiedAt: isoOrNull(d.verifiedAt) });

defineRoute(v1Router, {
  method: 'get',
  path: '/workers/:id/documents',
  scopes: ['documents:read'],
  tag: 'Documents',
  summary: 'A worker’s documents: kind, status and dates only',
  description: 'Never the file, a download link, the filename or any number on it. I-9, E-Verify, W-4 and SSN-card documents are not listed.',
  params: IdParams,
  query: PageQuery,
  response: page(DocumentSchema),
  handler: async ({ params, query }) => {
    const w = await findWorker(params.id);
    if (!w.associateId) return { data: [], nextCursor: null };
    const rows = await prisma.documentRecord.findMany({
      where: { tenantId: tenantIdForWrite(), associateId: w.associateId, deletedAt: null, kind: { notIn: [...HIDDEN_KINDS] } },
      select: DOC_SELECT,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(docOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/documents/:id',
  scopes: ['documents:read'],
  tag: 'Documents',
  summary: 'One document’s metadata',
  params: IdParams,
  response: DocumentSchema,
  handler: async ({ params }) => {
    const d = await prisma.documentRecord.findFirst({ where: { id: params.id, tenantId: tenantIdForWrite(), deletedAt: null, kind: { notIn: [...HIDDEN_KINDS] } }, select: DOC_SELECT });
    if (!d) throw new HttpError(404, 'document_not_found', 'Document not found.');
    return docOut(d);
  },
});

/* ------------------------------------------------------------- programs */

const PROGRAM_SELECT = { id: true, type: true, programStart: true, programEnd: true, closedAt: true, sponsor: { select: { name: true } }, associate: { select: { worker: { select: { id: true } } } } } as const;
type ProgramRow = Prisma.ProgramGetPayload<{ select: typeof PROGRAM_SELECT }>;
function programOut(p: ProgramRow) {
  const now = new Date();
  const status: 'CLOSED' | 'UPCOMING' | 'ENDED' | 'ACTIVE' = p.closedAt ? 'CLOSED' : p.programStart > now ? 'UPCOMING' : p.programEnd < now ? 'ENDED' : 'ACTIVE';
  return { id: p.id, workerId: p.associate.worker?.id ?? null, type: p.type, sponsorName: p.sponsor?.name ?? null, programStart: dateOnly(p.programStart)!, programEnd: dateOnly(p.programEnd)!, status };
}

defineRoute(v1Router, {
  method: 'get',
  path: '/programs',
  scopes: ['programs:read'],
  tag: 'Programs',
  summary: 'J-1 and H-2B programs: type, sponsor and dates only',
  description: 'Never SEVIS, DS-2019, visa or passport numbers, nor country or notes.',
  query: PageQuery.extend({ type: z.enum(['J1_SWT', 'H2B', 'DOMESTIC']).optional() }),
  response: page(ProgramSchema),
  handler: async ({ query }) => {
    await needModule('programs');
    const rows = await prisma.program.findMany({ where: { tenantId: tenantIdForWrite(), ...(query.type ? { type: query.type } : {}) }, select: PROGRAM_SELECT, orderBy: { id: 'asc' }, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(programOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/programs/:id',
  scopes: ['programs:read'],
  tag: 'Programs',
  summary: 'One program',
  params: IdParams,
  response: ProgramSchema,
  handler: async ({ params }) => {
    await needModule('programs');
    const p = await prisma.program.findFirst({ where: { id: params.id, tenantId: tenantIdForWrite() }, select: PROGRAM_SELECT });
    if (!p) throw new HttpError(404, 'program_not_found', 'Program not found.');
    return programOut(p);
  },
});

/* --------------------------------------------------------------- agents */

const AGENT_INCLUDE = {
  owner: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } },
  agent: { select: { family: true, purpose: true, scopes: true, agentCapabilities: { select: { key: true, enabled: true, suspendedAt: true } } } },
} as const;

defineRoute(v1Router, {
  method: 'get',
  path: '/agents',
  scopes: ['agents:read'],
  tag: 'Agents',
  summary: 'The agent registry: profile, owner, status, scopes, capabilities',
  description: 'Never credentials or spend detail.',
  query: PageQuery,
  response: page(AgentSchema),
  handler: async ({ query }) => {
    const rows = await prisma.worker.findMany({ where: { tenantId: tenantIdForWrite(), type: 'AGENT' }, include: AGENT_INCLUDE, orderBy: { id: 'asc' }, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(agentOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'get',
  path: '/agents/:id',
  scopes: ['agents:read'],
  tag: 'Agents',
  summary: 'One agent',
  params: IdParams,
  response: AgentSchema,
  handler: async ({ params }) => {
    const w = await prisma.worker.findFirst({ where: { id: params.id, tenantId: tenantIdForWrite(), type: 'AGENT' }, include: AGENT_INCLUDE });
    if (!w) throw new HttpError(404, 'agent_not_found', 'Agent not found.');
    return agentOut(w);
  },
});

function agentOut(w: Prisma.WorkerGetPayload<{ include: typeof AGENT_INCLUDE }>) {
  return {
    id: w.id,
    name: w.name,
    status: w.status,
    owner: { id: w.owner.id, name: ownerName(w.owner)! },
    family: w.agent?.family ?? null,
    purpose: w.agent?.purpose ?? null,
    scopes: w.agent?.scopes ?? [],
    capabilities: (w.agent?.agentCapabilities ?? []).map((c) => ({ key: c.key, enabled: c.enabled, suspended: !!c.suspendedAt })),
  };
}

/* ------------------------------------------------------------- webhooks */

/** Webhooks made here are the tenant's, like the ones made on the Integrations page; both lists show both. */
async function ownWebhook(id: string) {
  const w = await prisma.webhook.findFirst({ where: { id, tenantId: tenantIdForWrite(), deletedAt: null } });
  if (!w) throw new HttpError(404, 'webhook_not_found', 'Webhook not found.');
  return w;
}

const KNOWN_EVENTS = new Set<string>(WEBHOOK_EVENTS);
function webhookOut(w: { id: string; name: string; url: string; eventTypes: string[]; isActive: boolean; createdAt: Date }) {
  // A subscription made in the app may name an event this API does not list; it is not shown here.
  return { id: w.id, name: w.name, url: w.url, events: w.eventTypes.filter((e) => KNOWN_EVENTS.has(e)) as WebhookEvent[], active: w.isActive, createdAt: w.createdAt.toISOString() };
}

defineRoute(v1Router, {
  method: 'get',
  path: '/webhooks',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'The organization’s webhook subscriptions',
  query: PageQuery,
  response: page(WebhookSchema),
  handler: async ({ query }) => {
    const rows = await prisma.webhook.findMany({ where: { tenantId: tenantIdForWrite(), deletedAt: null }, orderBy: { id: 'asc' }, take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(webhookOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'post',
  path: '/webhooks',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'Subscribe a URL to events',
  description: 'The answer carries the signing secret, once. Deliveries are signed Alto-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">; reject a timestamp older than five minutes.',
  body: WebhookCreateSchema,
  response: WebhookCreatedSchema,
  handler: async ({ req, body }) => {
    await assertSafeOutboundUrl(body.url);
    const secret = newWebhookSecret();
    const w = await prisma.webhook.create({
      data: { name: body.name, url: body.url, eventTypes: body.events, secret: '', secretEnc: sealWebhookSecret(secret), createdById: client(req).ownerUserId, tenantId: tenantIdForWrite() },
    });
    return { ...webhookOut(w), secret };
  },
});

defineRoute(v1Router, {
  method: 'patch',
  path: '/webhooks/:id',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'Change, pause or resume a subscription',
  params: IdParams,
  body: WebhookUpdateSchema,
  response: WebhookSchema,
  handler: async ({ params, body }) => {
    await ownWebhook(params.id);
    if (body.url) await assertSafeOutboundUrl(body.url);
    const w = await prisma.webhook.update({
      where: { id: params.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { eventTypes: body.events } : {}),
        ...(body.active !== undefined ? { isActive: body.active } : {}),
      },
    });
    return webhookOut(w);
  },
});

defineRoute(v1Router, {
  method: 'delete',
  path: '/webhooks/:id',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'Remove a subscription',
  description: 'Pending deliveries stop; the delivery history is kept.',
  params: IdParams,
  response: null,
  status: 204,
  handler: async ({ params }) => {
    await ownWebhook(params.id);
    await prisma.webhook.update({ where: { id: params.id }, data: { deletedAt: new Date(), isActive: false } });
  },
});

function deliveryOut(d: { id: string; eventType: string; status: 'PENDING' | 'RETRYING' | 'DELIVERED' | 'FAILED'; attemptCount: number; responseStatus: number | null; lastAttemptAt: Date | null; deliveredAt: Date | null; createdAt: Date }) {
  return { id: d.id, event: d.eventType, status: d.status, attempts: d.attemptCount, responseStatus: d.responseStatus, lastAttemptAt: isoOrNull(d.lastAttemptAt), deliveredAt: isoOrNull(d.deliveredAt), createdAt: d.createdAt.toISOString() };
}

defineRoute(v1Router, {
  method: 'get',
  path: '/webhooks/:id/deliveries',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'Recent deliveries, newest first',
  description: 'Status and response code only; the receiver’s response body is not returned.',
  params: IdParams,
  query: PageQuery,
  response: page(WebhookDeliverySchema),
  handler: async ({ params, query }) => {
    await ownWebhook(params.id);
    const rows = await prisma.webhookDelivery.findMany({ where: { webhookId: params.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) });
    const p = toPage(rows, query.limit);
    return { data: p.rows.map(deliveryOut), nextCursor: p.nextCursor };
  },
});

defineRoute(v1Router, {
  method: 'post',
  path: '/webhooks/:id/deliveries/:deliveryId/redeliver',
  scopes: ['webhooks:manage'],
  tag: 'Webhooks',
  summary: 'Send a delivery again',
  description: 'Queues a new delivery with the same event body (signed afresh when sent); the original keeps its history.',
  params: DeliveryParams,
  response: WebhookDeliverySchema,
  status: 202,
  handler: async ({ params }) => {
    const w = await ownWebhook(params.id);
    if (!w.isActive) throw new HttpError(409, 'webhook_paused', 'The webhook is paused; resume it first.');
    const original = await prisma.webhookDelivery.findFirst({ where: { id: params.deliveryId, webhookId: w.id } });
    if (!original) throw new HttpError(404, 'delivery_not_found', 'Delivery not found.');
    const again = await prisma.webhookDelivery.create({
      data: { webhookId: w.id, tenantId: w.tenantId, eventType: original.eventType, payload: original.payload as Prisma.InputJsonValue, status: 'PENDING', nextAttemptAt: new Date() },
    });
    return deliveryOut(again);
  },
});
