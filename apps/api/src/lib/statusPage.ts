import { Prisma, type PrismaClient } from '@prisma/client';
import {
  PRODUCT_NAME,
  STATUS_COMPONENTS,
  type PublicStatus,
  type StatusComponentKey,
  type StatusComponentPublic,
  type StatusIncidentPublic,
  type StatusState,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';

/**
 * IS THE PLATFORM UP, FOR SOMEONE WHO HAS NO ACCOUNT?
 *
 * The public status page derives each component's state from what the
 * API already measures for the reliability dashboard — the route rollup,
 * kiosk punches, notification outcomes, the disbursement webhook — and
 * lays the incidents the team posted over it. Nothing here names a
 * tenant, a route or a person: states, percentages and the incident
 * timeline only.
 *
 * Rules: a missing measure is UNMEASURED, never OPERATIONAL by default
 * and never a zero; an open incident can only make a component look
 * worse than its measures, never better.
 */

type Db = Pick<PrismaClient, 'routeUsageDaily' | 'kioskPunch' | 'notification' | 'branchWebhookEvent' | 'payrollItem' | 'statusIncident' | '$queryRaw'>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_DAYS = 90;
/** Below this many calls a rate says nothing. */
const MIN_REQUESTS = 20;
const MIN_NOTIFICATIONS = 5;

const RANK: Record<StatusState, number> = { UNMEASURED: 0, OPERATIONAL: 1, DEGRADED: 2, OUTAGE: 3 };
const worse = (a: StatusState, b: StatusState): StatusState => (RANK[a] >= RANK[b] ? a : b);

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

interface Measure {
  state: StatusState;
  note: string;
}

/** Today and yesterday from the daily route rollup: the API's own error rate. */
async function apiMeasure(db: Db, now: Date): Promise<Measure & { uptime90d: number | null }> {
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const rows = await db.routeUsageDaily.groupBy({
    by: ['day'],
    where: { day: { gte: from } },
    _sum: { ok: true, clientError: true, serverError: true },
  });
  const perDay = rows.map((r) => {
    const requests = (r._sum.ok ?? 0) + (r._sum.clientError ?? 0) + (r._sum.serverError ?? 0);
    return { day: r.day, requests, serverError: r._sum.serverError ?? 0 };
  });
  const measuredDays = perDay.filter((d) => d.requests >= MIN_REQUESTS);
  const goodDays = measuredDays.filter((d) => d.serverError / d.requests < 0.05);
  const uptime90d = measuredDays.length > 0 ? Math.round((goodDays.length / measuredDays.length) * 1000) / 10 : null;

  const recentFrom = new Date(now.getTime() - 2 * DAY_MS);
  const recent = perDay.filter((d) => d.day >= recentFrom);
  const requests = recent.reduce((s, d) => s + d.requests, 0);
  const errors = recent.reduce((s, d) => s + d.serverError, 0);
  if (requests < MIN_REQUESTS) {
    // The API answered this very request; the rollup just has too little
    // in it to grade. Say so rather than inventing a rate.
    return { state: 'OPERATIONAL', note: 'Answering requests; too little traffic in the last two days to compute an error rate.', uptime90d };
  }
  const rate = errors / requests;
  const state: StatusState = rate >= 0.05 ? 'OUTAGE' : rate >= 0.01 ? 'DEGRADED' : 'OPERATIONAL';
  return { state, note: `${pct(1 - rate)} of requests succeeded over the last two days.`, uptime90d };
}

/** Punches the kiosk refused are wrong PINs and stale clocks, not outages: at worst DEGRADED. */
async function kioskMeasure(db: Db, now: Date, api: StatusState): Promise<Measure & { uptime90d: number | null }> {
  const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const days = await db.$queryRaw<Array<{ day: Date; total: bigint; rejected: bigint }>>(
    Prisma.sql`SELECT date_trunc('day', "createdAt") AS day, count(*)::bigint AS total, count(*) FILTER (WHERE action::text = 'REJECTED')::bigint AS rejected FROM "KioskPunch" WHERE "createdAt" >= ${from} GROUP BY 1`,
  );
  const measured = days.filter((d) => Number(d.total) >= 10);
  const good = measured.filter((d) => 1 - Number(d.rejected) / Number(d.total) >= 0.9);
  const uptime90d = measured.length > 0 ? Math.round((good.length / measured.length) * 1000) / 10 : null;

  const dayAgo = new Date(now.getTime() - DAY_MS);
  const [total, rejected] = await Promise.all([
    db.kioskPunch.count({ where: { createdAt: { gte: dayAgo } } }),
    db.kioskPunch.count({ where: { createdAt: { gte: dayAgo }, action: 'REJECTED' } }),
  ]);
  if (api === 'OUTAGE') return { state: 'OUTAGE', note: 'The kiosk cannot reach the platform while the API is down.', uptime90d };
  if (total < 10) return { state: 'UNMEASURED', note: 'Fewer than ten punches in the last 24 hours; nothing to grade.', uptime90d };
  const accepted = 1 - rejected / total;
  return {
    state: accepted >= 0.9 ? worse('OPERATIONAL', api) : 'DEGRADED',
    note: `${pct(accepted)} of punches accepted in the last 24 hours.`,
    uptime90d,
  };
}

/** Outcomes of what we tried to send on one channel in the last 24 hours. */
async function channelMeasure(db: Db, now: Date, channel: 'EMAIL' | 'WHATSAPP', noun: string): Promise<Measure> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const grouped = await db.notification.groupBy({
    by: ['status'],
    where: { channel, createdAt: { gte: dayAgo }, status: { in: ['SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED'] } },
    _count: { _all: true },
  });
  const n = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const failed = n('FAILED') + n('BOUNCED');
  const total = failed + n('SENT') + n('DELIVERED') + n('READ');
  if (total < MIN_NOTIFICATIONS) return { state: 'UNMEASURED', note: `Fewer than five ${noun} sent in the last 24 hours; nothing to grade.` };
  const rate = failed / total;
  return {
    state: rate >= 0.5 ? 'OUTAGE' : rate >= 0.1 ? 'DEGRADED' : 'OPERATIONAL',
    note: `${pct(1 - rate)} of ${noun} went out in the last 24 hours.`,
  };
}

/** The disbursement provider's webhook, the same reading the Payroll page shows. */
async function payrollMeasure(db: Db, now: Date): Promise<Measure> {
  if (env.PAYROLL_DISBURSEMENT_PROVIDER !== 'BRANCH') {
    return { state: 'UNMEASURED', note: 'No disbursement provider is connected on this deployment.' };
  }
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const [errors7d, latest, pending] = await Promise.all([
    db.branchWebhookEvent.count({ where: { status: 'ERROR', receivedAt: { gte: weekAgo } } }),
    db.branchWebhookEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    db.payrollItem.count({ where: { status: 'PENDING', payrollRun: { status: 'FINALIZED' } } }),
  ]);
  if (errors7d > 0) return { state: 'DEGRADED', note: 'The provider reported an error in the last seven days; the team is on it.' };
  const stale = latest !== null && now.getTime() - latest.receivedAt.getTime() > DAY_MS && pending > 0;
  if ((latest === null && pending > 0) || stale) return { state: 'DEGRADED', note: 'Confirmations from the provider are late while pay is waiting to go out.' };
  if (latest === null) return { state: 'UNMEASURED', note: 'No disbursement has run yet on this deployment.' };
  return { state: 'OPERATIONAL', note: `Last confirmation from the provider ${Math.max(1, Math.round((now.getTime() - latest.receivedAt.getTime()) / HOUR_MS))} hours ago.` };
}

function toPublic(i: {
  id: string;
  title: string;
  component: StatusComponentKey;
  impact: 'DEGRADED' | 'OUTAGE';
  state: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED';
  startedAt: Date;
  resolvedAt: Date | null;
  updates: Array<{ at: Date; state: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED'; note: string }>;
}): StatusIncidentPublic {
  return {
    id: i.id,
    title: i.title,
    component: i.component,
    impact: i.impact,
    state: i.state,
    startedAt: i.startedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    updates: i.updates.map((u) => ({ at: u.at.toISOString(), state: u.state, note: u.note })),
  };
}

export async function computePublicStatus(db: Db = defaultPrisma, now: Date = new Date()): Promise<PublicStatus> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const [api, email, messaging, payroll, incidentRows] = await Promise.all([
    apiMeasure(db, now),
    channelMeasure(db, now, 'EMAIL', 'emails'),
    channelMeasure(db, now, 'WHATSAPP', 'messages'),
    payrollMeasure(db, now),
    db.statusIncident.findMany({
      where: { OR: [{ state: { not: 'RESOLVED' } }, { resolvedAt: { gte: since } }] },
      orderBy: { startedAt: 'desc' },
      include: { updates: { orderBy: { at: 'asc' } } },
    }),
  ]);
  const kiosk = await kioskMeasure(db, now, api.state);

  const measures: Record<StatusComponentKey, Measure & { uptime90d: number | null }> = {
    API: api,
    // The web app ships with the API on the same deployment.
    WEB: { state: api.state, note: api.state === 'OPERATIONAL' ? 'Served with the API; loading normally.' : 'Served with the API and affected with it.', uptime90d: api.uptime90d },
    KIOSK: kiosk,
    MESSAGING: { ...messaging, uptime90d: null },
    PAYROLL_WEBHOOK: { ...payroll, uptime90d: null },
    EMAIL: { ...email, uptime90d: null },
  };

  // An open incident makes its component at least as bad as its impact
  // says (MONITORING is a fix being watched: degraded at most).
  const open = incidentRows.filter((i) => i.state !== 'RESOLVED');
  for (const i of open) {
    const impact: StatusState = i.state === 'MONITORING' ? 'DEGRADED' : i.impact;
    const m = measures[i.component];
    if (RANK[impact] > RANK[m.state]) measures[i.component] = { ...m, state: impact, note: `${i.title} — see the incident below.` };
  }

  const components: StatusComponentPublic[] = STATUS_COMPONENTS.map((c) => ({
    key: c.key,
    label: c.label,
    what: c.what,
    state: measures[c.key].state,
    note: measures[c.key].note,
    uptime90d: measures[c.key].uptime90d,
  }));
  const overall = components.reduce<StatusState>((acc, c) => (c.state === 'UNMEASURED' ? acc : worse(acc, c.state)), 'OPERATIONAL');

  return {
    generatedAt: now.toISOString(),
    product: PRODUCT_NAME,
    overall,
    components,
    incidents: [...open, ...incidentRows.filter((i) => i.state === 'RESOLVED')].map(toPublic),
  };
}
