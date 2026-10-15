import type { Prisma, PrismaClient } from '@prisma/client';
import { capabilityDef, paidMinutesForRange } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { benchFor } from './scope.js';
import { clientRestrictionFor } from './programRules.js';
import { assignWithinRules, autoFillScore, blockedForWindow, findRestGapViolation } from './shiftAssign.js';
import { netWorkedMinutes, startOfWeekUTC, endOfWeekUTC } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE, formatDateInZone, formatTimeInZone, zonedDayOfWeek, zonedMinutes } from './timezone.js';
import { claimApproval, inProcessAgent, logAgentAction } from './agents.js';
import {
  createProposal,
  registerApprovedHandler,
  registerCapabilityMetrics,
  registerCapabilityRunner,
  supersedeProposal,
  syncProposalWithApproval,
} from './agentCapabilities.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { moduleOn } from './tenantProfile.js';
import { notifyUser } from './notify.js';
import { formatShiftLine, notifyShift, shiftWa } from './notifyShift.js';
import { maybeNotifyFinanceNewWorker } from './fieldglassNotify.js';

/**
 * The Workforce agent's first capability, `shift.fill` (agent families
 * step 1; docs/agent-families-investigation.md §4 and §7).
 *
 *   The open-shift broadcast (lib/shiftAutofill) asks the bench first, as it
 *   always has. When the broadcast window passes with the shift still open,
 *   the agent proposes ONE named person: placed there (lib/scope.benchFor —
 *   the client's people, or the site's for a client-less shift), free (no
 *   overlapping shift, no approved time off or declared day off, rest gap
 *   kept, the H-2B petition's client), ranked by the same score as the
 *   schedule's "Suggested" list. The proposal files a SHIFT_ASSIGN approval
 *   on the scheduling desk and nothing is assigned until a person approves.
 *
 *   On approval the agent claims it and assigns through the same rules a
 *   supervisor's assign uses (lib/shiftAssign.assignWithinRules), records
 *   the outcome on the proposal, tells the person, and closes the loop with
 *   the approver. A shift filled another way meanwhile supersedes the
 *   proposal. The tenant's switch, the platform's, the agent's own and the
 *   capability's suspension all stop it; scheduling must be on.
 */

type Db = Prisma.TransactionClient | PrismaClient;

export const SHIFT_FILL = 'shift.fill';
/** Agent families step 2 (lib/scheduleRepair): the same assign, proposed the moment an event un-covers a shift. */
export const SCHEDULE_REPAIR = 'schedule.repair';
/** Agent families step 2 (lib/attendanceConfirm): a backup for a holder who said no, or went silent past the cut-off. */
export const ATTENDANCE_CONFIRM = 'attendance.confirm';
/** The capabilities whose proposals assign a shift: one live proposal per shift across them, one executor. */
export const ASSIGN_CAPABILITIES: readonly string[] = [SHIFT_FILL, SCHEDULE_REPAIR, ATTENDANCE_CONFIRM];
export const WORKFORCE_AGENT_KEY = 'workforce-agent' as const;
const BROADCAST_CATEGORY = 'shift_autofill';
const CLOSURE_CATEGORY = 'agent_shift_fill';
/** The broadcast's horizon: shifts starting within 48 hours (lib/shiftAutofill). */
const HORIZON_MS = 48 * 3_600_000;
/** How long the bench gets to pick a shift up before the agent names someone. */
export const BROADCAST_WINDOW_MS = 2 * 3_600_000;
/** Close to the start the window shortens, so a proposal still has time to be approved. */
const SHORT_NOTICE_MS = 4 * 3_600_000;
const SHORT_WINDOW_MS = 30 * 60_000;

export type FillShift = {
  id: string;
  clientId: string | null;
  locationId: string | null;
  position: string;
  startsAt: Date;
  endsAt: Date;
  publishedAt?: Date | null;
  locationRel: { timezone: string | null; name?: string | null } | null;
  client?: { name: string } | null;
};

export const SHIFT_SELECT = {
  id: true,
  clientId: true,
  locationId: true,
  position: true,
  startsAt: true,
  endsAt: true,
  status: true,
  publishedAt: true,
  assignedAssociateId: true,
  acknowledgedAt: true,
  location: true,
  client: { select: { name: true } },
  locationRel: { select: { name: true, timezone: true } },
} as const;

/** When the broadcast first saw the shift: its publication, or 48 hours before it starts. */
export function broadcastStartedAt(shift: { publishedAt: Date | null; startsAt: Date }): Date {
  const enteredHorizon = new Date(shift.startsAt.getTime() - HORIZON_MS);
  const published = shift.publishedAt ?? enteredHorizon;
  return published > enteredHorizon ? published : enteredHorizon;
}

/** Has the bench had its chance? Two hours, or half an hour when the shift is under four hours away. */
export function broadcastWindowPassed(shift: { publishedAt: Date | null; startsAt: Date }, now: Date): boolean {
  const asked = now.getTime() - broadcastStartedAt(shift).getTime();
  if (asked >= BROADCAST_WINDOW_MS) return true;
  return shift.startsAt.getTime() - now.getTime() <= SHORT_NOTICE_MS && asked >= SHORT_WINDOW_MS;
}

export interface FillCandidate {
  associateId: string;
  name: string;
  score: number;
}

/**
 * The one person to propose: on the shift's bench, free, within the
 * scheduling rules, best by the Suggested ranking (fewer hours this week,
 * then name, break ties). Null when nobody qualifies.
 */
export async function pickFillCandidate(db: Db, shift: FillShift, now: Date, opts: { tenantId: string; exclude?: string[] }): Promise<FillCandidate | null> {
  const bench = benchFor(shift);
  if (!bench) return null;
  const tz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
  const weekStart = startOfWeekUTC(shift.startsAt);
  const weekEnd = endOfWeekUTC(shift.startsAt);
  const people = await db.associate.findMany({
    where: {
      tenantId: opts.tenantId,
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      ...(opts.exclude?.length ? { id: { notIn: opts.exclude } } : {}),
      AND: [bench],
      // No overlapping shift (the hard rule of assignWithinRules, applied up front).
      assignedShifts: { none: { status: { notIn: ['CANCELLED'] }, startsAt: { lt: shift.endsAt }, endsAt: { gt: shift.startsAt } } },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      availability: { select: { dayOfWeek: true, startMinute: true, endMinute: true } },
      assignedShifts: {
        where: { status: { notIn: ['CANCELLED', 'COMPLETED'] }, startsAt: { gte: weekStart, lt: weekEnd } },
        select: { startsAt: true, endsAt: true },
      },
      timeEntries: { where: { clockInAt: { gte: weekStart, lt: weekEnd } }, include: { breaks: true } },
    },
    take: 200,
  });
  if (!people.length) return null;
  // Approved time off and declared days off are a wall, as on assign.
  const blocked = await blockedForWindow(people.map((p) => p.id), shift.startsAt, shift.endsAt, tz, db);
  const dow = zonedDayOfWeek(shift.startsAt, tz);
  const startMin = zonedMinutes(shift.startsAt, tz);
  const endMin = zonedMinutes(shift.endsAt, tz);
  const shiftMinutes = paidMinutesForRange(shift.startsAt, shift.endsAt);
  const ranked = people
    .filter((p) => !blocked.has(p.id))
    .map((p) => {
      const weeklyScheduled = p.assignedShifts.reduce((sum, s) => sum + paidMinutesForRange(s.startsAt, s.endsAt), 0);
      const weeklyActual = p.timeEntries.reduce((sum, e) => sum + netWorkedMinutes(e, e.breaks), 0);
      const score = autoFillScore({
        matchesAvailability: p.availability.some((w) => w.dayOfWeek === dow && w.startMinute <= startMin && w.endMinute >= endMin),
        noConflict: true,
        wouldExceed40: weeklyActual + shiftMinutes > 40 * 60,
        onApprovedTimeOff: false,
      });
      return { p, score, weeklyScheduled };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.weeklyScheduled - b.weeklyScheduled ||
        a.p.lastName.localeCompare(b.p.lastName) ||
        a.p.firstName.localeCompare(b.p.firstName) ||
        a.p.id.localeCompare(b.p.id),
    );
  for (const { p, score } of ranked) {
    // The rest gap is advisory for a supervisor (overridable); the agent never proposes past it.
    if (await findRestGapViolation(db, p.id, shift.startsAt, shift.endsAt, [shift.id])) continue;
    // A petition certifies a client: an H-2B worker is proposed only at that client (marketplace rule).
    const r = await clientRestrictionFor(db, p.id, now);
    if (r && r.clientId !== shift.clientId) continue;
    return { associateId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), score };
  }
  return null;
}

export function siteName(shift: FillShift & { location?: string | null }): string {
  return shift.locationRel?.name ?? shift.client?.name ?? shift.location ?? 'the site';
}

export function shiftWhen(shift: FillShift): string {
  const tz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
  return `${formatDateInZone(shift.startsAt, tz)} ${formatTimeInZone(shift.startsAt, tz)}–${formatTimeInZone(shift.endsAt, tz)}`;
}

/** The schedule opened on the shift's day at its site. */
export function shiftDeepLink(shift: FillShift): string {
  const tz = shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shift.startsAt);
  return `/scheduling?week=${day}${shift.locationId ? `&location=${shift.locationId}` : ''}`;
}

/**
 * Why the person holding a shift cannot work it, as a phrase ("separated"),
 * or null when they can: off the books, or approved time off / a declared
 * day off over it (the same wall assignWithinRules keeps).
 */
export async function holderCannotWork(db: Db, shift: { startsAt: Date; endsAt: Date; locationRel: { timezone: string | null } | null }, associateId: string): Promise<string | null> {
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { deletedAt: true, erasedAt: true, separatedAt: true, deactivatedAt: true } });
  if (!a || a.deletedAt || a.erasedAt) return 'is no longer on file';
  if (a.separatedAt) return 'separated';
  if (a.deactivatedAt) return 'was deactivated';
  const blocked = await blockedForWindow([associateId], shift.startsAt, shift.endsAt, shift.locationRel?.timezone ?? DEFAULT_TIMEZONE, db);
  return blocked.size > 0 ? 'is on approved time off or a declared day off' : null;
}

/**
 * Does an assign proposal still apply? The reason it does not, or null.
 * A fill (no `replaces`) needs the shift open; a repair needs it open or
 * still held by the person it covers for, who still cannot work it; a
 * confirmation backup needs the holder still unconfirmed.
 */
export async function assignProposalMoot(
  db: Db,
  shift: { status: string; assignedAssociateId: string | null; acknowledgedAt?: Date | null; startsAt: Date; endsAt: Date; locationRel: { timezone: string | null } | null } | null,
  replaces: string | null,
  capabilityKey: string,
): Promise<string | null> {
  if (!shift) return 'the shift no longer exists';
  if (shift.status === 'CANCELLED') return 'the shift was cancelled';
  if (shift.status !== 'OPEN' && shift.status !== 'ASSIGNED') return 'the shift is no longer open';
  if (shift.assignedAssociateId && shift.assignedAssociateId !== replaces) return 'the shift was filled another way';
  if (shift.assignedAssociateId) {
    if (capabilityKey === ATTENDANCE_CONFIRM) {
      if (shift.acknowledgedAt) return 'the holder confirmed they will be there';
    } else if (!(await holderCannotWork(db, shift, shift.assignedAssociateId))) {
      return 'the person it covered for can work it again';
    }
  }
  return null;
}

/** The person a proposal would replace on the shift (schedule.repair), or null for a fill. */
export function replacesOf(payload: unknown): string | null {
  const v = (payload as Record<string, unknown> | null)?.replacesAssociateId;
  return typeof v === 'string' ? v : null;
}

/**
 * The assign proposals already made for a shift, under either capability:
 * one waiting at a time; someone a person turned down, or whose assign
 * failed, is not proposed for that shift again. `executed`: the agent
 * already filled it once (a fill does not try twice; a repair answers a
 * new event and may).
 */
export async function earlierAssignProposals(db: Db, tenantId: string, shiftId: string): Promise<{ pending: boolean; executed: boolean; turnedDown: string[] }> {
  const rows = await db.agentProposal.findMany({ where: { tenantId, capabilityKey: { in: [...ASSIGN_CAPABILITIES] }, subjectId: shiftId }, select: { status: true, payload: true } });
  return {
    pending: rows.some((e) => e.status === 'PROPOSED' || e.status === 'APPROVED'),
    executed: rows.some((e) => e.status === 'EXECUTED'),
    turnedDown: rows
      .filter((e) => e.status === 'REJECTED' || e.status === 'FAILED')
      .map((e) => (e.payload as Record<string, unknown> | null)?.associateId)
      .filter((v): v is string => typeof v === 'string'),
  };
}

export interface ShiftFillRun {
  proposed: number;
  superseded: number;
  executed: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/**
 * One tick for the tenant in context: retire proposals whose shift no
 * longer needs filling, carry out approvals that were held by a switch,
 * and propose for every shift whose broadcast window has passed.
 */
export async function runShiftFill(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<ShiftFillRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: ShiftFillRun = { proposed: 0, superseded: 0, executed: 0 };
  if (!(await moduleOn('scheduling', tenantId))) return { ...out, skipped: 'module_off' };
  const agent = await inProcessAgent(db, WORKFORCE_AGENT_KEY, tenantId);
  if (!agent) return { ...out, skipped: 'agent_stopped' };
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: SHIFT_FILL, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return { ...out, skipped: 'capability_off' };

  // 1. Proposals in flight: moot ones leave the queue, held approvals run.
  const inflight = await db.agentProposal.findMany({ where: { tenantId, workerId: agent.workerId, capabilityKey: SHIFT_FILL, status: { in: ['PROPOSED', 'APPROVED'] } } });
  for (const pr of inflight) {
    const shift = pr.subjectId ? await db.shift.findFirst({ where: { id: pr.subjectId, tenantId }, select: SHIFT_SELECT }) : null;
    const moot = await assignProposalMoot(db, shift, replacesOf(pr.payload), pr.capabilityKey);
    if (moot) {
      await supersedeProposal(db, pr, moot, now);
      out.superseded += 1;
    } else if (pr.status === 'APPROVED') {
      if (await executeShiftFill(pr, now)) out.executed += 1;
    }
  }

  // 2. New proposals for shifts the bench left open.
  const shifts = await db.shift.findMany({
    where: { tenantId, publishedAt: { not: null }, status: 'OPEN', assignedAssociateId: null, startsAt: { gt: now, lt: new Date(now.getTime() + HORIZON_MS) } },
    select: SHIFT_SELECT,
    orderBy: { startsAt: 'asc' },
    take: 100,
  });
  for (const shift of shifts) {
    if (!broadcastWindowPassed(shift, now)) continue;
    const earlier = await earlierAssignProposals(db, tenantId, shift.id);
    // One live proposal per shift; a shift the agent already filled once is not proposed again.
    if (earlier.pending || earlier.executed) continue;
    const candidate = await pickFillCandidate(db, shift, now, { tenantId, exclude: earlier.turnedDown });
    if (!candidate) continue;
    await createProposal(
      db,
      agent,
      {
        capability: SHIFT_FILL,
        subjectType: 'Shift',
        subjectId: shift.id,
        summary: `Assign ${candidate.name} to ${shift.position} at ${siteName(shift)}, ${shiftWhen(shift)}. The open-shift broadcast went unanswered.`,
        payload: { associateId: candidate.associateId },
      },
      now,
    );
    out.proposed += 1;
  }
  return out;
}

/**
 * The executor for both assign capabilities: a person approved a shift.fill
 * or schedule.repair proposal. The agent claims the approval (exactly once,
 * the payload as approved) and assigns through the supervisor's rules; a
 * repair takes the shift over from the person it covers for, who hears it
 * is covered when they are still on the books. False when it did not run
 * now (a switch is on, or the proposal is not this agent's to carry out);
 * the next tick retries.
 */
export async function executeAssignProposal(proposal: { id: string; workerId: string; approvalId: string | null; capabilityKey: string; subjectId: string | null; tenantId: string | null; status: string }, now: Date = new Date()): Promise<boolean> {
  const db = defaultPrisma;
  const key = proposal.capabilityKey;
  if (!ASSIGN_CAPABILITIES.includes(key) || !proposal.approvalId || proposal.status !== 'APPROVED') return false;
  const tenantId = proposal.tenantId ?? ALTO_TENANT_ID;
  const agent = await inProcessAgent(db, WORKFORCE_AGENT_KEY, tenantId);
  if (!agent || agent.workerId !== proposal.workerId) return false;
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return false;
  if (!(await moduleOn('scheduling', tenantId))) return false;

  const approval = await db.agentApprovalRequest.findUnique({ where: { id: proposal.approvalId } });
  if (!approval || approval.status !== 'APPROVED') return false;
  const payload = (approval.payload as Record<string, unknown>) ?? {};
  const associateId = typeof payload.associateId === 'string' ? payload.associateId : null;
  const replaces = replacesOf(payload);
  const shift = proposal.subjectId
    ? await db.shift.findFirst({ where: { id: proposal.subjectId, tenantId }, select: SHIFT_SELECT })
    : null;
  const moot = await assignProposalMoot(db, shift, replaces, key);
  if (moot || !shift) {
    await supersedeProposal(db, proposal, moot ?? 'the shift no longer exists', now);
    return false;
  }
  const associate = associateId ? await db.associate.findFirst({ where: { id: associateId, tenantId, deletedAt: null } }) : null;
  const holder = shift.assignedAssociateId ? await db.associate.findUnique({ where: { id: shift.assignedAssociateId }, select: { id: true, firstName: true, lastName: true, separatedAt: true, deactivatedAt: true, deletedAt: true } }) : null;
  const repair = key === SCHEDULE_REPAIR;
  const backup = key === ATTENDANCE_CONFIRM;
  const via = repair ? 'agent_schedule_repair' : backup ? 'agent_attendance_confirm' : 'agent_shift_fill';
  const said = backup ? (await db.attendanceConfirmation.findUnique({ where: { shiftId: shift.id }, select: { answer: true } }))?.answer ?? null : null;

  // Carried out exactly once, as approved.
  await claimApproval(db, agent, approval.id, 'SHIFT_ASSIGN', payload, now);
  const def = capabilityDef(key)!;
  const link = shiftDeepLink(shift);
  let updated;
  try {
    if (!associate) throw new HttpError(404, 'associate_not_found', 'The proposed person is no longer on file.');
    updated = await assignWithinRules(db, shift, associate, { actorUserId: null, via });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 'assign_failed';
    const message = err instanceof Error ? err.message : String(err);
    await syncProposalWithApproval(db, approval.id, 'FAILED', now, { code, message, shiftId: shift.id, associateId });
    logAgentAction(agent, { action: repair ? 'agent.schedule_repair_failed' : backup ? 'agent.attendance_backup_failed' : 'agent.shift_fill_failed', entityType: 'Shift', entityId: shift.id, scopes: [...def.scopes], approvalId: approval.id, metadata: { associateId, replacesAssociateId: replaces, code, message, status: 409 } });
    if (approval.decidedById) {
      await notifyUser(approval.decidedById, {
        subject: `${repair ? 'Cover' : backup ? 'Backup' : 'Shift fill'} not carried out: ${shift.position} at ${siteName(shift)}`,
        body: `${message} ${holder ? 'The shift is still uncovered' : 'The shift is still open'}; assign it from the schedule.`,
        category: CLOSURE_CATEGORY,
        linkUrl: link,
      });
    }
    return true;
  }

  await syncProposalWithApproval(db, approval.id, 'EXECUTED', now, { shiftId: shift.id, associateId: associate.id, replacesAssociateId: holder?.id ?? null, assignedAt: now.toISOString(), startsAt: shift.startsAt.toISOString() });
  // The shift event is the agent's, citing the approval and who gave it.
  logAgentAction(agent, { action: 'shift.assigned', entityType: 'Shift', entityId: shift.id, scopes: [...def.scopes], approvalId: approval.id, metadata: { associateId: associate.id, replacesAssociateId: holder?.id ?? null, approvedBy: approval.decidedById, via } });
  void maybeNotifyFinanceNewWorker(associate.id);
  const line = formatShiftLine({ position: updated.position, clientName: updated.client?.name ?? null, startsAt: updated.startsAt, endsAt: updated.endsAt, timezone: updated.locationRel?.timezone ?? null });
  if (updated.publishedAt) {
    void notifyShift(db, {
      associateId: associate.id,
      subject: 'New shift assigned',
      body: `You've been assigned: ${line}`,
      category: 'shift_assigned',
      ...(approval.decidedById ? { senderUserId: approval.decidedById } : {}),
      wa: shiftWa('alto_shift_assigned', { position: updated.position, clientName: updated.client?.name ?? null, locationName: updated.locationRel?.name ?? null, startsAt: updated.startsAt, endsAt: updated.endsAt, timezone: updated.locationRel?.timezone ?? null }),
    });
  }
  // The person it covers for, still on the books, hears it is off their schedule.
  if (holder && !holder.separatedAt && !holder.deactivatedAt && !holder.deletedAt) {
    void notifyShift(db, {
      associateId: holder.id,
      subject: backup && said !== 'NO' ? 'Your shift was reassigned' : 'Your shift is covered',
      body: !backup
        ? `${line} is covered while you are away. It is off your schedule.`
        : said === 'NO'
          ? `You told us you can't make ${line}. It is covered and off your schedule.`
          : `You did not confirm ${line}, so it was given to someone else. It is off your schedule. If this is a mistake, talk to your supervisor.`,
      category: 'shift_unassigned',
    });
  }
  // Closure to the desk that approved (handoff spine).
  if (approval.decidedById) {
    await notifyUser(approval.decidedById, {
      subject: holder ? `${backup ? 'Backup assigned' : 'Shift covered'}: ${associate.firstName} ${associate.lastName} for ${holder.firstName} ${holder.lastName}` : `Shift filled: ${associate.firstName} ${associate.lastName}`,
      body: `${shift.position} at ${siteName(shift)}, ${shiftWhen(shift)}. Assigned by the Workforce agent on your approval.`,
      category: CLOSURE_CATEGORY,
      linkUrl: link,
    });
  }
  return true;
}

/** Step 1's name for the executor. */
export const executeShiftFill = executeAssignProposal;

/* ---- Registration: the executor, certification and the scorecard ------- */

let registered = false;

/** Idempotent: wire shift.fill's executor, fixture runner and metrics. */
export function registerWorkforceCapabilities(): void {
  if (registered) return;
  registered = true;
  registerApprovedHandler(SHIFT_FILL, async (proposal, now) => {
    await executeShiftFill(proposal, now);
  });
  registerCapabilityRunner(SHIFT_FILL, async (ctx) => {
    const shiftId = ctx.refs[String(ctx.input.shiftRef)];
    if (!shiftId) return { output: { proposedRef: null }, actions: [] };
    const shift = await ctx.db.shift.findUniqueOrThrow({ where: { id: shiftId }, select: SHIFT_SELECT });
    const c = await pickFillCandidate(ctx.db, shift, ctx.now, { tenantId: ctx.tenantId });
    return c ? { output: { proposedRef: c.associateId }, actions: ['propose'] } : { output: { proposedRef: null }, actions: [] };
  });
  registerCapabilityMetrics(SHIFT_FILL, async (db, workerId, since) => {
    const worker = await db.worker.findUnique({ where: { id: workerId }, select: { tenantId: true } });
    const tenantId = worker?.tenantId ?? ALTO_TENANT_ID;
    const rows = await db.agentProposal.findMany({
      where: { workerId, capabilityKey: SHIFT_FILL, createdAt: { gte: since } },
      select: { status: true, createdAt: true, outcomeAt: true, outcome: true, subjectId: true },
    });
    const executed = rows.filter((r) => r.status === 'EXECUTED');
    const beforeStart = executed.filter((r) => {
      const o = (r.outcome as Record<string, unknown> | null) ?? {};
      return typeof o.assignedAt === 'string' && typeof o.startsAt === 'string' && o.assignedAt < o.startsAt;
    }).length;
    const minutes = executed
      .filter((r) => r.outcomeAt)
      .map((r) => (r.outcomeAt!.getTime() - r.createdAt.getTime()) / 60_000)
      .sort((a, b) => a - b);
    const median = minutes.length ? Math.round(minutes.length % 2 ? minutes[(minutes.length - 1) / 2]! : (minutes[minutes.length / 2 - 1]! + minutes[minutes.length / 2]!) / 2) : null;
    // The broadcast's reach: shifts it asked the bench about, and how many were picked up without the agent.
    const asked = await db.notification.findMany({
      where: { tenantId, category: BROADCAST_CATEGORY, createdAt: { gte: since }, linkUrl: { startsWith: '/marketplace?shift=' } },
      select: { linkUrl: true },
      distinct: ['linkUrl'],
      take: 5_000,
    });
    const seenIds = asked.map((n) => (n.linkUrl ?? '').slice('/marketplace?shift='.length)).filter(Boolean);
    const agentFilled = new Set(executed.map((r) => r.subjectId).filter((v): v is string => !!v));
    const pickedUp = seenIds.length
      ? await db.shift.count({ where: { id: { in: seenIds.filter((id) => !agentFilled.has(id)) }, assignedAssociateId: { not: null } } })
      : 0;
    return {
      shiftsSeen: seenIds.length,
      broadcastPickupRate: seenIds.length ? Math.round((pickedUp * 100) / seenIds.length) : null,
      proposalsMade: rows.length,
      proposalsApproved: rows.filter((r) => r.status === 'APPROVED' || r.status === 'EXECUTED' || r.status === 'FAILED').length,
      filledBeforeStart: beforeStart,
      medianMinutesToFill: median,
    };
  });
}

registerWorkforceCapabilities();
