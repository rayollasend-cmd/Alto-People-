import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { rolesWithCapability, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { computeRoleDecisions } from '../lib/roleDecisions.js';

/**
 * GET  /me/decisions     — the signed-in user's decision queue, generated
 *                          by capability and clamped to their client
 *                          scope, with the team-collaboration overlay:
 *                          who has taken each item, and escalations.
 * POST /me/decisions/act — claim ("I've got this") / release / escalate.
 *
 * Collaboration model: everyone whose queue shows the SAME scoped key is
 * a team on that item. Claiming marks it "with <name>" for all of them
 * so nobody double-works it; releasing puts it back; escalating pings
 * every org admin with the item and an optional note. Claims die with
 * the item — a resolved condition stops being generated, so its stale
 * claim row simply never renders again.
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
  res.json({
    decisions: decisions.map((d) => {
      const c = byKey.get(d.key);
      return {
        ...d,
        claimedBy: c ? { id: c.claimedBy.id, name: claimantName(c.claimedBy) } : null,
        claimedByMe: c ? c.claimedById === req.user!.id : false,
        note: c?.note ?? null,
        escalated: Boolean(c?.escalatedAt),
      };
    }),
  });
});

const ActInputSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),
  action: z.enum(['claim', 'release', 'escalate']),
  note: z.string().trim().max(300).optional(),
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
      update: { claimedById: req.user!.id, claimedAt: new Date(), note: input.note ?? null },
    });
  } else if (input.action === 'release') {
    if (!existing) throw new HttpError(404, 'not_claimed', 'Nobody has claimed this item.');
    if (existing.claimedById !== req.user!.id) {
      throw new HttpError(403, 'not_yours', 'Only the person who took it can release it.');
    }
    await prisma.decisionClaim.delete({ where: { key: input.key } });
  } else {
    // Escalate: stamp it and ping every org admin (and the chairmen via
    // their manage:org-holding admin team) with the item + note.
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
    const fromLocal = req.user!.email.split('@')[0] ?? req.user!.email;
    const fromName = fromLocal.charAt(0).toUpperCase() + fromLocal.slice(1);
    for (const a of admins) {
      await notifyUser(a.id, {
        subject: `Escalated by ${fromName}: ${item.label}`,
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
      metadata: { label: item.label, note: input.note ?? null },
    },
    'decisions.act',
  );
  res.json({ ok: true });
});
