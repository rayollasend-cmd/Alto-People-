import type { Prisma } from '@prisma/client';
import type {
  FieldglassStatus,
  TimesheetHistoryPeriod,
  TimesheetHistoryResponse,
  TimesheetHistoryWeek,
} from '@alto-people/shared';
import { toCsv } from '@alto-people/shared';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE, formatTimeInZone, localDateKey } from './timezone.js';
import { netWorkedMinutes, type BreakFacts } from './timeAnomalies.js';
import { round2 } from './payroll.js';
import { buildAssociateDays, saturdayWeek, toUsDate, type TimesheetSourceEntry } from './timesheetWeek.js';
import { fieldglassDueAt, fieldglassHours } from './fieldglassDesk.js';
import { fieldglassSecurityId } from './fieldglassSecurityId.js';
import { payScheduleFor } from './associatePayday.js';
import { getCurrentPeriod } from './payrollSchedule.js';

/**
 * One associate's whole timesheet, across pay periods.
 *
 * Every Sat→Fri week they worked (one per client, as Fieldglass has one
 * timesheet per worker per SOW), with its day grid — time in, breaks, time
 * out, hours — grouped into the pay periods that paid them (their pay
 * schedule: Alto's is biweekly Sat→Fri, paid the Friday after), and where
 * each week stands in Fieldglass: entered, submitted, approved, rejected
 * and why, resubmitted, the timesheet ID and revision, finance's note.
 *
 * Scoped like the weekly sheet: a store-bound viewer sees only their
 * client's weeks, and never the money. The Security ID — built from PII —
 * only for finance.
 */

/** Three years of weeks; older history is in the payroll archive. */
const MAX_WEEKS = 156;
const MAX_ENTRIES = 5000;

export interface TimesheetHistoryInput {
  associateId: string;
  /** A store-bound viewer's client. */
  clientId?: string;
  scopeWhere: Prisma.TimeEntryWhereInput;
  /** A store-bound viewer: only their client's weeks, 404 without any. */
  bounded: boolean;
  showMoney: boolean;
  showSecurityId: boolean;
  now?: Date;
}

export async function buildTimesheetHistory(input: TimesheetHistoryInput): Promise<TimesheetHistoryResponse | null> {
  const now = input.now ?? new Date();
  const a = await prisma.associate.findFirst({
    where: { id: input.associateId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoS3Key: true,
      dob: true,
      ssnLast4: true,
      travelDocLast4: true,
      fieldglassRegistration: { select: { clientId: true, workerId: true, addedAt: true } },
    },
  });
  if (!a) return null;

  const from = new Date(now.getTime() - MAX_WEEKS * 7 * 86_400_000);
  const where: Prisma.TimeEntryWhereInput = {
    ...input.scopeWhere,
    associateId: a.id,
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };
  const [raw, firstEntry, schedule] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { ...where, status: { in: ['APPROVED', 'COMPLETED'] }, clockInAt: { gte: from } },
      orderBy: { clockInAt: 'desc' },
      take: MAX_ENTRIES,
      select: {
        clientId: true,
        clockInAt: true,
        clockOutAt: true,
        status: true,
        location: { select: { name: true, timezone: true } },
        shift: { select: { position: true } },
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
      },
    }),
    prisma.timeEntry.findFirst({
      where: { ...where, status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] } },
      orderBy: { clockInAt: 'asc' },
      select: { clockInAt: true, location: { select: { timezone: true } } },
    }),
    payScheduleFor(a.id),
  ]);
  if (input.bounded && raw.length === 0 && !firstEntry) return null;

  const clientIds = [...new Set(raw.map((e) => e.clientId).filter((x): x is string => !!x))];
  const clients = clientIds.length
    ? await prisma.client.findMany({
        where: { id: { in: clientIds } },
        select: { id: true, name: true, fieldglassSiteName: true, fieldglassBillRate: true },
      })
    : [];
  const clientOf = new Map(clients.map((c) => [c.id, c]));

  // Each entry into its week (by the site's own calendar) and client.
  type Group = { weekStart: string; weekEnd: string; dateKeys: string[]; clientId: string | null; entries: TimesheetSourceEntry[] };
  const groups = new Map<string, Group>();
  for (const e of raw) {
    const tz = e.location?.timezone ?? DEFAULT_TIMEZONE;
    const wk = saturdayWeek(e.clockInAt, tz);
    const key = `${wk.weekStart}|${e.clientId ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { ...wk, clientId: e.clientId, entries: [] };
      groups.set(key, g);
    }
    const c = e.clientId ? clientOf.get(e.clientId) : undefined;
    g.entries.push({
      associateId: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      clientId: e.clientId,
      site: c?.fieldglassSiteName ?? e.location?.name ?? c?.name ?? null,
      clockInAt: e.clockInAt,
      clockOutAt: e.clockOutAt,
      status: e.status,
      shiftName: e.shift?.position ?? null,
      breaks: e.breaks.map((b) => ({ type: b.type as BreakFacts['type'], startedAt: b.startedAt, endedAt: b.endedAt })),
      timeZone: tz,
    });
  }

  const weekStarts = [...new Set([...groups.values()].map((g) => g.weekStart))];
  const sheets = weekStarts.length
    ? await prisma.fieldglassTimesheet.findMany({
        where: { associateId: a.id, weekStart: { in: weekStarts.map((w) => new Date(`${w}T00:00:00Z`)) } },
      })
    : [];
  const sheetOf = new Map(sheets.map((s) => [`${s.weekStart.toISOString().slice(0, 10)}|${s.clientId}`, s]));
  const enteredByIds = [...new Set(sheets.map((s) => s.enteredById).filter((x): x is string => !!x))];
  const users = enteredByIds.length
    ? await prisma.user.findMany({
        where: { id: { in: enteredByIds } },
        select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } },
      })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.email]));
  const reg = a.fieldglassRegistration;

  const todayKey = localDateKey(now, DEFAULT_TIMEZONE);
  const year = Number(todayKey.slice(0, 4));
  const fg = { approved: 0, awaiting: 0, rejected: 0, toEnter: 0, overdue: 0, notRegistered: 0, variances: 0 };
  const money = { approved: 0, awaiting: 0, atRisk: 0 };

  const weeks: TimesheetHistoryWeek[] = [...groups.values()].map((g) => {
    const { days, totalHours } = buildAssociateDays(g.entries, g.dateKeys);
    const pendingMin = g.entries
      .filter((e) => e.status === 'COMPLETED' && e.clockOutAt)
      .reduce((m, e) => m + netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt }, e.breaks), 0);
    const client = g.clientId ? clientOf.get(g.clientId) : undefined;
    const rate = client?.fieldglassBillRate != null ? Number(client.fieldglassBillRate) : null;
    const inProgress = todayKey <= g.weekEnd;
    const due = fieldglassDueAt(g.weekEnd);
    const sheet = g.clientId ? sheetOf.get(`${g.weekStart}|${g.clientId}`) : undefined;
    const status = (sheet?.fgStatus as FieldglassStatus | null | undefined) ?? null;
    const fgHours = sheet?.fgHours != null ? Number(sheet.fgHours) : null;
    // Registered under this client now — or, for a week before a transfer,
    // Fieldglass had its timesheet then.
    const registered = !!g.clientId && ((!!reg && reg.clientId === g.clientId) || !!sheet?.enteredAt || !!status);
    const overdue =
      !!g.clientId && registered && !inProgress && totalHours > 0 && !sheet?.enteredAt && !status && now > due;

    if (g.clientId && totalHours > 0) {
      if (!registered) fg.notRegistered += 1;
      if (status === 'APPROVED' || status === 'INVOICED') fg.approved += 1;
      else if (status === 'REJECTED') fg.rejected += 1;
      else if (status || sheet?.enteredAt) fg.awaiting += 1;
      else if (registered && !inProgress) fg.toEnter += 1;
      if (overdue) fg.overdue += 1;
      if (fgHours !== null && Math.abs(fgHours - totalHours) >= 0.01) fg.variances += 1;
      if (rate !== null) {
        const h = fieldglassHours({ registered, status, entered: !!sheet?.enteredAt, fgHours, total: totalHours });
        money.approved += h.approved * rate;
        money.awaiting += h.awaiting * rate;
        // A week still being worked isn't at risk yet.
        if (!inProgress) money.atRisk += h.atRisk * rate;
      }
    }

    return {
      weekStart: g.weekStart,
      weekEnd: g.weekEnd,
      weekEnding: toUsDate(g.weekEnd),
      clientId: g.clientId,
      clientName: client?.name ?? null,
      site: g.entries[0]?.site ?? '—',
      days,
      total: totalHours,
      pendingHours: round2(pendingMin / 60),
      inProgress,
      dueAt: due.toISOString(),
      overdue,
      fieldglass: g.clientId
        ? {
            registered,
            workerId: registered ? (reg?.workerId ?? null) : null,
            enteredAt: sheet?.enteredAt?.toISOString() ?? null,
            enteredBy: sheet?.enteredById ? (nameOf.get(sheet.enteredById) ?? null) : null,
            enteredHours: sheet?.enteredHours != null ? Number(sheet.enteredHours) : null,
            status,
            timesheetId: sheet?.fgTimesheetId ?? null,
            revision: sheet?.fgRevision ?? null,
            hours: fgHours,
            syncedAt: sheet?.fgSyncedAt?.toISOString() ?? null,
            comment: sheet?.fgComment ?? null,
            resubmittedAt: sheet?.resubmittedAt?.toISOString() ?? null,
            note: sheet?.note ?? null,
          }
        : null,
      amount: input.showMoney && rate !== null ? round2(totalHours * rate) : null,
    };
  });
  weeks.sort((x, y) => y.weekStart.localeCompare(x.weekStart) || x.site.localeCompare(y.site));

  // Into the pay periods that paid them. No schedule: each week stands alone.
  const periodMap = new Map<string, TimesheetHistoryPeriod>();
  for (const w of weeks) {
    const p = schedule
      ? getCurrentPeriod(schedule, new Date(`${w.weekStart}T12:00:00Z`))
      : { periodStart: w.weekStart, periodEnd: w.weekEnd, payDate: null };
    let period = periodMap.get(p.periodStart);
    if (!period) {
      period = { periodStart: p.periodStart, periodEnd: p.periodEnd, payDate: p.payDate, weeks: [], total: 0, pendingHours: 0, amount: null };
      periodMap.set(p.periodStart, period);
    }
    period.weeks.push(w);
    period.total = round2(period.total + w.total);
    period.pendingHours = round2(period.pendingHours + w.pendingHours);
    if (w.amount !== null) period.amount = round2((period.amount ?? 0) + w.amount);
  }
  const periods = [...periodMap.values()].sort((x, y) => y.periodStart.localeCompare(x.periodStart));

  const workedWeeks = new Set(weeks.filter((w) => w.total > 0 || w.pendingHours > 0).map((w) => w.weekStart)).size;
  const hours = round2(weeks.reduce((s, w) => s + w.total, 0));
  const newest = raw[0];
  const newestClient = newest?.clientId ? clientOf.get(newest.clientId) : undefined;
  const firstTz = firstEntry?.location?.timezone ?? DEFAULT_TIMEZONE;
  const anyRate = clients.some((c) => c.fieldglassBillRate != null);

  return {
    associate: {
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      worker: `${a.lastName}, ${a.firstName}`,
      photoUrl: a.photoS3Key ? `/api/associates/${a.id}/photo` : null,
      clientName: newestClient?.name ?? null,
      position: raw.find((e) => e.shift?.position)?.shift?.position ?? null,
      workerId: reg?.workerId ?? null,
      registeredAt: reg?.addedAt.toISOString() ?? null,
      firstClockIn: firstEntry
        ? { date: localDateKey(firstEntry.clockInAt, firstTz), time: formatTimeInZone(firstEntry.clockInAt, firstTz) }
        : null,
      lastWorked: newest ? localDateKey(newest.clockInAt, newest.location?.timezone ?? DEFAULT_TIMEZONE) : null,
      securityId: input.showSecurityId ? fieldglassSecurityId(a).value : null,
    },
    schedule: schedule ? { name: schedule.name, frequency: schedule.frequency } : null,
    periods,
    totals: {
      hours,
      weeks: workedWeeks,
      avgWeekHours: workedWeeks > 0 ? round2(hours / workedWeeks) : 0,
      year,
      yearHours: round2(weeks.filter((w) => w.weekEnd.startsWith(String(year))).reduce((s, w) => s + w.total, 0)),
      pendingHours: round2(weeks.reduce((s, w) => s + w.pendingHours, 0)),
      fieldglass: fg,
      money:
        input.showMoney && anyRate
          ? { approved: round2(money.approved), awaiting: round2(money.awaiting), atRisk: round2(money.atRisk) }
          : null,
    },
    years: [...new Set(weeks.map((w) => Number(w.weekEnd.slice(0, 4))))].sort((x, y) => y - x),
    truncated: raw.length >= MAX_ENTRIES || (!!firstEntry && firstEntry.clockInAt < from),
    from: raw.length >= MAX_ENTRIES ? localDateKey(raw[raw.length - 1]!.clockInAt, DEFAULT_TIMEZONE) : from.toISOString().slice(0, 10),
    generatedAt: now.toISOString(),
  };
}

const FG_WORD: Record<FieldglassStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  INVOICED: 'Invoiced',
};

/** Where a week stands in Fieldglass, in a word or three. */
export function fieldglassWord(w: TimesheetHistoryWeek): string {
  const f = w.fieldglass;
  if (!f) return '';
  if (!f.registered) return 'Not in Fieldglass';
  if (f.status) return f.resubmittedAt && f.status === 'SUBMITTED' ? 'Resubmitted' : FG_WORD[f.status];
  if (f.enteredAt) return 'Entered';
  if (w.inProgress) return 'Week in progress';
  return w.overdue ? 'Not entered — past due' : 'To enter';
}

/** The whole history as a spreadsheet: one row per worked day. */
export function timesheetHistoryCsv(h: TimesheetHistoryResponse): string {
  const money = h.totals.money !== null;
  const rows: Array<Array<string | number | null>> = [
    [
      'Worker',
      'Pay period',
      'Pay date',
      'Week ending',
      'Date',
      'Day',
      'Client',
      'Site',
      'Shift',
      'Time in',
      'Time out',
      'Breaks',
      'Hours',
      'Week total',
      'Fieldglass',
      'Timesheet ID',
      'Revision',
      'Fieldglass hours',
      'Note',
      ...(money ? ['Week amount'] : []),
    ],
  ];
  for (const p of h.periods) {
    for (const w of p.weeks) {
      for (const d of w.days) {
        if (d.netHours <= 0 && !d.timeIn) continue;
        rows.push([
          h.associate.worker,
          `${toUsDate(p.periodStart)} – ${toUsDate(p.periodEnd)}`,
          p.payDate ? toUsDate(p.payDate) : '',
          w.weekEnding,
          toUsDate(d.date),
          d.weekday,
          w.clientName,
          w.site,
          (d.shifts ?? []).filter(Boolean).join(' / '),
          d.timeIn,
          d.timeOut,
          d.breaks.join('; '),
          d.netHours.toFixed(2),
          w.total.toFixed(2),
          fieldglassWord(w),
          w.fieldglass?.timesheetId ?? '',
          w.fieldglass?.revision ?? '',
          w.fieldglass?.hours != null ? w.fieldglass.hours.toFixed(2) : '',
          w.fieldglass?.note ?? '',
          ...(money ? [w.amount != null ? w.amount.toFixed(2) : ''] : []),
        ]);
      }
    }
  }
  return toCsv(rows);
}

export function timesheetHistoryFilename(h: TimesheetHistoryResponse): string {
  const slug = h.associate.worker.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `timesheet-history-${slug || 'associate'}.csv`;
}
