import type { Prisma, PrismaClient, RetentionPlayKind, RiskBand } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';
import { latestWages, percentileOf } from './marketWages.js';
import { positionKey } from './marketCatalog.js';
import { tenantJob } from './tenantJobs.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Retention intelligence: how likely each active worker is to leave soon,
 * and why — so a lead can do something about it this week.
 *
 * The score (0–100) is a sum of explainable factors, each with the points
 * it adds and one line a lead can act on. No black box: the top three
 * reasons always travel with the score, and every factor below is
 * something the worker's own schedule, attendance, pay or rides show.
 *
 * WHAT THE SCORE NEVER USES. No protected characteristic — age, sex,
 * gender identity, race, colour, national origin, citizenship, religion,
 * disability, pregnancy, marital or family status, genetic information,
 * veteran status — nor anything that stands in for one (date of birth,
 * name, address, language, photo). Tenure is time with us, not age.
 * Anonymous pulse answers are never attributed to a person. The score is
 * a prompt for a conversation, never an input to discipline, pay or
 * scheduling decisions on its own, and it is never shown to the worker.
 *
 * Computed nightly per tenant (RETENTION_INTERVAL_SECONDS) and on demand.
 * Plays a lead takes are logged; ninety days later each is marked STAYED
 * or LEFT, so the desk can show which plays actually keep people.
 */

type Db = PrismaClient;

const DAY = 86_400_000;

export interface RiskReason {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export const PLAY_FOR: Record<string, RetentionPlayKind> = {
  hours_drop: 'MORE_HOURS',
  call_outs: 'SCHEDULE_FIX',
  attendance: 'CHECK_IN',
  ride_trouble: 'RIDE_HELP',
  pay_below_market: 'PAY_REVIEW',
  pay_cut: 'PAY_REVIEW',
  stale_pay: 'PAY_REVIEW',
  new_hire: 'CHECK_IN',
  lead_change: 'CHECK_IN',
};

export function bandOf(score: number): RiskBand {
  return score >= 50 ? 'HIGH' : score >= 25 ? 'MEDIUM' : 'LOW';
}

/** Suggested plays from the reasons, strongest first; recognition when the record is otherwise clean. */
export function playsFor(reasons: RiskReason[]): RetentionPlayKind[] {
  const out: RetentionPlayKind[] = [];
  for (const r of reasons) {
    const p = PLAY_FOR[r.key];
    if (p && !out.includes(p)) out.push(p);
  }
  if (!reasons.some((r) => r.key === 'attendance' || r.key === 'call_outs') && !out.includes('RECOGNITION')) out.push('RECOGNITION');
  return out.slice(0, 3);
}

/** One person's facts, gathered in bulk by computeRetention. Pure scoring below. */
export interface RiskFacts {
  baselineWeeklyHours: number;
  recentWeeklyHours: number;
  callOutsAndSwaps30d: number;
  attendancePoints: number;
  rideTrouble30d: number;
  payPercentile: number | null;
  tenureDays: number | null;
  payCutDays: number | null;
  monthsSinceRaise: number | null;
  leadChangeDays: number | null;
}

export function scoreFacts(f: RiskFacts): { score: number; band: RiskBand; reasons: RiskReason[] } {
  const reasons: RiskReason[] = [];
  if (f.baselineWeeklyHours >= 8) {
    const drop = 1 - f.recentWeeklyHours / f.baselineWeeklyHours;
    const lately = Math.round(f.recentWeeklyHours) < 1 ? `No hours lately, down from ${Math.round(f.baselineWeeklyHours)} h a week.` : `About ${Math.round(f.recentWeeklyHours)} h a week lately, down from ${Math.round(f.baselineWeeklyHours)} h.`;
    if (drop >= 0.5) reasons.push({ key: 'hours_drop', label: 'Hours fell sharply', points: 25, detail: lately });
    else if (drop >= 0.3) reasons.push({ key: 'hours_drop', label: 'Hours are down', points: 15, detail: lately });
  }
  if (f.callOutsAndSwaps30d >= 3) reasons.push({ key: 'call_outs', label: 'Giving shifts away', points: 15, detail: `${f.callOutsAndSwaps30d} call-outs or swap requests in 30 days.` });
  else if (f.callOutsAndSwaps30d === 2) reasons.push({ key: 'call_outs', label: 'Giving shifts away', points: 8, detail: '2 call-outs or swap requests in 30 days.' });
  if (f.attendancePoints >= 5) reasons.push({ key: 'attendance', label: 'Attendance slipping', points: 15, detail: `${f.attendancePoints} attendance points in 90 days.` });
  else if (f.attendancePoints >= 3) reasons.push({ key: 'attendance', label: 'Attendance slipping', points: 10, detail: `${f.attendancePoints} attendance points in 90 days.` });
  else if (f.attendancePoints >= 1.5) reasons.push({ key: 'attendance', label: 'A few late days', points: 5, detail: `${f.attendancePoints} attendance points in 90 days.` });
  if (f.rideTrouble30d >= 2) reasons.push({ key: 'ride_trouble', label: 'Trouble getting to work', points: 10, detail: `${f.rideTrouble30d} missed rides or ride problems in 30 days.` });
  else if (f.rideTrouble30d === 1) reasons.push({ key: 'ride_trouble', label: 'Trouble getting to work', points: 5, detail: 'A missed ride or a ride problem this month.' });
  if (f.payPercentile !== null && f.payPercentile < 25) reasons.push({ key: 'pay_below_market', label: 'Paid below the local market', points: 15, detail: `Pay sits near the ${f.payPercentile}th percentile for this role nearby.` });
  else if (f.payPercentile !== null && f.payPercentile < 40) reasons.push({ key: 'pay_below_market', label: 'Paid under the local median', points: 8, detail: `Pay sits near the ${f.payPercentile}th percentile for this role nearby.` });
  if (f.payCutDays !== null && f.payCutDays <= 60) reasons.push({ key: 'pay_cut', label: 'Pay went down', points: 15, detail: `Their rate dropped ${f.payCutDays} days ago.` });
  else if (f.monthsSinceRaise !== null && f.monthsSinceRaise >= 12 && (f.tenureDays ?? 0) >= 365) reasons.push({ key: 'stale_pay', label: 'No raise in a year', points: 5, detail: `Same rate for ${f.monthsSinceRaise} months.` });
  if (f.tenureDays !== null && f.tenureDays < 30) reasons.push({ key: 'new_hire', label: 'First month', points: 15, detail: `Started ${f.tenureDays} days ago — the first weeks are when most people leave.` });
  else if (f.tenureDays !== null && f.tenureDays < 90) reasons.push({ key: 'new_hire', label: 'First 90 days', points: 10, detail: `Started ${f.tenureDays} days ago.` });
  if (f.leadChangeDays !== null && f.leadChangeDays <= 45) reasons.push({ key: 'lead_change', label: 'New lead or store', points: 10, detail: `Their manager or store changed ${f.leadChangeDays} days ago.` });
  reasons.sort((a, b) => b.points - a.points);
  const score = Math.min(100, reasons.reduce((t, r) => t + r.points, 0));
  return { score, band: bandOf(score), reasons };
}

const hoursOf = (s: { startsAt: Date; endsAt: Date }) => Math.max(0, (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000);

/** Score every active, placed worker in the current tenant and settle play outcomes. */
export async function computeRetention(db: Db = defaultPrisma, now: Date = new Date()): Promise<{ scored: number; high: number }> {
  const tenantId = tenantIdForWrite();
  const people = await db.associate.findMany({
    where: { tenantId, deletedAt: null, deactivatedAt: null, assignments: { some: { endedAt: null } } },
    select: {
      id: true,
      hireDate: true,
      createdAt: true,
      assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1, select: { startedAt: true, location: { select: { marketAreaCode: true } } } },
    },
    take: 20_000,
  });
  const ids = people.map((p) => p.id);
  if (ids.length === 0) {
    await settleOutcomes(db, now);
    return { scored: 0, high: 0 };
  }

  const [shifts, callOuts, swaps, attendance, rides, users, comps, history, priorAssignments, socMap] = await Promise.all([
    db.shift.findMany({
      where: { assignedAssociateId: { in: ids }, status: { not: 'CANCELLED' }, startsAt: { gte: new Date(now.getTime() - 56 * DAY), lte: new Date(now.getTime() + 7 * DAY) } },
      select: { assignedAssociateId: true, startsAt: true, endsAt: true, position: true },
    }),
    db.callOut.groupBy({ by: ['associateId'], where: { associateId: { in: ids }, status: 'CONFIRMED', createdAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _count: { _all: true } }),
    db.shiftSwapRequest.groupBy({ by: ['requesterAssociateId'], where: { requesterAssociateId: { in: ids }, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _count: { _all: true } }),
    db.attendanceEvent.groupBy({ by: ['associateId'], where: { associateId: { in: ids }, excusedAt: null, occurredOn: { gte: new Date(now.getTime() - 90 * DAY) } }, _sum: { points: true } }),
    db.ride.groupBy({ by: ['associateId'], where: { associateId: { in: ids }, status: 'NO_SHOW', targetAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _count: { _all: true } }),
    db.user.findMany({ where: { associateId: { in: ids }, deletedAt: null }, select: { id: true, associateId: true } }),
    db.compensationRecord.findMany({ where: { associateId: { in: ids }, payType: 'HOURLY' }, orderBy: { effectiveFrom: 'desc' }, select: { associateId: true, amount: true, effectiveFrom: true } }),
    db.associateHistory.findMany({ where: { associateId: { in: ids }, effectiveFrom: { gte: new Date(now.getTime() - 60 * DAY) } }, orderBy: { effectiveFrom: 'asc' }, select: { associateId: true, managerId: true, effectiveFrom: true } }),
    db.associateAssignment.groupBy({ by: ['associateId'], where: { associateId: { in: ids }, endedAt: { not: null } }, _count: { _all: true } }),
    db.positionSocMap.findMany({ where: { tenantId }, select: { positionKey: true, socCode: true } }),
  ]);
  const userToAssociate = new Map(users.map((u) => [u.id, u.associateId!]));
  const issues = users.length
    ? await db.transportIssue.groupBy({ by: ['reportedById'], where: { reportedById: { in: users.map((u) => u.id) }, createdAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _count: { _all: true } })
    : [];

  const byPerson = <T,>(rows: T[], key: (r: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      const list = m.get(k) ?? [];
      list.push(r);
      m.set(k, list);
    }
    return m;
  };
  const shiftsBy = byPerson(shifts, (s) => s.assignedAssociateId);
  const compsBy = byPerson(comps, (c) => c.associateId);
  const historyBy = byPerson(history, (h) => h.associateId);
  const count = (rows: Array<{ _count: { _all: number } } & Record<string, unknown>>, k: string) => new Map(rows.map((r) => [String(r[k]), r._count._all]));
  const callOutN = count(callOuts as never, 'associateId');
  const swapN = count(swaps as never, 'requesterAssociateId');
  const rideN = count(rides as never, 'associateId');
  const priorN = count(priorAssignments as never, 'associateId');
  const issueN = new Map<string, number>();
  for (const i of issues) {
    const a = userToAssociate.get(i.reportedById);
    if (a) issueN.set(a, (issueN.get(a) ?? 0) + i._count._all);
  }
  const pointsBy = new Map(attendance.map((a) => [a.associateId, Number(a._sum.points ?? 0)]));
  const soc = new Map(socMap.map((r) => [r.positionKey, r.socCode]));

  // Market pay: each person's main role at their store's metro, when both are mapped.
  const facts = new Map<string, { area: string | null; socCode: string | null; rate: number | null }>();
  const pairs: Array<{ areaCode: string; socCode: string }> = [];
  for (const p of people) {
    const mine = shiftsBy.get(p.id) ?? [];
    const tally = new Map<string, number>();
    for (const s of mine) tally.set(positionKey(s.position), (tally.get(positionKey(s.position)) ?? 0) + 1);
    const main = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const socCode = main ? (soc.get(main) ?? null) : null;
    const area = p.assignments[0]?.location?.marketAreaCode ?? null;
    const rate = compsBy.get(p.id)?.[0] ? Number(compsBy.get(p.id)![0]!.amount) : null;
    facts.set(p.id, { area, socCode, rate });
    if (area && socCode) pairs.push({ areaCode: area, socCode });
  }
  const wages: Awaited<ReturnType<typeof latestWages>> = pairs.length ? await latestWages(db, pairs).catch(() => new Map()) : new Map();

  let high = 0;
  for (const p of people) {
    const mine = shiftsBy.get(p.id) ?? [];
    const recentFrom = now.getTime() - 14 * DAY;
    const baseline = mine.filter((s) => s.startsAt.getTime() < recentFrom).reduce((t, s) => t + hoursOf(s), 0) / 6;
    const recent = mine.filter((s) => s.startsAt.getTime() >= recentFrom).reduce((t, s) => t + hoursOf(s), 0) / 3;
    const f = facts.get(p.id)!;
    const w = f.area && f.socCode ? wages.get(`${f.area}|${f.socCode}`) : undefined;
    const comp = compsBy.get(p.id) ?? [];
    const cut = comp.length >= 2 && Number(comp[0]!.amount) < Number(comp[1]!.amount) ? Math.round((now.getTime() - comp[0]!.effectiveFrom.getTime()) / DAY) : null;
    const lastRaise = comp.find((c, i) => i < comp.length - 1 && Number(c.amount) > Number(comp[i + 1]!.amount)) ?? null;
    const sinceRaise = comp.length ? Math.floor((now.getTime() - (lastRaise ?? comp[comp.length - 1]!).effectiveFrom.getTime()) / (30 * DAY)) : null;
    const hist = historyBy.get(p.id) ?? [];
    const managerChange = hist.find((h, i) => i > 0 && h.managerId !== hist[i - 1]!.managerId);
    const moved = (priorN.get(p.id) ?? 0) > 0 && p.assignments[0] ? Math.round((now.getTime() - p.assignments[0].startedAt.getTime()) / DAY) : null;
    const leadChangeDays = managerChange ? Math.round((now.getTime() - managerChange.effectiveFrom.getTime()) / DAY) : moved !== null && moved <= 45 ? moved : null;
    const started = p.hireDate ?? p.createdAt;

    const { score, band, reasons } = scoreFacts({
      baselineWeeklyHours: baseline,
      recentWeeklyHours: recent,
      callOutsAndSwaps30d: (callOutN.get(p.id) ?? 0) + (swapN.get(p.id) ?? 0),
      attendancePoints: pointsBy.get(p.id) ?? 0,
      rideTrouble30d: (rideN.get(p.id) ?? 0) + (issueN.get(p.id) ?? 0),
      payPercentile: w && f.rate ? percentileOf(f.rate, w) : null,
      tenureDays: started ? Math.max(0, Math.floor((now.getTime() - started.getTime()) / DAY)) : null,
      payCutDays: cut,
      monthsSinceRaise: sinceRaise,
      leadChangeDays,
    });
    if (band === 'HIGH') high += 1;
    const data = { tenantId, score, band, reasons: reasons as unknown as Prisma.InputJsonValue, plays: playsFor(reasons) as unknown as Prisma.InputJsonValue, computedAt: now };
    await db.flightRisk.upsert({ where: { associateId: p.id }, create: { associateId: p.id, ...data }, update: data });
  }
  // People no longer active or placed drop off the desk.
  await db.flightRisk.deleteMany({ where: { tenantId, associateId: { notIn: ids } } });
  await settleOutcomes(db, now);
  return { scored: people.length, high };
}

/** Ninety days after a play — or the day they leave — it gets its outcome. */
export async function settleOutcomes(db: Db, now: Date): Promise<void> {
  const open = await db.retentionPlay.findMany({
    where: { tenantId: tenantIdForWrite(), outcome: 'PENDING' },
    select: { id: true, createdAt: true, associate: { select: { deactivatedAt: true, deletedAt: true } } },
    take: 5000,
  });
  for (const p of open) {
    const left = !!(p.associate.deactivatedAt || p.associate.deletedAt);
    if (left) await db.retentionPlay.update({ where: { id: p.id }, data: { outcome: 'LEFT', outcomeAt: p.associate.deactivatedAt ?? now } });
    else if (now.getTime() - p.createdAt.getTime() >= 90 * DAY) await db.retentionPlay.update({ where: { id: p.id }, data: { outcome: 'STAYED', outcomeAt: now } });
  }
}

let timer: NodeJS.Timeout | null = null;

export function startRetentionCron(): void {
  if (timer || env.RETENTION_INTERVAL_SECONDS === 0) return;
  const tick = () => {
    void tenantJob('retentionScores', () => computeRetention())().catch((err) => console.error('[alto-people/api] retention scoring failed:', err));
  };
  timer = setInterval(tick, env.RETENTION_INTERVAL_SECONDS * 1000);
  timer.unref();
}
