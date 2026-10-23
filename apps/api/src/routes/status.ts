import { Router } from 'express';
import { z } from 'zod';
import { StatusIncidentCreateSchema, StatusIncidentUpdateSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';
import { requireCapability } from '../middleware/auth.js';
import { anonReportFileLimiter, loginIpLimiter } from '../middleware/rateLimit.js';
import { computePublicStatus } from '../lib/statusPage.js';
import { confirmStatusSubscription, notifyStatusSubscribers, subscribeToStatus, unsubscribeFromStatus } from '../lib/statusSubscribers.js';
import { logger } from '../lib/logger.js';

/**
 * The public status page (beside the Trust Center).
 *
 *   GET  /status/public                 no sign-in: the overall state, each
 *                                       component's state and 90-day uptime,
 *                                       the incidents of the last 90 days.
 *                                       Cached a minute; rate-limited like
 *                                       the login page. Never a tenant, a
 *                                       route, an address or a person.
 *   GET  /status/incidents              the platform operator's view (every
 *                                       incident, with who posted it)
 *   POST /status/incidents              post an incident
 *   POST /status/incidents/:id/updates  add a timeline entry; RESOLVED closes it
 *
 * Only an org manager of the platform operator's tenant may post: the
 * page is about the platform, not a customer's organization.
 */
export const statusRouter = Router();

statusRouter.get('/public', loginIpLimiter, async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(await computePublicStatus(prisma));
});

/*
 * Incident updates by email (F500 G5): double opt-in. The answer to a
 * subscribe is the same whether or not the address was already on the
 * list, so the form can't be used to test who is subscribed.
 */
const SubscribeSchema = z.object({ email: z.string().trim().email().max(254) });
const TokenSchema = z.object({ token: z.string().min(10).max(200) });

statusRouter.post('/subscribe', anonReportFileLimiter, async (req, res) => {
  const { email } = SubscribeSchema.parse(req.body);
  await subscribeToStatus(prisma, email);
  res.status(202).json({ ok: true });
});

statusRouter.post('/subscribe/confirm', loginIpLimiter, async (req, res) => {
  const { token } = TokenSchema.parse(req.body);
  if (!(await confirmStatusSubscription(prisma, token))) throw new HttpError(404, 'link_not_valid', 'This confirmation link is not valid. Ask for updates again from the status page.');
  res.json({ ok: true });
});

statusRouter.post('/unsubscribe', loginIpLimiter, async (req, res) => {
  const { token } = TokenSchema.parse(req.body);
  if (!(await unsubscribeFromStatus(prisma, token))) throw new HttpError(404, 'link_not_valid', 'This unsubscribe link is not valid.');
  res.json({ ok: true });
});

/** Tell the subscribers, off the request path: a slow mailer never holds up the operator. */
function tellSubscribers(incident: { title: string; component: string; impact: string; state: string; note: string }): void {
  void notifyStatusSubscribers(prisma, incident).catch((err) => logger.warn({ err }, 'status subscribers not told'));
}

const operatorOnly = requireCapability('manage:org');
function assertOperator(): void {
  if (tenantIdForWrite() !== ALTO_TENANT_ID) {
    throw new HttpError(403, 'forbidden', 'Only the platform operator posts to the status page.');
  }
}

const shape = (i: {
  id: string;
  title: string;
  component: string;
  impact: string;
  state: string;
  startedAt: Date;
  resolvedAt: Date | null;
  createdByUserId: string | null;
  updates: Array<{ id: string; at: Date; state: string; note: string; byUserId: string | null }>;
}) => ({
  id: i.id,
  title: i.title,
  component: i.component,
  impact: i.impact,
  state: i.state,
  startedAt: i.startedAt.toISOString(),
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
  createdByUserId: i.createdByUserId,
  updates: i.updates.map((u) => ({ id: u.id, at: u.at.toISOString(), state: u.state, note: u.note, byUserId: u.byUserId })),
});

statusRouter.get('/incidents', operatorOnly, async (_req, res) => {
  assertOperator();
  const rows = await prisma.statusIncident.findMany({ orderBy: { startedAt: 'desc' }, take: 100, include: { updates: { orderBy: { at: 'asc' } } } });
  res.json({ incidents: rows.map(shape) });
});

statusRouter.post('/incidents', operatorOnly, async (req, res) => {
  assertOperator();
  const input = StatusIncidentCreateSchema.parse(req.body);
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  const row = await prisma.statusIncident.create({
    data: {
      tenantId: ALTO_TENANT_ID,
      title: input.title,
      component: input.component,
      impact: input.impact,
      state: input.state,
      startedAt,
      createdByUserId: req.user!.id,
      updates: { create: { state: input.state, note: input.note, at: startedAt, byUserId: req.user!.id } },
    },
    include: { updates: true },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId: ALTO_TENANT_ID, action: 'status.incident.posted', entityType: 'StatusIncident', entityId: row.id, metadata: { component: input.component, impact: input.impact } },
    'status',
  );
  tellSubscribers({ title: row.title, component: row.component, impact: row.impact, state: row.state, note: input.note });
  res.status(201).json(shape(row));
});

statusRouter.post('/incidents/:id/updates', operatorOnly, async (req, res) => {
  assertOperator();
  const id = z.string().uuid().parse(req.params.id);
  const input = StatusIncidentUpdateSchema.parse(req.body);
  const existing = await prisma.statusIncident.findUnique({ where: { id }, select: { id: true, state: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'No such incident.');
  if (existing.state === 'RESOLVED') throw new HttpError(409, 'already_resolved', 'This incident is resolved; post a new one if it came back.');
  const now = new Date();
  const row = await prisma.statusIncident.update({
    where: { id },
    data: {
      state: input.state,
      resolvedAt: input.state === 'RESOLVED' ? now : null,
      updates: { create: { state: input.state, note: input.note, at: now, byUserId: req.user!.id } },
    },
    include: { updates: { orderBy: { at: 'asc' } } },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId: ALTO_TENANT_ID, action: 'status.incident.updated', entityType: 'StatusIncident', entityId: row.id, metadata: { state: input.state } },
    'status',
  );
  // Subscribers hear when it starts and when it's over, not every note in between.
  if (input.state === 'RESOLVED') tellSubscribers({ title: row.title, component: row.component, impact: row.impact, state: row.state, note: input.note });
  res.json(shape(row));
});
