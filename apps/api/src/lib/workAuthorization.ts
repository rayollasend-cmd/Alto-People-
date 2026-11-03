import type { EVerifyStatus, Prisma, PrismaClient } from '@prisma/client';
import {
  WORK_AUTH_WARNING_DAYS,
  type ClearedCell,
  type ClearedStanding,
  type WorkBlocker,
  type WorkBlockerKind,
  type WorkWarning,
} from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { addFederalBusinessDays, caseFromEarlierEmployment, earlierI9Reused, eVerifyDueBy } from './hiringCompliance.js';
import { employmentSpellsFor, rehiresFor } from './i9Records.js';
import { hireDatesFor, type HireDate } from './hireDate.js';
import { fmtDay } from './humanDates.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey, localDateKey } from './timezone.js';

/**
 * MAY THIS PERSON WORK ON THAT DAY? (owner, 2026-11-03)
 *
 * The one rule behind the Compliance "Cleared to work" tab, the Inbox's
 * "Scheduled but not cleared to work" count and the scheduling block.
 * Inside the 155 people still working here the compliance lists hid real
 * gaps: 7 people with expired I-9 work authorization (4 worked in the last
 * 30 days) and 3 J-1s past their program end, 2 of them on upcoming shifts
 * — and nothing stopped a scheduler booking them.
 *
 * BLOCKERS — the legal right to work on the day is gone:
 *   - the I-9's work authorization ended: Section 1 says "alien authorized
 *     to work" and workAuthExpiresAt is before the day. A re-verification
 *     (Supplement B, recorded on the I-9 tab) moves workAuthExpiresAt to
 *     the new document's end, so this reads ONLY that field and the
 *     citizenship status. A citizen's, national's or permanent resident's
 *     date never blocks (a green card's expiry is not a work limit).
 *   - the J-1 program ended: the latest end among the J-1 profile and the
 *     open J-1 Program records is before the day. The 30-day grace period
 *     lets a participant stay in the country; it does not allow work.
 *   - E-Verify returned a final nonconfirmation.
 * Every path that puts a person on a shift refuses a shift that touches a
 * blocked day (lib/shiftAssign, bulk create, pickup and swap approvals, the
 * open-shift list, the auto-fill agent and auto-schedule). Only a user with
 * manage:compliance may assign anyway, with a written reason, audited as
 * `work_authorization.override`; a refused attempt is audited too
 * (`work_authorization.blocked`), like the H-2B rule (lib/programRules).
 *
 * WARNINGS — the person may work and HR has something to do: authorization
 * or a J-1 program ending within 30 days, an open E-Verify mismatch, Section
 * 2 or the E-Verify case past the third business day, a background check or
 * drug test a site or client requires (CredentialRequirement) missing or too
 * old. Deadlines still ahead are `upcoming`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** "YYYY-MM-DD" of a DATE column (stored at UTC midnight). */
const ymd = dateColumnKey;
/** An early key: the day a blocker with no start date (a nonconfirmation) applies from. */
const ALWAYS = '0000-01-01';
const DAY_MS = 86_400_000;

/* ----- facts: what the rule reads --------------------------------------- */

export interface J1Window {
  /** The last program day. */
  endsOn: string;
  startsOn: string;
  /** An open J-1 Program record ends later than (or as late as) the profile, else the profile. */
  source: 'program' | 'profile';
  programId: string | null;
  ds2019ExpiresOn: string | null;
  /** programEnd + the program's grace days: may stay, may not work. */
  graceEndsOn: string | null;
}

/** What the blockers need — cheap enough for every assignment. */
export interface AuthorizationFacts {
  associateId: string;
  name: string;
  citizenshipStatus: string | null;
  workAuthExpiresOn: string | null;
  eVerifyStatus: EVerifyStatus | null;
  eVerifyClosedOn: string | null;
  j1: J1Window | null;
}

/** The J-1 window of each person who has one: the latest end among the profile and open J-1 Programs. */
export async function j1WindowsFor(db: Db, associateIds: string[]): Promise<Map<string, J1Window>> {
  const out = new Map<string, J1Window>();
  if (associateIds.length === 0) return out;
  const [profiles, programs] = await Promise.all([
    db.j1Profile.findMany({ where: { associateId: { in: associateIds } }, select: { associateId: true, programStartDate: true, programEndDate: true } }),
    db.program.findMany({
      where: { associateId: { in: associateIds }, type: 'J1_SWT', closedAt: null },
      select: { id: true, associateId: true, programStart: true, programEnd: true, ds2019ExpiresOn: true, gracePeriodDays: true },
      orderBy: [{ programEnd: 'desc' }, { id: 'asc' }],
    }),
  ]);
  // A program closed early (closedAt) is left out, and does NOT block work
  // when the profile's end is still ahead (owner, 2026-11-03): the profile's
  // date stands until HR changes it.
  for (const p of programs) {
    if (out.has(p.associateId)) continue; // newest end first
    const end = ymd(p.programEnd);
    out.set(p.associateId, {
      endsOn: end,
      startsOn: ymd(p.programStart),
      source: 'program',
      programId: p.id,
      ds2019ExpiresOn: p.ds2019ExpiresOn ? ymd(p.ds2019ExpiresOn) : null,
      graceEndsOn: addDaysToKey(end, p.gracePeriodDays),
    });
  }
  for (const j of profiles) {
    const end = ymd(j.programEndDate);
    const prog = out.get(j.associateId);
    if (prog && prog.endsOn >= end) continue;
    out.set(j.associateId, {
      endsOn: end,
      startsOn: ymd(j.programStartDate),
      source: 'profile',
      programId: null,
      ds2019ExpiresOn: prog?.ds2019ExpiresOn ?? null,
      // J-1 Summer Work Travel: 30 days to depart after the program.
      graceEndsOn: addDaysToKey(end, 30),
    });
  }
  return out;
}

export async function authorizationFactsFor(db: Db, associateIds: string[]): Promise<Map<string, AuthorizationFacts>> {
  const out = new Map<string, AuthorizationFacts>();
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return out;
  const [people, i9s, j1] = await Promise.all([
    db.associate.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }),
    db.i9Verification.findMany({
      where: { associateId: { in: ids } },
      select: { associateId: true, citizenshipStatus: true, workAuthExpiresAt: true, eVerifyStatus: true, eVerifyClosedAt: true },
    }),
    j1WindowsFor(db, ids),
  ]);
  const i9By = new Map(i9s.map((r) => [r.associateId, r]));
  for (const p of people) {
    const i9 = i9By.get(p.id);
    out.set(p.id, {
      associateId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      citizenshipStatus: i9?.citizenshipStatus ?? null,
      workAuthExpiresOn: i9?.workAuthExpiresAt ? ymd(i9.workAuthExpiresAt) : null,
      eVerifyStatus: i9?.eVerifyStatus ?? null,
      eVerifyClosedOn: i9?.eVerifyClosedAt ? orgDateKey(i9.eVerifyClosedAt) : null,
      j1: j1.get(p.id) ?? null,
    });
  }
  return out;
}

/* ----- the blockers ------------------------------------------------------ */

/** Who reads the message: HR fixes it; a scheduler without manage:compliance is told to ask HR. */
export type BlockerAudience = 'hr' | 'scheduler';

const returnToCleared = encodeURIComponent('/compliance?tab=cleared');
/** The compliance tab that fixes it, opened on the person, with the way back. */
export function fixLinkFor(tab: 'i9' | 'everify' | 'j1' | 'background' | 'drugtests', associateId: string): string {
  return `/compliance?tab=${tab}&associateId=${associateId}&return=${returnToCleared}`;
}

function blockerMessage(kind: WorkBlockerKind, name: string, endsOn: string | null, today: string, audience: BlockerAudience): string {
  const tense = endsOn && endsOn < today ? 'ended' : 'ends';
  const day = endsOn ? fmtDay(endsOn, { year: true }) : '';
  if (kind === 'WORK_AUTH_ENDED') {
    return audience === 'hr'
      ? `${name}'s work authorization ${tense} on ${day}. Record the re-verification on the I-9 first.`
      : `${name}'s work authorization ${tense} on ${day}. Ask HR to record the re-verification on the I-9.`;
  }
  if (kind === 'J1_PROGRAM_ENDED') {
    return audience === 'hr'
      ? `${name}'s J-1 program ${tense} on ${day}. The grace period does not allow work. If the sponsor extended it, update the program end on the J-1 tab first.`
      : `${name}'s J-1 program ${tense} on ${day}, and the grace period does not allow work. Ask HR.`;
  }
  return audience === 'hr'
    ? `E-Verify returned a final nonconfirmation for ${name}. They can't be scheduled; review the case on the E-Verify tab.`
    : `E-Verify returned a final nonconfirmation for ${name}, so they can't be scheduled. Ask HR.`;
}

/**
 * What stops this person working on `day` ("YYYY-MM-DD", the company's or a
 * site's calendar). `today` sets the message's tense.
 */
export function blockersOn(f: AuthorizationFacts, day: string, today: string, audience: BlockerAudience = 'hr'): WorkBlocker[] {
  const out: WorkBlocker[] = [];
  if (f.citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK' && f.workAuthExpiresOn && f.workAuthExpiresOn < day) {
    out.push({
      kind: 'WORK_AUTH_ENDED',
      endsOn: f.workAuthExpiresOn,
      since: addDaysToKey(f.workAuthExpiresOn, 1),
      message: blockerMessage('WORK_AUTH_ENDED', f.name, f.workAuthExpiresOn, today, audience),
      fixLink: fixLinkFor('i9', f.associateId),
    });
  }
  if (f.j1 && f.j1.endsOn < day) {
    out.push({
      kind: 'J1_PROGRAM_ENDED',
      endsOn: f.j1.endsOn,
      since: addDaysToKey(f.j1.endsOn, 1),
      message: blockerMessage('J1_PROGRAM_ENDED', f.name, f.j1.endsOn, today, audience),
      fixLink: fixLinkFor('j1', f.associateId),
    });
  }
  if (f.eVerifyStatus === 'FINAL_NONCONFIRMATION') {
    out.push({
      kind: 'EVERIFY_FINAL_NONCONFIRMATION',
      endsOn: null,
      since: null,
      message: blockerMessage('EVERIFY_FINAL_NONCONFIRMATION', f.name, null, today, audience),
      fixLink: fixLinkFor('everify', f.associateId),
    });
  }
  return out;
}

/** The first day this person is blocked, whatever the day asked; null = never (on what is on file). */
export function blockedFrom(f: AuthorizationFacts): string | null {
  const days: string[] = [];
  if (f.citizenshipStatus === 'ALIEN_AUTHORIZED_TO_WORK' && f.workAuthExpiresOn) days.push(addDaysToKey(f.workAuthExpiresOn, 1));
  if (f.j1) days.push(addDaysToKey(f.j1.endsOn, 1));
  if (f.eVerifyStatus === 'FINAL_NONCONFIRMATION') days.push(ALWAYS);
  return days.length ? days.sort()[0]! : null;
}

/* ----- shifts ------------------------------------------------------------ */

export interface ShiftWindow {
  startsAt: Date;
  endsAt: Date;
  /** The site's zone; the company's when the shift has no site. */
  timezone?: string | null;
}

/**
 * The calendar days a shift touches, at its site. A shift is checked on its
 * LAST day: an overnight shift that starts on the authorization's last day
 * and ends after midnight is hours of work past the end.
 */
export function shiftDays(s: ShiftWindow): { first: string; last: string } {
  const tz = s.timezone || companyWorkweek().timezone;
  const first = localDateKey(s.startsAt, tz);
  const lastInstant = new Date(Math.max(s.startsAt.getTime(), s.endsAt.getTime() - 1));
  return { first, last: localDateKey(lastInstant, tz) };
}

/** Is the person blocked for this shift, and by what? Empty = cleared for it. */
export function blockersForShift(f: AuthorizationFacts, s: ShiftWindow, now: Date = new Date(), audience: BlockerAudience = 'hr'): WorkBlocker[] {
  return blockersOn(f, shiftDays(s).last, orgDateKey(now), audience);
}

export interface WorkAuthContext {
  actorUserId: string | null;
  /** Which path asked: 'assign' | 'bulk_create' | 'claim_approve' | 'swap_approve' | 'claim' | 'agent' … */
  via: string;
  shiftId?: string | null;
  clientId?: string | null;
  /** The caller holds manage:compliance: the message says what to fix, and an override may pass. */
  canOverride?: boolean;
  /** "Assign anyway" — honoured only with canOverride. */
  override?: { reason: string } | null;
}

function auditBlocked(associateId: string, blockers: WorkBlocker[], day: string, ctx: WorkAuthContext): void {
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: 'work_authorization.blocked',
      entityType: 'Associate',
      entityId: associateId,
      metadata: {
        associateId,
        via: ctx.via,
        shiftId: ctx.shiftId ?? null,
        day,
        blockers: blockers.map((b) => ({ kind: b.kind, endsOn: b.endsOn })),
      } as Prisma.InputJsonObject,
    },
    'workAuthorization.blocked',
  );
}

/** The override's audit row: who, whom, which shift, which blocker, and why (owner, 2026-11-03). */
export function auditOverride(associateId: string, blockers: WorkBlocker[], day: string, ctx: WorkAuthContext & { shiftId: string; reason: string }): void {
  enqueueAudit(
    {
      actorUserId: ctx.actorUserId,
      clientId: ctx.clientId ?? null,
      action: 'work_authorization.override',
      entityType: 'Shift',
      entityId: ctx.shiftId,
      metadata: {
        associateId,
        shiftId: ctx.shiftId,
        via: ctx.via,
        day,
        reason: ctx.reason,
        blockers: blockers.map((b) => ({ kind: b.kind, endsOn: b.endsOn })),
      } as Prisma.InputJsonObject,
    },
    'workAuthorization.override',
  );
}

/**
 * Throw a 409 `not_authorized_to_work` when the person may not work the
 * shift — unless the caller may override and gave a reason, in which case
 * the blockers come back for the caller to audit once the assignment lands
 * (null when nothing blocked). A refused attempt is audited here.
 */
export async function assertAuthorizedToWork(
  db: Db,
  associate: { id: string },
  shift: ShiftWindow,
  ctx: WorkAuthContext,
  now: Date = new Date(),
): Promise<{ blockers: WorkBlocker[]; day: string } | null> {
  const facts = (await authorizationFactsFor(db, [associate.id])).get(associate.id);
  if (!facts) return null;
  const day = shiftDays(shift).last;
  const today = orgDateKey(now);
  const canOverride = ctx.canOverride === true;
  const blockers = blockersOn(facts, day, today, canOverride ? 'hr' : 'scheduler');
  if (blockers.length === 0) return null;
  if (canOverride && ctx.override?.reason && ctx.override.reason.trim().length >= 10) return { blockers, day };
  auditBlocked(associate.id, blockers, day, ctx);
  throw new HttpError(409, 'not_authorized_to_work', blockers.map((b) => b.message).join(' '), {
    associateId: associate.id,
    blockers,
    canOverride,
  });
}

/**
 * Many people against many shifts at once (bulk create, the agents): the
 * blockers per person for the given window. People who are clear are left out.
 */
export async function notClearedFor(db: Db, associateIds: string[], shift: ShiftWindow, now: Date = new Date()): Promise<Map<string, WorkBlocker[]>> {
  const out = new Map<string, WorkBlocker[]>();
  if (associateIds.length === 0) return out;
  const facts = await authorizationFactsFor(db, associateIds);
  const day = shiftDays(shift).last;
  const today = orgDateKey(now);
  for (const f of facts.values()) {
    const b = blockersOn(f, day, today, 'scheduler');
    if (b.length) out.set(f.associateId, b);
  }
  return out;
}

/** Audit a skip on a batch path (bulk create, auto-schedule): the attempt is worth knowing. */
export function auditSkipped(associateId: string, blockers: WorkBlocker[], shift: ShiftWindow, ctx: WorkAuthContext): void {
  auditBlocked(associateId, blockers, shiftDays(shift).last, ctx);
}

/* ----- the whole picture: the Cleared to work tab ----------------------- */

type ScreeningKind = 'BACKGROUND_CHECK' | 'DRUG_TEST';

export interface ScreeningRequirement {
  label: string;
  /** null = any passed one counts. */
  maxAgeDays: number | null;
}

interface ScreeningFacts {
  required: ScreeningRequirement | null;
  /** The latest PASSED one's day (completed, else ordered). */
  passedOn: string | null;
  /** The latest still in flight (ordered, in progress, waiting on review), its order day. */
  inFlightSince: string | null;
}

export interface ClearanceFacts extends AuthorizationFacts {
  hasI9: boolean;
  section2CompletedOn: string | null;
  hire: HireDate | null;
  eVerifyCaseNumber: string | null;
  eVerifyCaseOpenedOn: string | null;
  eVerifyDueBy: string | null;
  /** Employment spells (a rehire has more than one) and REHIRE Supplement B entries — which employment a case is for. */
  spells: Array<{ hireDate: Date; endDate: Date | null }>;
  rehires: Array<{ rehiredOn: string; reviewedOn: string }>;
  background: ScreeningFacts;
  drugTest: ScreeningFacts;
}

/** Where each person works, for which requirements apply: an open assignment, else an approved application, else one in flight. */
async function placesOf(db: Db, ids: string[]): Promise<Map<string, { clientId: string | null; locationId: string | null }>> {
  const out = new Map<string, { clientId: string | null; locationId: string | null }>();
  const [assigned, apps] = await Promise.all([
    db.associateAssignment.findMany({
      where: { associateId: { in: ids }, endedAt: null },
      select: { associateId: true, locationId: true, location: { select: { clientId: true } } },
      orderBy: { startedAt: 'desc' },
    }),
    db.application.findMany({
      where: { associateId: { in: ids }, deletedAt: null, status: { in: ['APPROVED', 'DRAFT', 'SUBMITTED', 'IN_REVIEW'] } },
      select: { associateId: true, clientId: true, locationId: true, status: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
  ]);
  for (const a of assigned) if (!out.has(a.associateId)) out.set(a.associateId, { clientId: a.location.clientId, locationId: a.locationId });
  for (const a of apps.filter((x) => x.status === 'APPROVED')) if (!out.has(a.associateId)) out.set(a.associateId, { clientId: a.clientId, locationId: a.locationId });
  for (const a of apps) if (!out.has(a.associateId)) out.set(a.associateId, { clientId: a.clientId, locationId: a.locationId });
  return out;
}

/**
 * The strictest requirement of a kind that applies to a person (smallest max
 * age; any-age last). A company-wide one (no site, no client — the owner's
 * "every client requires them", 2026-11-03) applies to everyone, placed or
 * not; a site's or a client's only where the person works.
 */
function strictest(reqs: Array<{ kind: string; label: string; maxAgeDays: number | null; locationId: string | null; clientId: string | null }>, kind: ScreeningKind, place: { clientId: string | null; locationId: string | null } | undefined): ScreeningRequirement | null {
  let best: ScreeningRequirement | null = null;
  for (const r of reqs) {
    if (r.kind !== kind) continue;
    const companyWide = !r.locationId && !r.clientId;
    const applies = companyWide || (!!place && ((r.locationId && r.locationId === place.locationId) || (r.clientId && r.clientId === place.clientId)));
    if (!applies) continue;
    if (!best || (r.maxAgeDays !== null && (best.maxAgeDays === null || r.maxAgeDays < best.maxAgeDays))) best = { label: r.label, maxAgeDays: r.maxAgeDays };
  }
  return best;
}

export async function clearanceFactsFor(db: Db, tenantId: string, associateIds: string[]): Promise<Map<string, ClearanceFacts>> {
  const out = new Map<string, ClearanceFacts>();
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return out;
  const [base, i9s, inFlightApps, places, reqs, checks, tests, spells, rehires] = await Promise.all([
    authorizationFactsFor(db, ids),
    db.i9Verification.findMany({
      where: { associateId: { in: ids } },
      select: { associateId: true, section2CompletedAt: true, eVerifyCaseNumber: true, eVerifyCaseOpenedAt: true, eVerifyDueBy: true },
    }),
    db.application.findMany({
      where: { associateId: { in: ids }, deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] }, startDate: { not: null } },
      select: { associateId: true, startDate: true },
      orderBy: { createdAt: 'desc' },
    }),
    placesOf(db, ids),
    db.credentialRequirement.findMany({
      where: { tenantId, deletedAt: null, kind: { in: ['BACKGROUND_CHECK', 'DRUG_TEST'] } },
      select: { kind: true, label: true, maxAgeDays: true, locationId: true, clientId: true },
    }),
    db.backgroundCheck.findMany({
      where: { associateId: { in: ids }, status: { in: ['PASSED', 'INITIATED', 'IN_PROGRESS', 'NEEDS_REVIEW'] } },
      select: { associateId: true, status: true, initiatedAt: true, completedAt: true },
    }),
    db.drugTest.findMany({
      where: { associateId: { in: ids }, status: { in: ['PASSED', 'INITIATED', 'IN_PROGRESS', 'NEEDS_REVIEW'] } },
      select: { associateId: true, status: true, initiatedAt: true, completedAt: true },
    }),
    employmentSpellsFor(db, ids),
    rehiresFor(db, ids),
  ]);
  const planned = new Map<string, Date | null>();
  for (const a of inFlightApps) if (!planned.has(a.associateId)) planned.set(a.associateId, a.startDate);
  const hires = await hireDatesFor(db, ids, planned);
  const i9By = new Map(i9s.map((r) => [r.associateId, r]));
  const screening = (rows: Array<{ associateId: string; status: string; initiatedAt: Date; completedAt: Date | null }>) => {
    const by = new Map<string, { passedOn: string | null; inFlightSince: string | null }>();
    for (const r of rows) {
      const cur = by.get(r.associateId) ?? { passedOn: null, inFlightSince: null };
      if (r.status === 'PASSED') {
        const on = orgDateKey(r.completedAt ?? r.initiatedAt);
        if (!cur.passedOn || on > cur.passedOn) cur.passedOn = on;
      } else {
        const on = orgDateKey(r.initiatedAt);
        if (!cur.inFlightSince || on > cur.inFlightSince) cur.inFlightSince = on;
      }
      by.set(r.associateId, cur);
    }
    return by;
  };
  const bg = screening(checks);
  const dt = screening(tests);
  for (const [id, f] of base) {
    const i9 = i9By.get(id);
    const place = places.get(id);
    out.set(id, {
      ...f,
      hasI9: !!i9,
      section2CompletedOn: i9?.section2CompletedAt ? orgDateKey(i9.section2CompletedAt) : null,
      hire: hires.get(id) ?? null,
      eVerifyCaseNumber: i9?.eVerifyCaseNumber ?? null,
      eVerifyCaseOpenedOn: i9?.eVerifyCaseOpenedAt ? orgDateKey(i9.eVerifyCaseOpenedAt) : null,
      eVerifyDueBy: i9?.eVerifyDueBy ? ymd(i9.eVerifyDueBy) : null,
      spells: spells.get(id) ?? [],
      rehires: rehires.get(id) ?? [],
      background: { required: strictest(reqs, 'BACKGROUND_CHECK', place), passedOn: null, inFlightSince: null, ...bg.get(id) },
      drugTest: { required: strictest(reqs, 'DRUG_TEST', place), passedOn: null, inFlightSince: null, ...dt.get(id) },
    });
  }
  return out;
}

export interface Clearance {
  associateId: string;
  /** No blocker on the day. */
  cleared: boolean;
  standing: ClearedStanding;
  blockers: WorkBlocker[];
  warnings: WorkWarning[];
  /** Deadlines still ahead (Section 2, the E-Verify case, a re-screen). */
  upcoming: WorkWarning[];
  cells: { i9: ClearedCell; everify: ClearedCell; workAuth: ClearedCell; j1: ClearedCell; background: ClearedCell; drugTest: ClearedCell };
}

/**
 * Three business days after the first day of work (I-9 Section 2 and the
 * E-Verify case), weekends and federal holidays skipped — the same day the
 * I-9 and E-Verify tabs show (lib/hiringCompliance).
 */
export function thirdBusinessDay(hireOn: string): string {
  return ymd(addFederalBusinessDays(hireOn, 3));
}

const within = (date: string, from: string, days: number) => date >= from && date <= addDaysToKey(from, days);

function screeningEval(
  s: ScreeningFacts,
  day: string,
  kind: ScreeningKind,
  f: ClearanceFacts,
): { cell: ClearedCell; warning: WorkWarning | null; upcoming: WorkWarning | null } {
  const what = kind === 'BACKGROUND_CHECK' ? 'background check' : 'drug test';
  const fixLink = fixLinkFor(kind === 'BACKGROUND_CHECK' ? 'background' : 'drugtests', f.associateId);
  const goodUntil = s.passedOn && s.required?.maxAgeDays != null ? addDaysToKey(s.passedOn, s.required.maxAgeDays) : null;
  const current = !!s.passedOn && (goodUntil === null || goodUntil >= day);
  if (!s.required) {
    return { cell: s.passedOn ? { state: 'done', date: s.passedOn } : { state: 'not_required', date: null }, warning: null, upcoming: null };
  }
  if (current) {
    const soon = goodUntil && within(goodUntil, day, WORK_AUTH_WARNING_DAYS);
    return {
      cell: soon ? { state: 'due', date: goodUntil } : { state: 'done', date: s.passedOn },
      warning: null,
      upcoming: soon
        ? { kind: kind === 'BACKGROUND_CHECK' ? 'BACKGROUND_DUE' : 'DRUG_TEST_DUE', dueBy: goodUntil, message: `${f.name}'s ${what} (${s.required.label}) needs repeating by ${fmtDay(goodUntil, { year: true })}.`, fixLink }
        : null,
    };
  }
  const message = s.inFlightSince
    ? `${f.name}'s ${what} (${s.required.label}) was ordered on ${fmtDay(s.inFlightSince, { year: true })} and isn't back yet.`
    : s.passedOn
      ? `${f.name}'s last passed ${what} (${fmtDay(s.passedOn, { year: true })}) is older than ${s.required.label} allows. Order a new one.`
      : `${f.name} has no passed ${what}, and ${s.required.label} is required where they work. Order one.`;
  return {
    cell: s.inFlightSince ? { state: 'in_progress', date: s.inFlightSince } : s.passedOn ? { state: 'late', date: goodUntil } : { state: 'missing', date: null },
    warning: { kind: kind === 'BACKGROUND_CHECK' ? 'BACKGROUND_REQUIRED' : 'DRUG_TEST_REQUIRED', dueBy: goodUntil, message, fixLink },
    upcoming: null,
  };
}

/** Everything about one person on `day`; `today` sets message tense (the tab passes today for both). */
export function evaluateClearance(f: ClearanceFacts, day: string, today: string = day): Clearance {
  const blockers = blockersOn(f, day, today, 'hr');
  const warnings: WorkWarning[] = [];
  const upcoming: WorkWarning[] = [];
  const hired = f.hire && f.hire.source !== 'application' ? f.hire.date : null;
  const plannedStart = f.hire?.source === 'application' ? f.hire.date : null;

  // I-9 Section 2: three business days from the first day of work.
  let i9: ClearedCell;
  if (f.section2CompletedOn) i9 = { state: 'done', date: f.section2CompletedOn };
  else {
    const anchor = hired ?? plannedStart;
    const due = anchor ? thirdBusinessDay(anchor) : null;
    const late = !!(hired && due && due < day);
    i9 = due ? { state: late ? 'late' : 'due', date: due } : { state: 'missing', date: null };
    const fixLink = fixLinkFor('i9', f.associateId);
    if (late) warnings.push({ kind: 'SECTION2_LATE', dueBy: due, message: `${f.name}'s I-9 Section 2 was due by ${fmtDay(due, { year: true })}${f.hasI9 ? '' : ' and no I-9 is on file'}.`, fixLink });
    else if (due) upcoming.push({ kind: 'SECTION2_DUE', dueBy: due, message: `${f.name}'s I-9 Section 2 is due by ${fmtDay(due, { year: true })}.`, fixLink });
  }

  // E-Verify: the case is opened by the third business day. A rehire's case
  // opened in an earlier employment doesn't count for this one — unless the
  // earlier I-9 was reused on a REHIRE Supplement B and that case ended
  // Employment Authorized (owner, 2026-11-03). The same rule as the E-Verify
  // tab (lib/hiringCompliance caseFromEarlierEmployment, earlierI9Reused).
  let everify: ClearedCell;
  const everifyLink = fixLinkFor('everify', f.associateId);
  const hasCase = !!(f.eVerifyCaseNumber || f.eVerifyStatus);
  const fromEarlier = hasCase && caseFromEarlierEmployment(f.eVerifyCaseOpenedOn, hired, f.spells);
  const caseForThisJob = hasCase && (!fromEarlier || earlierI9Reused(f.eVerifyStatus, f.rehires, hired));
  // A final nonconfirmation blocks whichever employment it came from (as blockersOn does).
  if (f.eVerifyStatus === 'FINAL_NONCONFIRMATION') everify = { state: 'blocked', date: f.eVerifyClosedOn };
  else if (f.eVerifyStatus === 'EMPLOYMENT_AUTHORIZED' && caseForThisJob) everify = { state: 'done', date: f.eVerifyClosedOn ?? f.eVerifyCaseOpenedOn };
  else if (f.eVerifyStatus === 'TENTATIVE_NONCONFIRMATION' && caseForThisJob) {
    everify = { state: 'issue', date: f.eVerifyCaseOpenedOn };
    warnings.push({ kind: 'EVERIFY_TNC', dueBy: null, message: `E-Verify returned a tentative nonconfirmation for ${f.name}. Give them the notice and record what they decide.`, fixLink: everifyLink });
  } else if (f.eVerifyStatus === 'CLOSE_CASE_AND_RESUBMIT' && caseForThisJob) {
    everify = { state: 'issue', date: f.eVerifyCaseOpenedOn };
    warnings.push({ kind: 'EVERIFY_RESUBMIT', dueBy: null, message: `E-Verify asked for ${f.name}'s case to be closed and submitted again.`, fixLink: everifyLink });
  } else if (caseForThisJob) everify = { state: 'in_progress', date: f.eVerifyCaseOpenedOn };
  else {
    const anchor = hired ?? plannedStart;
    // A stored provider deadline for this employment, else its third business day.
    const dueOn = anchor ? eVerifyDueBy(anchor, hired && f.eVerifyDueBy ? new Date(`${f.eVerifyDueBy}T00:00:00.000Z`) : null) : null;
    const due = dueOn ? ymd(dueOn) : null;
    const late = !!(hired && due && due < day);
    everify = due ? { state: late ? 'late' : 'due', date: due } : { state: 'missing', date: null };
    if (late) warnings.push({ kind: 'EVERIFY_LATE', dueBy: due, message: `${f.name}'s E-Verify case was due by ${fmtDay(due, { year: true })} and hasn't been opened.`, fixLink: everifyLink });
    else if (due) upcoming.push({ kind: 'EVERIFY_DUE', dueBy: due, message: `Open ${f.name}'s E-Verify case by ${fmtDay(due, { year: true })}.`, fixLink: everifyLink });
  }

  // Work authorization: only "alien authorized to work" has an end that matters.
  // An end date with no citizenship status can't say whether it does: HR
  // checks the paper Section 1 (owner, 2026-11-03) — a warning, never a block.
  let workAuth: ClearedCell;
  if (!f.citizenshipStatus && f.workAuthExpiresOn) {
    workAuth = { state: 'issue', date: f.workAuthExpiresOn };
    warnings.push({
      kind: 'WORK_AUTH_NEEDS_REVIEW',
      dueBy: f.workAuthExpiresOn,
      message: `Citizenship status missing — check Section 1 and the expiry date. ${f.name}'s I-9 has a work-authorization end date (${fmtDay(f.workAuthExpiresOn, { year: true })}) but no citizenship status.`,
      fixLink: fixLinkFor('i9', f.associateId),
    });
  } else if (!f.citizenshipStatus) workAuth = { state: 'missing', date: null };
  else if (f.citizenshipStatus !== 'ALIEN_AUTHORIZED_TO_WORK') workAuth = { state: 'not_required', date: null };
  else if (!f.workAuthExpiresOn) workAuth = { state: 'not_required', date: null };
  else if (f.workAuthExpiresOn < day) workAuth = { state: 'ended', date: f.workAuthExpiresOn };
  else if (within(f.workAuthExpiresOn, day, WORK_AUTH_WARNING_DAYS)) {
    workAuth = { state: 'ending', date: f.workAuthExpiresOn };
    warnings.push({ kind: 'WORK_AUTH_ENDING', dueBy: f.workAuthExpiresOn, message: `${f.name}'s work authorization ends on ${fmtDay(f.workAuthExpiresOn, { year: true })}. Re-verify before then (Supplement B on the I-9).`, fixLink: fixLinkFor('i9', f.associateId) });
  } else workAuth = { state: 'ends', date: f.workAuthExpiresOn };

  let j1: ClearedCell;
  if (!f.j1) j1 = { state: 'not_required', date: null };
  else if (f.j1.endsOn < day) j1 = { state: 'ended', date: f.j1.endsOn };
  else if (within(f.j1.endsOn, day, WORK_AUTH_WARNING_DAYS)) {
    j1 = { state: 'ending', date: f.j1.endsOn };
    warnings.push({ kind: 'J1_PROGRAM_ENDING', dueBy: f.j1.endsOn, message: `${f.name}'s J-1 program ends on ${fmtDay(f.j1.endsOn, { year: true })}. They may not work after it, grace period or not.`, fixLink: fixLinkFor('j1', f.associateId) });
  } else j1 = { state: 'ends', date: f.j1.endsOn };

  const bg = screeningEval(f.background, day, 'BACKGROUND_CHECK', f);
  const dt = screeningEval(f.drugTest, day, 'DRUG_TEST', f);
  for (const s of [bg, dt]) {
    if (s.warning) warnings.push(s.warning);
    if (s.upcoming) upcoming.push(s.upcoming);
  }

  const standing: ClearedStanding = blockers.length ? 'NOT_CLEARED' : warnings.length ? 'NEEDS_ATTENTION' : 'CLEARED';
  return {
    associateId: f.associateId,
    cleared: blockers.length === 0,
    standing,
    blockers,
    warnings,
    upcoming,
    cells: { i9, everify, workAuth, j1, background: bg.cell, drugTest: dt.cell },
  };
}

/**
 * The brief's entry point: per person, cleared on the company's day of `at`,
 * with the blockers, the warnings and the deadlines ahead.
 */
export async function workAuthorizationFor(db: Db, associateIds: string[], at: Date, tenantId?: string): Promise<Map<string, Clearance>> {
  const out = new Map<string, Clearance>();
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return out;
  const tenant = tenantId ?? (await db.associate.findFirst({ where: { id: ids[0] }, select: { tenantId: true } }))?.tenantId;
  if (!tenant) return out;
  const facts = await clearanceFactsFor(db, tenant, ids);
  const day = orgDateKey(at);
  const today = orgDateKey(new Date());
  for (const [id, f] of facts) out.set(id, evaluateClearance(f, day, today));
  return out;
}

/** Days from `from` to `to` (both YYYY-MM-DD); 0 on the same day. */
export function daysBetweenKeys(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
