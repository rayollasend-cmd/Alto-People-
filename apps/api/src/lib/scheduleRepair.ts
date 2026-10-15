import type { PrismaClient } from '@prisma/client';
import { capabilityDef } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { inProcessAgent, logAgentAction, type AgentContext } from './agents.js';
import {
  createProposal,
  registerApprovedHandler,
  registerCapabilityMetrics,
  registerCapabilityRunner,
  supersedeProposal,
} from './agentCapabilities.js';
import { trackNotificationWork } from './notify.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { moduleOn } from './tenantProfile.js';
import { formatDateUTC } from './timeOffRequests.js';
import {
  SCHEDULE_REPAIR,
  SHIFT_SELECT,
  WORKFORCE_AGENT_KEY,
  assignProposalMoot,
  earlierAssignProposals,
  executeAssignProposal,
  holderCannotWork,
  pickFillCandidate,
  replacesOf,
  shiftWhen,
  siteName,
} from './workforceAgent.js';

/**
 * The Workforce agent's `schedule.repair` (agent families step 2;
 * docs/agent-families-investigation.md §4).
 *
 *   shift.fill waits for the open-shift broadcast to go unanswered. Some
 *   holes are known the minute they open: leave is approved over someone's
 *   shifts, a separation or a deactivation releases them, an emergency
 *   stands down and its shifts come back open or held by someone who can
 *   no longer work them. For each shift the event un-covers, the agent
 *   proposes one named person at once (the same pick as shift.fill) and
 *   names the overlap on the item. Nothing changes until the desk approves;
 *   the shared executor then assigns under the supervisor's rules, taking
 *   the shift over from the person it covers for.
 *
 *   The events call repairSoon (fire-and-forget: a repair never fails the
 *   approval, separation or stand-down that caused it). The autofill tick
 *   runs runScheduleRepair as the backstop: approved leave over assigned
 *   shifts that no event reached, moot proposals retired, held approvals
 *   carried out. Every switch that stops shift.fill stops this too, and the
 *   capability has its own.
 */

type Db = PrismaClient;

const DAY_MS = 86_400_000;
/** How far ahead a repair looks: two weeks, as the emergency's lookahead. */
export const REPAIR_HORIZON_MS = 14 * DAY_MS;
const NO_CANDIDATE_ACTION = 'agent.schedule_repair.no_candidate';

export type RepairCause =
  | { kind: 'time_off'; associateId: string; category: string; startDate: Date; endDate: Date }
  | { kind: 'separation'; associateId: string }
  | { kind: 'deactivation'; associateId: string }
  | { kind: 'emergency_stand_down'; emergencyId: string; title: string };

export interface RepairRun {
  uncovered: number;
  proposed: number;
  noCandidate: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** The agent, when every switch lets schedule.repair run for this tenant; else why not. */
async function repairAgent(db: Db, tenantId: string): Promise<AgentContext | NonNullable<RepairRun['skipped']>> {
  if (!(await moduleOn('scheduling', tenantId))) return 'module_off';
  const agent = await inProcessAgent(db, WORKFORCE_AGENT_KEY, tenantId);
  if (!agent) return 'agent_stopped';
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: SCHEDULE_REPAIR, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return 'capability_off';
  return agent;
}

const fullName = (a: { firstName: string; lastName: string }) => `${a.firstName} ${a.lastName}`.trim();

/** The overlap, in the words the desk reads on the item. */
function overlapLine(cause: RepairCause, holder: { name: string; why: string } | null, released: string | null): string {
  switch (cause.kind) {
    case 'time_off': {
      const range = `${formatDateUTC(cause.startDate)} – ${formatDateUTC(cause.endDate)}`;
      return `${holder?.name ?? 'The holder'} has approved ${cause.category.toLowerCase().replace(/_/g, ' ')} leave ${range}`;
    }
    case 'separation':
      return `${released ?? 'The holder'} separated and was released from it`;
    case 'deactivation':
      return `${released ?? 'The holder'} was deactivated and released from it`;
    case 'emergency_stand_down':
      return `Back on the schedule after "${cause.title}" stood down${holder ? `; ${holder.name} ${holder.why}` : ', with nobody on it'}`;
  }
}

/**
 * Propose cover for each of these shifts that the cause left uncovered:
 * published, ahead, within the horizon, and open or held by someone who
 * cannot work it. One waiting proposal per shift across fill and repair;
 * never the holder, never someone turned down for that shift.
 */
export async function repairShifts(db: Db, shiftIds: readonly string[], cause: RepairCause, now: Date = new Date()): Promise<RepairRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: RepairRun = { uncovered: 0, proposed: 0, noCandidate: 0 };
  if (!shiftIds.length) return out;
  const agent = await repairAgent(db, tenantId);
  if (typeof agent === 'string') return { ...out, skipped: agent };

  const shifts = await db.shift.findMany({
    where: {
      id: { in: [...shiftIds] },
      tenantId,
      publishedAt: { not: null },
      status: { in: ['OPEN', 'ASSIGNED'] },
      startsAt: { gt: now, lt: new Date(now.getTime() + REPAIR_HORIZON_MS) },
    },
    select: { ...SHIFT_SELECT, assignedAssociate: { select: { firstName: true, lastName: true } } },
    orderBy: { startsAt: 'asc' },
  });
  const releasedPerson = cause.kind === 'separation' || cause.kind === 'deactivation'
    ? await db.associate.findUnique({ where: { id: cause.associateId }, select: { firstName: true, lastName: true } })
    : null;
  for (const shift of shifts) {
    const holderId = shift.assignedAssociateId;
    const why = holderId ? await holderCannotWork(db, shift, holderId) : null;
    if (holderId && !why) continue; // covered
    out.uncovered += 1;
    const earlier = await earlierAssignProposals(db, tenantId, shift.id);
    if (earlier.pending) continue;
    const exclude = [...earlier.turnedDown, ...(holderId ? [holderId] : [])];
    const candidate = await pickFillCandidate(db, shift, now, { tenantId, exclude });
    const holder = holderId && shift.assignedAssociate ? { name: fullName(shift.assignedAssociate), why: why! } : null;
    const overlap = overlapLine(cause, holder, releasedPerson ? fullName(releasedPerson) : null);
    if (!candidate) {
      out.noCandidate += 1;
      await noteNoCandidate(db, agent, shift.id, cause, overlap, now);
      continue;
    }
    const summary = holder
      ? `Cover ${holder.name}'s ${shift.position} shift at ${siteName(shift)}, ${shiftWhen(shift)}, with ${candidate.name}. ${overlap}.`
      : `Assign ${candidate.name} to ${shift.position} at ${siteName(shift)}, ${shiftWhen(shift)}. ${overlap}.`;
    await createProposal(
      db,
      agent,
      {
        capability: SCHEDULE_REPAIR,
        subjectType: 'Shift',
        subjectId: shift.id,
        summary,
        payload: { associateId: candidate.associateId, replacesAssociateId: holderId, cause: cause.kind },
      },
      now,
    );
    out.proposed += 1;
  }
  return out;
}

/** Nobody on the bench can take it: on the trail once a day per shift (the scorecard counts it; the desk already heard of the hole). */
async function noteNoCandidate(db: Db, agent: AgentContext, shiftId: string, cause: RepairCause, overlap: string, now: Date): Promise<void> {
  const seen = await db.auditLog.findFirst({ where: { workerId: agent.workerId, action: NO_CANDIDATE_ACTION, entityId: shiftId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } }, select: { id: true } });
  if (seen) return;
  logAgentAction(agent, { action: NO_CANDIDATE_ACTION, entityType: 'Shift', entityId: shiftId, scopes: [...capabilityDef(SCHEDULE_REPAIR)!.scopes], metadata: { cause: cause.kind, overlap } });
}

/**
 * Fire-and-forget entry for the events: never throws into the caller, and
 * tests await it through flushPendingNotifications. Runs in the caller's
 * tenant context.
 */
export function repairSoon(shiftIds: readonly string[], cause: RepairCause, now: Date = new Date()): void {
  if (!shiftIds.length) return;
  void trackNotificationWork(
    repairShifts(defaultPrisma, shiftIds, cause, now).catch((err) => {
      console.error('[alto-people/api] schedule.repair failed:', err);
    }),
  );
}

/** The assigned shifts approved leave runs over (widened a day each side; holderCannotWork reads the leave in the site's zone). */
async function shiftsUnderLeave(db: Db, tenantId: string, row: { associateId: string; startDate: Date; endDate: Date }, now: Date): Promise<string[]> {
  const rows = await db.shift.findMany({
    where: {
      tenantId,
      assignedAssociateId: row.associateId,
      status: 'ASSIGNED',
      startsAt: { gt: now, lt: new Date(Math.min(row.endDate.getTime() + 2 * DAY_MS, now.getTime() + REPAIR_HORIZON_MS)) },
      endsAt: { gt: new Date(row.startDate.getTime() - DAY_MS) },
    },
    select: { id: true },
    take: 100,
  });
  return rows.map((r) => r.id);
}

/** Leave approved: propose cover for every assigned shift it runs over. */
export function repairAfterTimeOff(row: { associateId: string; category: string; startDate: Date; endDate: Date }, now: Date = new Date()): void {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  void trackNotificationWork(
    shiftsUnderLeave(defaultPrisma, tenantId, row, now)
      .then((ids) => repairShifts(defaultPrisma, ids, { kind: 'time_off', associateId: row.associateId, category: row.category, startDate: row.startDate, endDate: row.endDate }, now))
      .catch((err) => {
        console.error('[alto-people/api] schedule.repair after time off failed:', err);
      }),
  );
}

export interface ScheduleRepairTick extends RepairRun {
  superseded: number;
  executed: number;
}

/**
 * The backstop tick, per tenant: retire repair proposals that no longer
 * apply, carry out approvals a switch held, and repair approved leave over
 * assigned shifts that no event reached.
 */
export async function runScheduleRepair(db: Db = defaultPrisma, now: Date = new Date()): Promise<ScheduleRepairTick> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: ScheduleRepairTick = { uncovered: 0, proposed: 0, noCandidate: 0, superseded: 0, executed: 0 };
  const agent = await repairAgent(db, tenantId);
  if (typeof agent === 'string') return { ...out, skipped: agent };

  const inflight = await db.agentProposal.findMany({ where: { tenantId, workerId: agent.workerId, capabilityKey: SCHEDULE_REPAIR, status: { in: ['PROPOSED', 'APPROVED'] } } });
  for (const pr of inflight) {
    const shift = pr.subjectId ? await db.shift.findFirst({ where: { id: pr.subjectId, tenantId }, select: SHIFT_SELECT }) : null;
    const moot = await assignProposalMoot(db, shift, replacesOf(pr.payload), pr.capabilityKey);
    if (moot) {
      await supersedeProposal(db, pr, moot, now);
      out.superseded += 1;
    } else if (pr.status === 'APPROVED') {
      if (await executeAssignProposal(pr, now)) out.executed += 1;
    }
  }

  const horizon = new Date(now.getTime() + REPAIR_HORIZON_MS);
  const leave = await db.timeOffRequest.findMany({
    where: { tenantId, status: 'APPROVED', endDate: { gte: new Date(now.getTime() - DAY_MS) }, startDate: { lt: horizon } },
    select: { associateId: true, category: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' },
    take: 500,
  });
  for (const row of leave) {
    const ids = await shiftsUnderLeave(db, tenantId, row, now);
    if (!ids.length) continue;
    const r = await repairShifts(db, ids, { kind: 'time_off', associateId: row.associateId, category: row.category, startDate: row.startDate, endDate: row.endDate }, now);
    out.uncovered += r.uncovered;
    out.proposed += r.proposed;
    out.noCandidate += r.noCandidate;
  }
  return out;
}

/* ---- Registration: the executor, certification and the scorecard ------- */

let registered = false;

/** Idempotent: wire schedule.repair's executor, fixture runner and metrics. */
export function registerScheduleRepair(): void {
  if (registered) return;
  registered = true;
  registerApprovedHandler(SCHEDULE_REPAIR, async (proposal, now) => {
    await executeAssignProposal(proposal, now);
  });
  // The fixture names the shift and the person it covers for; the pick is the real one.
  registerCapabilityRunner(SCHEDULE_REPAIR, async (ctx) => {
    const shiftId = ctx.refs[String(ctx.input.shiftRef)];
    if (!shiftId) return { output: { proposedRef: null }, actions: [] };
    const replaces = ctx.refs[String(ctx.input.replacesRef)];
    const shift = await ctx.db.shift.findUniqueOrThrow({ where: { id: shiftId }, select: SHIFT_SELECT });
    const c = await pickFillCandidate(ctx.db, shift, ctx.now, { tenantId: ctx.tenantId, exclude: replaces ? [replaces] : [] });
    return c ? { output: { proposedRef: c.associateId }, actions: ['propose'] } : { output: { proposedRef: null }, actions: [] };
  });
  registerCapabilityMetrics(SCHEDULE_REPAIR, async (db, workerId, since) => {
    const rows = await db.agentProposal.findMany({
      where: { workerId, capabilityKey: SCHEDULE_REPAIR, createdAt: { gte: since } },
      select: { status: true, outcome: true, subjectId: true },
    });
    const unmatched = await db.auditLog.findMany({ where: { workerId, action: NO_CANDIDATE_ACTION, createdAt: { gte: since } }, select: { entityId: true }, distinct: ['entityId'] });
    const shifts = new Set([...rows.map((r) => r.subjectId), ...unmatched.map((u) => u.entityId)].filter((v): v is string => !!v));
    const repairedBeforeStart = rows.filter((r) => {
      if (r.status !== 'EXECUTED') return false;
      const o = (r.outcome as Record<string, unknown> | null) ?? {};
      return typeof o.assignedAt === 'string' && typeof o.startsAt === 'string' && o.assignedAt < o.startsAt;
    }).length;
    return { shiftsUncovered: shifts.size, proposalsMade: rows.length, repairedBeforeStart };
  });
}

registerScheduleRepair();
