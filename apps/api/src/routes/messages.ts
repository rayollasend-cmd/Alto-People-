import { Router } from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { UPLOAD_MAX_BYTES } from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, verifyFileMagic } from '../lib/uploads.js';
import { trackNotificationWork } from '../lib/notify.js';
import { emitLiveEvent } from '../lib/liveEvents.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import {
  canMessageAsync,
  canUseMessenger,
  regionClientIds,
  directoryWhere,
  displayName,
  ensureStoreChannels,
  fanOutMessage,
  roleLabel,
  syncStoreChannel,
  type Messenger,
} from '../lib/messaging.js';

/**
 * The in-app messenger.
 *
 *   GET  /messages/conversations                  inbox (unread counts, previews)
 *   POST /messages/conversations                  start a direct / group thread
 *   GET  /messages/conversations/:id?before=      the thread, paged; marks read
 *   POST /messages/conversations/:id/messages     append a message
 *   POST /messages/conversations/:id/attachments  append a photo (multipart "file")
 *   GET  /messages/attachments/:messageId         the photo
 *   POST /messages/conversations/:id/read         mark read
 *   GET  /messages/conversations/:id/transcript.csv   the dated record
 *   GET  /messages/directory?q=                   who the caller may message
 *   GET  /messages/search?q=                      across the caller's threads
 *   GET  /messages/unread                         one number for the badge
 *
 * Messages are immutable: there is no PATCH and no DELETE, by design.
 * Every read is scoped to the caller's own participations; a thread id
 * from another tenant is simply not found.
 */

export const messagesRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });
const PHOTO_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Conversation.lastPreview is VARCHAR(160) — the sender's name and the text together. */
const PREVIEW = 160;

/**
 * At most `max` characters, with an ellipsis when cut. Counted in code
 * points — what a Postgres VARCHAR counts — so an emoji is one character
 * and is never split in half.
 */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** RFC-4180 cell: quote when needed, double embedded quotes. */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  clientId: true,
  locationId: true,
  associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true, photoUpdatedAt: true } },
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function person(u: UserRow) {
  return {
    id: u.id,
    name: displayName(u),
    role: u.role,
    roleLabel: roleLabel(u.role),
    photoUrl: u.associate ? profilePhotoUrlFor(u.associate) : null,
  };
}

function me(req: { user?: Messenger & { role: string } }): Messenger {
  const u = req.user!;
  if (!canUseMessenger(u.role as Messenger['role'])) {
    throw new HttpError(403, 'forbidden', 'Messaging is not available for this account.');
  }
  return u;
}

/** The caller's participation row for a thread, or 404. */
async function myThread(userId: string, conversationId: string) {
  const p = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    include: {
      conversation: {
        include: {
          participants: { include: { user: { select: USER_SELECT } } },
        },
      },
    },
  });
  if (!p) throw new HttpError(404, 'not_found', 'Conversation not found');
  return p;
}

/** A thread's display title for one viewer: the store for a channel,
 *  the other person for a direct thread, the group title or names. */
function titleFor(
  convo: { kind: string; title: string | null; participants: Array<{ user: UserRow }> },
  viewerId: string,
): string {
  if (convo.kind === 'STORE_CHANNEL') return convo.title ?? 'Store';
  const others = convo.participants.filter((p) => p.user.id !== viewerId).map((p) => displayName(p.user));
  if (convo.kind === 'DIRECT') return others[0] ?? '—';
  return convo.title ?? others.slice(0, 3).join(', ') + (others.length > 3 ? ` +${others.length - 3}` : '');
}

/* ---- Inbox ------------------------------------------------------------ */

messagesRouter.get('/conversations', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    await ensureStoreChannels(user);
    const rows = await prisma.conversationParticipant.findMany({
      where: { userId: user.id },
      include: {
        conversation: {
          include: { participants: { include: { user: { select: USER_SELECT } } } },
        },
      },
      take: 200,
    });
    const unread = await Promise.all(
      rows.map((r) =>
        prisma.message.count({
          where: {
            conversationId: r.conversationId,
            senderId: { not: user.id },
            ...(r.lastReadAt ? { createdAt: { gt: r.lastReadAt } } : {}),
          },
        }),
      ),
    );
    const list = rows
      .map((r, i) => ({
        id: r.conversationId,
        kind: r.conversation.kind,
        title: titleFor(r.conversation, user.id),
        participants: r.conversation.participants.map((p) => person(p.user)),
        lastMessageAt: r.conversation.lastMessageAt?.toISOString() ?? null,
        lastPreview: r.conversation.lastPreview,
        unread: unread[i] ?? 0,
      }))
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || a.title.localeCompare(b.title));
    res.json({ conversations: list });
  } catch (err) {
    next(err);
  }
});

messagesRouter.get('/unread', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const rows = await prisma.conversationParticipant.findMany({
      where: { userId: user.id },
      select: { conversationId: true, lastReadAt: true },
      take: 500,
    });
    const counts = await Promise.all(
      rows.map((r) =>
        prisma.message.count({
          where: {
            conversationId: r.conversationId,
            senderId: { not: user.id },
            ...(r.lastReadAt ? { createdAt: { gt: r.lastReadAt } } : {}),
          },
        }),
      ),
    );
    res.json({ unread: counts.reduce((a, b) => a + b, 0) });
  } catch (err) {
    next(err);
  }
});

/* ---- Directory + start ------------------------------------------------ */

messagesRouter.get('/directory', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const q = (req.query.q?.toString() ?? '').trim();
    const regionClients =
      user.role === 'CLIENT_PORTAL' && !user.clientId && user.regionId ? await regionClientIds(user.regionId) : [];
    const rows = await prisma.user.findMany({
      where: {
        ...directoryWhere(user, regionClients),
        ...(q
          ? {
              OR: [
                { email: { contains: q, mode: 'insensitive' } },
                { associate: { firstName: { contains: q, mode: 'insensitive' } } },
                { associate: { lastName: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: { ...USER_SELECT, client: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      take: 100,
    });
    res.json({
      people: rows.map((u) => ({ ...person(u), clientName: u.client?.name ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

const StartSchema = z.object({
  participantIds: z.array(z.string().uuid()).min(1).max(20),
  title: z.string().trim().max(120).optional(),
  /** Optional first message, sent in the same call. */
  body: z.string().trim().max(4000).optional(),
});

messagesRouter.post('/conversations', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const input = StartSchema.parse(req.body);
    const ids = [...new Set(input.participantIds)].filter((id) => id !== user.id);
    if (ids.length === 0) throw new HttpError(400, 'no_participants', 'Pick at least one person.');
    const targets = await prisma.user.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', deletedAt: null },
      select: USER_SELECT,
    });
    if (targets.length !== ids.length) throw new HttpError(404, 'not_found', 'Someone on that list was not found.');
    for (const t of targets) {
      if (!(await canMessageAsync(user, t))) {
        throw new HttpError(403, 'forbidden', `You can't message ${displayName(t)} from this account.`);
      }
    }
    // A direct thread between two people is unique: reuse it.
    let conversationId: string | null = null;
    let createdNow = false;
    if (targets.length === 1) {
      const existing = await prisma.conversation.findFirst({
        where: {
          kind: 'DIRECT',
          AND: [
            { participants: { some: { userId: user.id } } },
            { participants: { some: { userId: targets[0]!.id } } },
          ],
        },
        select: { id: true },
      });
      conversationId = existing?.id ?? null;
    }
    if (!conversationId) {
      const clientIds = new Set(
        [user.clientId, ...targets.map((t) => t.clientId)].filter((c): c is string => !!c),
      );
      const created = await prisma.conversation.create({
        data: {
          kind: targets.length === 1 ? 'DIRECT' : 'GROUP',
          title: targets.length === 1 ? null : (input.title ?? null),
          clientId: clientIds.size === 1 ? [...clientIds][0]! : null,
          createdById: user.id,
          participants: { create: [user.id, ...targets.map((t) => t.id)].map((userId) => ({ userId })) },
        },
        select: { id: true },
      });
      conversationId = created.id;
      createdNow = true;
    }
    if (input.body) {
      try {
        await appendMessage(user, conversationId, { body: input.body });
      } catch (err) {
        // A new thread whose first message didn't go through is removed,
        // so trying again doesn't leave an empty group behind each time.
        if (createdNow) await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => undefined);
        throw err;
      }
    }
    res.status(201).json({ id: conversationId });
  } catch (err) {
    next(err);
  }
});

/* ---- The thread ------------------------------------------------------- */

messagesRouter.get('/conversations/:id', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const p = await myThread(user.id, req.params.id);
    const before = req.query.before?.toString();
    const beforeAt = before ? new Date(before) : null;
    const limit = Math.min(200, Math.max(20, Number(req.query.limit ?? 60) || 60));
    const messages = await prisma.message.findMany({
      where: {
        conversationId: p.conversationId,
        ...(beforeAt && !Number.isNaN(beforeAt.getTime()) ? { createdAt: { lt: beforeAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      include: { sender: { select: USER_SELECT } },
    });
    const hasMore = messages.length > limit;
    const page = messages.slice(0, limit).reverse();
    // Opening the thread reads it.
    const now = new Date();
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: p.conversationId, userId: user.id } },
      data: { lastReadAt: now },
    });
    const others = p.conversation.participants.filter((x) => x.userId !== user.id);
    res.json({
      id: p.conversationId,
      kind: p.conversation.kind,
      title: titleFor(p.conversation, user.id),
      participants: p.conversation.participants.map((x) => ({
        ...person(x.user),
        lastReadAt: x.lastReadAt?.toISOString() ?? null,
      })),
      // "Seen by everyone" line: the latest instant every other participant has read up to.
      seenUpTo:
        others.length > 0 && others.every((x) => x.lastReadAt)
          ? new Date(Math.min(...others.map((x) => x.lastReadAt!.getTime()))).toISOString()
          : null,
      hasMore,
      messages: page.map((m) => ({
        id: m.id,
        kind: m.kind,
        body: m.body,
        senderId: m.senderId,
        senderName: m.sender ? displayName(m.sender) : null,
        senderRole: m.sender ? roleLabel(m.sender.role) : null,
        mine: m.senderId === user.id,
        attachment: m.attachmentKey
          ? { url: `/api/messages/attachments/${m.id}`, name: m.attachmentName, type: m.attachmentType }
          : null,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

async function appendMessage(
  user: Messenger,
  conversationId: string,
  input: { body: string; attachment?: { key: string; type: string; name: string } },
): Promise<{ id: string; createdAt: Date }> {
  const p = await myThread(user.id, conversationId);
  const body = input.body.trim();
  if (!body && !input.attachment) throw new HttpError(400, 'empty', 'Write something.');
  const sender = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: USER_SELECT });
  const preview = clip(body || `📷 ${input.attachment?.name ?? 'photo'}`, PREVIEW);
  const created = await prisma.$transaction(async (tx) => {
    const m = await tx.message.create({
      data: {
        conversationId,
        senderId: user.id,
        body,
        attachmentKey: input.attachment?.key ?? null,
        attachmentType: input.attachment?.type ?? null,
        attachmentName: input.attachment?.name ?? null,
      },
      select: { id: true, createdAt: true },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      // The name and the text share the column's 160 characters. It was
      // the text alone that was cut to 160, so with the name in front any
      // message over ~150 characters — two or three sentences — overflowed
      // the column, and the whole send failed.
      data: { lastMessageAt: m.createdAt, lastPreview: clip(`${displayName(sender)}: ${preview}`, PREVIEW) },
    });
    await tx.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: user.id } },
      data: { lastReadAt: m.createdAt },
    });
    return m;
  });
  // A store channel is re-synced first, so today's new manager hears this
  // message and yesterday's transfer does not.
  const synced = p.conversation.kind === 'STORE_CHANNEL' ? await syncStoreChannel(conversationId) : null;
  const recipients = (synced ?? p.conversation.participants.map((x) => x.userId)).filter((id) => id !== user.id);
  void trackNotificationWork(
    fanOutMessage({
      conversationId,
      // What the recipient sees on the bell: the store for a channel, the
      // sender for a direct thread, the group name otherwise.
      title:
        p.conversation.kind === 'DIRECT'
          ? displayName(sender)
          : titleFor(p.conversation, user.id),
      senderName: displayName(sender),
      preview,
      recipientIds: recipients,
    }),
  );
  // The sender's other tabs refresh too.
  emitLiveEvent(user.id, 'message');
  return created;
}

const SendSchema = z.object({ body: z.string().max(4000) });

messagesRouter.post('/conversations/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const input = SendSchema.parse(req.body);
    const m = await appendMessage(user, req.params.id, { body: input.body });
    res.status(201).json({ id: m.id, createdAt: m.createdAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

messagesRouter.post(
  '/conversations/:id/attachments',
  requireAuth,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const user = me(req);
      if (!req.file) throw new HttpError(400, 'no_file', 'A "file" multipart field is required');
      if (!PHOTO_MIMES.has(req.file.mimetype)) {
        throw new HttpError(400, 'invalid_type', 'Photos must be PNG, JPEG, or WebP.');
      }
      const magicError = verifyFileMagic(req.file.buffer, req.file.mimetype);
      if (magicError) throw new HttpError(400, 'invalid_file_contents', magicError);
      const cleanName = sanitizeUploadFilename(req.file.originalname);
      const sha = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 16);
      const key = `messages/${randomUUID()}-${sha}${extname(cleanName).toLowerCase() || '.jpg'}`;
      await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
      const caption = typeof req.body?.body === 'string' ? req.body.body : '';
      const m = await appendMessage(user, req.params.id, {
        body: caption,
        attachment: { key, type: req.file.mimetype, name: cleanName },
      });
      res.status(201).json({ id: m.id, createdAt: m.createdAt.toISOString() });
    } catch (err) {
      next(err);
    }
  },
);

messagesRouter.get('/attachments/:messageId', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const m = await prisma.message.findFirst({
      where: {
        id: req.params.messageId,
        conversation: { participants: { some: { userId: user.id } } },
        attachmentKey: { not: null },
      },
      select: { attachmentKey: true, attachmentType: true },
    });
    if (!m || !m.attachmentKey) throw new HttpError(404, 'not_found', 'Attachment not found');
    const buf = await getBlobStore().get(m.attachmentKey);
    if (!buf) throw new HttpError(404, 'not_found', 'Attachment not found');
    res.setHeader('Content-Type', m.attachmentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

messagesRouter.post('/conversations/:id/read', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    await myThread(user.id, req.params.id);
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId: req.params.id, userId: user.id } },
      data: { lastReadAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ---- The record --------------------------------------------------------- */

messagesRouter.get('/conversations/:id/transcript.csv', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const p = await myThread(user.id, req.params.id);
    const messages = await prisma.message.findMany({
      where: { conversationId: p.conversationId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: USER_SELECT } },
      take: 10000,
    });
    const title = titleFor(p.conversation, user.id);
    const lines = [
      ['Sent at (UTC)', 'From', 'Role', 'Message', 'Attachment'].map(csvCell).join(','),
      ...messages.map((m) =>
        [
          m.createdAt.toISOString(),
          m.sender ? displayName(m.sender) : 'System',
          m.sender ? roleLabel(m.sender.role) : '',
          m.body,
          m.attachmentName ?? '',
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="messages-${title.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(`\uFEFF${lines.join('\r\n')}`);
  } catch (err) {
    next(err);
  }
});

messagesRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const user = me(req);
    const q = (req.query.q?.toString() ?? '').trim();
    if (q.length < 2) {
      res.json({ results: [] });
      return;
    }
    const rows = await prisma.message.findMany({
      where: {
        conversation: { participants: { some: { userId: user.id } } },
        body: { contains: q, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        sender: { select: USER_SELECT },
        conversation: { include: { participants: { include: { user: { select: USER_SELECT } } } } },
      },
    });
    res.json({
      results: rows.map((m) => ({
        conversationId: m.conversationId,
        conversationTitle: titleFor(m.conversation, user.id),
        messageId: m.id,
        body: m.body,
        senderName: m.sender ? displayName(m.sender) : null,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});
