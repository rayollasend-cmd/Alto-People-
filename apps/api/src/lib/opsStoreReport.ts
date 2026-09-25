import { prisma } from '../db.js';
import { getBlobStore } from './blobStore.js';
import { buildOpsPacket, periodLabel, type OpsPacket } from './opsPacket.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * THE STORE OPERATIONS REPORT — what a store manager takes into planning.
 *
 * The SOP packet is the record: every shift, every exception, the accounts
 * behind them. This is the record read forward: one store (or all), any
 * range, with each figure set against the period before it, the evidence
 * drawn rather than listed, and a last page that says what to plan for —
 * the blocks that keep running late, the items that keep failing, the
 * shifts that never opened, the readings that took longest to re-check.
 *
 * Everything here is derived from the same rows the packet reads, with
 * four additions the packet does not need: the prior period (for deltas),
 * the temperature readings with the re-check that closed each one, the
 * per-line record of the standard, and the due-time record of each block.
 * Photos come from the store's own shifts only.
 */

const DAY_MS = 24 * 3_600_000;

export interface StoreReportQuery {
  clientId?: string | null;
  locationId?: string | null;
  /** Inclusive org day keys. */
  from: string;
  to: string;
}

export interface ReportStore {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string;
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface ReportKpi {
  label: string;
  value: string;
  /** "+4 pts vs prior", "-12 min vs prior" — null when there is no prior. */
  delta: string | null;
  tone: Tone;
  sub: string | null;
}

export interface ReportGridCell {
  department: string;
  period: string;
  shifts: number;
  sopPct: number | null;
  incomplete: number;
  tempAlerts: number;
  unsubmitted: number;
}

export interface ReportTempReading {
  at: Date;
  dateKey: string;
  department: string;
  period: string;
  label: string;
  value: number;
  min: number | null;
  max: number | null;
  out: boolean;
  /** Minutes from an out-of-range reading to the first in-range re-check; null = never re-checked. */
  recheckMinutes: number | null;
}

export interface ReportLineFailure {
  title: string;
  section: string | null;
  runs: number;
  failed: number;
}

export interface ReportLateBlock {
  section: string;
  /** Hour of day (store-local) the block was due. */
  hour: number;
  runs: number;
  late: number;
}

export interface ReportDailyMetric {
  metricKey: string;
  unit: string | null;
  total: number;
  mean: number;
  byDay: { dateKey: string; total: number }[];
}

export interface ReportPhoto {
  buffer: Buffer;
  caption: string;
  at: Date;
}

export interface ReportInsight {
  title: string;
  body: string;
  tone: Tone;
}

export interface OpsStoreReport {
  orgName: string;
  clientName: string;
  store: ReportStore | null;
  from: string;
  to: string;
  days: string[];
  periodLabel: string;
  priorLabel: string | null;
  generatedAt: Date;
  packet: OpsPacket;
  prior: OpsPacket | null;
  kpis: ReportKpi[];
  grid: { departments: string[]; periods: string[]; cells: ReportGridCell[] };
  temps: ReportTempReading[];
  lineFailures: ReportLineFailure[];
  lateBlocks: ReportLateBlock[];
  dailyMetrics: ReportDailyMetric[];
  staffing: { scheduled: number; actual: number; understaffedShifts: number; sopPctUnderstaffed: number | null; sopPctFull: number | null };
  planned: { perDay: number; days: number; expected: number; ran: number };
  photos: ReportPhoto[];
  insights: ReportInsight[];
}

const PERIOD_ORDER = ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'];

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to && out.length < 400; k = addDays(k, 1)) out.push(k);
  return out;
}

function dayLabel(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function shortDay(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function rangeLabel(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${shortDay(from)} – ${dayLabel(to)}`;
}

function hourInZone(d: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d);
  const n = Number(h);
  return Number.isFinite(n) ? n % 24 : d.getUTCHours();
}

export function hourLabel(h: number): string {
  const x = ((h % 24) + 24) % 24;
  const suffix = x >= 12 ? 'PM' : 'AM';
  const hh = x % 12 === 0 ? 12 : x % 12;
  return `${hh} ${suffix}`;
}

function pctOf(done: number, total: number): number | null {
  return total > 0 ? Math.round((done / total) * 100) : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function deltaPts(now: number | null, before: number | null, unit = 'pts'): { text: string | null; dir: 1 | 0 | -1 } {
  if (now == null || before == null) return { text: null, dir: 0 };
  const d = now - before;
  if (d === 0) return { text: `level with prior`, dir: 0 };
  return { text: `${d > 0 ? '+' : '-'}${Math.abs(d)} ${unit} vs prior`, dir: d > 0 ? 1 : -1 };
}

/** The store manager's report for a range. Null when the scope is not visible to the caller. */
export async function buildOpsStoreReport(
  q: StoreReportQuery,
  orgName: string,
  clientClamp: string | undefined,
): Promise<OpsStoreReport | null> {
  const generatedAt = new Date();
  let from = /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : orgDateKey(new Date(generatedAt.getTime() - 7 * DAY_MS));
  let to = /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : orgDateKey(new Date(generatedAt.getTime() - DAY_MS));
  if (from > to) [from, to] = [to, from];
  const days = daysBetween(from, to);
  if (days.length > 92) return null;

  const store = q.locationId
    ? await prisma.location.findFirst({
        where: {
          id: q.locationId,
          ...(clientClamp !== undefined ? { clientId: clientClamp } : q.clientId ? { clientId: q.clientId } : {}),
        },
        select: {
          id: true,
          name: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          zip: true,
          timezone: true,
          clientId: true,
          client: { select: { name: true } },
        },
      })
    : null;
  if (q.locationId && !store) return null;
  const clientId = store?.clientId ?? (clientClamp !== undefined ? clientClamp : q.clientId ?? null);
  const client = clientId
    ? await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } })
    : null;

  const scope = { clientId, locationId: store?.id ?? null };
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(days.length - 1));
  const [packet, prior] = await Promise.all([
    buildOpsPacket({ kind: 'range', from, to, ...scope }, orgName, clientClamp),
    buildOpsPacket({ kind: 'range', from: priorFrom, to: priorTo, ...scope }, orgName, clientClamp),
  ]);
  if (!packet) return null;
  const ids = packet.shifts.map((s) => s.id);
  const tz = store?.timezone ?? 'America/New_York';

  /* ---- evidence beyond the packet ------------------------------------ */
  const [tempTasks, lineTasks, dueTasks, metricTasks, photoRows, plannedPerDay] = await Promise.all([
    ids.length
      ? prisma.opsTask.findMany({
          where: { opsShiftId: { in: ids }, responseType: 'TEMPERATURE', answerNumber: { not: null }, parentTaskId: null },
          select: {
            id: true,
            title: true,
            tempLabel: true,
            answerNumber: true,
            tempMin: true,
            tempMax: true,
            tempOutOfRange: true,
            completedAt: true,
            opsShift: { select: { department: true, period: true, dateKey: true } },
          },
          orderBy: { completedAt: 'asc' },
          take: 2000,
        })
      : [],
    ids.length
      ? prisma.opsTask.findMany({
          where: { opsShiftId: { in: ids }, source: 'SOP', templateTaskId: { not: null }, parentTaskId: null },
          select: { templateTaskId: true, title: true, section: true, status: true, required: true, answerChoice: true, tempOutOfRange: true },
          take: 20000,
        })
      : [],
    ids.length
      ? prisma.opsTask.findMany({
          where: { opsShiftId: { in: ids }, dueAt: { not: null }, section: { not: null }, parentTaskId: null },
          select: { section: true, dueAt: true, completedAt: true, status: true },
          take: 20000,
        })
      : [],
    ids.length
      ? prisma.opsTask.findMany({
          where: { opsShiftId: { in: ids }, responseType: 'NUMBER', metricKey: { not: null }, answerNumber: { not: null } },
          select: { metricKey: true, unit: true, answerNumber: true, opsShift: { select: { dateKey: true } } },
          take: 8000,
        })
      : [],
    ids.length
      ? prisma.opsTaskPhoto.findMany({
          where: { task: { is: { opsShiftId: { in: ids } } }, mimeType: { in: ['image/jpeg', 'image/png'] } },
          orderBy: { createdAt: 'desc' },
          take: 9,
          select: {
            s3Key: true,
            createdAt: true,
            task: { select: { title: true, opsShift: { select: { department: true, period: true, dateKey: true } } } },
          },
        })
      : [],
    store ? prisma.storeShiftSop.count({ where: { locationId: store.id } }) : 0,
  ]);

  // Re-checks: the first in-range temperature child of an out-of-range reading.
  const outIds = tempTasks.filter((t) => t.tempOutOfRange).map((t) => t.id);
  const rechecks = outIds.length
    ? await prisma.opsTask.findMany({
        where: { parentTaskId: { in: outIds }, responseType: 'TEMPERATURE', answerNumber: { not: null }, tempOutOfRange: false },
        select: { parentTaskId: true, completedAt: true },
        orderBy: { completedAt: 'asc' },
      })
    : [];
  const recheckAt = new Map<string, Date>();
  for (const r of rechecks) {
    if (r.parentTaskId && r.completedAt && !recheckAt.has(r.parentTaskId)) recheckAt.set(r.parentTaskId, r.completedAt);
  }
  const temps: ReportTempReading[] = tempTasks
    .filter((t) => t.completedAt)
    .map((t) => {
      const re = t.tempOutOfRange ? recheckAt.get(t.id) ?? null : null;
      return {
        at: t.completedAt!,
        dateKey: t.opsShift.dateKey,
        department: t.opsShift.department,
        period: t.opsShift.period,
        label: t.tempLabel ? `${t.title} — ${t.tempLabel}` : t.title,
        value: Number(t.answerNumber),
        min: t.tempMin != null ? Number(t.tempMin) : null,
        max: t.tempMax != null ? Number(t.tempMax) : null,
        out: t.tempOutOfRange,
        recheckMinutes: re ? Math.max(0, Math.round((re.getTime() - t.completedAt!.getTime()) / 60_000)) : null,
      };
    });

  // The standard, line by line.
  const lineMap = new Map<string, ReportLineFailure>();
  for (const t of lineTasks) {
    const key = t.templateTaskId!;
    const row = lineMap.get(key) ?? { title: t.title, section: t.section, runs: 0, failed: 0 };
    row.runs += 1;
    const answer = (t.answerChoice ?? '').toUpperCase();
    const failed =
      t.status === 'BLOCKED' ||
      (t.required && t.status !== 'DONE') ||
      answer === 'NO' ||
      answer === 'PARTIAL' ||
      t.tempOutOfRange;
    if (failed) row.failed += 1;
    lineMap.set(key, row);
  }
  const lineFailures = [...lineMap.values()]
    .filter((r) => r.failed > 0 && r.runs >= 2)
    .sort((a, b) => b.failed / b.runs - a.failed / a.runs || b.failed - a.failed)
    .slice(0, 8);

  // Blocks that run late, by the hour they were due.
  const lateMap = new Map<string, ReportLateBlock>();
  for (const t of dueTasks) {
    if (!t.dueAt || !t.section) continue;
    const late = t.completedAt ? t.completedAt.getTime() > t.dueAt.getTime() : t.dueAt.getTime() < generatedAt.getTime();
    const hour = hourInZone(t.dueAt, tz);
    const key = `${t.section}|${hour}`;
    const row = lateMap.get(key) ?? { section: t.section, hour, runs: 0, late: 0 };
    row.runs += 1;
    if (late) row.late += 1;
    lateMap.set(key, row);
  }
  const lateBlocks = [...lateMap.values()]
    .filter((r) => r.late >= 2)
    .sort((a, b) => b.late - a.late || a.hour - b.hour)
    .slice(0, 6);

  // Production, by day.
  const metricMap = new Map<string, ReportDailyMetric & { days: Map<string, number> }>();
  for (const t of metricTasks) {
    if (!t.metricKey || t.answerNumber == null) continue;
    const row = metricMap.get(t.metricKey) ?? { metricKey: t.metricKey, unit: t.unit, total: 0, mean: 0, byDay: [], days: new Map() };
    const v = Number(t.answerNumber);
    row.total += v;
    row.days.set(t.opsShift.dateKey, (row.days.get(t.opsShift.dateKey) ?? 0) + v);
    metricMap.set(t.metricKey, row);
  }
  const dailyMetrics: ReportDailyMetric[] = [...metricMap.values()]
    .map((m) => ({
      metricKey: m.metricKey,
      unit: m.unit,
      total: m.total,
      mean: days.length ? m.total / days.length : 0,
      byDay: days.map((d) => ({ dateKey: d, total: m.days.get(d) ?? 0 })),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);

  // Staffing.
  const scheduled = packet.shifts.reduce((a, s) => a + s.scheduledHeadcount, 0);
  const actual = packet.shifts.reduce((a, s) => a + s.actualHeadcount, 0);
  const under = packet.shifts.filter((s) => s.scheduledHeadcount > 0 && s.actualHeadcount < s.scheduledHeadcount);
  const full = packet.shifts.filter((s) => s.scheduledHeadcount > 0 && s.actualHeadcount >= s.scheduledHeadcount);
  const sum = (xs: typeof packet.shifts, k: 'sopDone' | 'sopTotal') => xs.reduce((a, s) => a + s[k], 0);
  const staffing = {
    scheduled,
    actual,
    understaffedShifts: under.length,
    sopPctUnderstaffed: pctOf(sum(under, 'sopDone'), sum(under, 'sopTotal')),
    sopPctFull: pctOf(sum(full, 'sopDone'), sum(full, 'sopTotal')),
  };
  const planned = { perDay: plannedPerDay, days: days.length, expected: plannedPerDay * days.length, ran: packet.rollup.shifts };

  // The grid: department × shift.
  const cellMap = new Map<string, ReportGridCell & { done: number; total: number }>();
  for (const s of packet.shifts) {
    const key = `${s.department}|${s.period}`;
    const c = cellMap.get(key) ?? { department: s.department, period: s.period, shifts: 0, sopPct: null, incomplete: 0, tempAlerts: 0, unsubmitted: 0, done: 0, total: 0 };
    c.shifts += 1;
    c.done += s.sopDone;
    c.total += s.sopTotal;
    if (s.closedIncomplete) c.incomplete += 1;
    c.tempAlerts += s.tempAlerts;
    if (s.status !== 'CLOSED' && s.dueAt && s.dueAt.getTime() < generatedAt.getTime()) c.unsubmitted += 1;
    cellMap.set(key, c);
  }
  const departments = [...new Set(packet.shifts.map((s) => s.department))].sort();
  const periods = PERIOD_ORDER.filter((p) => packet.shifts.some((s) => s.period === p));
  const cells = [...cellMap.values()].map((c) => ({ ...c, sopPct: pctOf(c.done, c.total) }));

  // Photos, from this scope's shifts only.
  const blob = getBlobStore();
  const photos: ReportPhoto[] = [];
  for (const p of photoRows) {
    try {
      const buffer = await blob.get(p.s3Key);
      if (!buffer) continue;
      photos.push({
        buffer,
        at: p.createdAt,
        caption: `${p.task.title} · ${p.task.opsShift.department} · ${periodLabel(p.task.opsShift.period)} · ${shortDay(p.task.opsShift.dateKey)}`,
      });
    } catch {
      /* a photo that cannot be read is left out, never a broken page */
    }
  }

  /* ---- the figures, against the prior period --------------------------- */
  const r = packet.rollup;
  const pr = prior?.rollup ?? null;
  const tempsIn = r.tempChecks - r.tempOutOfRange;
  const tempPct = pctOf(tempsIn, r.tempChecks);
  const priorTempPct = pr ? pctOf(pr.tempChecks - pr.tempOutOfRange, pr.tempChecks) : null;
  const onTimePct = pctOf(r.onTimeCloses, r.onTimeOf);
  const priorOnTimePct = pr ? pctOf(pr.onTimeCloses, pr.onTimeOf) : null;
  const recheckMins = temps.filter((t) => t.out && t.recheckMinutes != null).map((t) => t.recheckMinutes!);
  const recheckMedian = median(recheckMins);
  const neverRechecked = temps.filter((t) => t.out && t.recheckMinutes == null).length;
  const carried = r.handoverCarried + r.handoverReviewed;
  const carriedPct = pctOf(carried, r.handoverCreated);
  const priorCarriedPct = pr ? pctOf(pr.handoverCarried + pr.handoverReviewed, pr.handoverCreated) : null;
  const grade = (v: number | null, good = 95, warn = 85): Tone => (v == null ? 'neutral' : v >= good ? 'good' : v >= warn ? 'warn' : 'bad');

  const kpis: ReportKpi[] = [
    {
      label: 'SOP completion',
      value: r.sopPct == null ? '—' : `${r.sopPct}%`,
      delta: deltaPts(r.sopPct, pr?.sopPct ?? null).text,
      tone: grade(r.sopPct),
      sub: `${r.sopDone.toLocaleString('en-US')} of ${r.sopTotal.toLocaleString('en-US')} required items`,
    },
    {
      label: 'Submitted on time',
      value: onTimePct == null ? '—' : `${onTimePct}%`,
      delta: deltaPts(onTimePct, priorOnTimePct).text,
      tone: grade(onTimePct, 90, 75),
      sub: r.onTimeOf > 0 ? `${r.onTimeCloses} of ${r.onTimeOf} shifts by their window` : 'nothing was due',
    },
    {
      label: 'Temperatures in range',
      value: tempPct == null ? '—' : `${tempPct}%`,
      delta: deltaPts(tempPct, priorTempPct).text,
      tone: r.tempOutOfRange === 0 ? (r.tempChecks > 0 ? 'good' : 'neutral') : neverRechecked > 0 ? 'bad' : 'warn',
      sub: `${r.tempOutOfRange} of ${r.tempChecks} readings out of range`,
    },
    {
      label: 'Re-check time',
      value: recheckMedian == null ? (r.tempOutOfRange > 0 ? 'none' : '—') : `${recheckMedian} min`,
      delta: neverRechecked > 0 ? `${neverRechecked} never re-checked` : recheckMins.length ? `slowest ${Math.max(...recheckMins)} min` : null,
      tone: neverRechecked > 0 ? 'bad' : recheckMedian == null ? 'neutral' : recheckMedian <= 30 ? 'good' : recheckMedian <= 60 ? 'warn' : 'bad',
      sub: 'median, out-of-range to back in range',
    },
    {
      label: 'Shifts run',
      value: `${r.shifts}`,
      delta: pr ? `${pr.shifts} in prior period` : null,
      tone: planned.expected > 0 && r.shifts < planned.expected ? 'warn' : 'neutral',
      sub: planned.expected > 0 ? `${planned.expected} planned store shifts · ${r.stillOpen} still open` : `${r.stillOpen} still open`,
    },
    {
      label: 'Handovers carried through',
      value: carriedPct == null ? '—' : `${carriedPct}%`,
      delta: deltaPts(carriedPct, priorCarriedPct).text,
      tone: r.handoverPending > 0 ? 'warn' : grade(carriedPct, 90, 70),
      sub: `${r.handoverCreated} raised · ${r.handoverPending} still undecided`,
    },
  ];

  /* ---- what to plan for ------------------------------------------------ */
  const insights: ReportInsight[] = [];
  const shiftsGap = planned.expected - r.shifts;
  if (planned.expected > 0 && shiftsGap > 0) {
    insights.push({
      title: `${shiftsGap} planned store shift${shiftsGap === 1 ? '' : 's'} ran without an SOP`,
      body: `${store?.name ?? clientName(client)} has ${planned.perDay} SOP shift${planned.perDay === 1 ? '' : 's'} a day; ${r.shifts} of ${planned.expected} opened in this period. A shift with no SOP leaves no record — check the supervisor roster for those days and whether the clock-in opened the checklist.`,
      tone: 'bad',
    });
  }
  if (neverRechecked > 0) {
    insights.push({
      title: `${neverRechecked} out-of-range reading${neverRechecked === 1 ? '' : 's'} never re-checked`,
      body: 'A warm reading with no re-check is the finding an inspector writes up. Each one is listed in Food safety with the shift it belongs to; the corrective re-check should be the supervisor’s next action, not the next shift’s.',
      tone: 'bad',
    });
  } else if (recheckMedian != null && recheckMedian > 45) {
    insights.push({
      title: `Re-checks take ${recheckMedian} minutes`,
      body: 'Out-of-range readings were corrected, but slowly. A 30-minute re-check window keeps product inside its safe hold time; put the re-check on the block that follows the reading rather than at close.',
      tone: 'warn',
    });
  }
  for (const b of lateBlocks.slice(0, 2)) {
    insights.push({
      title: `“${b.section}” ran late ${b.late} of ${b.runs} times`,
      body: `The block due around ${hourLabel(b.hour)} finished after its deadline on most days. Either the start is too late for the work in it or the work belongs to a later block — move the due time or split the block, and staff the hour before it.`,
      tone: b.late >= b.runs * 0.6 ? 'bad' : 'warn',
    });
  }
  for (const f of lineFailures.slice(0, 2)) {
    insights.push({
      title: `“${f.title}” failed ${f.failed} of ${f.runs} runs`,
      body: `${f.section ? `In ${f.section}: ` : ''}a line that fails this often is a supply, equipment or training problem, not a supervisor problem. Walk it with the shift lead once and record what stops it getting done.`,
      tone: f.failed / f.runs >= 0.5 ? 'bad' : 'warn',
    });
  }
  if (staffing.understaffedShifts > 0 && staffing.sopPctUnderstaffed != null && staffing.sopPctFull != null && staffing.sopPctUnderstaffed < staffing.sopPctFull) {
    insights.push({
      title: `${staffing.understaffedShifts} shift${staffing.understaffedShifts === 1 ? '' : 's'} ran short-staffed`,
      body: `SOP completion was ${staffing.sopPctUnderstaffed}% on short-staffed shifts against ${staffing.sopPctFull}% at full headcount. Fill rate is doing part of the compliance work; plan cover for the shifts that usually run short.`,
      tone: 'warn',
    });
  }
  if (r.incomplete > 0) {
    const reasons = packet.shifts.filter((s) => s.closedIncomplete && s.incompleteReason).map((s) => s.incompleteReason!);
    insights.push({
      title: `${r.incomplete} shift${r.incomplete === 1 ? '' : 's'} submitted incomplete`,
      body: reasons.length ? `Reasons given: ${reasons.slice(0, 2).map((x) => `“${x.slice(0, 120)}”`).join('; ')}. Each is in Exceptions with the account that submitted it.` : 'Each is listed in Exceptions with the account that submitted it.',
      tone: 'warn',
    });
  }
  if (r.handoverPending > 0) {
    insights.push({
      title: `${r.handoverPending} handover item${r.handoverPending === 1 ? '' : 's'} nobody picked up`,
      body: 'A note left by one shift and never decided by the next is work that fell through. The next shift’s supervisor should open with the handover, and the store should see it on the board until it is carried or dismissed.',
      tone: 'warn',
    });
  }
  if (pr && r.sopPct != null && pr.sopPct != null && r.sopPct - pr.sopPct >= 3) {
    insights.push({
      title: `SOP completion up ${r.sopPct - pr.sopPct} points on the prior period`,
      body: 'The trend is the right way. Keep the block due times and the supervisor roster as they are this week and use the freed attention on the items above.',
      tone: 'good',
    });
  }
  if (insights.length === 0) {
    insights.push({
      title: 'A clean period',
      body: `Every shift opened, every required item was recorded and every temperature held its range. The plan for next week is the same plan — the numbers to watch are on page one.`,
      tone: 'good',
    });
  }

  return {
    orgName,
    clientName: clientName(client),
    store: store
      ? { id: store.id, name: store.name, addressLine1: store.addressLine1, addressLine2: store.addressLine2, city: store.city, state: store.state, zip: store.zip, timezone: store.timezone }
      : null,
    from,
    to,
    days,
    periodLabel: rangeLabel(from, to),
    priorLabel: prior ? rangeLabel(priorFrom, priorTo) : null,
    generatedAt,
    packet,
    prior,
    kpis,
    grid: { departments, periods, cells },
    temps,
    lineFailures,
    lateBlocks,
    dailyMetrics,
    staffing,
    planned,
    photos,
    insights: insights.slice(0, 6),
  };
}

function clientName(c: { name: string } | null): string {
  return c?.name ?? 'the client';
}

/** "Walmart Santa Rosa Beach" → "walmart-santa-rosa-beach". */
export function reportSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .slice(0, 60) || 'store';
}

/** yesterday | last-week (the completed Sat–Fri org week) | last-7 → org day keys. */
export function presetRange(preset: string, now: Date = new Date()): { from: string; to: string } | null {
  const today = orgDateKey(now);
  const yesterday = addDays(today, -1);
  if (preset === 'yesterday') return { from: yesterday, to: yesterday };
  if (preset === 'last-7') return { from: addDays(yesterday, -6), to: yesterday };
  if (preset === 'last-week') {
    // The org week runs Saturday 00:00 to Friday 24:00; the most recent
    // COMPLETED week ends on the last Friday before today.
    const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay(); // 0=Sun … 6=Sat
    const back = (weekday + 7 - 5) % 7 || 7;
    const to = addDays(today, -back);
    return { from: addDays(to, -6), to };
  }
  return null;
}
