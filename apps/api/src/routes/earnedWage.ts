import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { ewaAvailability, loadEwaSettings, requestEarnedWageAdvance } from '../lib/earnedWage.js';
import { orgSettingIdFor } from '../lib/branding.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { scopeAssociates } from '../lib/scope.js';
import { idempotent } from '../middleware/idempotency.js';
import { dateKeyInZone, orgDateKey } from '../lib/timeAnomalies.js';

/**
 * Earned-wage access (lib/earnedWage.ts).
 *
 *   GET  /me/earned-wage           what the signed-in associate can draw now
 *   POST /me/earned-wage           draw it
 *   GET  /me/earned-wage/history   their advances
 *   GET  /payroll/earned-wage      Finance: every advance, the settings, the exposure
 *   PATCH /payroll/earned-wage/settings
 *
 * Mounted behind the `earnedWage` tenant module.
 */
export const earnedWageRouter = Router();

const PROCESS = requireCapability('process:payroll');

function requireAssociate(user: { associateId: string | null }): string {
  if (!user.associateId) throw new HttpError(403, 'not_an_associate', 'Only associates can draw earned wages.');
  return user.associateId;
}

function row(a: {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  amountCents: number;
  feeCents: number;
  status: string;
  provider: string | null;
  failureReason: string | null;
  requestedAt: Date;
  paidAt: Date | null;
  recoveredCents: number;
  recoveredAt: Date | null;
  associate?: { id: string; firstName: string; lastName: string } | null;
}) {
  return {
    id: a.id,
    periodStart: dateKeyInZone(a.periodStart, 'UTC'),
    periodEnd: dateKeyInZone(a.periodEnd, 'UTC'),
    amount: a.amountCents / 100,
    fee: a.feeCents / 100,
    status: a.status,
    provider: a.provider,
    failureReason: a.failureReason,
    requestedAt: a.requestedAt.toISOString(),
    paidAt: a.paidAt?.toISOString() ?? null,
    recovered: a.recoveredCents / 100,
    recoveredAt: a.recoveredAt?.toISOString() ?? null,
    ...(a.associate ? { associate: { id: a.associate.id, name: `${a.associate.firstName} ${a.associate.lastName}` } } : {}),
  };
}

earnedWageRouter.get('/me/earned-wage', async (req, res, next) => {
  try {
    const associateId = requireAssociate(req.user!);
    const a = await ewaAvailability(prisma, associateId);
    res.json({
      enabled: a.enabled,
      blocker: a.blocker,
      periodStart: a.periodStart,
      periodEnd: a.periodEnd,
      payDate: a.payDate,
      hoursWorked: a.hoursWorked,
      earnedGross: a.earnedGrossCents / 100,
      earnedNet: a.earnedNetCents / 100,
      capPct: a.capPct,
      cap: a.capCents / 100,
      maxPerPeriod: a.maxPerPeriodCents / 100,
      drawn: a.drawnCents / 100,
      available: a.availableCents / 100,
      fee: a.feeCents / 100,
      payoutTo: a.payoutTo,
    });
  } catch (err) {
    next(err);
  }
});

// Money out: a retried request with the same Idempotency-Key replays the first answer instead of paying again.
earnedWageRouter.post('/me/earned-wage', idempotent, async (req, res, next) => {
  try {
    const associateId = requireAssociate(req.user!);
    const amount = z.coerce.number().positive().max(10_000).parse(req.body?.amount);
    const amountCents = Math.round(amount * 100);
    const r = await requestEarnedWageAdvance(prisma, { associateId, amountCents, actor: { id: req.user!.id, role: req.user!.role }, req });
    res.status(r.status === 'FAILED' ? 502 : 201).json({ ...r, amount: r.amountCents / 100, fee: r.feeCents / 100 });
  } catch (err) {
    next(err);
  }
});

earnedWageRouter.get('/me/earned-wage/history', async (req, res, next) => {
  try {
    const associateId = requireAssociate(req.user!);
    const rows = await prisma.earnedWageAdvance.findMany({ where: { associateId }, orderBy: { requestedAt: 'desc' }, take: 50 });
    res.json({ advances: rows.map(row) });
  } catch (err) {
    next(err);
  }
});

/** Finance: every advance, newest first, with the settings and the outstanding exposure. */
/**
 * The desk's working numbers (F500 G3: its tiles repeated the policy —
 * "Offered On", "Cap 50%" — instead of saying what is happening):
 *   thisPeriod      advances drawn on the pay period running today (not failed or cancelled)
 *   lastRecovery    what the most recent payroll that recovered anything took back
 *   rolledOver      paid advances whose pay period has ended and that the check couldn't fully recover
 *   people          distinct people who drew an advance in the last 90 days
 */
async function ewaDeskStats(reach: Prisma.EarnedWageAdvanceWhereInput, now: Date = new Date()) {
  // The pay period running today on the company's calendar (deep audit MONEY-16), as a DATE.
  const today = new Date(`${orgDateKey(now)}T00:00:00.000Z`);
  const drawn: Prisma.EarnedWageAdvanceWhereInput = { ...reach, status: { in: ['REQUESTED', 'PAID', 'RECOVERED'] } };
  const [current, lastRecovered, rolled, recentPeople] = await Promise.all([
    prisma.earnedWageAdvance.aggregate({ where: { ...drawn, periodStart: { lte: today }, periodEnd: { gte: today } }, _sum: { amountCents: true }, _count: true }),
    prisma.earnedWageAdvance.findFirst({ where: { ...reach, recoveredRunId: { not: null }, recoveredAt: { not: null } }, orderBy: { recoveredAt: 'desc' }, select: { recoveredRunId: true, recoveredAt: true } }),
    prisma.earnedWageAdvance.findMany({ where: { ...reach, status: 'PAID', periodEnd: { lt: today } }, select: { amountCents: true, feeCents: true, recoveredCents: true } }),
    prisma.earnedWageAdvance.findMany({ where: { ...drawn, requestedAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } }, select: { associateId: true }, distinct: ['associateId'] }),
  ]);
  let lastRecovery: { runId: string; on: string; amount: number; advances: number } | null = null;
  if (lastRecovered?.recoveredRunId) {
    const runId = lastRecovered.recoveredRunId;
    // Each advance logs what each run took ([{runId, cents}]): the run's share across every advance it recovered.
    const touched = await prisma.earnedWageAdvance.findMany({ where: { ...reach, recoveryLog: { array_contains: [{ runId }] } }, select: { recoveryLog: true } });
    let cents = 0;
    let advances = 0;
    for (const t of touched) {
      const log = Array.isArray(t.recoveryLog) ? (t.recoveryLog as Array<{ runId?: string; cents?: number }>) : [];
      const share = log.filter((e) => e.runId === runId).reduce((a, e) => a + (e.cents ?? 0), 0);
      if (share > 0) {
        cents += share;
        advances += 1;
      }
    }
    lastRecovery = { runId, on: orgDateKey(lastRecovered.recoveredAt!), amount: cents / 100, advances };
  }
  const rolledOver = rolled.filter((r) => r.recoveredCents < r.amountCents + r.feeCents);
  return {
    thisPeriod: { count: current._count, amount: (current._sum.amountCents ?? 0) / 100 },
    lastRecovery,
    rolledOver: { count: rolledOver.length, amount: rolledOver.reduce((a, r) => a + r.amountCents + r.feeCents - r.recoveredCents, 0) / 100 },
    people: recentPeople.length,
  };
}

earnedWageRouter.get('/payroll/earned-wage', PROCESS, async (req, res, next) => {
  try {
    const status = z.enum(['OPEN', 'ALL', 'PAID', 'RECOVERED', 'FAILED']).catch('ALL').parse(req.query.status);
    // Every read is the tenant's, within this person's reach.
    const reach: Prisma.EarnedWageAdvanceWhereInput = { tenantId: tenantIdForWrite(), associate: scopeAssociates(req.user!) };
    const where: Prisma.EarnedWageAdvanceWhereInput = {
      ...reach,
      ...(status === 'OPEN' ? { status: { in: ['REQUESTED', 'PAID'] } } : status === 'ALL' ? {} : { status }),
    };
    const [rows, outstanding, settings, stats] = await Promise.all([
      prisma.earnedWageAdvance.findMany({
        where,
        include: { associate: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { requestedAt: 'desc' },
        take: 500,
      }),
      prisma.earnedWageAdvance.aggregate({ where: { ...reach, status: 'PAID' }, _sum: { amountCents: true, feeCents: true, recoveredCents: true }, _count: true }),
      loadEwaSettings(prisma),
      ewaDeskStats(reach),
    ]);
    res.json({
      settings: { enabled: settings.enabled, capPct: settings.capPct, fee: settings.feeCents / 100, maxPerPeriod: settings.maxPerPeriodCents / 100 },
      outstanding: {
        count: outstanding._count,
        amount: ((outstanding._sum.amountCents ?? 0) + (outstanding._sum.feeCents ?? 0) - (outstanding._sum.recoveredCents ?? 0)) / 100,
      },
      ...stats,
      advances: rows.map(row),
    });
  } catch (err) {
    next(err);
  }
});

const SettingsInput = z.object({
  enabled: z.boolean().optional(),
  capPct: z.number().int().min(0).max(100).optional(),
  fee: z.number().min(0).max(50).optional(),
  maxPerPeriod: z.number().min(0).max(100_000).optional(),
});

earnedWageRouter.patch('/payroll/earned-wage/settings', PROCESS, async (req, res, next) => {
  try {
    const input = SettingsInput.parse(req.body ?? {});
    const tenantId = tenantIdForWrite();
    const existing = await prisma.orgSetting.findFirst({ where: { OR: [{ tenantId }, { id: orgSettingIdFor(tenantId) }] }, select: { id: true } });
    const data = {
      ...(input.enabled !== undefined ? { ewaEnabled: input.enabled } : {}),
      ...(input.capPct !== undefined ? { ewaCapPct: input.capPct } : {}),
      ...(input.fee !== undefined ? { ewaFeeCents: Math.round(input.fee * 100) } : {}),
      ...(input.maxPerPeriod !== undefined ? { ewaMaxPerPeriodCents: Math.round(input.maxPerPeriod * 100) } : {}),
    };
    if (existing) await prisma.orgSetting.update({ where: { id: existing.id }, data });
    else await prisma.orgSetting.create({ data: { id: orgSettingIdFor(tenantId), tenantId, ...data } });
    enqueueAudit(
      { actorUserId: req.user!.id, action: 'ewa.settings_updated', entityType: 'OrgSetting', entityId: existing?.id ?? orgSettingIdFor(tenantId), metadata: data },
      'ewa.settings',
    );
    const s = await loadEwaSettings(prisma);
    res.json({ enabled: s.enabled, capPct: s.capPct, fee: s.feeCents / 100, maxPerPeriod: s.maxPerPeriodCents / 100 });
  } catch (err) {
    next(err);
  }
});
