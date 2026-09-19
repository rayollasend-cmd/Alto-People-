import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { BATON_LABELS, computeRelayBoard, computeSingleLane } from '../lib/relayBoard.js';
import { notifyUser, trackNotificationWork } from '../lib/notify.js';
import { enqueueAudit } from '../lib/audit.js';

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

type DeskKey = 'FINANCE' | 'HR' | 'WORKFORCE';

interface Person {
  userId: string;
  name: string;
  photoUrl: string | null;
}

const personSelect = {
  id: true,
  email: true,
  associate: { select: { id: true, firstName: true, lastName: true, photoS3Key: true } },
} as const;

function personOf(u: {
  id: string;
  email: string;
  associate: { id: string; firstName: string; lastName: string; photoS3Key: string | null } | null;
}): Person {
  return {
    userId: u.id,
    name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : (u.email.split('@')[0] ?? u.email),
    photoUrl: u.associate?.photoS3Key ? `/api/associates/${u.associate.id}/photo` : null,
  };
}

/**
 * GET /relay/board — the board, plus what makes it a shared room: the
 * people on each desk, who holds each lane / baton / client request, how
 * long each new hire's thread is, and which desk the viewer answers for.
 */
relayRouter.get('/relay/board', STAFF, async (req, res, next) => {
  try {
    const board = await computeRelayBoard(prisma);
    const laneIds = board.lanes.map((l) => l.associateId);
    const [deskUsers, claims, noteCounts] = await Promise.all([
      prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          role: { in: [...new Set(Object.values(DESK_ROLES).flat())] as never[] },
        },
        orderBy: { email: 'asc' },
        take: 200,
        select: { ...personSelect, role: true },
      }),
      prisma.relayClaim.findMany({
        take: 1000,
        select: {
          subjectType: true,
          subjectKey: true,
          claimedAt: true,
          user: { select: personSelect },
          claimedBy: { select: personSelect },
        },
      }),
      laneIds.length
        ? prisma.workNote.groupBy({
            by: ['subjectKey'],
            where: { subjectType: 'ASSOCIATE', subjectKey: { in: laneIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const desks: Record<DeskKey, Person[]> = { HR: [], WORKFORCE: [], FINANCE: [] };
    for (const u of deskUsers) {
      const d = deskOf(u.role);
      if (d) desks[d].push(personOf(u));
    }
    const notesBy = new Map(noteCounts.map((n) => [n.subjectKey, n._count._all]));
    res.json({
      ...board,
      lanes: board.lanes.map((l) => ({ ...l, notes: notesBy.get(l.associateId) ?? 0 })),
      desks,
      claims: Object.fromEntries(
        claims.map((c) => [
          `${c.subjectType}:${c.subjectKey}`,
          {
            ...personOf(c.user),
            claimedAt: c.claimedAt.toISOString(),
            claimedByName: c.claimedBy ? personOf(c.claimedBy).name : null,
          },
        ]),
      ),
      me: { userId: req.user!.id, desk: deskOf(req.user!.role) },
    });
  } catch (err) {
    next(err);
  }
});

/* ---- Who holds it: claims and hand-offs ------------------------------- */

const ClaimSubjectSchema = z.object({
  subjectType: z.enum(['LANE', 'BATON', 'REQUEST']),
  subjectKey: z.string().trim().min(1).max(80),
});

/** What a claim is on, in words — and whether it exists at all. */
async function describeSubject(type: 'LANE' | 'BATON' | 'REQUEST', key: string): Promise<string> {
  if (type === 'LANE') {
    const id = z.string().uuid().safeParse(key);
    const a = id.success
      ? await prisma.associate.findFirst({ where: { id: key, deletedAt: null }, select: { firstName: true, lastName: true } })
      : null;
    if (!a) throw new HttpError(404, 'subject_not_found', 'No such lane.');
    return `${a.firstName} ${a.lastName}’s first-paycheck lane`;
  }
  if (type === 'REQUEST') {
    const id = z.string().uuid().safeParse(key);
    const r = id.success
      ? await prisma.clientRequest.findUnique({ where: { id: key }, select: { subject: true, client: { select: { name: true } } } })
      : null;
    if (!r) throw new HttpError(404, 'subject_not_found', 'No such client request.');
    return `${r.client.name}’s request “${r.subject}”`;
  }
  const label = Object.prototype.hasOwnProperty.call(BATON_LABELS, key) ? BATON_LABELS[key] : undefined;
  if (!label) throw new HttpError(404, 'subject_not_found', 'No such baton.');
  return `the “${label}” baton`;
}

/**
 * POST /relay/claims { subjectType, subjectKey, userId? } — take it
 * yourself, or hand it to a teammate on any desk (their bell rings with
 * the handoff). One holder at a time: this replaces whoever held it.
 */
relayRouter.post('/relay/claims', STAFF, async (req, res, next) => {
  try {
    const input = ClaimSubjectSchema.extend({ userId: z.string().uuid().optional() }).parse(req.body);
    const what = await describeSubject(input.subjectType, input.subjectKey);
    const holderId = input.userId ?? req.user!.id;
    const holder = await prisma.user.findFirst({
      where: { id: holderId, status: 'ACTIVE', deletedAt: null },
      select: { ...personSelect, role: true },
    });
    // You can always take it yourself; a hand-off goes to someone on a desk.
    if (!holder || (holderId !== req.user!.id && !deskOf(holder.role))) {
      throw new HttpError(404, 'user_not_found', 'That person isn’t on a desk.');
    }
    const key = { subjectType_subjectKey: { subjectType: input.subjectType, subjectKey: input.subjectKey } };
    const row = await prisma.relayClaim.upsert({
      where: key,
      create: { subjectType: input.subjectType, subjectKey: input.subjectKey, userId: holderId, claimedById: req.user!.id },
      update: { userId: holderId, claimedById: req.user!.id, claimedAt: new Date() },
      select: { claimedAt: true },
    });
    const handedOff = holderId !== req.user!.id;
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: handedOff ? 'relay.handed_off' : 'relay.claimed',
        entityType: 'RelayClaim',
        entityId: `${input.subjectType}:${input.subjectKey}`,
        metadata: { holderUserId: holderId },
      },
      'relay.claim',
    );
    if (handedOff) {
      const from = await prisma.user.findUnique({ where: { id: req.user!.id }, select: personSelect });
      void trackNotificationWork(
        notifyUser(holderId, {
          subject: `${from ? personOf(from).name : 'A teammate'} handed you ${what}`,
          body: `It’s yours on the relay now — ${what}.`,
          category: 'work-thread',
          linkUrl:
            input.subjectType === 'LANE'
              ? `/relay?lane=${input.subjectKey}`
              : input.subjectType === 'REQUEST'
                ? '/relay#client-requests'
                : `/relay#${input.subjectKey}`,
        }),
      );
    }
    const me = personOf(holder);
    res.status(201).json({
      claim: {
        ...me,
        claimedAt: row.claimedAt.toISOString(),
        claimedByName: handedOff ? null : me.name,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** DELETE /relay/claims?subjectType=&subjectKey= — back on the desk. */
relayRouter.delete('/relay/claims', STAFF, async (req, res, next) => {
  try {
    const input = ClaimSubjectSchema.parse(req.query);
    const gone = await prisma.relayClaim.deleteMany({ where: { subjectType: input.subjectType, subjectKey: input.subjectKey } });
    if (gone.count > 0) {
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'relay.released',
          entityType: 'RelayClaim',
          entityId: `${input.subjectType}:${input.subjectKey}`,
        },
        'relay.claim',
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---- The conversation on the relay ----------------------------------- */

/**
 * GET /relay/activity — the latest on every thread (two weeks, newest
 * first) and every ruling still owed (oldest first), with the person each
 * one is about.
 */
relayRouter.get('/relay/activity', STAFF, async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 14 * 86_400_000);
    const include = {
      authorUser: { select: personSelect },
      decidedBy: { select: personSelect },
    } as const;
    const [recent, pending] = await Promise.all([
      prisma.workNote.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        include,
      }),
      prisma.workNote.findMany({
        where: { decisionStatus: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 50,
        include,
      }),
    ]);
    const subjectIds = [...new Set([...recent, ...pending].filter((n) => n.subjectType === 'ASSOCIATE').map((n) => n.subjectKey))];
    const people = subjectIds.length
      ? await prisma.associate.findMany({ where: { id: { in: subjectIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    const shape = (n: (typeof recent)[number]) => ({
      id: n.id,
      body: n.body,
      mentions: n.mentions,
      createdAt: n.createdAt.toISOString(),
      author: n.authorUser ? { name: personOf(n.authorUser).name, photoUrl: personOf(n.authorUser).photoUrl } : null,
      subject: { associateId: n.subjectKey, name: nameOf.get(n.subjectKey) ?? 'Unknown' },
      decisionDesk: n.decisionDesk,
      decisionStatus: n.decisionStatus,
      decisionNote: n.decisionNote,
      decidedAt: n.decidedAt?.toISOString() ?? null,
      decidedByName: n.decidedBy ? personOf(n.decidedBy).name : null,
    });
    res.json({
      decisions: pending.filter((n) => nameOf.has(n.subjectKey)).map(shape),
      notes: recent.filter((n) => nameOf.has(n.subjectKey)).map(shape),
    });
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
        decidedBy: { select: { email: true } },
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
        decisionDesk: n.decisionDesk,
        decisionStatus: n.decisionStatus,
        decisionNote: n.decisionNote,
        decidedAt: n.decidedAt?.toISOString() ?? null,
        decidedByEmail: n.decidedBy?.email ?? null,
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
  // Decisions with receipts: demand a ruling from exactly one desk. The
  // note sits as a baton on that desk until answered.
  decisionDesk: DESKS.optional(),
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
        ...(input.decisionDesk
          ? { decisionDesk: input.decisionDesk, decisionStatus: 'PENDING' }
          : {}),
      },
    });

    // Desk @mentions: the note lands on the other building's bell with
    // the person and the thread one click away. Never the author's own
    // bell, even when they mention their own desk. A decision demand
    // always rings its target desk, mentioned or not.
    const ringDesks = [
      ...new Set([
        ...input.mentionDesks,
        ...(input.decisionDesk ? [input.decisionDesk] : []),
      ]),
    ];
    if (ringDesks.length > 0) {
      const roles = [...new Set(ringDesks.flatMap((d) => DESK_ROLES[d]))];
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
                subject: input.decisionDesk
                  ? `Decision needed on ${who}`
                  : `Thread on ${who} — your desk was mentioned`,
                body: `${req.user!.email} wrote on ${who}'s record: "${preview}"${input.decisionDesk ? ' — a ruling from your desk is requested.' : ''}`,
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

/* ---- Decisions with receipts ----------------------------------------- */

/** Which desk this staff role answers for when ruling on a decision. */
function deskOf(role: string): 'FINANCE' | 'HR' | 'WORKFORCE' | null {
  if (role === 'FINANCE_ACCOUNTANT') return 'FINANCE';
  if (role === 'WORKFORCE_MANAGER') return 'WORKFORCE';
  if (DESK_ROLES.HR.includes(role)) return 'HR';
  return null;
}

const DecideSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().min(1).max(2000),
});

relayRouter.post('/work-notes/:id/decide', STAFF, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = DecideSchema.parse(req.body);
    const note = await prisma.workNote.findUnique({
      where: { id },
      select: {
        decisionDesk: true,
        decisionStatus: true,
        authorUserId: true,
        subjectKey: true,
        body: true,
      },
    });
    if (!note || note.decisionStatus !== 'PENDING') {
      throw new HttpError(404, 'not_pending', 'No pending decision here.');
    }
    // Only the desk the ruling was demanded FROM may answer — that is
    // the whole point of the receipt.
    if (deskOf(req.user!.role) !== note.decisionDesk) {
      throw new HttpError(
        403,
        'wrong_desk',
        `This decision belongs to the ${note.decisionDesk} desk.`,
      );
    }
    const status = input.approve ? 'APPROVED' : 'DECLINED';
    await prisma.workNote.update({
      where: { id },
      data: {
        decisionStatus: status,
        decidedById: req.user!.id,
        decidedAt: new Date(),
        decisionNote: input.note,
      },
    });
    // Close the loop with whoever asked.
    if (note.authorUserId && note.authorUserId !== req.user!.id) {
      void notifyUser(note.authorUserId, {
        subject: `Decision ${status.toLowerCase()}: ${note.body.slice(0, 80)}${note.body.length > 80 ? '…' : ''}`,
        body: `${req.user!.email} ruled ${status}: "${input.note}"`,
        category: 'work-thread',
        linkUrl: `/people?associateId=${note.subjectKey}&tab=thread`,
      });
    }
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

/* ---- Cohorts: waves on the relay -------------------------------------- */

const CohortSchema = z.object({
  name: z.string().trim().min(3).max(120),
  clientId: z.string().uuid().nullable().optional(),
  targetHeadcount: z.number().int().min(1).max(10_000),
  landByDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

relayRouter.post(
  '/cohorts',
  requireCapability('manage:recruiting'),
  async (req, res, next) => {
    try {
      const input = CohortSchema.parse(req.body);
      const created = await prisma.cohort.create({
        data: {
          name: input.name,
          clientId: input.clientId ?? null,
          targetHeadcount: input.targetHeadcount,
          landByDate: new Date(input.landByDate),
          createdById: req.user!.id,
        },
      });
      res.status(201).json({ id: created.id });
    } catch (err) {
      next(err);
    }
  },
);

relayRouter.get('/cohorts', STAFF, async (_req, res, next) => {
  try {
    const rows = await prisma.cohort.findMany({
      where: { archivedAt: null },
      orderBy: { landByDate: 'asc' },
      take: 50,
      select: {
        id: true,
        name: true,
        targetHeadcount: true,
        landByDate: true,
        client: { select: { name: true } },
      },
    });
    res.json({
      cohorts: rows.map((c) => ({
        id: c.id,
        name: c.name,
        clientName: c.client?.name ?? null,
        targetHeadcount: c.targetHeadcount,
        landByDate: c.landByDate.toISOString().slice(0, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Put a hire's lane in (or out of) a wave: stamps the cohort on their
 *  latest APPROVED application, which is exactly what feeds the board. */
relayRouter.post(
  '/cohorts/assign',
  requireCapability('manage:recruiting'),
  async (req, res, next) => {
    try {
      const input = z
        .object({
          associateId: z.string().uuid(),
          cohortId: z.string().uuid().nullable(),
        })
        .parse(req.body);
      if (input.cohortId) {
        const cohort = await prisma.cohort.findFirst({
          where: { id: input.cohortId, archivedAt: null },
          select: { id: true },
        });
        if (!cohort) throw new HttpError(404, 'cohort_not_found', 'Cohort not found.');
      }
      const app = await prisma.application.findFirst({
        where: { associateId: input.associateId, status: 'APPROVED', deletedAt: null },
        orderBy: { approvedAt: 'desc' },
        select: { id: true },
      });
      if (!app) {
        throw new HttpError(404, 'no_approved_application', 'No approved application.');
      }
      await prisma.application.update({
        where: { id: app.id },
        data: { cohortId: input.cohortId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/* ---- The associate's own lane ----------------------------------------- */

// The person with the most at stake in the lane finally gets to see it.
// Their own six steps, no desk names, no other people's data.
relayRouter.get('/me/first-paycheck', requireAuth, async (req, res, next) => {
  try {
    if (!req.user!.associateId) {
      return res.json({ lane: null });
    }
    const lane = await computeSingleLane(prisma, req.user!.associateId);
    res.json({ lane });
  } catch (err) {
    next(err);
  }
});
