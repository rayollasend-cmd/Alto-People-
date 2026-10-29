import type { Prisma, PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { resolveAdapter, type DisbursementInput } from './disbursement.js';
import { notifyFinance, resolvePayoutForPayroll } from './financialChanges.js';
import { netWorkedMinutes, orgDateKey, type BreakFacts } from './timeAnomalies.js';
import { dateOnly, patternOn, periodContaining, scheduleMembershipFor } from './payScheduleMembership.js';
import { estimateTakeHome } from './takeHome.js';
import { punchesInPeriod } from './payrollSchedule.js';
import { notifyUser } from './notify.js';
import { orgSettingIdFor } from './branding.js';
import { tenantIdForWrite } from './tenant.js';
import { tryDecryptString } from './crypto.js';
import { readRoutingNumber } from './payoutMethod.js';
import { booksAfterWageAdvance } from './books/posting/hooks.js';
import { fmtDay, fmtDayRange } from './humanDates.js';

/**
 * Earned-wage access: pay before payday.
 *
 * An associate may draw part of what they have already earned this pay
 * period. The money goes out on the ordinary payout rail (Branch, the
 * stub, a check) to a VERIFIED account only, and comes back as a post-tax
 * deduction on the next regular check for that period — a thin check
 * recovers part and the rest rolls to the one after. The cap (share of
 * estimated net), the fee and the per-period ceiling are the tenant's
 * OrgSetting; the module switch is `earnedWage`.
 *
 * Everything here is audited: the request, the payout, the recovery.
 */

type Db = Prisma.TransactionClient | PrismaClient;

export interface EwaSettings {
  enabled: boolean;
  capPct: number;
  feeCents: number;
  maxPerPeriodCents: number;
}

export async function loadEwaSettings(db: Db = defaultPrisma): Promise<EwaSettings> {
  const tenantId = tenantIdForWrite();
  const row =
    (await db.orgSetting.findFirst({
      where: { OR: [{ tenantId }, { id: orgSettingIdFor(tenantId) }] },
      select: { ewaEnabled: true, ewaCapPct: true, ewaFeeCents: true, ewaMaxPerPeriodCents: true },
    })) ?? null;
  return {
    enabled: row?.ewaEnabled ?? true,
    capPct: row?.ewaCapPct ?? 50,
    feeCents: row?.ewaFeeCents ?? 0,
    maxPerPeriodCents: row?.ewaMaxPerPeriodCents ?? 100_000,
  };
}

export interface EwaAvailability {
  enabled: boolean;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  /** Hours worked in the period so far (approved and awaiting approval). */
  hoursWorked: number;
  hourlyRate: number;
  earnedGrossCents: number;
  /** Conservative estimate of take-home on those hours. */
  earnedNetCents: number;
  netFactor: number;
  capPct: number;
  capCents: number;
  maxPerPeriodCents: number;
  /** Advances already out this period (requested or paid). */
  drawnCents: number;
  availableCents: number;
  feeCents: number;
  /** Why nothing is available right now, when nothing is. */
  blocker: 'OFF' | 'NO_SCHEDULE' | 'NO_VERIFIED_ACCOUNT' | 'NOTHING_EARNED' | 'LIMIT_REACHED' | null;
  /** Where an advance goes (the verified pay account), for the confirm before money moves. */
  payoutTo: { kind: 'BANK' | 'CARD' | 'OTHER'; last4: string | null } | null;
}

const DEFAULT_NET_FACTOR = 0.78;

/**
 * The pay period an advance comes off: the current period of the schedule
 * the person is ON today (lib/payScheduleMembership — the rule a run pays
 * by). Someone on no schedule gets none, so no advance: it would come off a
 * check no run will write, and never be recovered (F500 SH-4 — this used to
 * fall back to the company's first schedule).
 */
async function periodFor(db: Db, associateId: string, now: Date) {
  // The company's day, not UTC's: after 8 PM Eastern on a period's last
  // Friday, UTC is already in the next period (deep audit MONEY-16/CODE-14).
  const today = orgDateKey(now);
  const m = (await scheduleMembershipFor(db, [associateId], today)).get(associateId) ?? null;
  if (!m || m.from > today) return null;
  const schedule = await db.payrollSchedule.findUnique({ where: { id: m.scheduleId }, include: { versions: true } });
  if (!schedule) return null;
  const freq = patternOn(schedule, today).frequency;
  // DAILY's check of record is its weekly true-up, withheld as weekly.
  return { ...periodContaining(schedule, today), frequency: freq === 'DAILY' ? ('WEEKLY' as const) : freq };
}

/** Advances already out on a period (requested or paid), fees included, in cents. */
async function drawnInPeriod(db: Db, associateId: string, periodStart: string): Promise<number> {
  const drawn = await db.earnedWageAdvance.aggregate({
    where: { associateId, status: { in: ['REQUESTED', 'PAID'] }, periodStart: dateOnly(periodStart) },
    _sum: { amountCents: true, feeCents: true },
  });
  return (drawn._sum.amountCents ?? 0) + (drawn._sum.feeCents ?? 0);
}

/**
 * What is left to draw: the cap (a share of estimated net) or the
 * per-period ceiling, whichever is lower, less what is already out. The fee
 * comes out of the same room, so the person can never owe more than the
 * cap on payday.
 */
function roomLeft(capCents: number, maxPerPeriodCents: number, drawnCents: number, feeCents: number): number {
  return Math.max(0, Math.min(capCents, maxPerPeriodCents) - drawnCents - feeCents);
}

/** What this person could draw right now, and why not if nothing. */
export async function ewaAvailability(db: Db, associateId: string, now: Date = new Date()): Promise<EwaAvailability> {
  const settings = await loadEwaSettings(db);
  const period = await periodFor(db, associateId, now);
  const base: EwaAvailability = {
    enabled: settings.enabled,
    periodStart: period?.periodStart ?? '',
    periodEnd: period?.periodEnd ?? '',
    payDate: period?.payDate ?? '',
    hoursWorked: 0,
    hourlyRate: 0,
    earnedGrossCents: 0,
    earnedNetCents: 0,
    netFactor: DEFAULT_NET_FACTOR,
    capPct: settings.capPct,
    capCents: 0,
    maxPerPeriodCents: settings.maxPerPeriodCents,
    drawnCents: 0,
    availableCents: 0,
    feeCents: settings.feeCents,
    blocker: null,
    payoutTo: null,
  };
  if (!settings.enabled) return { ...base, blocker: 'OFF' };
  if (!period) return { ...base, blocker: 'NO_SCHEDULE' };

  // The period's hours are cut the way the run that recovers the advance
  // pays them: by the clock-in's day on the site's clock (lib/payrollSchedule
  // punchesInPeriod; deep audit ASSOC-20) — an evening shift on the
  // period's last day is this period's, even though UTC calls it tomorrow.
  const [entries, comp, lastPaid, drawnCents, payout] = await Promise.all([
    punchesInPeriod(period, null, (clockInAt) =>
      db.timeEntry.findMany({
        where: { associateId, status: { in: ['APPROVED', 'COMPLETED'] }, clockOutAt: { not: null }, clockInAt },
        select: {
          associateId: true,
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
          location: { select: { timezone: true } },
        },
        take: 2000,
      }),
    ),
    db.compensationRecord.findFirst({
      where: { associateId, payType: 'HOURLY', effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
      select: { amount: true },
    }),
    db.payrollItem.findFirst({
      where: { associateId, status: 'DISBURSED', grossPay: { gt: 0 } },
      orderBy: { disbursedAt: 'desc' },
      select: { grossPay: true, netPay: true, reimbursementsTotal: true },
    }),
    drawnInPeriod(db, associateId, period.periodStart),
    resolvePayoutForPayroll(db, associateId),
  ]);
  let minutes = 0;
  for (const e of entries) minutes += netWorkedMinutes({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt! }, e.breaks as BreakFacts[]);
  const hours = Math.round((minutes / 6)) / 10;
  const rate = comp ? Number(comp.amount) : env.DEFAULT_ASSOCIATE_PAY_RATE;
  const grossCents = Math.round(hours * rate * 100);
  // Take-home on those hours from the ONE estimate the associate's Home and
  // Pay read (lib/takeHome estimateTakeHome, as the check it will be on: the
  // schedule's frequency, the period's days) — so "available now" is a share
  // of the figure they see, never a third number. Before advances: what's
  // already drawn this period comes off below. The last check's net/gross
  // ratio stands in only when the estimate can't be made.
  let netFactor = DEFAULT_NET_FACTOR;
  if (lastPaid && Number(lastPaid.grossPay) > 0) {
    const f = (Number(lastPaid.netPay) - Number(lastPaid.reimbursementsTotal)) / Number(lastPaid.grossPay);
    netFactor = Math.min(0.95, Math.max(0.6, f));
  }
  let netCents = Math.floor(grossCents * netFactor);
  if (grossCents > 0) {
    const days = Math.round((Date.parse(`${period.periodEnd}T00:00:00Z`) - Date.parse(`${period.periodStart}T00:00:00Z`)) / 86_400_000) + 1;
    const est = await estimateTakeHome(db as PrismaClient, associateId, grossCents / 100, now, { payFrequency: period.frequency, days }).catch(() => null);
    if (est) {
      netCents = Math.max(0, Math.floor((est.gross - est.taxes - est.deductions) * 100));
      netFactor = netCents / grossCents;
    }
  }
  const capCents = Math.floor((netCents * settings.capPct) / 100);
  const availableCents = roomLeft(capCents, settings.maxPerPeriodCents, drawnCents, settings.feeCents);
  let blocker: EwaAvailability['blocker'] = null;
  const pm = payout.decision === 'verified' ? payout.method : null;
  const payoutTo: EwaAvailability['payoutTo'] = pm
    ? { kind: pm.type === 'BANK_ACCOUNT' ? 'BANK' : pm.type === 'BRANCH_CARD' ? 'CARD' : 'OTHER', last4: pm.type === 'BRANCH_CARD' ? (pm.branchCardId?.slice(-4) ?? null) : (pm.accountLast4 ?? null) }
    : null;
  if (payout.decision !== 'verified') blocker = 'NO_VERIFIED_ACCOUNT';
  else if (netCents <= 0) blocker = 'NOTHING_EARNED';
  else if (availableCents < 100) blocker = 'LIMIT_REACHED';
  return {
    ...base,
    hoursWorked: hours,
    hourlyRate: rate,
    earnedGrossCents: grossCents,
    earnedNetCents: netCents,
    netFactor: Math.round(netFactor * 100) / 100,
    capCents,
    drawnCents,
    availableCents: blocker ? 0 : availableCents,
    blocker,
    payoutTo,
  };
}

/**
 * Request and pay an advance. Refuses anything over what is available or
 * into an account Finance has not verified. Returns the row as paid, or
 * failed with the rail's reason.
 */
export async function requestEarnedWageAdvance(
  db: PrismaClient,
  input: { associateId: string; amountCents: number; actor: { id: string; role: string }; req?: Request },
): Promise<{ id: string; status: 'PAID' | 'REQUESTED' | 'FAILED'; amountCents: number; feeCents: number; provider: string; failureReason: string | null }> {
  const now = new Date();
  const avail = await ewaAvailability(db, input.associateId, now);
  if (!avail.enabled) throw new HttpError(404, 'not_found', 'Earned-wage access is not offered here.');
  if (avail.blocker === 'NO_VERIFIED_ACCOUNT') {
    throw new HttpError(409, 'no_verified_payout', 'An advance can only go to a pay account Finance has verified.');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 100) {
    throw new HttpError(400, 'amount_too_small', 'The smallest advance is $1.00.');
  }
  if (input.amountCents > avail.availableCents) {
    throw new HttpError(409, 'over_limit', `Up to $${(avail.availableCents / 100).toFixed(2)} is available right now.`);
  }
  const associate = await db.associate.findUniqueOrThrow({
    where: { id: input.associateId },
    select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true },
  });
  const payout = await resolvePayoutForPayroll(db, input.associateId);
  const pm = payout.method!;
  // The rail first: if it can't be resolved (lib/disbursement fails closed),
  // nothing is claimed and nothing is owed.
  const adapter = await resolveAdapter();
  // Claim, then pay (deep audit CODE-10). Two requests from two devices used
  // to read the same `drawn`, both pass the cap and both pay out. Now one
  // person's draws take turns: a per-person advisory lock held for the
  // transaction, the advances already out re-read under it, the cap checked
  // again, and only then the row. The rail is called after the row commits,
  // once per row (its id is the payout's idempotency key).
  const row = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ewa:${input.associateId}`}, 0))`;
    const drawnNow = await drawnInPeriod(tx, input.associateId, avail.periodStart);
    const room = roomLeft(avail.capCents, avail.maxPerPeriodCents, drawnNow, avail.feeCents);
    if (input.amountCents > room) {
      throw new HttpError(409, 'over_limit', room >= 100 ? `Up to $${(room / 100).toFixed(2)} is available right now.` : 'Nothing more is available this pay period.');
    }
    return tx.earnedWageAdvance.create({
      data: {
        associateId: input.associateId,
        periodStart: dateOnly(avail.periodStart),
        periodEnd: dateOnly(avail.periodEnd),
        amountCents: input.amountCents,
        feeCents: avail.feeCents,
        earnedNetCents: avail.earnedNetCents,
        availableCents: room,
        status: 'REQUESTED',
      },
    });
  });
  enqueueAudit(
    {
      actorUserId: input.actor.id,
      action: 'ewa.requested',
      entityType: 'EarnedWageAdvance',
      entityId: row.id,
      metadata: { associateId: input.associateId, amountCents: input.amountCents, feeCents: avail.feeCents, availableCents: avail.availableCents },
    },
    'ewa.requested',
  );

  const fullName = `${associate.firstName} ${associate.lastName}`;
  const recipient: DisbursementInput['recipient'] = {
    associateId: associate.id,
    fullName,
    addressLine1: associate.addressLine1,
    city: associate.city,
    state: associate.state,
    zip: associate.zip,
    ...(pm.branchCardId
      ? { branchCardId: pm.branchCardId }
      : pm.routingNumberEnc && pm.accountNumberEnc
        ? {
            routingNumber: readRoutingNumber(Buffer.from(pm.routingNumberEnc)),
            accountNumber: tryDecryptString(Buffer.from(pm.accountNumberEnc)),
            accountType: pm.accountType === 'SAVINGS' ? ('SAVINGS' as const) : ('CHECKING' as const),
          }
        : {}),
  };
  const result = await adapter
    .disburse({
      amount: input.amountCents / 100,
      currency: 'USD',
      recipient,
      idempotencyKey: `ewa-${row.id}`,
      memo: `Earned wage advance ${avail.periodStart}–${avail.periodEnd}`,
    })
    .catch((err: unknown) => ({
      provider: adapter.provider,
      externalRef: '',
      status: 'FAILED' as const,
      failureReason: err instanceof Error ? err.message : String(err),
    }));

  const status = result.status === 'SUCCESS' ? 'PAID' : result.status === 'PENDING' ? 'REQUESTED' : 'FAILED';
  await db.earnedWageAdvance.update({
    where: { id: row.id },
    data: {
      status,
      provider: result.provider,
      disbursementRef: result.externalRef || null,
      failureReason: result.failureReason ?? null,
      paidAt: status === 'PAID' ? now : null,
    },
  });
  // The books: the advance leaves payroll checking (lib/books/posting).
  if (status === 'PAID') booksAfterWageAdvance(row.id);
  enqueueAudit(
    {
      actorUserId: input.actor.id,
      action: status === 'FAILED' ? 'ewa.failed' : 'ewa.paid',
      entityType: 'EarnedWageAdvance',
      entityId: row.id,
      metadata: { provider: result.provider, status: result.status, ref: result.externalRef || null, reason: result.failureReason ?? null },
    },
    'ewa.paid',
  );
  const amount = `$${(input.amountCents / 100).toFixed(2)}`;
  void notifyFinance({
    subject: status === 'FAILED' ? `Earned-wage advance failed — ${fullName}` : `Earned-wage advance ${amount} — ${fullName}`,
    body:
      status === 'FAILED'
        ? `${fullName} asked for ${amount}; the payout failed: ${result.failureReason ?? 'unknown'}.`
        : `${fullName} drew ${amount} of ${fmtDayRange(avail.periodStart, avail.periodEnd)} pay${avail.feeCents ? ` (fee $${(avail.feeCents / 100).toFixed(2)})` : ''}. It is recovered on their next check.`,
    linkUrl: '/payroll/earned-wage',
    category: 'finance.ewa',
  }).catch(() => undefined);
  const user = await db.user.findFirst({ where: { associateId: input.associateId, status: 'ACTIVE' }, select: { id: true } });
  if (user) {
    void notifyUser(user.id, {
      subject: status === 'FAILED' ? 'Your advance could not be sent' : `${amount} is on its way`,
      body:
        status === 'FAILED'
          ? 'The payment did not go through. Nothing was taken from your pay. Payroll has been told.'
          : `${amount} is being sent to your pay account now. It comes off your ${fmtDay(avail.payDate)} check${avail.feeCents ? ` with a $${(avail.feeCents / 100).toFixed(2)} fee` : ''}.`,
      category: 'pay.ewa',
      linkUrl: '/payroll',
    }).catch(() => undefined);
  }
  return { id: row.id, status, amountCents: input.amountCents, feeCents: avail.feeCents, provider: result.provider, failureReason: result.failureReason ?? null };
}

/**
 * Recover paid advances on a regular check. Draws down what the check can
 * carry, oldest first; a partial recovery rolls the rest forward. Each
 * run's share is logged so a re-aggregation can give back its own.
 */
export async function recoverEarnedWageAdvances(
  tx: Db,
  input: { associateId: string; availableNet: number; payrollRunId: string; payrollItemId: string; now?: Date },
): Promise<{ totalApplied: number; lines: Array<{ id: string; appliedCents: number }> }> {
  const now = input.now ?? new Date();
  const open = await tx.earnedWageAdvance.findMany({
    where: { associateId: input.associateId, status: 'PAID' },
    orderBy: { paidAt: 'asc' },
  });
  let roomCents = Math.max(0, Math.round(input.availableNet * 100));
  let totalCents = 0;
  const lines: Array<{ id: string; appliedCents: number }> = [];
  for (const adv of open) {
    if (roomCents <= 0) break;
    const owed = adv.amountCents + adv.feeCents - adv.recoveredCents;
    if (owed <= 0) continue;
    const take = Math.min(owed, roomCents);
    roomCents -= take;
    totalCents += take;
    const log = (Array.isArray(adv.recoveryLog) ? (adv.recoveryLog as Array<{ runId: string; cents: number }>) : []).filter(
      (l) => l.runId !== input.payrollRunId,
    );
    log.push({ runId: input.payrollRunId, cents: take });
    const recovered = adv.recoveredCents + take;
    await tx.earnedWageAdvance.update({
      where: { id: adv.id },
      data: {
        recoveredCents: recovered,
        recoveryLog: log as unknown as Prisma.InputJsonValue,
        recoveredRunId: input.payrollRunId,
        recoveredItemId: input.payrollItemId,
        ...(recovered >= adv.amountCents + adv.feeCents ? { status: 'RECOVERED', recoveredAt: now } : {}),
      },
    });
    lines.push({ id: adv.id, appliedCents: take });
  }
  return { totalApplied: Math.round(totalCents) / 100, lines };
}

/** Give back a run's share before it is re-aggregated or deleted. */
export async function releaseEarnedWageRecoveryForRun(tx: Db, payrollRunId: string): Promise<void> {
  const touched = await tx.earnedWageAdvance.findMany({
    where: { OR: [{ recoveredRunId: payrollRunId }, { recoveryLog: { array_contains: [{ runId: payrollRunId }] } }] },
  });
  for (const adv of touched) {
    const log = Array.isArray(adv.recoveryLog) ? (adv.recoveryLog as Array<{ runId: string; cents: number }>) : [];
    const mine = log.filter((l) => l.runId === payrollRunId).reduce((s, l) => s + l.cents, 0);
    if (mine === 0 && adv.recoveredRunId !== payrollRunId) continue;
    const rest = log.filter((l) => l.runId !== payrollRunId);
    const last = rest[rest.length - 1] ?? null;
    await tx.earnedWageAdvance.update({
      where: { id: adv.id },
      data: {
        recoveredCents: Math.max(0, adv.recoveredCents - mine),
        recoveryLog: rest as unknown as Prisma.InputJsonValue,
        recoveredRunId: last?.runId ?? null,
        recoveredItemId: last ? adv.recoveredItemId : null,
        status: 'PAID',
        recoveredAt: null,
      },
    });
  }
}
