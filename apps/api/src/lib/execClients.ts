import type { Prisma, PrismaClient } from '@prisma/client';
import {
  OPEN_PROSPECT_STAGES,
  PROSPECT_STAGE_LABELS,
  PROSPECT_STAGE_WEIGHTS,
  prospectAnnualValue,
  prospectWeightedValue,
  type ExecClientRow,
  type ExecClients,
  type ExecPipelineStage,
} from '@alto-people/shared';
import { INTERNAL_HIRES_MARK } from '../routes/clients.js';
import { activeBreakdown } from './activeDefinition.js';
import { clientMetrics, type ClientHealth } from './clientMetrics.js';
import { computeNpsResults } from './clientNps.js';
import { lastCompleteWeeks, type ExecWindow } from './execPeriods.js';
import { loadPaidHours, round2, type PaidShare } from './paidHours.js';
import { tenantIdForWrite } from './tenant.js';
import { startOfWeekUTC } from './timeAnomalies.js';

/**
 * The chairman's client portfolio (GET /executive/clients, and the board
 * pack's clients page): who the company's revenue comes from in the
 * period, how concentrated it is, what the pipeline would add, and which
 * stores earn it.
 *
 *   billed, margin   est. at the standard rates on PAID hours (lib/paidHours
 *                    — the executive summary's math: each person's week split
 *                    by the labor engine, billed and paid at its multipliers,
 *                    burden and overhead on the cost side)
 *   sharePct         the client's share of the period's est. billed across the
 *                    clients listed (largest-remainder rounded, so the column
 *                    adds to exactly 100)
 *   headcount        the one definition of active (lib/activeDefinition), by
 *                    placement, as of the period's end
 *   fillPct          assigned ÷ published, not cancelled shifts that started
 *                    in the period (the clients list's rule, over the period
 *                    instead of the next 7 days)
 *   nps              the client's latest NPS wave with an answer (lib/clientNps
 *                    — the Client NPS page)
 *   health           the clients list's call (lib/clientMetrics healthFor):
 *                    a word — Good, Watch, At risk — not a score
 *   concentration    the top share against a 50% line, and the HHI (Σ share²,
 *                    shares in percent: 10,000 = one client)
 *   pipeline         open prospects by stage, valued at est. weekly hours ×
 *                    est. bill rate, weighted by the stage's stated chance of
 *                    closing (@alto-people/shared PROSPECT_STAGE_WEIGHTS — the
 *                    Pipeline page's weights)
 *   league           each store's period economics, best margin first
 *
 * The internal-hires pseudo-client (the account staff are onboarded under)
 * is not a client and stays out of every figure, as on the clients list.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const TREND_WEEKS = 8;
/** The share past which one client is a concentration risk. */
export const CONCENTRATION_THRESHOLD_PCT = 50;

export const HEALTH_WORD: Record<ClientHealth, string> = { good: 'Good', watch: 'Watch', risk: 'At risk' };

const pct1 = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Shares of a whole, in percent to one decimal, rounded by largest remainder so they add to exactly 100. */
export function sharesOf(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 1000);
  const floors = raw.map(Math.floor);
  let left = 1000 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - floors[i]! })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i]! += 1;
    left -= 1;
  }
  return floors.map((f) => f / 10);
}

/** Herfindahl–Hirschman index of a set of amounts: Σ (share in %)², 0–10,000. */
export function hhiOf(values: readonly number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return Math.round(values.reduce((n, v) => n + ((v / total) * 100) ** 2, 0));
}

/** The internal-hires pseudo-client is matched by name, as the clients list matches it. */
export function isInternalClientName(name: string): boolean {
  return name.toLowerCase().includes(INTERNAL_HIRES_MARK.toLowerCase());
}

interface Money {
  billed: number;
  cost: number;
  hours: number;
  otHours: number;
}
const zero = (): Money => ({ billed: 0, cost: 0, hours: 0, otHours: 0 });
const add = (m: Money, s: PaidShare) => {
  m.billed += s.billed;
  m.cost += s.cost;
  m.hours += s.hours;
  m.otHours += s.otHours;
};

export async function computeExecClients(db: Db, w: ExecWindow): Promise<ExecClients> {
  const tenantId = tenantIdForWrite();
  const now = new Date(w.period.asOf);
  const asOfEnd = w.to.getTime() < now.getTime() ? w.to : now;
  const trendStarts = lastCompleteWeeks(now, TREND_WEEKS);
  const thisWeek = startOfWeekUTC(now);
  const readFrom = new Date(Math.min(w.from.getTime(), trendStarts[0]!.getTime()));
  const readTo = new Date(Math.max(w.to.getTime(), thisWeek.getTime()));

  const [clientRows, shares, active, shiftTotals, shiftFilled, nps, prospects] = await Promise.all([
    db.client.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, status: true },
      take: 5000,
    }),
    loadPaidHours(db, { tenantId, from: readFrom, to: readTo }),
    activeBreakdown(asOfEnd, db, undefined, { tenantId }),
    db.shift.groupBy({
      by: ['clientId'],
      where: { tenantId, startsAt: { gte: w.from, lt: w.to }, status: { notIn: ['DRAFT', 'CANCELLED'] }, publishedAt: { not: null } },
      _count: { _all: true },
    }),
    db.shift.groupBy({
      by: ['clientId'],
      where: { tenantId, startsAt: { gte: w.from, lt: w.to }, status: { notIn: ['DRAFT', 'CANCELLED'] }, publishedAt: { not: null }, assignedAssociateId: { not: null } },
      _count: { _all: true },
    }),
    computeNpsResults(db as PrismaClient, now).catch(() => null),
    db.clientProspect.findMany({
      where: { tenantId, deletedAt: null, stage: { in: [...OPEN_PROSPECT_STAGES] } },
      select: { id: true, name: true, stage: true, estWeeklyHours: true, estBillRate: true, stageChangedAt: true },
      take: 1000,
    }),
  ]);

  const internal = new Set(clientRows.filter((c) => isInternalClientName(c.name)).map((c) => c.id));
  const nameOf = new Map(clientRows.map((c) => [c.id, c.name]));

  // The period, per client and per store; the trend, per client and week.
  const perClient = new Map<string, Money>();
  const perSite = new Map<string, Money & { clientId: string | null }>();
  const trend = new Map<string, number[]>();
  const weekIndex = (t: number): number => {
    for (let i = trendStarts.length - 1; i >= 0; i--) if (t >= trendStarts[i]!.getTime()) return i;
    return -1;
  };
  for (const s of shares) {
    const cid = s.entry.clientId;
    if (cid && internal.has(cid)) continue;
    const t = s.entry.clockInAt.getTime();
    if (t >= w.from.getTime() && t < w.to.getTime()) {
      if (cid) {
        const m = perClient.get(cid) ?? zero();
        add(m, s);
        perClient.set(cid, m);
      }
      if (s.entry.locationId) {
        const m = perSite.get(s.entry.locationId) ?? { ...zero(), clientId: cid };
        add(m, s);
        perSite.set(s.entry.locationId, m);
      }
    }
    if (cid && t < thisWeek.getTime()) {
      const i = weekIndex(t);
      if (i >= 0) {
        const series = trend.get(cid) ?? new Array<number>(TREND_WEEKS).fill(0);
        series[i]! += s.billed;
        trend.set(cid, series);
      }
    }
  }

  const totals = new Map(shiftTotals.map((r) => [r.clientId, r._count._all]));
  const filled = new Map(shiftFilled.map((r) => [r.clientId, r._count._all]));

  // Every active account, and any other that billed or has people working in the period.
  const listed = clientRows.filter(
    (c) => !internal.has(c.id) && (c.status === 'ACTIVE' || (perClient.get(c.id)?.billed ?? 0) > 0 || (active.byClient.get(c.id) ?? 0) > 0),
  );
  const health = listed.length ? await clientMetrics(listed.map((c) => c.id), { range: { from: w.from, to: w.to }, includeMoney: true, now }) : new Map();

  // The latest wave each client answered.
  const latestNps = new Map<string, number>();
  for (const ct of nps?.clientTrends ?? []) {
    for (let i = ct.points.length - 1; i >= 0; i--) {
      const v = ct.points[i]!.nps;
      if (v !== null) {
        latestNps.set(ct.clientId, v);
        break;
      }
    }
  }

  const billedOf = listed.map((c) => perClient.get(c.id)?.billed ?? 0);
  const shareList = sharesOf(billedOf);
  const clients: ExecClientRow[] = listed.map((c, i) => {
    const m = perClient.get(c.id) ?? zero();
    const total = totals.get(c.id) ?? 0;
    const h = health.get(c.id);
    return {
      clientId: c.id,
      name: c.name,
      billed: round2(m.billed),
      margin: round2(m.billed - m.cost),
      marginPct: pct1(m.billed - m.cost, m.billed),
      sharePct: shareList[i]!,
      headcount: active.byClient.get(c.id) ?? 0,
      hours: round2(m.hours),
      fillPct: total > 0 ? pct1(filled.get(c.id) ?? 0, total) : null,
      nps: latestNps.get(c.id) ?? null,
      health: null,
      healthLabel: h ? HEALTH_WORD[h.health as ClientHealth] : null,
      trend: (trend.get(c.id) ?? new Array<number>(TREND_WEEKS).fill(0)).map(round2),
      href: `/clients/${c.id}`,
    };
  });
  clients.sort((a, b) => b.billed - a.billed || b.headcount - a.headcount || a.name.localeCompare(b.name));

  const top = clients[0] && clients[0].billed > 0 ? clients[0] : null;
  const concentration = {
    topSharePct: top ? top.sharePct : 0,
    topClientName: top ? top.name : null,
    thresholdPct: CONCENTRATION_THRESHOLD_PCT,
    hhi: hhiOf(billedOf),
  };

  // ----- Pipeline: the open stages, most advanced first -----
  const stageOrder = [...OPEN_PROSPECT_STAGES].reverse();
  const rows = prospects.map((p) => {
    const rate = p.estBillRate === null ? null : Number(p.estBillRate);
    const annual = prospectAnnualValue(p.estWeeklyHours, rate);
    const weekly = p.estWeeklyHours != null && rate != null ? round2(p.estWeeklyHours * rate) : null;
    return { p, weekly, weighted: prospectWeightedValue(p.stage, annual) ?? 0 };
  });
  const stages: ExecPipelineStage[] = stageOrder.map((stage) => {
    const at = rows.filter((r) => r.p.stage === stage);
    return {
      stage,
      label: PROSPECT_STAGE_LABELS[stage],
      count: at.length,
      weeklyValue: round2(at.reduce((n, r) => n + (r.weekly ?? 0), 0)),
      probability: PROSPECT_STAGE_WEIGHTS[stage],
      weightedAnnual: round2(at.reduce((n, r) => n + r.weighted, 0)),
    };
  });
  const rank = new Map(stageOrder.map((s, i) => [s as string, i]));
  const pipeline = {
    stages,
    weightedAnnual: round2(stages.reduce((n, s) => n + s.weightedAnnual, 0)),
    prospects: rows
      .sort((a, b) => (rank.get(a.p.stage) ?? 9) - (rank.get(b.p.stage) ?? 9) || (b.weekly ?? -1) - (a.weekly ?? -1) || a.p.name.localeCompare(b.p.name))
      .map((r) => ({
        id: r.p.id,
        name: r.p.name,
        stage: r.p.stage,
        stageLabel: PROSPECT_STAGE_LABELS[r.p.stage],
        weeklyValue: r.weekly,
        daysInStage: Math.max(0, Math.floor((now.getTime() - r.p.stageChangedAt.getTime()) / DAY_MS)),
      })),
  };

  // ----- The store league -----
  const siteIds = [...perSite.keys()];
  const sites = siteIds.length
    ? await db.site.findMany({ where: { tenantId, id: { in: siteIds } }, select: { id: true, name: true, clientId: true } })
    : [];
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const league = [...perSite.entries()]
    .map(([locationId, m]) => {
      const site = siteById.get(locationId);
      const clientId = site?.clientId ?? m.clientId;
      return {
        locationId,
        name: site?.name ?? 'A store no longer on file',
        clientName: clientId ? (nameOf.get(clientId) ?? 'A client no longer on file') : 'Company site',
        billed: round2(m.billed),
        margin: round2(m.billed - m.cost),
        marginPct: pct1(m.billed - m.cost, m.billed),
        hours: round2(m.hours),
        otHours: round2(m.otHours),
      };
    })
    .filter((r) => r.hours > 0)
    .sort((a, b) => b.margin - a.margin || a.name.localeCompare(b.name));

  return { period: w.period, comparison: w.comparison, clients, concentration, pipeline, league };
}
