import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';

/**
 * The client in the loop — structured requests instead of phone calls.
 *
 * PORTAL SIDE (CLIENT_PORTAL, clamped to their own client):
 *   POST /client-portal/requests — staffing ask / feedback / issue.
 *   GET  /client-portal/requests — their requests with live status and
 *        the resolution reply. The client watches the baton move.
 *
 * STAFF SIDE (view:org to read; manage:scheduling to work, client-
 * bounded supervisors clamped to their own store):
 *   GET   /client-requests           — open queue, oldest first.
 *   PATCH /client-requests/:id       — start / resolve with a reply.
 *
 * Routing: STAFFING asks ring the Workforce desk; FEEDBACK and ISSUE
 * ring HR. The resolution text is CLIENT-VISIBLE — internal discussion
 * belongs on threads, never here.
 */

export const clientRequestsRouter = Router();

const KIND = z.enum(['STAFFING', 'FEEDBACK', 'ISSUE', 'BILLING']);
type Kind = z.infer<typeof KIND>;
type Desk = 'WORKFORCE' | 'HR' | 'FINANCE';

export const DESK_FOR_KIND: Record<Kind, Desk> = {
  STAFFING: 'WORKFORCE',
  FEEDBACK: 'HR',
  ISSUE: 'HR',
  // A statement question or dispute is Finance's baton — never HR's.
  BILLING: 'FINANCE',
};
const DESK_ROLES: Record<Desk, string[]> = {
  WORKFORCE: ['WORKFORCE_MANAGER'],
  HR: ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'],
  FINANCE: ['FINANCE_ACCOUNTANT'],
};
/** The promise the client sees: hours until a request is due a reply. */
export const SLA_HOURS: Record<Kind, number> = {
  STAFFING: 24,
  ISSUE: 48,
  BILLING: 72,
  FEEDBACK: 120,
};
const DESK_LABEL: Record<Desk, string> = {
  WORKFORCE: 'Workforce desk',
  HR: 'HR desk',
  FINANCE: 'Finance desk',
};

function requireClientPortal(user: { role: string; clientId: string | null }): string {
  if (user.role !== 'CLIENT_PORTAL') {
    throw new HttpError(403, 'forbidden', 'The request desk is for client accounts.');
  }
  if (!user.clientId) {
    throw new HttpError(
      403,
      'no_client_assigned',
      'No client is linked to this portal account yet — ask your Alto contact.',
    );
  }
  return user.clientId;
}

const CreateSchema = z.object({
  kind: KIND,
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(4000),
});

clientRequestsRouter.post(
  '/client-portal/requests',
  requireAuth,
  async (req, res, next) => {
    try {
      const clientId = requireClientPortal(req.user!);
      const input = CreateSchema.parse(req.body);
      const created = await prisma.clientRequest.create({
        data: {
          clientId,
          kind: input.kind,
          subject: input.subject,
          body: input.body,
          createdByUserId: req.user!.id,
          dueAt: new Date(Date.now() + SLA_HOURS[input.kind] * 3_600_000),
        },
        include: { client: { select: { name: true } } },
      });

      // Ring the owning desk with the client's own words attached.
      const desk = DESK_FOR_KIND[input.kind];
      const preview =
        input.body.length > 200 ? `${input.body.slice(0, 200)}…` : input.body;
      void trackNotificationWork(
        (async () => {
          const recipients = await prisma.user.findMany({
            where: {
              status: 'ACTIVE',
              role: { in: DESK_ROLES[desk] as never[] },
            },
            select: { id: true },
            take: 50,
          });
          await Promise.all(
            recipients.map((u) =>
              notifyUser(u.id, {
                subject: `Client request — ${created.client.name}: ${input.subject}`,
                body: `${created.client.name} sent a ${input.kind.toLowerCase()} request: "${preview}" They can see its status in their portal — keep it moving.`,
                category: 'client-request',
                linkUrl: '/relay#client-requests',
              }),
            ),
          );
        })(),
      );

      res.status(201).json({ id: created.id });
    } catch (err) {
      next(err);
    }
  },
);

clientRequestsRouter.get(
  '/client-portal/requests',
  requireAuth,
  async (req, res, next) => {
    try {
      const clientId = requireClientPortal(req.user!);
      const rows = await prisma.clientRequest.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          startedBy: { select: { email: true, associate: { select: { firstName: true } } } },
          resolvedBy: { select: { email: true, associate: { select: { firstName: true } } } },
        },
      });
      // The owner the client sees: the desk always, plus the FIRST name of
      // whoever picked it up (or replied). Never an email — that is an
      // internal identifier, not a human.
      const ownerName = (u: { email: string; associate: { firstName: string } | null } | null) =>
        u ? (u.associate?.firstName ?? null) : null;
      res.json({
        requests: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          subject: r.subject,
          body: r.body,
          status: r.status,
          resolution: r.resolution,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          dueAt: r.dueAt?.toISOString() ?? null,
          desk: DESK_LABEL[DESK_FOR_KIND[r.kind]],
          owner: ownerName(r.status === 'RESOLVED' ? r.resolvedBy : r.startedBy),
          overdue:
            r.status !== 'RESOLVED' && !!r.dueAt && r.dueAt.getTime() < Date.now(),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ---- Staff side ------------------------------------------------------ */

// Client-bounded supervisors see and work only their own store's asks.
function staffClamp(user: { role: string; clientId: string | null }): {
  clientId?: string;
} {
  if (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { clientId: user.clientId ?? '00000000-0000-0000-0000-000000000000' };
  }
  return {};
}

clientRequestsRouter.get(
  '/client-requests',
  requireCapability('view:org'),
  async (req, res, next) => {
    try {
      const rows = await prisma.clientRequest.findMany({
        where: { status: { not: 'RESOLVED' }, ...staffClamp(req.user!) },
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: { client: { select: { name: true } } },
      });
      res.json({
        requests: rows.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientName: r.client.name,
          kind: r.kind,
          desk: DESK_FOR_KIND[r.kind],
          subject: r.subject,
          body: r.body,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          dueAt: r.dueAt?.toISOString() ?? null,
          overdue: !!r.dueAt && r.dueAt.getTime() < Date.now(),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

const PatchSchema = z.object({
  status: z.enum(['IN_PROGRESS', 'RESOLVED']),
  // Required when resolving: the client reads this in their portal.
  resolution: z.string().trim().max(2000).optional(),
});

clientRequestsRouter.patch(
  '/client-requests/:id',
  requireCapability('manage:scheduling'),
  async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const input = PatchSchema.parse(req.body);
      const existing = await prisma.clientRequest.findFirst({
        where: { id, ...staffClamp(req.user!) },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new HttpError(404, 'not_found', 'Request not found.');
      }
      if (existing.status === 'RESOLVED') {
        throw new HttpError(409, 'already_resolved', 'Already resolved.');
      }
      if (input.status === 'RESOLVED' && !input.resolution) {
        throw new HttpError(
          400,
          'resolution_required',
          'Write the reply the client will read.',
        );
      }
      await prisma.clientRequest.update({
        where: { id },
        data: {
          status: input.status,
          ...(input.status === 'IN_PROGRESS'
            ? { startedAt: new Date(), startedById: req.user!.id }
            : {}),
          ...(input.status === 'RESOLVED'
            ? {
                resolution: input.resolution,
                resolvedAt: new Date(),
                resolvedById: req.user!.id,
              }
            : {}),
        },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
