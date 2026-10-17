import { Prisma, type PrismaClient, type TimeOffCategory, type TimeOffPolicy, type TimeOffPolicyScope } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { netWorkedMinutes } from './timeAnomalies.js';
import { tenantJob } from './tenantJobs.js';

/**
 * Time-off policies.
 *
 * A policy says how a category of leave is earned — per hour worked, per
 * month, or as a yearly grant — with a cap, a carryover, a waiting period
 * after hire, and tenure tiers that raise the rate. It is assigned to
 * everyone, a client, a site, a department or a job profile; for a person
 * the most specific assignment wins, one policy per category.
 *
 *   PER_HOUR_WORKED  posts when a time entry is approved, beside the
 *                    state sick accrual (which keeps SICK when both apply)
 *   PER_PERIOD       posts once a calendar month, by the daily job
 *   ANNUAL_GRANT     keeps a TimeOffEntitlement in step with the policy;
 *                    the existing yearly grant does the rest
 */

type Db = Prisma.TransactionClient | PrismaClient;

export interface TenureTier {
  afterMonths: number;
  accrualPerHour?: number | null;
  minutesPerPeriod?: number | null;
  annualMinutes?: number | null;
}

const SPECIFICITY: Record<TimeOffPolicyScope, number> = { JOB_PROFILE: 5, DEPARTMENT: 4, SITE: 3, CLIENT: 2, ALL: 1 };

export interface PersonFacts {
  id: string;
  clientId: string | null;
  departmentId: string | null;
  jobProfileId: string | null;
  hireDate: Date | null;
  /** Current site, from the open assignment. */
  locationId: string | null;
}

async function personFacts(db: Db, associateId: string): Promise<PersonFacts | null> {
  const a = await db.associate.findUnique({
    where: { id: associateId },
    select: {
      id: true,
      departmentId: true,
      jobProfileId: true,
      hireDate: true,
      assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1, select: { locationId: true, location: { select: { clientId: true } } } },
    },
  });
  if (!a) return null;
  const open = a.assignments[0] ?? null;
  return {
    id: a.id,
    clientId: open?.location.clientId ?? null,
    departmentId: a.departmentId,
    jobProfileId: a.jobProfileId,
    hireDate: a.hireDate,
    locationId: open?.locationId ?? null,
  };
}

/** The effective policy per category for one person. */
export async function resolvePoliciesFor(db: Db, person: PersonFacts): Promise<Map<TimeOffCategory, TimeOffPolicy>> {
  const assignments = await db.timeOffPolicyAssignment.findMany({
    where: {
      policy: { isActive: true, deletedAt: null },
      OR: [
        { scopeKind: 'ALL' },
        ...(person.clientId ? [{ scopeKind: 'CLIENT' as const, scopeId: person.clientId }] : []),
        ...(person.locationId ? [{ scopeKind: 'SITE' as const, scopeId: person.locationId }] : []),
        ...(person.departmentId ? [{ scopeKind: 'DEPARTMENT' as const, scopeId: person.departmentId }] : []),
        ...(person.jobProfileId ? [{ scopeKind: 'JOB_PROFILE' as const, scopeId: person.jobProfileId }] : []),
      ],
    },
    include: { policy: true },
  });
  const best = new Map<TimeOffCategory, { score: number; policy: TimeOffPolicy }>();
  for (const a of assignments) {
    const score = SPECIFICITY[a.scopeKind];
    const cur = best.get(a.policy.category);
    if (!cur || score > cur.score) best.set(a.policy.category, { score, policy: a.policy });
  }
  return new Map([...best.entries()].map(([k, v]) => [k, v.policy]));
}

export async function resolvePoliciesForAssociate(db: Db, associateId: string): Promise<Map<TimeOffCategory, TimeOffPolicy>> {
  const person = await personFacts(db, associateId);
  if (!person) return new Map();
  return resolvePoliciesFor(db, person);
}

function monthsSince(from: Date | null, now: Date): number {
  if (!from) return 0;
  return (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + (now.getUTCMonth() - from.getUTCMonth()) - (now.getUTCDate() < from.getUTCDate() ? 1 : 0);
}

/** The policy's numbers for a person of this tenure: the highest tier passed, else the base. */
export function rateFor(policy: TimeOffPolicy, hireDate: Date | null, now: Date): { accrualPerHour: number; minutesPerPeriod: number; annualMinutes: number } {
  const base = {
    accrualPerHour: policy.accrualPerHour ? Number(policy.accrualPerHour) : 0,
    minutesPerPeriod: policy.minutesPerPeriod ?? 0,
    annualMinutes: policy.annualMinutes ?? 0,
  };
  const tiers = (Array.isArray(policy.tenureTiers) ? (policy.tenureTiers as unknown as TenureTier[]) : [])
    .filter((t) => typeof t?.afterMonths === 'number')
    .sort((a, b) => b.afterMonths - a.afterMonths);
  const months = monthsSince(hireDate, now);
  const tier = tiers.find((t) => months >= t.afterMonths);
  if (!tier) return base;
  return {
    accrualPerHour: tier.accrualPerHour != null ? Number(tier.accrualPerHour) : base.accrualPerHour,
    minutesPerPeriod: tier.minutesPerPeriod ?? base.minutesPerPeriod,
    annualMinutes: tier.annualMinutes ?? base.annualMinutes,
  };
}

function waitingOver(policy: TimeOffPolicy, hireDate: Date | null, at: Date): boolean {
  if (policy.waitingPeriodDays <= 0 || !hireDate) return true;
  return at.getTime() - hireDate.getTime() >= policy.waitingPeriodDays * 86_400_000;
}

async function creditCapped(
  tx: Prisma.TransactionClient,
  input: { associateId: string; category: TimeOffCategory; minutes: number; capMinutes: number | null },
): Promise<number> {
  const bal = await tx.timeOffBalance.findUnique({ where: { associateId_category: { associateId: input.associateId, category: input.category } } });
  const current = bal?.balanceMinutes ?? 0;
  const room = input.capMinutes === null ? input.minutes : Math.max(0, input.capMinutes - current);
  const credit = Math.min(input.minutes, room);
  if (credit <= 0) return 0;
  await tx.timeOffBalance.upsert({
    where: { associateId_category: { associateId: input.associateId, category: input.category } },
    create: { associateId: input.associateId, category: input.category, balanceMinutes: current + credit },
    update: { balanceMinutes: current + credit },
  });
  return credit;
}

export interface PolicyAccrualResult {
  category: TimeOffCategory;
  policyId: string;
  earnedMinutes: number;
}

/**
 * Per-hour policies for one APPROVED time entry. Idempotent per (entry,
 * category) through the ledger's unique constraint; where the state sick
 * accrual already posted SICK for the entry, the policy yields to it.
 */
export async function accruePolicyLeaveForEntry(db: PrismaClient, timeEntryId: string): Promise<PolicyAccrualResult[]> {
  const entry = await db.timeEntry.findUnique({
    where: { id: timeEntryId },
    include: { breaks: true },
  });
  if (!entry || !entry.clockOutAt || entry.status !== 'APPROVED') return [];
  const person = await personFacts(db, entry.associateId);
  if (!person) return [];
  const policies = await resolvePoliciesFor(db, person);
  const worked = netWorkedMinutes({ clockInAt: entry.clockInAt, clockOutAt: entry.clockOutAt }, entry.breaks);
  if (worked <= 0) return [];
  const out: PolicyAccrualResult[] = [];
  for (const policy of policies.values()) {
    if (policy.accrualMode !== 'PER_HOUR_WORKED') continue;
    if (!waitingOver(policy, person.hireDate, entry.clockInAt)) continue;
    const { accrualPerHour } = rateFor(policy, person.hireDate, entry.clockInAt);
    const minutes = Math.round((worked / 60) * accrualPerHour * 60);
    if (minutes <= 0) continue;
    try {
      const credited = await db.$transaction(async (tx) => {
        const credit = await creditCapped(tx, { associateId: entry.associateId, category: policy.category, minutes, capMinutes: policy.capMinutes });
        await tx.timeOffLedgerEntry.create({
          data: {
            associateId: entry.associateId,
            category: policy.category,
            reason: 'ACCRUAL',
            deltaMinutes: credit,
            sourceTimeEntryId: entry.id,
            sourcePolicyId: policy.id,
            notes: `${policy.name}: ${(worked / 60).toFixed(2)}h worked × ${accrualPerHour}${credit < minutes ? ` (capped at ${policy.capMinutes} min)` : ''}`,
          },
        });
        return credit;
      });
      out.push({ category: policy.category, policyId: policy.id, earnedMinutes: credited });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  return out;
}

/** Monthly grants for everyone on a PER_PERIOD policy, once per month. */
export async function accruePeriodGrants(now: Date = new Date(), db: PrismaClient = defaultPrisma): Promise<{ granted: number; people: number }> {
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const anyPeriodic = await db.timeOffPolicy.count({ where: { accrualMode: 'PER_PERIOD', isActive: true, deletedAt: null } });
  if (anyPeriodic === 0) return { granted: 0, people: 0 };
  const people = await db.associate.findMany({ where: { deletedAt: null }, select: { id: true }, take: 20_000 });
  let granted = 0;
  for (const p of people) {
    const facts = await personFacts(db, p.id);
    if (!facts) continue;
    const policies = await resolvePoliciesFor(db, facts);
    for (const policy of policies.values()) {
      if (policy.accrualMode !== 'PER_PERIOD') continue;
      if (!waitingOver(policy, facts.hireDate, now)) continue;
      const { minutesPerPeriod } = rateFor(policy, facts.hireDate, now);
      if (minutesPerPeriod <= 0) continue;
      try {
        await db.$transaction(async (tx) => {
          const credit = await creditCapped(tx, { associateId: p.id, category: policy.category, minutes: minutesPerPeriod, capMinutes: policy.capMinutes });
          await tx.timeOffLedgerEntry.create({
            data: {
              associateId: p.id,
              category: policy.category,
              reason: 'ACCRUAL',
              deltaMinutes: credit,
              sourcePolicyId: policy.id,
              periodKey,
              notes: `${policy.name}: ${periodKey} grant${credit < minutesPerPeriod ? ` (capped at ${policy.capMinutes} min)` : ''}`,
            },
          });
        });
        granted += 1;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
  }
  return { granted, people: people.length };
}

/**
 * Keep a person's annual entitlements in step with their ANNUAL_GRANT
 * policies: a missing row is created, a policy-owned row whose numbers
 * changed is updated. Hand-set rows (no policyId) are left alone. Balances
 * are not touched here — the yearly grant does that on its own schedule.
 */
export async function syncPolicyEntitlements(tx: Db, associateId: string, now: Date = new Date()): Promise<void> {
  const person = await personFacts(tx, associateId);
  if (!person) return;
  const policies = await resolvePoliciesFor(tx, person);
  for (const policy of policies.values()) {
    if (policy.accrualMode !== 'ANNUAL_GRANT') continue;
    const { annualMinutes } = rateFor(policy, person.hireDate, now);
    if (annualMinutes <= 0) continue;
    const existing = await tx.timeOffEntitlement.findUnique({ where: { associateId_category: { associateId, category: policy.category } } });
    if (existing && existing.policyId === null) continue;
    if (existing && existing.policyId === policy.id && existing.annualMinutes === annualMinutes && existing.carryoverMaxMinutes === policy.carryoverMaxMinutes) continue;
    await tx.timeOffEntitlement.upsert({
      where: { associateId_category: { associateId, category: policy.category } },
      create: { associateId, category: policy.category, annualMinutes, carryoverMaxMinutes: policy.carryoverMaxMinutes, policyAnchorDate: policy.policyAnchorDate, policyId: policy.id },
      update: { annualMinutes, carryoverMaxMinutes: policy.carryoverMaxMinutes, policyAnchorDate: policy.policyAnchorDate, policyId: policy.id },
    });
  }
}

let timer: NodeJS.Timeout | null = null;

/** Daily: monthly grants land on the first pass of each month. */
export function startTimeOffPolicyCron(): void {
  if (timer) return;
  if (env.NODE_ENV === 'test') return;
  const tick = () => {
    void tenantJob('timeOffPolicyGrants', () => accruePeriodGrants(), { module: 'time' })().catch((err) => {
      console.error('[alto-people/api] time-off policy grants failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, 24 * 60 * 60 * 1000);
  timer.unref();
}
