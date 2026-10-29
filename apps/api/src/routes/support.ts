import { Router } from 'express';
import { z } from 'zod';
import { rolesWithCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { COMPANY } from '../lib/emailLayout.js';
import { ALTO_TENANT_ID, runWithTenant, tenantIdForWrite, withPlatformScope } from '../lib/tenant.js';
import { orgDateKey } from '../lib/timeAnomalies.js';

/**
 * Brief 2-6 step 5 — customer success basics (§4.5; decisions 8, 9).
 *
 *   GET   /support/config     the status page link (STATUS_PAGE_URL), public: the sign-in page shows it too
 *   POST  /support            anyone signed in asks Alto People for help; the platform inbox hears it
 *   GET   /support/mine       my requests and their status, and how long an answer typically takes
 *   POST  /support/:id/followup   the requester answers back on their own request (F500 G5)
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

supportRouter.get('/config', async (_req, res) => {
  // The platform has its own status page; a hosted one (STATUS_PAGE_URL) still wins when set.
  // `contact`: the platform operator's published support line — the one every email footer
  // carries — for the public pages' "write to us" (the accessibility statement, F500 G5).
  const branding = await runWithTenant(ALTO_TENANT_ID, 'job', () => ensureBrandingLoaded(prisma, ALTO_TENANT_ID)).catch(() => null);
  res.json({
    statusPageUrl: env.STATUS_PAGE_URL ?? `${env.APP_BASE_URL.replace(/\/$/, '')}/status`,
    contact: { email: branding?.supportEmail ?? COMPANY.supportEmail, phone: COMPANY.phone, hours: 'Mon–Fri, 8 AM – 5 PM Central' },
  });
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
  // The platform inbox is the operator's: its admins are read, and told, as
  // the operator (TENANCY_MODE=enforce refuses another tenant's rows from
  // this request's context, and a notification must carry its reader's tenant).
  await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
    const inbox = await prisma.user.findMany({ where: { tenantId: ALTO_TENANT_ID, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') } }, select: { id: true }, take: 10 });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    for (const u of inbox) {
      void notifyUser(u.id, { subject: `Support: ${input.subject}`, body: `${tenant?.name ?? 'A customer'} · ${input.category.toLowerCase()}`, linkUrl: `/platform/support?id=${row.id}` });
    }
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'support.requested', entityType: 'SupportRequest', entityId: row.id, metadata: { category: input.category } }, 'support');
  });
  res.status(201).json({ id: row.id, status: row.status });
});

/**
 * How long a request typically takes to resolve: the median over the last
 * 90 days of resolved requests, platform-wide (an aggregate only — no row
 * leaves its organization). Null with fewer than three to go on: the page
 * then says nothing rather than a number it can't back.
 */
async function typicalResolveHours(): Promise<number | null> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const rows = await withPlatformScope(() =>
    prisma.supportRequest.findMany({ where: { status: 'RESOLVED', resolvedAt: { not: null }, createdAt: { gte: since } }, select: { createdAt: true, resolvedAt: true }, take: 500 }),
  );
  if (rows.length < 3) return null;
  const hours = rows.map((r) => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 3_600_000).sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2;
  return Math.max(1, Math.round(median));
}

supportRouter.get('/mine', requireAuth, async (req, res) => {
  const [rows, typical] = await Promise.all([
    prisma.supportRequest.findMany({ where: { requesterUserId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    typicalResolveHours(),
  ]);
  res.json({
    requests: rows.map((r) => ({ id: r.id, category: r.category, subject: r.subject, body: r.body, status: r.status, reply: r.reply, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })),
    typicalResolveHours: typical,
  });
});

/**
 * The requester answers back (F500 G5: a reply arrived as plain text with no
 * way to answer it). Only on their own request; the answer is added to the
 * request's text with its date, the request reopens, and the platform inbox
 * hears it. No new table: the request is still one thread of text.
 */
supportRouter.post('/:id/followup', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { body } = z.object({ body: z.string().trim().min(2).max(2000) }).strict().parse(req.body);
  const row = await prisma.supportRequest.findFirst({ where: { id, requesterUserId: req.user!.id, tenantId: tenantIdForWrite() } });
  if (!row) throw new HttpError(404, 'not_found', 'Not found.');
  const stamp = orgDateKey(new Date());
  const added = `\n\n— Follow-up ${stamp}: ${body}`;
  if (row.body.length + added.length > 5000) throw new HttpError(400, 'too_long', 'This request is full — send a new one, and mention this one.');
  const updated = await prisma.supportRequest.update({ where: { id }, data: { body: row.body + added, status: 'OPEN', resolvedAt: null } });
  await runWithTenant(ALTO_TENANT_ID, 'job', async () => {
    const inbox = await prisma.user.findMany({ where: { tenantId: ALTO_TENANT_ID, status: 'ACTIVE', deletedAt: null, role: { in: rolesWithCapability('manage:org') } }, select: { id: true }, take: 10 });
    for (const u of inbox) void notifyUser(u.id, { subject: `Support follow-up: ${row.subject}`, body: body.slice(0, 300), linkUrl: `/platform/support?id=${row.id}` });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: row.tenantId, action: 'support.followup', entityType: 'SupportRequest', entityId: row.id, metadata: {} }, 'support');
  });
  res.status(201).json({ id: updated.id, status: updated.status });
});

supportRouter.get('/inbox', requireCapability('manage:org', 'view:hr-admin'), async (req, res) => {
  operatorOnly();
  const status = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional().parse(req.query.status);
  // Every organization's requests: the operator reads across tenants, on the record.
  // Open work oldest first; the resolved history newest first (F500 G4).
  const [rows, grouped] = await withPlatformScope(() =>
    Promise.all([
      prisma.supportRequest.findMany({
        where: status ? { status } : { status: { not: 'RESOLVED' } },
        orderBy: status === 'RESOLVED' ? { resolvedAt: 'desc' } : { createdAt: 'asc' },
        take: 200,
        include: { requester: { select: { email: true } } },
      }),
      prisma.supportRequest.groupBy({ by: ['status'], _count: { _all: true } }),
    ]),
  );
  const counts = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0 };
  for (const g of grouped) counts[g.status as keyof typeof counts] = g._count._all;
  const tenants = await prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.tenantId).filter((t): t is string => !!t))] } }, select: { id: true, name: true } });
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]));
  res.json({
    requests: rows.map((r) => ({ id: r.id, tenant: nameOf.get(r.tenantId ?? '') ?? null, requester: r.requester.email, category: r.category, subject: r.subject, body: r.body, pageUrl: r.pageUrl, appVersion: r.appVersion, status: r.status, reply: r.reply, createdAt: r.createdAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })),
    // How many in each state across every organization — the inbox's tabs.
    counts,
  });
});

supportRouter.patch('/:id', requireCapability('manage:org', 'view:hr-admin'), async (req, res) => {
  operatorOnly();
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']), reply: z.string().trim().max(5000).nullable().optional() }).strict().parse(req.body);
  // The request is another organization's: read and answered as the
  // operator, and its requester is told in their own tenant.
  const row = await withPlatformScope(async () => {
    const before = await prisma.supportRequest.findUnique({ where: { id } });
    if (!before) throw new HttpError(404, 'not_found', 'Not found.');
    return prisma.supportRequest.update({
      where: { id },
      data: { status: input.status, ...(input.reply !== undefined ? { reply: input.reply } : {}), resolvedAt: input.status === 'RESOLVED' ? (before.resolvedAt ?? new Date()) : null },
    });
  });
  void runWithTenant(row.tenantId ?? ALTO_TENANT_ID, 'job', () =>
    notifyUser(row.requesterUserId, {
      subject: input.status === 'RESOLVED' ? `Resolved: ${row.subject}` : `Update: ${row.subject}`,
      body: input.reply ? input.reply.slice(0, 300) : `Your request is ${input.status.toLowerCase().replace('_', ' ')}.`,
      linkUrl: '/support',
    }),
  );
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId: row.tenantId, action: 'support.updated', entityType: 'SupportRequest', entityId: id, metadata: { status: input.status, replied: !!input.reply } }, 'support');
  res.json({ id: row.id, status: row.status });
});
