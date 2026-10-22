// Executive summary — the numbers a chairman reads, computed once and
// reused by three surfaces: GET /executive/summary (the executive
// dashboard), GET /executive/board-pack.pdf, and the Saturday-morning
// executive digest email. Weeks are the org week (Saturday 00:00 →
// Friday 24:00, Florida-local) via the canonical helpers.
//
// Dollar figures are ESTIMATES at the org standard rates (env-configured
// pay/bill defaults + labor burden) — the same convention as the labor
// board. Statements remain the invoice-grade source of truth.

import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { activeBreakdown } from './activeDefinition.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { loadLiveRules } from './laborRules/live.js';
import { payFor, splitByPerson, type EntryHours, type HoursSplit, type LaborSite } from './laborRules/hours.js';
import { tenantIdForWrite } from './tenant.js';

const DAY_MS = 24 * 3600_000;
/** Complete org weeks in the trend series (newest last = last week). */
const TREND_WEEKS = 8;

export interface ExecutiveWeek {
  /** ISO instant of the org-week start (Sat 00:00 FL-local). */
  start: string;
  /** Exclusive end used for the aggregation (week end, or "now" for the current partial week). */
  end: string;
  workedHours: number;
  /** Hours paid above straight time: overtime plus double time, split by the labor-rules engine exactly as pay splits them. */
  otHours: number;
  /** The double-time part of otHours (a live jurisdiction's daily rule; 0 elsewhere). */
  doubleTimeHours?: number;
  /**
   * What the multipliers add, in straight-time hours: half an hour per
   * overtime hour at 1.5×, a whole one per double-time hour at 2×. A rate
   * what-if prices the week as (workedHours + premiumHours) × rate.
   */
  premiumHours?: number;
  headsWorked: number;
  estBilled: number;
  estLaborCost: number;
  estMargin: number;
}

export interface ExecutiveSummary {
  generatedAt: string;
  workforce: {
    active: number;
    deactivated: number;
    hires30d: number;
    separations30d: number;
    onboardingInFlight: number;
  };
  /** Last COMPLETE org week. */
  lastWeek: ExecutiveWeek;
  /** Current (partial) org week, aggregated through generation time. */
  thisWeek: ExecutiveWeek;
  /** The last TREND_WEEKS complete org weeks, oldest first (the final
   *  element is lastWeek) — feeds the dashboard's trend charts and the
   *  board pack's trend table. */
  trend: ExecutiveWeek[];
  attendance30d: Array<{ kind: string; count: number }>;
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>;
  /** Faces for the "new this month" band — name + photo only. */
  newHires30d: Array<{
    id: string;
    name: string;
    photoUrl: string | null;
    hireDate: string | null;
  }>;
  /** The rate assumptions behind every est. figure — feeds the web
   *  what-if calculator so it starts from reality. */
  rates: {
    payRate: number;
    billRate: number;
    burdenPct: number;
    overheadPerHour: number;
  };
  /** Store profitability league — last 4 complete org weeks, best margin
   *  first. Each store wears the overtime of the hours worked there: the
   *  engine fills a person's week chronologically, so the store whose
   *  shift ran past the line carries it. */
  league: Array<{
    clientId: string;
    clientName: string;
    locationId: string;
    locationName: string;
    hours: number;
    otHours: number;
    estBilled: number;
    estMargin: number;
  }>;
  /** Revenue concentration — est. billed share per client over the same
   *  4 weeks, largest first. */
  concentration: Array<{ clientId: string; clientName: string; sharePct: number }>;
  /** The churn bill: separations in the last 90 days × the configured
   *  fully-loaded cost per separation. */
  turnover: { separations90d: number; costPerSeparation: number; estCost90d: number };
}

interface EntryRow {
  associateId: string;
  clientId: string | null;
  locationId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
  site: LaborSite | null;
}

/** Each entry's hours as pay splits them (lib/laborRules/hours), and the person's multipliers. */
interface Split {
  byEntry: Map<EntryRow, EntryHours>;
  byPerson: Map<string, HoursSplit>;
}

/** Est. billed and est. labor cost for a share of hours, at the standard rates and the split's multipliers. */
function priceShare(share: Pick<EntryHours, 'workedHours' | 'regularHours' | 'overtimeHours' | 'doubleTimeHours'>, m: HoursSplit): { billed: number; cost: number } {
  const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
  return {
    billed: payFor(share, env.DEFAULT_ASSOCIATE_BILL_RATE, m),
    cost: payFor(share, env.DEFAULT_ASSOCIATE_PAY_RATE, m) * burden + share.workedHours * env.LABOR_OVERHEAD_PER_HOUR,
  };
}

function aggregateWeek(
  entries: EntryRow[],
  split: Split,
  start: Date,
  end: Date,
): ExecutiveWeek {
  const heads = new Set<string>();
  let workedHours = 0;
  let otHours = 0;
  let dtHours = 0;
  let premiumHours = 0;
  // Overtime and double time are billed and paid at the engine's multipliers on both sides of the ledger.
  let estBilled = 0;
  let estLaborCost = 0;
  for (const e of entries) {
    if (e.clockInAt < start || e.clockInAt >= end) continue;
    const share = split.byEntry.get(e);
    if (!share || share.workedHours <= 0) continue;
    heads.add(e.associateId);
    workedHours += share.workedHours;
    otHours += share.overtimeHours + share.doubleTimeHours;
    dtHours += share.doubleTimeHours;
    const m = split.byPerson.get(e.associateId)!;
    premiumHours += share.overtimeHours * (m.overtimeMultiplier - 1) + share.doubleTimeHours * (m.doubleMultiplier - 1);
    const p = priceShare(share, m);
    estBilled += p.billed;
    estLaborCost += p.cost;
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    workedHours: Math.round(workedHours * 100) / 100,
    otHours: Math.round(otHours * 100) / 100,
    ...(dtHours > 0 ? { doubleTimeHours: Math.round(dtHours * 100) / 100 } : {}),
    premiumHours: Math.round(premiumHours * 100) / 100,
    headsWorked: heads.size,
    estBilled: Math.round(estBilled * 100) / 100,
    estLaborCost: Math.round(estLaborCost * 100) / 100,
    estMargin: Math.round((estBilled - estLaborCost) * 100) / 100,
  };
}

export async function computeExecutiveSummary(
  prisma: PrismaClient,
  now: Date = new Date(),
  /** Brief 2-1: the tenant to read, until enforce mode filters every query. Absent = no filter (unchanged). */
  opts: { tenantId?: string } = {},
): Promise<ExecutiveSummary> {
  const T = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const thisWeekStart = startOfWeekUTC(now);
  // Walk week boundaries backwards — 36h back from a boundary lands
  // safely inside the previous org week regardless of DST week lengths.
  // weekStarts[0] = thisWeekStart, [1] = last week, … [TREND_WEEKS] = oldest.
  const weekStarts: Date[] = [thisWeekStart];
  for (let i = 0; i < TREND_WEEKS; i++) {
    weekStarts.push(
      startOfWeekUTC(new Date(weekStarts[i].getTime() - 36 * 3600_000)),
    );
  }
  const lastWeekStart = weekStarts[1];
  const oldestStart = weekStarts[TREND_WEEKS];
  const thirtyAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [
    rawEntries,
    active,
    deactivated,
    hires30d,
    separations30d,
    separations90d,
    onboardingInFlight,
    attendanceRows,
    openAssignments,
    newHireRows,
  ] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { ...T,
        status: { in: ['APPROVED', 'COMPLETED'] },
        clockInAt: { gte: oldestStart, lt: now },
      },
      select: {
        associateId: true,
        clientId: true,
        locationId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
        location: { select: { id: true, state: true, city: true, timezone: true } },
      },
      take: 50_000,
    }),
    // Brief 1A-2: the one definition of active.
    activeBreakdown(now, prisma, undefined, { tenantId: opts.tenantId }),
    prisma.associate.count({
      where: { ...T, deletedAt: null, deactivatedAt: { not: null } },
    }),
    prisma.associate.count({
      where: { ...T, deletedAt: null, hireDate: { gte: thirtyAgo } },
    }),
    prisma.associate.count({
      where: { ...T, separatedAt: { gte: thirtyAgo } },
    }),
    prisma.associate.count({
      where: { ...T, separatedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
    }),
    prisma.application.count({
      where: { ...T,
        deletedAt: null,
        status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] },
      },
    }),
    prisma.attendanceEvent.groupBy({
      by: ['kind'],
      where: { ...T, occurredOn: { gte: thirtyAgo }, excusedAt: null },
      _count: { _all: true },
    }),
    prisma.client.findMany({ where: { ...T, deletedAt: null }, select: { id: true, name: true }, take: 5_000 }),
    prisma.associate.findMany({
      where: { ...T, deletedAt: null, erasedAt: null, hireDate: { gte: thirtyAgo } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        photoS3Key: true,
        photoUpdatedAt: true,
      },
      orderBy: { hireDate: 'desc' },
      take: 24,
    }),
  ]);

  // Every person's hours split once, the way their paycheck splits them
  // (lib/laborRules/hours): the federal weekly 40, or a live jurisdiction's
  // daily and double-time rules. Each entry carries its share.
  const entries: EntryRow[] = rawEntries.map(({ location, ...e }) => ({ ...e, site: location }));
  const split: Split = splitByPerson(await loadLiveRules(prisma, opts.tenantId ?? tenantIdForWrite()), entries);

  // Per client: the active associates placed there (the one definition), not open assignments.
  const byClient = new Map<string, { clientName: string; activeAssociates: number }>();
  for (const c of openAssignments) {
    const n = active.byClient.get(c.id) ?? 0;
    if (n > 0) byClient.set(c.id, { clientName: c.name, activeAssociates: n });
  }

  // Oldest → newest: window i runs weekStarts[i+1] → weekStarts[i].
  const trend: ExecutiveWeek[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    trend.push(aggregateWeek(entries, split, weekStarts[i + 1], weekStarts[i]));
  }

  // ----- Store league + client concentration (last 4 complete weeks) -----
  // Each store's hours, overtime and dollars from its entries' shares of
  // their people's weeks: the engine puts a week's overtime on its latest
  // hours, so the store whose shift pushed someone past the line wears it.
  const leagueStart = weekStarts[Math.min(4, TREND_WEEKS)];
  const leagueEnd = thisWeekStart;
  const perLocation = new Map<string, { hours: number; otHours: number; billed: number; cost: number }>();
  for (const e of entries) {
    if (e.clockInAt < leagueStart || e.clockInAt >= leagueEnd) continue;
    if (!e.locationId || !e.clientId) continue;
    const share = split.byEntry.get(e);
    if (!share || share.workedHours <= 0) continue;
    const locKey = `${e.clientId}:${e.locationId}`;
    const agg = perLocation.get(locKey) ?? { hours: 0, otHours: 0, billed: 0, cost: 0 };
    const p = priceShare(share, split.byPerson.get(e.associateId)!);
    agg.hours += share.workedHours;
    agg.otHours += share.overtimeHours + share.doubleTimeHours;
    agg.billed += p.billed;
    agg.cost += p.cost;
    perLocation.set(locKey, agg);
  }
  const locationIds = [...new Set([...perLocation.keys()].map((k) => k.split(':')[1]))];
  const locMeta =
    locationIds.length === 0
      ? []
      : await prisma.site.findMany({
          where: { ...T, id: { in: locationIds } },
          select: {
            id: true,
            name: true,
            clientId: true,
            client: { select: { name: true } },
          },
        });
  const locById = new Map(locMeta.map((l) => [l.id, l]));
  const league = [...perLocation.entries()]
    .map(([locKey, agg]) => {
      const [clientId, locationId] = locKey.split(':');
      const meta = locById.get(locationId);
      const { hours, otHours, billed: estBilled, cost: estCost } = agg;
      return {
        clientId,
        clientName: meta?.client?.name ?? 'Unknown client',
        locationId,
        locationName: meta?.name ?? 'Unknown store',
        hours: Math.round(hours * 10) / 10,
        otHours: Math.round(otHours * 10) / 10,
        estBilled: Math.round(estBilled * 100) / 100,
        estMargin: Math.round((estBilled - estCost) * 100) / 100,
      };
    })
    .sort((a, b) => b.estMargin - a.estMargin);
  const billedByClient = new Map<string, { clientName: string; billed: number }>();
  for (const row of league) {
    const c = billedByClient.get(row.clientId) ?? { clientName: row.clientName, billed: 0 };
    c.billed += row.estBilled;
    billedByClient.set(row.clientId, c);
  }
  const totalBilled = [...billedByClient.values()].reduce((n, c) => n + c.billed, 0);
  const concentration = [...billedByClient.entries()]
    .map(([clientId, c]) => ({
      clientId,
      clientName: c.clientName,
      sharePct: totalBilled > 0 ? Math.round((c.billed / totalBilled) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sharePct - a.sharePct);

  return {
    generatedAt: now.toISOString(),
    workforce: { active: active.total, deactivated, hires30d, separations30d, onboardingInFlight },
    lastWeek: aggregateWeek(entries, split, lastWeekStart, thisWeekStart),
    thisWeek: aggregateWeek(entries, split, thisWeekStart, now),
    trend,
    newHires30d: newHireRows.map((a) => ({
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      photoUrl: profilePhotoUrlFor(a),
      hireDate: a.hireDate ? a.hireDate.toISOString().slice(0, 10) : null,
    })),
    rates: {
      payRate: env.DEFAULT_ASSOCIATE_PAY_RATE,
      billRate: env.DEFAULT_ASSOCIATE_BILL_RATE,
      burdenPct: env.LABOR_BURDEN_PERCENT,
      overheadPerHour: env.LABOR_OVERHEAD_PER_HOUR,
    },
    league,
    concentration,
    turnover: {
      separations90d,
      costPerSeparation: env.EXEC_COST_PER_SEPARATION,
      estCost90d: separations90d * env.EXEC_COST_PER_SEPARATION,
    },
    attendance30d: attendanceRows
      .map((r) => ({ kind: r.kind, count: r._count._all }))
      .sort((a, b) => b.count - a.count),
    clients: [...byClient.entries()]
      .map(([clientId, c]) => ({ clientId, ...c }))
      .sort((a, b) => b.activeAssociates - a.activeAssociates),
  };
}

const money = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain-text week-in-review for the Saturday executive digest email. */
export function executiveDigestBody(s: ExecutiveSummary): string {
  const w = s.lastWeek;
  const lines = [
    `Week in review (${w.start.slice(0, 10)} to ${w.end.slice(0, 10)}):`,
    `- Hours worked: ${w.workedHours.toFixed(2)}h across ${w.headsWorked} associates (${w.otHours.toFixed(2)}h overtime)`,
    `- Est. billed at standard rates: ${money(w.estBilled)} · est. margin ${money(w.estMargin)}`,
    `- Workforce: ${s.workforce.active} active · ${s.workforce.hires30d} hires and ${s.workforce.separations30d} separations in the last 30 days · ${s.workforce.onboardingInFlight} onboarding in flight`,
  ];
  if (s.attendance30d.length > 0) {
    lines.push(
      `- Attendance (30d): ${s.attendance30d
        .map((a) => `${a.count} ${a.kind.toLowerCase().replace(/_/g, ' ')}`)
        .join(' · ')}`,
    );
  }
  if (s.clients.length > 0) {
    lines.push(
      `- Placements: ${s.clients
        .slice(0, 5)
        .map((c) => `${c.clientName} ${c.activeAssociates}`)
        .join(' · ')}`,
    );
  }
  lines.push('Open the dashboard for the live floor, OT outlook, and the board pack.');
  return lines.join('\n');
}

/**
 * The week in a few sentences — what moved, against the week before, in
 * the words an executive would use to relay it. One source for the
 * Saturday digest, the board pack's opening paragraph and the dashboard,
 * so they never disagree.
 */
export function executiveNarrative(s: ExecutiveSummary): string[] {
  const w = s.lastWeek;
  const prev = s.trend.length >= 2 ? s.trend[s.trend.length - 2]! : null;
  const pct = (cur: number, was: number): string | null => {
    if (!was) return null;
    const d = ((cur - was) / was) * 100;
    if (Math.abs(d) < 0.5) return 'flat';
    return `${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(0)}%`;
  };
  const out: string[] = [];

  const hoursMove = prev ? pct(w.workedHours, prev.workedHours) : null;
  out.push(
    `Last week the workforce worked ${w.workedHours.toFixed(0)} hours across ${w.headsWorked} associates` +
      (hoursMove ? `, ${hoursMove} on the week before` : '') +
      `, with ${w.otHours.toFixed(0)} hours of overtime` +
      (prev ? ` (${prev.otHours.toFixed(0)} the week before)` : '') +
      '.',
  );

  const marginMove = prev ? pct(w.estMargin, prev.estMargin) : null;
  out.push(
    `At standard rates that is ${money(w.estBilled)} billed against ${money(w.estLaborCost)} of labor — an estimated margin of ${money(w.estMargin)}` +
      (marginMove ? `, ${marginMove}` : '') +
      '.',
  );

  const net = s.workforce.hires30d - s.workforce.separations30d;
  out.push(
    `Headcount stands at ${s.workforce.active} active associates; the last 30 days brought ${s.workforce.hires30d} hires and ${s.workforce.separations30d} separations` +
      (net !== 0 ? ` (net ${net > 0 ? '+' : ''}${net})` : '') +
      `, with ${s.workforce.onboardingInFlight} still onboarding.`,
  );

  const unexcused = s.attendance30d.reduce((n, a) => n + a.count, 0);
  if (unexcused > 0) {
    const top = [...s.attendance30d].sort((a, b) => b.count - a.count)[0]!;
    out.push(
      `Attendance logged ${unexcused} unexcused events in 30 days, most of them ${top.kind.toLowerCase().replace(/_/g, ' ')} (${top.count}).`,
    );
  }

  if (s.clients.length > 0) {
    const total = s.clients.reduce((n, c) => n + c.activeAssociates, 0);
    const lead = s.clients[0]!;
    const share = total > 0 ? Math.round((lead.activeAssociates / total) * 100) : 0;
    out.push(
      `${lead.clientName} carries ${lead.activeAssociates} of ${total} placed associates (${share}%)` +
        (share >= 50 ? ' — concentration worth watching.' : '.'),
    );
  }
  return out;
}
