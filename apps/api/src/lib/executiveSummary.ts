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
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import { startOfWeekUTC } from './timeAnomalies.js';

const WEEKLY_OT_THRESHOLD_MIN = 40 * 60;
const DAY_MS = 24 * 3600_000;
/** Complete org weeks in the trend series (newest last = last week). */
const TREND_WEEKS = 8;

export interface ExecutiveWeek {
  /** ISO instant of the org-week start (Sat 00:00 FL-local). */
  start: string;
  /** Exclusive end used for the aggregation (week end, or "now" for the current partial week). */
  end: string;
  workedHours: number;
  otHours: number;
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
}

interface EntryRow {
  associateId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
}

function netMinutes(e: EntryRow): number {
  if (!e.clockOutAt) return 0;
  const end = e.clockOutAt.getTime();
  let ms = end - e.clockInAt.getTime();
  for (const b of e.breaks) {
    const bEnd = b.endedAt ? b.endedAt.getTime() : end;
    ms -= Math.max(0, bEnd - b.startedAt.getTime());
  }
  return Math.max(0, Math.round(ms / 60_000));
}

function aggregateWeek(
  entries: EntryRow[],
  start: Date,
  end: Date,
): ExecutiveWeek {
  const byAssociate = new Map<string, number>();
  for (const e of entries) {
    if (e.clockInAt < start || e.clockInAt >= end) continue;
    byAssociate.set(e.associateId, (byAssociate.get(e.associateId) ?? 0) + netMinutes(e));
  }
  let workedMin = 0;
  let otMin = 0;
  for (const mins of byAssociate.values()) {
    workedMin += mins;
    otMin += Math.max(0, mins - WEEKLY_OT_THRESHOLD_MIN);
  }
  const workedHours = workedMin / 60;
  const otHours = otMin / 60;
  const bill = env.DEFAULT_ASSOCIATE_BILL_RATE;
  const pay = env.DEFAULT_ASSOCIATE_PAY_RATE;
  const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
  // OT adds the 0.5× premium on both sides of the ledger.
  const estBilled = workedHours * bill + otHours * bill * 0.5;
  const estLaborCost =
    (workedHours * pay + otHours * pay * 0.5) * burden +
    workedHours * env.LABOR_OVERHEAD_PER_HOUR;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    workedHours: Math.round(workedHours * 100) / 100,
    otHours: Math.round(otHours * 100) / 100,
    headsWorked: byAssociate.size,
    estBilled: Math.round(estBilled * 100) / 100,
    estLaborCost: Math.round(estLaborCost * 100) / 100,
    estMargin: Math.round((estBilled - estLaborCost) * 100) / 100,
  };
}

export async function computeExecutiveSummary(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ExecutiveSummary> {
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
    entries,
    active,
    deactivated,
    hires30d,
    separations30d,
    onboardingInFlight,
    attendanceRows,
    openAssignments,
    newHireRows,
  ] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        status: { in: ['APPROVED', 'COMPLETED'] },
        clockInAt: { gte: oldestStart, lt: now },
      },
      select: {
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
      },
      take: 50_000,
    }),
    prisma.associate.count({
      where: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        applications: { some: { status: 'APPROVED', deletedAt: null } },
      },
    }),
    prisma.associate.count({
      where: { deletedAt: null, deactivatedAt: { not: null } },
    }),
    prisma.associate.count({
      where: { deletedAt: null, hireDate: { gte: thirtyAgo } },
    }),
    prisma.associate.count({
      where: { separatedAt: { gte: thirtyAgo } },
    }),
    prisma.application.count({
      where: {
        deletedAt: null,
        status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] },
      },
    }),
    prisma.attendanceEvent.groupBy({
      by: ['kind'],
      where: { occurredOn: { gte: thirtyAgo }, excusedAt: null },
      _count: { _all: true },
    }),
    prisma.associateAssignment.findMany({
      where: { endedAt: null },
      select: {
        location: {
          select: { clientId: true, client: { select: { name: true } } },
        },
      },
      take: 5_000,
    }),
    prisma.associate.findMany({
      where: { deletedAt: null, erasedAt: null, hireDate: { gte: thirtyAgo } },
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

  const byClient = new Map<string, { clientName: string; activeAssociates: number }>();
  for (const a of openAssignments) {
    const c = byClient.get(a.location.clientId) ?? {
      clientName: a.location.client.name,
      activeAssociates: 0,
    };
    c.activeAssociates += 1;
    byClient.set(a.location.clientId, c);
  }

  // Oldest → newest: window i runs weekStarts[i+1] → weekStarts[i].
  const trend: ExecutiveWeek[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    trend.push(aggregateWeek(entries, weekStarts[i + 1], weekStarts[i]));
  }

  return {
    generatedAt: now.toISOString(),
    workforce: { active, deactivated, hires30d, separations30d, onboardingInFlight },
    lastWeek: aggregateWeek(entries, lastWeekStart, thisWeekStart),
    thisWeek: aggregateWeek(entries, thisWeekStart, now),
    trend,
    newHires30d: newHireRows.map((a) => ({
      id: a.id,
      name: `${a.firstName} ${a.lastName}`,
      photoUrl: profilePhotoUrlFor(a),
      hireDate: a.hireDate ? a.hireDate.toISOString().slice(0, 10) : null,
    })),
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
