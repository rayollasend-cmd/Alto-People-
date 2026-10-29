import type { BillingAdjustment, Prisma, PrismaClient } from '@prisma/client';
import { enqueueAudit } from './audit.js';
import { totalsWithTax } from './clientStatement.js';
import { cardOn, loadRateCards, type RateCard } from './rateCards.js';
import { createApprovalRequest, registerApplyHandler } from './approvalRequests.js';
import { netWorkedMinutes } from './timeAnomalies.js';
import { tenantIdForWrite } from './tenant.js';
import { fmtDay, fmtDayRange } from './humanDates.js';
import { cutOf, punchesInPeriod, workDayOf } from './payrollSchedule.js';

/**
 * The pay ↔ bill link (BEYOND). Every dollar payroll pays for work a client
 * is billed for should reach the client's bill, by the client's contract:
 *
 *   retro pay      a back-dated raise paid on this run → the matching bill
 *                  delta, at the bill-rate markup in force on the days worked
 *                  (rate cards), on the client's next statement. Per client:
 *                  AUTO (straight onto the bill), REVIEW (Finance approves
 *                  first), NEVER.
 *   premiums       double time, meal and rest premiums, predictability pay,
 *                  holiday premium and shift differentials, each billable or
 *                  not by contract, at cost (plus a markup) or at the
 *                  bill-rate markup.
 *   overtime       billed at 1.5× the bill rate (MULTIPLIED, the default) or
 *                  at straight time (STRAIGHT), read by the statement itself.
 *
 * A BillingAdjustment is created once per source (sourceKey), rides on every
 * draft statement for its client, and is claimed by the statement that
 * finalizes first — never billed twice. Voiding the payroll voids what was
 * not billed yet and reverses what was.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const PREMIUM_KEYS = ['DOUBLE_TIME', 'MEAL_REST', 'PREDICTABILITY', 'HOLIDAY', 'SHIFT_DIFFERENTIAL'] as const;
export type PremiumKey = (typeof PREMIUM_KEYS)[number];
export type PremiumMode = 'NOT_BILLABLE' | 'AT_COST' | 'BILL_MARKUP';
export interface PremiumRule {
  mode: PremiumMode;
  /** AT_COST only: added on top of the cost, in percent. */
  markupPct?: number | null;
}
export type RetroRebill = 'AUTO' | 'REVIEW' | 'NEVER';
export type OvertimeBilling = 'MULTIPLIED' | 'STRAIGHT';

export interface BillingTerms {
  id: string | null;
  clientId: string;
  effectiveFrom: string | null;
  retroRebill: RetroRebill;
  overtimeBilling: OvertimeBilling;
  premiumRules: Record<PremiumKey, PremiumRule>;
  defaultMarkupPct: number | null;
  notes: string | null;
}

export const PREMIUM_LABEL: Record<PremiumKey, string> = {
  DOUBLE_TIME: 'Double time',
  MEAL_REST: 'Meal and rest premiums',
  PREDICTABILITY: 'Predictability pay',
  HOLIDAY: 'Holiday premium',
  SHIFT_DIFFERENTIAL: 'Shift differentials',
};

const round2 = (v: number) => Math.round(v * 100) / 100;
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column or a site day's UTC-midnight anchor.
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const DAY_MS = 86_400_000;

function defaultRules(): Record<PremiumKey, PremiumRule> {
  // Nothing is billed that the contract doesn't say is billable.
  return Object.fromEntries(PREMIUM_KEYS.map((k) => [k, { mode: 'NOT_BILLABLE' as PremiumMode }])) as Record<PremiumKey, PremiumRule>;
}

export function normalizeRules(raw: unknown): Record<PremiumKey, PremiumRule> {
  const out = defaultRules();
  if (raw && typeof raw === 'object') {
    for (const k of PREMIUM_KEYS) {
      const r = (raw as Record<string, unknown>)[k] as { mode?: unknown; markupPct?: unknown } | undefined;
      if (!r) continue;
      const mode = r.mode === 'AT_COST' || r.mode === 'BILL_MARKUP' || r.mode === 'NOT_BILLABLE' ? r.mode : 'NOT_BILLABLE';
      const markupPct = typeof r.markupPct === 'number' && Number.isFinite(r.markupPct) ? r.markupPct : null;
      out[k] = { mode, markupPct: mode === 'AT_COST' ? (markupPct ?? 0) : null };
    }
  }
  return out;
}

/** The contract terms in force for a client on a date (defaults when none are on file). */
export async function termsFor(db: Db, clientId: string, on: Date = new Date()): Promise<BillingTerms> {
  const row = await db.clientBillingTerms.findFirst({
    where: { clientId, effectiveFrom: { lte: dateOnly(ymd(on)) } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!row) {
    return { id: null, clientId, effectiveFrom: null, retroRebill: 'REVIEW', overtimeBilling: 'MULTIPLIED', premiumRules: defaultRules(), defaultMarkupPct: null, notes: null };
  }
  return {
    id: row.id,
    clientId,
    effectiveFrom: ymd(row.effectiveFrom),
    retroRebill: (['AUTO', 'REVIEW', 'NEVER'].includes(row.retroRebill) ? row.retroRebill : 'REVIEW') as RetroRebill,
    overtimeBilling: row.overtimeBilling === 'STRAIGHT' ? 'STRAIGHT' : 'MULTIPLIED',
    premiumRules: normalizeRules(row.premiumRules),
    defaultMarkupPct: row.defaultMarkupPct == null ? null : Number(row.defaultMarkupPct),
    notes: row.notes,
  };
}

/**
 * Bill ÷ pay for a client's role on a day: the rate card in force then, else
 * the contract's default markup. Null when neither says — nothing is
 * invented.
 */
export function markupOn(cards: RateCard[], clientId: string, position: string | null, on: Date, terms: Pick<BillingTerms, 'defaultMarkupPct'>): number | null {
  if (position) {
    const card = cardOn(cards, clientId, position, on);
    if (card && card.billRate != null && card.payRate > 0) return card.billRate / card.payRate;
  }
  // No card for the role: the average markup across the client's cards in force, then the contract.
  const inForce = cards.filter((c) => c.clientId === clientId && c.billRate != null && c.payRate > 0 && c.effectiveFrom <= ymd(on) && (c.effectiveTo === null || c.effectiveTo >= ymd(on)));
  if (!position && inForce.length) return inForce.reduce((s, c) => s + c.billRate! / c.payRate, 0) / inForce.length;
  if (terms.defaultMarkupPct != null) return 1 + terms.defaultMarkupPct / 100;
  return null;
}

interface ClientShare {
  clientId: string;
  minutes: number;
  /** Minutes by role, for the markup. */
  byPosition: Map<string | null, number>;
  firstDay: Date;
  lastDay: Date;
}

/** Approved minutes an associate worked per client in the days [from, toExclusive) — each shift on its site's day (the pay-period cut, deep audit CODE-1 / MONEY-1). */
async function sharesFor(db: Db, associateId: string, from: Date, toExclusive: Date): Promise<ClientShare[]> {
  const entries = await punchesInPeriod(cutOf(from, toExclusive), null, (clockInAt) =>
    db.timeEntry.findMany({
      where: { associateId, status: 'APPROVED', clientId: { not: null }, clockInAt },
      select: { associateId: true, clientId: true, clockInAt: true, clockOutAt: true, location: { select: { timezone: true } }, breaks: { select: { type: true, startedAt: true, endedAt: true } }, shift: { select: { position: true } } },
      take: 5000,
    }),
  );
  const by = new Map<string, ClientShare>();
  for (const e of entries) {
    const min = netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt }, e.breaks);
    if (min <= 0 || !e.clientId) continue;
    // The work day as the statement counts it: the site's, at a UTC-midnight anchor.
    const day = dateOnly(workDayOf(e.clockInAt, e.location?.timezone));
    const s = by.get(e.clientId) ?? { clientId: e.clientId, minutes: 0, byPosition: new Map(), firstDay: day, lastDay: day };
    s.minutes += min;
    const pos = e.shift?.position ?? null;
    s.byPosition.set(pos, (s.byPosition.get(pos) ?? 0) + min);
    if (day < s.firstDay) s.firstDay = day;
    if (day > s.lastDay) s.lastDay = day;
    by.set(e.clientId, s);
  }
  return [...by.values()];
}

/** The markup weighted by the minutes worked in each role. */
function weightedMarkup(cards: RateCard[], share: ClientShare, terms: BillingTerms): number | null {
  let weighted = 0;
  let covered = 0;
  for (const [pos, min] of share.byPosition) {
    const m = markupOn(cards, share.clientId, pos, share.lastDay, terms);
    if (m == null) continue;
    weighted += m * min;
    covered += min;
  }
  if (covered === 0) return null;
  return weighted / covered;
}

/** FINAL statements of a client that cover any of the days in [from, to]. */
async function statementsCovering(db: Db, clientId: string, from: Date, to: Date): Promise<string[]> {
  const rows = await db.clientStatement.findMany({
    where: { clientId, status: 'FINAL', periodStart: { lte: to }, periodEnd: { gte: from } },
    select: { id: true },
    take: 20,
  });
  return rows.map((r) => r.id);
}

async function clientNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.client.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

const money = (v: number) => `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ----- Writing adjustments ------------------------------------------------- */

interface NewAdjustment {
  clientId: string;
  kind: 'RETRO' | 'PREMIUM' | 'REVERSAL';
  ruleKey: string | null;
  label: string;
  basis: string;
  hours: number;
  payAmount: number;
  amount: number;
  workFrom: Date | null;
  workTo: Date | null;
  associateId: string | null;
  payrollRunId: string | null;
  payrollItemId: string | null;
  sourceKey: string;
  originalStatementIds: string[];
  review: boolean;
}

/** Create one adjustment per source — the second call for the same source is a no-op. */
async function writeAdjustment(db: PrismaClient, a: NewAdjustment, actorUserId: string | null): Promise<BillingAdjustment | null> {
  if (Math.abs(a.amount) < 0.01) return null;
  const existing = await db.billingAdjustment.findUnique({ where: { sourceKey: a.sourceKey } });
  if (existing) return null;
  const row = await db.billingAdjustment.create({
    data: {
      tenantId: tenantIdForWrite(),
      clientId: a.clientId,
      kind: a.kind,
      status: a.review ? 'PENDING_REVIEW' : 'READY',
      ruleKey: a.ruleKey,
      label: a.label.slice(0, 300),
      basis: a.basis.slice(0, 300),
      hours: round2(a.hours),
      payAmount: round2(a.payAmount),
      amount: round2(a.amount),
      workFrom: a.workFrom,
      workTo: a.workTo,
      associateId: a.associateId,
      payrollRunId: a.payrollRunId,
      payrollItemId: a.payrollItemId,
      sourceKey: a.sourceKey,
      originalStatementIds: a.originalStatementIds,
    },
  });
  if (a.review) {
    const names = await clientNames(db, [a.clientId]);
    const approval = await createApprovalRequest(db, {
      kind: 'BILLING_ADJUSTMENT',
      subjectType: 'BillingAdjustment',
      subjectId: row.id,
      title: `Rebill ${money(a.amount)} to ${names.get(a.clientId) ?? 'the client'}`,
      summary: `${a.label}. ${a.basis}`,
      proposed: { billingAdjustmentId: row.id, amount: round2(a.amount), clientId: a.clientId },
      requesterUserId: actorUserId,
      approver: { capability: 'process:payroll' },
      clientId: a.clientId,
      associateId: a.associateId,
    });
    await db.billingAdjustment.update({ where: { id: row.id }, data: { approvalId: approval.id } });
  }
  enqueueAudit(
    {
      actorUserId,
      clientId: a.clientId,
      action: 'billing.adjustment_created',
      entityType: 'BillingAdjustment',
      entityId: row.id,
      metadata: { kind: a.kind, ruleKey: a.ruleKey, amount: round2(a.amount), payAmount: round2(a.payAmount), status: row.status, payrollRunId: a.payrollRunId, sourceKey: a.sourceKey },
    },
    'payBillLink',
  );
  return row;
}

/* ----- Retro pay → rebill -------------------------------------------------- */

export interface LinkResult {
  retro: number;
  premiums: number;
  skipped: Array<{ source: string; reason: string }>;
}

/**
 * After a run finalizes: rebill its retro pay and bill its premiums, by each
 * client's contract. Idempotent — safe to call again for the same run.
 */
export async function onPayrollFinalized(db: PrismaClient, runId: string, actorUserId: string | null): Promise<LinkResult> {
  const result: LinkResult = { retro: 0, premiums: 0, skipped: [] };
  const run = await db.payrollRun.findUnique({ where: { id: runId }, select: { id: true, periodStart: true, periodEnd: true, status: true } });
  if (!run || (run.status !== 'FINALIZED' && run.status !== 'DISBURSED')) return result;

  await linkRetro(db, run, actorUserId, result);
  await linkPremiums(db, run, actorUserId, result);
  return result;
}

async function linkRetro(db: PrismaClient, run: { id: string }, actorUserId: string | null, result: LinkResult): Promise<void> {
  const retros = await db.retroPayAdjustment.findMany({
    where: { paidRunId: run.id, status: 'PAID' },
    include: {
      compensationRecord: { select: { effectiveFrom: true } },
      sourceItem: { select: { payrollRun: { select: { periodStart: true, periodEnd: true } } } },
      associate: { select: { firstName: true, lastName: true } },
    },
  });
  if (!retros.length) return;
  for (const r of retros) {
    const srcStart = r.sourceItem.payrollRun.periodStart;
    const srcEnd = r.sourceItem.payrollRun.periodEnd;
    const from = new Date(Math.max(srcStart.getTime(), r.compensationRecord.effectiveFrom.getTime()));
    const toExclusive = new Date(srcEnd.getTime() + DAY_MS);
    const shares = await sharesFor(db, r.associateId, from, toExclusive);
    const totalMin = shares.reduce((s, x) => s + x.minutes, 0);
    if (totalMin <= 0) {
      result.skipped.push({ source: `retro:${r.id}`, reason: 'No approved client hours in the back-paid days.' });
      continue;
    }
    const cards = await loadRateCards(db, shares.map((s) => s.clientId));
    const names = await clientNames(db, shares.map((s) => s.clientId));
    const who = `${r.associate.firstName} ${r.associate.lastName}`;
    for (const share of shares) {
      const terms = await termsFor(db, share.clientId, share.lastDay);
      if (terms.retroRebill === 'NEVER') {
        result.skipped.push({ source: `retro:${r.id}:${share.clientId}`, reason: `${names.get(share.clientId) ?? 'The client'}'s contract does not rebill retro pay.` });
        enqueueAudit({ actorUserId, clientId: share.clientId, action: 'payroll.retro_rebill_skipped', entityType: 'RetroPayAdjustment', entityId: r.id, metadata: { reason: 'contract_never' } }, 'payBillLink');
        continue;
      }
      const markup = weightedMarkup(cards, share, terms);
      if (markup == null) {
        result.skipped.push({ source: `retro:${r.id}:${share.clientId}`, reason: `No bill rate or default markup on file for ${names.get(share.clientId) ?? 'the client'}.` });
        continue;
      }
      const fraction = share.minutes / totalMin;
      const payDelta = Number(r.amount) * fraction;
      const billDelta = payDelta * markup;
      const hours = (Number(r.regularHours) + Number(r.overtimeHours)) * fraction;
      const written = await writeAdjustment(
        db,
        {
          clientId: share.clientId,
          kind: 'RETRO',
          ruleKey: null,
          label: `Retroactive pay — ${who}, ${fmtDayRange(share.firstDay, share.lastDay)}`,
          basis: `${money(payDelta)} back pay (rate ${Number(r.oldRate).toFixed(2)} → ${Number(r.newRate).toFixed(2)}) × ${markup.toFixed(3)} bill-rate markup`,
          hours,
          payAmount: payDelta,
          amount: billDelta,
          workFrom: dateOnly(ymd(share.firstDay)),
          workTo: dateOnly(ymd(share.lastDay)),
          associateId: r.associateId,
          payrollRunId: run.id,
          payrollItemId: r.paidItemId,
          sourceKey: `retro:${r.id}:${share.clientId}`,
          originalStatementIds: await statementsCovering(db, share.clientId, share.firstDay, share.lastDay),
          review: terms.retroRebill === 'REVIEW',
        },
        actorUserId,
      );
      if (written) {
        result.retro += 1;
        // The payroll side of the same link: the retro payment knows where it was billed.
        enqueueAudit(
          {
            actorUserId,
            clientId: share.clientId,
            action: 'payroll.retro_rebill_linked',
            entityType: 'RetroPayAdjustment',
            entityId: r.id,
            metadata: { billingAdjustmentId: written.id, payDelta: round2(payDelta), billDelta: round2(billDelta), markup: Math.round(markup * 1000) / 1000, status: written.status, paidItemId: r.paidItemId },
          },
          'payBillLink',
        );
      }
    }
  }
}

/* ----- Premiums → bill, by contract ---------------------------------------- */

/** The labor-rules engine's double-time line (payrollAggregator): its hours bill as overtime on the statement. */
export const isEngineDoubleTime = (e: { kind: string; notes: string | null; hours: unknown }) => e.kind === 'DOUBLE_TIME' && e.notes === 'Double time' && e.hours != null;

/** The rate an item's overtime was paid at: its OVERTIME line's rate, else 1.5× its hourly rate. */
export function overtimeRateOf(item: { hourlyRate: unknown; earnings: ReadonlyArray<{ kind: string; rate: unknown }> }): number {
  const ot = item.earnings.find((e) => e.kind === 'OVERTIME' && e.rate != null);
  return ot ? Number(ot.rate) : Number(item.hourlyRate) * 1.5;
}

/**
 * The part of an earning line that is premium — what a contract's premium
 * rule bills. The whole line, except the engine's double-time line: its
 * hours are on the statement already, billed like overtime
 * (lib/clientStatement), so only what it paid beyond the overtime rate is.
 */
export function premiumCost(line: { kind: string; notes: string | null; hours: unknown; amount: unknown }, otRate: number): number {
  return isEngineDoubleTime(line) ? Math.max(0, Number(line.amount) - Number(line.hours) * otRate) : Number(line.amount);
}

/** Which contract rule an earning line falls under, or null when it is not a premium. */
export function premiumKeyOf(e: { kind: string; notes: string | null; rate: number | null }): PremiumKey | null {
  if (e.kind === 'DOUBLE_TIME') return 'DOUBLE_TIME';
  if (e.kind === 'HOLIDAY') return 'HOLIDAY';
  if (e.kind === 'PREMIUM') {
    // Predictability pay is billed from its own record (exact store); skip the earning line.
    if (e.notes && / — shift /.test(e.notes)) return null;
    return 'MEAL_REST';
  }
  // A differential is a REGULAR line carrying its rule's name (lib/payrollAggregator).
  if (e.kind === 'REGULAR' && e.notes) return 'SHIFT_DIFFERENTIAL';
  return null;
}

function billFor(rule: PremiumRule, cost: number, markup: number | null): { amount: number; basis: string } | null {
  if (rule.mode === 'NOT_BILLABLE') return null;
  if (rule.mode === 'AT_COST') {
    const pct = rule.markupPct ?? 0;
    return { amount: cost * (1 + pct / 100), basis: pct ? `${money(cost)} paid, billed at cost + ${pct}%` : `${money(cost)} paid, billed at cost` };
  }
  if (markup == null) return null;
  return { amount: cost * markup, basis: `${money(cost)} paid × ${markup.toFixed(3)} bill-rate markup` };
}

async function linkPremiums(db: PrismaClient, run: { id: string; periodStart: Date; periodEnd: Date }, actorUserId: string | null, result: LinkResult): Promise<void> {
  const from = run.periodStart;
  const toExclusive = new Date(run.periodEnd.getTime() + DAY_MS);
  const items = await db.payrollItem.findMany({
    where: { payrollRunId: run.id },
    select: { id: true, associateId: true, hourlyRate: true, associate: { select: { firstName: true, lastName: true } }, earnings: { select: { id: true, kind: true, amount: true, hours: true, rate: true, notes: true } } },
  });
  for (const item of items) {
    // The statement bills double-time HOURS like overtime (lib/clientStatement:
    // the engine's split, the contract's overtime billing). What the contract's
    // DOUBLE_TIME rule bills is the premium beyond that — the labor-rules
    // engine's "Double time" line less those hours at the overtime rate — so
    // no hour is billed twice. A client premium rule's daily-OT line is already
    // premium only and bills whole.
    const otRate = overtimeRateOf(item);
    const premiumLines = item.earnings
      .map((e) => ({ ...e, cost: premiumCost(e, otRate), key: premiumKeyOf({ kind: e.kind, notes: e.notes, rate: e.rate == null ? null : Number(e.rate) }) }))
      .filter((e): e is typeof e & { key: PremiumKey } => e.key !== null && e.cost > 0.004);
    if (!premiumLines.length) continue;
    const shares = await sharesFor(db, item.associateId, from, toExclusive);
    const totalMin = shares.reduce((s, x) => s + x.minutes, 0);
    if (totalMin <= 0) continue;
    const cards = await loadRateCards(db, shares.map((s) => s.clientId));
    const who = `${item.associate.firstName} ${item.associate.lastName}`;
    for (const share of shares) {
      const terms = await termsFor(db, share.clientId, share.lastDay);
      const markup = weightedMarkup(cards, share, terms);
      const fraction = share.minutes / totalMin;
      for (const line of premiumLines) {
        const rule = terms.premiumRules[line.key];
        const cost = line.cost * fraction;
        const bill = billFor(rule, cost, markup);
        if (!bill) {
          if (rule.mode === 'BILL_MARKUP') result.skipped.push({ source: `premium:${line.id}:${share.clientId}`, reason: 'Billable at markup, but no bill rate or default markup is on file.' });
          continue;
        }
        const written = await writeAdjustment(
          db,
          {
            clientId: share.clientId,
            kind: 'PREMIUM',
            ruleKey: line.key,
            label: `${PREMIUM_LABEL[line.key]} — ${who}${line.notes ? ` (${line.notes})` : ''}`,
            basis: fraction < 1 ? `${bill.basis}; ${Math.round(fraction * 100)}% of the period's hours were here` : bill.basis,
            hours: (line.hours == null ? 0 : Number(line.hours)) * fraction,
            payAmount: cost,
            amount: bill.amount,
            workFrom: dateOnly(ymd(share.firstDay)),
            workTo: dateOnly(ymd(share.lastDay)),
            associateId: item.associateId,
            payrollRunId: run.id,
            payrollItemId: item.id,
            sourceKey: `premium:${line.id}:${share.clientId}`,
            originalStatementIds: [],
            review: false,
          },
          actorUserId,
        );
        if (written) result.premiums += 1;
      }
    }
  }

  // Predictability pay: the record names the store, so the client is exact.
  const predict = await db.scheduleChangePremium.findMany({
    where: { payrollRunId: run.id, exempt: false, OR: [{ premiumHours: { gt: 0 } }, { premiumCents: { gt: 0 } }] },
    select: { id: true, associateId: true, siteId: true, workDate: true, premiumHours: true, premiumCents: true, rule: true, change: true, associate: { select: { firstName: true, lastName: true } } },
  });
  if (!predict.length) return;
  const sites = await db.site.findMany({ where: { id: { in: predict.map((p) => p.siteId).filter((x): x is string => !!x) } }, select: { id: true, clientId: true } });
  const clientOf = new Map(sites.map((s) => [s.id, s.clientId]));
  const items2 = await db.payrollItem.findMany({ where: { payrollRunId: run.id, associateId: { in: [...new Set(predict.map((p) => p.associateId))] } }, select: { id: true, associateId: true, hourlyRate: true } });
  const rateOf = new Map(items2.map((i) => [i.associateId, Number(i.hourlyRate)]));
  const itemOf = new Map(items2.map((i) => [i.associateId, i.id]));
  const allCards = await loadRateCards(db, [...new Set(sites.map((s) => s.clientId).filter((x): x is string => !!x))]);
  for (const p of predict) {
    const clientId = p.siteId ? clientOf.get(p.siteId) : null;
    if (!clientId) continue;
    const terms = await termsFor(db, clientId, p.workDate);
    const cost = Number(p.premiumHours) * (rateOf.get(p.associateId) ?? 0) + p.premiumCents / 100;
    if (cost <= 0) continue;
    const markup = markupOn(allCards, clientId, null, p.workDate, terms);
    const bill = billFor(terms.premiumRules.PREDICTABILITY, cost, markup);
    if (!bill) continue;
    const written = await writeAdjustment(
      db,
      {
        clientId,
        kind: 'PREMIUM',
        ruleKey: 'PREDICTABILITY',
        label: `Predictability pay — ${p.associate.firstName} ${p.associate.lastName}, shift ${p.change} ${fmtDay(p.workDate)} (${p.rule})`,
        basis: bill.basis,
        hours: Number(p.premiumHours),
        payAmount: cost,
        amount: bill.amount,
        workFrom: p.workDate,
        workTo: p.workDate,
        associateId: p.associateId,
        payrollRunId: run.id,
        payrollItemId: itemOf.get(p.associateId) ?? null,
        sourceKey: `predict:${p.id}`,
        originalStatementIds: [],
        review: false,
      },
      actorUserId,
    );
    if (written) result.premiums += 1;
  }
}

/* ----- Voiding ------------------------------------------------------------- */

/** A voided run: what was not billed yet is voided; what was billed is reversed on the next bill. */
export async function onPayrollVoided(db: PrismaClient, runId: string, actorUserId: string | null): Promise<{ voided: number; reversed: number }> {
  const rows = await db.billingAdjustment.findMany({ where: { payrollRunId: runId, kind: { in: ['RETRO', 'PREMIUM'] } } });
  let voided = 0;
  let reversed = 0;
  for (const r of rows) {
    if (r.status === 'READY' || r.status === 'PENDING_REVIEW') {
      await db.billingAdjustment.update({ where: { id: r.id }, data: { status: 'VOID', reason: 'The payroll it came from was voided.' } });
      voided += 1;
    } else if (r.status === 'BILLED') {
      const w = await writeAdjustment(
        db,
        {
          clientId: r.clientId,
          kind: 'REVERSAL',
          ruleKey: r.ruleKey,
          label: `Reversal — ${r.label}`,
          basis: 'The payroll this was billed from was voided.',
          hours: -Number(r.hours),
          payAmount: -Number(r.payAmount),
          amount: -Number(r.amount),
          workFrom: r.workFrom,
          workTo: r.workTo,
          associateId: r.associateId,
          payrollRunId: runId,
          payrollItemId: r.payrollItemId,
          sourceKey: `reverse:${r.id}`,
          originalStatementIds: r.billedStatementId ? [r.billedStatementId] : [],
          review: false,
        },
        actorUserId,
      );
      if (w) reversed += 1;
    }
  }
  return { voided, reversed };
}

/* ----- On the statement ---------------------------------------------------- */

export interface SnapshotAdjustment {
  id: string;
  kind: string;
  ruleKey: string | null;
  label: string;
  basis: string | null;
  hours: number;
  amount: number;
}

/** What a client's draft statement carries beyond its own hours: every READY adjustment not billed yet. */
export async function readyAdjustments(db: Db, clientId: string): Promise<SnapshotAdjustment[]> {
  const rows = await db.billingAdjustment.findMany({
    where: { clientId, status: 'READY', billedStatementId: null },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  return rows.map((r) => ({ id: r.id, kind: r.kind, ruleKey: r.ruleKey, label: r.label, basis: r.basis, hours: Number(r.hours), amount: Number(r.amount) }));
}

/**
 * At finalize: claim the snapshot's adjustments for this statement — only the
 * ones still READY (another statement may have finalized them first) — and
 * return the snapshot with exactly what was claimed, totals adjusted.
 */
export async function claimAdjustmentsForStatement<T extends { adjustments?: SnapshotAdjustment[]; totals: { amount: number; adjustmentsAmount?: number; hoursAmount?: number; subtotal?: number; salesTaxRatePct?: number; salesTax?: number } }>(
  tx: Db,
  statementId: string,
  snapshot: T,
  now: Date = new Date(),
): Promise<T> {
  const listed = snapshot.adjustments ?? [];
  if (!listed.length) return snapshot;
  await tx.billingAdjustment.updateMany({
    where: { id: { in: listed.map((a) => a.id) }, status: 'READY', billedStatementId: null },
    data: { status: 'BILLED', billedStatementId: statementId, billedAt: now },
  });
  const claimed = new Set(
    (await tx.billingAdjustment.findMany({ where: { id: { in: listed.map((a) => a.id) }, billedStatementId: statementId }, select: { id: true } })).map((r) => r.id),
  );
  const kept = listed.filter((a) => claimed.has(a.id));
  const subtotalBefore = snapshot.totals.subtotal ?? snapshot.totals.amount;
  const hoursAmount = snapshot.totals.hoursAmount ?? round2(subtotalBefore - (snapshot.totals.adjustmentsAmount ?? 0));
  const adjustmentsAmount = round2(kept.reduce((s, a) => s + a.amount, 0));
  // The tax rides on the recomputed subtotal (lib/clientStatement.totalsWithTax) — never dropped by the claim.
  return { ...snapshot, adjustments: kept, totals: { ...snapshot.totals, ...totalsWithTax({ hoursAmount, adjustmentsAmount, salesTaxRatePct: snapshot.totals.salesTaxRatePct ?? null }) } };
}

/* ----- Finance's decision on a REVIEW rebill ------------------------------- */

registerApplyHandler(
  'BILLING_ADJUSTMENT',
  async (db, row, decider) => {
    const p = row.proposed as { billingAdjustmentId: string };
    const adj = await db.billingAdjustment.findFirst({ where: { id: p.billingAdjustmentId } });
    if (!adj || adj.status !== 'PENDING_REVIEW') return;
    await db.billingAdjustment.update({ where: { id: adj.id }, data: { status: 'READY' } });
    enqueueAudit({ actorUserId: decider.id, clientId: adj.clientId, action: 'billing.adjustment_approved', entityType: 'BillingAdjustment', entityId: adj.id, metadata: { amount: Number(adj.amount), approvalId: row.id } }, 'payBillLink');
  },
  async (db, row, decider) => {
    const p = row.proposed as { billingAdjustmentId: string };
    const adj = await db.billingAdjustment.findFirst({ where: { id: p.billingAdjustmentId } });
    if (!adj || adj.status !== 'PENDING_REVIEW') return;
    await db.billingAdjustment.update({ where: { id: adj.id }, data: { status: 'VOID', reason: (row.reason ?? 'Finance decided not to rebill.').slice(0, 500) } });
    enqueueAudit({ actorUserId: decider.id, clientId: adj.clientId, action: 'billing.adjustment_rejected', entityType: 'BillingAdjustment', entityId: adj.id, metadata: { amount: Number(adj.amount), approvalId: row.id, reason: row.reason } }, 'payBillLink');
  },
);

