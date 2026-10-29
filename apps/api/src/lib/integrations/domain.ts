import { paidMinutesForRange } from '@alto-people/shared';
import { prisma } from '../../db.js';
import type { PayrollExportBatch, PayrollExportRow, ScheduleRecord, TimesheetRecord, WorkerRecord } from './adapter.js';
import { companyWorkweek, dateKeyInZone, orgDateKey } from '../timeAnomalies.js';
import { addDaysToKey, dateColumnKey } from '../timezone.js';

/**
 * Brief 3-5: Alto's records as the adapters see them. Loaded once per sync,
 * vendor-neutral, tenant-scoped by the context the runner opened.
 */

const DAY = 86_400_000;

function listName(firstName: string, lastName: string): string {
  return `${lastName}, ${firstName}`;
}

/** Every associate on record with their current placement, separated ones included (the vendor needs the end date). */
export async function workersForSync(tenantId: string): Promise<WorkerRecord[]> {
  const rows = await prisma.associate.findMany({
    where: { tenantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      hireDate: true,
      separatedAt: true,
      employmentType: true,
      jobProfile: { select: { title: true } },
      assignments: {
        where: { endedAt: null },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { location: { select: { name: true, client: { select: { name: true } } } } },
      },
    },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 5000,
  });
  return rows.map((a) => {
    const placement = a.assignments[0]?.location ?? null;
    return {
      ref: a.id,
      externalId: null,
      firstName: a.firstName,
      lastName: a.lastName,
      email: a.email,
      phone: a.phone,
      hireDate: a.hireDate ? dateColumnKey(a.hireDate) : null,
      separatedAt: a.separatedAt ? orgDateKey(a.separatedAt) : null,
      employmentType: a.employmentType,
      clientName: placement?.client?.name ?? null,
      siteName: placement?.name ?? null,
      position: a.jobProfile?.title ?? null,
    };
  });
}

/** Assigned shifts from yesterday through the next fourteen days: what a vendor's scheduler needs to mirror. */
export async function schedulesForSync(tenantId: string, now: Date): Promise<ScheduleRecord[]> {
  const rows = await prisma.shift.findMany({
    where: {
      tenantId,
      status: { in: ['ASSIGNED', 'COMPLETED'] },
      startsAt: { gte: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + 14 * DAY) },
    },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      position: true,
      status: true,
      assignedAssociateId: true,
      assignedAssociate: { select: { email: true } },
      locationRel: { select: { name: true } },
      client: { select: { name: true } },
    },
    orderBy: { startsAt: 'asc' },
    take: 20_000,
  });
  return rows.map((s) => ({
    ref: s.id,
    workerRef: s.assignedAssociateId,
    workerEmail: s.assignedAssociate?.email ?? null,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    position: s.position,
    siteName: s.locationRel?.name ?? null,
    clientName: s.client?.name ?? null,
    status: s.status,
  }));
}

/** The company week ends on Friday (memory: org workweek); the week-ending date for a day (YYYY-MM-DD). */
function weekEndingFriday(day: string): string {
  const dow = new Date(`${day}T00:00:00.000Z`).getUTCDay(); // 0 Sun … 5 Fri, 6 Sat
  return addDaysToKey(day, dow <= 5 ? 5 - dow : 6);
}

/**
 * APPROVED time in a period, one line per person per day — the shape a
 * Fieldglass timesheet takes. Hours follow the shared paid-minutes rule
 * (the unpaid break on a long shift), so what is submitted is what is paid.
 */
export async function timesheetsForPeriod(tenantId: string, periodStart: string, periodEnd: string): Promise<TimesheetRecord[]> {
  // A day either side, then each punch kept by its site's own day (a 7 PM Pacific punch on the last day is in).
  const from = new Date(new Date(`${periodStart}T00:00:00.000Z`).getTime() - DAY);
  const to = new Date(new Date(`${periodEnd}T00:00:00.000Z`).getTime() + 2 * DAY);
  const entries = await prisma.timeEntry.findMany({
    where: { tenantId, status: 'APPROVED', clockInAt: { gte: from, lt: to }, clockOutAt: { not: null } },
    select: {
      id: true,
      clockInAt: true,
      clockOutAt: true,
      associate: { select: { id: true, firstName: true, lastName: true, email: true } },
      location: { select: { name: true, timezone: true, client: { select: { name: true, fieldglassSiteName: true, fieldglassBillRate: true } } } },
    },
    orderBy: { clockInAt: 'asc' },
    take: 50_000,
  });
  const byKey = new Map<string, TimesheetRecord>();
  for (const e of entries) {
    if (!e.clockOutAt) continue;
    const day = dateKeyInZone(e.clockInAt, e.location?.timezone ?? companyWorkweek().timezone);
    if (day < periodStart || day > periodEnd) continue;
    const key = `${e.associate.id}:${day}`;
    const hours = Math.round((paidMinutesForRange(e.clockInAt, e.clockOutAt) / 60) * 100) / 100;
    const existing = byKey.get(key);
    if (existing) {
      existing.hours = Math.round((existing.hours + hours) * 100) / 100;
      existing.entryIds.push(e.id);
      continue;
    }
    byKey.set(key, {
      ref: key,
      workerRef: e.associate.id,
      workerEmail: e.associate.email,
      workerListName: listName(e.associate.firstName, e.associate.lastName),
      day,
      weekEnding: weekEndingFriday(day),
      hours,
      site: e.location?.client?.fieldglassSiteName ?? e.location?.name ?? null,
      billRate: e.location?.client?.fieldglassBillRate ? Number(e.location.client.fieldglassBillRate) : null,
      entryIds: [e.id],
    });
  }
  return [...byKey.values()];
}

/** The last period that has ended, biweekly Saturday to Friday, anchored on the org workweek; the caller may override. */
export function lastClosedPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const today = orgDateKey(now);
  const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const thisWeekStart = addDaysToKey(today, -((dow + 1) % 7));
  return { periodStart: addDaysToKey(thisWeekStart, -14), periodEnd: addDaysToKey(thisWeekStart, -1) };
}

/** A finalized or disbursed run as the export rows a payroll system imports, with the run's own totals to reconcile to. */
export async function payrollExportBatch(tenantId: string, runId: string | null): Promise<PayrollExportBatch | null> {
  const run = runId
    ? await prisma.payrollRun.findFirst({ where: { id: runId, tenantId, status: { in: ['FINALIZED', 'DISBURSED'] } }, include: { items: { include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } } } } })
    : await prisma.payrollRun.findFirst({ where: { tenantId, status: { in: ['FINALIZED', 'DISBURSED'] } }, orderBy: { periodEnd: 'desc' }, include: { items: { include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } } } } });
  if (!run) return null;
  const payDate = run.disbursedAt ? orgDateKey(run.disbursedAt) : addDaysToKey(dateColumnKey(run.periodEnd), 7);
  const rows: PayrollExportRow[] = run.items.map((i) => ({
    ref: i.id,
    workerRef: i.associate.id,
    workerEmail: i.associate.email,
    workerName: listName(i.associate.firstName, i.associate.lastName),
    payDate,
    periodStart: dateColumnKey(run.periodStart),
    periodEnd: dateColumnKey(run.periodEnd),
    hours: Number(i.hoursWorked),
    gross: Number(i.grossPay),
    net: Number(i.netPay),
    federalWithholding: Number(i.federalWithholding),
    fica: Number(i.fica),
    medicare: Number(i.medicare),
    stateWithholding: Number(i.stateWithholding),
    preTaxDeductions: Number(i.preTaxDeductions),
    postTaxDeductions: Number(i.postTaxDeductions),
  }));
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    runId: run.id,
    payDate,
    periodStart: dateColumnKey(run.periodStart),
    periodEnd: dateColumnKey(run.periodEnd),
    rows,
    totals: {
      gross: round(Number(run.totalGross)),
      net: round(Number(run.totalNet)),
      hours: round(rows.reduce((a, r) => a + r.hours, 0)),
      count: rows.length,
    },
  };
}
