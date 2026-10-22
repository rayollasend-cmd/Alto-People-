import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  EmailSuppressionListResponseSchema,
  NotificationBroadcastInputSchema,
  NotificationChannelSchema,
  NotificationListResponseSchema,
  NotificationSendInputSchema,
  NotificationStatusSchema,
  PushPublicKeyResponseSchema,
  PushSubscribeInputSchema,
  PushUnsubscribeInputSchema,
  type Notification,
  type NotificationListResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/auth.js';
import { anyPushConfigured, send, statusForSendError } from '../lib/notifications.js';
import { pushConfigured } from '../lib/webPush.js';
import { smsAvailability } from '../lib/sms.js';
import { enqueueAudit } from '../lib/audit.js';
import { emitLiveEvent } from '../lib/liveEvents.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { isInternallyScoped, scopeAssociates } from '../lib/scope.js';

export const communicationsRouter = Router();

/**
 * The personal half: your own inbox (the bell) and your own push
 * subscriptions. Every signed-in account has these — including portal
 * accounts, which hold no communications capability — so it mounts at
 * /communications/me behind requireAuth, ahead of the capability-gated
 * admin router.
 */
export const communicationsMeRouter = Router();

const MANAGE = requireCapability('manage:communications');

type RawNotif = Prisma.NotificationGetPayload<{
  include: { senderUser: { select: { email: true } } };
}>;

function toNotif(row: RawNotif, recipientName?: string | null): Notification {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    recipientUserId: row.recipientUserId,
    recipientPhone: row.recipientPhone,
    recipientEmail: row.recipientEmail,
    subject: row.subject,
    body: row.body,
    category: row.category,
    externalRef: row.externalRef,
    providerMessageId: row.providerMessageId,
    failureReason: row.failureReason,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    seenAt: row.seenAt ? row.seenAt.toISOString() : null,
    senderUserId: row.senderUserId,
    senderEmail: row.senderUser?.email ?? null,
    linkUrl: row.linkUrl ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(recipientName !== undefined ? { recipientName } : {}),
  };
}

/** Names for the admin log: the account's person, else the account's email. */
async function recipientNames(userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email]));
}

const NOTIF_INCLUDE = {
  senderUser: { select: { email: true } },
} as const;

/* ===== Web push subscriptions =========================================== */

/**
 * The VAPID public key the browser needs to subscribe. 404 (not 200-with-
 * empty) when push isn't configured, so clients treat it exactly like an
 * unsupported browser and never show the enable card's success path.
 */
communicationsMeRouter.get('/push/public-key', async (_req, res, next) => {
  try {
    if (!pushConfigured() || !env.VAPID_PUBLIC_KEY) {
      throw new HttpError(404, 'push_not_configured', 'Push is not configured');
    }
    res.json(PushPublicKeyResponseSchema.parse({ publicKey: env.VAPID_PUBLIC_KEY }));
  } catch (err) {
    next(err);
  }
});

communicationsMeRouter.post('/push/subscriptions', async (req, res, next) => {
  try {
    const parsed = PushSubscribeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid subscription', parsed.error.flatten());
    }
    const user = req.user!;
    // Upsert on the endpoint (globally unique per browser subscription).
    // If the endpoint was registered under ANOTHER account — shared device,
    // logout/login — it moves to the caller: pushes must follow the person
    // signed in on that browser, never a previous occupant.
    await prisma.pushSubscription.upsert({
      where: { endpoint: parsed.data.endpoint },
      create: {
        userId: user.id,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      },
      update: {
        userId: user.id,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

communicationsMeRouter.delete('/push/subscriptions', async (req, res, next) => {
  try {
    const parsed = PushUnsubscribeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request', parsed.error.flatten());
    }
    // Scoped to the caller — you can't unsubscribe someone else's device
    // by knowing its endpoint.
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: parsed.data.endpoint, userId: req.user!.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Associate inbox (IN_APP) ======================================== */

communicationsMeRouter.get('/inbox', async (req, res, next) => {
  try {
    const user = req.user!;
    const where = { recipientUserId: user.id, channel: 'IN_APP' as const };
    const [total, rows] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: NOTIF_INCLUDE,
      }),
    ]);
    const payload: NotificationListResponse = NotificationListResponseSchema.parse({
      notifications: rows.map((r) => toNotif(r)),
      total,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Opening the bell panel = "I have seen what's here". Stamps seenAt on
// every unseen IN_APP row so the badge clears, while readAt (the row
// highlight) survives until each item is actually clicked. Idempotent.
communicationsMeRouter.post('/inbox/seen', async (req, res, next) => {
  try {
    const r = await prisma.notification.updateMany({
      where: { recipientUserId: req.user!.id, channel: 'IN_APP', seenAt: null },
      data: { seenAt: new Date() },
    });
    res.json({ updated: r.count });
  } catch (err) {
    next(err);
  }
});

// One request instead of the bell's old Promise.allSettled storm of up to
// 100 individual /read calls. Also stamps seenAt — a row can't be read
// but unseen.
// With `ids`, only those (the bell's "mark these N read" on a group) —
// still only the caller's own rows.
communicationsMeRouter.post('/inbox/read-all', async (req, res, next) => {
  try {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(200).optional() }).parse(req.body ?? {});
    const now = new Date();
    const r = await prisma.notification.updateMany({
      where: { recipientUserId: req.user!.id, channel: 'IN_APP', readAt: null, ...(ids ? { id: { in: ids } } : {}) },
      data: { status: 'READ', readAt: now, seenAt: now },
    });
    res.json({ updated: r.count });
  } catch (err) {
    next(err);
  }
});

// "Clear all of this kind": every unread row of one category (and its
// sub-categories — compliance.attestation clears every signal's reminder),
// not just the ones loaded in the bell. Still only the caller's own rows.
communicationsMeRouter.post('/inbox/read-kind', async (req, res, next) => {
  try {
    const { category } = z.object({ category: z.string().trim().min(1).max(120) }).parse(req.body ?? {});
    const now = new Date();
    const r = await prisma.notification.updateMany({
      where: {
        recipientUserId: req.user!.id,
        channel: 'IN_APP',
        readAt: null,
        OR: [{ category }, { category: { startsWith: `${category}.` } }],
      },
      data: { status: 'READ', readAt: now, seenAt: now },
    });
    res.json({ updated: r.count });
  } catch (err) {
    next(err);
  }
});

communicationsMeRouter.post('/inbox/:id/read', async (req, res, next) => {
  try {
    const user = req.user!;
    const row = await prisma.notification.findFirst({
      where: { id: req.params.id, recipientUserId: user.id, channel: 'IN_APP' },
    });
    if (!row) throw new HttpError(404, 'notification_not_found', 'Notification not found');
    if (row.readAt) {
      const refreshed = await prisma.notification.findUniqueOrThrow({
        where: { id: row.id },
        include: NOTIF_INCLUDE,
      });
      res.json(toNotif(refreshed));
      return;
    }
    const updated = await prisma.notification.update({
      where: { id: row.id },
      // A row can't be read-but-unseen; backfill seenAt if the panel-open
      // stamp somehow never landed.
      data: { status: 'READ', readAt: new Date(), seenAt: row.seenAt ?? new Date() },
      include: NOTIF_INCLUDE,
    });
    res.json(toNotif(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== HR send / broadcast ============================================ */

communicationsRouter.get('/admin', MANAGE, async (req, res, next) => {
  try {
    // Optional ?channel= and ?status= filters. Validated against the shared
    // enums so a garbage value is ignored (unfiltered) instead of bubbling a
    // Prisma enum error out of the list endpoint.
    const channelParsed = NotificationChannelSchema.safeParse(
      req.query.channel?.toString(),
    );
    const statusParsed = NotificationStatusSchema.safeParse(
      req.query.status?.toString(),
    );
    const where: Prisma.NotificationWhereInput = {
      ...(channelParsed.success ? { channel: channelParsed.data } : {}),
      ...(statusParsed.success ? { status: statusParsed.data } : {}),
    };
    const rows = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: NOTIF_INCLUDE,
    });
    const names = await recipientNames(rows.map((r) => r.recipientUserId));
    res.json(
      NotificationListResponseSchema.parse({
        notifications: rows.map((r) => toNotif(r, r.recipientUserId ? names.get(r.recipientUserId) ?? null : null)),
      })
    );
  } catch (err) {
    next(err);
  }
});

communicationsRouter.post('/admin/send', MANAGE, idempotent, async (req, res, next) => {
  try {
    const parsed = NotificationSendInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;

    // A person picked in the composer: the server finds their account,
    // email and phone — within this tenant and the sender's reach.
    let target = { userId: i.recipientUserId ?? null, email: i.recipientEmail ?? null, phone: i.recipientPhone ?? null };
    if (i.recipientAssociateId) {
      const a = await prisma.associate.findFirst({
        where: { AND: [{ id: i.recipientAssociateId, tenantId: tenantIdForWrite(), deletedAt: null }, scopeAssociates(req.user!)] },
        select: { email: true, phone: true, firstName: true, user: { select: { id: true } } },
      });
      if (!a) throw new HttpError(404, 'not_found', 'That person is not in your reach.');
      target = {
        userId: target.userId ?? a.user?.id ?? null,
        email: target.email ?? (i.channel === 'EMAIL' ? a.email : null),
        phone: target.phone ?? (i.channel === 'SMS' ? a.phone : null),
      };
      if ((i.channel === 'IN_APP' || i.channel === 'PUSH') && !target.userId) {
        throw new HttpError(400, 'no_account', `${a.firstName} hasn’t set up an account yet — send by email instead.`);
      }
      if (i.channel === 'SMS' && !target.phone) {
        throw new HttpError(400, 'no_phone', `${a.firstName} has no phone number on file.`);
      }
    }

    const created = await prisma.notification.create({
      data: {
        channel: i.channel,
        status: 'QUEUED',
        recipientUserId: target.userId,
        recipientPhone: target.phone,
        recipientEmail: target.email,
        subject: i.subject ?? null,
        body: i.body,
        category: i.category ?? null,
        senderUserId: req.user!.id,
      },
      include: NOTIF_INCLUDE,
    });

    // The provider call, with the words — an email went out with an empty
    // body when this went through the subject-less stub sender.
    try {
      const { externalRef } = await send({
        channel: created.channel,
        recipient: { userId: created.recipientUserId, phone: created.recipientPhone, email: created.recipientEmail },
        subject: created.subject,
        body: created.body,
        audit: false,
      });
      const sent = await prisma.notification.update({
        where: { id: created.id },
        data: { status: 'SENT', sentAt: new Date(), externalRef },
        include: NOTIF_INCLUDE,
      });
      // Live nudge for in-app direct messages — an HR-composed message
      // used to be the slowest thing in the bell (30s poll) while a
      // birthday ping was instant.
      if (sent.channel === 'IN_APP' && sent.recipientUserId) {
        emitLiveEvent(sent.recipientUserId, 'notification');
      }
      res.status(201).json(toNotif(sent));
    } catch (sendErr) {
      const reason = sendErr instanceof Error ? sendErr.message : 'unknown error';
      // A suppressed address (or a number that texted STOP) is not a
      // provider failure, and a channel with no provider behind it is not
      // either — each gets its own status so the admin sees WHY nothing
      // went out, and the row is never SENT.
      const status = statusForSendError(sendErr);
      const failed = await prisma.notification.update({
        where: { id: created.id },
        data: { status, failureReason: reason },
        include: NOTIF_INCLUDE,
      });
      res.status(202).json(toNotif(failed));
    }
  } catch (err) {
    next(err);
  }
});

/* ===== Which channels can actually deliver ============================== */

/**
 * GET /communications/admin/channels — what the composer may offer. A
 * channel with no provider behind it is shown disabled WITH the reason,
 * instead of a "(stub)" option that silently goes nowhere.
 */
communicationsRouter.get('/admin/channels', MANAGE, (_req, res) => {
  const emailReady = Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
  res.json({
    channels: [
      { channel: 'IN_APP', available: true, reason: null },
      {
        channel: 'EMAIL',
        available: emailReady,
        reason: emailReady ? null : 'No email provider connected — set one up in Settings › Communications.',
      },
      { channel: 'SMS', ...smsAvailability() },
      {
        channel: 'PUSH',
        available: anyPushConfigured(),
        reason: anyPushConfigured() ? null : 'Push isn’t set up for this organization — set the VAPID (web) or APNs / FCM (phone) keys on the API.',
      },
    ],
  });
});

/* ===== Email suppression list (do-not-email) =========================== */

/**
 * GET /communications/admin/suppressions
 *
 * Addresses the system refuses to email � populated automatically by the
 * Resend webhook on hard bounce / spam complaint. Same manage gate as the
 * other admin actions on this router.
 */
communicationsRouter.get('/admin/suppressions', MANAGE, async (_req, res, next) => {
  try {
    const rows = await prisma.emailSuppression.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json(
      EmailSuppressionListResponseSchema.parse({
        suppressions: rows.map((r) => ({
          id: r.id,
          email: r.email,
          reason: r.reason,
          notes: r.notes,
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /communications/admin/suppressions/:email  (un-suppress, audited)
 *
 * Removing an address resumes delivery on the next send. Keyed by email
 * (URL-encoded) rather than row id so the admin UI can delete straight
 * off the listed address.
 */
communicationsRouter.delete(
  '/admin/suppressions/:email',
  MANAGE,
  async (req, res, next) => {
    try {
      const email = req.params.email.trim().toLowerCase();
      const existing = await prisma.emailSuppression.findUnique({ where: { email } });
      if (!existing) {
        throw new HttpError(404, 'suppression_not_found', 'Address is not suppressed.');
      }
      await prisma.emailSuppression.delete({ where: { email } });
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'email.unsuppressed',
          entityType: 'EmailSuppression',
          entityId: email,
          metadata: { reason: existing.reason, notes: existing.notes },
        },
        'communications.unsuppress',
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

communicationsRouter.post('/admin/broadcast', MANAGE, idempotent, async (req, res, next) => {
  try {
    const parsed = NotificationBroadcastInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;

    // This tenant's active accounts only; a site/region-bound sender reaches
    // the people at its own sites, never the whole company.
    const where: Prisma.UserWhereInput = { tenantId: tenantIdForWrite(), deletedAt: null, status: 'ACTIVE' };
    if (i.audience === 'ALL_ASSOCIATES') where.role = 'ASSOCIATE';
    if (i.audience === 'ALL_HR') where.role = 'HR_ADMINISTRATOR';
    if (isInternallyScoped(req.user!)) where.associate = { is: scopeAssociates(req.user!) };

    // Every recipient, in pages — a silent cap used to skip everyone past the first thousand.
    const recipients: Array<{ id: string }> = [];
    for (let cursor: string | undefined; ; ) {
      const page: Array<{ id: string }> = await prisma.user.findMany({
        where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      recipients.push(...page);
      if (page.length < 1000) break;
      cursor = page[page.length - 1]!.id;
    }
    if (recipients.length === 0) {
      res.json({ notifications: [], count: 0 });
      return;
    }

    const created = await prisma.notification.createMany({
      data: recipients.map((r) => ({
        channel: i.channel,
        status: 'QUEUED' as const,
        recipientUserId: r.id,
        subject: i.subject ?? null,
        body: i.body,
        category: i.category ?? null,
        senderUserId: req.user!.id,
      })),
    });

    // Mark IN_APP as immediately SENT (no external service). For PUSH/EMAIL
    // we'd loop and call sendStubbed; for the broadcast MVP we batch-flip
    // them so the caller sees `status: SENT`.
    await prisma.notification.updateMany({
      where: {
        senderUserId: req.user!.id,
        body: i.body,
        status: 'QUEUED',
      },
      data: { status: 'SENT', sentAt: new Date() },
    });

    if (i.channel === 'IN_APP') {
      for (const r of recipients) emitLiveEvent(r.id, 'notification');
    }

    res.status(201).json({ count: created.count });
  } catch (err) {
    next(err);
  }
});
