import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { logger } from './logger.js';
import { loadLiveRules } from './laborRules/live.js';
import { loadRulePool, rulesForSite } from './laborRules/store.js';
import { localParts } from './laborRules/evaluate.js';

/**
 * Predictability pay — the premium fair-workweek laws (NYC, Chicago, Oregon,
 * Seattle, Philadelphia…) owe a worker when their published schedule changes
 * inside the notice window: a shift added or moved, hours cut, or a shift
 * cancelled.
 *
 *   The scheduling routes call noteScheduleChange after a published,
 *   assigned shift changes. Where the site's rules (lib/laborRules) carry a
 *   predictive block and the change is inside its notice window, one row is
 *   recorded with the premium the band names. Only a row made while the
 *   jurisdiction is LIVE is paid (payroll consumes it once); the rest are
 *   the record a tenant reviews before going live.
 *
 *   The laws excuse changes the worker asked for, mutually agreed swaps and
 *   emergencies (threats, utility outages, acts of nature): a change marked
 *   with one of those is recorded as exempt, owing nothing. Without a reason
 *   the premium is owed — the protective reading.
 */

type Db = PrismaClient;

export const EXEMPT_REASONS = ['EMPLOYEE_REQUESTED', 'MUTUAL_SWAP', 'VOLUNTARY_PICKUP', 'EMERGENCY'] as const;
export type ExemptReason = (typeof EXEMPT_REASONS)[number];
/** Reads an optional `changeReason` off a request body without failing the request. */
export const ChangeReasonSchema = z.enum(EXEMPT_REASONS).optional().catch(undefined);

export interface ShiftSnap {
  id: string;
  assignedAssociateId: string | null;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

type Change = 'added' | 'reduced' | 'cancelled' | 'moved';

const HOUR = 3_600_000;
const published = (s: ShiftSnap | null) => !!s && (s.status === 'OPEN' || s.status === 'ASSIGNED');
const hours = (s: ShiftSnap) => (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR;

/** The changes a before → after edit amounts to, per worker. */
export function changesBetween(before: ShiftSnap | null, after: ShiftSnap | null): Array<{ associateId: string; change: Change; shift: ShiftSnap; hoursAffected: number }> {
  const out: Array<{ associateId: string; change: Change; shift: ShiftSnap; hoursAffected: number }> = [];
  const was = published(before) && before!.assignedAssociateId ? before! : null;
  const now = after && after.status !== 'CANCELLED' && published(after) && after.assignedAssociateId ? after : null;
  if (was && !now) {
    out.push({ associateId: was.assignedAssociateId!, change: 'cancelled', shift: was, hoursAffected: hours(was) });
  } else if (!was && now) {
    out.push({ associateId: now.assignedAssociateId!, change: 'added', shift: now, hoursAffected: hours(now) });
  } else if (was && now) {
    if (was.assignedAssociateId !== now.assignedAssociateId) {
      out.push({ associateId: was.assignedAssociateId!, change: 'cancelled', shift: was, hoursAffected: hours(was) });
      out.push({ associateId: now.assignedAssociateId!, change: 'added', shift: now, hoursAffected: hours(now) });
    } else if (was.startsAt.getTime() !== now.startsAt.getTime() || was.endsAt.getTime() !== now.endsAt.getTime()) {
      const lost = hours(was) - hours(now);
      out.push(lost > 0.0001 ? { associateId: now.assignedAssociateId!, change: 'reduced', shift: was, hoursAffected: lost } : { associateId: now.assignedAssociateId!, change: 'moved', shift: now, hoursAffected: hours(now) });
    }
  }
  return out;
}

export interface NoteInput {
  tenantId: string;
  before: ShiftSnap | null;
  after: ShiftSnap | null;
  actorUserId: string | null;
  exemptReason?: ExemptReason;
  reasonText?: string | null;
  now?: Date;
}

/** Record the predictability premiums an edit owes. Never throws into the scheduling route. */
export async function noteScheduleChange(db: Db, input: NoteInput): Promise<number> {
  try {
    const changes = changesBetween(input.before, input.after);
    if (!changes.length) return 0;
    const now = input.now ?? new Date();
    const siteId = (input.after ?? input.before)!.locationId;
    if (!siteId) return 0;
    const site = await db.site.findFirst({ where: { id: siteId, tenantId: input.tenantId }, select: { id: true, state: true, city: true, timezone: true } });
    if (!site) return 0;
    const live = await loadLiveRules(db, input.tenantId);
    let made = 0;
    let pool: Awaited<ReturnType<typeof loadRulePool>> | null = null;
    for (const c of changes) {
      const workDate = localParts(c.shift.startsAt, site.timezone).date;
      const liveRules = live.rulesFor(site, workDate);
      const rules = liveRules ?? rulesForSite((pool ??= await loadRulePool(db, input.tenantId)), site, workDate);
      const pr = rules.params.predictive;
      if (!pr?.noticeDays) continue;
      const noticeDays = (c.shift.startsAt.getTime() - now.getTime()) / (24 * HOUR);
      if (noticeDays >= pr.noticeDays || noticeDays < 0) continue;
      const band = (pr.changePremiums ?? []).filter((b) => noticeDays < b.withinDays && b.kind.includes(c.change)).sort((a, b) => a.withinDays - b.withinDays)[0];
      const exempt = !!input.exemptReason;
      const premiumHours = exempt || !band ? 0 : Math.round(((band.premiumHours ?? 0) + (band.shareOfHoursLost ?? 0) * (c.change === 'reduced' || c.change === 'cancelled' ? c.hoursAffected : 0)) * 100) / 100;
      const premiumCents = exempt || !band ? 0 : band.premiumCents ?? 0;
      const cite = rules.origin['predictive.noticeDays'] ?? rules.layers[rules.layers.length - 1] ?? 'predictive scheduling';
      await db.scheduleChangePremium.create({
        data: {
          tenantId: input.tenantId,
          associateId: c.associateId,
          shiftId: c.shift.id,
          siteId: site.id,
          workDate: new Date(`${workDate}T00:00:00Z`),
          change: c.change,
          noticeDays: new Prisma.Decimal(Math.round(noticeDays * 100) / 100),
          hoursAffected: new Prisma.Decimal(Math.round(c.hoursAffected * 100) / 100),
          premiumHours: new Prisma.Decimal(premiumHours),
          premiumCents,
          exempt,
          exemptReason: input.exemptReason ?? null,
          reasonText: input.reasonText?.slice(0, 500) ?? null,
          rule: `Predictability pay (${cite})`.slice(0, 300),
          live: !!liveRules,
          createdById: input.actorUserId,
        },
      });
      made += 1;
    }
    return made;
  } catch (err) {
    logger.error({ err }, 'predictability pay: recording a schedule change failed');
    return 0;
  }
}

/** Unpaid live premiums for people in a period, for the payroll aggregator. */
export async function unpaidPremiums(db: Db | Prisma.TransactionClient, tenantId: string, associateIds: readonly string[], periodStart: Date, periodEndExclusive: Date) {
  if (!associateIds.length) return [];
  return db.scheduleChangePremium.findMany({
    where: {
      tenantId,
      associateId: { in: [...associateIds] },
      live: true,
      exempt: false,
      payrollRunId: null,
      workDate: { gte: periodStart, lt: periodEndExclusive },
      OR: [{ premiumHours: { gt: 0 } }, { premiumCents: { gt: 0 } }],
    },
    select: { id: true, associateId: true, premiumHours: true, premiumCents: true, rule: true, change: true, workDate: true },
  });
}

/** Stamp the premiums a finalized run paid, so no later run pays them again. */
export async function markPremiumsPaid(db: Db | Prisma.TransactionClient, ids: readonly string[], payrollRunId: string): Promise<void> {
  if (!ids.length) return;
  await db.scheduleChangePremium.updateMany({ where: { id: { in: [...ids] }, payrollRunId: null }, data: { payrollRunId } });
}

/** A draft run re-aggregating, deleted or voided gives its premiums back. */
export async function releasePremiumsForRun(db: Db | Prisma.TransactionClient, payrollRunId: string): Promise<void> {
  await db.scheduleChangePremium.updateMany({ where: { payrollRunId }, data: { payrollRunId: null } });
}
