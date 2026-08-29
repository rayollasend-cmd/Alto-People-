import PDFDocument from 'pdfkit';
import type { PrismaClient } from '@prisma/client';
import { computeStatementSnapshot, type StatementSnapshot } from './clientStatement.js';
import { orgDateKey } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';
import { getBlobStore } from './blobStore.js';
import { METRIC_LABEL } from './opsSops.js';
import { paidMinutesForRange } from '@alto-people/shared';

/**
 * Weekly Client Service Report — the hand-to-the-store-manager PDF.
 *
 * The portal-grade "Walmart view" of one client's week, as a letterheaded
 * document Alto downloads and hands over: a live snapshot of the store at
 * generation time (who's clocked in right now, today's and tomorrow's
 * confirmed headcount), headline KPIs, coverage day by day with fill
 * bars, the full week schedule (the "can you email me the schedule?"
 * killer), the team with photos, a reliability narrative, and billing
 * status. Built on the SAME computation as the client statement
 * (computeStatementSnapshot), so the numbers a store manager sees here
 * always reconcile with the invoice they receive.
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
  generatedAt: string; // display timestamp
  snapshot: StatementSnapshot;
  /** Live view at generation time. */
  now: {
    onFloor: string[]; // names clocked in right now (capped)
    onFloorCount: number;
    todayShifts: number;
    todayConfirmed: number;
    tomorrowShifts: number;
    tomorrowStaffed: number;
    tomorrowConfirmed: number;
  };
  /** Org-local day rows Sat→Fri. */
  days: {
    key: string;
    label: string;
    shifts: number;
    assigned: number;
    open: number;
    plannedHours: number;
  }[];
  /** The full week schedule, grouped per day. */
  schedule: {
    dayLabel: string;
    rows: { time: string; position: string; who: string | null }[];
  }[];
  roster: {
    name: string;
    positions: string;
    hours: number;
    photo: Buffer | null;
    initials: string;
  }[];
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
    paid: boolean;
    amount: number | null;
  }[];
  /** Store-ops evidence for the week (null until the ops module has runs). */
  ops: {
    shifts: number;
    sopPct: number | null;
    tempChecks: number;
    tempOutOfRange: number;
    incompleteCloses: number;
    handoverItems: number;
    photos: Buffer[];
    /** Named production volumes for the week (cases stocked, discards…). */
    metrics: { label: string; total: number; unit: string | null }[];
  } | null;
}

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function dayName(key: string, full = false): string {
  const d = new Date(`${key}T12:00:00.000Z`);
  return `${(full ? DAY_FULL : DAY_LABEL)[d.getUTCDay()]} ${key.slice(5)}`;
}

export async function buildClientServiceReport(
  prisma: PrismaClient,
  clientId: string,
  weekStart: Date,
  orgName: string,
): Promise<ServiceReportData> {
  const startKey = orgDateKey(weekStart);
  const start = new Date(`${startKey}T00:00:00.000Z`);
  const endExclusive = new Date(start.getTime() + 7 * 24 * 3_600_000);

  const snapshot = await computeStatementSnapshot(prisma, clientId, start, endExclusive);

  const weekStartInstant = weekStart;
  const weekEndInstant = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);
  const nextEndInstant = new Date(weekStart.getTime() + 14 * 24 * 3_600_000);
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
      assignedAssociate: {
        select: { firstName: true, lastName: true, photoS3Key: true },
      },
      locationRel: { select: { timezone: true } },
      timeEntries: { select: { id: true }, take: 1 },
    },
    orderBy: { startsAt: 'asc' },
    take: 3000,
  });

  // Day-by-day + full schedule + roster, one pass (org-local days;
  // overnight shifts belong to their start day).
  const dayMap = new Map<
    string,
    { shifts: number; assigned: number; open: number; plannedHours: number }
  >();
  const scheduleMap = new Map<string, { time: string; position: string; who: string | null }[]>();
  for (let i = 0; i < 7; i++) {
    const key = orgDateKey(new Date(weekStartInstant.getTime() + i * 24 * 3_600_000));
    dayMap.set(key, { shifts: 0, assigned: 0, open: 0, plannedHours: 0 });
    scheduleMap.set(key, []);
  }
  const rosterMap = new Map<
    string,
    { name: string; positions: Set<string>; hours: number; photoS3Key: string | null }
  >();
  let noShows = 0;
  let noShowsCovered = 0;
  for (const s of shifts) {
    const key = orgDateKey(s.startsAt);
    const day = dayMap.get(key);
    // Paid hours (the shared unpaid-break rule) — the report must
    // reconcile with the invoice, which bills paid time.
    const hours = paidMinutesForRange(s.startsAt, s.endsAt) / 60;
    const tz = s.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    const who = s.assignedAssociate
      ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`
      : null;
    if (day) {
      day.shifts += 1;
      if (s.assignedAssociateId) day.assigned += 1;
      else day.open += 1;
      day.plannedHours += hours;
      scheduleMap.get(key)!.push({
        time: `${formatTimeInZone(s.startsAt, tz)} – ${formatTimeInZone(s.endsAt, tz)}`,
        position: s.position,
        who,
      });
    }
    if (s.assignedAssociateId && s.assignedAssociate) {
      const r = rosterMap.get(s.assignedAssociateId) ?? {
        name: who!,
        positions: new Set<string>(),
        hours: 0,
        photoS3Key: s.assignedAssociate.photoS3Key,
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
      photoS3Key: r.photoS3Key,
      initials: r.name
        .split(/\s+/)
        .map((p) => p[0] ?? '')
        .join('')
        .slice(0, 2)
        .toUpperCase(),
    }))
    .sort((a, b) => b.hours - a.hours);
  const ROSTER_CAP = 60;
  const rosterSlice = rosterAll.slice(0, ROSTER_CAP);

  // Photos: best-effort, bounded. A missing/unreadable blob just renders
  // the initials medallion instead.
  const blobStore = getBlobStore();
  const roster = await Promise.all(
    rosterSlice.map(async (r) => {
      let photo: Buffer | null = null;
      if (r.photoS3Key) {
        try {
          photo = await blobStore.get(r.photoS3Key);
        } catch {
          photo = null;
        }
      }
      return {
        name: r.name,
        positions: r.positions,
        hours: r.hours,
        photo,
        initials: r.initials,
      };
    }),
  );

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
      startsAt: { gte: weekEndInstant, lt: nextEndInstant },
    },
    select: { assignedAssociateId: true, acknowledgedAt: true },
    take: 3000,
  });
  const nextWeek = {
    shifts: nextShifts.length,
    assigned: nextShifts.filter((s) => s.assignedAssociateId).length,
    confirmed: nextShifts.filter((s) => s.acknowledgedAt).length,
  };

  // ---- Live snapshot at generation time ---------------------------------
  const nowInstant = new Date();
  const onFloorRows = await prisma.timeEntry.findMany({
    where: { clientId, status: 'ACTIVE' },
    select: { associate: { select: { firstName: true, lastName: true } } },
    take: 100,
  });
  const onFloorNames = onFloorRows.map(
    (e) => `${e.associate.firstName} ${e.associate.lastName}`,
  );
  const todayKey = orgDateKey(nowInstant);
  const tomorrowKey = orgDateKey(new Date(nowInstant.getTime() + 24 * 3_600_000));
  const nearShifts = await prisma.shift.findMany({
    where: {
      clientId,
      status: { not: 'CANCELLED' },
      startsAt: {
        gte: new Date(nowInstant.getTime() - 36 * 3_600_000),
        lt: new Date(nowInstant.getTime() + 60 * 3_600_000),
      },
    },
    select: { startsAt: true, assignedAssociateId: true, acknowledgedAt: true },
    take: 2000,
  });
  const todayList = nearShifts.filter((s) => orgDateKey(s.startsAt) === todayKey);
  const tomorrowList = nearShifts.filter((s) => orgDateKey(s.startsAt) === tomorrowKey);
  const now = {
    onFloor: onFloorNames.slice(0, 12),
    onFloorCount: onFloorNames.length,
    todayShifts: todayList.length,
    todayConfirmed: todayList.filter((s) => s.acknowledgedAt).length,
    tomorrowShifts: tomorrowList.length,
    tomorrowStaffed: tomorrowList.filter((s) => s.assignedAssociateId).length,
    tomorrowConfirmed: tomorrowList.filter((s) => s.acknowledgedAt).length,
  };

  // ---- Store-ops evidence for the week ----------------------------------
  const opsShifts = await prisma.opsShift.findMany({
    where: {
      clientId,
      dateKey: { gte: startKey, lte: orgDateKey(new Date(start.getTime() + 6 * 24 * 3_600_000)) },
    },
    select: {
      id: true,
      status: true,
      sopDone: true,
      sopTotal: true,
      closedIncomplete: true,
    },
    take: 200,
  });
  let ops: ServiceReportData['ops'] = null;
  if (opsShifts.length > 0) {
    const shiftIds = opsShifts.map((s) => s.id);
    const [tempAgg, handoverItems, photoRows, numberAgg] = await Promise.all([
      prisma.opsTask.groupBy({
        by: ['tempOutOfRange'],
        where: {
          opsShiftId: { in: shiftIds },
          responseType: 'TEMPERATURE',
          answerNumber: { not: null },
        },
        _count: { _all: true },
      }),
      prisma.opsHandoverItem.count({ where: { fromShiftId: { in: shiftIds } } }),
      prisma.opsTaskPhoto.findMany({
        where: { task: { is: { opsShiftId: { in: shiftIds } } } },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { s3Key: true },
      }),
      prisma.opsTask.groupBy({
        by: ['metricKey', 'unit'],
        where: {
          opsShiftId: { in: shiftIds },
          responseType: 'NUMBER',
          answerNumber: { not: null },
          metricKey: { not: null },
        },
        _sum: { answerNumber: true },
      }),
    ]);
    const sopDone = opsShifts.reduce((n, s) => n + s.sopDone, 0);
    const sopTotal = opsShifts.reduce((n, s) => n + s.sopTotal, 0);
    const inRange = tempAgg.find((r) => !r.tempOutOfRange)?._count._all ?? 0;
    const outRange = tempAgg.find((r) => r.tempOutOfRange)?._count._all ?? 0;
    const photos: Buffer[] = [];
    for (const p of photoRows) {
      try {
        const buf = await blobStore.get(p.s3Key);
        if (buf) photos.push(buf);
      } catch {
        /* best-effort highlight */
      }
    }
    ops = {
      shifts: opsShifts.length,
      sopPct: sopTotal > 0 ? Math.round((sopDone / sopTotal) * 100) : null,
      tempChecks: inRange + outRange,
      tempOutOfRange: outRange,
      incompleteCloses: opsShifts.filter((s) => s.closedIncomplete).length,
      handoverItems,
      photos,
      metrics: numberAgg
        .map((m) => ({
          label: METRIC_LABEL[m.metricKey!] ?? m.metricKey!.replace(/_/g, ' '),
          total: Number(m._sum.answerNumber ?? 0),
          unit: m.unit,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5),
    };
  }

  const statementRows = await prisma.clientStatement.findMany({
    where: { clientId },
    orderBy: { periodStart: 'desc' },
    take: 6,
    select: {
      periodStart: true,
      periodEnd: true,
      number: true,
      status: true,
      snapshot: true,
      paidAt: true,
    },
  });
  const statements = statementRows.map((r) => {
    const snap = r.snapshot as unknown as StatementSnapshot | null;
    return {
      period: `${r.periodStart.toISOString().slice(0, 10)} – ${r.periodEnd.toISOString().slice(0, 10)}`,
      label:
        r.status === 'FINAL'
          ? `No. ${String(r.number ?? 0).padStart(4, '0')}${r.paidAt ? ' · PAID' : ' · issued'}`
          : 'Draft',
      paid: !!r.paidAt,
      amount: snap?.totals?.amount ?? null,
    };
  });

  return {
    clientName: snapshot.clientName,
    orgName,
    periodStart: startKey,
    periodEnd: orgDateKey(new Date(start.getTime() + 6 * 24 * 3_600_000)),
    generatedAt: `${orgDateKey(nowInstant)} ${formatTimeInZone(nowInstant, DEFAULT_TIMEZONE)}`,
    snapshot,
    now,
    days: [...dayMap.entries()].map(([key, d]) => ({
      key,
      label: dayName(key),
      shifts: d.shifts,
      assigned: d.assigned,
      open: d.open,
      plannedHours: Math.round(d.plannedHours * 10) / 10,
    })),
    schedule: [...scheduleMap.entries()]
      .filter(([, rows]) => rows.length > 0)
      .map(([key, rows]) => ({ dayLabel: dayName(key, true), rows })),
    roster,
    rosterTruncated: Math.max(0, rosterAll.length - ROSTER_CAP),
    reliability: { noShows, noShowsCovered, pickupsApproved },
    nextWeek,
    statements,
    ops,
  };
}

/* ===== PDF ================================================================ */

const NAVY = '#0B1832';
const NAVY_SOFT = '#22355C';
const GOLD = '#C9A227';
const GREY = '#5B6472';
const LIGHT = '#9AA3B2';
const PANEL = '#F3F5F9';
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
    const bottom = () => doc.page.height - doc.page.margins.bottom - 26;
    const ensure = (needed: number) => {
      if (doc.y + needed > bottom()) doc.addPage();
    };
    const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`);
    const money = (v: number) =>
      `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ---- Hero letterhead ---------------------------------------------------
    doc.rect(0, 0, doc.page.width, 118).fill(NAVY);
    doc.rect(0, 118, doc.page.width, 3).fill(GOLD);
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#FFFFFF').text(data.orgName, left, 34);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(GOLD)
      .text('WEEKLY SERVICE REPORT', left, 60, { characterSpacing: 2 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#FFFFFF')
      .text(data.clientName, left, 34, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#C7CEDC')
      .text(`Service week ${data.periodStart} — ${data.periodEnd}`, left, 56, {
        width,
        align: 'right',
      })
      .text(`Prepared ${data.generatedAt}`, left, 70, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#8E99AD')
      .text('Prepared exclusively for our partner — workforce coverage, reliability and billing, one page truth.', left, 92, {
        width: width * 0.7,
      });
    doc.y = 140;

    // ---- KPI cards ---------------------------------------------------------
    const sla = data.snapshot.sla;
    const kpis: { label: string; value: string; tone?: string; sub?: string }[] = [
      {
        label: 'FILL RATE',
        value: pct(sla.fillRatePct),
        tone: (sla.fillRatePct ?? 100) >= 95 ? GOOD : WARN,
      },
      { label: 'HOURS DELIVERED', value: data.snapshot.totals.hours.toFixed(1) },
      { label: 'SHIFTS COVERED', value: `${sla.assignedShifts}/${sla.publishedShifts}` },
      { label: 'ON-TIME ARRIVALS', value: pct(sla.punctualPct) },
      {
        label: 'NO-SHOWS',
        value: String(data.reliability.noShows),
        tone: data.reliability.noShows === 0 ? GOOD : WARN,
        sub:
          data.reliability.noShows > 0
            ? `${data.reliability.noShowsCovered} covered`
            : 'clean week',
      },
    ];
    const gap = 8;
    const cardW = (width - gap * (kpis.length - 1)) / kpis.length;
    const cardH = 56;
    kpis.forEach((k, i) => {
      const x = left + i * (cardW + gap);
      doc.roundedRect(x, doc.y, cardW, cardH, 5).fill(PANEL);
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(LIGHT)
        .text(k.label, x + 8, doc.y + 8, { width: cardW - 16, characterSpacing: 0.7 });
      doc
        .font('Helvetica-Bold')
        .fontSize(17)
        .fillColor(k.tone ?? NAVY)
        .text(k.value, x + 8, doc.y + 20, { width: cardW - 16 });
      if (k.sub) {
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(GREY)
          .text(k.sub, x + 8, doc.y + 41, { width: cardW - 16 });
      }
    });
    doc.y += cardH + 14;

    const section = (title: string) => {
      ensure(46);
      const y = doc.y + 8;
      doc.rect(left, y + 1, 4, 11).fill(GOLD);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(title, left + 10, y);
      doc
        .moveTo(left, y + 18)
        .lineTo(right, y + 18)
        .lineWidth(0.5)
        .strokeColor('#E1E5EC')
        .stroke();
      doc.y = y + 24;
    };

    // ---- Live snapshot -----------------------------------------------------
    section('Your store right now');
    {
      const panelY = doc.y;
      const panelH = 64;
      doc.roundedRect(left, panelY, width, panelH, 6).fill(PANEL);
      const colW = width / 3;
      const stat = (i: number, label: string, value: string, sub: string, tone = NAVY) => {
        const x = left + i * colW + 12;
        doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT).text(label, x, panelY + 9, {
          width: colW - 20,
          characterSpacing: 0.7,
        });
        doc.font('Helvetica-Bold').fontSize(15).fillColor(tone).text(value, x, panelY + 20, {
          width: colW - 20,
        });
        doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(sub, x, panelY + 40, {
          width: colW - 20,
          height: 20,
          ellipsis: true,
        });
      };
      stat(
        0,
        'ON THE FLOOR RIGHT NOW',
        String(data.now.onFloorCount),
        data.now.onFloorCount > 0 ? data.now.onFloor.join(', ') : 'Nobody clocked in at this moment.',
        data.now.onFloorCount > 0 ? GOOD : NAVY,
      );
      stat(
        1,
        'TODAY',
        `${data.now.todayShifts} shifts`,
        `${data.now.todayConfirmed} personally confirmed ("I'll be there")`,
      );
      stat(
        2,
        'TOMORROW',
        `${data.now.tomorrowShifts} shifts`,
        `${data.now.tomorrowStaffed} staffed · ${data.now.tomorrowConfirmed} confirmed`,
      );
      doc.y = panelY + panelH + 10;
    }

    // ---- Day by day with fill bars ----------------------------------------
    section('Coverage, day by day');
    {
      const rowH = 17;
      const nameW = 78;
      const numW = 40;
      const barX = left + nameW + 6;
      const barW = width - nameW - numW * 3 - 30;
      doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT);
      doc.text('DAY', left, doc.y, { characterSpacing: 0.6 });
      doc.text('STAFFED / OPEN', barX, doc.y, { characterSpacing: 0.6 });
      doc.text('SHIFTS', barX + barW + 8, doc.y, { width: numW, align: 'right' });
      doc.text('OPEN', barX + barW + 8 + numW, doc.y, { width: numW, align: 'right' });
      doc.text('HOURS', barX + barW + 8 + numW * 2, doc.y, { width: numW, align: 'right' });
      doc.y += 11;
      const maxShifts = Math.max(1, ...data.days.map((d) => d.shifts));
      for (const d of data.days) {
        ensure(rowH + 2);
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(d.label, left, y + 3, {
          width: nameW,
          lineBreak: false,
        });
        // Track + stacked bar (green staffed, amber open), scaled to the
        // busiest day so relative load reads at a glance.
        doc.roundedRect(barX, y + 3, barW, 8, 4).fill('#E7EAF1');
        const total = Math.max(d.shifts, 1);
        const filledW = (barW * d.shifts) / maxShifts;
        const staffedW = filledW * (d.assigned / total);
        if (staffedW > 0) doc.roundedRect(barX, y + 3, Math.max(staffedW, 4), 8, 4).fill(GOOD);
        if (d.open > 0) {
          doc
            .roundedRect(barX + staffedW, y + 3, Math.max(filledW - staffedW, 3), 8, 4)
            .fill(WARN);
        }
        doc.font('Helvetica').fontSize(8.5).fillColor(NAVY);
        doc.text(String(d.shifts), barX + barW + 8, y + 3, { width: numW, align: 'right' });
        doc
          .fillColor(d.open > 0 ? WARN : LIGHT)
          .text(String(d.open), barX + barW + 8 + numW, y + 3, { width: numW, align: 'right' });
        doc
          .fillColor(NAVY)
          .text(d.plannedHours.toFixed(1), barX + barW + 8 + numW * 2, y + 3, {
            width: numW,
            align: 'right',
          });
        doc.y = y + rowH;
      }
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
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(GREY)
      .text(
        data.nextWeek.shifts === 0
          ? 'Next week is not yet published.'
          : `${data.nextWeek.shifts} shifts planned · ${data.nextWeek.assigned} already staffed · ${data.nextWeek.confirmed} personally confirmed by the associate.`,
        left,
        doc.y,
        { width },
      );

    // ---- Team with photos --------------------------------------------------
    section(
      `Your team this week (${data.roster.length}${data.rosterTruncated > 0 ? ` of ${data.roster.length + data.rosterTruncated}` : ''})`,
    );
    {
      const cols = 3;
      const cardGap = 8;
      const cw = (width - cardGap * (cols - 1)) / cols;
      const ch = 44;
      const avatar = 30;
      data.roster.forEach((r, i) => {
        const col = i % cols;
        if (col === 0) ensure(ch + 6);
        const x = left + col * (cw + cardGap);
        const y = doc.y;
        doc.roundedRect(x, y, cw, ch, 5).fill(PANEL);
        const ax = x + 8;
        const ay = y + (ch - avatar) / 2;
        let drewPhoto = false;
        if (r.photo) {
          try {
            doc.save();
            doc.circle(ax + avatar / 2, ay + avatar / 2, avatar / 2).clip();
            doc.image(r.photo, ax, ay, { width: avatar, height: avatar });
            doc.restore();
            drewPhoto = true;
          } catch {
            // Unreadable image (bad bytes, unsupported format): restore the
            // clip state if it was left open, then fall back to initials.
            try {
              doc.restore();
            } catch {
              /* no dangling save — fine */
            }
          }
        }
        if (!drewPhoto) {
          doc.circle(ax + avatar / 2, ay + avatar / 2, avatar / 2).fill(NAVY_SOFT);
          doc
            .font('Helvetica-Bold')
            .fontSize(10)
            .fillColor('#FFFFFF')
            .text(r.initials, ax, ay + 9, { width: avatar, align: 'center' });
        }
        const tx = ax + avatar + 8;
        const tw = cw - (tx - x) - 8;
        doc
          .font('Helvetica-Bold')
          .fontSize(8)
          .fillColor(NAVY)
          .text(r.name, tx, y + 8, { width: tw, lineBreak: false, ellipsis: true });
        doc
          .font('Helvetica')
          .fontSize(6.5)
          .fillColor(GREY)
          .text(r.positions, tx, y + 19, { width: tw, lineBreak: false, ellipsis: true });
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor(GOLD)
          .text(`${r.hours.toFixed(1)} h`, tx, y + 29, { width: tw });
        if (col === cols - 1 || i === data.roster.length - 1) doc.y = y + ch + 6;
      });
      if (data.rosterTruncated > 0) {
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(LIGHT)
          .text(`+ ${data.rosterTruncated} more associates`, left, doc.y + 2);
        doc.y += 14;
      }
    }

    // ---- Full week schedule ------------------------------------------------
    doc.addPage();
    doc.y = 54;
    section('The week, shift by shift');
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(LIGHT)
      .text(
        'Every scheduled shift in the service week — the answer to "can you send me this week\'s schedule?", permanently attached to this report.',
        left,
        doc.y,
        { width },
      );
    doc.y += 6;
    for (const day of data.schedule) {
      ensure(30);
      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(NAVY_SOFT)
        .text(day.dayLabel, left, doc.y + 8);
      doc.y += 22;
      for (const row of day.rows) {
        ensure(13);
        const y = doc.y;
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(GREY)
          .text(row.time, left, y, { width: 130, lineBreak: false });
        doc
          .fillColor(NAVY)
          .text(row.position, left + 140, y, { width: 170, lineBreak: false, ellipsis: true });
        if (row.who) {
          doc.fillColor(GREY).text(row.who, left + 320, y, {
            width: width - 320,
            lineBreak: false,
            ellipsis: true,
          });
        } else {
          doc.font('Helvetica-Bold').fillColor(WARN).text('OPEN — being filled', left + 320, y, {
            width: width - 320,
            lineBreak: false,
          });
        }
        doc.y = y + 12;
      }
    }

    // ---- Operational excellence (store-ops evidence) -----------------------
    if (data.ops) {
      section('Operational excellence');
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(GREY)
        .text(
          `${data.ops.shifts} supervised operational shift${data.ops.shifts === 1 ? '' : 's'} ran on documented SOP checklists this week` +
            (data.ops.sopPct != null ? ` — SOP compliance ${data.ops.sopPct}%` : '') +
            `. ${data.ops.tempChecks} logged temperature check${data.ops.tempChecks === 1 ? '' : 's'}` +
            (data.ops.tempOutOfRange === 0
              ? ', all in range'
              : `, ${data.ops.tempOutOfRange} flagged and escalated the moment they were recorded`) +
            `. ${data.ops.handoverItems} shift-to-shift handover item${data.ops.handoverItems === 1 ? '' : 's'} tracked to a decision — nothing left on paper.` +
            (data.ops.incompleteCloses > 0
              ? ` ${data.ops.incompleteCloses} shift${data.ops.incompleteCloses === 1 ? '' : 's'} closed with open items, visible to our operations team for follow-up.`
              : ''),
          left,
          doc.y,
          { width },
        );
      if (data.ops.metrics.length > 0) {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(NAVY)
          .text(
            data.ops.metrics
              .map(
                (m) =>
                  `${m.total.toLocaleString('en-US')} ${m.unit ?? ''} ${m.label.toLowerCase()}`.replace(/\s+/g, ' '),
              )
              .join('   ·   '),
            left,
            doc.y + 4,
            { width },
          );
        doc.y += 4;
      }
      if (data.ops.photos.length > 0) {
        doc.y += 6;
        ensure(96);
        const ph = 84;
        const pw = (width - 16) / 3;
        data.ops.photos.forEach((photo, i) => {
          const x = left + i * (pw + 8);
          try {
            doc.save();
            doc.roundedRect(x, doc.y, pw, ph, 6).clip();
            doc.image(photo, x, doc.y, { width: pw, height: ph });
            doc.restore();
          } catch {
            try {
              doc.restore();
            } catch {
              /* no dangling save */
            }
          }
        });
        doc.y += ph + 8;
        doc
          .font('Helvetica')
          .fontSize(7)
          .fillColor(LIGHT)
          .text('From the floor this week — captured by our shift supervisors.', left, doc.y);
        doc.y += 12;
      }
    }

    // ---- Billing -----------------------------------------------------------
    section('Billing');
    {
      const y0 = doc.y;
      doc.font('Helvetica').fontSize(6.5).fillColor(LIGHT);
      doc.text('PERIOD', left, y0, { characterSpacing: 0.6 });
      doc.text('STATEMENT', left + 200, y0, { characterSpacing: 0.6 });
      doc.text('AMOUNT', left + 380, y0, { width: 124, align: 'right', characterSpacing: 0.6 });
      doc.y = y0 + 11;
      if (data.statements.length === 0) {
        doc.font('Helvetica').fontSize(9).fillColor(LIGHT).text('No statements yet.', left, doc.y);
      }
      for (const s of data.statements) {
        ensure(15);
        const y = doc.y;
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(NAVY)
          .text(s.period, left, y, { width: 190, lineBreak: false });
        doc
          .fillColor(s.paid ? GOOD : s.label === 'Draft' ? LIGHT : NAVY)
          .text(s.label, left + 200, y, { width: 170, lineBreak: false });
        doc
          .fillColor(NAVY)
          .text(s.amount != null ? money(s.amount) : '—', left + 380, y, {
            width: 124,
            align: 'right',
          });
        doc.y = y + 13;
      }
    }

    // ---- Footer on every page ---------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .moveTo(left, doc.page.height - 48)
        .lineTo(right, doc.page.height - 48)
        .lineWidth(0.5)
        .strokeColor(GOLD)
        .stroke();
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(LIGHT)
        .text(
          `${data.orgName} · Weekly Service Report · ${data.clientName} · ${data.periodStart} — ${data.periodEnd} · Confidential · page ${i - range.start + 1} of ${range.count}`,
          left,
          doc.page.height - 40,
          { width, align: 'center', lineBreak: false },
        );
    }

    doc.end();
  });
}
