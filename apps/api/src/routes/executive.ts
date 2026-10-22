import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { activeHeadcount } from '../lib/activeDefinition.js';
import { ageStatements } from '../lib/books/aging.js';
import { statementBalances } from '../lib/books/posting/receivables.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { isInternallyScoped } from '../lib/scope.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { formatRef } from '../lib/emailTemplates.js';
import { rolesWithCapability } from '@alto-people/shared';
import { computeExecutiveBriefing } from '../lib/executiveBriefing.js';
import { computeExecutiveDecisions } from '../lib/executiveDecisions.js';
import { computeExecutiveSummary, executiveNarrative } from '../lib/executiveSummary.js';
import { buildBoardPack } from '../lib/executiveBoardPack.js';
import { notifyUser } from '../lib/notify.js';
import { portalEngagementOverview } from '../lib/portalEngagement.js';
import { computeAgentRoi } from '../lib/agentRoi.js';
import { startOfWeekUTC } from '../lib/timeAnomalies.js';
import { env } from '../config/env.js';
import { executiveMoney } from '../lib/executiveMoney.js';

/**
 * Executive surfaces — the chairman's read-only layer.
 *
 * GET /executive/summary        → the numbers behind the executive dashboard
 * GET /executive/board-pack.pdf → a letterheaded board pack of the same
 *                                 numbers, ready to table at a meeting
 *
 * Both gated on view:executive (EXECUTIVE_CHAIRMAN + the FULL_ADMIN
 * family). All dollar figures are estimates at org standard rates; client
 * statements remain the invoice-grade artifact.
 */

export const executiveRouter = Router();

const EXEC = requireCapability('view:executive');

/**
 * The executive layer is the whole company by design: its numbers are
 * tenant-wide totals, margins and concentrations. An office account
 * narrowed to sites/regions is clamped out rather than shown a company
 * picture it may not hold (lib/scope.internalSites).
 */
executiveRouter.use((req, _res, next) => {
  if (req.user && isInternallyScoped(req.user)) {
    next(new HttpError(403, 'scope_too_narrow', 'The executive view covers the whole company; your access is limited to certain sites.'));
    return;
  }
  next();
});

executiveRouter.get('/summary', EXEC, async (_req: Request, res: Response) => {
  // Brief 2-1: explicit tenant until enforce mode (cross-tenant suite).
  const s = await computeExecutiveSummary(prisma, new Date(), { tenantId: tenantIdForWrite() });
  // The narrative rides with the numbers so the dashboard, the digest and
  // the board pack say the same thing.
  res.json({ ...s, narrative: executiveNarrative(s) });
});

// The morning brief: today's coverage + overnight incidents, the
// chairman's decision queue, client health scores, capacity + the J-1
// cliff, and the people worth knowing this week.
executiveRouter.get('/briefing', EXEC, async (_req: Request, res: Response) => {
  res.json(await computeExecutiveBriefing(prisma, new Date(), { tenantId: tenantIdForWrite() }));
});

// What the agents gave back over the last thirty days — hours of people's
// time saved against what they cost — the number beside margin.
executiveRouter.get('/agent-roi', EXEC, async (_req: Request, res: Response) => {
  res.json(await computeAgentRoi(prisma, new Date()));
});

// Who on the client side is using their site: last seen, sign-ins this
// week, the reports they pulled. The "are they even using it" card.
executiveRouter.get('/portal-engagement', EXEC, async (_req: Request, res: Response) => {
  res.json(await portalEngagementOverview(prisma));
});

// Batons in flight — the handoff spine's health, read-only. Every count
// is work sitting between two departments; when one runs deep, the
// chairman sees which building the baton is stuck in.
executiveRouter.get('/batons', EXEC, async (_req: Request, res: Response) => {
  const now = new Date();
  const DAY_MS = 86_400_000;
  const CASE_OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] as const;
  // Brief 2-1: every count is this tenant's.
  const T = tenantIdForWrite();

  const [closeOuts, fgCandidates, regs, unapprovedTimesheets, payrollCasesOpen, incidentsOpen] =
    await Promise.all([
      // Separated (or erased) workers still registered in Fieldglass.
      prisma.fieldglassRegistration.count({
        where: {
          tenantId: T,
          associate: {
            OR: [{ separatedAt: { not: null } }, { deletedAt: { not: null } }],
          },
        },
      }),
      // Recent approvals with no registration yet (active workers only).
      prisma.application.findMany({
        where: {
          tenantId: T,
          status: 'APPROVED',
          approvedAt: { gte: new Date(now.getTime() - 60 * DAY_MS) },
          deletedAt: null,
          associate: {
            deletedAt: null,
            separatedAt: null,
            deactivatedAt: null,
            fieldglassRegistration: { is: null },
          },
        },
        select: { associateId: true },
        take: 200,
      }),
      // Registered under one client while openly assigned at another.
      prisma.fieldglassRegistration.findMany({
        where: {
          tenantId: T,
          clientId: { not: null },
          associate: { deletedAt: null, separatedAt: null },
        },
        select: {
          clientId: true,
          associate: {
            select: {
              assignments: {
                where: { endedAt: null },
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: { location: { select: { clientId: true } } },
              },
            },
          },
        },
        take: 500,
      }),
      prisma.timeEntry.count({
        where: { tenantId: T, status: 'COMPLETED', clockOutAt: { not: null } },
      }),
      prisma.hrCase.count({
        where: { tenantId: T, category: 'PAYROLL', status: { in: [...CASE_OPEN] } },
      }),
      prisma.oshaIncident.count({ where: { tenantId: T, status: { not: 'RESOLVED' } } }),
    ]);

  const candidateIds = [...new Set(fgCandidates.map((a) => a.associateId))];
  const [everScheduled, upcomingScheduled] =
    candidateIds.length > 0
      ? await Promise.all([
          prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: candidateIds },
              status: { in: ['ASSIGNED', 'COMPLETED'] },
            },
            distinct: ['assignedAssociateId'],
            select: { assignedAssociateId: true },
          }),
          prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: candidateIds },
              status: 'ASSIGNED',
              startsAt: { gte: now },
            },
            distinct: ['assignedAssociateId'],
            select: { assignedAssociateId: true },
          }),
        ])
      : [[], []];
  const everSet = new Set(everScheduled.map((s) => s.assignedAssociateId));
  const upcomingSet = new Set(upcomingScheduled.map((s) => s.assignedAssociateId));
  // Adds = approved AND scheduled but not yet registered (Finance's queue);
  // ready-to-schedule = approved but holding no upcoming shift (WFM's).
  const adds = candidateIds.filter((id) => everSet.has(id)).length;
  const readyToSchedule = candidateIds.filter((id) => !upcomingSet.has(id)).length;
  const transfers = regs.filter((r) => {
    const cur = r.associate.assignments[0]?.location.clientId;
    return cur !== undefined && cur !== r.clientId;
  }).length;

  res.json({
    generatedAt: now.toISOString(),
    batons: {
      fieldglass: { closeOuts, transfers, adds },
      readyToSchedule,
      unapprovedTimesheets,
      payrollCasesOpen,
      incidentsOpen,
    },
  });
});

/* ===== Decision actions ==================================================== */
//
// The chairman's ONLY write surface — and it touches nothing but his own
// queue's state overlay. Dismiss = deliberately not acting (re-raises if
// stakes grow 1.25×); snooze = 7 days; delegate = fans the item out to
// every manage:org admin's bell + email and keeps it visible as
// "with your team" until the underlying condition resolves.

const DecisionActionSchema = z.object({
  action: z.enum(['dismiss', 'snooze', 'delegate']),
  note: z.string().trim().max(300).optional(),
});

executiveRouter.post('/decisions/action', EXEC, async (req: Request, res: Response) => {
  const key = z
    .string()
    .regex(/^[a-zA-Z0-9:_-]{3,120}$/)
    .parse(req.body?.key);
  const input = DecisionActionSchema.parse(req.body);

  const decisions = await computeExecutiveDecisions(prisma, new Date(), { tenantId: tenantIdForWrite() });
  const item = decisions.find((d) => d.key === key);
  if (!item) {
    throw new HttpError(404, 'not_found', 'That decision is no longer in the queue.');
  }

  const data =
    input.action === 'dismiss'
      ? {
          status: 'DISMISSED',
          snoozeUntil: null,
          stakesAtAction: item.stakes,
          actedById: req.user!.id,
          actedAt: new Date(),
          note: input.note ?? null,
        }
      : input.action === 'snooze'
        ? {
            status: 'SNOOZED',
            snoozeUntil: new Date(Date.now() + 7 * 86_400_000),
            stakesAtAction: item.stakes,
            actedById: req.user!.id,
            actedAt: new Date(),
            note: input.note ?? null,
          }
        : {
            status: 'DELEGATED',
            snoozeUntil: null,
            stakesAtAction: item.stakes,
            actedById: req.user!.id,
            actedAt: new Date(),
            note: input.note ?? null,
          };
  await prisma.execDecisionState.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: `executive.decision_${input.action}`,
      entityType: 'ExecDecisionState',
      entityId: key,
      metadata: { label: item.label, stakes: item.stakes, note: input.note ?? null },
    },
    'executive.decisions',
  );

  if (input.action === 'delegate') {
    const adminRoles = rolesWithCapability('manage:org');
    const admins = await prisma.user.findMany({
      where: {
        role: { in: adminRoles },
        status: 'ACTIVE',
        deletedAt: null,
        id: { not: req.user!.id },
      },
      select: { id: true },
      take: 25,
    });
    for (const a of admins) {
      await notifyUser(a.id, {
        subject: `Delegated by the chairman: ${item.label}`,
        body: `${item.detail}${input.note ? `\n\nNote from the chairman: ${input.note}` : ''}`,
        category: 'executive_delegation',
        linkUrl: item.linkUrl,
      });
    }
  }
  res.json({ ok: true });
});

/* ===== The money band (finance walk 17) ================================== */

// Real money, not estimates: cash today from the books, the 13-week low
// point from the cash forecast, month-to-date profit against the budget,
// days to collect by month, and what each payroll run cost
// (lib/executiveMoney). Whole company, like every route here.
executiveRouter.get('/money', EXEC, async (_req: Request, res: Response) => {
  res.json(await executiveMoney(prisma, new Date()));
});

/* ===== Receivables — the cash view ======================================= */
//
// Staffing economics 101: payroll goes out weekly, client cash arrives in
// 30-60 days. This view ages every open FINAL statement by days past its
// due date (lib/books/aging — the same definition the finance home and
// Books use) and reports the effective days-to-pay so the working-capital
// gap is a number, not a feeling.

executiveRouter.get(
  '/receivables',
  requireAnyCapability('view:executive', 'process:payroll'),
  async (_req: Request, res: Response) => {
    const finals = await prisma.clientStatement.findMany({
      where: { tenantId: tenantIdForWrite(), status: 'FINAL' },
      select: {
        id: true,
        clientId: true,
        number: true,
        periodStart: true,
        periodEnd: true,
        finalizedAt: true,
        dueAt: true,
        paidAt: true,
        paymentRef: true,
        snapshot: true,
        client: { select: { name: true } },
      },
      orderBy: { finalizedAt: 'asc' },
      take: 500,
    });
    const totalOf = (snapshot: unknown): number => {
      const t = (snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
      return typeof t === 'number' ? t : 0;
    };
    // One aging definition (lib/books/aging): ageDays is days past DUE, and the
    // buckets are the Books buckets; each statement counts what is still OPEN on it
    // (net of partial payments, lib/books/posting/receivables) — the same numbers the
    // finance home and Books show.
    const unpaid = finals.filter((s) => !s.paidAt);
    const balances = unpaid.length ? await statementBalances(prisma, { id: { in: unpaid.map((s) => s.id) } }) : [];
    const openOf = new Map(balances.map((b) => [b.statementId, b.open / 100]));
    const aged = ageStatements(unpaid.map((s) => ({ ...s, amount: openOf.get(s.id) ?? totalOf(s.snapshot) })).filter((s) => s.amount > 0));
    const outstanding = aged.statements
      .map(({ row: s, daysPastDue, dueOn }) => ({
        id: s.id,
        clientId: s.clientId,
        clientName: s.client.name,
        number: s.number,
        periodStart: s.periodStart.toISOString().slice(0, 10),
        periodEnd: s.periodEnd.toISOString().slice(0, 10),
        finalizedAt: s.finalizedAt?.toISOString() ?? null,
        dueOn,
        amount: s.amount,
        ageDays: daysPastDue,
      }))
      .sort((a, b) => b.ageDays - a.ageDays);
    const paid = finals.filter((s) => s.paidAt && s.finalizedAt);
    const avgDaysToPay =
      paid.length > 0
        ? Math.round(
            paid.reduce(
              (n, s) => n + (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / 86_400_000,
              0,
            ) / paid.length,
          )
        : null;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    res.json({
      outstanding,
      totals: {
        outstandingAmount: r2(aged.total),
        outstandingCount: outstanding.length,
        aging: {
          current: r2(aged.buckets.current),
          days1to30: r2(aged.buckets.days1to30),
          days31to60: r2(aged.buckets.days31to60),
          days61to90: r2(aged.buckets.days61to90),
          over90: r2(aged.buckets.over90),
        },
        avgDaysToPay,
        paidCount: paid.length,
      },
    });
  },
);

/* ===== Quarterly targets vs actuals ====================================== */

const TargetsInputSchema = z.object({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
  revenueTarget: z.number().nonnegative().nullable().optional(),
  marginTarget: z.number().nonnegative().nullable().optional(),
  headcountTarget: z.number().int().nonnegative().nullable().optional(),
  turnoverPctTarget: z.number().nonnegative().max(999).nullable().optional(),
  fillRatePctTarget: z.number().nonnegative().max(100).nullable().optional(),
});

function currentQuarter(now: Date): { key: string; start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3);
  return {
    key: `${y}-Q${q + 1}`,
    start: new Date(Date.UTC(y, q * 3, 1)),
    end: new Date(Date.UTC(y, q * 3 + 3, 1)),
  };
}

executiveRouter.get('/targets', EXEC, async (_req: Request, res: Response) => {
  const now = new Date();
  const quarter = currentQuarter(now);
  // The quarter key is unique platform-wide; read it only as this tenant's.
  const target = await prisma.execTarget.findFirst({ where: { quarter: quarter.key, tenantId: tenantIdForWrite() } });
  // Brief 2-1: the quarter's punches, headcount and shifts are this tenant's own.
  const T = { tenantId: tenantIdForWrite() };

  // Quarter-to-date economics from approved/completed punches, per-
  // associate-org-week OT, at standard rates — same math as the summary.
  const entries = await prisma.timeEntry.findMany({
    where: {
      ...T,
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockInAt: { gte: quarter.start, lt: now },
    },
    select: {
      associateId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { startedAt: true, endedAt: true } },
    },
    take: 100_000,
  });
  const byAssocWeek = new Map<string, number>();
  for (const e of entries) {
    if (!e.clockOutAt) continue;
    let ms = e.clockOutAt.getTime() - e.clockInAt.getTime();
    for (const b of e.breaks) {
      const bEnd = b.endedAt ? b.endedAt.getTime() : e.clockOutAt.getTime();
      ms -= Math.max(0, bEnd - b.startedAt.getTime());
    }
    const mins = Math.max(0, Math.round(ms / 60_000));
    const key = `${e.associateId}:${startOfWeekUTC(e.clockInAt).getTime()}`;
    byAssocWeek.set(key, (byAssocWeek.get(key) ?? 0) + mins);
  }
  let workedMin = 0;
  let otMin = 0;
  for (const mins of byAssocWeek.values()) {
    workedMin += mins;
    otMin += Math.max(0, mins - 40 * 60);
  }
  const hours = workedMin / 60;
  const otHours = otMin / 60;
  const revenueQtd =
    hours * env.DEFAULT_ASSOCIATE_BILL_RATE + otHours * env.DEFAULT_ASSOCIATE_BILL_RATE * 0.5;
  const costQtd =
    (hours * env.DEFAULT_ASSOCIATE_PAY_RATE + otHours * env.DEFAULT_ASSOCIATE_PAY_RATE * 0.5) *
      (1 + env.LABOR_BURDEN_PERCENT / 100) +
    hours * env.LABOR_OVERHEAD_PER_HOUR;

  const [headcount, separationsQtd, published, assigned] = await Promise.all([
    // Brief 1A-2: the one definition of active.
    activeHeadcount(T, now),
    prisma.associate.count({ where: { ...T, separatedAt: { gte: quarter.start } } }),
    prisma.shift.count({
      where: {
        ...T,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: quarter.start, lt: now },
      },
    }),
    prisma.shift.count({
      where: {
        ...T,
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: quarter.start, lt: now },
        assignedAssociateId: { not: null },
      },
    }),
  ]);
  const quarterMs = quarter.end.getTime() - quarter.start.getTime();
  const elapsed = Math.min(1, Math.max(0.01, (now.getTime() - quarter.start.getTime()) / quarterMs));
  const avgHeadcount = Math.max(1, headcount + separationsQtd / 2);
  const turnoverAnnualizedPct = Math.round(((separationsQtd / elapsed / avgHeadcount) * 100) * 10) / 10;

  res.json({
    quarter: quarter.key,
    elapsedPct: Math.round(elapsed * 100),
    targets: target
      ? {
          revenueTarget: target.revenueTarget === null ? null : Number(target.revenueTarget),
          marginTarget: target.marginTarget === null ? null : Number(target.marginTarget),
          headcountTarget: target.headcountTarget,
          turnoverPctTarget:
            target.turnoverPctTarget === null ? null : Number(target.turnoverPctTarget),
          fillRatePctTarget:
            target.fillRatePctTarget === null ? null : Number(target.fillRatePctTarget),
        }
      : null,
    actuals: {
      revenueQtd: Math.round(revenueQtd * 100) / 100,
      marginQtd: Math.round((revenueQtd - costQtd) * 100) / 100,
      headcount,
      turnoverAnnualizedPct,
      fillRatePct: published > 0 ? Math.round((assigned / published) * 1000) / 10 : null,
    },
  });
});

// Setting targets is a WRITE — admins only, never the read-only chairman.
executiveRouter.put(
  '/targets',
  requireCapability('manage:org'),
  async (req: Request, res: Response) => {
    const input = TargetsInputSchema.parse(req.body);
    const { quarter, ...fields } = input;
    // One row per (tenant, quarter): find this tenant's, else create it.
    const tenantId = tenantIdForWrite();
    const existing = await prisma.execTarget.findFirst({ where: { quarter, tenantId }, select: { id: true } });
    const row = existing
      ? await prisma.execTarget.update({ where: { id: existing.id }, data: fields })
      : await prisma.execTarget.create({ data: { quarter, tenantId, ...fields } });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'executive.targets_set',
        entityType: 'ExecTarget',
        entityId: row.id,
        metadata: { quarter, ...fields },
      },
      'executive.targets',
    );
    res.json({ ok: true });
  },
);

/* ===== New-business pipeline ============================================= */

const ProspectInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  stage: z.enum(['LEAD', 'CONTACTED', 'PROPOSAL', 'VERBAL', 'WON', 'LOST']).optional(),
  estWeeklyHours: z.number().int().nonnegative().max(100_000).nullable().optional(),
  estBillRate: z.number().nonnegative().max(10_000).nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
});

const PROSPECT_WRITE = requireCapability('manage:clients');

executiveRouter.get('/prospects', EXEC, async (_req: Request, res: Response) => {
  const rows = await prisma.clientProspect.findMany({
    where: { tenantId: tenantIdForWrite(), deletedAt: null },
    orderBy: [{ stage: 'asc' }, { updatedAt: 'desc' }],
    take: 200,
  });
  res.json({
    prospects: rows.map((p) => ({
      id: p.id,
      name: p.name,
      stage: p.stage,
      estWeeklyHours: p.estWeeklyHours,
      estBillRate: p.estBillRate === null ? null : Number(p.estBillRate),
      notes: p.notes,
      updatedAt: p.updatedAt.toISOString(),
    })),
  });
});

executiveRouter.post('/prospects', PROSPECT_WRITE, async (req: Request, res: Response) => {
  const input = ProspectInputSchema.parse(req.body);
  const row = await prisma.clientProspect.create({
    data: {
      name: input.name,
      stage: input.stage ?? 'LEAD',
      estWeeklyHours: input.estWeeklyHours ?? null,
      estBillRate: input.estBillRate ?? null,
      notes: input.notes ?? null,
    },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'executive.prospect_created',
      entityType: 'ClientProspect',
      entityId: row.id,
      metadata: { name: row.name },
    },
    'executive.prospects',
  );
  res.status(201).json({ id: row.id });
});

executiveRouter.patch('/prospects/:id', PROSPECT_WRITE, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = ProspectInputSchema.partial().parse(req.body);
  const existing = await prisma.clientProspect.findFirst({
    where: { id, deletedAt: null, tenantId: tenantIdForWrite() },
  });
  if (!existing) throw new HttpError(404, 'not_found', 'Prospect not found.');
  await prisma.clientProspect.update({ where: { id }, data: input });
  res.json({ ok: true });
});

executiveRouter.delete('/prospects/:id', PROSPECT_WRITE, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  // Brief 2-1: another tenant's prospect is not found (cross-tenant suite).
  const existing = await prisma.clientProspect.findFirst({ where: { id, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'Prospect not found.');
  await prisma.clientProspect.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  res.json({ ok: true });
});


executiveRouter.get('/board-pack.pdf', EXEC, async (req: Request, res: Response) => {
  const s = await computeExecutiveSummary(prisma, new Date(), { tenantId: tenantIdForWrite() });
  const refId = formatRef();
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'executive.board_pack_generated',
      entityType: 'Organization',
      entityId: 'BOARD_PACK',
      metadata: { reference: refId },
    },
    'executive.board_pack',
  );

  const buf = await buildBoardPack(s, refId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="board-pack-${s.generatedAt.slice(0, 10)}.pdf"`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
});
