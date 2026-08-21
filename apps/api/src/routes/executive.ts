import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { formatRef } from '../lib/emailTemplates.js';
import { ReportPdf } from '../lib/reportPdf.js';
import { rolesWithCapability } from '@alto-people/shared';
import { computeExecutiveBriefing } from '../lib/executiveBriefing.js';
import { computeExecutiveDecisions } from '../lib/executiveDecisions.js';
import { computeExecutiveSummary } from '../lib/executiveSummary.js';
import { notifyUser } from '../lib/notify.js';
import { startOfWeekUTC } from '../lib/timeAnomalies.js';
import { env } from '../config/env.js';

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

executiveRouter.get('/summary', EXEC, async (_req: Request, res: Response) => {
  res.json(await computeExecutiveSummary(prisma));
});

// The morning brief: today's coverage + overnight incidents, the
// chairman's decision queue, client health scores, capacity + the J-1
// cliff, and the people worth knowing this week.
executiveRouter.get('/briefing', EXEC, async (_req: Request, res: Response) => {
  res.json(await computeExecutiveBriefing(prisma));
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

  const decisions = await computeExecutiveDecisions(prisma);
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

/* ===== Receivables — the cash view ======================================= */
//
// Staffing economics 101: payroll goes out weekly, client cash arrives in
// 30-60 days. This view ages every FINAL statement from finalizedAt until
// payment is recorded (POST .../mark-paid in clients.ts) and reports the
// effective days-to-pay so the working-capital gap is a number, not a
// feeling.

executiveRouter.get(
  '/receivables',
  requireAnyCapability('view:executive', 'process:payroll'),
  async (_req: Request, res: Response) => {
    const finals = await prisma.clientStatement.findMany({
      where: { status: 'FINAL' },
      select: {
        id: true,
        clientId: true,
        number: true,
        periodStart: true,
        periodEnd: true,
        finalizedAt: true,
        paidAt: true,
        paymentRef: true,
        snapshot: true,
        client: { select: { name: true } },
      },
      orderBy: { finalizedAt: 'asc' },
      take: 500,
    });
    const now = Date.now();
    const totalOf = (snapshot: unknown): number => {
      const t = (snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
      return typeof t === 'number' ? t : 0;
    };
    const outstanding = finals
      .filter((s) => !s.paidAt)
      .map((s) => ({
        id: s.id,
        clientId: s.clientId,
        clientName: s.client.name,
        number: s.number,
        periodStart: s.periodStart.toISOString().slice(0, 10),
        periodEnd: s.periodEnd.toISOString().slice(0, 10),
        finalizedAt: s.finalizedAt?.toISOString() ?? null,
        amount: totalOf(s.snapshot),
        ageDays: s.finalizedAt
          ? Math.floor((now - s.finalizedAt.getTime()) / 86_400_000)
          : 0,
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
    const bucket = (lo: number, hi: number | null) =>
      outstanding
        .filter((s) => s.ageDays >= lo && (hi === null || s.ageDays < hi))
        .reduce((n, s) => n + s.amount, 0);
    res.json({
      outstanding,
      totals: {
        outstandingAmount: Math.round(outstanding.reduce((n, s) => n + s.amount, 0) * 100) / 100,
        outstandingCount: outstanding.length,
        aging: {
          current: Math.round(bucket(0, 30) * 100) / 100,
          days30: Math.round(bucket(30, 45) * 100) / 100,
          days45: Math.round(bucket(45, 60) * 100) / 100,
          days60plus: Math.round(bucket(60, null) * 100) / 100,
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
  const target = await prisma.execTarget.findUnique({ where: { quarter: quarter.key } });

  // Quarter-to-date economics from approved/completed punches, per-
  // associate-org-week OT, at standard rates — same math as the summary.
  const entries = await prisma.timeEntry.findMany({
    where: {
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
    prisma.associate.count({
      where: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        applications: { some: { status: 'APPROVED', deletedAt: null } },
      },
    }),
    prisma.associate.count({ where: { separatedAt: { gte: quarter.start } } }),
    prisma.shift.count({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: quarter.start, lt: now },
      },
    }),
    prisma.shift.count({
      where: {
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
    const row = await prisma.execTarget.upsert({
      where: { quarter },
      create: { quarter, ...fields },
      update: fields,
    });
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
    where: { deletedAt: null },
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
    where: { id, deletedAt: null },
  });
  if (!existing) throw new HttpError(404, 'not_found', 'Prospect not found.');
  await prisma.clientProspect.update({ where: { id }, data: input });
  res.json({ ok: true });
});

executiveRouter.delete('/prospects/:id', PROSPECT_WRITE, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  await prisma.clientProspect.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  res.json({ ok: true });
});

const money = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

executiveRouter.get('/board-pack.pdf', EXEC, async (req: Request, res: Response) => {
  const s = await computeExecutiveSummary(prisma);
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

  const facts = [
    { label: 'Prepared for', value: 'Board / executive review' },
    { label: 'Generated', value: s.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC' },
  ];
  const confidentialityNote =
    'CONFIDENTIAL — internal board material. Figures marked "est." are computed at org standard rates; finalized client statements are the invoice-grade record.';

  const pdf = new ReportPdf({
    title: 'Executive Board Pack',
    subtitle:
      'Workforce, labor, and client posture at a glance — one page per topic, drawn live from the compliance system at generation time.',
    facts,
    reference: refId,
    confidentialityNote,
  });

  pdf.heading('Workforce');
  pdf.kv([
    { label: 'Active associates', value: String(s.workforce.active) },
    { label: 'Temporarily deactivated', value: String(s.workforce.deactivated) },
    { label: 'Hires (last 30 days)', value: String(s.workforce.hires30d) },
    { label: 'Separations (last 30 days)', value: String(s.workforce.separations30d) },
    { label: 'Onboarding in flight', value: String(s.workforce.onboardingInFlight) },
  ]);

  pdf.heading('Labor — last complete week vs current week');
  pdf.table(
    [
      { label: 'Week', width: 120 },
      { label: 'Hours', width: 70, align: 'right' },
      { label: 'OT hours', width: 70, align: 'right' },
      { label: 'Heads', width: 60, align: 'right' },
      { label: 'Est. billed', align: 'right' },
      { label: 'Est. labor cost', align: 'right' },
      { label: 'Est. margin', align: 'right' },
    ],
    [
      [
        `${s.lastWeek.start.slice(0, 10)} (complete)`,
        s.lastWeek.workedHours.toFixed(2),
        s.lastWeek.otHours.toFixed(2),
        s.lastWeek.headsWorked,
        money(s.lastWeek.estBilled),
        money(s.lastWeek.estLaborCost),
        money(s.lastWeek.estMargin),
      ],
      [
        `${s.thisWeek.start.slice(0, 10)} (in progress)`,
        s.thisWeek.workedHours.toFixed(2),
        s.thisWeek.otHours.toFixed(2),
        s.thisWeek.headsWorked,
        money(s.thisWeek.estBilled),
        money(s.thisWeek.estLaborCost),
        money(s.thisWeek.estMargin),
      ],
    ],
  );
  pdf.para(
    'Weeks run Saturday 00:00 through Friday 24:00, Florida-local — the org FLSA workweek. Overtime is the weekly over-40 tail per associate.',
    { muted: true, size: 8.5 },
  );

  pdf.heading('Eight-week trend');
  pdf.table(
    [
      { label: 'Week of', width: 90 },
      { label: 'Hours', width: 80, align: 'right' },
      { label: 'OT hours', width: 80, align: 'right' },
      { label: 'Heads', width: 60, align: 'right' },
      { label: 'Est. billed', align: 'right' },
      { label: 'Est. margin', align: 'right' },
    ],
    s.trend.map((w) => [
      w.start.slice(0, 10),
      w.workedHours.toFixed(1),
      w.otHours.toFixed(1),
      w.headsWorked,
      money(w.estBilled),
      money(w.estMargin),
    ]),
  );

  pdf.heading('Attendance — unexcused events, last 30 days');
  if (s.attendance30d.length > 0) {
    pdf.table(
      [
        { label: 'Event', width: 220 },
        { label: 'Count', align: 'right' },
      ],
      s.attendance30d.map((a) => [a.kind.replace(/_/g, ' '), a.count]),
    );
  } else {
    pdf.para('No unexcused attendance events in the last 30 days.', { muted: true });
  }

  pdf.heading('Store profitability league — last 4 weeks');
  if (s.league.length > 0) {
    pdf.table(
      [
        { label: 'Store', width: 220 },
        { label: 'Hours', width: 70, align: 'right' },
        { label: 'OT h', width: 60, align: 'right' },
        { label: 'Est. billed', align: 'right' },
        { label: 'Est. margin', align: 'right' },
      ],
      s.league.map((r) => [
        `${r.clientName} — ${r.locationName}`,
        r.hours.toFixed(1),
        r.otHours.toFixed(1),
        money(r.estBilled),
        money(r.estMargin),
      ]),
    );
  } else {
    pdf.para('No worked time in the window.', { muted: true });
  }

  pdf.heading('Revenue concentration & churn');
  pdf.kv([
    ...s.concentration
      .slice(0, 5)
      .map((c) => ({ label: c.clientName, value: `${c.sharePct.toFixed(1)}% of est. billed` })),
    {
      label: 'Turnover cost (90 days)',
      value: `${s.turnover.separations90d} separations × ${money(s.turnover.costPerSeparation)} ≈ ${money(s.turnover.estCost90d)}`,
    },
  ]);

  // Receivables snapshot — the cash view, straight into the pack.
  const unpaidFinals = await prisma.clientStatement.findMany({
    where: { status: 'FINAL', paidAt: null },
    select: { finalizedAt: true, snapshot: true },
    take: 500,
  });
  const arAmount = unpaidFinals.reduce((n, r) => {
    const t = (r.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
    return n + (typeof t === 'number' ? t : 0);
  }, 0);
  const oldestDays = unpaidFinals.reduce((m, r) => {
    if (!r.finalizedAt) return m;
    return Math.max(m, Math.floor((Date.now() - r.finalizedAt.getTime()) / 86_400_000));
  }, 0);
  pdf.heading('Receivables');
  pdf.kv([
    { label: 'Outstanding statements', value: String(unpaidFinals.length) },
    { label: 'Outstanding amount', value: money(Math.round(arAmount * 100) / 100) },
    ...(unpaidFinals.length > 0
      ? [{ label: 'Oldest outstanding', value: `${oldestDays} days` }]
      : []),
  ]);

  pdf.heading('Client placements');
  if (s.clients.length > 0) {
    pdf.table(
      [
        { label: 'Client', width: 260 },
        { label: 'Active associates placed', align: 'right' },
      ],
      s.clients.map((c) => [c.clientName, c.activeAssociates]),
    );
  } else {
    pdf.para('No open site placements on record.', { muted: true });
  }

  const buf = await pdf.render();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="board-pack-${s.generatedAt.slice(0, 10)}.pdf"`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
});
