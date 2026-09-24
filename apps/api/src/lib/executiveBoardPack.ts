import { prisma } from '../db.js';
import { ReportPdf } from './reportPdf.js';
import { executiveNarrative, type ExecutiveSummary } from './executiveSummary.js';

/**
 * The executive board pack as bytes — one page per topic, drawn live from
 * the compliance system at generation time. Built here so the on-demand
 * download (routes/executive) and the Saturday digest's attachment are the
 * same document.
 */

const money = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function buildBoardPack(s: ExecutiveSummary, refId: string): Promise<Buffer> {
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

  // The week in a few sentences, before any table — the same words the
  // Saturday digest and the dashboard carry.
  pdf.heading('The week in brief');
  for (const line of executiveNarrative(s)) pdf.para(line);

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
  return buf;
}
