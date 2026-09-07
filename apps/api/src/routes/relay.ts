import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { computeRelayBoard } from '../lib/relayBoard.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';

/**
 * THE RELAY + threads on the work.
 *
 * GET  /relay/board — the one shared operating picture: first-paycheck
 *      lanes, batons with holders and due dates, and the self-writing
 *      Monday-pack agenda. Identical for every department head.
 * GET  /work-notes  — the thread on an object (an associate record).
 * POST /work-notes  — add a note; desk @mentions ring the other building
 *      with the full context attached.
 *
 * All gated on view:org — the staff tier every department head holds;
 * associates and client portals never see any of it.
 */

export const relayRouter = Router();

const STAFF = requireCapability('view:org');

relayRouter.get('/relay/board', STAFF, async (_req, res, next) => {
  try {
    res.json(await computeRelayBoard(prisma));
  } catch (err) {
    next(err);
  }
});

/* ---- Threads on the work -------------------------------------------- */

const SUBJECT_TYPES = z.enum(['ASSOCIATE']);
const DESKS = z.enum(['FINANCE', 'HR', 'WORKFORCE']);

const DESK_ROLES: Record<z.infer<typeof DESKS>, string[]> = {
  FINANCE: ['FINANCE_ACCOUNTANT'],
  HR: ['HR_ADMINISTRATOR', 'OPERATIONS_MANAGER'],
  WORKFORCE: ['WORKFORCE_MANAGER'],
};

relayRouter.get('/work-notes', STAFF, async (req, res, next) => {
  try {
    const subjectType = SUBJECT_TYPES.parse(req.query.subjectType);
    const subjectKey = z.string().uuid().parse(req.query.subjectKey);
    const rows = await prisma.workNote.findMany({
      where: { subjectType, subjectKey },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: {
        authorUser: {
          select: {
            email: true,
            associate: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    res.json({
      notes: rows.map((n) => ({
        id: n.id,
        body: n.body,
        mentions: n.mentions,
        createdAt: n.createdAt.toISOString(),
        authorEmail: n.authorUser?.email ?? null,
        authorName: n.authorUser?.associate
          ? `${n.authorUser.associate.firstName} ${n.authorUser.associate.lastName}`.trim()
          : (n.authorUser?.email.split('@')[0] ?? null),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const NoteInputSchema = z.object({
  subjectType: SUBJECT_TYPES,
  subjectKey: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
  mentionDesks: z.array(DESKS).max(3).default([]),
});

relayRouter.post('/work-notes', STAFF, async (req, res, next) => {
  try {
    const input = NoteInputSchema.parse(req.body);

    // The subject must exist — a thread on nothing is a typo, not a note.
    const associate = await prisma.associate.findFirst({
      where: { id: input.subjectKey, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!associate) {
      throw new HttpError(404, 'subject_not_found', 'Associate not found.');
    }

    const created = await prisma.workNote.create({
      data: {
        subjectType: input.subjectType,
        subjectKey: input.subjectKey,
        body: input.body,
        authorUserId: req.user!.id,
        mentions: input.mentionDesks,
      },
    });

    // Desk @mentions: the note lands on the other building's bell with
    // the person and the thread one click away. Never the author's own
    // bell, even when they mention their own desk.
    if (input.mentionDesks.length > 0) {
      const roles = [...new Set(input.mentionDesks.flatMap((d) => DESK_ROLES[d]))];
      const who = `${associate.firstName} ${associate.lastName}`.trim();
      const preview =
        input.body.length > 160 ? `${input.body.slice(0, 160)}…` : input.body;
      void trackNotificationWork(
        (async () => {
          const recipients = await prisma.user.findMany({
            where: {
              status: 'ACTIVE',
              role: { in: roles as never[] },
              id: { not: req.user!.id },
            },
            select: { id: true },
            take: 50,
          });
          await Promise.all(
            recipients.map((u) =>
              notifyUser(u.id, {
                subject: `Thread on ${who} — your desk was mentioned`,
                body: `${req.user!.email} wrote on ${who}'s record: "${preview}"`,
                category: 'work-thread',
                linkUrl: `/people?associateId=${input.subjectKey}&tab=thread`,
              }),
            ),
          );
        })(),
      );
    }

    res.status(201).json({ id: created.id });
  } catch (err) {
    next(err);
  }
});
