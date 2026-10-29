import { Prisma, type PrismaClient } from '@prisma/client';
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
import { associateLang, discloserFor, userLang } from './agentDisclosure.js';
import { enqueueAudit } from './audit.js';
import { attendancePoints, RISK_THRESHOLD } from './noShowRisk.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { formatShiftLine, notifyShift } from './notifyShift.js';
import { dayKeyInZone } from './shiftAssign.js';
import { siteSupervisorRecipients, supervisorRecipients } from './shiftWindows.js';
import { ALTO_TENANT_ID, currentTenantId } from './tenant.js';
import { moduleOn } from './tenantProfile.js';
import { utcInstantOfLocalMidnight, companyWorkweek } from './timeAnomalies.js';
import { formatTimeInZone, addDaysToKey } from './timezone.js';
import {
  ATTENDANCE_CONFIRM,
  SHIFT_SELECT,
  WORKFORCE_AGENT_KEY,
  assignProposalMoot,
  earlierAssignProposals,
  assignEvidence,
  executeAssignProposal,
  rankBench,
  replacesOf,
  shiftDeepLink,
  shiftWhen,
  siteName,
} from './workforceAgent.js';

/**
 * The Workforce agent's `attendance.confirm` (agent families step 2;
 * docs/agent-families-investigation.md §4).
 *
 *   The day before, the agent asks each high-risk holder (2.5+ unexcused
 *   attendance points in 90 days, the no-show radar's rule) whether they are
 *   coming: WhatsApp when they opted in, the app otherwise, one message a
 *   person a day. The ask goes out at 10:00 site time the day before, so a
 *   6 AM shift still has hours before its cut-off; a shift assigned later is
 *   asked on the next tick, up to an hour before the cut-off. The ask takes
 *   the place of that shift's day-before reminder and the generic "please
 *   confirm" nudge (one message, not three).
 *
 *   The answer is recorded: "I'll be there" in the app or YES on WhatsApp
 *   confirms the shift; "I can't make it" or NO files a backup proposal at
 *   once; silence past the cut-off (twelve hours before the start, owner
 *   2026-10-15) files one too. A backup is a SHIFT_ASSIGN proposal: nothing
 *   changes until the desk approves, and the holder confirming meanwhile
 *   retires it. A NO is a call, so a shift it leaves uncovered and unworked
 *   is recorded as a call-out, not a no-call no-show (lib/attendance).
 *
 *   Asking is a notice, ungated (owner's decision 3), and every ask is on
 *   the agent's trail.
 */

type Db = PrismaClient;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Site-local hour, the day before the shift, from which the holder is asked. */
export const ASK_LOCAL_HOUR = 10;
/** Silence this long before the start files a backup (owner, 2026-10-15). */
export const CUTOFF_MS = 12 * HOUR_MS;
/** The latest an ask still goes out: an hour before the cut-off, so there is time to answer. */
const LAST_ASK_BEFORE_CUTOFF_MS = HOUR_MS;
/** How far ahead the sweep looks. */
const LOOKAHEAD_MS = 48 * HOUR_MS;
/** One agent message per person per day. */
const ONE_PER_DAY_MS = 20 * HOUR_MS;
const NO_CANDIDATE_ACTION = 'agent.attendance.no_backup';

export type ConfirmAnswer = 'YES' | 'NO';

type AskShift = Prisma.ShiftGetPayload<{ select: typeof SHIFT_SELECT & { assignedAssociate: { select: { firstName: true; lastName: true } } } }>;

/** 10:00 site time on the day before the shift's site-local date. */
export function askFrom(shift: { startsAt: Date; locationRel: { timezone: string | null } | null }): Date {
  const tz = shift.locationRel?.timezone ?? companyWorkweek().timezone;
  const dayBefore = addDaysToKey(dayKeyInZone(shift.startsAt, tz), -1);
  return new Date(utcInstantOfLocalMidnight(dayBefore, tz).getTime() + ASK_LOCAL_HOUR * HOUR_MS);
}

export const cutoffOf = (startsAt: Date) => new Date(startsAt.getTime() - CUTOFF_MS);

/** The agent, when every switch lets attendance.confirm run for this tenant; else why not. */
async function confirmAgent(db: Db, tenantId: string): Promise<AgentContext | 'module_off' | 'agent_stopped' | 'capability_off'> {
  for (const m of capabilityDef(ATTENDANCE_CONFIRM)!.requiresModule) {
    if (!(await moduleOn(m, tenantId))) return 'module_off';
  }
  const agent = await inProcessAgent(db, WORKFORCE_AGENT_KEY, tenantId);
  if (!agent) return 'agent_stopped';
  const cap = await db.agentCapability.findFirst({ where: { workerId: agent.workerId, key: ATTENDANCE_CONFIRM, tenantId } });
  if (!cap || !cap.enabled || cap.suspendedAt) return 'capability_off';
  return agent;
}

/**
 * The shifts to ask about now: published, assigned, unconfirmed, never
 * asked, past their ask time (unless `ignoreAskHour`, for certification),
 * not past the last ask, held by a high-risk person; the earliest one per
 * person, and nobody asked in the last day.
 */
export async function selectAskable(db: Db, tenantId: string, now: Date, opts: { ignoreAskHour?: boolean } = {}): Promise<Array<{ shift: AskShift; points: number }>> {
  const shifts = await db.shift.findMany({
    where: {
      tenantId,
      publishedAt: { not: null },
      status: 'ASSIGNED',
      assignedAssociateId: { not: null },
      acknowledgedAt: null,
      attendanceConfirmation: { is: null },
      startsAt: { gt: new Date(now.getTime() + CUTOFF_MS + LAST_ASK_BEFORE_CUTOFF_MS), lt: new Date(now.getTime() + LOOKAHEAD_MS) },
    },
    select: { ...SHIFT_SELECT, assignedAssociate: { select: { firstName: true, lastName: true } } },
    orderBy: { startsAt: 'asc' },
    take: 500,
  });
  const due = shifts.filter((s) => opts.ignoreAskHour || now >= askFrom(s));
  if (!due.length) return [];
  const holders = [...new Set(due.map((s) => s.assignedAssociateId!))];
  const points = await attendancePoints(db, holders, now);
  const recent = await db.attendanceConfirmation.findMany({
    where: { associateId: { in: holders }, sentAt: { gt: new Date(now.getTime() - ONE_PER_DAY_MS) } },
    select: { associateId: true },
  });
  const asked = new Set(recent.map((r) => r.associateId));
  const out: Array<{ shift: AskShift; points: number }> = [];
  for (const s of due) {
    const id = s.assignedAssociateId!;
    const p = points.get(id) ?? 0;
    if (p < RISK_THRESHOLD || asked.has(id)) continue;
    asked.add(id); // the earliest shift only: one message a person a day
    out.push({ shift: s, points: p });
  }
  return out;
}

function cutoffLabel(shift: { startsAt: Date; locationRel: { timezone: string | null } | null }): string {
  const tz = shift.locationRel?.timezone ?? companyWorkweek().timezone;
  const at = cutoffOf(shift.startsAt);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at);
  return `${day} ${formatTimeInZone(at, tz)}`;
}

/** Ask one holder. False when someone else asked first (the shift's row is unique). */
async function ask(db: Db, agent: AgentContext, shift: AskShift, points: number, now: Date): Promise<boolean> {
  const associateId = shift.assignedAssociateId!;
  const consent = await db.whatsAppConsent.findUnique({ where: { associateId }, select: { status: true } });
  const channel = consent?.status === 'OPTED_IN' ? 'WHATSAPP' : 'IN_APP';
  const cutoffAt = cutoffOf(shift.startsAt);
  try {
    await db.attendanceConfirmation.create({
      data: { shiftId: shift.id, associateId, workerId: agent.workerId, channel, sentAt: now, cutoffAt, tenantId: agent.tenantId ?? ALTO_TENANT_ID },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
  // One message, not three: the ask stands in for the day-before reminder and the generic nudge.
  await db.shift.updateMany({ where: { id: shift.id, reminderSentAt: null }, data: { reminderSentAt: now } });
  await db.shift.updateMany({ where: { id: shift.id, confirmNudgedAt: null }, data: { confirmNudgedAt: now } });
  const tz = shift.locationRel?.timezone ?? null;
  const line = formatShiftLine({ position: shift.position, clientName: shift.client?.name ?? shift.locationRel?.name ?? null, startsAt: shift.startsAt, endsAt: shift.endsAt, timezone: tz });
  const by = cutoffLabel(shift);
  // AI disclosure: the ask says an agent is asking and who answers for it, in the holder's language.
  const disclose = await discloserFor(db, agent);
  const lang = await associateLang(db, associateId);
  void notifyShift(db, {
    associateId,
    subject: 'Are you coming to your shift?',
    body: disclose(`${line}. Tap "I'll be there" or "I can't make it" by ${by}. If we don't hear from you, the shift may go to someone else.`, lang),
    category: 'shift_confirm',
    senderUserId: null,
    byAgentId: agent.workerId,
    wa: {
      template: 'alto_shift_confirm',
      params: (lang) => {
        const locale = lang === 'es' ? 'es-US' : lang === 'tr' ? 'tr-TR' : 'en-US';
        const zone = tz ?? companyWorkweek().timezone;
        const day = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(shift.startsAt);
        const time = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
        const cutDay = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'short' }).format(cutoffAt);
        return [shift.position, siteName(shift), `${day}, ${time(shift.startsAt)}–${time(shift.endsAt)}`, `${cutDay} ${time(cutoffAt)}`];
      },
    },
  });
  logAgentAction(agent, {
    action: 'agent.attendance.asked',
    entityType: 'Shift',
    entityId: shift.id,
    scopes: [...capabilityDef(ATTENDANCE_CONFIRM)!.scopes],
    metadata: { associateId, channel, cutoffAt: cutoffAt.toISOString(), points },
  });
  return true;
}

/** The desk for a shift: its client's supervisors, or a direct employer's site leads. */
async function deskFor(db: Db, shift: { clientId: string | null; locationId: string | null; startsAt: Date }): Promise<string[]> {
  const rows = shift.clientId
    ? await supervisorRecipients(db, shift.clientId, { locationId: shift.locationId, startsAt: shift.startsAt })
    : shift.locationId
      ? await siteSupervisorRecipients(db, shift.locationId, { startsAt: shift.startsAt })
      : [];
  return rows.map((r) => r.id);
}

/**
 * File the backup for a NO or for silence: one named person who would take
 * the shift over, waiting on the desk. Nobody free: the desk hears it, once
 * a day per shift, so the hole is still someone's to cover.
 */
async function proposeBackup(db: Db, agent: AgentContext, shiftId: string, holderId: string, reason: 'NO' | 'SILENT', now: Date): Promise<boolean> {
  const tenantId = agent.tenantId ?? ALTO_TENANT_ID;
  const shift = await db.shift.findFirst({ where: { id: shiftId, tenantId }, select: { ...SHIFT_SELECT, assignedAssociate: { select: { firstName: true, lastName: true } } } });
  if (!shift || shift.status !== 'ASSIGNED' || shift.assignedAssociateId !== holderId || shift.startsAt <= now) return false;
  const earlier = await earlierAssignProposals(db, tenantId, shift.id);
  if (earlier.pending) return false;
  const holder = shift.assignedAssociate ? `${shift.assignedAssociate.firstName} ${shift.assignedAssociate.lastName}`.trim() : 'The holder';
  const why = reason === 'NO' ? `${holder} said they can't make it` : `${holder} did not confirm by ${cutoffLabel(shift)}`;
  const ranking = await rankBench(db, shift, now, { tenantId, exclude: [...earlier.turnedDown, holderId], excludeWhy: { [holderId]: reason === 'NO' ? 'holds the shift and said no' : 'holds the shift and did not confirm' } });
  const candidate = ranking.pick;
  if (!candidate) {
    const seen = await db.auditLog.findFirst({ where: { workerId: agent.workerId, action: NO_CANDIDATE_ACTION, entityId: shift.id, createdAt: { gte: new Date(now.getTime() - DAY_MS) } }, select: { id: true } });
    if (seen) return false;
    logAgentAction(agent, { action: NO_CANDIDATE_ACTION, entityType: 'Shift', entityId: shift.id, scopes: [...capabilityDef(ATTENDANCE_CONFIRM)!.scopes], metadata: { reason, holderId } });
    const disclose = await discloserFor(db, agent);
    for (const userId of await deskFor(db, shift)) {
      await notifyUser(userId, {
        subject: `No backup on the bench: ${shift.position} at ${siteName(shift)}`,
        body: disclose(`${why}. Nobody placed there is free for ${shiftWhen(shift)}; cover it from the schedule.`, await userLang(db, userId)),
        category: 'agent_shift_fill',
        linkUrl: shiftDeepLink(shift),
        byAgentId: agent.workerId,
      });
    }
    return false;
  }
  const r = await createProposal(
    db,
    agent,
    {
      capability: ATTENDANCE_CONFIRM,
      subjectType: 'Shift',
      subjectId: shift.id,
      summary: `Give ${holder}'s ${shift.position} shift at ${siteName(shift)}, ${shiftWhen(shift)}, to ${candidate.name}. ${why}.`,
      payload: { associateId: candidate.associateId, replacesAssociateId: holderId, reason },
      evidence: assignEvidence(shift, ranking, {
        context: `${why}, so the shift is at risk of a no-show.`,
        holder: { id: holderId, name: holder, why: reason === 'NO' ? 'said no' : 'did not confirm' },
        leaveOpen: reason === 'NO' ? `${holder} said they cannot make it; the shift would go uncovered unless you assign someone from the schedule.` : `${holder} may still turn up; a no-show leaves the shift uncovered.`,
      }),
    },
    now,
  );
  await db.attendanceConfirmation.updateMany({ where: { shiftId: shift.id }, data: { backupProposalId: r.proposal.id } });
  return true;
}

/**
 * The holder answered (the app's buttons or WhatsApp). Null when the agent
 * never asked about that shift, or it is not theirs. YES confirms the shift
 * and retires a waiting backup; NO files a backup at once. The latest answer
 * stands.
 */
export async function recordConfirmationAnswer(
  db: Db,
  input: { shiftId: string; associateId: string; answer: ConfirmAnswer; via: 'APP' | 'WHATSAPP'; actorUserId?: string | null },
  now: Date = new Date(),
): Promise<{ answer: ConfirmAnswer; shift: { startsAt: Date; endsAt: Date; position: string; timezone: string | null } } | null> {
  const row = await db.attendanceConfirmation.findUnique({
    where: { shiftId: input.shiftId },
    include: { shift: { select: { startsAt: true, endsAt: true, position: true, assignedAssociateId: true, locationRel: { select: { timezone: true } } } } },
  });
  if (!row || row.associateId !== input.associateId || row.shift.assignedAssociateId !== input.associateId) return null;
  const shiftInfo = { startsAt: row.shift.startsAt, endsAt: row.shift.endsAt, position: row.shift.position, timezone: row.shift.locationRel?.timezone ?? null };
  if (row.answer === input.answer) return { answer: input.answer, shift: shiftInfo };
  await db.attendanceConfirmation.update({ where: { id: row.id }, data: { answer: input.answer, answeredAt: now, answeredVia: input.via } });
  enqueueAudit(
    { actorUserId: input.actorUserId ?? null, clientId: null, action: 'attendance_confirmation.answered', entityType: 'Shift', entityId: input.shiftId, metadata: { answer: input.answer, via: input.via, associateId: input.associateId, before: row.answer } },
    'attendanceConfirm',
  );
  if (input.answer === 'YES') {
    await db.shift.updateMany({ where: { id: input.shiftId, acknowledgedAt: null }, data: { acknowledgedAt: now } });
    if (row.backupProposalId) {
      const pr = await db.agentProposal.findUnique({ where: { id: row.backupProposalId } });
      if (pr && (pr.status === 'PROPOSED' || pr.status === 'APPROVED')) await supersedeProposal(db, pr, 'the holder confirmed they will be there', now);
    }
  } else {
    // A NO un-confirms: the shift is no longer "I'll be there".
    await db.shift.updateMany({ where: { id: input.shiftId }, data: { acknowledgedAt: null } });
    const tenantId = currentTenantId() ?? row.tenantId ?? ALTO_TENANT_ID;
    void trackNotificationWork(
      (async () => {
        const agent = await confirmAgent(db, tenantId);
        if (typeof agent === 'string') return;
        await proposeBackup(db, agent, input.shiftId, input.associateId, 'NO', now);
      })().catch((err) => console.error('[alto-people/api] attendance.confirm backup failed:', err)),
    );
  }
  return { answer: input.answer, shift: shiftInfo };
}

/** WhatsApp YES/NO: the holder's open ask (a shift still ahead), newest first. */
export async function answerFromWhatsApp(db: Db, associateId: string, answer: ConfirmAnswer, now: Date = new Date()) {
  const row = await db.attendanceConfirmation.findFirst({
    where: { associateId, shift: { startsAt: { gt: now }, assignedAssociateId: associateId, status: 'ASSIGNED' } },
    orderBy: { sentAt: 'desc' },
    select: { shiftId: true },
  });
  if (!row) return null;
  return recordConfirmationAnswer(db, { shiftId: row.shiftId, associateId, answer, via: 'WHATSAPP' }, now);
}

export interface AttendanceConfirmRun {
  asked: number;
  backups: number;
  superseded: number;
  executed: number;
  skipped?: 'module_off' | 'agent_stopped' | 'capability_off';
}

/** One tick for the tenant in context: retire or carry out backups, ask, and back up the silent. */
export async function runAttendanceConfirm(db: Db = defaultPrisma, now: Date = new Date()): Promise<AttendanceConfirmRun> {
  const tenantId = currentTenantId() ?? ALTO_TENANT_ID;
  const out: AttendanceConfirmRun = { asked: 0, backups: 0, superseded: 0, executed: 0 };
  const agent = await confirmAgent(db, tenantId);
  if (typeof agent === 'string') return { ...out, skipped: agent };

  // 1. Backups in flight: moot ones leave the queue, held approvals run.
  const inflight = await db.agentProposal.findMany({ where: { tenantId, workerId: agent.workerId, capabilityKey: ATTENDANCE_CONFIRM, status: { in: ['PROPOSED', 'APPROVED'] } } });
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

  // 2. Ask, unless the shift already waits on a desk decision (a repair for leave, a fill).
  for (const { shift, points } of await selectAskable(db, tenantId, now)) {
    if ((await earlierAssignProposals(db, tenantId, shift.id)).pending) continue;
    if (await ask(db, agent, shift, points, now)) out.asked += 1;
  }

  // 3. Silence past the cut-off: a backup.
  const silent = await db.attendanceConfirmation.findMany({
    where: { tenantId, answer: null, backupProposalId: null, cutoffAt: { lte: now }, shift: { startsAt: { gt: now }, status: 'ASSIGNED' } },
    select: { shiftId: true, associateId: true },
    take: 200,
  });
  for (const row of silent) {
    if (await proposeBackup(db, agent, row.shiftId, row.associateId, 'SILENT', now)) out.backups += 1;
  }
  return out;
}

/* ---- Registration: the executor, certification and the scorecard ------- */

let registered = false;

/** Idempotent: wire attendance.confirm's executor, fixture runner and metrics. */
export function registerAttendanceConfirm(): void {
  if (registered) return;
  registered = true;
  registerApprovedHandler(ATTENDANCE_CONFIRM, async (proposal, now) => {
    await executeAssignProposal(proposal, now);
  });
  // Who would be asked: the real selection and risk score, without the clock's ask hour.
  registerCapabilityRunner(ATTENDANCE_CONFIRM, async (ctx) => {
    const picked = await selectAskable(ctx.db, ctx.tenantId, ctx.now, { ignoreAskHour: true });
    return { output: { askedRef: picked[0]?.shift.id ?? null, asked: picked.length }, actions: picked.length ? ['ask'] : [] };
  });
  registerCapabilityMetrics(ATTENDANCE_CONFIRM, async (db, workerId, since) => {
    const rows = await db.attendanceConfirmation.findMany({
      where: { workerId, sentAt: { gte: since } },
      select: { shiftId: true, associateId: true, answer: true, backupProposalId: true },
    });
    const ncns = rows.length
      ? await db.attendanceEvent.findMany({ where: { shiftId: { in: rows.map((r) => r.shiftId) }, kind: 'NO_CALL_NO_SHOW', excusedAt: null }, select: { shiftId: true, associateId: true } })
      : [];
    const missed = new Set(ncns.map((e) => `${e.shiftId}:${e.associateId}`));
    const backupIds = rows.map((r) => r.backupProposalId).filter((v): v is string => !!v);
    const accepted = backupIds.length ? await db.agentProposal.count({ where: { id: { in: backupIds }, status: 'EXECUTED' } }) : 0;
    return {
      textsSent: rows.length,
      answered: rows.filter((r) => r.answer).length,
      noShowsConfirmed: rows.filter((r) => r.answer === 'YES' && missed.has(`${r.shiftId}:${r.associateId}`)).length,
      noShowsUnconfirmed: rows.filter((r) => !r.answer && missed.has(`${r.shiftId}:${r.associateId}`)).length,
      backupsAccepted: accepted,
    };
  });
}

registerAttendanceConfirm();
