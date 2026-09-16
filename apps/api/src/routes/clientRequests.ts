import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';
import { associatesOfClient } from '../lib/scope.js';

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
  // Optional: the person this is about, from the store's own roster.
  associateId: z.string().uuid().nullable().optional(),
});

clientRequestsRouter.post(
  '/client-portal/requests',
  requireAuth,
  async (req, res, next) => {
    try {
      const clientId = requireClientPortal(req.user!);
      const input = CreateSchema.parse(req.body);
      // The named person must be on THIS client's roster — a store can only
      // talk about people it can already see.
      let associate: { id: string; firstName: string; lastName: string } | null = null;
      if (input.associateId) {
        associate = await prisma.associate.findFirst({
          where: { id: input.associateId, deletedAt: null, ...associatesOfClient(clientId) },
          select: { id: true, firstName: true, lastName: true },
        });
        if (!associate) {
          throw new HttpError(400, 'associate_not_on_roster', 'That person is not on your roster.');
        }
      }
      const created = await prisma.clientRequest.create({
        data: {
          clientId,
          kind: input.kind,
          subject: input.subject,
          body: input.body,
          createdByUserId: req.user!.id,
          associateId: associate?.id ?? null,
          dueAt: new Date(Date.now() + SLA_HOURS[input.kind] * 3_600_000),
        },
        include: { client: { select: { name: true } } },
      });
      const aboutLine = associate ? ` About: ${associate.firstName} ${associate.lastName}.` : '';

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
                body: `${created.client.name} sent a ${input.kind.toLowerCase()} request: "${preview}"${aboutLine} They can see its status in their portal — keep it moving.`,
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
          associate: { select: { id: true, firstName: true, lastName: true } },
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
          associateId: r.associate?.id ?? null,
          associateName: r.associate ? `${r.associate.firstName} ${r.associate.lastName}` : null,
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
        include: {
          client: { select: { name: true } },
          associate: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      res.json({
        requests: rows.map((r) => ({
          id: r.id,
          clientId: r.clientId,
          clientName: r.client.name,
          associateId: r.associate?.id ?? null,
          associateName: r.associate ? `${r.associate.firstName} ${r.associate.lastName}` : null,
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
        select: { id: true, status: true, subject: true, createdByUserId: true },
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
      // Close the loop: the store manager who asked hears back the moment
      // someone picks it up, and again with the reply — bell + email.
      if (existing.createdByUserId) {
        const actor = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { associate: { select: { firstName: true } } },
        });
        const who = actor?.associate?.firstName ?? 'Alto';
        void trackNotificationWork(
          notifyUser(existing.createdByUserId, {
            subject:
              input.status === 'RESOLVED'
                ? `Reply from Alto: ${existing.subject}`
                : `${who} picked up your request: ${existing.subject}`,
            body:
              input.status === 'RESOLVED'
                ? `${who} replied:\n\n${input.resolution}\n\nThe full thread is in your portal.`
                : `${who} is working on "${existing.subject}". You'll hear back here when there's a reply.`,
            category: 'client-request',
            linkUrl: '/portal/requests',
          }),
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
