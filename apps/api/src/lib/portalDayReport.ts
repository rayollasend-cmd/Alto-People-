import PDFDocument from 'pdfkit';
import { paidMinutesForRange } from '@alto-people/shared';
import { prisma } from '../db.js';
import { orgDateKey, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { formatTimeInZone, zonedMinutes } from './timezone.js';
import {
  DAY,
  HOUR,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  entryScope,
  fullName,
  gradeWeeks,
  loadPunches,
  loadTargets,
  netMinutes,
  nextKey,
  shiftScope,
  targetAtMinute,
  type PortalScope,
} from './portalMetrics.js';

/**
 * The store service report — the dashboard, on paper, for a day the
 * store manager picks.
 *
 * A manager who downloads the 16th gets the portal home page as it stood
 * on the 16th: the hero (the floor against the contracted headcount, the
 * coverage curve across the day), the four KPI tiles (fill rate, the
 * reliability grade, hours delivered, tomorrow), today by shift as one
 * line per wave (the roster stays on the Today page), the Alto lead, last night's checklist work, the
 * week's fill, the five-week reliability trend, crew clearance, safety,
 * statements, and open requests. Every figure is computed "as of" that
 * day from the same instruments the live page uses (portalMetrics), so
 * the PDF is the screen, frozen — and a range gives one snapshot per day
 * behind a period page.
 */

export const REPORT_MAX_DAYS = 31;

export type ReportState = 'open' | 'on-floor' | 'worked' | 'missed' | 'not-in' | 'confirmed' | 'unconfirmed';
export type WaveName = 'Morning' | 'Midday' | 'Evening' | 'Overnight';
type Grade = 'A' | 'B' | 'C' | 'D' | 'F' | null;

export interface ReportPerson {
  name: string | null;
  initials: string;
  position: string;
  isLead: boolean;
  locationName: string | null;
  state: ReportState;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  timezone: string;
}

export interface ReportWave {
  name: WaveName;
  timeRange: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  phase: 'upcoming' | 'live' | 'finished';
  expected: number;
  present: number;
  onFloor: number;
  missed: number;
  open: number;
  groups: Array<{ key: 'in' | 'worked' | 'missing' | 'upcoming' | 'open'; label: string; people: ReportPerson[] }>;
}

export interface OpsDaySnapshot {
  dateKey: string;
  shifts: number;
  open: number;
  sopDone: number;
  sopTotal: number;
  taskDone: number;
  taskTotal: number;
  tempAlerts: number;
  incomplete: number;
  photos: number;
  notes: Array<{ department: string; period: string; summary: string }>;
}

/** The home page's cards, computed as of the day. */
export interface DashboardSnapshot {
  asOf: Date;
  live: boolean;
  /** The hero's live figure — only on a live (today) snapshot. */
  onFloorNow: number | null;
  targetNow: number | null;
  targetLabel: string | null;
  kpis: {
    fill: { pct: number | null; filled: number; total: number; deltaPts: number | null };
    grade: { grade: Grade; score: number | null; basis: 'contract' | 'schedule' | null; ncns: number; replaced: number; hasHistory: boolean };
    hours: { worked: number; scheduled: number };
    tomorrow: { date: string; confirmed: number; unconfirmed: number; open: number };
  };
  week: { start: string; end: string; days: Array<{ date: string; filled: number; open: number }> };
  reliability: {
    weeks: Array<{ start: string; reliabilityPct: number | null; current: boolean }>;
    thisWeek: { ncns: number; callOuts: number; lates: number; replaced: number };
  };
  leads: Array<{ name: string; title: 'supervisor' | 'floor-lead'; phone: string | null; email: string; onSite: boolean }>;
  ops: { lastNight: OpsDaySnapshot | null; today: OpsDaySnapshot | null } | null;
  clearance: { total: number; i9Complete: number; checksInFlight: number; flagged: number };
  safety: { monthIncidents: number; open: number; daysSinceLast: number | null };
  statements: Array<{ number: number | null; periodStart: string; periodEnd: string; amount: number | null; hours: number | null; paid: boolean; storeShare: boolean }>;
  requests: { open: Array<{ kind: string; subject: string; status: string; at: string; overdue: boolean }>; loggedToday: number };
}

export interface ReportDay {
  key: string;
  label: string;
  isToday: boolean;
  isFuture: boolean;
  summary: { expected: number; showed: number; onFloor: number; missed: number; open: number };
  contract: { contractedHours: number; deliveredHours: number; score: number | null; grade: Grade; basis: 'contract' | 'schedule' | null };
  hours: Array<{ label: string; scheduled: number; delivered: number | null; target: number | null }>;
  waves: ReportWave[];
  multiStore: boolean;
  dashboard: DashboardSnapshot;
}

export interface PortalReportData {
  orgName: string;
  clientName: string;
  storeName: string | null;
  from: string;
  to: string;
  isRange: boolean;
  generatedAt: string;
  days: ReportDay[];
  totals: {
    expected: number;
    showed: number;
    missed: number;
    open: number;
    contractedHours: number;
    deliveredHours: number;
    score: number | null;
    grade: Grade;
  };
}

/* ---- naming ------------------------------------------------------------ */

export function waveName(startsAt: Date, timezone: string): WaveName {
  const h = Math.floor(zonedMinutes(startsAt, timezone) / 60);
  if (h >= 4 && h < 11) return 'Morning';
  if (h >= 11 && h < 16) return 'Midday';
  if (h >= 16 && h < 21) return 'Evening';
  return 'Overnight';
}

export function dayLabel(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function shortDay(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function monthDay(key: string): string {
  return new Date(`${key}T12:00:00.000Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h < 12) return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function initialsOf(name: string | null): string {
  if (!name) return '·';
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * The built-in PDF fonts only carry WinAnsi glyphs. Names from Turkish,
 * Kazakh, Vietnamese … rosters would otherwise print as garbage, so
 * strip accents the font lacks, map the common bare letters, and swap
 * anything still outside Latin-1 for a question mark.
 */
const BARE: Record<string, string> = { ı: 'i', İ: 'I', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ħ: 'h', ŧ: 't', ŋ: 'n', ĸ: 'k' };
export function pdfSafe(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ıİłŁđĐħŧŋĸ]/g, (c) => BARE[c] ?? c)
    .replace(/[^\u0000-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u00b7]/g, '?');
}

const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hrs = (v: number) => `${Math.round(v * 10) / 10}h`;

/** The scope for a client-wide or store account, loaded off the ids. */
export async function portalScopeFor(clientId: string, locationId: string | null): Promise<PortalScope | null> {
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, name: true } });
  if (!client) return null;
  const location = locationId
    ? await prisma.location.findFirst({
        where: { id: locationId, clientId, deletedAt: null },
        select: { id: true, name: true, timezone: true, addressLine1: true, addressLine2: true, city: true, state: true, zip: true },
      })
    : null;
  if (locationId && !location) return null;
  return { clientId: client.id, locationId: location?.id ?? null, client, location };
}

/* ---- build ------------------------------------------------------------- */

export async function buildPortalReport(
  scope: PortalScope,
  fromKey: string,
  toKey: string,
  orgName: string,
  now: Date = new Date(),
): Promise<PortalReportData> {
  const from = utcInstantOfLocalMidnight(fromKey, ORG_TZ);
  const toExclusive = utcInstantOfLocalMidnight(nextKey(toKey, 1), ORG_TZ);
  const todayKey = orgDateKey(now);
  const nowMs = now.getTime();
  // Everything the dashboard reads for any day in the range, fetched
  // once: the 4 completed weeks before the first day's week (the grade
  // and the fill delta), through the end of the last day's week and
  // the day after (tomorrow's tile).
  const trendStart = new Date(startOfWeekUTC(from).getTime() - 4 * 7 * DAY);
  const lastWeekEnd = new Date(startOfWeekUTC(new Date(toExclusive.getTime() - 1)).getTime() + 7 * DAY);
  const spanEnd = new Date(Math.max(lastWeekEnd.getTime(), toExclusive.getTime() + DAY));
  const dayKeys: string[] = [];
  for (let k = fromKey; k <= toKey; k = nextKey(k, 1)) dayKeys.push(k);
  const opsKeys = [nextKey(fromKey, -1), ...dayKeys];

  const [rows, leadPositions, punches, targets, requests, leadUsers, opsShifts, incidents, statements] = await Promise.all([
    prisma.shift.findMany({
      where: { ...shiftScope(scope), startsAt: { lt: spanEnd }, endsAt: { gt: trendStart } },
      select: {
        id: true,
        position: true,
        startsAt: true,
        endsAt: true,
        status: true,
        acknowledgedAt: true,
        locationId: true,
        assignedAssociateId: true,
        assignedAssociate: { select: { firstName: true, lastName: true } },
        locationRel: { select: { name: true, timezone: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 20000,
    }),
    prisma.shiftPosition.findMany({ where: { clientId: scope.clientId, isLead: true, deletedAt: null }, select: { name: true }, take: 50 }),
    loadPunches(scope, trendStart, spanEnd, now),
    loadTargets(scope, toExclusive < now ? toExclusive : now),
    prisma.clientRequest.findMany({
      where: { clientId: scope.clientId, createdAt: { lt: toExclusive }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] },
      select: { kind: true, subject: true, status: true, createdAt: true, dueAt: true, resolvedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.user.findMany({
      where: { clientId: scope.clientId, status: 'ACTIVE', deletedAt: null, role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] } },
      select: { id: true, email: true, role: true, associateId: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      take: 6,
    }),
    prisma.opsShift.findMany({
      where: { clientId: scope.clientId, dateKey: { in: opsKeys } },
      select: {
        dateKey: true,
        department: true,
        period: true,
        status: true,
        sopDone: true,
        sopTotal: true,
        taskDone: true,
        taskTotal: true,
        tempAlerts: true,
        closedIncomplete: true,
        closingSummary: true,
        _count: { select: { tasks: { where: { photos: { some: {} } } } } },
      },
      orderBy: { openedAt: 'desc' },
      take: 400,
    }),
    prisma.oshaIncident.findMany({
      where: { clientId: scope.clientId, occurredAt: { gte: new Date(from.getTime() - 366 * DAY), lt: toExclusive } },
      select: { occurredAt: true, status: true, resolvedAt: true },
      take: 2000,
    }),
    prisma.clientStatement.findMany({
      where: { clientId: scope.clientId, status: 'FINAL', finalizedAt: { lt: toExclusive } },
      orderBy: { periodEnd: 'desc' },
      select: { number: true, periodStart: true, periodEnd: true, finalizedAt: true, paidAt: true, snapshot: true },
      take: 60,
    }),
  ]);
  const shiftIds = rows.map((s) => s.id);
  const crewAll = [...new Set(rows.map((s) => s.assignedAssociateId).filter((x): x is string => !!x))];
  const [events, claims, weekEntries, bg, dt, i9] = await Promise.all([
    rows.length === 0
      ? Promise.resolve([] as Array<{ kind: string; occurredOn: Date; shiftId: string | null }>)
      : prisma.attendanceEvent.findMany({
          where: { ...attendanceWhere(scope, trendStart, shiftIds), occurredOn: { lt: spanEnd } },
          select: { kind: true, occurredOn: true, shiftId: true },
          take: 10000,
        }),
    prisma.openShiftClaim.findMany({
      where: {
        status: 'APPROVED',
        decidedAt: { gte: trendStart, lt: spanEnd },
        shift: { clientId: scope.clientId, ...(scope.locationId ? { locationId: scope.locationId } : {}) },
      },
      select: { decidedAt: true },
      take: 5000,
    }),
    prisma.timeEntry.findMany({
      where: { ...entryScope(scope), status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] }, clockInAt: { gte: startOfWeekUTC(from), lt: spanEnd } },
      select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
      take: 20000,
    }),
    prisma.backgroundCheck.findMany({ where: { associateId: { in: crewAll } }, orderBy: { initiatedAt: 'desc' }, select: { associateId: true, status: true }, take: 5000 }),
    prisma.drugTest.findMany({ where: { associateId: { in: crewAll } }, orderBy: { initiatedAt: 'desc' }, select: { associateId: true, status: true }, take: 5000 }),
    prisma.i9Verification.findMany({ where: { associateId: { in: crewAll }, section2CompletedAt: { not: null } }, select: { associateId: true }, take: 5000 }),
  ]);
  const ncns = new Set(events.filter((e) => e.kind === 'NO_CALL_NO_SHOW' && e.shiftId).map((e) => e.shiftId));
  const leadNames = new Set(leadPositions.map((p) => p.name));
  const allHours = coverageByHours({ locations: targets, storeScoped: !!scope.locationId, from: trendStart, to: spanEnd, now, shifts: rows, entries: punches.entries });
  const latestStatus = (list: Array<{ associateId: string; status: string }>) => {
    const m = new Map<string, string>();
    for (const r of list) if (!m.has(r.associateId)) m.set(r.associateId, r.status);
    return m;
  };
  const bgLatest = latestStatus(bg);
  const dtLatest = latestStatus(dt);
  const i9Done = new Set(i9.map((r) => r.associateId));

  const inRange = rows.filter((s) => s.startsAt < toExclusive && s.endsAt > from);

  const weekKeyOf = (d: Date) => orgDateKey(startOfWeekUTC(d));
  const opsDay = (key: string): OpsDaySnapshot | null => {
    const list = opsShifts.filter((o) => o.dateKey === key);
    if (list.length === 0) return null;
    const sum = (f: (o: (typeof list)[number]) => number) => list.reduce((a, o) => a + f(o), 0);
    return {
      dateKey: key,
      shifts: list.length,
      open: list.filter((o) => o.status === 'ACTIVE').length,
      sopDone: sum((o) => o.sopDone),
      sopTotal: sum((o) => o.sopTotal),
      taskDone: sum((o) => o.taskDone),
      taskTotal: sum((o) => o.taskTotal),
      tempAlerts: sum((o) => o.tempAlerts),
      incomplete: list.filter((o) => o.closedIncomplete).length,
      photos: sum((o) => o._count.tasks),
      notes: list
        .filter((o) => o.closingSummary)
        .slice(0, 3)
        .map((o) => ({ department: o.department, period: o.period, summary: o.closingSummary! })),
    };
  };

  const days: ReportDay[] = [];
  for (const key of dayKeys) {
    const dayStart = utcInstantOfLocalMidnight(key, ORG_TZ);
    const dayEnd = utcInstantOfLocalMidnight(nextKey(key, 1), ORG_TZ);
    const isToday = key === todayKey;
    const isFuture = key > todayKey;
    // The snapshot instant: the live page for today, the close of the
    // day for the past, "now" for a day that has not started.
    const asOf = isToday || isFuture ? now : dayEnd;
    const asOfMs = asOf.getTime();
    const dayShifts = rows.filter((s) => s.startsAt < dayEnd && s.endsAt > dayStart);
    const coverage = allHours.filter((h) => h.instant >= dayStart && h.instant < dayEnd && h.instant.getTime() + HOUR <= asOfMs);
    const coverageAt = new Map(coverage.map((h) => [h.instant.getTime(), h]));
    const hours = Array.from({ length: 24 }, (_, h) => {
      const at = new Date(dayStart.getTime() + h * HOUR);
      const covering = dayShifts.filter((s) => s.startsAt.getTime() <= at.getTime() && s.endsAt.getTime() > at.getTime());
      let target: number | null = null;
      for (const loc of targets) {
        const t = targetAtMinute(loc, zonedMinutes(at, loc.timezone));
        if (t) target = (target ?? 0) + t.target;
      }
      const cov = coverageAt.get(at.getTime());
      return {
        label: hourLabel(h),
        scheduled: covering.filter((s) => s.status !== 'OPEN').length,
        delivered: at.getTime() + HOUR <= asOfMs ? (cov?.delivered ?? 0) : null,
        target,
      };
    });

    // Each shift's state — the same rules as the live Day page, as of the snapshot.
    const people = dayShifts.map((s) => {
      const punch = s.status === 'OPEN' ? null : punches.punchFor(s);
      const ended = s.endsAt.getTime() <= asOfMs;
      const started = s.startsAt.getTime() <= asOfMs;
      let state: ReportState;
      if (s.status === 'OPEN') state = 'open';
      else if (ncns.has(s.id)) state = 'missed';
      else if (punch && punch.clockOutAt === null && !ended) state = 'on-floor';
      else if (punch) state = 'worked';
      else if (ended) state = 'missed';
      else if (started) state = 'not-in';
      else state = s.acknowledgedAt ? 'confirmed' : 'unconfirmed';
      const name = s.assignedAssociate ? fullName(s.assignedAssociate) : null;
      const tz = s.locationRel?.timezone ?? ORG_TZ;
      return {
        shift: s,
        person: {
          name,
          initials: initialsOf(name),
          position: s.position,
          isLead: leadNames.has(s.position),
          locationName: s.locationRel?.name ?? null,
          state,
          clockInAt: punch && state !== 'missed' ? punch.clockInAt : null,
          clockOutAt: punch && state === 'worked' ? punch.clockOutAt : null,
          timezone: tz,
        } satisfies ReportPerson,
      };
    });

    // Waves: every shift sharing the same start and end instant.
    type Bucketed = ReportWave & { buckets: Record<ReportWave['groups'][number]['key'], ReportPerson[]> };
    const byKey = new Map<string, Bucketed>();
    for (const { shift: s, person } of people) {
      const k = `${s.startsAt.toISOString()}|${s.endsAt.toISOString()}`;
      const tz = person.timezone;
      let w = byKey.get(k);
      if (!w) {
        w = {
          name: waveName(s.startsAt, tz),
          timeRange: `${formatTimeInZone(s.startsAt, tz)} – ${formatTimeInZone(s.endsAt, tz)}`,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          timezone: tz,
          phase: asOfMs < s.startsAt.getTime() ? 'upcoming' : asOfMs >= s.endsAt.getTime() ? 'finished' : 'live',
          expected: 0,
          present: 0,
          onFloor: 0,
          missed: 0,
          open: 0,
          groups: [],
          buckets: { in: [], worked: [], missing: [], upcoming: [], open: [] },
        };
        byKey.set(k, w);
      }
      switch (person.state) {
        case 'open':
          w.open += 1;
          w.buckets.open.push(person);
          break;
        case 'on-floor':
          w.expected += 1;
          w.present += 1;
          w.onFloor += 1;
          w.buckets.in.push(person);
          break;
        case 'worked':
          w.expected += 1;
          w.present += 1;
          w.buckets.worked.push(person);
          break;
        case 'missed':
          w.expected += 1;
          w.missed += 1;
          w.buckets.missing.push(person);
          break;
        case 'not-in':
          w.expected += 1;
          w.buckets.missing.push(person);
          break;
        default:
          w.expected += 1;
          w.buckets.upcoming.push(person);
      }
    }
    const byName = (a: ReportPerson, b: ReportPerson) => (a.name ?? '').localeCompare(b.name ?? '');
    const byPunch = (a: ReportPerson, b: ReportPerson) => (a.clockInAt?.getTime() ?? 0) - (b.clockInAt?.getTime() ?? 0) || byName(a, b);
    const waves: ReportWave[] = [...byKey.values()]
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((w) => {
        const { buckets, ...rest } = w;
        const groups: ReportWave['groups'] = [];
        if (buckets.in.length) groups.push({ key: 'in', label: 'On the floor', people: buckets.in.sort(byPunch) });
        if (buckets.worked.length) groups.push({ key: 'worked', label: 'Worked', people: buckets.worked.sort(byPunch) });
        if (buckets.missing.length) groups.push({ key: 'missing', label: w.phase === 'finished' ? 'Did not punch in' : 'Not in yet', people: buckets.missing.sort(byName) });
        if (buckets.upcoming.length) groups.push({ key: 'upcoming', label: 'Expected', people: buckets.upcoming.sort(byName) });
        if (buckets.open.length) groups.push({ key: 'open', label: 'Unfilled', people: buckets.open });
        return { ...rest, groups };
      });

    const states = people.map((p) => p.person.state);
    const ended = dayShifts.filter((s) => s.status !== 'OPEN' && s.endsAt.getTime() <= asOfMs);
    const showedEnded = ended.filter((s) => !ncns.has(s.id) && punches.punched(s)).length;
    const contractedHours = coverage.reduce((a, h) => a + h.target, 0);
    const deliveredHours = coverage.reduce((a, h) => a + h.delivered, 0);
    const graded = gradeWeeks([{ contracted: contractedHours, delivered: deliveredHours, ended: ended.length, showed: showedEnded }]);

    /* ---- the dashboard cards, as of the day ------------------------------ */
    const weekStartD = startOfWeekUTC(dayStart);
    const weekKeyD = orgDateKey(weekStartD);
    const weekEndD = new Date(weekStartD.getTime() + 7 * DAY);
    const weekKeys: string[] = [];
    for (let i = 4; i >= 0; i--) weekKeys.push(orgDateKey(new Date(weekStartD.getTime() - i * 7 * DAY)));
    const prevWeekKey = orgDateKey(new Date(weekStartD.getTime() - 7 * DAY));
    const agg = new Map(
      weekKeys.map((k) => [k, { start: k, filled: 0, total: 0, ended: 0, showed: 0, contracted: 0, delivered: 0, ncns: 0, callOuts: 0, lates: 0, replaced: 0 }]),
    );
    const cutoff = Math.min(asOfMs, weekEndD.getTime());
    for (const s of rows) {
      const w = agg.get(weekKeyOf(s.startsAt));
      if (!w) continue;
      w.total += 1;
      if (s.status !== 'OPEN') w.filled += 1;
      if (s.endsAt.getTime() <= asOfMs) {
        w.ended += 1;
        if (s.status !== 'OPEN' && !ncns.has(s.id) && punches.punched(s)) w.showed += 1;
      }
    }
    for (const e of events) {
      if (e.occurredOn.getTime() >= cutoff) continue;
      const w = agg.get(weekKeyOf(e.occurredOn));
      if (!w) continue;
      if (e.kind === 'NO_CALL_NO_SHOW') w.ncns += 1;
      else if (e.kind === 'CALL_OUT') w.callOuts += 1;
      else if (e.kind === 'LATE') w.lates += 1;
    }
    for (const c of claims) {
      if (!c.decidedAt || c.decidedAt.getTime() >= cutoff) continue;
      const w = agg.get(weekKeyOf(c.decidedAt));
      if (w) w.replaced += 1;
    }
    for (const h of allHours) {
      if (h.instant.getTime() + HOUR > asOfMs) continue;
      const w = agg.get(weekKeyOf(h.instant));
      if (!w) continue;
      w.contracted += h.target;
      w.delivered += h.delivered;
    }
    const relWeeks = weekKeys.map((k) => {
      const w = agg.get(k)!;
      return {
        start: k,
        reliabilityPct: w.contracted > 0 ? Math.round((w.delivered / w.contracted) * 100) : w.ended > 0 ? Math.round((w.showed / w.ended) * 100) : null,
        current: k === weekKeyD,
      };
    });
    const completed = weekKeys.filter((k) => k !== weekKeyD).map((k) => agg.get(k)!);
    const hasHistory = completed.some((w) => w.total > 0);
    const weekGrade = gradeWeeks(hasHistory ? completed : [...agg.values()]);
    const thisW = agg.get(weekKeyD)!;
    const prevW = agg.get(prevWeekKey);
    const fillPct = thisW.total > 0 ? Math.round((thisW.filled / thisW.total) * 100) : null;
    const prevPct = prevW && prevW.total > 0 ? Math.round((prevW.filled / prevW.total) * 100) : null;
    const weekShifts = rows.filter((s) => s.startsAt >= weekStartD && s.startsAt < weekEndD);
    const weekDays = Array.from({ length: 7 }, (_, i) => nextKey(weekKeyD, i)).map((d) => ({
      date: d,
      filled: weekShifts.filter((s) => orgDateKey(s.startsAt) === d && s.status !== 'OPEN').length,
      open: weekShifts.filter((s) => orgDateKey(s.startsAt) === d && s.status === 'OPEN').length,
    }));
    const scheduledMin = weekShifts.reduce((a, s) => a + paidMinutesForRange(s.startsAt, s.endsAt), 0);
    const workedMin = weekEntries
      .filter((e) => e.clockInAt >= weekStartD && e.clockInAt < weekEndD && e.clockInAt.getTime() < asOfMs)
      .reduce((a, e) => a + netMinutes({ ...e, clockOutAt: e.clockOutAt && e.clockOutAt.getTime() <= asOfMs ? e.clockOutAt : null }, asOf), 0);
    const tomorrowKey = nextKey(key, 1);
    const tomorrowShifts = rows.filter((s) => orgDateKey(s.startsAt) === tomorrowKey);
    const crewIds = [...new Set(weekShifts.map((s) => s.assignedAssociateId).filter((x): x is string => !!x))];
    const inFlight = new Set(['INITIATED', 'IN_PROGRESS']);
    const bad = new Set(['FAILED', 'NEEDS_REVIEW']);
    let i9Complete = 0;
    let checksInFlight = 0;
    let flagged = 0;
    for (const id of crewIds) {
      if (i9Done.has(id)) i9Complete += 1;
      const st = [bgLatest.get(id), dtLatest.get(id)].filter((x): x is string => !!x);
      if (st.some((x) => bad.has(x))) flagged += 1;
      else if (st.some((x) => inFlight.has(x))) checksInFlight += 1;
    }
    const monthStart = utcInstantOfLocalMidnight(`${key.slice(0, 7)}-01`, ORG_TZ);
    const lastIncident = incidents
      .filter((i) => i.occurredAt.getTime() < asOfMs && i.occurredAt.getTime() >= asOfMs - 365 * DAY)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
    const onSiteAt = (associateId: string) =>
      punches.entries.some((e) => e.associateId === associateId && e.clockInAt.getTime() < Math.min(asOfMs, dayEnd.getTime()) && (e.clockOutAt ?? now).getTime() > dayStart.getTime());
    const opsSnapshot = opsShifts.some((o) => o.dateKey === key || o.dateKey === nextKey(key, -1)) ? { lastNight: opsDay(nextKey(key, -1)), today: opsDay(key) } : null;
    const liveOnFloor = isToday
      ? new Set(punches.entries.filter((e) => e.clockInAt.getTime() <= nowMs && (e.clockOutAt === null || e.clockOutAt.getTime() > nowMs)).map((e) => e.associateId)).size
      : null;
    let targetNow: number | null = null;
    let targetLabel: string | null = null;
    if (isToday) {
      const labels = new Set<string>();
      for (const loc of targets) {
        const t = targetAtMinute(loc, zonedMinutes(now, loc.timezone));
        if (!t) continue;
        targetNow = (targetNow ?? 0) + t.target;
        for (const l of t.labels) labels.add(l);
      }
      targetLabel = labels.size > 0 ? [...labels].join(' + ') : null;
    }

    const dashboard: DashboardSnapshot = {
      asOf,
      live: isToday,
      onFloorNow: liveOnFloor,
      targetNow,
      targetLabel,
      kpis: {
        fill: { pct: fillPct, filled: thisW.filled, total: thisW.total, deltaPts: fillPct !== null && prevPct !== null ? fillPct - prevPct : null },
        grade: {
          grade: weekGrade.grade,
          score: weekGrade.score,
          basis: weekGrade.basis,
          ncns: completed.reduce((a, w) => a + w.ncns, 0),
          replaced: completed.reduce((a, w) => a + w.replaced, 0),
          hasHistory,
        },
        hours: { worked: Math.round((workedMin / 60) * 10) / 10, scheduled: Math.round((scheduledMin / 60) * 10) / 10 },
        tomorrow: {
          date: tomorrowKey,
          confirmed: tomorrowShifts.filter((s) => s.status === 'ASSIGNED' && s.acknowledgedAt !== null && s.acknowledgedAt.getTime() <= asOfMs).length,
          unconfirmed: tomorrowShifts.filter((s) => s.status === 'ASSIGNED' && (s.acknowledgedAt === null || s.acknowledgedAt.getTime() > asOfMs)).length,
          open: tomorrowShifts.filter((s) => s.status === 'OPEN').length,
        },
      },
      week: { start: weekKeyD, end: nextKey(weekKeyD, 6), days: weekDays },
      reliability: { weeks: relWeeks, thisWeek: { ncns: thisW.ncns, callOuts: thisW.callOuts, lates: thisW.lates, replaced: thisW.replaced } },
      leads: leadUsers.map((u) => ({
        name: u.associate ? fullName(u.associate) : (u.email.split('@')[0] ?? u.email),
        title: u.role === 'SHIFT_SUPERVISOR' ? ('supervisor' as const) : ('floor-lead' as const),
        phone: u.associate?.phone ?? null,
        email: u.email,
        onSite: !!u.associateId && onSiteAt(u.associateId),
      })),
      ops: opsSnapshot,
      clearance: { total: crewIds.length, i9Complete, checksInFlight, flagged },
      safety: {
        monthIncidents: incidents.filter((i) => i.occurredAt >= monthStart && i.occurredAt.getTime() < asOfMs).length,
        open: incidents.filter((i) => i.occurredAt.getTime() < asOfMs && (i.status !== 'RESOLVED' || (i.resolvedAt !== null && i.resolvedAt.getTime() > asOfMs))).length,
        daysSinceLast: lastIncident ? Math.floor((asOfMs - lastIncident.occurredAt.getTime()) / DAY) : null,
      },
      statements: statements
        .filter((st) => st.finalizedAt !== null && st.finalizedAt.getTime() <= asOfMs)
        .slice(0, 4)
        .map((st) => {
          const snap = st.snapshot as { totals?: { amount?: number; hours?: number }; stores?: Array<{ locationName: string; hours: number; amount: number }> } | null;
          const line = scope.location ? ((snap?.stores ?? []).find((x) => x.locationName === scope.location!.name) ?? null) : null;
          return {
            number: st.number,
            periodStart: st.periodStart.toISOString().slice(0, 10),
            periodEnd: st.periodEnd.toISOString().slice(0, 10),
            amount: line ? line.amount : (snap?.totals?.amount ?? null),
            hours: line ? line.hours : (snap?.totals?.hours ?? null),
            paid: st.paidAt !== null && st.paidAt.getTime() <= asOfMs,
            storeShare: !!line,
          };
        }),
      requests: {
        open: requests
          .filter((r) => r.createdAt.getTime() < asOfMs && (r.resolvedAt === null || r.resolvedAt.getTime() > asOfMs))
          .slice(0, 8)
          .map((r) => ({
            kind: r.kind,
            subject: r.subject,
            status: r.status === 'RESOLVED' ? 'IN_PROGRESS' : r.status,
            at: orgDateKey(r.createdAt),
            overdue: !!r.dueAt && r.dueAt.getTime() < asOfMs,
          })),
        loggedToday: requests.filter((r) => r.createdAt >= dayStart && r.createdAt.getTime() < Math.min(asOfMs, dayEnd.getTime())).length,
      },
    };

    days.push({
      key,
      label: dayLabel(key),
      isToday,
      isFuture,
      summary: {
        expected: states.filter((s) => s !== 'open').length,
        showed: states.filter((s) => s === 'worked' || s === 'on-floor').length,
        onFloor: states.filter((s) => s === 'on-floor').length,
        missed: states.filter((s) => s === 'missed').length,
        open: states.filter((s) => s === 'open').length,
      },
      contract: { contractedHours, deliveredHours, score: graded.score, grade: graded.grade, basis: graded.basis },
      hours,
      waves,
      multiStore: new Set(people.map((p) => p.person.locationName ?? '')).size > 1,
      dashboard,
    });
  }

  const sum = (f: (d: ReportDay) => number) => days.reduce((a, d) => a + f(d), 0);
  const endedAll = inRange.filter((s) => s.status !== 'OPEN' && s.endsAt.getTime() <= nowMs);
  const rangeGrade = gradeWeeks([
    {
      contracted: sum((d) => d.contract.contractedHours),
      delivered: sum((d) => d.contract.deliveredHours),
      ended: endedAll.length,
      showed: endedAll.filter((s) => !ncns.has(s.id) && punches.punched(s)).length,
    },
  ]);

  return {
    orgName,
    clientName: scope.client.name,
    storeName: scope.location?.name ?? null,
    from: fromKey,
    to: toKey,
    isRange: fromKey !== toKey,
    generatedAt: `${orgDateKey(now)} ${formatTimeInZone(now, ORG_TZ)}`,
    days,
    totals: {
      expected: sum((d) => d.summary.expected),
      showed: sum((d) => d.summary.showed),
      missed: sum((d) => d.summary.missed),
      open: sum((d) => d.summary.open),
      contractedHours: sum((d) => d.contract.contractedHours),
      deliveredHours: sum((d) => d.contract.deliveredHours),
      score: rangeGrade.score,
      grade: rangeGrade.grade,
    },
  };
}

/* ---- render ------------------------------------------------------------ */

const NAVY = '#0B1832';
const NAVY_SOFT = '#22355C';
const GOLD = '#C9A227';
const GREY = '#5B6472';
const LIGHT = '#9AA3B2';
const PANEL = '#F3F5F9';
const TRACK = '#E1E5EC';
const GOOD = '#1A7F4B';
const WARN = '#B45309';
const BAD = '#B42318';
const SCHEDULED = '#C9D2E3';
const BLUE = '#2563EB';

type TextOpts = { color?: string; bold?: boolean; size?: number; width?: number; align?: 'left' | 'center' | 'right'; ellipsis?: boolean; characterSpacing?: number; lineBreak?: boolean; height?: number };

export function renderPortalReportPdf(data: PortalReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const where = data.storeName ?? data.clientName;
    const period = data.isRange ? `${data.from} — ${data.to}` : data.from;
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 48,
      bufferPages: true,
      info: { Title: `Service Report — ${where} — ${period}`, Author: data.orgName },
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
      if (doc.y + needed > bottom()) {
        doc.addPage();
        doc.y = 54;
      }
    };
    const gradeTone = (g: Grade) => (g === 'A' || g === 'B' ? GOOD : g === 'F' ? BAD : NAVY);
    const small = (text: string, x: number, y: number, opts: TextOpts = {}) => {
      const { color, bold, size, ...rest } = opts;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size ?? 8).fillColor(color ?? GREY);
      let t = pdfSafe(text);
      // pdfkit wraps whenever a width is given, even with lineBreak:false —
      // so a one-line field is trimmed by measurement, never by hope.
      if (rest.width && rest.ellipsis && !rest.lineBreak) t = fitLine(t, rest.width);
      doc.text(t, x, y, { lineBreak: false, ...rest });
    };
    const fitLine = (t: string, w: number): string => {
      if (doc.widthOfString(t) <= w) return t;
      let lo = 0;
      let hi = t.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (doc.widthOfString(t.slice(0, mid).trimEnd() + '…') <= w) lo = mid;
        else hi = mid - 1;
      }
      return lo <= 0 ? '…' : t.slice(0, lo).trimEnd() + '…';
    };

    /* ---- letterhead ----------------------------------------------------- */
    doc.rect(0, 0, doc.page.width, 118).fill(NAVY);
    doc.rect(0, 118, doc.page.width, 3).fill(GOLD);
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#FFFFFF').text(pdfSafe(data.orgName), left, 34);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(GOLD)
      .text(data.isRange ? 'SERVICE REPORT · YOUR DASHBOARD, DAY BY DAY' : 'SERVICE REPORT · YOUR DASHBOARD, AS IT STOOD', left, 60, { characterSpacing: 2 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFFFFF').text(pdfSafe(where), left, 34, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#C7CEDC')
      .text(data.isRange ? `${monthDay(data.from)} – ${monthDay(data.to)}, ${data.to.slice(0, 4)}` : dayLabel(data.from), left, 56, { width, align: 'right' })
      .text(`Prepared ${data.generatedAt}`, left, 70, { width, align: 'right' });
    const single = data.days.length === 1 ? data.days[0]! : null;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#8E99AD')
      .text(
        single?.isToday
          ? 'Your store site, exactly as it reads right now — every card of the dashboard, frozen at the time above.'
          : single
            ? 'Your store site as it stood at the close of that day — every card of the dashboard, computed as of then.'
            : 'Your store site as it stood at the close of each day in the period — the dashboard, one snapshot per day, behind a period summary.',
        left,
        90,
        { width: width * 0.78 },
      );
    doc.y = 140;

    /* ---- helpers ------------------------------------------------------- */
    const section = (title: string, sub?: string) => {
      // A heading never sits alone at the foot of a page: keep it with at
      // least the first row of whatever follows.
      ensure(sub ? 150 : 138);
      const y = doc.y + 8;
      doc.rect(left, y + 1, 4, 11).fill(GOLD);
      doc.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(title, left + 10, y, { lineBreak: false });
      doc
        .moveTo(left, y + 18)
        .lineTo(right, y + 18)
        .lineWidth(0.5)
        .strokeColor(TRACK)
        .stroke();
      doc.y = y + 24;
      if (sub) {
        doc.font('Helvetica').fontSize(8).fillColor(LIGHT).text(sub, left, doc.y, { width });
        doc.y += 6;
      }
    };
    const cardTitle = (title: string, x: number, y: number, w: number, rightText?: string) => {
      small(title, x, y, { bold: true, color: NAVY, size: 9.5, width: w });
      if (rightText) small(rightText, x, y + 1, { color: LIGHT, size: 7.5, width: w, align: 'right' });
    };

    /** The coverage curve: scheduled (grey), on the floor (green), the contracted line (gold). */
    const hourChart = (d: ReportDay, plotX: number, y0: number, plotW: number, h: number) => {
      const slot = plotW / 24;
      const maxV = Math.max(1, ...d.hours.map((r) => Math.max(r.scheduled, r.target ?? 0, r.delivered ?? 0)));
      const yFor = (v: number) => y0 + h - (v / maxV) * h;
      for (const g of [0, maxV]) {
        const gy = yFor(g);
        doc.moveTo(plotX, gy).lineTo(plotX + plotW, gy).lineWidth(0.4).strokeColor(TRACK).stroke();
        small(String(g), plotX - 16, gy - 4, { color: LIGHT, size: 6.5, width: 13, align: 'right' });
      }
      d.hours.forEach((r, i) => {
        const x = plotX + i * slot;
        if (r.scheduled > 0) doc.rect(x + 1, yFor(r.scheduled), slot - 2, y0 + h - yFor(r.scheduled)).fill(SCHEDULED);
        if (r.delivered !== null && r.delivered > 0) {
          const bw = Math.max(2, (slot - 2) * 0.55);
          doc.rect(x + 1 + (slot - 2 - bw) / 2, yFor(r.delivered), bw, y0 + h - yFor(r.delivered)).fill(GOOD);
        }
      });
      doc.lineWidth(1.2).strokeColor(GOLD);
      let pen = false;
      d.hours.forEach((r, i) => {
        const x = plotX + i * slot;
        if (r.target === null) {
          pen = false;
          return;
        }
        const ty = yFor(r.target);
        if (!pen) {
          doc.moveTo(x, ty);
          pen = true;
        } else doc.lineTo(x, ty);
        doc.lineTo(x + slot, ty);
      });
      if (pen) doc.stroke();
      if (d.isToday) {
        const nx = plotX + (zonedMinutes(new Date(), ORG_TZ) / 60) * slot;
        doc.moveTo(nx, y0).lineTo(nx, y0 + h).lineWidth(0.8).dash(2, { space: 2 }).strokeColor(NAVY_SOFT).stroke().undash();
        small('now', nx + 2, y0 + 2, { color: NAVY_SOFT, size: 6.5 });
      }
      d.hours.forEach((r, i) => {
        if (i % 3 === 0) small(r.label, plotX + i * slot, y0 + h + 3, { color: LIGHT, size: 6.5, width: slot * 3 });
      });
      const ly = y0 + h + 14;
      let lx = plotX;
      const legend = (color: string, label: string, line = false) => {
        if (line) doc.moveTo(lx, ly + 4).lineTo(lx + 10, ly + 4).lineWidth(1.2).strokeColor(color).stroke();
        else doc.rect(lx, ly, 8, 8).fill(color);
        small(label, lx + 13, ly, { color: GREY, size: 6.5 });
        lx += 13 + doc.widthOfString(label) + 12;
      };
      legend(SCHEDULED, 'Scheduled');
      legend(GOOD, 'On the floor');
      legend(GOLD, 'Contracted', true);
    };

    /** The hero: the number on the left, the coverage curve on the right. */
    const hero = (d: ReportDay) => {
      const db = d.dashboard;
      ensure(170);
      const y0 = doc.y;
      const h = 150;
      doc.roundedRect(left, y0, width, h, 8).fill(PANEL);
      doc.rect(left, y0, 4, h).fill(GOLD);
      const lx = left + 16;
      const lw = width * 0.34 - 16;
      if (db.live) {
        small('ON THE FLOOR NOW', lx, y0 + 12, { color: GOLD, size: 7, characterSpacing: 1.2, bold: true });
        const short = db.targetNow !== null && (db.onFloorNow ?? 0) < db.targetNow;
        const big = String(db.onFloorNow ?? 0);
        doc.font('Helvetica-Bold').fontSize(38).fillColor(short ? WARN : NAVY).text(big, lx, y0 + 24, { lineBreak: false });
        if (db.targetNow !== null) {
          const nw = doc.widthOfString(big);
          doc.font('Helvetica-Bold').fontSize(16).fillColor(LIGHT).text(`/ ${db.targetNow}`, lx + nw + 6, y0 + 44, { lineBreak: false });
        }
        small(
          db.targetNow === null
            ? 'No contracted headcount set for this hour.'
            : short
              ? `${db.targetNow - (db.onFloorNow ?? 0)} short of ${db.targetLabel ?? 'the contracted headcount'} right now.`
              : `Staffed to ${db.targetLabel ?? 'the contracted headcount'}.`,
          lx,
          y0 + 74,
          { color: GREY, size: 8.5, width: lw, lineBreak: true, height: 30 },
        );
        small(
          `Day so far: ${d.contract.score === null ? '—' : `${d.contract.score}%`} delivered vs contracted · ${d.summary.showed} of ${d.summary.expected} punched in · ${d.summary.open} unfilled`,
          lx,
          y0 + 112,
          { color: GREY, size: 7.5, width: lw, lineBreak: true, height: 30 },
        );
      } else {
        small(d.isFuture ? 'THE DAY AHEAD' : 'THE DAY, DELIVERED VS CONTRACTED', lx, y0 + 12, { color: GOLD, size: 7, characterSpacing: 1.2, bold: true });
        const c = d.contract;
        const big = c.score === null ? '—' : `${c.score}%`;
        doc.font('Helvetica-Bold').fontSize(38).fillColor(gradeTone(c.grade)).text(big, lx, y0 + 24, { lineBreak: false });
        if (c.grade) {
          const nw = doc.widthOfString(big);
          doc.font('Helvetica-Bold').fontSize(16).fillColor(gradeTone(c.grade)).text(`· ${c.grade}`, lx + nw + 6, y0 + 44, { lineBreak: false });
        }
        small(
          d.isFuture
            ? `${d.summary.expected} expected · ${d.summary.open} unfilled`
            : c.contractedHours > 0
              ? `${c.deliveredHours} of ${c.contractedHours} contracted person-hours were on the floor.`
              : c.basis === 'schedule'
                ? 'No floor target that day — graded on the schedule.'
                : 'No graded hours that day.',
          lx,
          y0 + 74,
          { color: GREY, size: 8.5, width: lw, lineBreak: true, height: 30 },
        );
        if (!d.isFuture) {
          small(`${d.summary.showed} of ${d.summary.expected} punched in · ${d.summary.missed} did not · ${d.summary.open} unfilled`, lx, y0 + 112, {
            color: GREY,
            size: 7.5,
            width: lw,
            lineBreak: true,
            height: 30,
          });
        }
      }
      const cx = left + width * 0.36 + 16;
      const cw = width - width * 0.36 - 28;
      small('COVERAGE ACROSS THE DAY', cx, y0 + 12, { color: LIGHT, size: 6.5, characterSpacing: 0.8 });
      hourChart(d, cx, y0 + 26, cw, 84);
      doc.y = y0 + h + 12;
    };

    const kpiCards = (cards: Array<{ label: string; value: string; tone?: string; sub?: string; meter?: number | null; meterTone?: string; delta?: string; deltaTone?: string }>) => {
      ensure(74);
      const gap = 8;
      const cardW = (width - gap * (cards.length - 1)) / cards.length;
      const cardH = 60;
      const y0 = doc.y;
      cards.forEach((k, i) => {
        const x = left + i * (cardW + gap);
        doc.roundedRect(x, y0, cardW, cardH, 5).fill(PANEL);
        small(k.label, x + 8, y0 + 8, { color: LIGHT, size: 6.5, width: cardW - 16, characterSpacing: 0.4, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(17).fillColor(k.tone ?? NAVY).text(k.value, x + 8, y0 + 19, { width: cardW - 16, lineBreak: false });
        if (k.delta) {
          const vw = doc.widthOfString(k.value);
          small(k.delta, x + 8 + vw + 6, y0 + 27, { color: k.deltaTone ?? GREY, size: 7, width: Math.max(10, cardW - 16 - vw - 6), ellipsis: true });
        }
        if (k.meter !== undefined && k.meter !== null) {
          doc.roundedRect(x + 8, y0 + 40, cardW - 16, 3, 1.5).fill(TRACK);
          const mw = Math.max(2, ((cardW - 16) * Math.min(100, Math.max(0, k.meter))) / 100);
          doc.roundedRect(x + 8, y0 + 40, mw, 3, 1.5).fill(k.meterTone ?? BLUE);
        }
        if (k.sub) small(k.sub, x + 8, y0 + 46, { color: GREY, size: 7, width: cardW - 16, ellipsis: true });
      });
      doc.y = y0 + cardH + 12;
    };

    /** One line per wave, the way the dashboard card reads it, with the meter. */
    const waveLine = (w: ReportWave) => {
      ensure(30);
      const y = doc.y + 4;
      const notIn = Math.max(0, w.expected - w.present);
      const confirmed = w.groups.filter((g) => g.key === 'upcoming').flatMap((g) => g.people).filter((p) => p.state === 'confirmed').length;
      const status =
        w.phase === 'finished'
          ? `${w.present} of ${w.expected} on the floor${w.missed > 0 ? ` · ${w.missed} did not punch in` : ''}${w.open > 0 ? ` · ${w.open} unfilled` : ''}`
          : w.phase === 'live'
            ? `${w.onFloor} of ${w.expected} in${notIn > 0 ? ` · ${notIn} not in yet` : ''}${w.open > 0 ? ` · ${w.open} unfilled` : ''}`
            : `starts ${formatTimeInZone(w.startsAt, w.timezone)} · ${w.expected} expected · ${confirmed} confirmed${w.open > 0 ? ` · ${w.open} unfilled` : ''}`;
      const statusTone =
        w.phase === 'upcoming' ? GREY : w.present + w.onFloor >= w.expected && w.open === 0 ? GOOD : w.missed > 0 || w.open > 0 ? WARN : NAVY;
      small(`${w.name} · ${w.timeRange}`, left, y, { bold: true, color: NAVY, size: 9.5, width: width * 0.42, ellipsis: true });
      small(status, left + width * 0.42, y + 1, { bold: true, color: statusTone, size: 8, width: width * 0.58, align: 'right', ellipsis: true });
      const my = y + 14;
      doc.roundedRect(left, my, width, 4, 2).fill(TRACK);
      const denom = Math.max(1, w.expected + w.open);
      const filled = (width * (w.present + w.onFloor)) / denom;
      if (filled > 0) doc.roundedRect(left, my, Math.max(filled, 3), 4, 2).fill(w.phase === 'upcoming' ? LIGHT : GOOD);
      doc.y = my + 12;
    };

    type Panel = { title: string; right?: string; body: (x: number, y: number, w: number) => number };
    /** Side-by-side panels; each body draws inside (x, y, w) and returns its height. */
    const panels = (items: Panel[], minH: number) => {
      ensure(minH + 16);
      const gap = 10;
      const w = (width - gap * (items.length - 1)) / items.length;
      const y0 = doc.y;
      const hs = items.map((p, i) => {
        const x = left + i * (w + gap);
        cardTitle(p.title, x + 10, y0 + 10, w - 20, p.right);
        return p.body(x + 10, y0 + 26, w - 20);
      });
      const h = Math.max(minH, ...hs.map((v) => v + 36));
      items.forEach((_, i) => doc.roundedRect(left + i * (w + gap), y0, w, h, 6).lineWidth(0.6).strokeColor(TRACK).stroke());
      doc.y = y0 + h + 10;
    };

    const weekBars = (db: DashboardSnapshot, dayKey: string, x: number, y: number, w: number): number => {
      const h = 58;
      const n = db.week.days.length;
      const slot = w / n;
      const maxV = Math.max(1, ...db.week.days.map((d) => d.filled + d.open));
      db.week.days.forEach((d, i) => {
        const cx = x + i * slot + slot * 0.2;
        const bw = slot * 0.6;
        const fh = (h * d.filled) / maxV;
        const oh = (h * d.open) / maxV;
        if (fh > 0) doc.rect(cx, y + h - fh, bw, fh).fill(d.date === dayKey ? NAVY : BLUE);
        if (oh > 0) doc.rect(cx, y + h - fh - oh, bw, oh).fill(WARN);
        small(shortDay(d.date).slice(0, 3), x + i * slot, y + h + 3, { color: d.date === dayKey ? NAVY : LIGHT, size: 6.5, width: slot, align: 'center', bold: d.date === dayKey });
        if (d.filled + d.open > 0) small(String(d.filled + d.open), x + i * slot, y + h - fh - oh - 9, { color: GREY, size: 6.5, width: slot, align: 'center' });
      });
      const ly = y + h + 14;
      doc.rect(x, ly, 8, 8).fill(BLUE);
      small('Filled', x + 12, ly, { color: GREY, size: 6.5 });
      doc.rect(x + 50, ly, 8, 8).fill(WARN);
      small('Unfilled', x + 62, ly, { color: GREY, size: 6.5 });
      return h + 26;
    };

    const reliabilityBars = (db: DashboardSnapshot, x: number, y: number, w: number): number => {
      const h = 58;
      const weeks = db.reliability.weeks;
      const slot = w / weeks.length;
      const yFor = (v: number) => y + h - (h * Math.min(100, v)) / 100;
      doc.moveTo(x, yFor(88)).lineTo(x + w, yFor(88)).lineWidth(0.8).dash(3, { space: 2 }).strokeColor(GOLD).stroke().undash();
      weeks.forEach((wk, i) => {
        const cx = x + i * slot + slot * 0.25;
        const bw = slot * 0.5;
        if (wk.reliabilityPct !== null) {
          const tone = wk.reliabilityPct >= 88 ? GOOD : wk.reliabilityPct >= 70 ? BLUE : BAD;
          doc.rect(cx, yFor(wk.reliabilityPct), bw, y + h - yFor(wk.reliabilityPct)).fill(tone);
          if (wk.current) doc.rect(cx, yFor(wk.reliabilityPct), bw, y + h - yFor(wk.reliabilityPct)).lineWidth(1).strokeColor(NAVY).stroke();
          small(`${wk.reliabilityPct}%`, x + i * slot, yFor(wk.reliabilityPct) - 9, { color: GREY, size: 6.5, width: slot, align: 'center' });
        } else {
          small('—', x + i * slot, y + h - 10, { color: LIGHT, size: 7, width: slot, align: 'center' });
        }
        small(wk.current ? 'this wk' : monthDay(wk.start), x + i * slot, y + h + 3, { color: wk.current ? NAVY : LIGHT, size: 6.5, width: slot, align: 'center', bold: wk.current });
      });
      const t = db.reliability.thisWeek;
      small(
        `This week so far: ${t.ncns} no-call no-show${t.ncns === 1 ? '' : 's'} · ${t.callOuts} call-out${t.callOuts === 1 ? '' : 's'} · ${t.lates} late · ${t.replaced} covered`,
        x,
        y + h + 14,
        { color: t.ncns > 0 ? WARN : GREY, size: 6.8, width: w, ellipsis: true },
      );
      return h + 26;
    };

    const leadsPanel = (db: DashboardSnapshot, x: number, y: number, w: number): number => {
      if (db.leads.length === 0) {
        small('Your Alto contact is being assigned — a request lands on the right desk.', x, y, { color: LIGHT, size: 8, width: w, lineBreak: true, height: 30 });
        return 22;
      }
      let yy = y;
      for (const l of db.leads) {
        doc.circle(x + 5, yy + 5, 3).fill(l.onSite ? GOOD : TRACK);
        small(l.name, x + 14, yy, { bold: true, color: NAVY, size: 8.5, width: w - 14, ellipsis: true });
        small(`${l.title === 'supervisor' ? 'Shift supervisor' : 'Floor lead'}${l.onSite ? ' · on site that day' : ''}${l.phone ? ` · ${l.phone}` : ''}`, x + 14, yy + 11, {
          color: l.onSite ? GOOD : GREY,
          size: 7,
          width: w - 14,
          ellipsis: true,
        });
        yy += 24;
      }
      return yy - y;
    };

    const opsPanel = (db: DashboardSnapshot, x: number, y: number, w: number): number => {
      const o = db.ops?.today ?? db.ops?.lastNight ?? null;
      if (!o) {
        small('No checklist shifts were run — nothing to show yet.', x, y, { color: LIGHT, size: 8, width: w, lineBreak: true, height: 30 });
        return 22;
      }
      const pct = o.sopTotal > 0 ? Math.round((o.sopDone / o.sopTotal) * 100) : null;
      const r = 16;
      const cx = x + r + 2;
      const cy = y + r + 2;
      doc.circle(cx, cy, r).lineWidth(4).strokeColor(TRACK).stroke();
      if (pct !== null && pct > 0) {
        const sweep = Math.min(359.9, (360 * pct) / 100);
        const theta = ((-90 + sweep) * Math.PI) / 180;
        const ex = cx + r * Math.cos(theta);
        const ey = cy + r * Math.sin(theta);
        doc
          .path(`M ${cx} ${cy - r} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${ex} ${ey}`)
          .lineWidth(4)
          .strokeColor(pct >= 90 ? GOOD : pct >= 70 ? BLUE : WARN)
          .stroke();
      }
      small(pct === null ? '—' : `${pct}%`, cx - r, cy - 4, { bold: true, color: NAVY, size: 8, width: 2 * r, align: 'center' });
      const tx = cx + r + 10;
      small(`SOP ${o.sopDone} of ${o.sopTotal} · ${o.shifts} shift${o.shifts === 1 ? '' : 's'}`, tx, y + 2, { bold: true, color: NAVY, size: 8.5, width: w - (tx - x), ellipsis: true });
      small(`${o.taskDone} of ${o.taskTotal} tasks · ${o.photos} photo${o.photos === 1 ? '' : 's'}`, tx, y + 14, { color: GREY, size: 7.5, width: w - (tx - x), ellipsis: true });
      const flags = [o.tempAlerts > 0 && `${o.tempAlerts} temperature alert${o.tempAlerts === 1 ? '' : 's'}`, o.incomplete > 0 && `${o.incomplete} closed incomplete`, o.open > 0 && `${o.open} still open`]
        .filter(Boolean)
        .join(' · ');
      if (flags) small(flags, tx, y + 25, { color: WARN, size: 7.5, width: w - (tx - x), ellipsis: true });
      let yy = y + 40;
      for (const n of o.notes.slice(0, 2)) {
        small(`${n.department} · ${n.period}: ${n.summary}`, x, yy, { color: GREY, size: 7, width: w, ellipsis: true });
        yy += 10;
      }
      return yy - y;
    };

    const dayBody = (d: ReportDay) => {
      const db = d.dashboard;
      hero(d);
      const t = db.kpis.tomorrow;
      const tomorrowTotal = t.confirmed + t.unconfirmed + t.open;
      kpiCards([
        {
          label: 'FILL RATE · THIS WEEK',
          value: db.kpis.fill.pct === null ? '—' : `${db.kpis.fill.pct}%`,
          delta: db.kpis.fill.deltaPts === null ? undefined : `${db.kpis.fill.deltaPts > 0 ? '+' : ''}${db.kpis.fill.deltaPts} pts vs last week`,
          deltaTone: db.kpis.fill.deltaPts === null || db.kpis.fill.deltaPts === 0 ? GREY : db.kpis.fill.deltaPts > 0 ? GOOD : BAD,
          meter: db.kpis.fill.pct,
          meterTone: db.kpis.fill.pct === null ? BLUE : db.kpis.fill.pct >= 95 ? GOOD : db.kpis.fill.pct >= 85 ? BLUE : WARN,
          sub: `${db.kpis.fill.filled} of ${db.kpis.fill.total} shifts filled`,
        },
        {
          label: 'RELIABILITY · 4 WEEKS',
          value: db.kpis.grade.grade ?? '—',
          tone: gradeTone(db.kpis.grade.grade),
          delta: db.kpis.grade.score === null ? undefined : `${db.kpis.grade.score}% ${db.kpis.grade.basis === 'schedule' ? 'showed up' : 'delivered'}`,
          sub: db.kpis.grade.hasHistory ? `${db.kpis.grade.ncns} no-call no-shows · ${db.kpis.grade.replaced} covered` : 'no completed weeks yet',
        },
        {
          label: 'HOURS · THIS WEEK',
          value: hrs(db.kpis.hours.worked),
          meter: db.kpis.hours.scheduled > 0 ? Math.min(100, Math.round((db.kpis.hours.worked / db.kpis.hours.scheduled) * 100)) : null,
          sub: `of ${hrs(db.kpis.hours.scheduled)} scheduled`,
        },
        {
          label: 'TOMORROW · CONFIRMED',
          value: tomorrowTotal === 0 ? '—' : `${t.confirmed} / ${tomorrowTotal}`,
          tone: t.open > 0 ? WARN : NAVY,
          meter: tomorrowTotal > 0 ? Math.round((t.confirmed / tomorrowTotal) * 100) : null,
          meterTone: t.open > 0 ? WARN : GOOD,
          sub:
            `${monthDay(t.date)} · ` +
            (tomorrowTotal === 0
              ? 'nothing scheduled'
              : [t.open > 0 && `${t.open} unfilled`, t.unconfirmed > 0 && `${t.unconfirmed} awaiting confirmation`].filter(Boolean).join(' · ') || 'all confirmed'),
        },
      ]);

      if (d.waves.length === 0) {
        section(d.isToday ? 'Today by shift' : 'The day by shift');
        small('Nothing scheduled this day.', left, doc.y, { color: LIGHT, size: 9 });
        doc.y += 14;
      } else {
        section(
          `${d.isToday ? 'Today' : 'The day'} by shift · ${d.waves.length} ${d.waves.length === 1 ? 'wave' : 'waves'}`,
          'Each wave against its headcount. Names and punch times stay on the Today page in your portal.',
        );
        for (const w of d.waves) waveLine(w);
        doc.y += 4;
      }

      section('Your Alto lead · the checklist');
      panels(
        [
          { title: 'Your Alto lead', body: (x, y, w) => leadsPanel(db, x, y, w) },
          {
            title: db.ops?.today ? (d.isToday ? "Today's checklist work" : 'The checklist that day') : "Last night's work",
            right: db.ops?.today ? undefined : db.ops?.lastNight ? monthDay(db.ops.lastNight.dateKey) : undefined,
            body: (x, y, w) => opsPanel(db, x, y, w),
          },
        ],
        70,
      );

      section('The week · reliability');
      panels(
        [
          { title: `The week · ${monthDay(db.week.start)} – ${monthDay(db.week.end)}`, right: 'shifts per day', body: (x, y, w) => weekBars(db, d.key, x, y, w) },
          { title: 'Reliability · 5 weeks', right: 'delivered vs contracted · A from 88%', body: (x, y, w) => reliabilityBars(db, x, y, w) },
        ],
        100,
      );

      section('Crew clearance · safety · statements');
      panels(
        [
          {
            title: 'Crew clearance',
            body: (x, y, w) => {
              const c = db.clearance;
              if (c.total === 0) {
                small('No crew scheduled this week.', x, y, { color: LIGHT, size: 8, width: w });
                return 14;
              }
              const cleared = c.total - c.checksInFlight - c.flagged;
              doc.font('Helvetica-Bold').fontSize(16).fillColor(c.flagged > 0 ? WARN : GOOD).text(`${cleared} / ${c.total}`, x, y, { lineBreak: false });
              small(
                cleared === c.total ? 'everyone on this week’s crew is cleared' : `${c.checksInFlight} check${c.checksInFlight === 1 ? '' : 's'} in flight${c.flagged > 0 ? ` · ${c.flagged} flagged` : ''}`,
                x,
                y + 20,
                { color: GREY, size: 7, width: w, lineBreak: true, height: 20 },
              );
              small(`${c.i9Complete} of ${c.total} I-9 complete · current standing`, x, y + 38, { color: LIGHT, size: 6.5, width: w, ellipsis: true });
              return 48;
            },
          },
          {
            title: 'Safety',
            body: (x, y, w) => {
              const s = db.safety;
              doc.font('Helvetica-Bold').fontSize(16).fillColor(s.open > 0 ? WARN : GOOD).text(s.daysSinceLast === null ? '365+' : String(s.daysSinceLast), x, y, { lineBreak: false });
              small('days since the last incident', x, y + 20, { color: GREY, size: 7, width: w });
              small(`${s.monthIncidents === 0 ? 'a clean month' : `${s.monthIncidents} this month`}${s.open > 0 ? ` · ${s.open} open` : ''}`, x, y + 31, { color: s.open > 0 ? WARN : LIGHT, size: 7, width: w, ellipsis: true });
              return 42;
            },
          },
          {
            title: 'Statements',
            body: (x, y, w) => {
              if (db.statements.length === 0) {
                small('No statements yet.', x, y, { color: LIGHT, size: 8, width: w });
                return 14;
              }
              let yy = y;
              for (const st of db.statements.slice(0, 3)) {
                small(`${st.number !== null ? `No. ${String(st.number).padStart(4, '0')}` : 'Statement'} · ${monthDay(st.periodStart)} – ${monthDay(st.periodEnd)}${st.storeShare ? ' · your store' : ''}`, x, yy, {
                  color: NAVY,
                  size: 7,
                  width: w,
                  ellipsis: true,
                });
                small(`${st.amount !== null ? money(st.amount) : '—'}${st.hours !== null ? ` · ${hrs(st.hours)}` : ''} · ${st.paid ? 'paid' : 'due'}`, x, yy + 9, { color: st.paid ? GOOD : GREY, size: 7, width: w, ellipsis: true });
                yy += 22;
              }
              return yy - y;
            },
          },
        ],
        64,
      );

      const rq = db.requests;
      section(`Requests · ${rq.open.length} open${rq.loggedToday > 0 ? ` · ${rq.loggedToday} logged ${d.isToday ? 'today' : 'that day'}` : ''}`);
      if (rq.open.length === 0) {
        small('Nothing open with Alto.', left, doc.y, { color: LIGHT, size: 9 });
        doc.y += 14;
      } else {
        for (const r of rq.open) {
          ensure(14);
          const y = doc.y;
          small(monthDay(r.at), left, y, { color: GREY, size: 8, width: 48 });
          small(r.kind, left + 52, y, { bold: true, color: NAVY, size: 8, width: 64 });
          small(r.subject, left + 122, y, { color: NAVY, size: 8, width: width - 230, ellipsis: true });
          small(r.overdue ? 'past reply-by' : r.status.replace('_', ' ').toLowerCase(), right - 100, y, { color: r.overdue ? BAD : GREY, size: 8, width: 100, align: 'right' });
          doc.y = y + 13;
        }
      }
    };

    /* ---- the period at a glance (range only) --------------------------- */
    if (data.isRange) {
      section('The period at a glance');
      const tt = data.totals;
      kpiCards([
        {
          label: 'DELIVERED VS CONTRACT',
          value: tt.score === null ? '—' : `${tt.score}%${tt.grade ? ` · ${tt.grade}` : ''}`,
          tone: gradeTone(tt.grade),
          sub: tt.contractedHours > 0 ? `${tt.deliveredHours} of ${tt.contractedHours} person-hours` : 'no contracted hours in the period',
        },
        { label: 'ON THE FLOOR', value: `${tt.showed} / ${tt.expected}`, tone: tt.showed >= tt.expected ? GOOD : NAVY, sub: 'punched in of expected' },
        { label: 'DID NOT PUNCH IN', value: String(tt.missed), tone: tt.missed > 0 ? BAD : GOOD, sub: tt.missed === 0 ? 'nobody missed' : 'shifts ended with no punch' },
        { label: 'UNFILLED', value: String(tt.open), tone: tt.open > 0 ? WARN : GOOD, sub: tt.open === 0 ? 'every slot filled' : 'open slots in the period' },
      ]);
      section('Day by day', 'Each row is one day — its dashboard follows on its own pages.');
      {
        const rowH = 17;
        const nameW = 92;
        const numW = 46;
        const barX = left + nameW + 6;
        const barW = width - nameW - numW * 4 - 30;
        small('DAY', left, doc.y, { color: LIGHT, size: 6.5, characterSpacing: 0.6 });
        small('DELIVERED VS CONTRACTED', barX, doc.y, { color: LIGHT, size: 6.5, characterSpacing: 0.6 });
        small('ON FLOOR', barX + barW + 8, doc.y, { color: LIGHT, size: 6.5, width: numW, align: 'right' });
        small('NO PUNCH', barX + barW + 8 + numW, doc.y, { color: LIGHT, size: 6.5, width: numW, align: 'right' });
        small('UNFILLED', barX + barW + 8 + numW * 2, doc.y, { color: LIGHT, size: 6.5, width: numW, align: 'right' });
        small('GRADE', barX + barW + 8 + numW * 3, doc.y, { color: LIGHT, size: 6.5, width: numW, align: 'right' });
        doc.y += 11;
        for (const d of data.days) {
          ensure(rowH + 2);
          const y = doc.y;
          small(shortDay(d.key), left, y + 3, { bold: true, color: NAVY, size: 8.5, width: nameW });
          doc.roundedRect(barX, y + 3, barW, 8, 4).fill(TRACK);
          const score = d.contract.score;
          if (score !== null && score > 0) doc.roundedRect(barX, y + 3, Math.max(4, (barW * Math.min(100, score)) / 100), 8, 4).fill(gradeTone(d.contract.grade));
          small(score === null ? (d.isFuture ? 'upcoming' : 'no graded hours') : `${score}%`, barX + barW - 60, y + 3, { color: GREY, size: 7, width: 58, align: 'right' });
          small(`${d.summary.showed}/${d.summary.expected}`, barX + barW + 8, y + 3, { color: NAVY, size: 8.5, width: numW, align: 'right' });
          small(String(d.summary.missed), barX + barW + 8 + numW, y + 3, { color: d.summary.missed > 0 ? BAD : LIGHT, size: 8.5, width: numW, align: 'right' });
          small(String(d.summary.open), barX + barW + 8 + numW * 2, y + 3, { color: d.summary.open > 0 ? WARN : LIGHT, size: 8.5, width: numW, align: 'right' });
          small(d.contract.grade ?? '—', barX + barW + 8 + numW * 3, y + 3, { bold: true, color: gradeTone(d.contract.grade), size: 8.5, width: numW, align: 'right' });
          doc.y = y + rowH;
        }
      }
      for (const d of data.days) {
        doc.addPage();
        doc.y = 54;
        const by = doc.y;
        doc.roundedRect(left, by, width, 40, 6).fill(NAVY);
        doc.font('Helvetica-Bold').fontSize(13).fillColor('#FFFFFF').text(d.label, left + 12, by + 9, { lineBreak: false });
        small(
          d.isFuture ? `${d.summary.expected} expected · ${d.summary.open} unfilled` : `${d.summary.showed} of ${d.summary.expected} on the floor · ${d.summary.missed} did not punch in · ${d.summary.open} unfilled`,
          left + 12,
          by + 25,
          { color: GOLD, size: 8 },
        );
        if (d.contract.grade) {
          doc
            .font('Helvetica-Bold')
            .fontSize(18)
            .fillColor(gradeTone(d.contract.grade) === NAVY ? '#FFFFFF' : gradeTone(d.contract.grade))
            .text(d.contract.grade, left, by + 10, { width: width - 12, align: 'right', lineBreak: false });
        }
        doc.y = by + 48;
        dayBody(d);
      }
    } else {
      dayBody(data.days[0]!);
    }

    /* ---- footer on every page ------------------------------------------ */
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .moveTo(left, doc.page.height - 48)
        .lineTo(right, doc.page.height - 48)
        .lineWidth(0.5)
        .strokeColor(GOLD)
        .stroke();
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(LIGHT)
        .text(pdfSafe(`${data.orgName} · Service Report · ${where} · ${period} · Confidential · page ${i - range.start + 1} of ${range.count}`), left, doc.page.height - 40, {
          width,
          align: 'center',
          lineBreak: false,
        });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}
