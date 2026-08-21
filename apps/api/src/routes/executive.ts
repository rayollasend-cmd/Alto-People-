import { Router, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { formatRef } from '../lib/emailTemplates.js';
import { ReportPdf } from '../lib/reportPdf.js';
import { computeExecutiveSummary } from '../lib/executiveSummary.js';

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
