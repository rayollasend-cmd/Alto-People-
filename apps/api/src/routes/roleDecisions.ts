import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  hasCapability,
  ROLE_LABELS,
  rolesWithCapability,
  type Role,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireAuth } from '../middleware/auth.js';
import { approveWalkInRequest } from '../lib/walkInApproval.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyUser } from '../lib/notify.js';
import { computeExecutiveDecisions } from '../lib/executiveDecisions.js';
import { computeNoShowRisk } from '../lib/noShowRisk.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { computeRoleDecisions } from '../lib/roleDecisions.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from '../lib/timezone.js';

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
  role: true,
  associate: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoS3Key: true,
      photoUpdatedAt: true,
    },
  },
} as const;

type ClaimerRow = {
  id: string;
  email: string;
  role: string;
  associate: {
    id: string;
    firstName: string;
    lastName: string;
    photoS3Key: string | null;
    photoUpdatedAt: Date | null;
  } | null;
};

const personOf = (u: ClaimerRow) => ({
  id: u.id,
  name: claimantName(u),
  photoUrl: u.associate ? profilePhotoUrlFor(u.associate) : null,
  roleLabel: ROLE_LABELS[u.role as Role] ?? u.role,
  role: u.role,
});

/** Can this user see this key at all? Their role queue, or (for
 *  view:executive holders) the executive queue — the chairman can open
 *  any room his own queue shows. */
async function resolveItemForUser(req: Request, key: string) {
  const me = queueUser(req);
  const decisions = await computeRoleDecisions(prisma, me);
  const own = decisions.find((d) => d.key === key);
  if (own) {
    return {
      label: own.label,
      detail: own.detail,
      linkUrl: own.linkUrl,
      severity: own.severity as string | null,
      stakes: own.stakes,
      ageDays: own.ageDays,
    };
  }
  if (hasCapability(me.role, 'view:executive')) {
    const exec = await computeExecutiveDecisions(prisma);
    const item = exec.find((d) => d.key === key);
    if (item) {
      return {
        label: item.label,
        detail: item.detail,
        linkUrl: item.linkUrl,
        severity: item.severity as string | null,
        stakes: item.stakes,
        ageDays: item.ageDays,
      };
    }
  }
  // The item may have RESOLVED while its room still holds history — allow
  // opening a room that has any trace (thread or claim), so links in old
  // notifications don't dead-end.
  const [comment, claim] = await Promise.all([
    prisma.decisionComment.findFirst({ where: { key }, select: { id: true } }),
    prisma.decisionClaim.findUnique({ where: { key }, select: { id: true } }),
  ]);
  if (comment || claim) {
    return { label: key, detail: '', linkUrl: '/', severity: null, stakes: null, ageDays: null };
  }
  return null;
}

/** NVIDIA move: the room pulls its own evidence — item-type-aware facts
 *  computed server-side so nobody leaves the room to look things up. */
async function computeItemFacts(
  key: string,
): Promise<{ facts: Array<{ label: string; value: string }>; list: string[] }> {
  const facts: Array<{ label: string; value: string }> = [];
  const list: string[] = [];
  const money = (v: number) => `$${v.toFixed(2)}`;

  if (key.startsWith('receivable:')) {
    const id = key.slice('receivable:'.length);
    const s = await prisma.clientStatement.findUnique({
      where: { id },
      select: {
        number: true,
        periodStart: true,
        periodEnd: true,
        finalizedAt: true,
        snapshot: true,
        clientId: true,
        client: { select: { name: true } },
      },
    });
    if (s) {
      const amount =
        (s.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount ?? 0;
      facts.push(
        { label: 'Client', value: s.client.name },
        { label: 'Statement', value: `#${s.number ?? '—'}` },
        {
          label: 'Period',
          value: `${s.periodStart.toISOString().slice(0, 10)} → ${s.periodEnd.toISOString().slice(0, 10)}`,
        },
        { label: 'Amount', value: money(amount) },
        {
          label: 'Outstanding',
          value: s.finalizedAt
            ? `${Math.floor((Date.now() - s.finalizedAt.getTime()) / 86_400_000)} days`
            : '—',
        },
      );
      const paid = await prisma.clientStatement.findMany({
        where: {
          clientId: s.clientId,
          status: 'FINAL',
          paidAt: { not: null },
          finalizedAt: { not: null },
        },
        select: { paidAt: true, finalizedAt: true },
        take: 50,
      });
      if (paid.length > 0) {
        const avg = Math.round(
          paid.reduce(
            (n, p) => n + (p.paidAt!.getTime() - p.finalizedAt!.getTime()) / 86_400_000,
            0,
          ) / paid.length,
        );
        facts.push({ label: 'This client usually pays in', value: `${avg} days` });
      }
    }
  } else if (key.startsWith('walkins:pending')) {
    const clientId = key.includes(':', 'walkins:pending'.length)
      ? key.slice('walkins:pending:'.length)
      : null;
    const pending = await prisma.clockInRequest.findMany({
      where: { status: 'PENDING', ...(clientId ? { clientId } : {}) },
      select: {
        requestedAt: true,
        associate: { select: { firstName: true, lastName: true } },
      },
      orderBy: { requestedAt: 'asc' },
      take: 8,
    });
    for (const p of pending) {
      const mins = Math.round((Date.now() - p.requestedAt.getTime()) / 60_000);
      list.push(`${p.associate.firstName} ${p.associate.lastName} — waiting ${mins} min`);
    }
  } else if (key.startsWith('associate:paused:')) {
    const id = key.slice('associate:paused:'.length);
    const a = await prisma.associate.findUnique({
      where: { id },
      select: { firstName: true, lastName: true, deactivatedAt: true, deactivationReason: true },
    });
    if (a) {
      facts.push(
        { label: 'Associate', value: `${a.firstName} ${a.lastName}` },
        {
          label: 'Paused since',
          value: a.deactivatedAt ? a.deactivatedAt.toISOString().slice(0, 10) : '—',
        },
        ...(a.deactivationReason ? [{ label: 'Reason', value: a.deactivationReason }] : []),
      );
    }
  } else if (key.startsWith('risk:tomorrow')) {
    const clientId = key.includes(':', 'risk:tomorrow'.length)
      ? key.slice('risk:tomorrow:'.length)
      : null;
    const risky = await computeNoShowRisk(prisma, new Date(), clientId);
    for (const r of risky.slice(0, 8)) {
      list.push(
        `${formatTimeInZone(r.startsAt, DEFAULT_TIMEZONE)} ${r.position} — ${r.holderName} (${r.points} pts, 90d)`,
      );
    }
  } else if (key.startsWith('shifts:open-24h')) {
    const clientId = key.includes(':', 'shifts:open-24h'.length)
      ? key.slice('shifts:open-24h:'.length)
      : null;
    const shifts = await prisma.shift.findMany({
      where: {
        publishedAt: { not: null },
        status: 'OPEN',
        assignedAssociateId: null,
        startsAt: { gte: new Date(), lt: new Date(Date.now() + 24 * 3600_000) },
        ...(clientId ? { clientId } : {}),
      },
      select: { position: true, startsAt: true, location: true, client: { select: { name: true } } },
      orderBy: { startsAt: 'asc' },
      take: 8,
    });
    for (const s of shifts) {
      list.push(
        `${formatTimeInZone(s.startsAt, DEFAULT_TIMEZONE)} ${s.position} — ${s.location ?? s.client.name}`,
      );
    }
  }
  return { facts, list };
}

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
  return rows.map((u) => personOf(u as ClaimerRow));
}

roleDecisionsRouter.get('/colleagues', requireAuth, async (req: Request, res: Response) => {
  res.json({ colleagues: await listColleagues(req) });
});

roleDecisionsRouter.get('/decisions', requireAuth, async (req: Request, res: Response) => {
  const decisions = await computeRoleDecisions(prisma, queueUser(req));
  const [claims, nextSteps] =
    decisions.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.decisionClaim.findMany({
            where: { key: { in: decisions.map((d) => d.key) } },
            include: { claimedBy: { select: CLAIMER_SELECT } },
          }),
          prisma.decisionNextStep.findMany({
            where: { key: { in: decisions.map((d) => d.key) } },
            include: { owner: { select: CLAIMER_SELECT } },
          }),
        ]);
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const stepByKey = new Map(nextSteps.map((s) => [s.key, s]));
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
        const s = stepByKey.get(d.key);
        return {
          ...d,
          claimedBy: c ? personOf(c.claimedBy as ClaimerRow) : null,
          claimedByMe: c ? c.claimedById === req.user!.id : false,
          assigned: Boolean(c?.assignedById),
          note: c?.note ?? null,
          escalated: Boolean(c?.escalatedAt),
          nextStep: s
            ? {
                text: s.text,
                ownerName: s.owner ? personOf(s.owner as ClaimerRow).name : null,
                dueDay: s.dueDay ? s.dueDay.toISOString().slice(0, 10) : null,
              }
            : null,
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

/* ===== One-tap resolutions =============================================== */
//
// The Tesla move: the fix lives on the item. Only SAFE bulk operations
// get a quick action — each handler re-derives everything server-side
// (never trusts the client's idea of what's pending) and reports what it
// actually did.

roleDecisionsRouter.post('/decisions/quick', requireAuth, async (req: Request, res: Response) => {
  const key = z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{3,160}$/)
    .parse(req.body?.key);
  const me = queueUser(req);
  const decisions = await computeRoleDecisions(prisma, me);
  const item = decisions.find((d) => d.key === key);
  if (!item || !item.quickAction) {
    throw new HttpError(404, 'not_found', 'No quick action available for that item.');
  }

  let summary = '';
  if (key.startsWith('walkins:pending')) {
    const clamp = me.clientId ? { clientId: me.clientId } : {};
    const pending = await prisma.clockInRequest.findMany({
      where: { status: 'PENDING', ...clamp },
      select: { id: true },
      take: 50,
    });
    let approved = 0;
    let skipped = 0;
    for (const r of pending) {
      const result = await approveWalkInRequest(prisma, r.id, req.user!.id, req);
      if (result.ok) approved += 1;
      else skipped += 1;
    }
    summary = `Approved ${approved} walk-in${approved === 1 ? '' : 's'}${skipped > 0 ? `; ${skipped} needed manual review (too old or already clocked in)` : ''}.`;
  } else if (key.startsWith('associate:paused:')) {
    const associateId = z.string().uuid().parse(key.slice('associate:paused:'.length));
    // Mirror of POST /org/associates/:id/reactivate — keep in lockstep.
    const existing = await prisma.associate.findFirst({
      where: { id: associateId, deletedAt: null, deactivatedAt: { not: null } },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!existing) throw new HttpError(409, 'not_deactivated', 'Already reactivated.');
    const enabledUserIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.associate.update({
        where: { id: associateId },
        data: { deactivatedAt: null, deactivatedById: null, deactivationReason: null },
      });
      const users = await tx.user.findMany({
        where: { associateId, deletedAt: null, status: 'DISABLED' },
        select: { id: true },
      });
      if (users.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: users.map((u) => u.id) } },
          data: { status: 'ACTIVE' },
        });
        enabledUserIds.push(...users.map((u) => u.id));
      }
    });
    for (const uid of enabledUserIds) invalidateUserCache(uid);
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'associate.reactivated',
        entityType: 'Associate',
        entityId: associateId,
        metadata: { enabledLogins: enabledUserIds.length, via: 'quick_action' },
      },
      'decisions.quick',
    );
    summary = `${existing.firstName} ${existing.lastName} reactivated — login restored, back in the scheduling pool.`;
  } else {
    throw new HttpError(400, 'unsupported', 'No quick action handler for that item.');
  }

  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'decisions.quick_action',
      entityType: 'DecisionClaim',
      entityId: key,
      metadata: { label: item.label, summary },
    },
    'decisions.quick',
  );
  res.json({ ok: true, summary });
});

/* ===== The item's room: thread + timeline + participants ================= */

const TIMELINE_LABEL: Record<string, string> = {
  'decisions.claim': 'took the item',
  'decisions.release': 'released it back to the team',
  'decisions.assign': 'assigned it',
  'decisions.postpone': 'postponed it',
  'decisions.tag': 'tagged a colleague',
  'decisions.escalate': 'escalated it',
  'decisions.comment': 'commented',
  'decisions.next_step': 'set the next step',
  'decisions.quick_action': 'ran the one-tap fix',
  'executive.decision_dismiss': 'dismissed it (chairman)',
  'executive.decision_snooze': 'snoozed it (chairman)',
  'executive.decision_delegate': 'delegated it to the team (chairman)',
};

roleDecisionsRouter.get('/decisions/item', requireAuth, async (req: Request, res: Response) => {
  const key = z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{3,160}$/)
    .parse(String(req.query.key ?? ''));
  const item = await resolveItemForUser(req, key);
  if (!item) throw new HttpError(404, 'not_found', 'That item is not visible to you.');

  const [comments, timelineRows, claim, nextStep, itemContext] = await Promise.all([
    prisma.decisionComment.findMany({
      where: { key },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: { select: CLAIMER_SELECT } },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'DecisionClaim', entityId: key },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: { actorUser: { select: CLAIMER_SELECT } },
    }),
    prisma.decisionClaim.findUnique({
      where: { key },
      include: { claimedBy: { select: CLAIMER_SELECT } },
    }),
    prisma.decisionNextStep.findUnique({
      where: { key },
      include: { owner: { select: CLAIMER_SELECT } },
    }),
    computeItemFacts(key),
  ]);

  const thread = comments.map((c) => ({
    id: c.id,
    author: personOf(c.user as ClaimerRow),
    body: c.body,
    at: c.createdAt.toISOString(),
  }));
  const timeline = timelineRows
    .filter((r) => r.action !== 'decisions.comment')
    .map((r) => ({
      action: TIMELINE_LABEL[r.action] ?? r.action,
      actor: r.actorUser ? personOf(r.actorUser as ClaimerRow) : null,
      note: (r.metadata as { note?: string | null } | null)?.note ?? null,
      at: r.createdAt.toISOString(),
    }));
  // Participants: everyone who touched the room, deduped, claimer first.
  const seen = new Map<string, ReturnType<typeof personOf>>();
  if (claim) seen.set(claim.claimedBy.id, personOf(claim.claimedBy as ClaimerRow));
  for (const c of thread) if (!seen.has(c.author.id)) seen.set(c.author.id, c.author);
  for (const t of timeline) if (t.actor && !seen.has(t.actor.id)) seen.set(t.actor.id, t.actor);

  res.json({
    key,
    label: item.label,
    detail: item.detail,
    linkUrl: item.linkUrl,
    severity: item.severity,
    stakes: item.stakes,
    ageDays: item.ageDays,
    claimedBy: claim ? personOf(claim.claimedBy as ClaimerRow) : null,
    participants: [...seen.values()],
    nextStep: nextStep
      ? {
          text: nextStep.text,
          owner: nextStep.owner ? personOf(nextStep.owner as ClaimerRow) : null,
          dueDay: nextStep.dueDay ? nextStep.dueDay.toISOString().slice(0, 10) : null,
        }
      : null,
    facts: itemContext.facts,
    factList: itemContext.list,
    thread,
    timeline,
  });
});

/* ----- The pinned next step — the flight-director rule ------------------- */

const NextStepInputSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),
  /** null / empty clears the next step. */
  text: z.string().trim().max(200).nullable(),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueDay: z.string().date().nullable().optional(),
});

roleDecisionsRouter.post(
  '/decisions/next-step',
  requireAuth,
  async (req: Request, res: Response) => {
    const input = NextStepInputSchema.parse(req.body);
    const item = await resolveItemForUser(req, input.key);
    if (!item) throw new HttpError(404, 'not_found', 'That item is not visible to you.');

    if (!input.text) {
      await prisma.decisionNextStep.deleteMany({ where: { key: input.key } });
    } else {
      await prisma.decisionNextStep.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          text: input.text,
          ownerId: input.ownerUserId ?? req.user!.id,
          dueDay: input.dueDay ? new Date(`${input.dueDay}T00:00:00Z`) : null,
          setById: req.user!.id,
        },
        update: {
          text: input.text,
          ownerId: input.ownerUserId ?? req.user!.id,
          dueDay: input.dueDay ? new Date(`${input.dueDay}T00:00:00Z`) : null,
          setById: req.user!.id,
        },
      });
      const ownerId = input.ownerUserId ?? req.user!.id;
      if (ownerId !== req.user!.id) {
        const actorLocal = req.user!.email.split('@')[0] ?? req.user!.email;
        await notifyUser(ownerId, {
          subject: `Next step is yours: ${item.label}`,
          body: `${input.text}${input.dueDay ? ` — by ${input.dueDay}` : ''} (set by ${actorLocal.charAt(0).toUpperCase() + actorLocal.slice(1)})`,
          category: 'decision_next_step',
          linkUrl: item.linkUrl,
        });
      }
    }
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'decisions.next_step',
        entityType: 'DecisionClaim',
        entityId: input.key,
        metadata: { text: input.text, ownerUserId: input.ownerUserId ?? null, dueDay: input.dueDay ?? null },
      },
      'decisions.next_step',
    );
    res.json({ ok: true });
  },
);

const CommentInputSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9:_-]{3,160}$/),
  body: z.string().trim().min(1).max(1_000),
  mentionUserId: z.string().uuid().optional(),
});

roleDecisionsRouter.post('/decisions/comment', requireAuth, async (req: Request, res: Response) => {
  const input = CommentInputSchema.parse(req.body);
  const item = await resolveItemForUser(req, input.key);
  if (!item) throw new HttpError(404, 'not_found', 'That item is not visible to you.');

  await prisma.decisionComment.create({
    data: { key: input.key, userId: req.user!.id, body: input.body },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'decisions.comment',
      entityType: 'DecisionClaim',
      entityId: input.key,
      metadata: { label: item.label },
    },
    'decisions.comment',
  );

  const actorLocal = req.user!.email.split('@')[0] ?? req.user!.email;
  const actorName = actorLocal.charAt(0).toUpperCase() + actorLocal.slice(1);
  // Ping the mentioned colleague and the item's current holder (if
  // someone else) — the room comes to them.
  const targets = new Set<string>();
  if (input.mentionUserId && input.mentionUserId !== req.user!.id) {
    targets.add(input.mentionUserId);
  }
  const claim = await prisma.decisionClaim.findUnique({
    where: { key: input.key },
    select: { claimedById: true },
  });
  if (claim && claim.claimedById !== req.user!.id) targets.add(claim.claimedById);
  for (const t of targets) {
    await notifyUser(t, {
      subject: `${actorName} on: ${item.label}`,
      body: input.body,
      category: 'decision_comment',
      linkUrl: item.linkUrl,
    });
  }
  res.status(201).json({ ok: true });
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
