import { Router } from 'express';
import { z } from 'zod';
import type { Prisma, RetentionPlayKind } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { createApprovalRequest } from '../lib/approvalRequests.js';
import { assertAssociateInScope, scopeActiveAssociates } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { computeRetention, type RiskReason } from '../lib/retention.js';

/**
 * Retention desk (lib/retention). Only for the people who manage someone —
 * a lead their crew, a manager or HR within their reach; a worker never
 * sees a score, theirs or anyone's.
 *
 *   GET   /retention                 workers in reach with their risk, reasons and suggested plays
 *   GET   /retention/summary         bands, the stores most at risk, and which plays work
 *   GET   /retention/crew            "N people at risk on your crew" for the home cards
 *   POST  /retention/:associateId/plays   { kind, note?, proposedRate? } — log a play (pay → a second person)
 *   PATCH /retention/plays/:id       { note? } — mark a play done
 *   POST  /retention/recompute       score now (manage:org)
 */

export const retentionRouter = Router();

const VIEW = requireAnyCapability('manage:scheduling', 'view:org');
const KINDS = ['MORE_HOURS', 'CHECK_IN', 'SCHEDULE_FIX', 'RIDE_HELP', 'RECOGNITION', 'PAY_REVIEW'] as const;

const ListQuery = z.object({
  band: z.enum(['HIGH', 'MEDIUM', 'LOW', 'AT_RISK']).optional(),
  clientId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
});

function inReach(user: NonNullable<Express.Request['user']>, q: { clientId?: string; locationId?: string }): Prisma.AssociateWhereInput {
  return {
    AND: [
      scopeActiveAssociates(user),
      q.locationId ? { assignments: { some: { endedAt: null, locationId: q.locationId } } } : {},
      q.clientId ? { assignments: { some: { endedAt: null, location: { clientId: q.clientId } } } } : {},
    ],
  };
}

retentionRouter.get('/retention', VIEW, async (req, res) => {
  const user = req.user!;
  const q = ListQuery.parse(req.query);
  const bandFilter: Prisma.FlightRiskWhereInput = q.band === 'AT_RISK' ? { band: { in: ['HIGH', 'MEDIUM'] } } : q.band ? { band: q.band } : {};
  const rows = await prisma.flightRisk.findMany({
    where: { AND: [{ tenantId: tenantIdForWrite() }, bandFilter, { associate: inReach(user, q) }] },
    orderBy: [{ score: 'desc' }],
    take: 501,
    select: {
      associateId: true,
      score: true,
      band: true,
      reasons: true,
      plays: true,
      computedAt: true,
      associate: {
        select: {
          firstName: true,
          lastName: true,
          photoS3Key: true,
          photoUpdatedAt: true,
          hireDate: true,
          assignments: { where: { endedAt: null }, take: 1, orderBy: { startedAt: 'desc' }, select: { location: { select: { id: true, name: true, client: { select: { id: true, name: true } } } } } },
          retentionPlays: { orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, kind: true, status: true, note: true, createdAt: true, approvalId: true } },
        },
      },
    },
  });
  const truncated = rows.length > 500;
  res.json({
    truncated,
    computedAt: rows[0]?.computedAt.toISOString() ?? null,
    items: rows.slice(0, 500).map((r) => {
      const site = r.associate.assignments[0]?.location;
      return {
        associateId: r.associateId,
        name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
        photoUrl: r.associate.photoS3Key ? `/api/associates/${r.associateId}/photo?v=${r.associate.photoUpdatedAt?.getTime() ?? 0}` : null,
        score: r.score,
        band: r.band,
        reasons: (r.reasons as unknown as RiskReason[]).slice(0, 3),
        plays: r.plays as unknown as RetentionPlayKind[],
        store: site ? { id: site.id, name: site.name } : null,
        client: site?.client ? { id: site.client.id, name: site.client.name } : null,
        recentPlays: r.associate.retentionPlays.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      };
    }),
  });
});

retentionRouter.get('/retention/summary', VIEW, async (req, res) => {
  const user = req.user!;
  const tenantId = tenantIdForWrite();
  const scoped = { associate: scopeActiveAssociates(user) };
  const [bands, risky, plays] = await Promise.all([
    prisma.flightRisk.groupBy({ by: ['band'], where: { AND: [{ tenantId }, scoped] }, _count: { _all: true } }),
    prisma.flightRisk.findMany({
      where: { AND: [{ tenantId, band: { in: ['HIGH', 'MEDIUM'] } }, scoped] },
      select: { band: true, associate: { select: { assignments: { where: { endedAt: null }, take: 1, select: { location: { select: { id: true, name: true } } } } } } },
      take: 5000,
    }),
    // Which plays keep people: every play in reach that has an outcome.
    prisma.retentionPlay.groupBy({
      by: ['kind', 'outcome'],
      where: { AND: [{ tenantId }, { associate: scopeActiveAssociates(user, { former: true }) }] },
      _count: { _all: true },
    }),
  ]);
  const byStore = new Map<string, { id: string; name: string; high: number; medium: number }>();
  for (const r of risky) {
    const site = r.associate.assignments[0]?.location;
    if (!site) continue;
    const e = byStore.get(site.id) ?? { id: site.id, name: site.name, high: 0, medium: 0 };
    if (r.band === 'HIGH') e.high += 1;
    else e.medium += 1;
    byStore.set(site.id, e);
  }
  const playStats = KINDS.map((kind) => {
    const of = (o: string) => plays.find((p) => p.kind === kind && p.outcome === o)?._count._all ?? 0;
    const stayed = of('STAYED');
    const left = of('LEFT');
    return { kind, taken: stayed + left + of('PENDING'), stayed, left, pending: of('PENDING'), stayRate: stayed + left > 0 ? Math.round((stayed / (stayed + left)) * 100) : null };
  });
  res.json({
    bands: { HIGH: bands.find((b) => b.band === 'HIGH')?._count._all ?? 0, MEDIUM: bands.find((b) => b.band === 'MEDIUM')?._count._all ?? 0, LOW: bands.find((b) => b.band === 'LOW')?._count._all ?? 0 },
    stores: [...byStore.values()].sort((a, b) => b.high - a.high || b.medium - a.medium).slice(0, 8),
    plays: playStats,
  });
});

retentionRouter.get('/retention/crew', VIEW, async (req, res) => {
  const user = req.user!;
  const where = { AND: [{ tenantId: tenantIdForWrite() }, { associate: scopeActiveAssociates(user) }] };
  const [high, medium] = await Promise.all([
    prisma.flightRisk.count({ where: { AND: [...where.AND, { band: 'HIGH' as const }] } }),
    prisma.flightRisk.count({ where: { AND: [...where.AND, { band: 'MEDIUM' as const }] } }),
  ]);
  res.json({ high, medium });
});

const PlayBody = z.object({
  kind: z.enum(KINDS),
  note: z.string().trim().max(1000).optional(),
  /** PAY_REVIEW: the hourly rate proposed — it goes to a second person who holds compensation. */
  proposedRate: z.number().positive().max(500).optional(),
});

retentionRouter.post('/retention/:associateId/plays', VIEW, async (req, res) => {
  const user = req.user!;
  const associateId = z.string().uuid().parse(req.params.associateId);
  const body = PlayBody.parse(req.body ?? {});
  await assertAssociateInScope(prisma, user, associateId, { former: false });
  const risk = await prisma.flightRisk.findUnique({ where: { associateId }, select: { score: true, reasons: true } });
  let approvalId: string | null = null;
  if (body.kind === 'PAY_REVIEW') {
    if (!body.proposedRate) throw new HttpError(400, 'rate_required', 'A pay review needs the hourly rate you propose.');
    const person = await prisma.associate.findUniqueOrThrow({ where: { id: associateId }, select: { firstName: true, lastName: true } });
    const current = await prisma.compensationRecord.findFirst({ where: { associateId, payType: 'HOURLY' }, orderBy: { effectiveFrom: 'desc' }, select: { amount: true } });
    const open = await prisma.approvalRequest.findFirst({ where: { kind: 'PAY_RATE_CHANGE', associateId, status: 'PENDING' }, select: { id: true } });
    if (open) throw new HttpError(409, 'approval_pending', 'A pay change for this person is already waiting on a decision.');
    const fmt = (n: number) => `$${n.toFixed(2)}`;
    const request = await createApprovalRequest(prisma, {
      kind: 'PAY_RATE_CHANGE',
      subjectType: 'Associate',
      subjectId: associateId,
      title: `${person.firstName} ${person.lastName}: ${current ? `${fmt(Number(current.amount))} → ` : ''}${fmt(body.proposedRate)} per hour`,
      summary: `Retention pay review${body.note ? ` — ${body.note}` : ''}`,
      proposed: { associateId, effectiveFrom: new Date().toISOString(), payType: 'HOURLY', amount: body.proposedRate, reason: 'MARKET', notes: `Retention pay review${body.note ? `: ${body.note}` : ''}` },
      before: current ? { payType: 'HOURLY', amount: Number(current.amount) } : null,
      requesterUserId: user.id,
      approver: { capability: 'manage:comp' },
      associateId,
    });
    approvalId = request.id;
  }
  const play = await prisma.retentionPlay.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId,
      kind: body.kind,
      note: body.note ?? null,
      riskAtStart: risk?.score ?? 0,
      reasonsAtStart: (risk?.reasons ?? undefined) as Prisma.InputJsonValue | undefined,
      takenById: user.id,
      approvalId,
    },
  });
  enqueueAudit({ actorUserId: user.id, action: 'retention.play_logged', entityType: 'Associate', entityId: associateId, metadata: { playId: play.id, kind: body.kind, approvalId } }, 'retention');
  res.status(201).json({ playId: play.id, approvalId, pending: !!approvalId });
});

retentionRouter.patch('/retention/plays/:id', VIEW, async (req, res) => {
  const user = req.user!;
  const id = z.string().uuid().parse(req.params.id);
  const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
  const play = await prisma.retentionPlay.findFirst({ where: { id, tenantId: tenantIdForWrite() }, select: { associateId: true, note: true } });
  if (!play) throw new HttpError(404, 'play_not_found', 'Play not found.');
  await assertAssociateInScope(prisma, user, play.associateId);
  await prisma.retentionPlay.update({ where: { id }, data: { status: 'DONE', doneAt: new Date(), note: note ?? play.note } });
  res.json({ ok: true });
});

retentionRouter.post('/retention/recompute', requireCapability('manage:org'), async (_req, res) => {
  const r = await computeRetention(prisma);
  res.json(r);
});
