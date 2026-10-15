import { Router } from 'express';
import { z } from 'zod';
import { rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-6 step 5 — customer success basics (§4.5; decisions 8, 9).
 *
 *   GET   /support/config     the status page link (STATUS_PAGE_URL), public: the sign-in page shows it too
 *   POST  /support            anyone signed in asks Alto People for help; the platform inbox hears it
 *   GET   /support/mine       my requests and their status
 *   GET   /support/inbox      the platform inbox: every tenant's requests (the platform operator's admins)
 *   PATCH /support/:id        the platform answers or moves a request; the requester hears it in the bell
 *
 *   No worker data is attached automatically: the request carries what the
 *   person wrote, the page they were on and the app version, nothing else.
 */

export const supportRouter = Router();

const CATEGORIES = ['QUESTION', 'PROBLEM', 'BILLING', 'ACCOUNT', 'OTHER'] as const;

function operatorOnly(): void {
  if (tenantIdForWrite() !== ALTO_TENANT_ID) throw new HttpError(404, 'not_found', 'Not found.');
}

supportRouter.get('/config', (_req, res) => {
  res.json({ statusPageUrl: env.STATUS_PAGE_URL ?? null });
});

supportRouter.post('/', requireAuth, async (req, res) => {
  const input = z
    .object({
      category: z.enum(CATEGORIES),
      subject: z.string().trim().min(3).max(160),
      body: z.string().trim().min(5).max(5000),
      pageUrl: z.string().max(500).nullable().optional(),
      appVersion: z.string().max(60).nullable().optional(),
    })
    .strict()
    .parse(req.body);
  const tenantId = tenantIdForWrite();
  const row = await prisma.supportRequest.create({
    data: { tenantId, requesterUserId: req.user!.id, category: input.category, subject: input.subject, body: input.body, pageUrl: input.pageUrl ?? null, appVersion: input.appVersion ?? null },
  });
  // The platform inbox: the operator's admins, in the bell (decision 8: our own inbox, not a helpdesk).
  const inbox = await prisma.user.findMany({ where: { tenantId: ALTO_TENANT_ID, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') } }, select: { id: true }, take: 10 });
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  for (const u of inbox) {
    void notifyUser(u.id, { subject: `Support: ${input.subject}`, body: `${tenant?.name ?? 'A customer'} · ${input.category.toLowerCase()}`, linkUrl: `/platform/support?id=${row.id}` });
  }
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'support.requested', entityType: 'SupportRequest', entityId: row.id, metadata: { category: input.category } }, 'support');
  res.status(201).json({ id: row.id, status: row.status });
});

supportRouter.get('/mine', requireAuth, async (req, res) => {
  const rows = await prisma.supportRequest.findMany({ where: { requesterUserId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ requests: rows.map((r) => ({ id: r.id, category: r.category, subject: r.subject, status: r.status, reply: r.reply, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })) });
});

supportRouter.get('/inbox', requireCapability('manage:org'), async (req, res) => {
  operatorOnly();
  const status = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional().parse(req.query.status);
  const rows = await prisma.supportRequest.findMany({
    where: status ? { status } : { status: { not: 'RESOLVED' } },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { requester: { select: { email: true } } },
  });
  const tenants = await prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId).filter((t): t is string => !!t))] } }, select: { id: true, name: true } });
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]));
  res.json({
    requests: rows.map((r) => ({ id: r.id, tenant: nameOf.get(r.tenantId ?? '') ?? null, requester: r.requester.email, category: r.category, subject: r.subject, body: r.body, pageUrl: r.pageUrl, appVersion: r.appVersion, status: r.status, reply: r.reply, createdAt: r.createdAt.toISOString() })),
  });
});

supportRouter.patch('/:id', requireCapability('manage:org'), async (req, res) => {
  operatorOnly();
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']), reply: z.string().trim().max(5000).nullable().optional() }).strict().parse(req.body);
  const before = await prisma.supportRequest.findUnique({ where: { id } });
  if (!before) throw new HttpError(404, 'not_found', 'Not found.');
  const row = await prisma.supportRequest.update({
    where: { id },
    data: { status: input.status, ...(input.reply !== undefined ? { reply: input.reply } : {}), resolvedAt: input.status === 'RESOLVED' ? (before.resolvedAt ?? new Date()) : null },
  });
  void notifyUser(row.requesterUserId, {
    subject: input.status === 'RESOLVED' ? `Resolved: ${row.subject}` : `Update: ${row.subject}`,
    body: input.reply ? input.reply.slice(0, 300) : `Your request is ${input.status.toLowerCase().replace('_', ' ')}.`,
    linkUrl: '/support',
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: row.tenantId, action: 'support.updated', entityType: 'SupportRequest', entityId: id, metadata: { status: input.status, replied: !!input.reply } }, 'support');
  res.json({ id: row.id, status: row.status });
});
