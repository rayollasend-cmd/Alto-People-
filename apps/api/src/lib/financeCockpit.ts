import type { FieldglassStatus } from '@alto-people/shared';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';
import { netWorkedMinutes, utcInstantOfLocalMidnight, type BreakFacts } from './timeAnomalies.js';
import { round2 } from './payroll.js';
import { buildTimesheetWeek, saturdayWeek, toUsDate } from './timesheetWeek.js';
import { fieldglassDueAt, fieldglassHours } from './fieldglassDesk.js';
import { getNextPayday, getPeriodAfter } from './payrollSchedule.js';

/**
 * The finance cockpit's money questions, answered from the source rows:
 *
 *   payCycle      the period the next payday pays for — its hours
 *                 (approved, still waiting) and its payroll run
 *   billingWeek   last Sat→Fri week in Fieldglass, due Monday 2 PM Pacific:
 *                 entered, approved, rejected, and the dollars approved,
 *                 with the buyer, or at risk; plus rejections from earlier
 *                 weeks still unresolved
 *   marginTrend   week by week: approved hours × the client's bill rate
 *                 (revenue) against what payroll pays for them (wages:
 *                 the associate's hourly pay, time and a half past 40 —
 *                 payroll's own rule, its $15 fallback included)
 *   receivablesAging  unpaid statements by age, and who owes the most
 */

/** Payroll's fallback for an associate with no hourly pay on file. */
export const PAYROLL_DEFAULT_RATE = 15;
const DAY_MS = 86_400_000;

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface PayCycle {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  schedule: string;
  hours: { approved: number; pending: number };
  run: { id: string; status: 'DRAFT' | 'FINALIZED' | 'DISBURSED'; totalGross: number } | null;
}

export async function payCycle(now: Date = new Date()): Promise<PayCycle | null> {
  const live = { isActive: true, deletedAt: null } as const;
  const select = { name: true, frequency: true, anchorDate: true, payDateOffsetDays: true } as const;
  // The org's schedule first — the one Alto pays on — else any active one.
  const schedule =
    (await prisma.payrollSchedule.findFirst({ where: { ...live, clientId: null }, orderBy: { createdAt: 'asc' }, select })) ??
    (await prisma.payrollSchedule.findFirst({ where: live, orderBy: { createdAt: 'asc' }, select }));
  if (!schedule) return null;
  const today = localDateKey(now, DEFAULT_TIMEZONE);
  let w = getNextPayday(schedule, new Date(`${today}T12:00:00Z`));
  if (w.payDate < today) w = getPeriodAfter(schedule, w);

  const from = utcInstantOfLocalMidnight(w.periodStart, DEFAULT_TIMEZONE);
  const to = utcInstantOfLocalMidnight(addDays(w.periodEnd, 1), DEFAULT_TIMEZONE);
  const [entries, run] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { clockInAt: { gte: from, lt: to }, status: { in: ['APPROVED', 'COMPLETED'] }, clockOutAt: { not: null } },
      select: { clockInAt: true, clockOutAt: true, status: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
      take: 50_000,
    }),
    prisma.payrollRun.findFirst({
      where: {
        status: { in: ['DRAFT', 'FINALIZED', 'DISBURSED'] },
        periodStart: { lte: new Date(`${w.periodEnd}T00:00:00Z`) },
        periodEnd: { gte: new Date(`${w.periodStart}T00:00:00Z`) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, totalGross: true },
    }),
  ]);
  let approved = 0;
  let pending = 0;
  for (const e of entries) {
    const min = netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt! }, e.breaks as BreakFacts[]);
    if (e.status === 'APPROVED') approved += min;
    else pending += min;
  }
  return {
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    payDate: w.payDate,
    schedule: schedule.name,
    // Tenths, like the close chase — nobody pays by the hundredth of an hour here.
    hours: { approved: Math.round(approved / 6) / 10, pending: Math.round(pending / 6) / 10 },
    run: run
      ? { id: run.id, status: run.status as 'DRAFT' | 'FINALIZED' | 'DISBURSED', totalGross: Number(run.totalGross) }
      : null,
  };
}

export interface BillingWeek {
  weekStart: string;
  weekEnd: string;
  weekEnding: string;
  dueAt: string;
  workers: number;
  registered: number;
  entered: number;
  toEnter: number;
  rejected: number;
  approved: number;
  submitted: number;
  notRegistered: number;
  variances: number;
  hours: number;
  money: { approved: number; awaiting: number; atRisk: number };
  unpricedHours: number;
  rejectedOpen: { count: number; amount: number };
}

/** Last completed Sat→Fri week, as Fieldglass has it. */
export async function billingWeek(now: Date = new Date()): Promise<BillingWeek> {
  const current = saturdayWeek(now, DEFAULT_TIMEZONE);
  const weekStart = addDays(current.weekStart, -7);
  const week = await buildTimesheetWeek(prisma, { weekStart: new Date(`${weekStart}T12:00:00Z`), showMoney: true });
  const clientIds = [...new Set(week.rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const earlier = await prisma.fieldglassTimesheet.findMany({
    where: {
      fgStatus: 'REJECTED',
      weekStart: { lt: new Date(`${weekStart}T00:00:00Z`), gte: new Date(`${addDays(weekStart, -84)}T00:00:00Z`) },
    },
    select: { clientId: true, enteredHours: true, fgHours: true },
  });
  const rateIds = [...new Set([...clientIds, ...earlier.map((e) => e.clientId)])];
  const rates = new Map(
    (rateIds.length
      ? await prisma.client.findMany({ where: { id: { in: rateIds } }, select: { id: true, fieldglassBillRate: true } })
      : []
    ).map((c) => [c.id, c.fieldglassBillRate != null ? Number(c.fieldglassBillRate) : null]),
  );

  const out: BillingWeek = {
    weekStart: week.weekStart,
    weekEnd: week.weekEndIso,
    weekEnding: toUsDate(week.weekEndIso),
    dueAt: fieldglassDueAt(week.weekEndIso).toISOString(),
    workers: 0,
    registered: 0,
    entered: 0,
    toEnter: 0,
    rejected: 0,
    approved: 0,
    submitted: 0,
    notRegistered: 0,
    variances: 0,
    hours: 0,
    money: { approved: 0, awaiting: 0, atRisk: 0 },
    unpricedHours: 0,
    rejectedOpen: { count: 0, amount: 0 },
  };
  for (const row of week.rows) {
    const f = row.fieldglass;
    if (!row.clientId || !f || row.total <= 0) continue;
    const status = (f.status as FieldglassStatus | null) ?? null;
    out.workers += 1;
    out.hours += row.total;
    if (f.registered) out.registered += 1;
    else out.notRegistered += 1;
    if (f.enteredAt) out.entered += 1;
    if (f.registered && ((!f.enteredAt && !status) || status === 'REJECTED')) out.toEnter += 1;
    if (status === 'REJECTED') out.rejected += 1;
    if (status === 'APPROVED' || status === 'INVOICED') out.approved += 1;
    if (status === 'SUBMITTED') out.submitted += 1;
    if (f.hours !== null && Math.abs(f.hours - row.total) >= 0.01) out.variances += 1;
    const rate = rates.get(row.clientId) ?? null;
    if (rate === null) {
      out.unpricedHours += row.total;
      continue;
    }
    const h = fieldglassHours({ registered: f.registered, status, entered: !!f.enteredAt, fgHours: f.hours, total: row.total });
    out.money.approved += h.approved * rate;
    out.money.awaiting += h.awaiting * rate;
    out.money.atRisk += h.atRisk * rate;
  }
  for (const e of earlier) {
    const rate = rates.get(e.clientId) ?? null;
    out.rejectedOpen.count += 1;
    if (rate !== null) out.rejectedOpen.amount += Number(e.enteredHours ?? e.fgHours ?? 0) * rate;
  }
  out.hours = round2(out.hours);
  out.unpricedHours = round2(out.unpricedHours);
  out.money = { approved: round2(out.money.approved), awaiting: round2(out.money.awaiting), atRisk: round2(out.money.atRisk) };
  out.rejectedOpen.amount = round2(out.rejectedOpen.amount);
  return out;
}

export interface MarginWeek {
  weekStart: string;
  weekEnd: string;
  inProgress: boolean;
  hours: number;
  revenue: number;
  wages: number;
  margin: number;
  marginPct: number | null;
  unpricedHours: number;
}

/** Revenue, wages and gross margin for the last `weeks` Sat→Fri weeks
 *  (this one, so far, included). Approved time only. */
export async function marginTrend(
  now: Date = new Date(),
  weeks = 8,
): Promise<{ weeks: MarginWeek[]; defaultRate: number; defaultRateAssociates: number }> {
  const current = saturdayWeek(now, DEFAULT_TIMEZONE).weekStart;
  const starts = Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
  const startSet = new Set(starts);
  const entries = await prisma.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockOutAt: { not: null },
      clockInAt: { gte: new Date(new Date(`${starts[0]}T00:00:00Z`).getTime() - DAY_MS), lt: now },
    },
    select: {
      associateId: true,
      clientId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      location: { select: { timezone: true } },
    },
    take: 100_000,
  });
  const associateIds = [...new Set(entries.map((e) => e.associateId))];
  const clientIds = [...new Set(entries.map((e) => e.clientId).filter((x): x is string => !!x))];
  const [comps, clients] = await Promise.all([
    associateIds.length
      ? prisma.compensationRecord.findMany({
          where: { associateId: { in: associateIds }, payType: 'HOURLY', effectiveTo: null },
          orderBy: { effectiveFrom: 'desc' },
          select: { associateId: true, amount: true },
        })
      : Promise.resolve([]),
    clientIds.length
      ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, fieldglassBillRate: true } })
      : Promise.resolve([]),
  ]);
  const payRate = new Map<string, number>();
  for (const c of comps) if (!payRate.has(c.associateId)) payRate.set(c.associateId, Number(c.amount));
  const billRate = new Map(clients.map((c) => [c.id, c.fieldglassBillRate != null ? Number(c.fieldglassBillRate) : null]));

  // Minutes per week per associate (for overtime) and per client (for revenue).
  const byWeek = new Map<string, { people: Map<string, number>; clients: Map<string, number> }>();
  for (const e of entries) {
    const ws = saturdayWeek(e.clockInAt, e.location?.timezone ?? DEFAULT_TIMEZONE).weekStart;
    if (!startSet.has(ws)) continue;
    const min = netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt! }, e.breaks as BreakFacts[]);
    const b = byWeek.get(ws) ?? { people: new Map(), clients: new Map() };
    b.people.set(e.associateId, (b.people.get(e.associateId) ?? 0) + min);
    const ck = e.clientId ?? '';
    b.clients.set(ck, (b.clients.get(ck) ?? 0) + min);
    byWeek.set(ws, b);
  }

  const atDefault = new Set<string>();
  const out = starts.map((ws): MarginWeek => {
    const b = byWeek.get(ws);
    let hours = 0;
    let revenue = 0;
    let wages = 0;
    let unpriced = 0;
    for (const [clientId, min] of b?.clients ?? []) {
      const h = min / 60;
      hours += h;
      const rate = clientId ? (billRate.get(clientId) ?? null) : null;
      if (rate === null) unpriced += h;
      else revenue += h * rate;
    }
    for (const [associateId, min] of b?.people ?? []) {
      const h = min / 60;
      const rate = payRate.get(associateId);
      if (rate === undefined) atDefault.add(associateId);
      const r = rate ?? PAYROLL_DEFAULT_RATE;
      wages += Math.min(40, h) * r + Math.max(0, h - 40) * r * 1.5;
    }
    revenue = round2(revenue);
    wages = round2(wages);
    return {
      weekStart: ws,
      weekEnd: addDays(ws, 6),
      inProgress: ws === current,
      hours: round2(hours),
      revenue,
      wages,
      margin: round2(revenue - wages),
      marginPct: revenue > 0 ? Math.round(((revenue - wages) / revenue) * 1000) / 1000 : null,
      unpricedHours: round2(unpriced),
    };
  });
  return { weeks: out, defaultRate: PAYROLL_DEFAULT_RATE, defaultRateAssociates: atDefault.size };
}

export interface ReceivablesAging {
  aging: { current: number; d31: number; d61: number; d91: number };
  byClient: Array<{ clientId: string | null; clientName: string; amount: number; oldestDays: number }>;
}

/** Unpaid statements by age since they were finalized; the five clients owing most. */
export function receivablesAging(
  unpaid: Array<{ clientId: string | null; clientName: string | null; finalizedAt: Date | null; amount: number }>,
  now: Date = new Date(),
): ReceivablesAging {
  const aging = { current: 0, d31: 0, d61: 0, d91: 0 };
  const byClient = new Map<string, { clientId: string | null; clientName: string; amount: number; oldestDays: number }>();
  for (const s of unpaid) {
    const days = s.finalizedAt ? Math.floor((now.getTime() - s.finalizedAt.getTime()) / DAY_MS) : 0;
    if (days > 90) aging.d91 += s.amount;
    else if (days > 60) aging.d61 += s.amount;
    else if (days > 30) aging.d31 += s.amount;
    else aging.current += s.amount;
    const key = s.clientId ?? 'none';
    const c = byClient.get(key) ?? { clientId: s.clientId, clientName: s.clientName ?? 'Unassigned', amount: 0, oldestDays: 0 };
    c.amount += s.amount;
    c.oldestDays = Math.max(c.oldestDays, days);
    byClient.set(key, c);
  }
  return {
    aging: { current: round2(aging.current), d31: round2(aging.d31), d61: round2(aging.d61), d91: round2(aging.d91) },
    byClient: [...byClient.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((c) => ({ ...c, amount: round2(c.amount) })),
  };
}
