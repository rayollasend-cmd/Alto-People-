import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  NotificationBroadcastInputSchema,
  NotificationListResponseSchema,
  NotificationSendInputSchema,
  type Notification,
  type NotificationListResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { sendStubbed } from '../lib/notifications.js';

export const communicationsRouter = Router();

const MANAGE = requireCapability('manage:communications');

type RawNotif = Prisma.NotificationGetPayload<{
  include: { senderUser: { select: { email: true } } };
}>;

function toNotif(row: RawNotif): Notification {
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
    failureReason: row.failureReason,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    senderUserId: row.senderUserId,
    senderEmail: row.senderUser?.email ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const NOTIF_INCLUDE = {
  senderUser: { select: { email: true } },
} as const;

/* ===== Associate inbox (IN_APP) ======================================== */

communicationsRouter.get('/me/inbox', async (req, res, next) => {
  try {
    const user = req.user!;
    const rows = await prisma.notification.findMany({
      where: { recipientUserId: user.id, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: NOTIF_INCLUDE,
    });
    const payload: NotificationListResponse = NotificationListResponseSchema.parse({
      notifications: rows.map(toNotif),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

communicationsRouter.post('/me/inbox/:id/read', async (req, res, next) => {
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
      data: { status: 'READ', readAt: new Date() },
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
    const channel = req.query.channel?.toString();
    const status = req.query.status?.toString();
    const where: Prisma.NotificationWhereInput = {
      ...(channel
        ? { channel: channel as Prisma.NotificationWhereInput['channel'] }
        : {}),
      ...(status ? { status: status as Prisma.NotificationWhereInput['status'] } : {}),
    };
    const rows = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: NOTIF_INCLUDE,
    });
    res.json(
      NotificationListResponseSchema.parse({ notifications: rows.map(toNotif) })
    );
  } catch (err) {
    next(err);
  }
});

communicationsRouter.post('/admin/send', MANAGE, async (req, res, next) => {
  try {
    const parsed = NotificationSendInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;

    const created = await prisma.notification.create({
      data: {
        channel: i.channel,
        status: 'QUEUED',
        recipientUserId: i.recipientUserId ?? null,
        recipientPhone: i.recipientPhone ?? null,
        recipientEmail: i.recipientEmail ?? null,
        subject: i.subject ?? null,
        body: i.body,
        category: i.category ?? null,
        senderUserId: req.user!.id,
      },
      include: NOTIF_INCLUDE,
    });

    // Stub the provider call.
    try {
      const { externalRef } = await sendStubbed(created.channel, {
        userId: created.recipientUserId,
        phone: created.recipientPhone,
        email: created.recipientEmail,
      });
      const sent = await prisma.notification.update({
        where: { id: created.id },
        data: { status: 'SENT', sentAt: new Date(), externalRef },
        include: NOTIF_INCLUDE,
      });
      res.status(201).json(toNotif(sent));
    } catch (sendErr) {
      const reason = sendErr instanceof Error ? sendErr.message : 'unknown error';
      const failed = await prisma.notification.update({
        where: { id: created.id },
        data: { status: 'FAILED', failureReason: reason },
        include: NOTIF_INCLUDE,
      });
      res.status(202).json(toNotif(failed));
    }
  } catch (err) {
    next(err);
  }
});

communicationsRouter.post('/admin/broadcast', MANAGE, async (req, res, next) => {
  try {
    const parsed = NotificationBroadcastInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const i = parsed.data;

    const where: Prisma.UserWhereInput = { deletedAt: null, status: 'ACTIVE' };
    if (i.audience === 'ALL_ASSOCIATES') where.role = 'ASSOCIATE';
    if (i.audience === 'ALL_HR') where.role = 'HR_ADMINISTRATOR';

    const recipients = await prisma.user.findMany({
      take: 1000,
      where,
      select: { id: true },
    });
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

    res.status(201).json({ count: created.count });
  } catch (err) {
    next(err);
  }
});
