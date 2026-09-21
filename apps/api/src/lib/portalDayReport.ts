import PDFDocument from 'pdfkit';
import { paidMinutesForRange } from '@alto-people/shared';
import { prisma } from '../db.js';
import { formatTimeInZone, zonedMinutes } from './timezone.js';
import { opsShiftScope } from './portalOps.js';
import {
  DAY,
  HOUR,
  ORG_TZ,
  attendanceWhere,
  coverageByHours,
  entryScope,
  fullName,
  gradeWeeks,
  incidentWhere,
  loadPunches,
  loadTargets,
  netMinutes,
  nextKey,
  portalCalendar,
  shiftScope,
  targetAtMinute,
  type PortalScope,
  type StoreCalendar,
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
  /** The zone the report's days are cut in (the store's clock). */
  timezone: string;
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
  /** Days and weeks on the store's clock — the live page's calendar. */
  calendar?: StoreCalendar,
): Promise<PortalReportData> {
  const cal = calendar ?? (await portalCalendar(scope));
  const from = cal.midnight(fromKey);
  const toExclusive = cal.midnight(nextKey(toKey, 1));
  const todayKey = cal.key(now);
  const nowMs = now.getTime();
  // Everything the dashboard reads for any day in the range, fetched
  // once: the 4 completed weeks before the first day's week (the grade
  // and the fill delta), through the end of the last day's week and
  // the day after (tomorrow's tile).
  const trendStart = cal.midnight(nextKey(cal.key(cal.weekStart(from)), -4 * 7));
  const lastWeekEnd = cal.weekEnd(new Date(toExclusive.getTime() - 1));
  const spanEnd = new Date(Math.max(lastWeekEnd.getTime(), toExclusive.getTime() + DAY));
  const dayKeys: string[] = [];
  for (let k = fromKey; k <= toKey; k = nextKey(k, 1)) dayKeys.push(k);
  const opsKeys = [nextKey(fromKey, -1), ...dayKeys];
  // Store Ops belongs to the building that ran it.
  const opsWhere = await opsShiftScope(scope);

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
      where: {
        clientId: scope.clientId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
        createdAt: { lt: toExclusive },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }],
      },
      select: { kind: true, subject: true, status: true, createdAt: true, dueAt: true, resolvedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    }),
    prisma.user.findMany({
      where: {
        clientId: scope.clientId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR'] },
        // Names, phones and emails: the leadership in THIS building, plus
        // supervisors who float across the client. Another store's corps
        // has no place in this store's report.
        ...(scope.locationId
          ? { OR: [{ locationId: scope.locationId }, { locationId: null }] }
          : {}),
      },
      select: { id: true, email: true, role: true, associateId: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      take: 6,
    }),
    prisma.opsShift.findMany({
      where: { ...opsWhere, dateKey: { in: opsKeys } },
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
      where: {
        ...incidentWhere(scope),
        occurredAt: { gte: new Date(from.getTime() - 366 * DAY), lt: toExclusive },
      },
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
      where: { ...entryScope(scope), status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] }, clockInAt: { gte: cal.weekStart(from), lt: spanEnd } },
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

  const weekKeyOf = (d: Date) => cal.key(cal.weekStart(d));
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
    const dayStart = cal.midnight(key);
    const dayEnd = cal.midnight(nextKey(key, 1));
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
    const weekStartD = cal.weekStart(dayStart);
    const weekKeyD = cal.key(weekStartD);
    const weekEndD = cal.weekEnd(dayStart);
    const weekKeys: string[] = [];
    for (let i = 4; i >= 0; i--) weekKeys.push(nextKey(weekKeyD, -7 * i));
    const prevWeekKey = nextKey(weekKeyD, -7);
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
      filled: weekShifts.filter((s) => cal.key(s.startsAt) === d && s.status !== 'OPEN').length,
      open: weekShifts.filter((s) => cal.key(s.startsAt) === d && s.status === 'OPEN').length,
    }));
    const scheduledMin = weekShifts.reduce((a, s) => a + paidMinutesForRange(s.startsAt, s.endsAt), 0);
    const workedMin = weekEntries
      .filter((e) => e.clockInAt >= weekStartD && e.clockInAt < weekEndD && e.clockInAt.getTime() < asOfMs)
      .reduce((a, e) => a + netMinutes({ ...e, clockOutAt: e.clockOutAt && e.clockOutAt.getTime() <= asOfMs ? e.clockOutAt : null }, asOf), 0);
    const tomorrowKey = nextKey(key, 1);
    const tomorrowShifts = rows.filter((s) => cal.key(s.startsAt) === tomorrowKey);
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
    const monthStart = cal.midnight(`${key.slice(0, 7)}-01`);
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
            // No fallback for a store account. When the statement has no
            // line for this store (renamed, or billed before the store
            // existed), the honest answer is nothing — the client total
            // is every other store's labour spend.
            amount: line ? line.amount : scope.locationId ? null : (snap?.totals?.amount ?? null),
            hours: line ? line.hours : scope.locationId ? null : (snap?.totals?.hours ?? null),
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
            at: cal.key(r.createdAt),
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
    generatedAt: `${cal.key(now)} ${formatTimeInZone(now, cal.tz)}`,
    timezone: cal.tz,
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

/*
 * The layout system — one of each, applied everywhere:
 *
 *   Grid     Letter page, 44pt margins, 12 columns with 12pt gutters.
 *   Type     Five sizes (8 label · 9.5 body · 12 title · 20 figure ·
 *            36 hero), two weights, caps only on eyebrow labels.
 *   Card     One outlined card: 14pt padding, a 12pt title row, an
 *            optional 8pt meta on the right. The hero is the single
 *            filled surface and earns it.
 *   Colour   Ink for text; Alto gold for brand marks only (masthead,
 *            hero rule); one blue for data; green / amber / red reserved
 *            for status. Charts use the same palette as the tiles.
 *   Dates    "Sep 16, 2026" everywhere ("Sep 16" inside a card, a
 *            weekday prefix only where the day itself is the subject).
 *   Pages    A masthead on page one, a running header on every other
 *            page, a footer with the page count on all of them. Blocks
 *            move whole to the next page; tables break between rows and
 *            say "(continued)". Nothing is ever truncated.
 */

const C = {
  ink: '#0B1832',
  ink2: '#4A5568',
  ink3: '#7C8799',
  rule: '#DCE1E8',
  wash: '#F4F6F9',
  brand: '#C9A227',
  mastSub: '#AEB8C9',
  data: '#2F5FD0',
  dataTint: '#C9D6F2',
  good: '#1E7B4F',
  warn: '#B7791F',
  bad: '#C0392B',
  white: '#FFFFFF',
} as const;
const T = { label: 8, body: 9.5, title: 12, figure: 20, hero: 36 } as const;
const PAGE_W = 612;
const PAGE_H = 792;
const M = 44;
const W = PAGE_W - M * 2;
const GUTTER = 12;
const GAP = 12;
const PAD = 14;
const HEAD = PAD + 15 + 8;
const CONTENT_TOP = 62;
const CONTENT_BOTTOM = PAGE_H - 58;
const ASCENT = 0.718; // Helvetica ascender and cap height, as a fraction of size
const colW = (n: number) => ((W - GUTTER * 11) / 12) * n + GUTTER * (n - 1);

const keyDate = (key: string) => new Date(`${key}T12:00:00.000Z`);
const fmtKey = (key: string, o: Intl.DateTimeFormatOptions) => keyDate(key).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
const dShort = (k: string) => fmtKey(k, { month: 'short', day: 'numeric' });
const dFull = (k: string) => fmtKey(k, { month: 'short', day: 'numeric', year: 'numeric' });
const dWeekday = (k: string) => `${fmtKey(k, { weekday: 'long' })}, ${dFull(k)}`;
const dWeekdayShort = (k: string) => `${fmtKey(k, { weekday: 'short' })}, ${dShort(k)}`;
const dSpan = (a: string, b: string) =>
  a === b ? dFull(a) : a.slice(0, 4) === b.slice(0, 4) ? `${dShort(a)} – ${dFull(b)}` : `${dFull(a)} – ${dFull(b)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const fmtHours = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
const gradeColor = (g: Grade) => (g === 'A' ? C.good : g === 'B' ? C.ink : g === 'F' ? C.bad : g ? C.warn : C.ink3);

type Style = { size?: number; bold?: boolean; color?: string; caps?: boolean };
type CardSpec = { title: string; meta?: string; bodyHeight: (w: number) => number; drawBody: (x: number, y: number, w: number) => void };
type TableRow = { height: number; draw: (x: number, y: number, w: number) => void };
type LegendItem = { color: string; label: string; kind?: 'box' | 'line' | 'dash' | 'outline' };
type Tile = {
  label: string;
  value: string;
  valueColor?: string;
  chip?: Grade;
  meter: { parts: Array<{ value: number; color: string }>; total: number; marker?: number } | null;
  sub: string;
  note?: string;
  noteColor?: string;
};

export function renderPortalReportPdf(data: PortalReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const where = data.storeName ?? data.clientName;
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 0,
      bufferPages: true,
      info: { Title: pdfSafe(`Service Report — ${where} — ${dSpan(data.from, data.to)}`), Author: pdfSafe(data.orgName) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    /* ---- text ---------------------------------------------------------- */
    const spacingOf = (st: Style) => (st.caps ? 0.7 : 0);
    const prep = (s: string, st: Style) => (st.caps ? pdfSafe(s).toUpperCase() : pdfSafe(s));
    const font = (st: Style) =>
      doc
        .font(st.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(st.size ?? T.body)
        .fillColor(st.color ?? C.ink);
    const widthOf = (s: string, st: Style = {}) => {
      font(st);
      return doc.widthOfString(prep(s, st), { characterSpacing: spacingOf(st) });
    };
    const text = (s: string, x: number, y: number, st: Style = {}) => {
      font(st);
      doc.text(prep(s, st), x, y, { lineBreak: false, characterSpacing: spacingOf(st) });
    };
    const textRight = (s: string, right: number, y: number, st: Style = {}) => text(s, right - widthOf(s, st), y, st);
    const textCenter = (s: string, cx: number, y: number, st: Style = {}) => text(s, cx - widthOf(s, st) / 2, y, st);
    const paraH = (s: string, w: number, st: Style = {}) => {
      font(st);
      return doc.heightOfString(prep(s, st), { width: w, lineGap: 1.5, characterSpacing: spacingOf(st) });
    };
    const para = (s: string, x: number, y: number, w: number, st: Style = {}) => {
      font(st);
      doc.text(prep(s, st), x, y, { width: w, lineGap: 1.5, characterSpacing: spacingOf(st) });
      return paraH(s, w, st);
    };
    const LABEL: Style = { size: T.label, caps: true, bold: true, color: C.ink3 };

    /* ---- marks --------------------------------------------------------- */
    const hr = (x: number, y: number, w: number, color: string = C.rule, weight = 0.5) =>
      doc.moveTo(x, y).lineTo(x + w, y).lineWidth(weight).strokeColor(color).stroke();
    const frame = (x: number, y: number, w: number, h: number) => doc.roundedRect(x, y, w, h, 4).lineWidth(0.75).strokeColor(C.rule).stroke();
    const meter = (x: number, y: number, w: number, parts: Array<{ value: number; color: string }>, total: number, marker?: number) => {
      doc.save();
      doc.roundedRect(x, y, w, 4, 2).clip();
      doc.rect(x, y, w, 4).fill(C.rule);
      let cx = x;
      if (total > 0) {
        for (const p of parts) {
          if (p.value <= 0) continue;
          const pw = Math.min(x + w - cx, (w * p.value) / total);
          if (pw <= 0) break;
          doc.rect(cx, y, pw, 4).fill(p.color);
          cx += pw;
        }
      }
      doc.restore();
      if (marker !== undefined) doc.rect(x + (w * Math.min(100, marker)) / 100 - 0.5, y - 2, 1, 8).fill(C.ink);
    };
    const chip = (g: Grade, x: number, y: number, size: number) => {
      if (!g) return;
      doc.roundedRect(x, y, size, size, 3).fill(gradeColor(g));
      textCenter(g, x + size / 2, y + (size - T.title * ASCENT) / 2, { size: T.title, bold: true, color: C.white });
    };
    const ring = (cx: number, cy: number, r: number, pct: number | null) => {
      doc.circle(cx, cy, r).lineWidth(4.5).strokeColor(C.rule).stroke();
      if (pct !== null && pct > 0) {
        const sweep = Math.min(359.9, (360 * pct) / 100);
        const th = ((-90 + sweep) * Math.PI) / 180;
        doc
          .path(`M ${cx} ${cy - r} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${cx + r * Math.cos(th)} ${cy + r * Math.sin(th)}`)
          .lineWidth(4.5)
          .strokeColor(C.data)
          .stroke();
      }
      textCenter(pct === null ? '—' : `${pct}%`, cx, cy - (T.body * ASCENT) / 2, { size: T.body, bold: true });
    };
    const legend = (items: LegendItem[], x: number, y: number) => {
      let lx = x;
      for (const it of items) {
        if (it.kind === 'line' || it.kind === 'dash') {
          doc.moveTo(lx, y + 3.5).lineTo(lx + 12, y + 3.5).lineWidth(1.2).strokeColor(it.color);
          if (it.kind === 'dash') doc.dash(2.5, { space: 2 });
          doc.stroke().undash();
          lx += 16;
        } else if (it.kind === 'outline') {
          doc.rect(lx, y, 7, 7).fillAndStroke(C.dataTint, C.data);
          lx += 11;
        } else {
          doc.rect(lx, y, 7, 7).fill(it.color);
          lx += 11;
        }
        text(it.label, lx, y, { size: T.label, color: C.ink2 });
        lx += widthOf(it.label, { size: T.label }) + 14;
      }
    };

    /* ---- pages --------------------------------------------------------- */
    let y = 0;
    const newPage = () => {
      doc.addPage();
      y = CONTENT_TOP;
    };
    /** Reserve a whole block; it moves to the next page rather than split. */
    const place = (h: number) => {
      if (y + h > CONTENT_BOTTOM && y > CONTENT_TOP + 1) newPage();
      const top = y;
      y += h + GAP;
      return top;
    };

    /* ---- cards --------------------------------------------------------- */
    const cardHead = (title: string, meta: string | undefined, x: number, top: number, w: number) => {
      text(title, x + PAD, top + PAD, { size: T.title, bold: true });
      if (meta) textRight(meta, x + w - PAD, top + PAD + 3, { size: T.label, color: C.ink3 });
    };
    const cardsRow = (cards: CardSpec[], spans: number[]) => {
      const ws = spans.map(colW);
      const h = Math.max(...cards.map((c, i) => HEAD + c.bodyHeight(ws[i]! - PAD * 2) + PAD));
      const top = place(h);
      let x = M;
      cards.forEach((c, i) => {
        const w = ws[i]!;
        frame(x, top, w, h);
        cardHead(c.title, c.meta, x, top, w);
        c.drawBody(x + PAD, top + HEAD, w - PAD * 2);
        x += w + GUTTER;
      });
    };
    /** A full-width card of rows that breaks between rows across pages. */
    const tableCard = (
      title: string,
      meta: string | undefined,
      columns: Array<{ label: string; x: number; right?: boolean }> | null,
      rows: TableRow[],
      empty: string,
    ) => {
      const iw = W - PAD * 2;
      if (rows.length === 0) {
        const h = HEAD + paraH(empty, iw, { color: C.ink3 }) + PAD;
        const top = place(h);
        frame(M, top, W, h);
        cardHead(title, meta, M, top, W);
        para(empty, M + PAD, top + HEAD, iw, { color: C.ink3 });
        return;
      }
      const headH = HEAD + (columns ? 16 : 0);
      const wholeH = headH + rows.reduce((a, r) => a + r.height, 0) + PAD - 4;
      const pageRoom = CONTENT_BOTTOM - CONTENT_TOP;
      // Keep a table together when it fits a page on its own and only a
      // sliver of it would land here — a lone row under a heading reads
      // as a mistake, not a continuation.
      if (y + wholeH > CONTENT_BOTTOM && wholeH <= pageRoom && y > CONTENT_TOP + 1) {
        let fits = 0;
        let hh = headH;
        while (fits < rows.length && y + hh + rows[fits]!.height + PAD <= CONTENT_BOTTOM) {
          hh += rows[fits]!.height;
          fits += 1;
        }
        if (rows.length <= 3 || fits < Math.ceil(rows.length / 2)) newPage();
      }
      let i = 0;
      let part = 0;
      while (i < rows.length) {
        if (y + headH + rows[i]!.height + PAD > CONTENT_BOTTOM && y > CONTENT_TOP + 1) newPage();
        const top = y;
        let h = headH;
        let j = i;
        while (j < rows.length && top + h + rows[j]!.height + PAD <= CONTENT_BOTTOM) {
          h += rows[j]!.height;
          j += 1;
        }
        if (j === i) {
          h += rows[i]!.height;
          j = i + 1;
        }
        // Never strand one row: pull one back so the next page carries two.
        if (j === rows.length - 1 && j - i >= 3) {
          j -= 1;
          h -= rows[j]!.height;
        }
        h += PAD - 4;
        frame(M, top, W, h);
        cardHead(part === 0 ? title : `${title} (continued)`, part === 0 ? meta : undefined, M, top, W);
        let ry = top + HEAD;
        if (columns) {
          for (const c of columns) (c.right ? textRight : text)(c.label, M + PAD + c.x, ry, LABEL);
          ry += 16;
        }
        for (let k = i; k < j; k += 1) {
          hr(M + PAD, ry, iw);
          rows[k]!.draw(M + PAD, ry, iw);
          ry += rows[k]!.height;
        }
        y = top + h + GAP;
        i = j;
        part += 1;
      }
    };
    const tiles = (list: Tile[]) => {
      const tw = colW(3);
      const iw = tw - 24;
      const noteH = (t: Tile) => (t.note ? paraH(t.note, iw, { size: T.label }) + 2 : 0);
      const textH = Math.max(...list.map((t) => paraH(t.sub, iw, { size: T.label }) + noteH(t)));
      const h = 76 + textH + 12;
      const top = place(h);
      list.forEach((t, i) => {
        const x = M + i * (tw + GUTTER);
        frame(x, top, tw, h);
        const ix = x + 12;
        text(t.label, ix, top + 12, LABEL);
        let vx = ix;
        if (t.chip) {
          chip(t.chip, vx, top + 28, 24);
          vx += 30;
        }
        text(t.value, vx, top + 30, { size: T.figure, bold: true, color: t.valueColor ?? C.ink });
        if (t.meter) meter(ix, top + 62, iw, t.meter.parts, t.meter.total, t.meter.marker);
        else meter(ix, top + 62, iw, [], 0);
        const sh = para(t.sub, ix, top + 76, iw, { size: T.label, color: C.ink2 });
        if (t.note) para(t.note, ix, top + 76 + sh + 2, iw, { size: T.label, bold: true, color: t.noteColor ?? C.ink2 });
      });
    };

    /* ---- charts -------------------------------------------------------- */
    /** Scheduled (tint), on the floor (blue), contracted (ink step line). */
    const coverageChart = (d: ReportDay, x: number, y0: number, w: number, h: number) => {
      const plotX = x + 18;
      const plotW = w - 18;
      const maxRaw = Math.max(1, ...d.hours.map((r) => Math.max(r.scheduled, r.target ?? 0, r.delivered ?? 0)));
      const max = maxRaw <= 2 ? maxRaw : Math.ceil(maxRaw / 2) * 2;
      const yFor = (v: number) => y0 + h - (v / max) * h;
      for (const g of max >= 2 ? [0, max / 2, max] : [0, max]) {
        hr(plotX, yFor(g), plotW);
        textRight(String(g), plotX - 5, yFor(g) - (T.label * ASCENT) / 2, { size: T.label, color: C.ink3 });
      }
      const slot = plotW / 24;
      d.hours.forEach((r, i) => {
        const bx = plotX + i * slot;
        if (r.scheduled > 0) doc.rect(bx + 0.75, yFor(r.scheduled), slot - 1.5, y0 + h - yFor(r.scheduled)).fill(C.dataTint);
        if (r.delivered !== null && r.delivered > 0) {
          const bw = Math.max(2, slot * 0.46);
          doc.rect(bx + (slot - bw) / 2, yFor(r.delivered), bw, y0 + h - yFor(r.delivered)).fill(C.data);
        }
      });
      doc.lineWidth(1.1).strokeColor(C.ink);
      let pen = false;
      d.hours.forEach((r, i) => {
        const bx = plotX + i * slot;
        if (r.target === null) {
          if (pen) doc.stroke();
          pen = false;
          return;
        }
        if (!pen) {
          doc.moveTo(bx, yFor(r.target));
          pen = true;
        } else doc.lineTo(bx, yFor(r.target));
        doc.lineTo(bx + slot, yFor(r.target));
      });
      if (pen) doc.stroke();
      if (d.isToday) {
        const nx = plotX + (zonedMinutes(new Date(), data.timezone) / 60) * slot;
        doc.moveTo(nx, y0).lineTo(nx, y0 + h).lineWidth(0.75).dash(2, { space: 2 }).strokeColor(C.ink3).stroke().undash();
        text('Now', nx + 3, y0, { size: T.label, color: C.ink3 });
      }
      for (let i = 0; i < 24; i += 3) textCenter(hourLabel(i), plotX + i * slot, y0 + h + 4, { size: T.label, color: C.ink3 });
      legend(
        [
          { color: C.dataTint, label: 'Scheduled' },
          { color: C.data, label: 'On the floor' },
          { color: C.ink, label: 'Contracted', kind: 'line' },
        ],
        plotX,
        y0 + h + 18,
      );
    };

    /* ---- sections -------------------------------------------------------- */
    const hero = (d: ReportDay) => {
      const db = d.dashboard;
      const H = 178;
      const top = place(H);
      doc.roundedRect(M, top, W, H, 4).fill(C.wash);
      doc.rect(M, top, 3, H).fill(C.brand);
      const lx = M + 18;
      const lw = colW(5) - 24;
      let eyebrow: string;
      let big: string;
      let suffix = '';
      let bigColor: string = C.ink;
      let grade: Grade = null;
      let sentence: string;
      let stats: Array<[string, string, string?]>;
      if (d.isToday) {
        const on = db.onFloorNow ?? 0;
        const short = db.targetNow !== null && on < db.targetNow;
        const label = db.targetLabel ?? 'the contracted headcount';
        eyebrow = 'On the floor now';
        big = String(on);
        suffix = db.targetNow !== null ? ` / ${db.targetNow}` : '';
        bigColor = short ? C.warn : C.ink;
        sentence =
          db.targetNow === null
            ? 'No contracted headcount is set for this hour.'
            : short
              ? `${db.targetNow - on} short of ${label}.`
              : `Staffed to ${label}.`;
        stats = [
          ['Delivered', d.contract.score === null ? '—' : `${d.contract.score}%`],
          ['Punched in', `${d.summary.showed} of ${d.summary.expected}`],
          ['Unfilled', String(d.summary.open), d.summary.open > 0 ? C.warn : undefined],
        ];
      } else if (d.isFuture) {
        eyebrow = 'The day ahead';
        big = String(d.summary.expected);
        suffix = ' expected';
        sentence = d.summary.open > 0 ? `${plural(d.summary.open, 'slot')} still unfilled.` : 'Every slot is filled.';
        stats = [
          ['Shifts', String(d.waves.length)],
          ['Expected', String(d.summary.expected)],
          ['Unfilled', String(d.summary.open), d.summary.open > 0 ? C.warn : undefined],
        ];
      } else {
        const c = d.contract;
        eyebrow = 'Delivered vs contract';
        big = c.score === null ? '—' : `${c.score}%`;
        grade = c.grade;
        sentence =
          c.contractedHours > 0
            ? `${c.deliveredHours} of ${c.contractedHours} contracted person-hours were covered on the floor.`
            : c.basis === 'schedule'
              ? 'No floor target was set, so the day is graded on the schedule.'
              : 'No graded hours this day.';
        stats = [
          ['Punched in', `${d.summary.showed} of ${d.summary.expected}`],
          ['No punch', String(d.summary.missed), d.summary.missed > 0 ? C.bad : undefined],
          ['Unfilled', String(d.summary.open), d.summary.open > 0 ? C.warn : undefined],
        ];
      }
      text(eyebrow, lx, top + 18, LABEL);
      const bigTop = top + 34;
      text(big, lx, bigTop, { size: T.hero, bold: true, color: bigColor });
      let bx = lx + widthOf(big, { size: T.hero, bold: true });
      const baseline = bigTop + T.hero * ASCENT;
      if (suffix) {
        text(suffix, bx + 2, baseline - T.figure * ASCENT, { size: T.figure, bold: true, color: C.ink3 });
        bx += 2 + widthOf(suffix, { size: T.figure, bold: true });
      }
      if (grade) chip(grade, bx + 12, baseline - 24, 24);
      para(sentence, lx, top + 86, lw, { color: C.ink2 });
      const sw = lw / 3;
      stats.forEach(([label, value, color], i) => {
        text(label, lx + i * sw, top + 132, { size: T.label, color: C.ink3 });
        text(value, lx + i * sw, top + 145, { size: T.title, bold: true, color: color ?? C.ink });
      });
      const cx = M + colW(5) + GUTTER;
      text('Coverage across the day', cx, top + 18, LABEL);
      coverageChart(d, cx, top + 40, M + W - 18 - cx, 100);
    };

    const kpiTiles = (d: ReportDay) => {
      const k = d.dashboard.kpis;
      const t = k.tomorrow;
      const tomorrowTotal = t.confirmed + t.unconfirmed + t.open;
      const delta = k.fill.deltaPts;
      tiles([
        {
          label: 'Fill rate · week',
          value: k.fill.pct === null ? '—' : `${k.fill.pct}%`,
          meter: { parts: [{ value: k.fill.filled, color: C.data }], total: k.fill.total },
          sub: `${k.fill.filled} of ${k.fill.total} shifts filled`,
          note: delta === null ? undefined : delta === 0 ? 'Level with last week' : `${delta > 0 ? '+' : '–'}${Math.abs(delta)} pts vs last week`,
          noteColor: delta === null || delta === 0 ? C.ink2 : delta > 0 ? C.good : C.bad,
        },
        {
          label: 'Reliability',
          chip: k.grade.grade,
          value: k.grade.score === null ? '—' : `${k.grade.score}%`,
          meter: k.grade.score === null ? null : { parts: [{ value: Math.min(100, k.grade.score), color: C.data }], total: 100, marker: 88 },
          sub: k.grade.basis === 'schedule' ? 'Last 4 weeks · showed up' : 'Last 4 weeks · delivered',
          note: k.grade.hasHistory ? `${plural(k.grade.ncns, 'no-call no-show')}\n${k.grade.replaced} covered` : 'No completed weeks yet',
          noteColor: k.grade.ncns > 0 ? C.warn : C.ink2,
        },
        {
          label: 'Hours · week',
          value: `${fmtHours(k.hours.worked)} h`,
          meter: { parts: [{ value: k.hours.worked, color: C.data }], total: k.hours.scheduled },
          sub: `of ${fmtHours(k.hours.scheduled)} h scheduled`,
        },
        {
          label: 'Tomorrow',
          value: tomorrowTotal === 0 ? '—' : `${t.confirmed} / ${tomorrowTotal}`,
          meter: tomorrowTotal === 0 ? null : { parts: [{ value: t.confirmed, color: C.data }], total: tomorrowTotal },
          sub: tomorrowTotal === 0 ? `Nothing scheduled for ${dShort(t.date)}` : `Confirmed for ${dShort(t.date)}`,
          note:
            tomorrowTotal === 0
              ? undefined
              : t.open + t.unconfirmed === 0
                ? 'Everyone confirmed'
                : [t.open > 0 && `${t.open} unfilled`, t.unconfirmed > 0 && `${t.unconfirmed} unconfirmed`].filter(Boolean).join('\n'),
          noteColor: t.open > 0 ? C.warn : t.unconfirmed > 0 ? C.ink2 : C.good,
        },
      ]);
    };

    const shiftsCard = (d: ReportDay) => {
      const status = d.waves.map((w) => {
        const upcoming = w.groups.filter((g) => g.key === 'upcoming').flatMap((g) => g.people);
        const confirmed = upcoming.filter((p) => p.state === 'confirmed').length;
        const notIn = Math.max(0, w.expected - w.present - upcoming.length);
        const total = w.expected + w.open;
        const tail = (parts: Array<string | false>) => parts.filter(Boolean).join(' · ');
        if (w.phase === 'finished') {
          return {
            main: `${w.present} of ${w.expected} on the floor`,
            detail: tail([w.missed > 0 && `${w.missed} did not punch in`, w.open > 0 && `${w.open} unfilled`]) || 'Full crew',
            color: w.missed > 0 ? C.bad : w.open > 0 ? C.warn : C.good,
            parts: [
              { value: w.present, color: C.good },
              { value: w.missed, color: C.bad },
              { value: w.open, color: C.warn },
            ],
            total,
          };
        }
        if (w.phase === 'live') {
          return {
            main: `${w.onFloor} of ${w.expected} in`,
            detail: tail([notIn > 0 && `${notIn} not in yet`, w.open > 0 && `${w.open} unfilled`]) || 'Everyone in',
            color: w.open > 0 ? C.warn : notIn > 0 ? C.ink2 : C.good,
            parts: [
              { value: w.present, color: C.good },
              { value: notIn, color: C.ink3 },
              { value: w.open, color: C.warn },
            ],
            total,
          };
        }
        return {
          main: `${w.expected} expected`,
          detail: tail([`${confirmed} confirmed`, w.open > 0 && `${w.open} unfilled`]),
          color: w.open > 0 ? C.warn : C.ink2,
          parts: [
            { value: confirmed, color: C.data },
            { value: w.open, color: C.warn },
          ],
          total,
        };
      });
      const nameW = 150;
      const statusW = Math.max(
        120,
        ...status.map((s) => Math.max(widthOf(s.main, { size: T.body, bold: true }), widthOf(s.detail, { size: T.label }))),
      );
      tableCard(
        'Shifts',
        d.waves.length ? `${plural(d.waves.length, 'wave')} · names are on the Today page` : undefined,
        null,
        d.waves.map((w, i) => ({
          height: 36,
          draw: (x, ry, iw) => {
            const s = status[i]!;
            text(w.name, x, ry + 8, { size: T.body, bold: true });
            text(w.timeRange, x, ry + 21, { size: T.label, color: C.ink3 });
            meter(x + nameW, ry + 16, Math.max(40, iw - nameW - statusW - 20), s.parts, s.total);
            textRight(s.main, x + iw, ry + 8, { size: T.body, bold: true });
            textRight(s.detail, x + iw, ry + 21, { size: T.label, color: s.color });
          },
        })),
        d.isFuture ? 'Nothing is scheduled for this day yet.' : 'Nothing was scheduled this day.',
      );
    };

    const leadCard = (d: ReportDay): CardSpec => {
      const leads = d.dashboard.leads;
      const role = (l: DashboardSnapshot['leads'][number]) =>
        [
          l.title === 'supervisor' ? 'Shift supervisor' : 'Floor lead',
          l.onSite ? (d.isToday ? 'On site today' : 'On site that day') : d.isFuture ? '' : 'Not on site',
          l.phone ?? '',
        ]
          .filter(Boolean)
          .join(' · ');
      const empty = 'Your Alto contact is being assigned. A request lands on the right desk in the meantime.';
      const rowH = (l: DashboardSnapshot['leads'][number], w: number) =>
        paraH(l.name, w - 14, { bold: true }) + 2 + paraH(role(l), w - 14, { size: T.label });
      return {
        title: 'Your Alto lead',
        bodyHeight: (w) => (leads.length === 0 ? paraH(empty, w, { color: C.ink3 }) : leads.reduce((a, l) => a + rowH(l, w), 0) + (leads.length - 1) * 10),
        drawBody: (x, by, w) => {
          if (leads.length === 0) {
            para(empty, x, by, w, { color: C.ink3 });
            return;
          }
          let ry = by;
          for (const l of leads) {
            doc.circle(x + 3.5, ry + 4.5, 3.5).fill(l.onSite ? C.good : C.rule);
            const nh = para(l.name, x + 14, ry, w - 14, { bold: true });
            para(role(l), x + 14, ry + nh + 2, w - 14, { size: T.label, color: C.ink2 });
            ry += rowH(l, w) + 10;
          }
        },
      };
    };

    const opsCard = (d: ReportDay): CardSpec => {
      const ops = d.dashboard.ops;
      const o = ops?.today ?? ops?.lastNight ?? null;
      const title = ops?.today ? (d.isToday ? "Today's checklist" : 'Checklist') : "Last night's checklist";
      const empty = 'No checklist shifts were run.';
      const detail = o ? `${o.taskDone} of ${o.taskTotal} tasks · ${plural(o.photos, 'photo')} · ${plural(o.shifts, 'shift')}` : '';
      const flags = o
        ? [o.tempAlerts > 0 && plural(o.tempAlerts, 'temperature alert'), o.incomplete > 0 && `${o.incomplete} closed incomplete`, o.open > 0 && `${o.open} still open`]
            .filter(Boolean)
            .join(' · ')
        : '';
      const notes = o ? o.notes.slice(0, 3).map((n) => `${n.department}, ${n.period.toLowerCase()}: ${n.summary}`) : [];
      const RING = 48;
      const textBlockH = (w: number) =>
        o ? paraH(`${o.sopDone} of ${o.sopTotal} SOP steps`, w - RING - 12, { bold: true }) + 3 + paraH(detail, w - RING - 12, { size: T.label }) + (flags ? 3 + paraH(flags, w - RING - 12, { size: T.label }) : 0) : 0;
      const notesH = (w: number) => notes.reduce((a, n) => a + paraH(n, w, { size: T.label }) + 4, 0);
      return {
        title,
        meta: o ? dShort(o.dateKey) : undefined,
        bodyHeight: (w) => (o ? Math.max(RING, textBlockH(w)) + (notes.length ? 10 + notesH(w) : 0) : paraH(empty, w, { color: C.ink3 })),
        drawBody: (x, by, w) => {
          if (!o) {
            para(empty, x, by, w, { color: C.ink3 });
            return;
          }
          ring(x + RING / 2, by + RING / 2, RING / 2 - 3, o.sopTotal > 0 ? Math.round((o.sopDone / o.sopTotal) * 100) : null);
          const tx = x + RING + 12;
          const tw = w - RING - 12;
          let ty = by + 2;
          ty += para(`${o.sopDone} of ${o.sopTotal} SOP steps`, tx, ty, tw, { bold: true }) + 3;
          ty += para(detail, tx, ty, tw, { size: T.label, color: C.ink2 });
          if (flags) para(flags, tx, ty + 3, tw, { size: T.label, bold: true, color: C.warn });
          let ny = by + Math.max(RING, textBlockH(w)) + 10;
          for (const n of notes) ny += para(n, x, ny, w, { size: T.label, color: C.ink2 }) + 4;
        },
      };
    };

    const weekCard = (d: ReportDay): CardSpec => {
      const wk = d.dashboard.week;
      return {
        title: 'The week',
        meta: `${dShort(wk.start)} – ${dShort(wk.end)}`,
        bodyHeight: () => 108,
        drawBody: (x, by, w) => {
          const h = 64;
          const top = by + 12;
          const slot = w / wk.days.length;
          const max = Math.max(1, ...wk.days.map((q) => q.filled + q.open));
          wk.days.forEach((q, i) => {
            const cx = x + i * slot + slot / 2;
            const bw = Math.min(20, slot * 0.55);
            const fh = (h * q.filled) / max;
            const oh = (h * q.open) / max;
            if (fh > 0) doc.rect(cx - bw / 2, top + h - fh, bw, fh).fill(C.data);
            if (oh > 0) doc.rect(cx - bw / 2, top + h - fh - oh, bw, oh).fill(C.warn);
            if (q.filled + q.open > 0) textCenter(String(q.filled + q.open), cx, top + h - fh - oh - 11, { size: T.label, color: C.ink2 });
            const isDay = q.date === d.key;
            textCenter(fmtKey(q.date, { weekday: 'short' }), cx, top + h + 6, { size: T.label, bold: isDay, color: isDay ? C.ink : C.ink3 });
            if (isDay) hr(cx - 9, top + h + 17, 18, C.ink, 1);
          });
          hr(x, top + h, w, C.rule, 0.75);
          legend(
            [
              { color: C.data, label: 'Filled' },
              { color: C.warn, label: 'Unfilled' },
            ],
            x,
            top + h + 26,
          );
        },
      };
    };

    const reliabilityCard = (d: ReportDay): CardSpec => {
      const rel = d.dashboard.reliability;
      const tw = rel.thisWeek;
      const caption = `This week: ${plural(tw.ncns, 'no-show')} · ${plural(tw.callOuts, 'call-out')} · ${tw.lates} late · ${tw.replaced} covered`;
      return {
        title: 'Reliability',
        meta: 'Delivered vs contract',
        bodyHeight: (w) => 108 + 6 + paraH(caption, w, { size: T.label }),
        drawBody: (x, by, w) => {
          const h = 64;
          const top = by + 12;
          const slot = w / rel.weeks.length;
          const yFor = (v: number) => top + h - (h * Math.min(100, Math.max(0, v))) / 100;
          doc.moveTo(x, yFor(88)).lineTo(x + w, yFor(88)).lineWidth(0.75).dash(2.5, { space: 2 }).strokeColor(C.ink).stroke().undash();
          rel.weeks.forEach((wk, i) => {
            const cx = x + i * slot + slot / 2;
            const bw = Math.min(24, slot * 0.5);
            if (wk.reliabilityPct !== null) {
              const by2 = yFor(wk.reliabilityPct);
              if (wk.current) doc.rect(cx - bw / 2, by2, bw, top + h - by2).fillAndStroke(C.dataTint, C.data);
              else doc.rect(cx - bw / 2, by2, bw, top + h - by2).fill(C.data);
              const lbl = `${wk.reliabilityPct}%`;
              const lw = widthOf(lbl, { size: T.label });
              doc.rect(cx - lw / 2 - 2, by2 - 12, lw + 4, 10).fill(C.white);
              textCenter(lbl, cx, by2 - 11, { size: T.label, color: C.ink2 });
            } else {
              textCenter('—', cx, top + h - 11, { size: T.label, color: C.ink3 });
            }
            textCenter(wk.current ? 'This week' : dShort(wk.start), cx, top + h + 6, { size: T.label, bold: wk.current, color: wk.current ? C.ink : C.ink3 });
          });
          hr(x, top + h, w, C.rule, 0.75);
          legend(
            [
              { color: C.ink, label: 'Target 88% (grade A)', kind: 'dash' },
              { color: C.dataTint, label: 'In progress', kind: 'outline' },
            ],
            x,
            top + h + 26,
          );
          para(caption, x, by + 108 + 6, w, { size: T.label, color: tw.ncns > 0 ? C.warn : C.ink2 });
        },
      };
    };

    const clearanceCard = (d: ReportDay): CardSpec => {
      const c = d.dashboard.clearance;
      const cleared = c.total - c.checksInFlight - c.flagged;
      const line =
        c.flagged > 0
          ? `${c.flagged} flagged${c.checksInFlight > 0 ? ` · ${c.checksInFlight} in progress` : ''}`
          : c.checksInFlight > 0
            ? `${plural(c.checksInFlight, 'check')} still in progress`
            : 'Everyone on this week’s crew is cleared.';
      const empty = 'No crew was scheduled this week.';
      return {
        title: 'Crew clearance',
        bodyHeight: (w) => (c.total === 0 ? paraH(empty, w, { color: C.ink3 }) : 28 + paraH(line, w) + 4 + paraH(`I-9 complete for ${c.i9Complete} of ${c.total}`, w, { size: T.label })),
        drawBody: (x, by, w) => {
          if (c.total === 0) {
            para(empty, x, by, w, { color: C.ink3 });
            return;
          }
          text(`${cleared} of ${c.total}`, x, by, { size: T.figure, bold: true, color: c.flagged > 0 ? C.warn : cleared === c.total ? C.good : C.ink });
          const lh = para(line, x, by + 28, w, { color: c.flagged > 0 ? C.warn : C.ink2 });
          para(`I-9 complete for ${c.i9Complete} of ${c.total}`, x, by + 28 + lh + 4, w, { size: T.label, color: C.ink3 });
        },
      };
    };

    const safetyCard = (d: ReportDay): CardSpec => {
      const s = d.dashboard.safety;
      const line = `${s.monthIncidents === 0 ? 'No incidents this month' : `${plural(s.monthIncidents, 'incident')} this month`}${s.open > 0 ? ` · ${s.open} open` : ''}`;
      return {
        title: 'Safety',
        bodyHeight: (w) => 28 + paraH('Days since the last incident', w, { size: T.label }) + 4 + paraH(line, w),
        drawBody: (x, by, w) => {
          text(s.daysSinceLast === null ? '365+' : String(s.daysSinceLast), x, by, { size: T.figure, bold: true, color: s.open > 0 ? C.warn : C.good });
          const lh = para('Days since the last incident', x, by + 28, w, { size: T.label, color: C.ink3 });
          para(line, x, by + 28 + lh + 4, w, { color: s.open > 0 ? C.warn : C.ink2 });
        },
      };
    };

    const statementsCard = (d: ReportDay): CardSpec => {
      const list = d.dashboard.statements.slice(0, 3);
      const empty = 'No statements issued yet.';
      return {
        title: 'Statements',
        bodyHeight: (w) => (list.length === 0 ? paraH(empty, w, { color: C.ink3 }) : list.length * 30 - 6),
        drawBody: (x, by, w) => {
          if (list.length === 0) {
            para(empty, x, by, w, { color: C.ink3 });
            return;
          }
          list.forEach((st, i) => {
            const ry = by + i * 30;
            if (i > 0) hr(x, ry - 6, w);
            text(st.number !== null ? `No. ${String(st.number).padStart(4, '0')}` : 'Statement', x, ry, { bold: true });
            text(`${dShort(st.periodStart)} – ${dShort(st.periodEnd)}${st.hours !== null ? ` · ${fmtHours(st.hours)} h` : ''}`, x, ry + 13, { size: T.label, color: C.ink3 });
            textRight(st.amount !== null ? money(st.amount) : '—', x + w, ry, { bold: true });
            textRight(st.paid ? 'Paid' : 'Due', x + w, ry + 13, { size: T.label, bold: true, color: st.paid ? C.good : C.warn });
          });
        },
      };
    };

    const requestsCard = (d: ReportDay) => {
      const rq = d.dashboard.requests;
      const dateW = 50;
      const typeW = 70;
      const statusW = 66;
      const iw = W - PAD * 2;
      const subjectW = iw - dateW - typeW - statusW - 12;
      tableCard(
        'Requests',
        [rq.open.length > 0 && plural(rq.open.length, 'open request'), rq.loggedToday > 0 && `${rq.loggedToday} logged ${d.isToday ? 'today' : 'this day'}`].filter(Boolean).join(' · ') || undefined,
        rq.open.length
          ? [
              { label: 'Opened', x: 0 },
              { label: 'Type', x: dateW },
              { label: 'Subject', x: dateW + typeW },
              { label: 'Status', x: iw, right: true },
            ]
          : null,
        rq.open.map((r) => {
          const sh = paraH(r.subject, subjectW);
          const status = r.overdue ? 'Past reply-by' : r.status === 'IN_PROGRESS' ? 'In progress' : 'Received';
          return {
            height: Math.max(24, sh + 10),
            draw: (x, ry, w) => {
              text(dShort(r.at), x, ry + 6, { size: T.label, color: C.ink2 });
              text(r.kind, x + dateW, ry + 6, { size: T.label, caps: true, color: C.ink2 });
              para(r.subject, x + dateW + typeW, ry + 5, subjectW);
              textRight(status, x + w, ry + 6, { size: T.label, bold: r.overdue, color: r.overdue ? C.bad : C.ink2 });
            },
          };
        }),
        'Nothing is open with Alto.',
      );
    };

    const dayBody = (d: ReportDay) => {
      hero(d);
      kpiTiles(d);
      shiftsCard(d);
      cardsRow([leadCard(d), opsCard(d)], [6, 6]);
      cardsRow([weekCard(d), reliabilityCard(d)], [6, 6]);
      cardsRow([clearanceCard(d), safetyCard(d), statementsCard(d)], [4, 4, 4]);
      requestsCard(d);
    };

    /* ---- masthead (page one) -------------------------------------------- */
    const [genKey = '', ...genRest] = data.generatedAt.split(' ');
    const prepared = `Prepared ${/^\d{4}-\d{2}-\d{2}$/.test(genKey) ? dFull(genKey) : genKey}${genRest.length ? `, ${genRest.join(' ')} ET` : ''}`;
    const single = data.days.length === 1 ? data.days[0]! : null;
    const snapshotNote = data.isRange
      ? `${plural(data.days.length, 'day')}, each as of the close of day`
      : single?.isToday
        ? 'Live snapshot'
        : single?.isFuture
          ? 'The schedule as it stands'
          : 'As of the close of day';
    const MAST_H = 100;
    doc.rect(0, 0, PAGE_W, MAST_H).fill(C.ink);
    doc.rect(0, MAST_H, PAGE_W, 2.5).fill(C.brand);
    text(`${data.orgName} · Service report`, M, 28, { ...LABEL, color: C.brand });
    const storeStyle: Style = { size: widthOf(where, { size: T.figure, bold: true }) > colW(7) ? T.title : T.figure, bold: true, color: C.white };
    text(where, M, 44, storeStyle);
    text(data.storeName ? data.clientName : 'All stores', M, 72, { color: C.mastSub });
    textRight(data.isRange ? 'Period' : 'Report date', M + W, 28, { ...LABEL, color: C.mastSub });
    textRight(data.isRange ? dSpan(data.from, data.to) : dWeekday(data.from), M + W, 44, { size: T.title, bold: true, color: C.white });
    textRight(prepared, M + W, 64, { size: T.label, color: C.mastSub });
    textRight(snapshotNote, M + W, 76, { size: T.label, color: C.mastSub });
    y = MAST_H + 2.5 + 22;

    /* ---- body ------------------------------------------------------------ */
    if (!data.isRange) {
      dayBody(data.days[0]!);
    } else {
      const tt = data.totals;
      tiles([
        {
          label: 'Delivered',
          chip: tt.grade,
          value: tt.score === null ? '—' : `${tt.score}%`,
          meter: tt.score === null ? null : { parts: [{ value: Math.min(100, tt.score), color: C.data }], total: 100, marker: 88 },
          sub: tt.contractedHours > 0 ? `${tt.deliveredHours} of ${tt.contractedHours} contracted person-hours` : 'No contracted hours in the period',
        },
        {
          label: 'On the floor',
          value: `${tt.showed} of ${tt.expected}`,
          meter: { parts: [{ value: tt.showed, color: C.good }], total: tt.expected },
          sub: 'Punched in, of those expected',
        },
        {
          label: 'No punch',
          value: String(tt.missed),
          valueColor: tt.missed > 0 ? C.bad : C.ink,
          meter: { parts: [{ value: tt.missed, color: C.bad }], total: tt.expected },
          sub: 'Shifts that ended with no punch',
        },
        {
          label: 'Unfilled',
          value: String(tt.open),
          valueColor: tt.open > 0 ? C.warn : C.ink,
          meter: { parts: [{ value: tt.open, color: C.warn }], total: tt.expected + tt.open },
          sub: 'Open slots across the period',
        },
      ]);
      const iw = W - PAD * 2;
      const numW = 58;
      const dayW = 104;
      const barX = dayW;
      const barW = iw - dayW - numW * 4 - 44;
      tableCard(
        'Day by day',
        'Each day follows on its own pages',
        [
          { label: 'Day', x: 0 },
          { label: 'Delivered vs contract', x: barX },
          { label: 'On floor', x: iw - numW * 3, right: true },
          { label: 'No punch', x: iw - numW * 2, right: true },
          { label: 'Unfilled', x: iw - numW, right: true },
          { label: 'Grade', x: iw, right: true },
        ],
        data.days.map((d) => ({
          height: 24,
          draw: (x, ry, w) => {
            text(dWeekdayShort(d.key), x, ry + 8, { bold: true });
            const sc = d.contract.score;
            meter(x + barX, ry + 11, barW, sc === null ? [] : [{ value: Math.min(100, sc), color: C.data }], 100, 88);
            text(sc === null ? (d.isFuture ? 'Upcoming' : '—') : `${sc}%`, x + barX + barW + 8, ry + 8, { size: T.label, color: C.ink2 });
            textRight(`${d.summary.showed} of ${d.summary.expected}`, x + w - numW * 3, ry + 8);
            textRight(String(d.summary.missed), x + w - numW * 2, ry + 8, { color: d.summary.missed > 0 ? C.bad : C.ink3 });
            textRight(String(d.summary.open), x + w - numW, ry + 8, { color: d.summary.open > 0 ? C.warn : C.ink3 });
            textRight(d.contract.grade ?? '—', x + w, ry + 8, { bold: true, color: gradeColor(d.contract.grade) });
          },
        })),
        'No days in the period.',
      );
      data.days.forEach((d, i) => {
        newPage();
        text(dWeekday(d.key), M, y, { size: T.figure, bold: true });
        text(
          `Day ${i + 1} of ${data.days.length} · ${d.isToday ? 'Live snapshot' : d.isFuture ? 'The schedule as it stands' : 'As of the close of day'}`,
          M,
          y + 27,
          { size: T.label, color: C.ink3 },
        );
        hr(M, y + 44, W, C.rule, 0.75);
        y += 44 + 18;
        dayBody(d);
      });
    }

    /* ---- running header + footer on every page ---------------------------- */
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      if (i > 0) {
        text(`${data.orgName} · Service report`, M, 28, LABEL);
        textRight(`${where} · ${dSpan(data.from, data.to)}`, M + W, 28, { size: T.label, color: C.ink3 });
        hr(M, 42, W, C.rule, 0.75);
      }
      hr(M, PAGE_H - 44, W, C.rule, 0.75);
      text(`Confidential · Prepared for ${data.clientName} by ${data.orgName}`, M, PAGE_H - 34, { size: T.label, color: C.ink3 });
      textRight(`Page ${i + 1} of ${pages.count}`, M + W, PAGE_H - 34, { size: T.label, color: C.ink3 });
    }
    doc.end();
  });
}
