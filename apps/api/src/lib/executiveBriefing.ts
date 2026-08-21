// The chairman's morning brief — the five questions the person driving
// the company asks at 6:45am, answered from live data:
//   1. What happened overnight, and is TODAY safe? (coverage + incidents)
//   2. What needs MY decision? (the chairman's queue)
//   3. How healthy is each client relationship? (scored, with reasons)
//   4. Can I say yes to growth? (bench, funnel velocity, the J-1 cliff)
//   5. Who should I know this week? (top performers, anniversaries)
// Read-only, computed on demand for GET /executive/briefing.

import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import {
  computeExecutiveDecisions,
  type ExecutiveDecision,
} from './executiveDecisions.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import {
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from './timeAnomalies.js';

const ORG_TZ = 'America/New_York';
const DAY_MS = 24 * 3600_000;

export interface ExecutiveBriefing {
  generatedAt: string;
  today: {
    dateKey: string;
    shiftsTotal: number;
    shiftsAssigned: number;
    shiftsOpen: number;
    /** Open shifts GROUPED by (client, site, position, start) — "3× GM
     *  Morning @ Pier Park, 6:00 AM", not three identical lines. */
    openShifts: Array<{
      clientName: string;
      locationName: string | null;
      position: string;
      startsAt: string;
      count: number;
    }>;
    estBilledToday: number;
    /** Unexcused attendance events from the last 24h — the overnight read. */
    incidents: Array<{ kind: string; associateName: string; clientName: string | null }>;
  };
  /** The next 7 org days' coverage — the future, per day. */
  outlook: Array<{
    dateKey: string;
    published: number;
    assigned: number;
    open: number;
  }>;
  decisions: ExecutiveDecision[];
  clientHealth: Array<{
    clientId: string;
    clientName: string;
    score: number;
    band: 'green' | 'amber' | 'red';
    fillRatePct: number | null;
    fillDeltaPct: number | null;
    reasons: string[];
  }>;
  capacity: {
    bench: number;
    funnel: { inFlight: number; approved30d: number };
    j1Active: number;
    j1Cliff: Array<{ month: string; count: number }>;
  };
  people: {
    topPerformers: Array<{
      id: string;
      name: string;
      photoUrl: string | null;
      hours: number;
    }>;
    anniversaries: Array<{
      id: string;
      name: string;
      photoUrl: string | null;
      years: number;
      date: string;
    }>;
  };
}

export async function computeExecutiveBriefing(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ExecutiveBriefing> {
  const todayKey = orgDateKey(now);
  const dayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
  // Org-local midnights for today+1 … today+7 — day boundaries for the
  // end of today and each outlook day.
  const dayBounds: Date[] = [dayStart];
  for (let i = 1; i <= 7; i++) {
    const k = new Date(`${todayKey}T12:00:00Z`);
    k.setUTCDate(k.getUTCDate() + i);
    dayBounds.push(utcInstantOfLocalMidnight(k.toISOString().slice(0, 10), ORG_TZ));
  }
  const dayEnd = dayBounds[1];

  const thisWeekStart = startOfWeekUTC(now);
  const w = [thisWeekStart];
  for (let i = 0; i < 8; i++) {
    w.push(startOfWeekUTC(new Date(w[i].getTime() - 36 * 3600_000)));
  }
  const recentStart = w[4]; // last 4 complete weeks
  const priorStart = w[8]; // the 4 before

  const [
    todayShifts,
    outlookShifts,
    incidents,
    windowShifts,
    windowEvents,
    paidStatements,
    bench,
    funnelRows,
    approved30d,
    j1Active,
    j1Docs,
    windowEntries,
    windowBadActors,
    anniversaryRows,
  ] = await Promise.all([
    prisma.shift.findMany({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: dayStart, lt: dayEnd },
      },
      select: {
        id: true,
        position: true,
        startsAt: true,
        endsAt: true,
        assignedAssociateId: true,
        location: true,
        client: { select: { name: true } },
      },
      take: 2_000,
    }),
    prisma.shift.findMany({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: dayEnd, lt: dayBounds[7] },
      },
      select: { startsAt: true, assignedAssociateId: true },
      take: 10_000,
    }),
    prisma.attendanceEvent.findMany({
      where: { occurredOn: { gte: new Date(now.getTime() - DAY_MS) }, excusedAt: null },
      select: {
        kind: true,
        associate: { select: { firstName: true, lastName: true } },
        clientId: true,
      },
      take: 20,
    }),
    prisma.shift.findMany({
      where: {
        publishedAt: { not: null },
        status: { notIn: ['CANCELLED', 'DRAFT'] },
        startsAt: { gte: priorStart, lt: thisWeekStart },
      },
      select: {
        clientId: true,
        assignedAssociateId: true,
        startsAt: true,
        client: { select: { name: true } },
      },
      take: 20_000,
    }),
    prisma.attendanceEvent.findMany({
      where: {
        occurredOn: { gte: recentStart },
        excusedAt: null,
        kind: { in: ['NO_CALL_NO_SHOW', 'LATE'] },
      },
      select: { kind: true, clientId: true },
      take: 5_000,
    }),
    prisma.clientStatement.findMany({
      where: { status: 'FINAL', paidAt: { not: null }, finalizedAt: { not: null } },
      select: { clientId: true, finalizedAt: true, paidAt: true },
      take: 200,
    }),
    prisma.associate.count({
      where: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        applications: { some: { status: 'APPROVED', deletedAt: null } },
        assignments: { none: { endedAt: null } },
      },
    }),
    prisma.application.groupBy({
      by: ['status'],
      where: { deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] } },
      _count: { _all: true },
    }),
    prisma.application.count({
      where: {
        deletedAt: null,
        status: 'APPROVED',
        approvedAt: { gte: new Date(now.getTime() - 30 * DAY_MS) },
      },
    }),
    prisma.associate.count({
      where: {
        deletedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        j1Status: true,
      },
    }),
    prisma.documentRecord.findMany({
      where: {
        deletedAt: null,
        kind: { in: ['J1_VISA', 'J1_DS2019'] },
        expiresAt: { gte: now, lt: new Date(now.getTime() + 120 * DAY_MS) },
        associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
      },
      select: { associateId: true, expiresAt: true },
      take: 2_000,
    }),
    prisma.timeEntry.findMany({
      where: {
        status: { in: ['APPROVED', 'COMPLETED'] },
        clockInAt: { gte: recentStart, lt: thisWeekStart },
      },
      select: {
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
      },
      take: 50_000,
    }),
    prisma.attendanceEvent.findMany({
      where: { occurredOn: { gte: recentStart }, excusedAt: null },
      select: { associateId: true },
      take: 5_000,
    }),
    prisma.associate.findMany({
      where: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        hireDate: { not: null },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        photoS3Key: true,
        photoUpdatedAt: true,
      },
      take: 2_000,
    }),
  ]);

  /* ----- 1. Today ------------------------------------------------------- */
  const assignedToday = todayShifts.filter((s) => s.assignedAssociateId !== null);
  const openToday = todayShifts.filter((s) => s.assignedAssociateId === null);
  const scheduledMinToday = todayShifts.reduce(
    (n, s) => n + Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000),
    0,
  );
  const clientNames = new Map<string, string>();
  for (const s of windowShifts) clientNames.set(s.clientId, s.client.name);

  /* ----- 2. Decisions — the full rule engine with human-state overlay --- */
  const decisions = await computeExecutiveDecisions(prisma, now);

  /* ----- 3. Client health ------------------------------------------------ */
  interface WindowAgg {
    published: number;
    assigned: number;
  }
  const recent = new Map<string, WindowAgg>();
  const prior = new Map<string, WindowAgg>();
  for (const s of windowShifts) {
    const bucket = s.startsAt >= recentStart ? recent : prior;
    const agg = bucket.get(s.clientId) ?? { published: 0, assigned: 0 };
    agg.published += 1;
    if (s.assignedAssociateId !== null) agg.assigned += 1;
    bucket.set(s.clientId, agg);
  }
  const eventsByClient = new Map<string, { ncns: number; late: number }>();
  for (const e of windowEvents) {
    if (!e.clientId) continue;
    const agg = eventsByClient.get(e.clientId) ?? { ncns: 0, late: 0 };
    if (e.kind === 'NO_CALL_NO_SHOW') agg.ncns += 1;
    else agg.late += 1;
    eventsByClient.set(e.clientId, agg);
  }
  const payDaysByClient = new Map<string, number[]>();
  for (const s of paidStatements) {
    const days = (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / DAY_MS;
    const arr = payDaysByClient.get(s.clientId) ?? [];
    arr.push(days);
    payDaysByClient.set(s.clientId, arr);
  }
  const clientHealth: ExecutiveBriefing['clientHealth'] = [...recent.entries()]
    .map(([clientId, agg]) => {
      const fill = agg.published > 0 ? (agg.assigned / agg.published) * 100 : null;
      const priorAgg = prior.get(clientId);
      const fillPrior =
        priorAgg && priorAgg.published > 0
          ? (priorAgg.assigned / priorAgg.published) * 100
          : null;
      const ev = eventsByClient.get(clientId) ?? { ncns: 0, late: 0 };
      const payArr = payDaysByClient.get(clientId) ?? [];
      const payDays =
        payArr.length > 0 ? payArr.reduce((n, d) => n + d, 0) / payArr.length : null;

      let score = 100;
      const reasons: string[] = [];
      if (fill !== null && fill < 90) {
        score -= Math.min(30, (90 - fill) * 2);
        reasons.push(`Fill rate ${fill.toFixed(0)}% over the last 4 weeks`);
      }
      if (fill !== null && fillPrior !== null && fill < fillPrior - 3) {
        score -= 10;
        reasons.push(`Fill trending down (${fillPrior.toFixed(0)}% → ${fill.toFixed(0)}%)`);
      }
      if (agg.assigned > 0 && ev.ncns > 0) {
        const rate = (ev.ncns / agg.assigned) * 100;
        score -= Math.min(25, rate * 5);
        reasons.push(`${ev.ncns} no-call no-show${ev.ncns === 1 ? '' : 's'} in 4 weeks`);
      }
      if (agg.assigned > 0 && ev.late >= 5) {
        score -= 10;
        reasons.push(`${ev.late} late arrivals in 4 weeks`);
      }
      if (payDays !== null && payDays > 45) {
        score -= 10;
        reasons.push(`Pays in ~${Math.round(payDays)} days`);
      }
      score = Math.max(0, Math.round(score));
      return {
        clientId,
        clientName: clientNames.get(clientId) ?? 'Unknown client',
        score,
        band: (score >= 80 ? 'green' : score >= 60 ? 'amber' : 'red') as
          | 'green'
          | 'amber'
          | 'red',
        fillRatePct: fill === null ? null : Math.round(fill * 10) / 10,
        fillDeltaPct:
          fill !== null && fillPrior !== null
            ? Math.round((fill - fillPrior) * 10) / 10
            : null,
        reasons: reasons.length > 0 ? reasons : ['No issues detected — running clean'],
      };
    })
    .sort((a, b) => a.score - b.score);

  /* ----- 4. Capacity ----------------------------------------------------- */
  const cliffByAssociate = new Map<string, Date>();
  for (const d of j1Docs) {
    if (!d.expiresAt) continue;
    const cur = cliffByAssociate.get(d.associateId);
    if (!cur || d.expiresAt < cur) cliffByAssociate.set(d.associateId, d.expiresAt);
  }
  const cliffMonths = new Map<string, number>();
  for (const exp of cliffByAssociate.values()) {
    const month = exp.toISOString().slice(0, 7);
    cliffMonths.set(month, (cliffMonths.get(month) ?? 0) + 1);
  }

  /* ----- 5. People -------------------------------------------------------- */
  const minutesByAssociate = new Map<string, number>();
  for (const e of windowEntries) {
    if (!e.clockOutAt) continue;
    let ms = e.clockOutAt.getTime() - e.clockInAt.getTime();
    for (const b of e.breaks) {
      const bEnd = b.endedAt ? b.endedAt.getTime() : e.clockOutAt.getTime();
      ms -= Math.max(0, bEnd - b.startedAt.getTime());
    }
    minutesByAssociate.set(
      e.associateId,
      (minutesByAssociate.get(e.associateId) ?? 0) + Math.max(0, Math.round(ms / 60_000)),
    );
  }
  const flagged = new Set(windowBadActors.map((e) => e.associateId));
  const topIds = [...minutesByAssociate.entries()]
    .filter(([id]) => !flagged.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const topMeta =
    topIds.length === 0
      ? []
      : await prisma.associate.findMany({
          where: { id: { in: topIds.map(([id]) => id) } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            photoS3Key: true,
            photoUpdatedAt: true,
          },
        });
  const topById = new Map(topMeta.map((a) => [a.id, a]));

  const anniversaries: ExecutiveBriefing['people']['anniversaries'] = [];
  for (const a of anniversaryRows) {
    const hire = a.hireDate!;
    // Next anniversary of the hire month/day, within the coming 7 days.
    const anniv = new Date(
      Date.UTC(now.getUTCFullYear(), hire.getUTCMonth(), hire.getUTCDate()),
    );
    if (anniv.getTime() < now.getTime() - DAY_MS) anniv.setUTCFullYear(anniv.getUTCFullYear() + 1);
    const inDays = (anniv.getTime() - now.getTime()) / DAY_MS;
    const years = anniv.getUTCFullYear() - hire.getUTCFullYear();
    if (inDays >= -1 && inDays <= 7 && years >= 1) {
      anniversaries.push({
        id: a.id,
        name: `${a.firstName} ${a.lastName}`,
        photoUrl: profilePhotoUrlFor(a),
        years,
        date: anniv.toISOString().slice(0, 10),
      });
    }
  }
  anniversaries.sort((a, b) => a.date.localeCompare(b.date));

  return {
    generatedAt: now.toISOString(),
    today: {
      dateKey: todayKey,
      shiftsTotal: todayShifts.length,
      shiftsAssigned: assignedToday.length,
      shiftsOpen: openToday.length,
      openShifts: (() => {
        const grouped = new Map<
          string,
          {
            clientName: string;
            locationName: string | null;
            position: string;
            startsAt: string;
            count: number;
          }
        >();
        for (const s of openToday) {
          const key = `${s.client.name}|${s.location ?? ''}|${s.position}|${s.startsAt.getTime()}`;
          const g = grouped.get(key);
          if (g) g.count += 1;
          else
            grouped.set(key, {
              clientName: s.client.name,
              locationName: s.location ?? null,
              position: s.position,
              startsAt: s.startsAt.toISOString(),
              count: 1,
            });
        }
        return [...grouped.values()]
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
          .slice(0, 6);
      })(),
      estBilledToday:
        Math.round((scheduledMinToday / 60) * env.DEFAULT_ASSOCIATE_BILL_RATE * 100) / 100,
      incidents: incidents.map((e) => ({
        kind: e.kind,
        associateName: `${e.associate.firstName} ${e.associate.lastName}`,
        clientName: e.clientId ? (clientNames.get(e.clientId) ?? null) : null,
      })),
    },
    outlook: dayBounds.slice(1, 7).map((boundStart, i) => {
      const boundEnd = dayBounds[i + 2] ?? new Date(boundStart.getTime() + 26 * 3600_000);
      const days = outlookShifts.filter(
        (s) => s.startsAt >= boundStart && s.startsAt < boundEnd,
      );
      const assigned = days.filter((s) => s.assignedAssociateId !== null).length;
      return {
        dateKey: orgDateKey(new Date(boundStart.getTime() + 12 * 3600_000)),
        published: days.length,
        assigned,
        open: days.length - assigned,
      };
    }),
    decisions,
    clientHealth,
    capacity: {
      bench,
      funnel: {
        inFlight: funnelRows.reduce((n, r) => n + r._count._all, 0),
        approved30d: approved30d,
      },
      j1Active,
      j1Cliff: [...cliffMonths.entries()]
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month)),
    },
    people: {
      topPerformers: topIds.map(([id, mins]) => {
        const a = topById.get(id);
        return {
          id,
          name: a ? `${a.firstName} ${a.lastName}` : 'Unknown',
          photoUrl: a ? profilePhotoUrlFor(a) : null,
          hours: Math.round((mins / 60) * 10) / 10,
        };
      }),
      anniversaries: anniversaries.slice(0, 8),
    },
  };
}
