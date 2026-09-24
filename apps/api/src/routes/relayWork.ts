import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';
import { getBlobStore } from '../lib/blobStore.js';
import { sanitizeUploadFilename, safeContentDisposition, verifyFileMagic } from '../lib/uploads.js';

/**
 * THE WORKSTATION — what one desk sends another, and the documents the
 * work runs on.
 *
 *   requests  ask HR a question, send Recruiting a document, hand Finance
 *             a task. It lands on that desk (or on one person there),
 *             anyone on the desk can pick it up, and the thread keeps the
 *             answer where the next person will look for it.
 *   files     the working shelf: upload, tag, keep it yours or put it on a
 *             desk's, attach it to a request. NOT the associate's document
 *             vault — that stays on their record with its own retention.
 *
 * Staff only (view:org), like the rest of the relay.
 */

export const relayWorkRouter = Router();

const STAFF = requireCapability('view:org');

const DESKS = z.enum(['HR', 'RECRUITING', 'WORKFORCE', 'FINANCE']);
type Desk = z.infer<typeof DESKS>;

/** Who answers for each desk. */
const DESK_ROLES: Record<Desk, string[]> = {
  HR: ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'],
  RECRUITING: ['INTERNAL_RECRUITER'],
  WORKFORCE: ['WORKFORCE_MANAGER'],
  FINANCE: ['FINANCE_ACCOUNTANT'],
};

export function deskOfRole(role: string): Desk | null {
  for (const [desk, roles] of Object.entries(DESK_ROLES)) if (roles.includes(role)) return desk as Desk;
  return null;
}

const personSelect = {
  id: true,
  email: true,
  role: true,
  associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true } },
} as const;

type PersonRow = {
  id: string;
  email: string;
  role: string;
  associate: { id: string; firstName: string; lastName: string; photoS3Key: string | null } | null;
};

function person(u: PersonRow | null) {
  if (!u) return null;
  return {
    userId: u.id,
    name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : (u.email.split('@')[0] ?? u.email),
    photoUrl: u.associate?.photoS3Key ? `/api/associates/${u.associate.id}/photo` : null,
    desk: deskOfRole(u.role),
  };
}

const fileSelect = {
  id: true,
  name: true,
  mime: true,
  size: true,
  desk: true,
  tags: true,
  requestId: true,
  createdAt: true,
  uploadedBy: { select: personSelect },
  about: { select: { id: true, firstName: true, lastName: true } },
} as const;

type FileRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  desk: string | null;
  tags: string[];
  requestId: string | null;
  createdAt: Date;
  uploadedBy: PersonRow | null;
  about: { id: string; firstName: string; lastName: string } | null;
};

function fileView(f: FileRow) {
  return {
    id: f.id,
    name: f.name,
    mime: f.mime,
    size: f.size,
    desk: f.desk as Desk | null,
    tags: f.tags,
    requestId: f.requestId,
    createdAt: f.createdAt.toISOString(),
    uploadedBy: person(f.uploadedBy),
    about: f.about ? { associateId: f.about.id, name: `${f.about.firstName} ${f.about.lastName}`.trim() } : null,
    url: `/api/relay/files/${f.id}/download`,
  };
}

const requestInclude = {
  from: { select: personSelect },
  toUser: { select: personSelect },
  claimedBy: { select: personSelect },
  about: { select: { id: true, firstName: true, lastName: true } },
  files: { where: { deletedAt: null, messageId: null }, select: fileSelect },
  _count: { select: { messages: true } },
} as const;

type RequestRow = Prisma.RelayRequestGetPayload<{ include: typeof requestInclude }>;
type MessageRow = Prisma.RelayMessageGetPayload<{
  include: {
    author: { select: typeof personSelect };
    files: { where: { deletedAt: null }; select: typeof fileSelect };
  };
}>;

function requestView(
  r: RequestRow & { messages?: MessageRow[] },
  meId: string,
  myDesk: Desk | null,
  withMessages = false,
) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subject: r.subject,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    dueAt: r.dueAt?.toISOString() ?? null,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    from: person(r.from),
    toDesk: r.toDesk as Desk,
    toUser: person(r.toUser),
    claimedBy: person(r.claimedBy),
    about: r.about ? { associateId: r.about.id, name: `${r.about.firstName} ${r.about.lastName}`.trim() } : null,
    files: (r.files ?? []).map(fileView),
    replies: r._count?.messages ?? (r.messages?.length ?? 0),
    // It's waiting on this viewer: their desk holds it, or it was addressed to them.
    mine: r.toUserId === meId || (!r.toUserId && r.toDesk === myDesk),
    ...(withMessages
      ? {
          messages: (r.messages ?? []).map((m) => ({
            id: m.id,
            body: m.body,
            createdAt: m.createdAt.toISOString(),
            author: person(m.author),
            files: (m.files ?? []).map(fileView),
          })),
        }
      : {}),
  };
}

/** Everyone who should hear about a request: the desk, or the one person. */
async function recipients(toDesk: Desk, toUserId: string | null, exceptUserId: string): Promise<string[]> {
  if (toUserId) return toUserId === exceptUserId ? [] : [toUserId];
  const rows = await prisma.user.findMany({
    where: { status: 'ACTIVE', deletedAt: null, role: { in: DESK_ROLES[toDesk] as never[] }, id: { not: exceptUserId } },
    select: { id: true },
    take: 50,
  });
  return rows.map((r) => r.id);
}

/* ---- Requests --------------------------------------------------------- */

const ListQuery = z.object({
  box: z.enum(['inbox', 'sent', 'all']).default('inbox'),
  status: z.enum(['open', 'all']).default('open'),
});

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS', 'ANSWERED'] as const;

relayWorkRouter.get('/relay/requests', STAFF, async (req, res, next) => {
  try {
    const q = ListQuery.parse(req.query);
    const me = req.user!.id;
    const myDesk = deskOfRole(req.user!.role);
    const mine = myDesk
      ? { OR: [{ toUserId: me }, { toUserId: null, toDesk: myDesk }] }
      : { toUserId: me };
    const where =
      q.box === 'inbox' ? mine : q.box === 'sent' ? { fromUserId: me } : {};
    const [rows, inbox, sent] = await Promise.all([
      prisma.relayRequest.findMany({
        where: { ...where, ...(q.status === 'open' ? { status: { in: [...OPEN_STATUSES] } } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        include: requestInclude,
      }),
      prisma.relayRequest.count({ where: { ...mine, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.relayRequest.count({ where: { fromUserId: me, status: { in: [...OPEN_STATUSES] } } }),
    ]);
    res.json({
      requests: rows.map((r) => requestView(r, me, myDesk)),
      counts: { inbox, sent, unanswered: rows.filter((r) => r.status === 'OPEN').length },
    });
  } catch (err) {
    next(err);
  }
});

const CreateSchema = z.object({
  kind: z.enum(['ASK', 'SEND', 'TASK']),
  toDesk: DESKS,
  toUserId: z.string().uuid().optional(),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(2).max(4000),
  dueAt: z.string().datetime().optional(),
  aboutAssociateId: z.string().uuid().optional(),
  fileIds: z.array(z.string().uuid()).max(20).optional(),
});

relayWorkRouter.post('/relay/requests', STAFF, async (req, res, next) => {
  try {
    const input = CreateSchema.parse(req.body);
    const me = req.user!.id;
    if (input.toUserId) {
      const to = await prisma.user.findFirst({ where: { id: input.toUserId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
      if (!to) throw new HttpError(404, 'user_not_found', 'That person isn’t here to send to.');
    }
    if (input.aboutAssociateId) {
      const a = await prisma.associate.findFirst({ where: { id: input.aboutAssociateId, deletedAt: null }, select: { id: true } });
      if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found.');
    }
    const created = await prisma.relayRequest.create({
      data: {
        kind: input.kind,
        toDesk: input.toDesk,
        toUserId: input.toUserId ?? null,
        fromUserId: me,
        subject: input.subject,
        body: input.body,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        aboutAssociateId: input.aboutAssociateId ?? null,
      },
      select: { id: true },
    });
    // The files ride along — only the sender's own loose ones.
    if (input.fileIds?.length) {
      await prisma.relayFile.updateMany({
        where: { id: { in: input.fileIds }, uploadedById: me, requestId: null, deletedAt: null },
        data: { requestId: created.id },
      });
    }
    const full = await prisma.relayRequest.findUniqueOrThrow({ where: { id: created.id }, include: requestInclude });
    enqueueAudit(
      { actorUserId: me, action: 'relay.request_sent', entityType: 'RelayRequest', entityId: created.id, metadata: { toDesk: input.toDesk, kind: input.kind } },
      'relay.work',
    );
    const who = person(full.from as PersonRow)?.name ?? 'A teammate';
    void trackNotificationWork(
      (async () => {
        for (const userId of await recipients(input.toDesk, input.toUserId ?? null, me)) {
          await notifyUser(userId, {
            subject: `${who}: ${input.subject}`,
            body: input.body.length > 200 ? `${input.body.slice(0, 200)}…` : input.body,
            category: 'relay.request',
            linkUrl: `/relay?tab=requests&request=${created.id}`,
          });
        }
      })(),
    );
    res.status(201).json({ request: requestView(full, me, deskOfRole(req.user!.role)) });
  } catch (err) {
    next(err);
  }
});

relayWorkRouter.get('/relay/requests/:id', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const r = await prisma.relayRequest.findUnique({
      where: { id },
      include: {
        ...requestInclude,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          include: { author: { select: personSelect }, files: { where: { deletedAt: null }, select: fileSelect } },
        },
      },
    });
    if (!r) throw new HttpError(404, 'not_found', 'Request not found.');
    res.json({ request: requestView(r, req.user!.id, deskOfRole(req.user!.role), true) });
  } catch (err) {
    next(err);
  }
});

const ReplySchema = z.object({
  body: z.string().trim().min(1).max(4000),
  fileIds: z.array(z.string().uuid()).max(20).optional(),
});

relayWorkRouter.post('/relay/requests/:id/messages', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = ReplySchema.parse(req.body);
    const me = req.user!.id;
    const r = await prisma.relayRequest.findUnique({ where: { id }, include: { from: { select: personSelect } } });
    if (!r) throw new HttpError(404, 'not_found', 'Request not found.');
    if (r.status === 'CLOSED') throw new HttpError(409, 'closed', 'This one is closed — reopen it to add to the thread.');
    const message = await prisma.relayMessage.create({
      data: { requestId: id, authorUserId: me, body: input.body },
      select: { id: true },
    });
    if (input.fileIds?.length) {
      await prisma.relayFile.updateMany({
        where: { id: { in: input.fileIds }, uploadedById: me, requestId: null, deletedAt: null },
        data: { requestId: id, messageId: message.id },
      });
    }
    // Answering on the desk moves it along; the sender's reply reopens it.
    const answering = r.fromUserId !== me;
    await prisma.relayRequest.update({
      where: { id },
      data: {
        updatedAt: new Date(),
        ...(answering && r.status === 'OPEN' ? { status: 'IN_PROGRESS' } : {}),
        ...(!answering && r.status === 'ANSWERED' ? { status: 'IN_PROGRESS', answeredAt: null } : {}),
      },
    });
    const full = await prisma.relayMessage.findUniqueOrThrow({
      where: { id: message.id },
      include: { author: { select: personSelect }, files: { where: { deletedAt: null }, select: fileSelect } },
    });
    const who = person(full.author as PersonRow)?.name ?? 'A teammate';
    void trackNotificationWork(
      (async () => {
        const to = answering ? [r.fromUserId] : await recipients(r.toDesk as Desk, r.toUserId, me);
        for (const userId of to.filter((u) => u && u !== me)) {
          await notifyUser(userId!, {
            subject: `${who} replied: ${r.subject}`,
            body: input.body.length > 200 ? `${input.body.slice(0, 200)}…` : input.body,
            category: 'relay.request',
            linkUrl: `/relay?tab=requests&request=${id}`,
          });
        }
      })(),
    );
    res.status(201).json({
      message: {
        id: full.id,
        body: full.body,
        createdAt: full.createdAt.toISOString(),
        author: person(full.author as PersonRow),
        files: full.files.map(fileView),
      },
    });
  } catch (err) {
    next(err);
  }
});

const PatchSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'ANSWERED', 'CLOSED']).optional(),
  claim: z.boolean().optional(),
});

relayWorkRouter.patch('/relay/requests/:id', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = PatchSchema.parse(req.body);
    const me = req.user!.id;
    const r = await prisma.relayRequest.findUnique({ where: { id }, select: { id: true, fromUserId: true, toDesk: true, toUserId: true, subject: true, status: true } });
    if (!r) throw new HttpError(404, 'not_found', 'Request not found.');
    const myDesk = deskOfRole(req.user!.role);
    const onDesk = r.toUserId === me || (!r.toUserId && r.toDesk === myDesk);
    // Closing is the asker's call (they decide they have their answer);
    // everything else belongs to the desk holding it.
    if (input.status === 'CLOSED' && r.fromUserId !== me && !onDesk) {
      throw new HttpError(403, 'not_yours', 'Only the person who asked, or the desk holding it, can close it.');
    }
    const updated = await prisma.relayRequest.update({
      where: { id },
      data: {
        ...(input.claim ? { claimedById: me, status: r.status === 'OPEN' ? 'IN_PROGRESS' : r.status } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.status === 'ANSWERED' ? { answeredAt: new Date() } : {}),
        ...(input.status === 'CLOSED' ? { closedAt: new Date(), closedById: me } : {}),
        ...(input.status === 'OPEN' ? { closedAt: null, closedById: null, answeredAt: null } : {}),
      },
      include: requestInclude,
    });
    enqueueAudit(
      { actorUserId: me, action: 'relay.request_updated', entityType: 'RelayRequest', entityId: id, metadata: { status: input.status ?? null, claimed: !!input.claim } },
      'relay.work',
    );
    if (input.status === 'ANSWERED' && r.fromUserId !== me) {
      void trackNotificationWork(
        notifyUser(r.fromUserId, {
          subject: `Answered: ${r.subject}`,
          body: 'Your request has an answer on the relay.',
          category: 'relay.request',
          linkUrl: `/relay?tab=requests&request=${id}`,
        }),
      );
    }
    res.json({ request: requestView(updated, me, myDesk) });
  } catch (err) {
    next(err);
  }
});

/* ---- The shelf: work documents ---------------------------------------- */

const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** PDFs, images, office documents, text, archives. Nothing that runs. */
const ALLOWED_MIME =
  /^(application\/pdf|image\/(png|jpeg|webp|gif|heic)|text\/(plain|csv|markdown)|application\/(zip|x-zip-compressed|rtf|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.oasis\.opendocument\.[a-z]+))$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

const FileQuery = z.object({
  scope: z.enum(['mine', 'desk', 'all']).default('all'),
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(40).optional(),
});

relayWorkRouter.get('/relay/files', STAFF, async (req, res, next) => {
  try {
    const q = FileQuery.parse(req.query);
    const me = req.user!.id;
    const myDesk = deskOfRole(req.user!.role);
    // Asking for "my desk's shelf" without a desk of your own is an empty shelf.
    if (q.scope === 'desk' && !myDesk) {
      res.json({ files: [], tags: [] });
      return;
    }
    const where: Prisma.RelayFileWhereInput = {
      deletedAt: null,
      ...(q.scope === 'mine' ? { uploadedById: me } : {}),
      ...(q.scope === 'desk' && myDesk ? { desk: myDesk } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' as const } },
              { tags: { has: q.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [files, everything] = await Promise.all([
      prisma.relayFile.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, select: fileSelect }),
      prisma.relayFile.findMany({ where: { deletedAt: null }, select: { tags: true }, take: 500 }),
    ]);
    res.json({
      files: files.map(fileView),
      tags: [...new Set(everything.flatMap((f) => f.tags))].sort().slice(0, 24),
    });
  } catch (err) {
    next(err);
  }
});

relayWorkRouter.post('/relay/files', STAFF, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'no_file', 'Choose a file to put on the shelf.');
    const desk = req.body?.desk ? DESKS.parse(req.body.desk) : null;
    const aboutAssociateId = req.body?.aboutAssociateId ? z.string().uuid().parse(req.body.aboutAssociateId) : null;
    const tags = String(req.body?.tags ?? '')
      .split(',')
      .map((t: string) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8);
    // What the work actually runs on — and nothing executable.
    const name = sanitizeUploadFilename(req.file.originalname);
    if (!ALLOWED_MIME.test(req.file.mimetype)) {
      throw new HttpError(415, 'unsupported_file', 'Documents, spreadsheets, images, PDFs and zips — that type isn’t one of them.');
    }
    // The bytes must be what the type claims — the document vault's guard.
    const wrong = verifyFileMagic(req.file.buffer, req.file.mimetype);
    if (wrong) throw new HttpError(415, 'unsupported_file', wrong);
    if (aboutAssociateId) {
      const a = await prisma.associate.findFirst({ where: { id: aboutAssociateId, deletedAt: null }, select: { id: true } });
      if (!a) throw new HttpError(404, 'associate_not_found', 'Associate not found.');
    }
    const id = randomUUID();
    const key = `relay-work/${id}/${name}`;
    await getBlobStore().put(key, req.file.buffer, req.file.mimetype);
    const created = await prisma.relayFile.create({
      data: {
        id,
        name,
        key,
        mime: req.file.mimetype,
        size: req.file.size,
        uploadedById: req.user!.id,
        desk,
        tags,
        aboutAssociateId,
      },
      select: fileSelect,
    });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'relay.file_added', entityType: 'RelayFile', entityId: id, metadata: { desk, size: req.file.size } },
      'relay.work',
    );
    res.status(201).json({ file: fileView(created) });
  } catch (err) {
    next(err);
  }
});

relayWorkRouter.get('/relay/files/:id/download', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const f = await prisma.relayFile.findFirst({ where: { id, deletedAt: null }, select: { key: true, name: true, mime: true } });
    if (!f) throw new HttpError(404, 'not_found', 'That document is no longer here.');
    const blob = await getBlobStore().get(f.key);
    if (!blob) throw new HttpError(410, 'file_missing', 'The file behind this record is gone.');
    res.setHeader('Content-Type', f.mime);
    // Inline unless the browser asked to save it (the download link does).
    res.setHeader('Content-Disposition', safeContentDisposition(f.name, req.query.download !== '1'));
    res.send(blob);
  } catch (err) {
    next(err);
  }
});

relayWorkRouter.delete('/relay/files/:id', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const f = await prisma.relayFile.findFirst({ where: { id, deletedAt: null }, select: { uploadedById: true } });
    if (!f) throw new HttpError(404, 'not_found', 'That document is no longer here.');
    // Yours to take off the shelf — or an administrator's.
    if (f.uploadedById !== req.user!.id && req.user!.role !== 'HR_ADMINISTRATOR') {
      throw new HttpError(403, 'not_yours', 'Only whoever put it there can take it off.');
    }
    await prisma.relayFile.update({ where: { id }, data: { deletedAt: new Date() } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'relay.file_removed', entityType: 'RelayFile', entityId: id }, 'relay.work');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
