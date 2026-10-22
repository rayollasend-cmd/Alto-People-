import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { cardOn, loadRateCards } from './rateCards.js';
import { currentComp } from './payChanges.js';
import { addDaysYmd, dateOnly, periodContaining, ymd, type ScheduleWithVersions } from './payScheduleMembership.js';
import { inWindows, workDayOf } from './payrollSchedule.js';
import { sumApprovedHours } from './payroll.js';
import { tenantIdForWrite } from './tenant.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * What a pay change means before anyone saves it (finance walk 13): the
 * current rate, where the new one sits in the band, the bill rate from the
 * client's rate card, the margin per hour before and after, which pay
 * period it lands in, and the back pay a date in an already-paid period
 * owes (which lib/retroPay will add to the next check).
 */
export interface PayChangeContext {
  associateId: string;
  current: { payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string } | null;
  proposed: { payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string };
  deltaPct: number | null;
  band: { name: string; min: number; mid: number; max: number; currentPct: number | null; proposedPct: number } | null;
  client: { id: string; name: string } | null;
  position: string | null;
  billRate: number | null;
  burdenPct: number;
  /** Per hour: bill − pay × (1 + burden). Null without a bill rate or for salary. */
  marginBefore: number | null;
  marginAfter: number | null;
  landsIn: { scheduleName: string; periodStart: string; periodEnd: string; payDate: string } | null;
  backPay: { from: string; through: string; hours: number; amount: number } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctIn = (v: number, min: number, max: number) => (max > min ? Math.round(((v - min) / (max - min)) * 1000) / 10 : null);

interface Facts {
  name: string;
  clientId: string | null;
  clientName: string | null;
  position: string | null;
  jobProfileId: string | null;
  scheduleId: string | null;
}

async function factsFor(db: Db, associateIds: string[]): Promise<Map<string, Facts>> {
  const rows = await db.associate.findMany({
    where: { id: { in: associateIds }, tenantId: tenantIdForWrite() },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobProfileId: true,
      jobProfile: { select: { title: true } },
      payrollScheduleId: true,
      payScheduleAssignments: { where: { effectiveTo: null }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { scheduleId: true } },
      applications: { where: { deletedAt: null, status: 'APPROVED' }, orderBy: { updatedAt: 'desc' }, take: 1, select: { clientId: true, position: true, client: { select: { name: true } } } },
    },
  });
  return new Map(
    rows.map((a) => {
      const app = a.applications[0];
      return [
        a.id,
        {
          name: `${a.firstName} ${a.lastName}`.trim(),
          clientId: app?.clientId ?? null,
          clientName: app?.client?.name ?? null,
          position: app?.position ?? a.jobProfile?.title ?? null,
          jobProfileId: a.jobProfileId,
          scheduleId: a.payScheduleAssignments[0]?.scheduleId ?? a.payrollScheduleId ?? null,
        },
      ];
    }),
  );
}

export interface ProposedChange {
  associateId: string;
  payType: 'HOURLY' | 'SALARY';
  amount: number;
  effectiveFrom: string;
}

export async function payChangeContexts(db: Db, changes: ProposedChange[]): Promise<Map<string, PayChangeContext>> {
  const out = new Map<string, PayChangeContext>();
  if (changes.length === 0) return out;
  const ids = [...new Set(changes.map((c) => c.associateId))];
  const facts = await factsFor(db, ids);
  const clientIds = [...new Set([...facts.values()].map((f) => f.clientId))];
  const [cards, bands, schedules] = await Promise.all([
    loadRateCards(db, clientIds),
    db.compBand.findMany({ where: { tenantId: tenantIdForWrite(), deletedAt: null, effectiveTo: null, clientId: { in: clientIds.filter((x): x is string => !!x) } } }),
    db.payrollSchedule.findMany({
      where: { id: { in: [...new Set([...facts.values()].map((f) => f.scheduleId).filter((x): x is string => !!x))] } },
      select: { id: true, name: true, frequency: true, anchorDate: true, payDateOffsetDays: true, versions: true },
    }),
  ]);
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));
  const burdenPct = env.LABOR_BURDEN_PERCENT;

  for (const change of changes) {
    const f = facts.get(change.associateId);
    if (!f) continue;
    const cur = await currentComp(db, change.associateId);
    const current = cur ? { payType: cur.payType, amount: cur.amount, effectiveFrom: ymd(cur.effectiveFrom) } : null;
    const card = f.position ? cardOn(cards, f.clientId, f.position, dateOnly(change.effectiveFrom)) : null;
    const billRate = card?.billRate ?? null;
    const band =
      bands.find((b) => b.clientId === f.clientId && b.payType === change.payType && f.jobProfileId && b.jobProfileId === f.jobProfileId) ??
      bands.find((b) => b.clientId === f.clientId && b.payType === change.payType && !b.jobProfileId) ??
      null;
    const margin = (pay: number | null) => (billRate != null && pay != null ? round2(billRate - pay * (1 + burdenPct / 100)) : null);

    // Where it lands: the first period from the effective date that no locked run has paid this person for.
    let landsIn: PayChangeContext['landsIn'] = null;
    let backPay: PayChangeContext['backPay'] = null;
    const s = f.scheduleId ? scheduleById.get(f.scheduleId) : undefined;
    const paidRuns = await db.payrollRun.findMany({
      where: {
        tenantId: tenantIdForWrite(),
        status: { in: ['FINALIZED', 'DISBURSED'] },
        kind: { in: ['REGULAR', 'OFF_CYCLE'] },
        periodEnd: { gte: dateOnly(change.effectiveFrom) },
        items: { some: { associateId: change.associateId, status: { not: 'VOIDED' } } },
      },
      select: { periodStart: true, periodEnd: true },
    });
    const paidThrough = paidRuns.map((r) => ymd(r.periodEnd)).sort().pop() ?? null;
    if (s) {
      let p = periodContaining(s as ScheduleWithVersions, change.effectiveFrom);
      for (let i = 0; i < 40 && paidThrough && p.periodEnd <= paidThrough; i++) p = periodContaining(s as ScheduleWithVersions, addDaysYmd(p.periodEnd, 1));
      landsIn = { scheduleName: s.name, periodStart: p.periodStart, periodEnd: p.periodEnd, payDate: p.payDate };
    }
    // Back pay: approved hours from the effective date already paid at the old rate.
    if (paidThrough && cur && cur.payType === 'HOURLY' && change.payType === 'HOURLY' && change.amount !== cur.amount) {
      const entries = await db.timeEntry.findMany({
        where: { tenantId: tenantIdForWrite(), associateId: change.associateId, status: 'APPROVED', clockInAt: { gte: dateOnly(change.effectiveFrom), lt: dateOnly(addDaysYmd(paidThrough, 1)) } },
        select: { status: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } }, location: { select: { timezone: true } } },
      });
      const windows = new Map([[change.associateId, paidRuns.map((r) => ({ start: ymd(r.periodStart), end: ymd(r.periodEnd) }))]]);
      const paid = entries.filter((e) => inWindows(windows, change.associateId, workDayOf(e.clockInAt, e.location?.timezone)));
      const hours = sumApprovedHours(paid);
      if (hours > 0) backPay = { from: change.effectiveFrom, through: paidThrough, hours, amount: round2(hours * (change.amount - cur.amount)) };
    }
    const bandMin = band ? Number(band.minAmount) : 0;
    const bandMax = band ? Number(band.maxAmount) : 0;
    out.set(change.associateId, {
      associateId: change.associateId,
      current,
      proposed: { payType: change.payType, amount: change.amount, effectiveFrom: change.effectiveFrom },
      deltaPct: current && current.payType === change.payType && current.amount > 0 ? Math.round(((change.amount - current.amount) / current.amount) * 1000) / 10 : null,
      band: band
        ? { name: band.name, min: bandMin, mid: Number(band.midAmount), max: bandMax, currentPct: current && current.payType === band.payType ? pctIn(current.amount, bandMin, bandMax) : null, proposedPct: pctIn(change.amount, bandMin, bandMax) ?? 0 }
        : null,
      client: f.clientId && f.clientName ? { id: f.clientId, name: f.clientName } : null,
      position: f.position,
      billRate,
      burdenPct,
      marginBefore: current?.payType === 'HOURLY' ? margin(current.amount) : null,
      marginAfter: change.payType === 'HOURLY' ? margin(change.amount) : null,
      landsIn,
      backPay,
    });
  }
  return out;
}

/** The names payChangeContexts read, for a batch preview's rows. */
export async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const f = await factsFor(db, ids);
  return new Map([...f].map(([id, x]) => [id, x.name]));
}
