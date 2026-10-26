import type { Prisma, PrismaClient, TimeCorrectionRequest } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { notifyAssociate, notifyClientSupervisors } from './notify.js';
import { getLaborPolicy } from './stateLaborPolicy.js';
import { loadLiveRules } from './laborRules/live.js';
import { fmtDayInZone, fmtMomentInZone } from './humanDates.js';

/**
 * Timekeeping corrections, attested.
 *
 *   A worker asks to fix a punch from their phone — a missed clock-in or
 *   clock-out, a wrong time, a shift that never got punched — with a reason
 *   and a signed attestation ("I certify…"), which California requires for
 *   any change to a worker's time record. A time approver (in reach) approves
 *   with the edit applied under their name, the before and after kept on the
 *   request and the audit trail, or denies with a reason the worker sees.
 *
 *   The kiosk raises a PROMPTED request when someone punches with an entry
 *   still open from a past day (a missed clock-out) — the worker finishes it
 *   from their phone.
 *
 *   At clock-out, where the state requires a meal break, the worker answers
 *   "did you get your meal break?". A "no" is paid as the premium when the
 *   jurisdiction pays by its labor rules (LIVE); otherwise the lead is told.
 */

type Db = PrismaClient;

export const CORRECTION_KINDS = ['MISSED_CLOCK_IN', 'MISSED_CLOCK_OUT', 'WRONG_TIME', 'NEW_ENTRY'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

/** The words a worker signs, kept with the request. */
export const ATTESTATION_TEXT =
  'I certify that the times in this request are true and correct, and that I am asking to change my own time record.';

/** An entry open longer than this when the person punches again was a missed clock-out. */
export const STALE_OPEN_HOURS = 16;
const HOUR = 3_600_000;
const MAX_ENTRY_HOURS = 24;

export interface SubmitInput {
  kind: CorrectionKind;
  timeEntryId?: string | null;
  siteId?: string | null;
  proposedClockIn?: string | null;
  proposedClockOut?: string | null;
  reason: string;
  attested: boolean;
}

const audit = (actorUserId: string | null, action: string, id: string, metadata: Record<string, unknown>) =>
  enqueueAudit({ actorUserId, clientId: null, action, entityType: 'TimeCorrectionRequest', entityId: id, metadata: metadata as Prisma.InputJsonObject }, 'timeCorrections');

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function asDate(v: string | null | undefined, label: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_time', `${label} isn’t a valid time.`);
  return d;
}

/** Is the day already paid? A finalized run covering the date for this person refuses a correction. */
async function paidPeriodFor(db: Db, associateId: string, at: Date): Promise<boolean> {
  const hit = await db.payrollItem.findFirst({
    where: { associateId, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodStart: { lte: at }, periodEnd: { gte: new Date(at.getTime() - 86_400_000) } } },
    select: { id: true },
  });
  return !!hit;
}

/** A worker submits (or finishes a PROMPTED) correction. */
export async function submitCorrection(db: Db, ctx: { tenantId: string; associateId: string; userId: string; ip?: string | null; ua?: string | null }, input: SubmitInput, promptedId?: string): Promise<TimeCorrectionRequest> {
  if (!input.attested) throw new HttpError(400, 'attestation_required', 'Confirm that the times are true and correct.');
  const reason = input.reason.trim();
  if (reason.length < 3) throw new HttpError(400, 'reason_required', 'Say what happened.');
  const cin = asDate(input.proposedClockIn, 'Clock-in');
  const cout = asDate(input.proposedClockOut, 'Clock-out');
  const now = new Date();
  if ((cin && cin > now) || (cout && cout > now)) throw new HttpError(400, 'future_time', 'A correction can’t be in the future.');
  if (cin && cout && cout <= cin) throw new HttpError(400, 'out_before_in', 'The clock-out has to be after the clock-in.');
  if (cin && cout && cout.getTime() - cin.getTime() > MAX_ENTRY_HOURS * HOUR) throw new HttpError(400, 'too_long', 'A single shift can’t be longer than 24 hours.');

  let entry: { id: string; clockInAt: Date; clockOutAt: Date | null; status: string; locationId: string | null; clientId: string | null } | null = null;
  if (input.kind === 'NEW_ENTRY' || input.kind === 'MISSED_CLOCK_IN') {
    if (!cin || !cout) throw new HttpError(400, 'times_required', 'Give both the clock-in and the clock-out.');
  } else {
    if (!input.timeEntryId) throw new HttpError(400, 'entry_required', 'Pick the shift to fix.');
    entry = await db.timeEntry.findFirst({ where: { id: input.timeEntryId, associateId: ctx.associateId }, select: { id: true, clockInAt: true, clockOutAt: true, status: true, locationId: true, clientId: true } });
    if (!entry) throw new HttpError(404, 'entry_not_found', 'That shift isn’t yours, or doesn’t exist.');
    if (input.kind === 'MISSED_CLOCK_OUT' && !cout) throw new HttpError(400, 'clock_out_required', 'Give the time you left.');
    if (input.kind === 'WRONG_TIME' && !cin && !cout) throw new HttpError(400, 'times_required', 'Give the right clock-in, clock-out, or both.');
    const effIn = cin ?? entry.clockInAt;
    const effOut = cout ?? entry.clockOutAt;
    if (effOut && effOut <= effIn) throw new HttpError(400, 'out_before_in', 'The clock-out has to be after the clock-in.');
  }
  const workAt = cin ?? entry?.clockInAt ?? now;
  if (await paidPeriodFor(db, ctx.associateId, workAt)) {
    throw new HttpError(409, 'period_paid', 'That day is in a pay period that has already been paid. Ask your manager or payroll to correct it with an amendment.');
  }
  let siteId = input.siteId ?? entry?.locationId ?? null;
  if (input.siteId) {
    const placed = await db.associateAssignment.findFirst({ where: { associateId: ctx.associateId, locationId: input.siteId }, select: { id: true } });
    if (!placed) throw new HttpError(400, 'site_not_yours', 'Pick a place you work at.');
    siteId = input.siteId;
  }
  const open = await db.timeCorrectionRequest.findFirst({ where: { associateId: ctx.associateId, status: 'SUBMITTED', ...(entry ? { timeEntryId: entry.id } : {}), ...(entry ? {} : { proposedClockIn: cin }) }, select: { id: true } });
  if (open) throw new HttpError(409, 'already_requested', 'You already asked to fix this one — it’s waiting on your manager.');

  const data = {
    tenantId: ctx.tenantId,
    associateId: ctx.associateId,
    timeEntryId: entry?.id ?? null,
    kind: input.kind,
    status: 'SUBMITTED',
    workDate: new Date(`${workAt.toISOString().slice(0, 10)}T00:00:00Z`),
    siteId,
    proposedClockIn: cin,
    proposedClockOut: cout,
    reason,
    attestationText: ATTESTATION_TEXT,
    attestedAt: now,
    attestationIp: ctx.ip?.slice(0, 64) ?? null,
    attestationUa: ctx.ua?.slice(0, 300) ?? null,
    before: entry ? { clockInAt: iso(entry.clockInAt), clockOutAt: iso(entry.clockOutAt), status: entry.status } : undefined,
  };
  const row = promptedId
    ? await db.timeCorrectionRequest.update({ where: { id: promptedId }, data })
    : await db.timeCorrectionRequest.create({ data });
  audit(ctx.userId, 'time.correction_requested', row.id, { kind: row.kind, timeEntryId: row.timeEntryId, proposedClockIn: iso(cin), proposedClockOut: iso(cout), attestation: ATTESTATION_TEXT });
  const clientId = entry?.clientId ?? (siteId ? (await db.site.findFirst({ where: { id: siteId }, select: { clientId: true } }))?.clientId ?? null : null);
  void notifyClientSupervisors(clientId, {
    subject: 'A punch correction to review',
    body: `A worker asked to fix a ${row.kind === 'MISSED_CLOCK_OUT' ? 'missed clock-out' : row.kind === 'MISSED_CLOCK_IN' ? 'missed clock-in' : row.kind === 'NEW_ENTRY' ? 'shift that wasn’t punched' : 'wrong time'}: “${reason.slice(0, 140)}”.`,
    category: 'time',
    linkUrl: '/time-attendance?tab=corrections',
    excludeUserId: ctx.userId,
    aboutAssociateId: ctx.associateId,
  });
  return row;
}

/** The decider is never the worker the request is about. */
export async function decideCorrection(db: Db, id: string, decider: { id: string; associateId: string | null }, input: { decision: 'APPROVE' | 'DENY'; reason?: string | null }, scope: Prisma.AssociateWhereInput): Promise<TimeCorrectionRequest> {
  const row = await db.timeCorrectionRequest.findFirst({ where: { id, associate: scope } });
  if (!row) throw new HttpError(404, 'correction_not_found', 'Not found.');
  if (row.status !== 'SUBMITTED') throw new HttpError(409, 'already_decided', 'This one was already decided.');
  if (decider.associateId && decider.associateId === row.associateId) throw new HttpError(403, 'own_correction', 'Someone else decides a correction to your own time.');
  const now = new Date();
  if (input.decision === 'DENY') {
    const reason = input.reason?.trim();
    if (!reason || reason.length < 3) throw new HttpError(400, 'reason_required', 'Say why, so the worker knows what to do next.');
    const denied = await db.timeCorrectionRequest.update({ where: { id }, data: { status: 'DENIED', decidedById: decider.id, decidedAt: now, decisionReason: reason } });
    audit(decider.id, 'time.correction_denied', id, { reason });
    void notifyAssociate(row.associateId, { subject: 'Your punch correction wasn’t approved', body: reason, category: 'time', linkUrl: '/time-attendance' });
    return denied;
  }
  const beforeIn = (row.before as { clockInAt?: string | null } | null)?.clockInAt;
  const workAt = row.proposedClockIn ?? (beforeIn ? new Date(beforeIn) : now);
  if (await paidPeriodFor(db, row.associateId, workAt)) {
    throw new HttpError(409, 'period_paid', 'That day has already been paid. Correct it with a payroll amendment instead.');
  }
  const updated = await db.$transaction(async (tx) => {
    let after: Record<string, string | null>;
    let entryId = row.timeEntryId;
    if (row.timeEntryId) {
      const entry = await tx.timeEntry.findUniqueOrThrow({ where: { id: row.timeEntryId } });
      const clockInAt = row.proposedClockIn ?? entry.clockInAt;
      const clockOutAt = row.proposedClockOut ?? entry.clockOutAt;
      if (clockOutAt && clockOutAt <= clockInAt) throw new HttpError(409, 'out_before_in', 'The corrected clock-out would come before the clock-in.');
      const status = entry.status === 'ACTIVE' && clockOutAt ? 'COMPLETED' : entry.status;
      await tx.timeEntry.update({
        where: { id: entry.id },
        data: {
          clockInAt,
          clockOutAt,
          status,
          ...(status === 'APPROVED' ? { approvedById: decider.id, approvedAt: now } : {}),
          notes: [entry.notes, `Corrected ${fmtDayInZone(now)} at the worker’s attested request.`].filter(Boolean).join(' ').slice(0, 1000),
        },
      });
      after = { clockInAt: iso(clockInAt), clockOutAt: iso(clockOutAt), status };
    } else {
      const site = row.siteId ? await tx.site.findFirst({ where: { id: row.siteId }, select: { clientId: true } }) : null;
      const overlap = await tx.timeEntry.findFirst({ where: { associateId: row.associateId, clockInAt: { lt: row.proposedClockOut! }, OR: [{ clockOutAt: null }, { clockOutAt: { gt: row.proposedClockIn! } }] }, select: { id: true } });
      if (overlap) throw new HttpError(409, 'overlaps_entry', 'Those times overlap a shift already on file. Fix that shift instead.');
      const created = await tx.timeEntry.create({
        data: {
          associateId: row.associateId,
          clientId: site?.clientId ?? null,
          locationId: row.siteId,
          clockInAt: row.proposedClockIn!,
          clockOutAt: row.proposedClockOut!,
          status: 'COMPLETED',
          notes: 'Added at the worker’s attested request.',
        },
      });
      entryId = created.id;
      after = { clockInAt: iso(created.clockInAt), clockOutAt: iso(created.clockOutAt), status: created.status };
    }
    return tx.timeCorrectionRequest.update({ where: { id }, data: { status: 'APPROVED', timeEntryId: entryId, decidedById: decider.id, decidedAt: now, decisionReason: input.reason?.trim() || null, after } });
  });
  audit(decider.id, 'time.correction_approved', id, { timeEntryId: updated.timeEntryId, before: row.before ?? null, after: updated.after ?? null, attestation: row.attestationText, attestedAt: iso(row.attestedAt) });
  void notifyAssociate(row.associateId, { subject: 'Your punch correction was approved', body: 'Your time record now shows the times you sent.', category: 'time', linkUrl: '/time-attendance' });
  return updated;
}

/** The kiosk saw an entry left open from a past shift: ask the worker to finish it. Idempotent per entry. */
export async function promptMissedClockOut(db: Db, tenantId: string, entry: { id: string; associateId: string; clockInAt: Date; locationId: string | null }): Promise<string> {
  const existing = await db.timeCorrectionRequest.findFirst({ where: { timeEntryId: entry.id, status: { in: ['PROMPTED', 'SUBMITTED'] } }, select: { id: true } });
  if (existing) return existing.id;
  const row = await db.timeCorrectionRequest.create({
    data: { tenantId, associateId: entry.associateId, timeEntryId: entry.id, kind: 'MISSED_CLOCK_OUT', status: 'PROMPTED', siteId: entry.locationId, workDate: new Date(`${entry.clockInAt.toISOString().slice(0, 10)}T00:00:00Z`), before: { clockInAt: iso(entry.clockInAt), clockOutAt: null, status: 'ACTIVE' } },
  });
  void notifyAssociate(entry.associateId, { subject: 'You didn’t clock out last time', body: 'Tell us when you left, from the Time tab, so your hours are right.', category: 'time', linkUrl: '/time-attendance?fix=1' });
  return row.id;
}

/** Whether an open entry is a missed clock-out from a past shift. */
export const isStaleOpenEntry = (clockInAt: Date, now = new Date()) => now.getTime() - clockInAt.getTime() > STALE_OPEN_HOURS * HOUR;

/* ----- Break attestation ------------------------------------------------------ */

export type MealAnswer = 'YES' | 'NO' | 'WAIVED';

/** Does this state ask the worker about breaks at clock-out? */
export function breakQuestionsFor(state: string | null | undefined): { meal: boolean; rest: boolean; mealAfterHours: number | null } {
  const p = getLaborPolicy(state);
  return { meal: p.mealBreakRequiredAfterHours !== null, rest: p.restBreakRequiredPerHours !== null, mealAfterHours: p.mealBreakRequiredAfterHours };
}

/**
 * Record the clock-out answer. A "no" is paid as the premium where the
 * jurisdiction is LIVE (the payroll aggregator reads the answer); anywhere
 * else the lead hears about it so it can be put right.
 */
export async function recordBreakAttestation(db: Db, ctx: { tenantId: string; associateId: string; entry: { id: string; clientId: string | null; locationId: string | null; clockInAt: Date } }, input: { meal: MealAnswer; rest?: 'YES' | 'NO' | null; note?: string | null }): Promise<{ flagged: boolean }> {
  let flagged = false;
  if (input.meal === 'NO' || input.rest === 'NO') {
    const site = ctx.entry.locationId ? await db.site.findFirst({ where: { id: ctx.entry.locationId }, select: { id: true, state: true, city: true } }) : null;
    const live = await loadLiveRules(db, ctx.tenantId);
    flagged = !live.activationFor(site);
  }
  await db.breakAttestation.upsert({
    where: { timeEntryId: ctx.entry.id },
    create: { tenantId: ctx.tenantId, timeEntryId: ctx.entry.id, associateId: ctx.associateId, meal: input.meal, rest: input.rest ?? null, note: input.note?.slice(0, 500) ?? null, flagged },
    update: { meal: input.meal, rest: input.rest ?? null, note: input.note?.slice(0, 500) ?? null, flagged },
  });
  if (flagged) {
    void notifyClientSupervisors(ctx.entry.clientId, {
      subject: 'A worker reported a missed break',
      body: `${input.meal === 'NO' ? 'No meal break' : 'A rest break was missed'} on the shift that started ${fmtMomentInZone(ctx.entry.clockInAt)}.${input.note ? ` “${input.note.slice(0, 140)}”` : ''}`,
      category: 'time',
      linkUrl: '/time-attendance?tab=breaks',
      at: { locationId: ctx.entry.locationId, startsAt: ctx.entry.clockInAt },
      aboutAssociateId: ctx.associateId,
    });
  }
  return { flagged };
}
