import { COLOR, SIZE, createDoc, fmt } from './docKit/index.js';
import type { PrismaClient } from '@prisma/client';
import { computeStatementSnapshot, type StatementSnapshot } from './clientStatement.js';
import { orgDateKey } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';
import { getBlobStore } from './blobStore.js';
import { METRIC_LABEL } from './opsSops.js';
import { paidMinutesForRange } from '@alto-people/shared';
import { fmtDayRange } from './humanDates.js';

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
    /** Shifts that ended with no punch of any kind against them. */
    noShows: number;
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
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
    {
      name: string;
      positions: Set<string>;
      hours: number;
      photoS3Key: string | null;
    }
  >();
  let noShows = 0;
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
    // The alert stamp only means nobody had punched 15 minutes in. A
    // shift with any punch against it was worked, however late — counting
    // those as missed told the store a person who was on the floor never
    // showed.
    if (s.noShowNotifiedAt && s.timeEntries.length === 0) {
      noShows += 1;
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
  const onFloorNames = onFloorRows.map((e) => `${e.associate.firstName} ${e.associate.lastName}`);
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
      dateKey: {
        gte: startKey,
        lte: orgDateKey(new Date(start.getTime() + 6 * 24 * 3_600_000)),
      },
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
      prisma.opsHandoverItem.count({
        where: { fromShiftId: { in: shiftIds } },
      }),
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
      period: fmt.dateRange(
        r.periodStart.toISOString().slice(0, 10),
        r.periodEnd.toISOString().slice(0, 10),
      ),
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
    generatedAt: `${fmt.date(orgDateKey(nowInstant))}, ${formatTimeInZone(
      nowInstant,
      DEFAULT_TIMEZONE,
    )}`,
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
    reliability: { noShows, pickupsApproved },
    nextWeek,
    statements,
    ops,
  };
}

/* ===== PDF ================================================================ */

/**
 * The report, drawn in the house style (lib/docKit): the store manager
 * reads the week's headline in five figures, then coverage day by day,
 * reliability and next week, the team, the full schedule, the store's
 * operations evidence, and billing. Every number comes from the same
 * computation as the client's statement.
 */
export function renderClientServiceReportPdf(data: ServiceReportData): Promise<Buffer> {
  const { k, doc } = createDoc({
    title: `Weekly service report — ${data.clientName}`,
    author: data.orgName,
    subject: `Service week ${fmtDayRange(data.periodStart, data.periodEnd, { year: true })}`,
  });
  const L = k.L;
  const Wd = k.width();
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`);
  const sla = data.snapshot.sla;

  let y = k.masthead({
    title: 'Weekly service report',
    subtitle: `Prepared ${data.generatedAt}`,
    brand: {
      name: data.orgName,
      lines: ['Workforce coverage, reliability and billing'],
    },
    meta: [
      { label: 'Prepared for', value: data.clientName },
      {
        label: 'Service week',
        value: fmt.dateRange(data.periodStart, data.periodEnd),
      },
      {
        label: 'Billed this week',
        value: fmt.money(data.snapshot.totals.amount),
      },
    ],
  });

  // ---- The week in five figures -------------------------------------------
  y = k.figures(
    [
      {
        label: 'Fill rate',
        value: pct(sla.fillRatePct),
        hint: `${sla.assignedShifts} of ${sla.publishedShifts} staffed`,
        tone: sla.fillRatePct == null ? undefined : sla.fillRatePct >= 95 ? 'good' : 'warn',
      },
      {
        label: 'On time',
        value: pct(sla.punctualPct),
        hint: sla.punctualPct == null ? 'no punches yet' : 'of arrivals',
        tone: sla.punctualPct == null ? undefined : sla.punctualPct >= 95 ? 'good' : 'warn',
      },
      {
        label: 'No-shows',
        value: String(data.reliability.noShows),
        hint: data.reliability.noShows === 0 ? 'a clean week' : 'no punch recorded',
        tone: data.reliability.noShows === 0 ? 'good' : 'bad',
      },
      {
        label: 'Shifts covered',
        value: `${sla.assignedShifts}/${sla.publishedShifts}`,
        hint: `${data.reliability.pickupsApproved} picked up`,
      },
      {
        label: 'Hours',
        value: fmt.number(data.snapshot.totals.hours, 1),
        hint: `${fmt.number(data.snapshot.totals.otHours, 1)} overtime`,
        emphasis: true,
      },
    ],
    y,
  );

  // ---- Right now ----------------------------------------------------------
  y = k.section('Your store right now', y, `as of ${data.generatedAt}`);
  y = k.figures(
    [
      {
        label: 'On the floor',
        value: String(data.now.onFloorCount),
        hint:
          data.now.onFloorCount > 0
            ? data.now.onFloor.join(', ')
            : 'Nobody clocked in at this moment',
        tone: data.now.onFloorCount > 0 ? 'good' : undefined,
      },
      {
        label: 'Today',
        value: `${data.now.todayShifts} shifts`,
        hint: `${data.now.todayConfirmed} personally confirmed`,
      },
      {
        label: 'Tomorrow',
        value: `${data.now.tomorrowShifts} shifts`,
        hint: `${data.now.tomorrowStaffed} staffed · ${data.now.tomorrowConfirmed} confirmed`,
      },
    ],
    y,
  );

  // ---- Coverage, day by day -----------------------------------------------
  y = k.section('Coverage, day by day', y, 'staffed and open shifts, scaled to the busiest day');
  {
    const rowH = 20;
    const dayW = 110;
    const numW = 52;
    const barX = L + dayW;
    const barW = Wd - dayW - numW * 3 - 12;
    const head = (yy: number) => {
      k.text('Day', L, yy, { size: SIZE.label, caps: true, color: COLOR.ink3 });
      k.text('Staffed / open', barX, yy, {
        size: SIZE.label,
        caps: true,
        color: COLOR.ink3,
      });
      ['Shifts', 'Open', 'Hours'].forEach((h, i) =>
        k.text(h, barX + barW + 12 + numW * i, yy, {
          size: SIZE.label,
          caps: true,
          color: COLOR.ink3,
          width: numW,
          align: 'right',
        }),
      );
      k.hr(yy + 13, L, Wd, COLOR.ruleStrong);
      return yy + 19;
    };
    y = head(k.ensure(y, rowH * 4));
    const maxShifts = Math.max(1, ...data.days.map((d) => d.shifts));
    const empty = data.days.every((d) => d.shifts === 0);
    if (empty) {
      k.text('No shifts were published for this week.', L, y + 2, {
        size: SIZE.small,
        color: COLOR.ink3,
      });
      y += rowH;
    }
    for (const d of empty ? [] : data.days) {
      y = k.ensure(y, rowH, head);
      const label = new Date(`${d.key}T12:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
      k.text(label, L, y + 4, {
        size: SIZE.small,
        weight: 'medium',
        width: dayW - 8,
      });
      k.box(barX, y + 5, barW, 8, COLOR.wash, 4);
      const filled = (barW * d.shifts) / maxShifts;
      const staffed = d.shifts > 0 ? filled * (d.assigned / d.shifts) : 0;
      if (staffed > 0) k.box(barX, y + 5, Math.max(staffed, 4), 8, COLOR.good, 4);
      if (d.open > 0) k.box(barX + staffed, y + 5, Math.max(filled - staffed, 4), 8, COLOR.warn, 4);
      k.text(String(d.shifts), barX + barW + 12, y + 4, {
        size: SIZE.small,
        width: numW,
        align: 'right',
      });
      k.text(String(d.open), barX + barW + 12 + numW, y + 4, {
        size: SIZE.small,
        width: numW,
        align: 'right',
        color: d.open > 0 ? COLOR.warn : COLOR.ink3,
        weight: d.open > 0 ? 'semibold' : 'regular',
      });
      k.text(fmt.number(d.plannedHours, 1), barX + barW + 12 + numW * 2, y + 4, {
        size: SIZE.small,
        width: numW,
        align: 'right',
      });
      k.hr(y + rowH - 1, L, Wd, COLOR.rule, 0.4);
      y += rowH;
    }
    y += 4;
    if (!empty) {
      k.box(L, y + 3, 10, 6, COLOR.good, 2);
      k.text('Staffed', L + 14, y, { size: SIZE.label, color: COLOR.ink3 });
      k.box(L + 70, y + 3, 10, 6, COLOR.warn, 2);
      k.text('Open, being filled', L + 84, y, {
        size: SIZE.label,
        color: COLOR.ink3,
      });
      y += 22;
    }
  }

  // ---- Reliability and next week, side by side -----------------------------
  {
    const rel = data.reliability;
    const relBody =
      (rel.noShows === 0
        ? 'No missed shifts this week. '
        : `${rel.noShows} missed shift${rel.noShows === 1 ? '' : 's'}: nobody punched in against ${
            rel.noShows === 1 ? 'it' : 'them'
          }. `) +
      `${rel.pickupsApproved} open shift${
        rel.pickupsApproved === 1 ? ' was' : 's were'
      } filled by associates volunteering through the shift marketplace.` +
      (sla.pendingEntries > 0
        ? ` ${sla.pendingEntries} time entr${
            sla.pendingEntries === 1 ? 'y is' : 'ies are'
          } still in review, so hour totals may rise slightly.`
        : '');
    const nextBody =
      data.nextWeek.shifts === 0
        ? 'Next week is not published yet.'
        : `${data.nextWeek.shifts} shifts planned. ${data.nextWeek.assigned} already staffed, and ${data.nextWeek.confirmed} personally confirmed by the associate.`;
    const half = (Wd - 12) / 2;
    y = k.ensure(y, 90);
    const y1 = k.callout(
      {
        tone: rel.noShows === 0 ? 'good' : 'warn',
        title: 'Reliability',
        body: relBody,
      },
      y,
      L,
      half,
    );
    const y2 = k.callout(
      {
        tone:
          data.nextWeek.shifts > 0 && data.nextWeek.assigned >= data.nextWeek.shifts
            ? 'good'
            : 'info',
        title: 'Next week',
        body: nextBody,
      },
      y,
      L + half + 12,
      half,
    );
    y = Math.max(y1, y2);
  }

  // ---- The team -----------------------------------------------------------
  y = k.section(
    `Your team this week`,
    y,
    `${data.roster.length}${
      data.rosterTruncated > 0 ? ` of ${data.roster.length + data.rosterTruncated}` : ''
    } associates`,
  );
  {
    const cols = 3;
    const gap = 8;
    const cw = (Wd - gap * (cols - 1)) / cols;
    const ch = 46;
    const av = 30;
    if (data.roster.length === 0) {
      k.text('No associates worked at this client this week.', L, y, {
        size: SIZE.small,
        color: COLOR.ink3,
      });
      y += 18;
    }
    data.roster.forEach((r, i) => {
      const col = i % cols;
      if (col === 0) y = k.ensure(y, ch + gap);
      const x = L + col * (cw + gap);
      k.outline(x, y, cw, ch, COLOR.rule, 6);
      const ax = x + 8;
      const ay = y + (ch - av) / 2;
      let photo = false;
      if (r.photo) {
        try {
          doc.save();
          doc.circle(ax + av / 2, ay + av / 2, av / 2).clip();
          doc.image(r.photo, ax, ay, { width: av, height: av });
          doc.restore();
          photo = true;
        } catch {
          try {
            doc.restore();
          } catch {
            /* nothing left open */
          }
        }
      }
      if (!photo) {
        doc
          .save()
          .circle(ax + av / 2, ay + av / 2, av / 2)
          .fill(COLOR.band)
          .restore();
        k.text(r.initials, ax, ay + 10, {
          size: SIZE.small,
          weight: 'semibold',
          color: COLOR.white,
          width: av,
          align: 'center',
        });
      }
      const tx = ax + av + 8;
      const tw = cw - (tx - x) - 8;
      k.text(r.name, tx, y + 8, {
        size: SIZE.small,
        weight: 'semibold',
        width: tw,
      });
      k.text(r.positions || '—', tx, y + 20, {
        size: SIZE.label,
        color: COLOR.ink3,
        width: tw,
      });
      k.text(`${fmt.number(r.hours, 1)} h`, tx, y + 31, {
        size: SIZE.label,
        weight: 'semibold',
        color: COLOR.brand,
        width: tw,
      });
      if (col === cols - 1 || i === data.roster.length - 1) y += ch + gap;
    });
    if (data.rosterTruncated > 0) {
      k.text(`and ${data.rosterTruncated} more associates`, L, y, {
        size: SIZE.small,
        color: COLOR.ink3,
      });
      y += 16;
    }
  }

  // ---- The schedule -------------------------------------------------------
  doc.addPage();
  y = k.section('The week, shift by shift', k.top, 'every scheduled shift');
  y = k.callout(
    {
      body: 'Every scheduled shift in the service week, attached to this report so the schedule travels with it.',
    },
    y,
  );
  if (data.schedule.length === 0) {
    k.text('No shifts were scheduled this week.', L, y, {
      size: SIZE.small,
      color: COLOR.ink3,
    });
    y += 18;
  }
  for (const day of data.schedule) {
    y = k.ensure(y, 70);
    k.text(day.dayLabel, L, y, { size: SIZE.body, weight: 'semibold' });
    k.text(
      `${day.rows.length} shift${day.rows.length === 1 ? '' : 's'} · ${
        day.rows.filter((r) => !r.who).length
      } open`,
      L,
      y + 1,
      { size: SIZE.label, color: COLOR.ink3, width: Wd, align: 'right' },
    );
    y = k.table({
      y: y + 16,
      rows: day.rows,
      rowH: 16,
      columns: [
        { key: 'time', header: 'Time', width: 1.4, value: (r) => r.time },
        {
          key: 'position',
          header: 'Position',
          width: 2,
          value: (r) => r.position,
        },
        {
          key: 'who',
          header: 'Associate',
          width: 2.6,
          value: (r) => r.who ?? 'Open, being filled',
          color: (r) => (r.who ? undefined : COLOR.warn),
          strong: false,
        },
      ],
    });
  }

  // ---- Operations evidence -----------------------------------------------
  if (data.ops) {
    const o = data.ops;
    y = k.section('Operational excellence', k.ensure(y, 150), 'from the store-operations checklists');
    y = k.figures(
      [
        {
          label: 'Supervised shifts',
          value: String(o.shifts),
          hint: 'run on documented checklists',
        },
        {
          label: 'SOP compliance',
          value: o.sopPct == null ? '—' : `${o.sopPct}%`,
          tone: o.sopPct == null ? undefined : o.sopPct >= 95 ? 'good' : 'warn',
        },
        {
          label: 'Temperature checks',
          value: String(o.tempChecks),
          hint:
            o.tempOutOfRange === 0 ? 'all in range' : `${o.tempOutOfRange} out of range, escalated`,
          tone: o.tempOutOfRange === 0 ? 'good' : 'warn',
        },
        {
          label: 'Handover items',
          value: String(o.handoverItems),
          hint:
            o.incompleteCloses > 0
              ? `${o.incompleteCloses} shift${o.incompleteCloses === 1 ? '' : 's'} closed with open items`
              : 'each tracked to a decision',
        },
      ],
      y,
    );
    if (o.metrics.length > 0) {
      y = k.table({
        y,
        rows: o.metrics,
        columns: [
          {
            key: 'label',
            header: 'This week on the floor',
            width: 4,
            value: (m) => m.label,
          },
          {
            key: 'total',
            header: 'Total',
            width: 1.4,
            align: 'right',
            value: (m) => `${m.total.toLocaleString('en-US')}${m.unit ? ` ${m.unit}` : ''}`,
            strong: true,
          },
        ],
      });
    }
    if (o.photos.length > 0) {
      const ph = 96;
      const pw = (Wd - 16) / 3;
      y = k.ensure(y, ph + 26);
      o.photos.slice(0, 3).forEach((photo, i) => {
        const x = L + i * (pw + 8);
        try {
          doc.save();
          doc.roundedRect(x, y, pw, ph, 6).clip();
          doc.image(photo, x, y, {
            cover: [pw, ph],
            align: 'center',
            valign: 'center',
          });
          doc.restore();
        } catch {
          try {
            doc.restore();
          } catch {
            /* nothing left open */
          }
        }
      });
      y += ph + 6;
      k.text('From the floor this week, captured by our shift supervisors.', L, y, {
        size: SIZE.label,
        color: COLOR.ink3,
      });
      y += 18;
    }
  }

  // ---- Billing ------------------------------------------------------------
  y = k.section('Billing', y, 'statements for this client');
  y = k.table({
    y,
    rows: data.statements,
    empty: 'No statements yet.',
    columns: [
      { key: 'period', header: 'Period', width: 2.4, value: (s) => s.period },
      {
        key: 'label',
        header: 'Statement',
        width: 2.2,
        value: (s) => s.label,
        color: (s) => (s.paid ? COLOR.good : s.label === 'Draft' ? COLOR.ink3 : undefined),
      },
      {
        key: 'amount',
        header: 'Amount',
        width: 1.4,
        align: 'right',
        value: (s) => (s.amount != null ? fmt.money(s.amount) : '—'),
        strong: true,
      },
    ],
  });

  return k.finish({
    reference: `Weekly service report · ${data.clientName} · ${fmt.dateRange(
      data.periodStart,
      data.periodEnd,
    )}`,
    note: data.orgName,
  });
}
