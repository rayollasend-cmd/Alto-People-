import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { enqueueAudit } from '../lib/audit.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

export const delegationsRouter = Router();

/**
 * Out-of-office cover for the team inbox. A manager names who covers
 * their direct reports for a date range; for those days the cover's
 * team scope widens (lib/delegations) and they are copied on the
 * manager's notifications. The manager keeps full access throughout —
 * a delegation adds a reader, it never removes one.
 *
 * Only people who have a team inbox can give or receive cover, and the
 * candidates list is exactly those people, so a delegation can never
 * hand a team to an account that could not open the page.
 */

const TEAM = requireCapability('view:my-team');
const MAX_DAYS = 90;

const InputSchema = z.object({
  toUserId: z.string().uuid(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(200).optional().transform((v) => (v ? v : null)),
});

const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function shape(d: {
  id: string;
  startsOn: Date;
  endsOn: Date;
  note: string | null;
  from: { id: string; email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null };
  to: { id: string; email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null };
}) {
  const name = (u: typeof d.from) => u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email);
  return {
    id: d.id,
    startsOn: ymd(d.startsOn),
    endsOn: ymd(d.endsOn),
    note: d.note,
    from: { id: d.from.id, name: name(d.from) },
    to: { id: d.to.id, name: name(d.to) },
  };
}

const PERSON = { select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } };

/** GET /delegations/mine — cover I have given and cover I am providing, current and upcoming. */
delegationsRouter.get('/mine', TEAM, async (req, res, next) => {
  try {
    const today = day(ymd(new Date()));
    const [given, received] = await Promise.all([
      prisma.teamDelegation.findMany({ where: { fromUserId: req.user!.id, endsOn: { gte: today } }, orderBy: { startsOn: 'asc' }, include: { from: PERSON, to: PERSON } }),
      prisma.teamDelegation.findMany({ where: { toUserId: req.user!.id, endsOn: { gte: today } }, orderBy: { startsOn: 'asc' }, include: { from: PERSON, to: PERSON } }),
    ]);
    res.json({ given: given.map(shape), received: received.map(shape), today: ymd(today) });
  } catch (err) {
    next(err);
  }
});

/** GET /delegations/candidates — everyone else with a team inbox. */
delegationsRouter.get('/candidates', TEAM, async (req, res, next) => {
  try {
    const rows = await prisma.user.findMany({
      where: {
        id: { not: req.user!.id },
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['MANAGER', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'HR_ADMINISTRATOR'] },
      },
      select: { id: true, email: true, displayName: true, role: true, associate: { select: { firstName: true, lastName: true } } },
      orderBy: { email: 'asc' },
      take: 200,
    });
    res.json({
      candidates: rows.map((u) => ({
        id: u.id,
        name: u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email),
        email: u.email,
        role: u.role,
      })),
    });
  } catch (err) {
    next(err);
  }
});

delegationsRouter.post('/', TEAM, async (req, res, next) => {
  try {
    const parsed = InputSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, 'invalid_body', 'Invalid delegation', parsed.error.flatten());
    const { toUserId, startsOn, endsOn, note } = parsed.data;
    if (toUserId === req.user!.id) throw new HttpError(400, 'self_delegation', 'You cannot cover for yourself.');
    const start = day(startsOn);
    const end = day(endsOn);
    if (end < start) throw new HttpError(400, 'bad_range', 'The end date is before the start date.');
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DAYS) throw new HttpError(400, 'too_long', `A delegation runs at most ${MAX_DAYS} days.`);
    const cover = await prisma.user.findFirst({
      where: { id: toUserId, status: 'ACTIVE', deletedAt: null, role: { in: ['MANAGER', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'HR_ADMINISTRATOR'] } },
      select: { id: true },
    });
    if (!cover) throw new HttpError(400, 'not_a_cover', 'That person does not have a team inbox.');
    const overlapping = await prisma.teamDelegation.findFirst({
      where: { fromUserId: req.user!.id, startsOn: { lte: end }, endsOn: { gte: start } },
      select: { id: true },
    });
    if (overlapping) throw new HttpError(409, 'overlap', 'You already have cover for part of those dates.');
    const row = await prisma.teamDelegation.create({
      data: { fromUserId: req.user!.id, toUserId, startsOn: start, endsOn: end, note },
      include: { from: PERSON, to: PERSON },
    });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'team_delegation.created', entityType: 'TeamDelegation', entityId: row.id, metadata: { toUserId, startsOn, endsOn } },
      'delegations.create',
    );
    res.status(201).json({ delegation: shape(row) });
  } catch (err) {
    next(err);
  }
});

delegationsRouter.delete('/:id', TEAM, async (req, res, next) => {
  try {
    const row = await prisma.teamDelegation.findFirst({ where: { id: req.params.id, fromUserId: req.user!.id } });
    if (!row) throw new HttpError(404, 'not_found', 'Delegation not found');
    await prisma.teamDelegation.delete({ where: { id: row.id } });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'team_delegation.removed', entityType: 'TeamDelegation', entityId: row.id, metadata: { toUserId: row.toUserId } },
      'delegations.delete',
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
