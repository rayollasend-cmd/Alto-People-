import PDFDocument from 'pdfkit';
import type { PrismaClient } from '@prisma/client';
import { computeStatementSnapshot, type StatementSnapshot } from './clientStatement.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * Weekly Client Service Report — the hand-to-the-store-manager PDF.
 *
 * The portal-grade view of one client's week, as a letterheaded document
 * Alto can download and physically or digitally hand to the client:
 * coverage and fill rate, the day-by-day picture, the team that worked,
 * next week's readiness, reliability (no-shows and how they were
 * covered), and billing status. Built on the SAME computation as the
 * client statement (computeStatementSnapshot), so the numbers a store
 * manager sees here always reconcile with the invoice they receive.
 *
 * Deliberately a report, not a portal: no accounts to provision for
 * client staff, works in a sales pitch, and Alto controls when it goes
 * out and what week it covers.
 */

export interface ServiceReportData {
  clientName: string;
  orgName: string;
  periodStart: string; // YYYY-MM-DD, org-local Saturday
  periodEnd: string; // YYYY-MM-DD, org-local Friday
  generatedAt: string;
  snapshot: StatementSnapshot;
  /** Org-local day rows Sat→Fri. */
  days: {
    key: string;
    label: string;
    shifts: number;
    assigned: number;
    open: number;
    plannedHours: number;
  }[];
  roster: { name: string; positions: string; hours: number }[];
  rosterTruncated: number;
  reliability: {
    noShows: number;
    noShowsCovered: number;
    pickupsApproved: number;
  };
  nextWeek: { shifts: number; assigned: number; confirmed: number };
  statements: {
    period: string;
    label: string;
    amount: number | null;
    paidAt: string | null;
  }[];
}

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function buildClientServiceReport(
  prisma: PrismaClient,
  clientId: string,
  weekStart: Date,
  orgName: string,
): Promise<ServiceReportData> {
  const startKey = orgDateKey(weekStart);
  const start = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 6 * 24 * 3_600_000);
  const endExclusive = new Date(start.getTime() + 7 * 24 * 3_600_000);
  const nextEndExclusive = new Date(start.getTime() + 14 * 24 * 3_600_000);

  const snapshot = await computeStatementSnapshot(prisma, clientId, start, endExclusive);

  // The week's shifts — the same window the statement bills.
  const weekStartInstant = weekStart;
  const weekEndInstant = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  const shifts = await prisma.shift.findMany({
    where: {
      clientId,
      status: { not: 'CANCELLED' },
      startsAt: { gte: weekStartInstant, lt: weekEndInstant },
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      position: true,
      noShowNotifiedAt: true,
      assignedAssociateId: true,
      assignedAssociate: { select: { firstName: true, lastName: true } },
      timeEntries: { select: { id: true }, take: 1 },
    },
    orderBy: { startsAt: 'asc' },
    take: 3000,
  });

  // Day-by-day (org-local days; overnight shifts belong to their start day).
  const dayMap = new Map<string, { shifts: number; assigned: number; open: number; plannedHours: number }>();
  for (let i = 0; i < 7; i++) {
    dayMap.set(orgDateKey(new Date(weekStartInstant.getTime() + i * 24 * 3_600_000)), {
      shifts: 0,
      assigned: 0,
      open: 0,
      plannedHours: 0,
    });
  }
  const rosterMap = new Map<string, { name: string; positions: Set<string>; hours: number }>();
  let noShows = 0;
  let noShowsCovered = 0;
  for (const s of shifts) {
    const key = orgDateKey(s.startsAt);
    const day = dayMap.get(key);
    const hours = Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000);
    if (day) {
      day.shifts += 1;
      if (s.assignedAssociateId) day.assigned += 1;
      else day.open += 1;
      day.plannedHours += hours;
    }
    if (s.assignedAssociateId && s.assignedAssociate) {
      const r = rosterMap.get(s.assignedAssociateId) ?? {
        name: `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`,
        positions: new Set<string>(),
        hours: 0,
      };
      r.positions.add(s.position);
      r.hours += hours;
      rosterMap.set(s.assignedAssociateId, r);
    }
    if (s.noShowNotifiedAt) {
      noShows += 1;
      if (s.timeEntries.length > 0) noShowsCovered += 1;
    }
  }
  const rosterAll = [...rosterMap.values()]
    .map((r) => ({
      name: r.name,
      positions: [...r.positions].join(', '),
      hours: Math.round(r.hours * 10) / 10,
    }))
    .sort((a, b) => b.hours - a.hours);
  const ROSTER_CAP = 70;
  const roster = rosterAll.slice(0, ROSTER_CAP);

  const pickupsApproved = await prisma.openShiftClaim.count({
    where: {
      status: 'APPROVED',
      decidedAt: { gte: weekStartInstant, lt: weekEndInstant },
      shift: { is: { clientId } },
    },
  });

  const nextShifts = await prisma.shift.findMany({
    where: {
      clientId,
      status: { not: 'CANCELLED' },
      startsAt: { gte: weekEndInstant, lt: nextEndExclusive },
    },
    select: { assignedAssociateId: true, acknowledgedAt: true },
    take: 3000,
  });
  const nextWeek = {
    shifts: nextShifts.length,
    assigned: nextShifts.filter((s) => s.assignedAssociateId).length,
    confirmed: nextShifts.filter((s) => s.acknowledgedAt).length,
  };

  const statementRows = await prisma.clientStatement.findMany({
    where: { clientId },
    orderBy: { periodStart: 'desc' },
    take: 6,
    select: { periodStart: true, periodEnd: true, number: true, status: true, snapshot: true, paidAt: true },
  });
  const statements = statementRows.map((r) => {
    const snap = r.snapshot as unknown as StatementSnapshot | null;
    return {
      period: `${r.periodStart.toISOString().slice(0, 10)} – ${r.periodEnd.toISOString().slice(0, 10)}`,
      label:
        r.status === 'FINAL'
          ? `No. ${String(r.number ?? 0).padStart(4, '0')}${r.paidAt ? ' · PAID' : ' · issued'}`
          : 'Draft',
      amount: snap?.totals?.amount ?? null,
      paidAt: r.paidAt ? r.paidAt.toISOString().slice(0, 10) : null,
    };
  });

  return {
    clientName: snapshot.clientName,
    orgName,
    periodStart: startKey,
    periodEnd: orgDateKey(end),
    generatedAt: new Date().toISOString().slice(0, 10),
    snapshot,
    days: [...dayMap.entries()].map(([key, d]) => ({
      key,
      label: `${DAY_LABEL[new Date(`${key}T12:00:00.000Z`).getUTCDay()]} ${key.slice(5)}`,
      shifts: d.shifts,
      assigned: d.assigned,
      open: d.open,
      plannedHours: Math.round(d.plannedHours * 10) / 10,
    })),
    roster,
    rosterTruncated: Math.max(0, rosterAll.length - ROSTER_CAP),
    reliability: { noShows, noShowsCovered, pickupsApproved },
    nextWeek,
    statements,
  };
}

/* ===== PDF ================================================================ */

const NAVY = '#0B1832';
const GREY = '#666666';
const LIGHT = '#999999';
const GOOD = '#1A7F4B';
const WARN = '#B45309';

export function renderClientServiceReportPdf(data: ServiceReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      bufferPages: true,
      info: {
        Title: `Weekly Service Report — ${data.clientName} — ${data.periodStart} to ${data.periodEnd}`,
        Author: data.orgName,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 24;
    const ensure = (needed: number) => {
      if (doc.y + needed > bottom()) doc.addPage();
    };
    const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`);
    const money = (v: number) =>
      `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ---- Letterhead --------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(data.orgName, left, 54);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GREY)
      .text('WEEKLY CLIENT SERVICE REPORT', { characterSpacing: 1.2 });
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(NAVY)
      .text(data.clientName, left, 58, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GREY)
      .text(`Service week ${data.periodStart} — ${data.periodEnd}`, left, 76, {
        width,
        align: 'right',
      })
      .text(`Prepared ${data.generatedAt}`, { width, align: 'right' });
    doc.moveTo(left, 108).lineTo(right, 108).lineWidth(1).strokeColor(NAVY).stroke();
    doc.y = 122;

    // ---- Headline KPIs -----------------------------------------------------
    const sla = data.snapshot.sla;
    const kpis: { label: string; value: string; tone?: string }[] = [
      { label: 'FILL RATE', value: pct(sla.fillRatePct), tone: (sla.fillRatePct ?? 100) >= 95 ? GOOD : WARN },
      { label: 'HOURS DELIVERED', value: data.snapshot.totals.hours.toFixed(1) },
      {
        label: 'SHIFTS COVERED',
        value: `${sla.assignedShifts}/${sla.publishedShifts}`,
      },
      { label: 'ON-TIME ARRIVALS', value: pct(sla.punctualPct) },
      {
        label: 'NO-SHOWS',
        value:
          data.reliability.noShows === 0
            ? '0'
            : `${data.reliability.noShows} (${data.reliability.noShowsCovered} covered)`,
        tone: data.reliability.noShows === 0 ? GOOD : WARN,
      },
    ];
    const cell = width / kpis.length;
    kpis.forEach((k, i) => {
      const x = left + i * cell;
      doc.font('Helvetica').fontSize(7).fillColor(LIGHT).text(k.label, x, doc.y, {
        width: cell - 8,
        characterSpacing: 0.8,
      });
    });
    const kpiTop = doc.y + 2;
    kpis.forEach((k, i) => {
      const x = left + i * cell;
      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .fillColor(k.tone ?? NAVY)
        .text(k.value, x, kpiTop, { width: cell - 8 });
    });
    doc.y = kpiTop + 28;

    const section = (title: string) => {
      ensure(40);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(title, left, doc.y + 8);
      doc.moveDown(0.3);
    };
    const tableHeader = (cols: { label: string; x: number; w: number; align?: 'right' }[]) => {
      const y = doc.y;
      doc.font('Helvetica').fontSize(7.5).fillColor(LIGHT);
      for (const c of cols) doc.text(c.label, c.x, y, { width: c.w, align: c.align });
      doc.y = y + 12;
      doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor('#DDDDDD').stroke();
      doc.y += 4;
    };

    // ---- Day by day --------------------------------------------------------
    section('Coverage, day by day');
    const dc = [
      { label: 'DAY', x: left, w: 90 },
      { label: 'SHIFTS', x: left + 100, w: 70, align: 'right' as const },
      { label: 'STAFFED', x: left + 180, w: 70, align: 'right' as const },
      { label: 'OPEN', x: left + 260, w: 70, align: 'right' as const },
      { label: 'PLANNED HOURS', x: left + 340, w: 110, align: 'right' as const },
    ];
    tableHeader(dc);
    for (const d of data.days) {
      ensure(16);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor(NAVY).text(d.label, dc[0].x, y, { width: dc[0].w });
      doc.text(String(d.shifts), dc[1].x, y, { width: dc[1].w, align: 'right' });
      doc.fillColor(d.assigned === d.shifts ? GOOD : NAVY).text(String(d.assigned), dc[2].x, y, { width: dc[2].w, align: 'right' });
      doc.fillColor(d.open > 0 ? WARN : LIGHT).text(String(d.open), dc[3].x, y, { width: dc[3].w, align: 'right' });
      doc.fillColor(NAVY).text(d.plannedHours.toFixed(1), dc[4].x, y, { width: dc[4].w, align: 'right' });
      doc.y = y + 14;
    }

    // ---- Reliability -------------------------------------------------------
    section('Reliability');
    doc.font('Helvetica').fontSize(9).fillColor(GREY);
    const rel = data.reliability;
    doc.text(
      rel.noShows === 0
        ? 'No missed shifts this week.'
        : `${rel.noShows} missed shift${rel.noShows === 1 ? '' : 's'}; ${rel.noShowsCovered} ${rel.noShowsCovered === 1 ? 'was' : 'were'} still covered on the day.`,
      left,
      doc.y,
      { width },
    );
    doc.text(
      `${rel.pickupsApproved} open shift${rel.pickupsApproved === 1 ? '' : 's'} filled by associates volunteering through the Alto shift marketplace.`,
      { width },
    );
    if (sla.pendingEntries > 0) {
      doc
        .fillColor(WARN)
        .text(
          `${sla.pendingEntries} time entr${sla.pendingEntries === 1 ? 'y is' : 'ies are'} still in review — hour totals may tick up slightly.`,
          { width },
        );
    }

    // ---- Next week ---------------------------------------------------------
    section('Next week readiness');
    doc.font('Helvetica').fontSize(9).fillColor(GREY).text(
      data.nextWeek.shifts === 0
        ? 'Next week is not yet published.'
        : `${data.nextWeek.shifts} shifts planned · ${data.nextWeek.assigned} already staffed · ${data.nextWeek.confirmed} personally confirmed by the associate ("I'll be there").`,
      left,
      doc.y,
      { width },
    );

    // ---- Roster ------------------------------------------------------------
    section(`Your team this week (${data.roster.length}${data.rosterTruncated > 0 ? ` of ${data.roster.length + data.rosterTruncated}` : ''})`);
    const rc = [
      { label: 'ASSOCIATE', x: left, w: 190 },
      { label: 'POSITIONS', x: left + 200, w: 210 },
      { label: 'SCHEDULED HOURS', x: left + 420, w: 84, align: 'right' as const },
    ];
    tableHeader(rc);
    for (const r of data.roster) {
      ensure(15);
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(NAVY).text(r.name, rc[0].x, y, { width: rc[0].w, lineBreak: false });
      doc.fillColor(GREY).text(r.positions, rc[1].x, y, { width: rc[1].w, lineBreak: false, ellipsis: true });
      doc.fillColor(NAVY).text(r.hours.toFixed(1), rc[2].x, y, { width: rc[2].w, align: 'right' });
      doc.y = y + 13;
    }
    if (data.rosterTruncated > 0) {
      doc.font('Helvetica').fontSize(8).fillColor(LIGHT).text(`+ ${data.rosterTruncated} more associates`, left, doc.y + 2);
      doc.y += 14;
    }

    // ---- Billing -----------------------------------------------------------
    section('Billing');
    const bc = [
      { label: 'PERIOD', x: left, w: 190 },
      { label: 'STATEMENT', x: left + 200, w: 160 },
      { label: 'AMOUNT', x: left + 380, w: 124, align: 'right' as const },
    ];
    tableHeader(bc);
    if (data.statements.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(LIGHT).text('No statements yet.', left, doc.y);
    }
    for (const s of data.statements) {
      ensure(15);
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(NAVY).text(s.period, bc[0].x, y, { width: bc[0].w, lineBreak: false });
      doc
        .fillColor(s.paidAt ? GOOD : s.label === 'Draft' ? LIGHT : NAVY)
        .text(s.label, bc[1].x, y, { width: bc[1].w, lineBreak: false });
      doc
        .fillColor(NAVY)
        .text(s.amount != null ? money(s.amount) : '—', bc[2].x, y, { width: bc[2].w, align: 'right' });
      doc.y = y + 13;
    }

    // ---- Footer on every page ---------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(LIGHT)
        .text(
          `${data.orgName} · Weekly Service Report · ${data.clientName} · ${data.periodStart} — ${data.periodEnd} · page ${i - range.start + 1} of ${range.count}`,
          left,
          doc.page.height - 40,
          { width, align: 'center', lineBreak: false },
        );
    }

    doc.end();
  });
}
