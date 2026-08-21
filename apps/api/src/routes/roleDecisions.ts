import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ROLE_LABELS,
  rolesWithCapability,
  type Role,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { computeRoleDecisions } from '../lib/roleDecisions.js';

/**
 * The collaborative work layer under every dashboard:
 *
 *   GET  /me/decisions      — your queue (capability-scoped, client-
 *                             clamped) with the team overlay: who has
 *                             each item, assignments, postponements.
 *   POST /me/decisions/act  — claim / release / escalate / ASSIGN to a
 *                             colleague (or reassign) / POSTPONE / TAG a
 *                             colleague on an item.
 *   GET  /me/colleagues     — who you can assign or tag: your site's
 *                             team for client-scoped roles, plus the org
 *                             admins; org roles see all operators.
 *   GET  /me/plan           — your day/week planner (queue items you
 *   POST /me/plan             pulled in + free-form tasks), check-off,
 *   PATCH/DELETE /me/plan/:id reschedule, remove.
 *
 * Assignment puts the item in the colleague's own queue chip-set (they
 * become the claimer, with a bell + email); postponement hides the item
 * from every queue until the chosen day; tagging notifies without
 * transferring ownership. Everything audited.
 */
export const roleDecisionsRouter = Router();

function queueUser(req: Request) {
  const u = req.user!;
  return {
    id: u.id,
    role: u.role as Role,
    clientId: (u as { clientId?: string | null }).clientId ?? null,
    associateId: (u as { associateId?: string | null }).associateId ?? null,
  };
}

// Users carry no name columns — names live on the linked associate;
// admin accounts fall back to a prettified email local-part.
const claimantName = (u: {
  email: string;
  associate: { firstName: string; lastName: string } | null;
}) => {
  if (u.associate) return `${u.associate.firstName} ${u.associate.lastName}`.trim();
  const local = u.email.split('@')[0] ?? u.email;
  return local.charAt(0).toUpperCase() + local.slice(1);
};

const CLAIMER_SELECT = {
  id: true,
  email: true,
  associate: { select: { firstName: true, lastName: true } },
} as const;

/** The people this user can assign/tag: same-site operators for client-
 *  scoped roles plus the org admins; org-wide roles get every operator
 *  and admin. Associates collaborate upward only (their supervisors +
 *  admins). */
async function listColleagues(req: Request) {
  const me = queueUser(req);
  const adminRoles = rolesWithCapability('manage:org');
  const operatorRoles: Role[] = [...adminRoles, 'SHIFT_SUPERVISOR', 'FINANCE_ACCOUNTANT'];
  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      id: { not: me.id },
      OR: [
        { role: { in: adminRoles } },
        me.clientId
          ? { role: { in: operatorRoles }, clientId: me.clientId }
          : { role: { in: operatorRoles } },
      ],
    },
    select: { ...CLAIMER_SELECT, role: true, clientId: true },
    orderBy: { email: 'asc' },
    take: 50,
  });
  return rows.map((u) => ({
    id: u.id,
    name: claimantName(u),
    roleLabel: ROLE_LABELS[u.role as Role] ?? u.role,
  }));
}

roleDecisionsRouter.get('/colleagues', requireAuth, async (req: Request, res: Response) => {
  res.json({ colleagues: await listColleagues(req) });
});

roleDecisionsRouter.get('/decisions', requireAuth, async (req: Request, res: Response) => {
  const decisions = await computeRoleDecisions(prisma, queueUser(req));
  const claims =
    decisions.length === 0
      ? []
      : await prisma.decisionClaim.findMany({
          where: { key: { in: decisions.map((d) => d.key) } },
          include: { claimedBy: { select: CLAIMER_SELECT } },
        });
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const now = new Date();
  res.json({
    decisions: decisions
      // Postponed items rest until their day comes back around.
      .filter((d) => {
        const c = byKey.get(d.key);
        return !(c?.postponedUntil && c.postponedUntil > now);
      })
      .map((d) => {
        const c = byKey.get(d.key);
        return {
          ...d,
          claimedBy: c ? { id: c.claimedBy.id, name: claimantName(c.claimedBy) } : null,
          claimedByMe: c ? c.claimedById === req.user!.id : false,
          assigned: Boolean(c?.assignedById),
          note: c?.note ?? null,
          escalated: Boolean(c?.escalatedAt),
        };
      }),
  });
});

const ActInputSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),
  action: z.enum(['claim', 'release', 'escalate', 'assign', 'postpone', 'tag']),
  note: z.string().trim().max(300).optional(),
  /** assign / tag target. */
  targetUserId: z.string().uuid().optional(),
  /** postpone horizon in days (1–14). */
  days: z.number().int().min(1).max(14).optional(),
});

roleDecisionsRouter.post('/decisions/act', requireAuth, async (req: Request, res: Response) => {
  const input = ActInputSchema.parse(req.body);
  // The key must be in THIS user's own queue — you can only collaborate
  // on items your capabilities and client scope actually show you.
  const decisions = await computeRoleDecisions(prisma, queueUser(req));
  const item = decisions.find((d) => d.key === input.key);
  if (!item) {
    throw new HttpError(404, 'not_found', 'That item is not in your queue (it may have been resolved).');
  }
  const existing = await prisma.decisionClaim.findUnique({
    where: { key: input.key },
    include: { claimedBy: { select: CLAIMER_SELECT } },
  });

  const actorLocal = req.user!.email.split('@')[0] ?? req.user!.email;
  const actorName = actorLocal.charAt(0).toUpperCase() + actorLocal.slice(1);

  if (input.action === 'claim') {
    if (existing && existing.claimedById !== req.user!.id) {
      throw new HttpError(
        409,
        'already_claimed',
        `${claimantName(existing.claimedBy)} already has this one.`,
      );
    }
    await prisma.decisionClaim.upsert({
      where: { key: input.key },
      create: { key: input.key, claimedById: req.user!.id, note: input.note ?? null },
      update: {
        claimedById: req.user!.id,
        claimedAt: new Date(),
        assignedById: null,
        postponedUntil: null,
        note: input.note ?? null,
      },
    });
  } else if (input.action === 'release') {
    if (!existing) throw new HttpError(404, 'not_claimed', 'Nobody has claimed this item.');
    if (existing.claimedById !== req.user!.id && existing.assignedById !== req.user!.id) {
      throw new HttpError(403, 'not_yours', 'Only the person who has it (or who assigned it) can release it.');
    }
    await prisma.decisionClaim.delete({ where: { key: input.key } });
  } else if (input.action === 'assign') {
    if (!input.targetUserId) {
      throw new HttpError(400, 'target_required', 'Pick the colleague to assign this to.');
    }
    // Reassignment rights: current holder, original assigner, or anyone
    // when the item is unclaimed.
    if (
      existing &&
      existing.claimedById !== req.user!.id &&
      existing.assignedById !== req.user!.id
    ) {
      throw new HttpError(
        409,
        'already_claimed',
        `${claimantName(existing.claimedBy)} already has this one — ask them to release it.`,
      );
    }
    const colleagues = await listColleagues(req);
    const target = colleagues.find((c) => c.id === input.targetUserId);
    if (!target) {
      throw new HttpError(400, 'invalid_target', 'That person is not in your collaboration circle.');
    }
    await prisma.decisionClaim.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        claimedById: input.targetUserId,
        assignedById: req.user!.id,
        note: input.note ?? null,
      },
      update: {
        claimedById: input.targetUserId,
        claimedAt: new Date(),
        assignedById: req.user!.id,
        postponedUntil: null,
        note: input.note ?? null,
      },
    });
    await notifyUser(input.targetUserId, {
      subject: `${actorName} assigned you: ${item.label}`,
      body: `${item.detail}${input.note ? `\n\nNote: ${input.note}` : ''}`,
      category: 'decision_assignment',
      linkUrl: item.linkUrl,
    });
  } else if (input.action === 'postpone') {
    const days = input.days ?? 1;
    const until = new Date(Date.now() + days * 86_400_000);
    await prisma.decisionClaim.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        claimedById: req.user!.id,
        postponedUntil: until,
        note: input.note ?? null,
      },
      update: { postponedUntil: until, note: input.note ?? undefined },
    });
  } else if (input.action === 'tag') {
    if (!input.targetUserId) {
      throw new HttpError(400, 'target_required', 'Pick the colleague to tag.');
    }
    const colleagues = await listColleagues(req);
    const target = colleagues.find((c) => c.id === input.targetUserId);
    if (!target) {
      throw new HttpError(400, 'invalid_target', 'That person is not in your collaboration circle.');
    }
    await notifyUser(input.targetUserId, {
      subject: `${actorName} tagged you on: ${item.label}`,
      body: `${item.detail}${input.note ? `\n\n"${input.note}"` : ''}`,
      category: 'decision_tag',
      linkUrl: item.linkUrl,
    });
  } else {
    // Escalate: stamp it and ping every org admin + chairman with the
    // item and note.
    await prisma.decisionClaim.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        claimedById: req.user!.id,
        note: input.note ?? null,
        escalatedAt: new Date(),
        escalatedById: req.user!.id,
      },
      update: { escalatedAt: new Date(), escalatedById: req.user!.id, note: input.note ?? null },
    });
    const adminRoles = rolesWithCapability('manage:org');
    const admins = await prisma.user.findMany({
      where: {
        role: { in: [...adminRoles, 'EXECUTIVE_CHAIRMAN'] },
        status: 'ACTIVE',
        deletedAt: null,
        id: { not: req.user!.id },
      },
      select: { id: true },
      take: 25,
    });
    for (const a of admins) {
      await notifyUser(a.id, {
        subject: `Escalated by ${actorName}: ${item.label}`,
        body: `${item.detail}${input.note ? `\n\nNote: ${input.note}` : ''}`,
        category: 'decision_escalation',
        linkUrl: item.linkUrl,
      });
    }
  }
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: `decisions.${input.action}`,
      entityType: 'DecisionClaim',
      entityId: input.key,
      metadata: {
        label: item.label,
        note: input.note ?? null,
        targetUserId: input.targetUserId ?? null,
        days: input.days ?? null,
      },
    },
    'decisions.act',
  );
  res.json({ ok: true });
});

/* ===== Personal day/week planner ========================================= */

const PlanCreateSchema = z.object({
  day: z.string().date(),
  title: z.string().trim().min(1).max(200),
  decisionKey: z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/).optional(),
  linkUrl: z.string().trim().max(300).optional(),
});
const PlanPatchSchema = z.object({
  day: z.string().date().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
});

roleDecisionsRouter.get('/plan', requireAuth, async (req: Request, res: Response) => {
  const from = z.string().date().catch('').parse(String(req.query.from ?? ''));
  const to = z.string().date().catch('').parse(String(req.query.to ?? ''));
  const start = from ? new Date(`${from}T00:00:00Z`) : new Date(Date.now() - 86_400_000);
  const end = to ? new Date(`${to}T00:00:00Z`) : new Date(Date.now() + 7 * 86_400_000);
  const items = await prisma.workPlanItem.findMany({
    where: { userId: req.user!.id, day: { gte: start, lte: end } },
    orderBy: [{ day: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  });
  res.json({
    items: items.map((i) => ({
      id: i.id,
      day: i.day.toISOString().slice(0, 10),
      title: i.title,
      decisionKey: i.decisionKey,
      linkUrl: i.linkUrl,
      done: i.doneAt !== null,
    })),
  });
});

roleDecisionsRouter.post('/plan', requireAuth, async (req: Request, res: Response) => {
  const input = PlanCreateSchema.parse(req.body);
  const row = await prisma.workPlanItem.create({
    data: {
      userId: req.user!.id,
      day: new Date(`${input.day}T00:00:00Z`),
      title: input.title,
      decisionKey: input.decisionKey ?? null,
      linkUrl: input.linkUrl ?? null,
    },
  });
  res.status(201).json({ id: row.id });
});

roleDecisionsRouter.patch('/plan/:id', requireAuth, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = PlanPatchSchema.parse(req.body);
  const existing = await prisma.workPlanItem.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!existing) throw new HttpError(404, 'not_found', 'Plan item not found.');
  await prisma.workPlanItem.update({
    where: { id },
    data: {
      ...(input.day ? { day: new Date(`${input.day}T00:00:00Z`) } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.done !== undefined ? { doneAt: input.done ? new Date() : null } : {}),
    },
  });
  res.json({ ok: true });
});

roleDecisionsRouter.delete('/plan/:id', requireAuth, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  await prisma.workPlanItem.deleteMany({ where: { id, userId: req.user!.id } });
  res.json({ ok: true });
});
