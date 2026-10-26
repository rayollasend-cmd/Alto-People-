import type { Prisma, PrismaClient, UnemploymentClaim } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { attendanceScore } from './attendance.js';
import { renderFormPdf, fmtDay } from './claimsPdf.js';
import { employerNameFor } from './leaveOfAbsence.js';
import { fmtDay as sayDay } from './humanDates.js';

/**
 * Unemployment claims — what the employer says back to the state, and why.
 *
 * The response is only as good as its evidence, and the evidence already
 * lives in the record: the separation (reason, last day, final pay), the
 * last assignment and how it ended, the discipline history, the attendance
 * points at the time, the policies they signed, and — the staffing
 * firm's strongest card — offers of suitable work they declined after an
 * assignment ended. This module gathers it into one packet.
 *
 * The final outcome of a claim is the last word on it: an appeal's outcome,
 * else the hearing's, else the first determination. ALLOWED means benefits
 * were paid and charged to the account; DENIED means the employer's
 * position held.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY_MS = 86_400_000;

export function finalOutcome(c: Pick<UnemploymentClaim, 'determination' | 'hearingOutcome' | 'appealOutcome'>) {
  return c.appealOutcome ?? c.hearingOutcome ?? c.determination ?? null;
}

const SEPARATION_TEXT: Record<string, string> = {
  VOLUNTARY_OTHER_OPPORTUNITY: 'Quit — took another job',
  VOLUNTARY_PERSONAL: 'Quit — personal reasons',
  VOLUNTARY_RELOCATION: 'Quit — relocated',
  VOLUNTARY_RETIREMENT: 'Retired',
  INVOLUNTARY_PERFORMANCE: 'Discharged — performance',
  INVOLUNTARY_LAYOFF: 'Laid off — lack of work',
  INVOLUNTARY_MISCONDUCT: 'Discharged — misconduct',
  END_OF_CONTRACT: 'Assignment ended',
  DECEASED: 'Deceased',
  OTHER: 'Other',
};

const DISCIPLINE_TEXT: Record<string, string> = {
  VERBAL_WARNING: 'Verbal warning',
  WRITTEN_WARNING: 'Written warning',
  FINAL_WARNING: 'Final warning',
  SUSPENSION: 'Suspension',
  TERMINATION: 'Termination',
};

const ATTENDANCE_TEXT: Record<string, string> = {
  LATE: 'Late',
  EARLY_OUT: 'Left early',
  CALL_OUT: 'Called out',
  NO_CALL_NO_SHOW: 'No call, no show',
};

export interface ClaimEvidence {
  separation: {
    id: string;
    reason: string;
    reasonLabel: string;
    lastDayWorked: string;
    noticeDate: string | null;
    status: string;
    notes: string | null;
    finalPaycheckDate: string | null;
  } | null;
  lastAssignment: { store: string; client: string | null; startedAt: string; endedAt: string | null; reason: string | null; stillPlaced: boolean } | null;
  discipline: Array<{ id: string; kind: string; label: string; incidentDate: string; description: string; acknowledged: boolean }>;
  attendance: { score: number; asOf: string; events: Array<{ kind: string; label: string; date: string; points: number; excused: boolean }> };
  signedPolicies: Array<{ title: string; signedAt: string }>;
  workOffers: Array<{ id: string; offeredAt: string; description: string; payRate: number | null; response: string; respondedAt: string | null; declineReason: string | null }>;
  /** A plain-language read of what the evidence supports, for the decision. */
  posture: { kind: 'strong' | 'mixed' | 'weak'; points: string[] };
}

export async function assembleEvidence(c: Pick<UnemploymentClaim, 'associateId' | 'separationId' | 'claimDate'>, db: Db = defaultPrisma): Promise<ClaimEvidence> {
  const sep = c.separationId
    ? await db.separation.findUnique({ where: { id: c.separationId } })
    : await db.separation.findFirst({ where: { associateId: c.associateId }, orderBy: { lastDayWorked: 'desc' } });
  const asOf = sep?.lastDayWorked ?? c.claimDate;
  const yearBefore = new Date(asOf.getTime() - 365 * DAY_MS);
  const [assignment, open, discipline, attendanceEvents, score, policies, agreements, offers] = await Promise.all([
    db.associateAssignment.findFirst({
      where: { associateId: c.associateId, endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
      select: { startedAt: true, endedAt: true, reason: true, location: { select: { name: true, client: { select: { name: true } } } } },
    }),
    db.associateAssignment.findFirst({ where: { associateId: c.associateId, endedAt: null }, select: { startedAt: true, location: { select: { name: true, client: { select: { name: true } } } } } }),
    db.disciplinaryAction.findMany({
      where: { associateId: c.associateId, status: { not: 'RESCINDED' }, incidentDate: { gte: yearBefore, lte: asOf } },
      orderBy: { incidentDate: 'asc' },
      select: { id: true, kind: true, incidentDate: true, description: true, acknowledgedAt: true },
    }),
    db.attendanceEvent.findMany({
      where: { associateId: c.associateId, occurredOn: { gte: new Date(asOf.getTime() - 90 * DAY_MS), lte: asOf } },
      orderBy: { occurredOn: 'asc' },
      select: { kind: true, occurredOn: true, points: true, excusedAt: true },
    }),
    attendanceScore(db as PrismaClient, c.associateId, asOf),
    db.policyCampaignRecipient.findMany({ where: { associateId: c.associateId, signedAt: { not: null } }, select: { signedAt: true, campaign: { select: { name: true } } }, take: 50 }),
    db.agreement.findMany({ where: { associateId: c.associateId, signedAt: { not: null } }, select: { kind: true, signedAt: true }, take: 50 }),
    db.workOffer.findMany({ where: { associateId: c.associateId, offeredAt: { gte: sep ? new Date(sep.lastDayWorked.getTime() - 14 * DAY_MS) : yearBefore } }, orderBy: { offeredAt: 'asc' } }),
  ]);

  const evidence: ClaimEvidence = {
    separation: sep
      ? {
          id: sep.id,
          reason: sep.reason,
          reasonLabel: SEPARATION_TEXT[sep.reason] ?? sep.reason,
          lastDayWorked: fmtDay(sep.lastDayWorked),
          noticeDate: sep.noticeDate ? fmtDay(sep.noticeDate) : null,
          status: sep.status,
          notes: sep.reasonNotes,
          finalPaycheckDate: sep.finalPaycheckDate ? fmtDay(sep.finalPaycheckDate) : null,
        }
      : null,
    lastAssignment: open
      ? { store: open.location.name, client: open.location.client?.name ?? null, startedAt: fmtDay(open.startedAt), endedAt: null, reason: null, stillPlaced: true }
      : assignment
        ? { store: assignment.location.name, client: assignment.location.client?.name ?? null, startedAt: fmtDay(assignment.startedAt), endedAt: assignment.endedAt ? fmtDay(assignment.endedAt) : null, reason: assignment.reason, stillPlaced: false }
        : null,
    discipline: discipline.map((d) => ({ id: d.id, kind: d.kind, label: DISCIPLINE_TEXT[d.kind] ?? d.kind, incidentDate: fmtDay(d.incidentDate), description: d.description, acknowledged: !!d.acknowledgedAt })),
    attendance: {
      score: Number(score),
      asOf: fmtDay(asOf),
      events: attendanceEvents.map((e) => ({ kind: e.kind, label: ATTENDANCE_TEXT[e.kind] ?? e.kind, date: fmtDay(e.occurredOn), points: Number(e.points), excused: !!e.excusedAt })),
    },
    signedPolicies: [
      ...policies.map((p) => ({ title: p.campaign.name, signedAt: fmtDay(p.signedAt) })),
      ...agreements.map((a) => ({ title: a.kind.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase()), signedAt: fmtDay(a.signedAt) })),
    ],
    workOffers: offers.map((o) => ({
      id: o.id,
      offeredAt: o.offeredAt.toISOString(),
      description: o.description,
      payRate: o.payRate === null ? null : Number(o.payRate),
      response: o.response,
      respondedAt: o.respondedAt?.toISOString() ?? null,
      declineReason: o.declineReason,
    })),
    posture: { kind: 'weak', points: [] },
  };
  evidence.posture = readPosture(evidence);
  return evidence;
}

/** What the record supports — never a decision, a read for the person making one. */
export function readPosture(e: ClaimEvidence): ClaimEvidence['posture'] {
  const points: string[] = [];
  let strength = 0;
  const reason = e.separation?.reason ?? null;
  const declined = e.workOffers.filter((o) => o.response === 'DECLINED' || o.response === 'NO_RESPONSE');
  if (reason?.startsWith('VOLUNTARY')) {
    points.push('They quit. A voluntary quit without good cause usually disqualifies — record the notice they gave.');
    strength += 2;
  }
  if (reason === 'INVOLUNTARY_MISCONDUCT') {
    const finals = e.discipline.filter((d) => d.kind === 'FINAL_WARNING' || d.kind === 'WRITTEN_WARNING');
    if (finals.length) {
      points.push(`Discharged for misconduct after ${finals.length} written or final warning${finals.length === 1 ? '' : 's'} — documented warnings are the core of a misconduct case.`);
      strength += 2;
    } else {
      points.push('Discharged for misconduct, but there are no written warnings on file — states expect documented warnings.');
    }
  }
  if (reason === 'INVOLUNTARY_LAYOFF') {
    points.push('A layoff for lack of work is rarely contestable.');
    strength -= 2;
  }
  if (reason === 'END_OF_CONTRACT' || e.lastAssignment?.endedAt) {
    if (declined.length) {
      points.push(`The assignment ended, and they declined or didn't answer ${declined.length} offer${declined.length === 1 ? '' : 's'} of new work — many states treat refusing suitable work as disqualifying.`);
      strength += 2;
    } else {
      points.push('The assignment ended and no offer of new work is on file. Record any offers you made — without one, an ended assignment usually reads as a layoff.');
      strength -= 1;
    }
  }
  if (e.attendance.score >= 6) {
    points.push(`Attendance points stood at ${e.attendance.score} on their last day.`);
    strength += 1;
  }
  if (!e.separation) points.push('No separation is on file — complete it first, so the response states a reason.');
  const kind = strength >= 3 ? 'strong' : strength >= 1 ? 'mixed' : 'weak';
  return { kind, points };
}

export async function responsePacketPdf(
  c: UnemploymentClaim & { associate: { firstName: string; lastName: string; ssnLast4: string | null } },
  e: ClaimEvidence,
  db: Db = defaultPrisma,
): Promise<Buffer> {
  const employer = await employerNameFor(db, c.associateId);
  return renderFormPdf({
    title: 'Employer response — unemployment claim',
    subtitle: `${employer} · ${c.state} claim${c.stateClaimNumber ? ` ${c.stateClaimNumber}` : ''}`,
    sections: [
      {
        heading: 'Claim',
        rows: [
          ['Claimant', `${c.associate.firstName} ${c.associate.lastName}${c.associate.ssnLast4 ? ` (SSN ending ${c.associate.ssnLast4})` : ''}`],
          ['State', c.state],
          ['Claim date', fmtDay(c.claimDate)],
          ['Notice received', fmtDay(c.noticeReceivedAt)],
          ['Response due', fmtDay(c.responseDueAt)],
          ['Employer position', c.decision === 'CONTEST' ? 'Contest' : c.decision === 'DO_NOT_CONTEST' ? 'Do not contest' : 'Not decided'],
        ],
        paragraphs: c.decisionReason ? [c.decisionReason] : [],
      },
      {
        heading: 'Separation',
        rows: e.separation
          ? [
              ['Reason', e.separation.reasonLabel],
              ['Last day worked', e.separation.lastDayWorked],
              ['Notice given', e.separation.noticeDate],
              ['Final paycheck', e.separation.finalPaycheckDate],
            ]
          : [['Separation', 'Not on file']],
        paragraphs: e.separation?.notes ? [e.separation.notes] : [],
      },
      {
        heading: 'Last assignment',
        rows: e.lastAssignment
          ? [
              ['Where', `${e.lastAssignment.store}${e.lastAssignment.client ? ` — ${e.lastAssignment.client}` : ''}`],
              ['From', e.lastAssignment.startedAt],
              ['Ended', e.lastAssignment.endedAt ?? 'Still placed'],
              ['Why it ended', e.lastAssignment.reason],
            ]
          : [['Assignment', 'None on file']],
      },
      {
        heading: 'Offers of suitable work after the assignment',
        bullets: e.workOffers.length
          ? e.workOffers.map(
              (o) =>
                `${sayDay(o.offeredAt.slice(0, 10), { year: true })}: ${o.description}${o.payRate ? ` at $${o.payRate.toFixed(2)}/h` : ''} — ${o.response.toLowerCase().replace('_', ' ')}${o.declineReason ? ` (${o.declineReason})` : ''}`,
            )
          : ['None recorded.'],
      },
      {
        heading: 'Discipline in the 12 months before separation',
        bullets: e.discipline.length ? e.discipline.map((d) => `${sayDay(d.incidentDate, { year: true })} · ${d.label}${d.acknowledged ? ' (acknowledged)' : ''}: ${d.description}`) : ['None.'],
      },
      {
        heading: `Attendance (points on last day: ${e.attendance.score})`,
        bullets: e.attendance.events.length ? e.attendance.events.map((a) => `${sayDay(a.date, { year: true })} · ${a.label} · ${a.points} point${a.points === 1 ? '' : 's'}${a.excused ? ' (excused)' : ''}`) : ['No attendance events in the last 90 days.'],
      },
      {
        heading: 'Policies acknowledged',
        bullets: e.signedPolicies.length ? e.signedPolicies.map((p) => `${p.title} — signed ${p.signedAt}`) : ['None on file.'],
      },
    ],
    footer: 'Submit this response through the state’s employer portal or by its stated method before the due date. Alto People does not transmit to state agencies.',
  });
}

/**
 * The estimated tax impact: charged benefits on claims that were allowed,
 * times the tenant's SUI impact factor (how many future tax dollars each
 * charged dollar costs under its state's experience-rating — set it with
 * your accountant). An estimate, labelled as one.
 */
export function estimatedSuiImpact(claims: Array<Pick<UnemploymentClaim, 'determination' | 'hearingOutcome' | 'appealOutcome' | 'chargesAmount'>>, factor: number): number {
  const charged = claims.filter((c) => finalOutcome(c) === 'ALLOWED').reduce((t, c) => t + Number(c.chargesAmount ?? 0), 0);
  return Math.round(charged * factor * 100) / 100;
}
