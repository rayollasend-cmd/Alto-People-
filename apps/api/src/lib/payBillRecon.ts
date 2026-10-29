import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { cardOn, loadRateCards, type RateCard } from './rateCards.js';
import { isEngineDoubleTime, overtimeRateOf, premiumCost, premiumKeyOf, termsFor, PREMIUM_LABEL, type BillingTerms, type PremiumKey } from './payBillLink.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { payFor, splitByPerson } from './laborRules/hours.js';
import { loadLiveRules } from './laborRules/live.js';
import { loadPayContext } from './laborRules/payContext.js';
import { tenantIdForWrite } from './tenant.js';
import { paidPunchFilters } from './payrollRunCut.js';
import { workDayOf } from './payrollSchedule.js';

/**
 * Margin per paycheck and the payroll-to-invoice reconciliation (BEYOND).
 *
 * For a pay period's finalized runs, every paycheck is split by the clients
 * its approved hours were worked for, and each slice carries:
 *   billed     hours on a FINAL statement, priced the way the statement
 *              prices them (shift bill rate, else the rate card, else the
 *              default; overtime at the contract's multiplier), plus the
 *              premium and retro adjustments already on a bill;
 *   pending    hours on a DRAFT statement and adjustments queued for the
 *              next one;
 *   cost       wages + the employer taxes on the check + the rest of the
 *              burden (LABOR_BURDEN_PERCENT covers statutory taxes AND
 *              workers' comp, so only what the taxes don't reach is added)
 *              + allocated overhead per worked hour;
 *   margin     billed + pending − cost.
 *
 * Every dollar of billable pay that is on no bill is listed with its reason,
 * so Finance can tell a contract choice (premium not billable) from a gap
 * (no statement for those days, a rebill waiting on review).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 86_400_000;
/** Work older than this with no statement at all is a gap, not just "not billed yet". */
export const UNBILLED_GRACE_DAYS = 10;

const round2 = (v: number) => Math.round(v * 100) / 100;
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column (stored at UTC midnight) or a UTC-midnight anchor.
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type UnbilledReason =
  | 'NO_STATEMENT'
  | 'NOT_YET_BILLED'
  | 'AWAITING_REVIEW'
  | 'NOT_BILLABLE'
  | 'NEVER_REBILL'
  | 'REJECTED'
  | 'NO_RATE';

/** Reasons that are a gap Finance must close (the rest are the contract working as written, or simply early). */
export const GAP_REASONS: UnbilledReason[] = ['NO_STATEMENT', 'AWAITING_REVIEW', 'NO_RATE'];

export interface StatementRef {
  id: string;
  clientId: string;
  number: number | null;
  status: string;
}

export interface PaycheckMargin {
  payrollItemId: string;
  payrollRunId: string;
  associateId: string;
  associateName: string;
  clientId: string | null;
  clientName: string;
  hours: number;
  wages: number;
  employerTaxes: number;
  burden: number;
  overhead: number;
  cost: number;
  billed: number;
  pending: number;
  margin: number;
  /** Null when nothing is billed or pending (no revenue to divide by). */
  marginPct: number | null;
  statements: StatementRef[];
}

export interface UnbilledRow {
  associateId: string;
  associateName: string;
  payrollItemId: string;
  clientId: string | null;
  clientName: string;
  kind: 'HOURS' | 'PREMIUM' | 'RETRO';
  label: string;
  hours: number;
  /** Pay that reached no bill. */
  payAmount: number;
  reason: UnbilledReason;
  reasonText: string;
  workFrom: string | null;
  workTo: string | null;
}

export interface ReconReport {
  periodStart: string;
  periodEnd: string;
  runs: Array<{ id: string; periodStart: string; periodEnd: string; status: string; clientName: string | null; checks: number }>;
  hours: { paid: number; billed: number; onDraft: number; unbilled: number };
  premiums: { paid: number; billed: number; queued: number; awaitingReview: number; notBillable: number; unbilled: number };
  retro: { paid: number; rebilled: number; queued: number; awaitingReview: number; notRebilled: number };
  totals: { wages: number; cost: number; billed: number; pending: number; margin: number; marginPct: number | null; gapPay: number };
  paychecks: PaycheckMargin[];
  unbilled: UnbilledRow[];
}

export interface ReconInput {
  periodStart: Date;
  /** Inclusive (DATE). */
  periodEnd: Date;
  /** The caller's reach on runs (scopePayrollRuns) — ANDed with the tenant. */
  runWhere?: Prisma.PayrollRunWhereInput;
  clientId?: string | null;
  now?: Date;
}

interface EntryRow {
  associateId: string;
  clientId: string | null;
  clockInAt: Date;
  /** The site's zone: the entry's day is its clock-in's day there (lib/payrollSchedule workDayOf). */
  location: { timezone: string | null } | null;
  /** That day, YYYY-MM-DD. */
  workDay: string;
  minutes: number;
  /** The entry's share of the labor-rules engine's split (lib/laborRules/hours), in hours. */
  share: { regularHours: number; overtimeHours: number; doubleTimeHours: number };
  /** The person's overtime multiplier that week (the statement bills MULTIPLIED overtime at it). */
  otMultiplier: number;
  position: string | null;
  shiftBillRate: number | null;
}

const reasonText = (reason: UnbilledReason, clientName: string): string => {
  switch (reason) {
    case 'NO_STATEMENT':
      return `No statement for ${clientName} covers these days.`;
    case 'NOT_YET_BILLED':
      return `Not on a statement yet — ${clientName}'s statement for these days hasn't been drafted.`;
    case 'AWAITING_REVIEW':
      return 'Waiting for Finance to approve the rebill.';
    case 'NOT_BILLABLE':
      return `Not billable under ${clientName}'s contract.`;
    case 'NEVER_REBILL':
      return `${clientName}'s contract does not rebill retro pay.`;
    case 'REJECTED':
      return 'Finance decided not to rebill it.';
    case 'NO_RATE':
      return `No bill rate or default markup on file for ${clientName}.`;
  }
};

/** Reconcile the finalized pay runs inside [periodStart, periodEnd]. */
export async function reconcilePayPeriod(db: Db, input: ReconInput): Promise<ReconReport> {
  const now = input.now ?? new Date();
  const graceCut = new Date(now.getTime() - UNBILLED_GRACE_DAYS * DAY_MS);
  const runs = await db.payrollRun.findMany({
    where: {
      AND: [
        input.runWhere ?? {},
        { status: { in: ['FINALIZED', 'DISBURSED'] }, periodStart: { gte: input.periodStart }, periodEnd: { lte: input.periodEnd } },
        input.clientId ? { OR: [{ clientId: input.clientId }, { clientId: null }] } : {},
      ],
    },
    select: { id: true, periodStart: true, periodEnd: true, status: true, kind: true, clientId: true, payrollScheduleId: true, timeCut: true, client: { select: { name: true } }, _count: { select: { items: true } } },
    orderBy: { periodStart: 'asc' },
    take: 60,
  });
  const report: ReconReport = {
    periodStart: ymd(input.periodStart),
    periodEnd: ymd(input.periodEnd),
    runs: runs.map((r) => ({ id: r.id, periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd), status: r.status, clientName: r.client?.name ?? null, checks: r._count.items })),
    hours: { paid: 0, billed: 0, onDraft: 0, unbilled: 0 },
    premiums: { paid: 0, billed: 0, queued: 0, awaitingReview: 0, notBillable: 0, unbilled: 0 },
    retro: { paid: 0, rebilled: 0, queued: 0, awaitingReview: 0, notRebilled: 0 },
    totals: { wages: 0, cost: 0, billed: 0, pending: 0, margin: 0, marginPct: null, gapPay: 0 },
    paychecks: [],
    unbilled: [],
  };
  if (!runs.length) return report;
  const runById = new Map(runs.map((r) => [r.id, r]));

  const items = await db.payrollItem.findMany({
    where: { payrollRunId: { in: runs.map((r) => r.id) } },
    select: {
      id: true,
      payrollRunId: true,
      associateId: true,
      grossPay: true,
      hourlyRate: true,
      employerFica: true,
      employerMedicare: true,
      employerFuta: true,
      employerSuta: true,
      associate: { select: { firstName: true, lastName: true } },
      earnings: { select: { id: true, kind: true, amount: true, hours: true, rate: true, notes: true } },
    },
    take: 20_000,
  });
  if (!items.length) return report;

  // Approved time behind every check, from the start of the first week touched (the OT line is weekly).
  // A day of slack: a site west of the company zone starts its week later (the engine weeks by the site's zone).
  const minStart = new Date(startOfWeekUTC(new Date(Math.min(...runs.map((r) => r.periodStart.getTime())))).getTime() - DAY_MS);
  // A day past the last period's UTC end: an evening shift on its last day is the next UTC day (deep audit MONEY-1).
  const maxEndEx = new Date(Math.max(...runs.map((r) => r.periodEnd.getTime())) + 2 * DAY_MS);
  const associateIds = [...new Set(items.map((i) => i.associateId))];
  const rawEntries = await db.timeEntry.findMany({
    where: { associateId: { in: associateIds }, status: 'APPROVED', clockInAt: { gte: minStart, lt: maxEndEx } },
    select: { id: true, associateId: true, clientId: true, locationId: true, clockInAt: true, clockOutAt: true, breaks: { select: { type: true, startedAt: true, endedAt: true } }, location: { select: { id: true, state: true, city: true, timezone: true } }, shift: { select: { position: true, hourlyRate: true } } },
    orderBy: { clockInAt: 'asc' },
    take: 200_000,
  });
  // The statement's own split (lib/clientStatement): the engine over each
  // person's whole week, through the paycheck's inputs — so what this
  // reconciliation calls billed is what the statement billed.
  const pay = await loadPayContext(db);
  const work = rawEntries.map((raw) => {
    const e = pay.forPay(raw);
    return { raw, h: { id: e.id, associateId: e.associateId, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location } };
  });
  const { byEntry, byPerson } = splitByPerson(pay.rules, work.map((w) => w.h));
  const entries: EntryRow[] = work
    .map(({ raw: e, h }) => {
      const share = byEntry.get(h)!;
      return {
        associateId: e.associateId,
        clientId: e.clientId,
        clockInAt: e.clockInAt,
        location: e.location,
        workDay: workDayOf(e.clockInAt, e.location?.timezone),
        minutes: share.workedHours * 60,
        share,
        otMultiplier: byPerson.get(e.associateId)?.overtimeMultiplier ?? 1.5,
        position: e.shift?.position ?? null,
        shiftBillRate: e.shift?.hourlyRate != null ? Number(e.shift.hourlyRate) : null,
      };
    })
    .filter((e) => e.minutes > 0);

  const clientIds = [...new Set(entries.map((e) => e.clientId).filter((x): x is string => !!x))];
  const [clients, statements, cards, positions, adjustments, retros] = await Promise.all([
    db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }),
    db.clientStatement.findMany({
      where: { clientId: { in: clientIds }, periodStart: { lte: new Date(maxEndEx.getTime() - DAY_MS) }, periodEnd: { gte: minStart } },
      select: { id: true, clientId: true, number: true, status: true, periodStart: true, periodEnd: true },
    }),
    loadRateCards(db, clientIds),
    db.shiftPosition.findMany({ where: { clientId: { in: clientIds }, deletedAt: null }, select: { clientId: true, name: true, isLead: true } }),
    db.billingAdjustment.findMany({
      where: { payrollItemId: { in: items.map((i) => i.id) } },
      select: { id: true, kind: true, status: true, clientId: true, ruleKey: true, sourceKey: true, payAmount: true, amount: true, billedStatementId: true, payrollItemId: true },
    }),
    db.retroPayAdjustment.findMany({ where: { paidItemId: { in: items.map((i) => i.id) }, status: 'PAID' }, select: { id: true, paidItemId: true, amount: true } }),
  ]);
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const nameOf = (id: string | null) => (id ? (clientName.get(id) ?? 'the client') : 'No client');
  const leadOf = new Map(positions.map((p) => [`${p.clientId}:${p.name}`, p.isLead]));
  const termsCache = new Map<string, BillingTerms>();
  const terms = async (clientId: string, on: Date) => {
    const k = `${clientId}:${ymd(on)}`;
    if (!termsCache.has(k)) termsCache.set(k, await termsFor(db, clientId, on));
    return termsCache.get(k)!;
  };
  // The entry's day is the SITE's (deep audit MONEY-1), as payroll and the statement count it.
  const statementFor = (clientId: string, d: string) => {
    const hits = statements.filter((s) => s.clientId === clientId && ymd(s.periodStart) <= d && ymd(s.periodEnd) >= d);
    return hits.find((s) => s.status === 'FINAL') ?? hits[0] ?? null;
  };
  const billRate = (e: EntryRow, on: Date): number => {
    if (e.shiftBillRate != null) return e.shiftBillRate;
    if (e.clientId && e.position) {
      const card: RateCard | null = cardOn(cards, e.clientId, e.position, on);
      if (card?.billRate != null) return card.billRate;
    }
    const lead = e.clientId && e.position ? (leadOf.get(`${e.clientId}:${e.position}`) ?? false) : false;
    return lead ? env.DEFAULT_LEAD_BILL_RATE : env.DEFAULT_ASSOCIATE_BILL_RATE;
  };

  // Which hours each check paid: the run's own cut, as it was made (lib/payrollRunCut) — never UTC days.
  const paidBy = await paidPunchFilters(db, runs);
  const dayDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

  const burdenPct = env.LABOR_BURDEN_PERCENT / 100;
  const overheadPerHour = env.LABOR_OVERHEAD_PER_HOUR;

  for (const item of items) {
    const run = runById.get(item.payrollRunId)!;
    const who = `${item.associate.firstName} ${item.associate.lastName}`;
    const paidHere = paidBy.get(run.id)!;
    const mine = entries.filter((e) => e.associateId === item.associateId && paidHere(e));
    const totalMin = mine.reduce((s, e) => s + e.minutes, 0);
    const gross = Number(item.grossPay);
    const employerTaxes = Number(item.employerFica) + Number(item.employerMedicare) + Number(item.employerFuta) + Number(item.employerSuta);
    const otherBurden = Math.max(0, gross * burdenPct - employerTaxes);
    const itemAdj = adjustments.filter((a) => a.payrollItemId === item.id);

    // Slices by client (null = time with no client, or a check with no time at all).
    const slices = new Map<string | null, { minutes: number; billed: number; pending: number; statements: Map<string, StatementRef> }>();
    const slice = (c: string | null) => {
      if (!slices.has(c)) slices.set(c, { minutes: 0, billed: 0, pending: 0, statements: new Map() });
      return slices.get(c)!;
    };
    // Wages for the hours themselves: regular and overtime lines, and the engine's double-time hours at the overtime rate (the rest of that line is premium, below).
    const otRate = overtimeRateOf(item);
    const baseWages = item.earnings.reduce((s, e) => s + ((e.kind === 'REGULAR' && !e.notes) || e.kind === 'OVERTIME' ? Number(e.amount) : isEngineDoubleTime(e) ? Number(e.amount) - premiumCost(e, otRate) : 0), 0);
    const payPerMin = totalMin > 0 ? baseWages / totalMin : 0;

    // Unbilled hours, grouped per (client, reason) so a 40-hour week is one row.
    const hourGaps = new Map<string, UnbilledRow>();
    for (const e of mine) {
      const s = slice(e.clientId);
      s.minutes += e.minutes;
      if (!e.clientId) continue;
      report.hours.paid += e.minutes / 60;
      const st = statementFor(e.clientId, e.workDay);
      const t = await terms(e.clientId, st ? st.periodEnd : dayDate(e.workDay));
      // Priced as the statement prices it: overtime and double-time hours at the contract's overtime billing.
      const otMult = t.overtimeBilling === 'STRAIGHT' ? 1 : e.otMultiplier;
      const rate = billRate(e, st ? st.periodEnd : dayDate(e.workDay));
      const amount = e.share.regularHours * rate + (e.share.overtimeHours + e.share.doubleTimeHours) * rate * otMult;
      if (st) s.statements.set(st.id, { id: st.id, clientId: st.clientId, number: st.number, status: st.status });
      if (st?.status === 'FINAL') {
        s.billed += amount;
        report.hours.billed += e.minutes / 60;
      } else if (st) {
        s.pending += amount;
        report.hours.onDraft += e.minutes / 60;
      } else {
        report.hours.unbilled += e.minutes / 60;
        const reason: UnbilledReason = e.clockInAt < graceCut ? 'NO_STATEMENT' : 'NOT_YET_BILLED';
        const k = `${e.clientId}:${reason}`;
        const row = hourGaps.get(k) ?? {
          associateId: item.associateId,
          associateName: who,
          payrollItemId: item.id,
          clientId: e.clientId,
          clientName: nameOf(e.clientId),
          kind: 'HOURS' as const,
          label: 'Hours worked',
          hours: 0,
          payAmount: 0,
          reason,
          reasonText: reasonText(reason, nameOf(e.clientId)),
          workFrom: e.workDay,
          workTo: e.workDay,
        };
        row.hours += e.minutes / 60;
        row.payAmount += e.minutes * payPerMin;
        if (row.workFrom! > e.workDay) row.workFrom = e.workDay;
        if (row.workTo! < e.workDay) row.workTo = e.workDay;
        hourGaps.set(k, row);
      }
    }
    if (!slices.size) slice(null);
    for (const r of hourGaps.values()) report.unbilled.push({ ...r, hours: round2(r.hours), payAmount: round2(r.payAmount) });

    // Adjustments on bills (or waiting for one) count toward their client's slice.
    for (const a of itemAdj) {
      if (a.kind === 'REVERSAL') continue;
      const s = slice(a.clientId);
      const amt = Number(a.amount);
      if (a.status === 'BILLED') s.billed += amt;
      else if (a.status === 'READY' || a.status === 'PENDING_REVIEW') s.pending += amt;
    }

    // Premiums paid vs billed.
    const clientShares = [...slices.entries()].filter(([c]) => c !== null).map(([c, s]) => ({ clientId: c as string, fraction: totalMin > 0 ? s.minutes / totalMin : 0 }));
    for (const line of item.earnings) {
      const isPredict = line.kind === 'PREMIUM' && !!line.notes && / — shift /.test(line.notes);
      const key: PremiumKey | null = isPredict ? 'PREDICTABILITY' : premiumKeyOf({ kind: line.kind, notes: line.notes, rate: line.rate == null ? null : Number(line.rate) });
      const paid = premiumCost(line, otRate);
      if (!key || paid <= 0.004) continue;
      report.premiums.paid += paid;
      if (!clientShares.length) continue;
      for (const share of clientShares) {
        const cost = paid * share.fraction;
        if (cost < 0.005) continue;
        const adj = isPredict
          ? itemAdj.filter((a) => a.kind === 'PREMIUM' && a.ruleKey === 'PREDICTABILITY' && a.clientId === share.clientId)
          : itemAdj.filter((a) => a.sourceKey === `premium:${line.id}:${share.clientId}`);
        const covered = adj.filter((a) => a.status !== 'VOID');
        for (const a of covered) {
          const pay = Math.min(cost, Number(a.payAmount));
          if (a.status === 'BILLED') report.premiums.billed += pay;
          else if (a.status === 'READY') report.premiums.queued += pay;
          else if (a.status === 'PENDING_REVIEW') report.premiums.awaitingReview += pay;
        }
        const left = cost - covered.reduce((s, a) => s + Number(a.payAmount), 0);
        if (left < 0.01) continue;
        const t = await terms(share.clientId, run.periodEnd);
        const reason: UnbilledReason = adj.some((a) => a.status === 'VOID') ? 'REJECTED' : t.premiumRules[key].mode === 'NOT_BILLABLE' ? 'NOT_BILLABLE' : 'NO_RATE';
        if (reason === 'NOT_BILLABLE') report.premiums.notBillable += left;
        else report.premiums.unbilled += left;
        report.unbilled.push({
          associateId: item.associateId,
          associateName: who,
          payrollItemId: item.id,
          clientId: share.clientId,
          clientName: nameOf(share.clientId),
          kind: 'PREMIUM',
          label: `${PREMIUM_LABEL[key]}${line.notes ? ` (${line.notes})` : ''}`,
          hours: round2((line.hours == null ? 0 : Number(line.hours)) * share.fraction),
          payAmount: round2(left),
          reason,
          reasonText: reasonText(reason, nameOf(share.clientId)),
          workFrom: ymd(run.periodStart),
          workTo: ymd(run.periodEnd),
        });
      }
    }

    // Retro paid vs rebilled.
    for (const r of retros.filter((x) => x.paidItemId === item.id)) {
      const paid = Number(r.amount);
      report.retro.paid += paid;
      const adj = itemAdj.filter((a) => a.kind === 'RETRO' && a.sourceKey?.startsWith(`retro:${r.id}:`));
      let covered = 0;
      for (const a of adj) {
        const pay = Number(a.payAmount);
        if (a.status === 'VOID') continue;
        covered += pay;
        if (a.status === 'BILLED') report.retro.rebilled += pay;
        else if (a.status === 'READY') report.retro.queued += pay;
        else if (a.status === 'PENDING_REVIEW') report.retro.awaitingReview += pay;
      }
      for (const a of adj.filter((x) => x.status === 'PENDING_REVIEW')) {
        report.unbilled.push({
          associateId: item.associateId,
          associateName: who,
          payrollItemId: item.id,
          clientId: a.clientId,
          clientName: nameOf(a.clientId),
          kind: 'RETRO',
          label: 'Retroactive pay',
          hours: 0,
          payAmount: round2(Number(a.payAmount)),
          reason: 'AWAITING_REVIEW',
          reasonText: reasonText('AWAITING_REVIEW', nameOf(a.clientId)),
          workFrom: null,
          workTo: null,
        });
      }
      const left = paid - covered;
      if (left < 0.01) continue;
      report.retro.notRebilled += left;
      // Why: a contract that never rebills, a rejected rebill, or no rate to price it.
      const share = clientShares[0];
      let reason: UnbilledReason = 'NO_RATE';
      if (adj.some((a) => a.status === 'VOID')) reason = 'REJECTED';
      else if (share && (await terms(share.clientId, run.periodEnd)).retroRebill === 'NEVER') reason = 'NEVER_REBILL';
      report.unbilled.push({
        associateId: item.associateId,
        associateName: who,
        payrollItemId: item.id,
        clientId: share?.clientId ?? null,
        clientName: nameOf(share?.clientId ?? null),
        kind: 'RETRO',
        label: 'Retroactive pay',
        hours: 0,
        payAmount: round2(left),
        reason,
        reasonText: reasonText(reason, nameOf(share?.clientId ?? null)),
        workFrom: null,
        workTo: null,
      });
    }

    // Margin per slice: the check's cost split by the slice's share of the hours.
    for (const [c, s] of slices) {
      // Margin is for pay tied to a client; time with no client (or a check with no time) has no bill to set against.
      if (c === null) continue;
      const fraction = totalMin > 0 ? s.minutes / totalMin : 1 / slices.size;
      const hours = s.minutes / 60;
      const wages = gross * fraction;
      const taxes = employerTaxes * fraction;
      const burden = otherBurden * fraction;
      const overhead = overheadPerHour * hours;
      const cost = wages + taxes + burden + overhead;
      const revenue = s.billed + s.pending;
      report.paychecks.push({
        payrollItemId: item.id,
        payrollRunId: item.payrollRunId,
        associateId: item.associateId,
        associateName: who,
        clientId: c,
        clientName: nameOf(c),
        hours: round2(hours),
        wages: round2(wages),
        employerTaxes: round2(taxes),
        burden: round2(burden),
        overhead: round2(overhead),
        cost: round2(cost),
        billed: round2(s.billed),
        pending: round2(s.pending),
        margin: round2(revenue - cost),
        marginPct: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
        statements: [...s.statements.values()],
      });
      report.totals.wages += wages;
      report.totals.cost += cost;
      report.totals.billed += s.billed;
      report.totals.pending += s.pending;
    }
  }

  const r2 = <T extends Record<string, number>>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)])) as T;
  report.hours = r2(report.hours);
  report.premiums = r2(report.premiums);
  report.retro = r2(report.retro);
  const revenue = report.totals.billed + report.totals.pending;
  report.totals.margin = revenue - report.totals.cost;
  report.totals.marginPct = revenue > 0 ? round2((report.totals.margin / revenue) * 100) : null;
  report.totals.gapPay = report.unbilled.filter((u) => GAP_REASONS.includes(u.reason)).reduce((s, u) => s + u.payAmount, 0);
  const { marginPct } = report.totals;
  report.totals = { ...r2({ wages: report.totals.wages, cost: report.totals.cost, billed: report.totals.billed, pending: report.totals.pending, margin: report.totals.margin, gapPay: report.totals.gapPay }), marginPct };
  report.paychecks.sort((a, b) => a.associateName.localeCompare(b.associateName) || a.clientName.localeCompare(b.clientName));
  report.unbilled.sort((a, b) => b.payAmount - a.payAmount);
  return report;
}

/** The Inbox's number: billable pay on no bill (gaps only) over the last `days` of finalized pay. */
export async function unbilledGap(db: Db, runWhere: Prisma.PayrollRunWhereInput, now: Date = new Date(), days = 120): Promise<UnbilledGap> {
  const start = new Date(now.getTime() - days * DAY_MS);
  const report = await reconcilePayPeriod(db, { periodStart: new Date(`${ymd(start)}T00:00:00.000Z`), periodEnd: new Date(`${ymd(now)}T00:00:00.000Z`), runWhere, now });
  const gaps = report.unbilled.filter((u) => GAP_REASONS.includes(u.reason));
  // The pay periods the gaps fall in, oldest first — the link opens the page on the oldest (deep audit MONEY-2:
  // a link without its period opened on the newest one, which said "No gaps").
  const periodOf = (day: string | null) => (day ? report.runs.find((r) => r.periodStart <= day && r.periodEnd >= day) : undefined);
  const periods = [...new Set(gaps.map((g) => periodOf(g.workFrom)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => `${r.periodStart}:${r.periodEnd}`))].sort();
  return { count: gaps.length, amount: round2(gaps.reduce((s, u) => s + u.payAmount, 0)), periods };
}

/** Billable pay on no statement: how many lines, how much, and the pay periods they fall in (`start:end`, oldest first). */
export interface UnbilledGap {
  count: number;
  amount: number;
  periods: string[];
}

/* ----- This week's running payroll cost, per store ----------------------- */

export interface StoreRunningCost {
  siteId: string | null;
  siteName: string;
  clientName: string | null;
  hours: number;
  overtimeHours: number;
  wages: number;
  /** Wages + burden + overhead per hour. */
  loadedCost: number;
  onClockNow: number;
}

/**
 * What this org week (Sat→Fri) has cost so far at each store: every
 * approved, completed and live minute at the person's hourly rate, split
 * by the labor-rules engine as pay splits it (all stores combined, the
 * overtime and double time falling where they were worked, at their
 * multipliers), loaded with the burden and overhead. `entryWhere` is the
 * caller's reach (scopeTimeEntries) — ANDed with the tenant by the route.
 */
export async function runningPayrollCost(db: Db, entryWhere: Prisma.TimeEntryWhereInput, weekStart: Date, now: Date = new Date()): Promise<{ stores: StoreRunningCost[]; totals: { hours: number; wages: number; loadedCost: number; onClockNow: number } }> {
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  const rows = await db.timeEntry.findMany({
    where: { AND: [entryWhere, { status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] }, clockInAt: { gte: weekStart, lt: weekEnd } }] },
    select: { id: true, associateId: true, locationId: true, clockInAt: true, clockOutAt: true, status: true, breaks: { select: { type: true, startedAt: true, endedAt: true } }, location: { select: { id: true, state: true, city: true, timezone: true } } },
    orderBy: { clockInAt: 'asc' },
    take: 100_000,
  });
  const people = [...new Set(rows.map((r) => r.associateId))];
  const [comps, sites] = await Promise.all([
    db.compensationRecord.findMany({ where: { associateId: { in: people }, payType: 'HOURLY', effectiveTo: null }, orderBy: { effectiveFrom: 'desc' }, select: { associateId: true, amount: true } }),
    db.site.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, client: { select: { name: true } } } }),
  ]);
  const rateOf = new Map<string, number>();
  for (const c of comps) if (!rateOf.has(c.associateId)) rateOf.set(c.associateId, Number(c.amount));
  const siteOf = new Map(sites.map((s) => [s.id, s]));
  const burden = 1 + env.LABOR_BURDEN_PERCENT / 100;
  const by = new Map<string | null, StoreRunningCost>();
  // The week split as pay splits it (lib/laborRules/hours): each person's
  // whole week across stores, a live jurisdiction's daily rules included,
  // the overtime on the hours that ran past the line; a running punch counts
  // to now (at most 16 h, so a forgotten clock-out can't run away).
  const live = await loadLiveRules(db, tenantIdForWrite());
  const work = rows.map((r) => ({
    r,
    h: {
      id: r.id,
      associateId: r.associateId,
      clockInAt: r.clockInAt,
      clockOutAt: r.clockOutAt ?? (r.status === 'ACTIVE' && now > r.clockInAt ? new Date(Math.min(now.getTime(), r.clockInAt.getTime() + 16 * 3_600_000)) : null),
      breaks: r.breaks,
      site: r.location,
    },
  }));
  const { byEntry, byPerson } = splitByPerson(live, work.map((w) => w.h));
  for (const { r, h } of work) {
    const share = byEntry.get(h)!;
    const minutes = share.workedHours * 60;
    if (minutes <= 0) continue;
    const ot = (share.overtimeHours + share.doubleTimeHours) * 60;
    const rate = rateOf.get(r.associateId) ?? env.DEFAULT_ASSOCIATE_PAY_RATE;
    const wages = payFor(share, rate, byPerson.get(r.associateId)!);
    const site = r.locationId ? siteOf.get(r.locationId) : undefined;
    const s = by.get(r.locationId) ?? { siteId: r.locationId, siteName: site?.name ?? 'No store recorded', clientName: site?.client?.name ?? null, hours: 0, overtimeHours: 0, wages: 0, loadedCost: 0, onClockNow: 0 };
    s.hours += minutes / 60;
    s.overtimeHours += ot / 60;
    s.wages += wages;
    s.loadedCost += wages * burden + (minutes / 60) * env.LABOR_OVERHEAD_PER_HOUR;
    if (!r.clockOutAt && r.status === 'ACTIVE') s.onClockNow += 1;
    by.set(r.locationId, s);
  }
  const stores = [...by.values()]
    .map((s) => ({ ...s, hours: round2(s.hours), overtimeHours: round2(s.overtimeHours), wages: round2(s.wages), loadedCost: round2(s.loadedCost) }))
    .sort((a, b) => b.loadedCost - a.loadedCost);
  return {
    stores,
    totals: {
      hours: round2(stores.reduce((x, s) => x + s.hours, 0)),
      wages: round2(stores.reduce((x, s) => x + s.wages, 0)),
      loadedCost: round2(stores.reduce((x, s) => x + s.loadedCost, 0)),
      onClockNow: stores.reduce((x, s) => x + s.onClockNow, 0),
    },
  };
}

const gapMemo = new Map<string, { at: number; value: Promise<UnbilledGap> }>();
/** unbilledGap, shared for five minutes per tenant and reach (the Inbox asks on every page). */
export function unbilledGapCached(db: Db, key: string, runWhere: Prisma.PayrollRunWhereInput): Promise<UnbilledGap> {
  const hit = gapMemo.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = unbilledGap(db, runWhere).catch((err) => {
    gapMemo.delete(key);
    throw err;
  });
  gapMemo.set(key, { at: Date.now(), value });
  return value;
}

/** Test hook: forget the cached gap. */
export function __resetUnbilledGapCache(): void {
  gapMemo.clear();
}
