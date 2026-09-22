import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HAPPENED } from './opsShiftStatus.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * The SOP packet — the record a store's operations leave behind, as a
 * document someone can take into a meeting.
 *
 * The board answers "what is happening". This answers "what happened, who
 * signed it, and what should we do about it" — for one shift, one day, or
 * one month, over one store or all of them.
 *
 * Three principles hold the whole thing together:
 *
 *   The account, not the person.  Every shift names the supervisor
 *   account that OPENED it and the account that SUBMITTED it. Those are
 *   often the same login and are not always, and the difference is the
 *   whole of accountability. A packet that prints only "Overnight,
 *   Destin" cannot be used to hold anyone to anything.
 *
 *   Exceptions above averages.  A 94% completion rate is a comfortable
 *   number that hides the one freezer that ran warm for six hours. Every
 *   roll-up here is followed by the ledger of what actually went wrong,
 *   named, timed and attributed.
 *
 *   Nothing is inferred.  Where a number is unknown it prints as "—", and
 *   where shifts predate the store field they are counted separately
 *   rather than folded into a building they may not belong to.
 */

const OPS_TZ = 'America/New_York';
const DAY_MS = 24 * 3_600_000;

export type PacketKind = 'shift' | 'day' | 'month';

export interface PacketQuery {
  kind: PacketKind;
  /** kind=shift */
  shiftId?: string;
  /** kind=day — an org day key, YYYY-MM-DD. */
  dateKey?: string;
  /** kind=month — YYYY-MM. */
  month?: string;
  clientId?: string | null;
  locationId?: string | null;
  period?: string | null;
  department?: string | null;
}

export interface PacketAccount {
  name: string;
  email: string | null;
}

export interface PacketShift {
  id: string;
  dateKey: string;
  period: string;
  department: string;
  departments: string[];
  position: string;
  storeName: string;
  clientName: string;
  windowLabel: string | null;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  dueAt: Date | null;
  ranMinutes: number | null;
  /** Closed by the time the window was due. Null when nothing was due. */
  onTime: boolean | null;
  openedBy: PacketAccount | null;
  submittedBy: PacketAccount | null;
  coveringFor: PacketAccount | null;
  scheduledHeadcount: number;
  actualHeadcount: number;
  sopDone: number;
  sopTotal: number;
  taskDone: number;
  taskTotal: number;
  sopPct: number | null;
  closedIncomplete: boolean;
  incompleteReason: string | null;
  tempAlerts: number;
  closingSummary: string | null;
  handoverNone: boolean;
}

export interface PacketTask {
  section: string | null;
  title: string;
  status: string;
  required: boolean;
  responseType: string;
  /** The answer as it should read on paper ("28.4 °F", "Yes", "14 cases"). */
  answer: string | null;
  band: string | null;
  outOfRange: boolean;
  note: string | null;
  blockedReason: string | null;
  completedAt: Date | null;
  doneBy: string | null;
  completedByAccount: string | null;
  photos: number;
}

export interface PacketHandover {
  kind: string;
  body: string;
  priority: string;
  status: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByAccount: string | null;
  fromShift: string | null;
}

export interface PacketRollup {
  shifts: number;
  closed: number;
  stillOpen: number;
  sopDone: number;
  sopTotal: number;
  sopPct: number | null;
  incomplete: number;
  tempChecks: number;
  tempOutOfRange: number;
  photos: number;
  handoverCreated: number;
  handoverCarried: number;
  handoverDismissed: number;
  handoverReviewed: number;
  handoverPending: number;
  onTimeCloses: number;
  onTimeOf: number;
}

export interface PacketGroup {
  label: string;
  sub: string | null;
  shifts: number;
  sopDone: number;
  sopTotal: number;
  sopPct: number | null;
  incomplete: number;
  tempAlerts: number;
  onTimeCloses: number;
  onTimeOf: number;
}

export interface PacketDayPoint {
  dateKey: string;
  shifts: number;
  sopPct: number | null;
  incomplete: number;
  tempAlerts: number;
}

export interface PacketMetric {
  metricKey: string;
  unit: string | null;
  total: number;
  readings: number;
}

export interface PacketException {
  at: Date;
  storeName: string;
  period: string;
  department: string;
  account: string | null;
  headline: string;
  detail: string | null;
  severity: 'temp' | 'incomplete' | 'unsubmitted' | 'handover';
  shiftId: string;
}

export interface OpsPacket {
  kind: PacketKind;
  orgName: string;
  /** "Destin" / "Front Beach 218 and 3 others" / "All stores". */
  scopeLabel: string;
  /** "Overnight · Frozen & Dairy", or null when unfiltered. */
  narrowLabel: string | null;
  /** "Wednesday, Sep 16, 2026" / "September 2026" / the shift's own line. */
  periodLabel: string;
  from: string;
  to: string;
  generatedAt: Date;
  /** The shifts in scope, newest first. */
  shifts: PacketShift[];
  rollup: PacketRollup;
  byStore: PacketGroup[];
  byPeriod: PacketGroup[];
  bySupervisor: PacketGroup[];
  byDay: PacketDayPoint[];
  metrics: PacketMetric[];
  exceptions: PacketException[];
  /** kind=shift only — the full record. */
  detail: {
    shift: PacketShift;
    tasks: PacketTask[];
    handoverOut: PacketHandover[];
    handoverIn: PacketHandover[];
  } | null;
  /** Shifts in scope whose store was never recorded — the honest caveat. */
  unplaced: number;
}

/* ------------------------------------------------------------------ */

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};
export const periodLabel = (p: string) => PERIOD_LABEL[p] ?? p;

const nameOf = (u: { email: string; associate: { firstName: string; lastName: string } | null } | null) =>
  u ? { name: u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email, email: u.email } : null;

const accountSelect = {
  email: true,
  associate: { select: { firstName: true, lastName: true } },
} as const;

const shiftSelect = {
  id: true,
  clientId: true,
  locationId: true,
  dateKey: true,
  period: true,
  department: true,
  departments: true,
  position: true,
  windowLabel: true,
  status: true,
  openedAt: true,
  closedAt: true,
  dueAt: true,
  scheduledHeadcount: true,
  actualHeadcount: true,
  sopDone: true,
  sopTotal: true,
  taskDone: true,
  taskTotal: true,
  closedIncomplete: true,
  incompleteReason: true,
  tempAlerts: true,
  closingSummary: true,
  handoverNone: true,
  client: { select: { name: true } },
  location: { select: { name: true } },
  openedBy: { select: accountSelect },
  closedBy: { select: accountSelect },
  coveringFor: { select: accountSelect },
} satisfies Prisma.OpsShiftSelect;

type ShiftRow = Prisma.OpsShiftGetPayload<{ select: typeof shiftSelect }>;

function toPacketShift(s: ShiftRow): PacketShift {
  const ran =
    s.closedAt ? Math.round((s.closedAt.getTime() - s.openedAt.getTime()) / 60_000) : null;
  return {
    id: s.id,
    dateKey: s.dateKey,
    period: s.period,
    department: s.department,
    departments: s.departments,
    position: s.position,
    // An unplaced shift says so rather than borrowing the chain's name and
    // pretending to be a building.
    storeName: s.location?.name ?? `${s.client.name} (store not recorded)`,
    clientName: s.client.name,
    windowLabel: s.windowLabel,
    status: s.status,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    dueAt: s.dueAt,
    ranMinutes: ran,
    onTime: s.dueAt && s.closedAt ? s.closedAt.getTime() <= s.dueAt.getTime() : null,
    openedBy: nameOf(s.openedBy),
    submittedBy: nameOf(s.closedBy),
    coveringFor: nameOf(s.coveringFor),
    scheduledHeadcount: s.scheduledHeadcount,
    actualHeadcount: s.actualHeadcount,
    sopDone: s.sopDone,
    sopTotal: s.sopTotal,
    taskDone: s.taskDone,
    taskTotal: s.taskTotal,
    sopPct: s.sopTotal > 0 ? Math.round((s.sopDone / s.sopTotal) * 100) : null,
    closedIncomplete: s.closedIncomplete,
    incompleteReason: s.incompleteReason,
    tempAlerts: s.tempAlerts,
    closingSummary: s.closingSummary,
    handoverNone: s.handoverNone,
  };
}

/** One bucket of the group tables, accumulated shift by shift. */
function groupBy(
  shifts: PacketShift[],
  key: (s: PacketShift) => { id: string; label: string; sub: string | null } | null,
): PacketGroup[] {
  const map = new Map<string, PacketGroup>();
  for (const s of shifts) {
    const k = key(s);
    if (!k) continue;
    const row = map.get(k.id) ?? {
      label: k.label,
      sub: k.sub,
      shifts: 0,
      sopDone: 0,
      sopTotal: 0,
      sopPct: null,
      incomplete: 0,
      tempAlerts: 0,
      onTimeCloses: 0,
      onTimeOf: 0,
    };
    row.shifts += 1;
    row.sopDone += s.sopDone;
    row.sopTotal += s.sopTotal;
    if (s.closedIncomplete) row.incomplete += 1;
    row.tempAlerts += s.tempAlerts;
    if (s.onTime !== null) {
      row.onTimeOf += 1;
      if (s.onTime) row.onTimeCloses += 1;
    }
    map.set(k.id, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, sopPct: r.sopTotal > 0 ? Math.round((r.sopDone / r.sopTotal) * 100) : null }))
    // Worst first. A table sorted by name puts the store that needs
    // attention wherever the alphabet happens to drop it.
    .sort(
      (a, b) =>
        (a.sopPct ?? 101) - (b.sopPct ?? 101) ||
        b.incomplete - a.incomplete ||
        b.tempAlerts - a.tempAlerts ||
        a.label.localeCompare(b.label),
    );
}

const monthLabel = (month: string) =>
  new Date(`${month}-01T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const dayLabel = (key: string) =>
  new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The last org day of a month, as a key. */
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return orgDateKey(new Date(Date.UTC(y, m, 0, 12)));
}

/* ------------------------------------------------------------------ */

export async function buildOpsPacket(
  q: PacketQuery,
  orgName: string,
  /** The caller's tenant clamp — undefined means "all clients". */
  clientClamp: string | undefined,
): Promise<OpsPacket | null> {
  const generatedAt = new Date();

  // --- the window ---------------------------------------------------
  let from: string;
  let to: string;
  let periodLabelText: string;
  let anchorShift: ShiftRow | null = null;

  if (q.kind === 'shift') {
    if (!q.shiftId) return null;
    anchorShift = await prisma.opsShift.findUnique({
      where: { id: q.shiftId },
      select: shiftSelect,
    });
    if (!anchorShift) return null;
    if (clientClamp !== undefined && anchorShift.clientId !== clientClamp) return null;
    from = anchorShift.dateKey;
    to = anchorShift.dateKey;
    periodLabelText = `${periodLabel(anchorShift.period)} · ${dayLabel(anchorShift.dateKey)}`;
  } else if (q.kind === 'month') {
    const month = q.month && /^\d{4}-\d{2}$/.test(q.month) ? q.month : orgDateKey(generatedAt).slice(0, 7);
    from = `${month}-01`;
    to = monthEnd(month);
    periodLabelText = monthLabel(month);
  } else {
    const key = q.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(q.dateKey) ? q.dateKey : orgDateKey(generatedAt);
    from = key;
    to = key;
    periodLabelText = dayLabel(key);
  }

  // --- the scope ----------------------------------------------------
  const where: Prisma.OpsShiftWhereInput = {
    // A cancelled shift never happened — it does not belong in the packet.
    ...HAPPENED,
    ...(clientClamp !== undefined ? { clientId: clientClamp } : q.clientId ? { clientId: q.clientId } : {}),
    ...(q.locationId ? { locationId: q.locationId } : {}),
    ...(q.period ? { period: q.period as Prisma.OpsShiftWhereInput['period'] } : {}),
    ...(q.department
      ? { OR: [{ department: q.department }, { departments: { has: q.department } }] }
      : {}),
    dateKey: { gte: from, lte: to },
  };

  const rows =
    q.kind === 'shift' && anchorShift
      ? [anchorShift]
      : await prisma.opsShift.findMany({
          where,
          orderBy: [{ dateKey: 'desc' }, { openedAt: 'desc' }],
          take: 2000,
          select: shiftSelect,
        });

  const shifts = rows.map(toPacketShift);
  const ids = shifts.map((s) => s.id);

  // --- the evidence behind the numbers -------------------------------
  const [temps, photoCount, handovers, metricRows] = await Promise.all([
    ids.length
      ? prisma.opsTask.groupBy({
          by: ['tempOutOfRange'],
          where: { opsShiftId: { in: ids }, responseType: 'TEMPERATURE', answerNumber: { not: null } },
          _count: { _all: true },
        })
      : Promise.resolve([] as { tempOutOfRange: boolean; _count: { _all: number } }[]),
    ids.length
      ? prisma.opsTaskPhoto.count({ where: { task: { is: { opsShiftId: { in: ids } } } } })
      : Promise.resolve(0),
    ids.length
      ? prisma.opsHandoverItem.groupBy({
          by: ['status'],
          where: { fromShiftId: { in: ids } },
          _count: { _all: true },
        })
      : Promise.resolve([] as { status: string; _count: { _all: number } }[]),
    ids.length
      ? prisma.opsTask.findMany({
          where: {
            opsShiftId: { in: ids },
            responseType: 'NUMBER',
            metricKey: { not: null },
            answerNumber: { not: null },
          },
          select: { metricKey: true, unit: true, answerNumber: true },
          take: 8000,
        })
      : Promise.resolve([] as { metricKey: string | null; unit: string | null; answerNumber: Prisma.Decimal | null }[]),
  ]);

  const inRange = temps.find((t) => !t.tempOutOfRange)?._count._all ?? 0;
  const outOfRange = temps.find((t) => t.tempOutOfRange)?._count._all ?? 0;
  const ho = Object.fromEntries(handovers.map((h) => [h.status, h._count._all])) as Record<string, number>;

  const rollup: PacketRollup = {
    shifts: shifts.length,
    closed: shifts.filter((s) => s.status === 'CLOSED').length,
    stillOpen: shifts.filter((s) => s.status !== 'CLOSED').length,
    sopDone: shifts.reduce((a, s) => a + s.sopDone, 0),
    sopTotal: shifts.reduce((a, s) => a + s.sopTotal, 0),
    sopPct: null,
    incomplete: shifts.filter((s) => s.closedIncomplete).length,
    tempChecks: inRange + outOfRange,
    tempOutOfRange: outOfRange,
    photos: photoCount,
    handoverCreated:
      (ho.PENDING ?? 0) + (ho.CARRIED ?? 0) + (ho.DISMISSED ?? 0) + (ho.REVIEWED ?? 0),
    handoverCarried: ho.CARRIED ?? 0,
    handoverDismissed: ho.DISMISSED ?? 0,
    handoverReviewed: ho.REVIEWED ?? 0,
    handoverPending: ho.PENDING ?? 0,
    onTimeCloses: shifts.filter((s) => s.onTime === true).length,
    onTimeOf: shifts.filter((s) => s.onTime !== null).length,
  };
  rollup.sopPct = rollup.sopTotal > 0 ? Math.round((rollup.sopDone / rollup.sopTotal) * 100) : null;

  const metricMap = new Map<string, PacketMetric>();
  for (const r of metricRows) {
    if (!r.metricKey || r.answerNumber == null) continue;
    const row = metricMap.get(r.metricKey) ?? {
      metricKey: r.metricKey,
      unit: r.unit,
      total: 0,
      readings: 0,
    };
    row.total += Number(r.answerNumber);
    row.readings += 1;
    metricMap.set(r.metricKey, row);
  }
  const metrics = [...metricMap.values()].sort((a, b) => b.total - a.total);

  // --- the cuts ------------------------------------------------------
  const byStore = groupBy(shifts, (s) => ({ id: s.storeName, label: s.storeName, sub: s.clientName }));
  const byPeriod = groupBy(shifts, (s) => ({
    id: `${s.period}|${s.department}`,
    label: periodLabel(s.period),
    sub: s.department,
  }));
  // The whole point of "which supervisor account submitted what": keyed on
  // the LOGIN that closed the shift, not the person's display name.
  const bySupervisor = groupBy(shifts, (s) => {
    const acct = s.submittedBy ?? s.openedBy;
    if (!acct) return null;
    return {
      id: acct.email ?? acct.name,
      label: acct.name,
      sub: acct.email,
    };
  });

  const dayMap = new Map<string, PacketDayPoint>();
  for (const s of shifts) {
    const row = dayMap.get(s.dateKey) ?? {
      dateKey: s.dateKey,
      shifts: 0,
      sopPct: null,
      incomplete: 0,
      tempAlerts: 0,
    };
    row.shifts += 1;
    if (s.closedIncomplete) row.incomplete += 1;
    row.tempAlerts += s.tempAlerts;
    dayMap.set(s.dateKey, row);
  }
  const dayTotals = new Map<string, { done: number; total: number }>();
  for (const s of shifts) {
    const t = dayTotals.get(s.dateKey) ?? { done: 0, total: 0 };
    t.done += s.sopDone;
    t.total += s.sopTotal;
    dayTotals.set(s.dateKey, t);
  }
  const byDay = [...dayMap.values()]
    .map((d) => {
      const t = dayTotals.get(d.dateKey)!;
      return { ...d, sopPct: t.total > 0 ? Math.round((t.done / t.total) * 100) : null };
    })
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  // --- the exception ledger ------------------------------------------
  const exceptions: PacketException[] = [];
  for (const s of shifts) {
    const acct = s.submittedBy?.email ?? s.openedBy?.email ?? null;
    if (s.tempAlerts > 0) {
      exceptions.push({
        at: s.closedAt ?? s.openedAt,
        storeName: s.storeName,
        period: s.period,
        department: s.department,
        account: acct,
        headline: `${s.tempAlerts} temperature reading${s.tempAlerts === 1 ? '' : 's'} out of range`,
        detail: null,
        severity: 'temp',
        shiftId: s.id,
      });
    }
    if (s.closedIncomplete) {
      exceptions.push({
        at: s.closedAt ?? s.openedAt,
        storeName: s.storeName,
        period: s.period,
        department: s.department,
        account: acct,
        headline: `Submitted incomplete — ${s.sopDone}/${s.sopTotal} required items`,
        detail: s.incompleteReason,
        severity: 'incomplete',
        shiftId: s.id,
      });
    }
    // A shift that never closed is the loudest exception of all: there is
    // no record, and the SOP was never signed.
    if (s.status !== 'CLOSED' && s.dueAt && s.dueAt.getTime() < generatedAt.getTime()) {
      exceptions.push({
        at: s.dueAt,
        storeName: s.storeName,
        period: s.period,
        department: s.department,
        account: s.openedBy?.email ?? null,
        headline: 'Never submitted — the shift window has ended',
        detail: `Opened ${s.openedBy?.name ?? 'unknown'}, due ${s.dueAt.toISOString()}`,
        severity: 'unsubmitted',
        shiftId: s.id,
      });
    }
  }
  if (rollup.handoverPending > 0) {
    const pending = await prisma.opsHandoverItem.findMany({
      where: { fromShiftId: { in: ids }, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        body: true,
        priority: true,
        createdAt: true,
        fromShift: {
          select: {
            id: true,
            period: true,
            department: true,
            client: { select: { name: true } },
            location: { select: { name: true } },
          },
        },
      },
    });
    for (const h of pending) {
      exceptions.push({
        at: h.createdAt,
        storeName: h.fromShift.location?.name ?? h.fromShift.client.name,
        period: h.fromShift.period,
        department: h.fromShift.department,
        account: null,
        headline: 'Handover still undecided',
        detail: h.body,
        severity: 'handover',
        shiftId: h.fromShift.id,
      });
    }
  }
  exceptions.sort((a, b) => b.at.getTime() - a.at.getTime());

  // --- the full record, for a single shift ---------------------------
  let detail: OpsPacket['detail'] = null;
  if (q.kind === 'shift' && anchorShift) {
    const [tasks, out, incoming] = await Promise.all([
      prisma.opsTask.findMany({
        where: { opsShiftId: anchorShift.id },
        orderBy: [{ source: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
        take: 500,
        select: {
          section: true,
          title: true,
          status: true,
          required: true,
          responseType: true,
          answerChoice: true,
          answerNumber: true,
          answerText: true,
          unit: true,
          tempLabel: true,
          tempMin: true,
          tempMax: true,
          tempOutOfRange: true,
          note: true,
          blockedReason: true,
          completedAt: true,
          doneAssociate: { select: { firstName: true, lastName: true } },
          completedBy: { select: { email: true } },
          _count: { select: { photos: true } },
        },
      }),
      prisma.opsHandoverItem.findMany({
        where: { fromShiftId: anchorShift.id },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          kind: true,
          body: true,
          priority: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          decidedBy: { select: { email: true } },
        },
      }),
      prisma.opsHandoverItem.findMany({
        where: { decidedInShiftId: anchorShift.id },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          kind: true,
          body: true,
          priority: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          decidedBy: { select: { email: true } },
          fromShift: {
            select: {
              period: true,
              department: true,
              dateKey: true,
              location: { select: { name: true } },
              client: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    const answerOf = (t: (typeof tasks)[number]): string | null => {
      if (t.responseType === 'TEMPERATURE' && t.answerNumber != null) {
        return `${Number(t.answerNumber)} °F`;
      }
      if (t.responseType === 'NUMBER' && t.answerNumber != null) {
        return `${Number(t.answerNumber).toLocaleString('en-US')}${t.unit ? ` ${t.unit}` : ''}`;
      }
      if (t.answerChoice) return t.answerChoice;
      if (t.answerText) return t.answerText;
      return null;
    };

    detail = {
      shift: toPacketShift(anchorShift),
      tasks: tasks.map((t) => ({
        section: t.section,
        title: t.tempLabel ? `${t.title} — ${t.tempLabel}` : t.title,
        status: t.status,
        required: t.required,
        responseType: t.responseType,
        answer: answerOf(t),
        band:
          t.tempMin != null || t.tempMax != null
            ? `${t.tempMin != null ? Number(t.tempMin) : '—'} to ${t.tempMax != null ? Number(t.tempMax) : '—'} °F`
            : null,
        outOfRange: t.tempOutOfRange,
        note: t.note,
        blockedReason: t.blockedReason,
        completedAt: t.completedAt,
        doneBy: t.doneAssociate ? `${t.doneAssociate.firstName} ${t.doneAssociate.lastName}` : null,
        completedByAccount: t.completedBy?.email ?? null,
        photos: t._count.photos,
      })),
      handoverOut: out.map((h) => ({
        kind: h.kind,
        body: h.body,
        priority: h.priority,
        status: h.status,
        createdAt: h.createdAt,
        decidedAt: h.decidedAt,
        decidedByAccount: h.decidedBy?.email ?? null,
        fromShift: null,
      })),
      handoverIn: incoming.map((h) => ({
        kind: h.kind,
        body: h.body,
        priority: h.priority,
        status: h.status,
        createdAt: h.createdAt,
        decidedAt: h.decidedAt,
        decidedByAccount: h.decidedBy?.email ?? null,
        fromShift: `${periodLabel(h.fromShift.period)} · ${
          h.fromShift.location?.name ?? h.fromShift.client.name
        } · ${h.fromShift.dateKey}`,
      })),
    };
  }

  // --- how to describe the scope on the masthead ---------------------
  const storeNames = [...new Set(shifts.map((s) => s.storeName))];
  const scopeLabel =
    q.kind === 'shift' && detail
      ? detail.shift.storeName
      : storeNames.length === 0
        ? 'No stores in range'
        : storeNames.length === 1
          ? storeNames[0]
          : `${storeNames.length} stores`;
  const narrowParts = [
    q.period ? periodLabel(q.period) : null,
    q.department ?? null,
  ].filter(Boolean) as string[];

  return {
    kind: q.kind,
    orgName,
    scopeLabel,
    narrowLabel: narrowParts.length ? narrowParts.join(' · ') : null,
    periodLabel: periodLabelText,
    from,
    to,
    generatedAt,
    shifts,
    rollup,
    byStore,
    byPeriod,
    bySupervisor,
    byDay,
    metrics,
    exceptions,
    detail,
    unplaced: shifts.filter((s) => s.storeName.endsWith('(store not recorded)')).length,
  };
}

/* ---- formatting shared with the renderer -------------------------- */

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OPS_TZ,
  hour: 'numeric',
  minute: '2-digit',
});
const stampFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OPS_TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const shortFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: OPS_TZ,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export const clock = (d: Date | null) => (d ? clockFmt.format(d) : '—');
/** "Sep 10, 3:12 AM" — for table columns, where the year is redundant. */
export const shortStamp = (d: Date | null) => (d ? shortFmt.format(d) : '—');
export const stamp = (d: Date | null) => (d ? `${stampFmt.format(d)} ET` : '—');
export const duration = (mins: number | null) => {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};
export { OPS_TZ, DAY_MS, dayLabel, monthLabel, utcInstantOfLocalMidnight };
