import type { FieldglassStatus } from '@alto-people/shared';
import { prisma } from '../db.js';
import { DEFAULT_TIMEZONE, localDateKey } from './timezone.js';
import { netWorkedMinutes, utcInstantOfLocalMidnight, type BreakFacts } from './timeAnomalies.js';
import { loadLiveRules } from './laborRules/live.js';
import { payFor, splitByPerson } from './laborRules/hours.js';
import { tenantIdForWrite } from './tenant.js';
import { round2 } from './payroll.js';
import { ageStatements, type AgingBuckets } from './books/aging.js';
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
 *                 the associate's hourly pay split by the labor-rules
 *                 engine exactly as the paycheck splits it — overtime
 *                 and double time at its multipliers — payroll's $15
 *                 fallback included)
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

export async function payCycle(now: Date = new Date(), opts: { tenantId?: string } = {}): Promise<PayCycle | null> {
  // Brief 2-1: a route passes the caller's tenant; callers without one read every row as before.
  const tenant = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const live = { isActive: true, deletedAt: null, ...tenant };
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
      where: { ...tenant, clockInAt: { gte: from, lt: to }, status: { in: ['APPROVED', 'COMPLETED'] }, clockOutAt: { not: null } },
      select: { clockInAt: true, clockOutAt: true, status: true, breaks: { select: { type: true, startedAt: true, endedAt: true } } },
      take: 50_000,
    }),
    prisma.payrollRun.findFirst({
      where: {
        ...tenant,
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
export async function billingWeek(
  now: Date = new Date(),
  /** Brief 2-1: the tenant to read, until enforce mode filters every query. Absent = no filter (unchanged). */
  opts: { tenantId?: string } = {},
): Promise<BillingWeek> {
  const T = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const current = saturdayWeek(now, DEFAULT_TIMEZONE);
  const weekStart = addDays(current.weekStart, -7);
  const week = await buildTimesheetWeek(prisma, {
    weekStart: new Date(`${weekStart}T12:00:00Z`),
    showMoney: true,
    ...(opts.tenantId ? { scopeWhere: T, shiftScopeWhere: T } : {}),
  });
  const clientIds = [...new Set(week.rows.map((r) => r.clientId).filter((x): x is string => !!x))];
  const earlier = await prisma.fieldglassTimesheet.findMany({
    where: {
      ...T,
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
  /** Brief 2-1: the tenant to read, until enforce mode filters every query. Absent = no filter (unchanged). */
  opts: { tenantId?: string } = {},
): Promise<{ weeks: MarginWeek[]; defaultRate: number; defaultRateAssociates: number }> {
  const T = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const current = saturdayWeek(now, DEFAULT_TIMEZONE).weekStart;
  const starts = Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
  const startSet = new Set(starts);
  const entries = await prisma.timeEntry.findMany({
    where: {
      ...T,
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
      location: { select: { id: true, state: true, city: true, timezone: true } },
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

  // Wages split by the labor-rules engine (lib/laborRules/hours): each
  // person's weeks exactly as their paycheck splits them — the federal
  // weekly 40, or a live jurisdiction's daily and double-time rules — and
  // each entry's share priced at their rate and the split's multipliers.
  const rules = await loadLiveRules(prisma, opts.tenantId ?? tenantIdForWrite());
  const work = entries.map((e) => ({ ...e, site: e.location }));
  const { byEntry, byPerson } = splitByPerson(rules, work);

  // Minutes per week per person+client (for revenue), wages per week (for the margin).
  // Revenue is billed the way the VMS bills it — each person's week at a client in
  // hundredths of an hour (lib/timesheetWeek), times the client's rate — so "Revenue ·
  // last week" and the billing card's dollars for the same week agree to the cent
  // (they read $6,601.50 and $6,601.73: exact minutes against rounded rows).
  const byWeek = new Map<string, { people: Map<string, number>; rows: Map<string, { clientId: string; min: number }>; wages: number }>();
  for (const e of work) {
    const ws = saturdayWeek(e.clockInAt, e.location?.timezone ?? DEFAULT_TIMEZONE).weekStart;
    if (!startSet.has(ws)) continue;
    const share = byEntry.get(e)!;
    const min = share.workedHours * 60;
    const b = byWeek.get(ws) ?? { people: new Map(), rows: new Map(), wages: 0 };
    b.people.set(e.associateId, (b.people.get(e.associateId) ?? 0) + min);
    const ck = e.clientId ?? '';
    const rk = `${e.associateId}|${ck}`;
    const row = b.rows.get(rk) ?? { clientId: ck, min: 0 };
    row.min += min;
    b.rows.set(rk, row);
    b.wages += payFor(share, payRate.get(e.associateId) ?? PAYROLL_DEFAULT_RATE, byPerson.get(e.associateId)!);
    byWeek.set(ws, b);
  }

  const atDefault = new Set<string>();
  const out = starts.map((ws): MarginWeek => {
    const b = byWeek.get(ws);
    let hours = 0;
    let revenue = 0;
    let wages = b?.wages ?? 0;
    let unpriced = 0;
    for (const { clientId, min } of b?.rows.values() ?? []) {
      const h = round2(min / 60);
      hours += h;
      const rate = clientId ? (billRate.get(clientId) ?? null) : null;
      if (rate === null) unpriced += h;
      else revenue += h * rate;
    }
    for (const associateId of b?.people.keys() ?? []) {
      if (!payRate.has(associateId)) atDefault.add(associateId);
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
  /** The one aging definition (lib/books/aging): by days past DUE — current (not yet due), 1–30, 31–60, 61–90, over 90. */
  aging: AgingBuckets;
  byClient: Array<{ clientId: string | null; clientName: string; amount: number; oldestDays: number }>;
  /** The oldest open statement's days past due; null with nothing open. */
  oldestDays: number | null;
}

/** Open statements aged by the shared definition; the five clients owing most, each with its oldest days past due. */
export function receivablesAging(
  unpaid: Array<{ clientId: string | null; clientName: string | null; finalizedAt: Date | null; dueAt?: Date | null; periodEnd?: Date | null; amount: number }>,
  now: Date = new Date(),
): ReceivablesAging {
  const aged = ageStatements(unpaid, now);
  const byClient = new Map<string, { clientId: string | null; clientName: string; amount: number; oldestDays: number }>();
  for (const a of aged.statements) {
    const key = a.row.clientId ?? 'none';
    const c = byClient.get(key) ?? { clientId: a.row.clientId, clientName: a.row.clientName ?? 'Unassigned', amount: 0, oldestDays: 0 };
    c.amount += a.row.amount;
    c.oldestDays = Math.max(c.oldestDays, a.daysPastDue);
    byClient.set(key, c);
  }
  const aging = Object.fromEntries(Object.entries(aged.buckets).map(([k, v]) => [k, round2(v)])) as AgingBuckets;
  return {
    aging,
    byClient: [...byClient.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((c) => ({ ...c, amount: round2(c.amount) })),
    oldestDays: aged.oldestDaysPastDue,
  };
}
