import type { Prisma, PrismaClient } from '@prisma/client';
import { ON_THE_BOOKS_STATUSES, TURNOVER_TRAILING_DAYS, type ExecKpi, type ExecPeople, type ExecPeopleWeek, type ExecTrendPoint } from '@alto-people/shared';
import { env } from '../config/env.js';
import { placements } from './activeDefinition.js';
import { activeCountsAt, fillCounts, loadPlan, plural, wholeHours } from './execFinance.js';
import { buildKpi, KPI_SPECS } from './execOverview.js';
import { lastCompleteWeeks, quarterOf, quartersBetween, type ExecWindow } from './execPeriods.js';
import { fmtDayRange } from './humanDates.js';
import { loadPaidHours, round2, totalPaid } from './paidHours.js';
import { countStandings, hiresBetween, onTheBooksAt, peopleStandings, separationsBetween, turnoverBetween } from './peopleStatus.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import { tenantIdForWrite } from './tenant.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { localDateKey, addDaysToKey, dateColumnKey } from './timezone.js';

/**
 * The chairman's workforce page (GET /executive/people, and the board
 * pack's people page).
 *
 *   kpis        workforce, hires, turnover, overtime — workforce, turnover
 *               and overtime are the overview scorecard's own measures
 *               (lib/execOverview KPI_SPECS + buildKpi, the active count at
 *               each instant from lib/execFinance), so the tile here and the
 *               tile on the home screen are one number
 *   counts      lib/peopleStatus, exactly: the numbers the People directory,
 *               Headcount and Analytics show
 *   weeks       the last 13 complete weeks: active at each week's end, hires
 *               and separations (peopleStatus's hire and leave dates), PAID
 *               hours and overtime (lib/paidHours — the executive summary's
 *               math), unexcused attendance events
 *   turnover    the period's annualized rate against the plan, and the churn
 *               bill: separations in 90 days × the configured cost of one
 *   attendance  unexcused events per store per week (8 weeks), and per 100
 *               assigned shifts there — the event's shift's store, else the
 *               person's placement
 *   tenure      the working (active) people by time since hire
 *   newHires    hired in the last 90 days with the start date arrived —
 *               never a future start shown as "new to the team"
 *   topWorkers  most paid hours in the last 4 complete weeks with no
 *               unexcused event in them
 *   anniversaries  work anniversaries in the next 14 days
 */

export type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const TREND_WEEKS = 13;
const ATTENDANCE_WEEKS = 8;
const TOP_WEEKS = 4;
const NEW_HIRE_DAYS = 90;
const ANNIVERSARY_DAYS = 14;

/** Hires have no line in the plan; the scorecard tracks them without a target. */
const HIRES_SPEC = {
  id: 'hires' as const,
  label: 'Hires',
  sentence: 'Hires',
  unit: 'count' as const,
  betterWhen: 'up' as const,
  basis: 'live' as const,
  definition: 'People whose hire date falls in the period: the hire date on file, else the day their application was approved.',
  href: '/headcount',
};

const pct = (a: number, b: number): number | null => (b > 0 ? (a / b) * 100 : null);
const pct1 = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const addDaysKey = (key: string, days: number): string => addDaysToKey(key, days);

export const TENURE_BANDS = ['Under 90 days', '3–12 months', '1–2 years', '2 years or more'] as const;

export function tenureBand(hiredOn: Date, now: Date): (typeof TENURE_BANDS)[number] {
  const days = (now.getTime() - hiredOn.getTime()) / DAY_MS;
  if (days < 90) return TENURE_BANDS[0];
  if (days < 365) return TENURE_BANDS[1];
  if (days < 730) return TENURE_BANDS[2];
  return TENURE_BANDS[3];
}

export async function computeExecPeople(db: Db, w: ExecWindow): Promise<ExecPeople> {
  const tenantId = tenantIdForWrite();
  const now = new Date(w.period.asOf);
  const tz = w.timezone;
  const today = localDateKey(now, tz);
  const periodEnd = new Date(Math.min(w.to.getTime(), now.getTime()));
  const weekStarts = lastCompleteWeeks(now, TREND_WEEKS);
  const weeksEnd = startOfWeekUTC(now);
  const weekEnds = weekStarts.map((_, i) => weekStarts[i + 1] ?? weeksEnd);
  const weekKeys = weekStarts.map((d) => localDateKey(d, tz));
  const hasCompare = !!(w.compareFrom && w.compareTo);
  const quarterKeys = quartersBetween(w.from, w.to, tz).map((q) => q.key);
  if (quarterKeys.length === 0) quarterKeys.push(quarterOf(w.from, tz).key);
  const instants = [periodEnd, ...weekEnds, ...(hasCompare ? [w.compareTo!] : [])];
  const attFrom = weekStarts[TREND_WEEKS - ATTENDANCE_WEEKS]!;
  const readFrom = new Date(Math.min(w.from.getTime(), weekStarts[0]!.getTime()));
  const readTo = new Date(Math.max(w.to.getTime(), weeksEnd.getTime()));

  const [standings, active, plan, shares, compareShares, compareFill, events, attShifts, placed, sites] = await Promise.all([
    peopleStandings({ tenantId }, now, db),
    activeCountsAt(db, tenantId, instants),
    loadPlan(db, tenantId, quarterKeys),
    loadPaidHours(db, { tenantId, from: readFrom, to: readTo }),
    hasCompare ? loadPaidHours(db, { tenantId, from: w.compareFrom!, to: w.compareTo! }) : Promise.resolve([]),
    hasCompare ? fillCounts(db, tenantId, w.compareFrom!, w.compareTo!) : Promise.resolve(null),
    db.attendanceEvent.findMany({
      where: { tenantId, excusedAt: null, occurredOn: { gte: new Date(`${weekKeys[0]}T00:00:00Z`), lt: new Date(`${localDateKey(weeksEnd, tz)}T00:00:00Z`) } },
      select: { associateId: true, shiftId: true, occurredOn: true },
      take: 100_000,
    }),
    db.shift.findMany({
      where: { tenantId, assignedAssociateId: { not: null }, status: { notIn: ['CANCELLED', 'DRAFT'] }, startsAt: { gte: attFrom, lt: weeksEnd } },
      select: { id: true, locationId: true, startsAt: true },
      take: 200_000,
    }),
    placements({ tenantId }, db),
    db.site.findMany({ where: { tenantId }, select: { id: true, name: true } }),
  ]);

  const counts = countStandings(standings);
  const lastQuarter = quarterKeys[quarterKeys.length - 1]!;
  const qPlan = plan.get(lastQuarter) ?? null;
  const qLabel = quarterKeys.length === 1 ? `Q${quarterKeys[0]!.slice(-1)}` : `Q${quarterKeys[0]!.slice(-1)}–Q${lastQuarter.slice(-1)}`;

  // ----- The comparison: none when the span holds no recorded work (the overview's rule).
  const current = totalPaid(shares, w.from, w.to);
  const compared = hasCompare ? totalPaid(compareShares, w.compareFrom!, w.compareTo!) : null;
  const comparison = { ...w.comparison };
  if (hasCompare && compared && compared.hours === 0 && (compareFill?.published ?? 0) === 0) {
    comparison.available = false;
    comparison.reason = `There is no recorded work for ${fmtDayRange(comparison.start, comparison.end)} to compare against.`;
  }
  const planMode = comparison.key === 'plan';
  const cmp = <T>(v: T | null): T | null => (comparison.available && !planMode ? v : null);
  const trendOf = (values: Array<number | null>): ExecTrendPoint[] => weekKeys.map((start, i) => ({ start, value: values[i] ?? null }));
  const activeAt = (d: Date) => active.get(d.getTime()) ?? null;
  const weekly = weekStarts.map((s, i) => totalPaid(shares, s, weekEnds[i]!));

  // ----- Unexcused events by week (and by store, below).
  const shiftIds = [...new Set(events.map((e) => e.shiftId).filter((id): id is string => !!id))];
  const known = new Map(attShifts.map((s) => [s.id, s.locationId]));
  const missing = shiftIds.filter((id) => !known.has(id));
  if (missing.length) {
    for (const s of await db.shift.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, locationId: true } })) known.set(s.id, s.locationId);
  }
  const weekOfKey = (key: string): number => {
    for (let i = weekKeys.length - 1; i >= 0; i--) if (key >= weekKeys[i]!) return i;
    return -1;
  };
  const unexcusedByWeek = new Array<number>(TREND_WEEKS).fill(0);
  const eventsBy = new Map<string, number>();
  for (const e of events) {
    const i = weekOfKey(dateColumnKey(e.occurredOn));
    if (i < 0) continue;
    unexcusedByWeek[i]! += 1;
  }

  // ----- KPIs
  const headTarget = qPlan?.headcount ?? null;
  const workforce = buildKpi(KPI_SPECS.workforce, {
    value: activeAt(periodEnd),
    compare: planMode ? headTarget : cmp(hasCompare ? activeAt(w.compareTo!) : null),
    target: headTarget,
    targetLabel: headTarget !== null ? `${qLabel} plan ${headTarget.toLocaleString('en-US')} active` : null,
    sub: `of ${onTheBooksAt(standings, periodEnd).toLocaleString('en-US')} on the books`,
    trend: trendOf(weekEnds.map((d) => activeAt(d))),
  });

  const hires = hiresBetween(standings, w.from, periodEnd);
  const separations = separationsBetween(standings, w.from, periodEnd);
  const net = hires - separations;
  const hiresKpi = buildKpi(HIRES_SPEC, {
    value: hires,
    compare: planMode ? null : cmp(hasCompare ? hiresBetween(standings, w.compareFrom!, w.compareTo!) : null),
    target: null,
    targetLabel: null,
    sub: `${plural(separations, 'separation')} · net ${net > 0 ? '+' : net < 0 ? '−' : ''}${Math.abs(net)}`,
    trend: trendOf(weekStarts.map((s, i) => hiresBetween(standings, s, weekEnds[i]!))),
    status: { status: 'none', label: 'No hiring target' },
  });

  const turn = turnoverBetween(standings, w.from, periodEnd);
  const turnTarget = qPlan?.turnoverPct ?? null;
  const turnover = buildKpi(KPI_SPECS.turnover, {
    value: turn.annualizedPct,
    compare: planMode ? turnTarget : cmp(hasCompare ? turnoverBetween(standings, w.compareFrom!, w.compareTo!).annualizedPct : null),
    target: turnTarget,
    targetLabel: turnTarget !== null ? `${qLabel} plan ${turnTarget.toFixed(1)}% a year` : null,
    sub: `${plural(turn.separations, 'separation')} in the period`,
    trend: trendOf(weekEnds.map((d) => turnoverBetween(standings, new Date(d.getTime() - 28 * DAY_MS), d).annualizedPct)),
  });

  const overtimePct = buildKpi(KPI_SPECS.overtimePct, {
    value: pct(current.otHours, current.hours),
    compare: planMode ? null : cmp(compared ? pct(compared.otHours, compared.hours) : null),
    target: null,
    targetLabel: null,
    sub: `${wholeHours(current.otHours)} overtime hours`,
    trend: trendOf(weekly.map((x) => pct(x.otHours, x.hours))),
    thresholds: { good: 5, watch: 10 },
  });
  const kpis: ExecKpi[] = [workforce, hiresKpi, turnover, overtimePct];

  // ----- The 13 weeks
  const weeks: ExecPeopleWeek[] = weekStarts.map((s, i) => ({
    start: weekKeys[i]!,
    active: activeAt(weekEnds[i]!) ?? 0,
    hires: hiresBetween(standings, s, weekEnds[i]!),
    separations: separationsBetween(standings, s, weekEnds[i]!),
    hours: weekly[i]!.hours,
    otHours: weekly[i]!.otHours,
    otPct: pct1(weekly[i]!.otHours, weekly[i]!.hours),
    unexcused: unexcusedByWeek[i]!,
  }));

  // ----- Attendance by store: events (the shift's store, else the person's placement) per 100 assigned shifts.
  const attKeys = weekKeys.slice(TREND_WEEKS - ATTENDANCE_WEEKS);
  const attIndex = (key: string): number => {
    for (let i = attKeys.length - 1; i >= 0; i--) if (key >= attKeys[i]!) return i;
    return -1;
  };
  const NO_STORE = 'none';
  const shiftsBy = new Map<string, number>();
  for (const s of attShifts) {
    if (!s.locationId) continue;
    const i = attIndex(localDateKey(s.startsAt, tz));
    if (i < 0) continue;
    const k = `${s.locationId}|${i}`;
    shiftsBy.set(k, (shiftsBy.get(k) ?? 0) + 1);
  }
  for (const e of events) {
    const i = attIndex(dateColumnKey(e.occurredOn));
    if (i < 0) continue;
    const site = (e.shiftId ? known.get(e.shiftId) : null) ?? placed.get(e.associateId)?.locationId ?? NO_STORE;
    const k = `${site}|${i}`;
    eventsBy.set(k, (eventsBy.get(k) ?? 0) + 1);
  }
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const siteTotals = new Map<string, { events: number; shifts: number }>();
  for (const [k, n] of eventsBy) {
    const id = k.split('|')[0]!;
    const t = siteTotals.get(id) ?? { events: 0, shifts: 0 };
    t.events += n;
    siteTotals.set(id, t);
  }
  for (const [k, n] of shiftsBy) {
    const id = k.split('|')[0]!;
    const t = siteTotals.get(id) ?? { events: 0, shifts: 0 };
    t.shifts += n;
    siteTotals.set(id, t);
  }
  const attSites = [...siteTotals.entries()]
    .map(([id, t]) => ({ id, name: id === NO_STORE ? 'No store on record' : (siteName.get(id) ?? 'A store no longer on file'), ...t }))
    .sort((a, b) => b.events - a.events || b.shifts - a.shifts || a.name.localeCompare(b.name));
  const attendance = {
    sites: attSites.map(({ id, name }) => ({ id, name })),
    weeks: attKeys,
    cells: attSites.flatMap((s) =>
      attKeys.map((week, i) => {
        const ev = eventsBy.get(`${s.id}|${i}`) ?? 0;
        const sh = shiftsBy.get(`${s.id}|${i}`) ?? 0;
        return { siteId: s.id, week, events: ev, perHundredShifts: sh > 0 ? Math.round((ev / sh) * 1000) / 10 : null };
      }),
    ),
  };

  // ----- Tenure of the working people
  const bandCounts = new Map<string, number>(TENURE_BANDS.map((b) => [b, 0]));
  for (const p of standings.people.values()) {
    if (p.status !== 'ACTIVE' || !p.hiredOn) continue;
    const b = tenureBand(p.hiredOn, now);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
  }
  const tenure = TENURE_BANDS.map((band) => ({ band, count: bandCounts.get(band) ?? 0 }));

  // ----- Faces: new hires, the strongest four weeks, anniversaries
  const onBooks = [...standings.people.values()].filter((p) => ON_THE_BOOKS_STATUSES.includes(p.status));
  const newCandidates = onBooks.filter((p) => p.hiredOn && now.getTime() - p.hiredOn.getTime() <= NEW_HIRE_DAYS * DAY_MS).map((p) => p.id);

  const topFrom = weekStarts[TREND_WEEKS - TOP_WEEKS]!;
  const topFromKey = weekKeys[TREND_WEEKS - TOP_WEEKS]!;
  const flagged = new Set(events.filter((e) => dateColumnKey(e.occurredOn) >= topFromKey).map((e) => e.associateId));
  const onBooksIds = new Set(onBooks.map((p) => p.id));
  const hoursBy = new Map<string, number>();
  for (const s of shares) {
    if (s.entry.clockInAt < topFrom || s.entry.clockInAt >= weeksEnd) continue;
    hoursBy.set(s.entry.associateId, (hoursBy.get(s.entry.associateId) ?? 0) + s.hours);
  }
  const topIds = [...hoursBy.entries()]
    .filter(([id, h]) => h > 0 && !flagged.has(id) && onBooksIds.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const faceIds = [...new Set([...newCandidates, ...topIds.map(([id]) => id), ...onBooks.map((p) => p.id)])];
  const faces = faceIds.length
    ? await db.associate.findMany({
        where: { tenantId, id: { in: faceIds }, deletedAt: null, erasedAt: null },
        select: { id: true, firstName: true, lastName: true, hireDate: true, photoS3Key: true, photoUpdatedAt: true },
      })
    : [];
  const face = new Map(faces.map((f) => [f.id, f]));
  const nameOf = (id: string) => {
    const f = face.get(id);
    return f ? `${f.firstName} ${f.lastName}`.trim() : null;
  };
  /** The hire date as a calendar day: the one on file, else the day peopleStatus dates the hire. */
  const hireKey = (id: string): string | null => {
    const raw = face.get(id)?.hireDate;
    if (raw) return dateColumnKey(raw);
    const h = standings.people.get(id)?.hiredOn;
    return h ? localDateKey(h, tz) : null;
  };

  const newHires = newCandidates
    .map((id) => ({ id, key: hireKey(id) }))
    .filter((x): x is { id: string; key: string } => !!x.key && x.key <= today && !!face.get(x.id))
    .sort((a, b) => b.key.localeCompare(a.key) || (nameOf(a.id) ?? '').localeCompare(nameOf(b.id) ?? ''))
    .slice(0, 8)
    .map(({ id, key }) => ({ id, name: nameOf(id)!, photoUrl: profilePhotoUrlFor(face.get(id)!), hireDate: key }));

  const topWorkers = topIds
    .filter(([id]) => face.has(id))
    .map(([id, h]) => ({ id, name: nameOf(id)!, photoUrl: profilePhotoUrlFor(face.get(id)!), hours: round2(h) }));

  const horizon = addDaysKey(today, ANNIVERSARY_DAYS);
  const anniversaries: ExecPeople['anniversaries'] = [];
  for (const p of onBooks) {
    const key = hireKey(p.id);
    if (!key || !face.has(p.id) || key > today) continue;
    const [hy, hm, hd] = key.split('-').map(Number) as [number, number, number];
    const ty = Number(today.slice(0, 4));
    for (const y of [ty, ty + 1]) {
      // 29 February is celebrated on the 28th in a common year.
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const day = hm === 2 && hd === 29 && !leap ? 28 : hd;
      const date = `${y}-${String(hm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const years = y - hy;
      if (years >= 1 && date >= today && date <= horizon) {
        anniversaries.push({ id: p.id, name: nameOf(p.id)!, years, date });
        break;
      }
    }
  }
  anniversaries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  // The trailing 90 days (METRICS.turnover90d): the rate, the count and the
  // cost all read the same span, so the card's number and its words agree.
  const since90 = new Date(now.getTime() - TURNOVER_TRAILING_DAYS * DAY_MS);
  const separations90d = separationsBetween(standings, since90, now);
  const turnover90d = turnoverBetween(standings, since90, now);

  return {
    period: w.period,
    comparison,
    kpis,
    counts: {
      active: counts.ACTIVE,
      onTheBooks: counts.onTheBooks,
      onboarding: counts.ONBOARDING,
      deactivated: counts.DEACTIVATED,
      placedNotActive: counts.PLACED_NOT_ACTIVE,
      notPlaced: counts.NOT_PLACED,
    },
    weeks,
    turnover: {
      annualizedPct: turn.annualizedPct,
      targetPct: turnTarget,
      separations90d,
      estCost90d: round2(separations90d * env.EXEC_COST_PER_SEPARATION),
      annualizedPct90d: turnover90d.annualizedPct,
    },
    attendance,
    tenure,
    newHires,
    topWorkers,
    anniversaries: anniversaries.slice(0, 12),
  };
}
