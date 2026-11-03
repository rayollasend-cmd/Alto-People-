import { z } from 'zod';
import { WorkStatusSchema } from './peopleStatus.js';
import { ComplianceWorkforceSchema, WorkforceCountsSchema } from './complianceWorkforce.js';

/**
 * CLEARED TO WORK (owner, 2026-11-03).
 *
 * One answer per person to "may this person work on that day?", from the
 * one rule in apps/api/src/lib/workAuthorization.ts. Three things take the
 * legal right to work away, and each is a HARD block on scheduling (assign,
 * bulk create, pickup and swap approvals, the open-shift list, the
 * auto-fill agent):
 *
 *   WORK_AUTH_ENDED                 the I-9's work authorization ended
 *                                   (Section 1 "alien authorized to work",
 *                                   its expiry date before the day)
 *   J1_PROGRAM_ENDED                the J-1 program ended before the day —
 *                                   the 30-day grace period lets a
 *                                   participant stay in the country, not work
 *   EVERIFY_FINAL_NONCONFIRMATION   E-Verify returned a final nonconfirmation
 *
 * Only someone who holds manage:compliance may assign past a block, with a
 * written reason; the override is audited (work_authorization.override).
 *
 * Everything else is a warning (Needs attention) or a deadline ahead: the
 * person may work, and HR has something to do.
 */

export const WORK_BLOCKER_KINDS = ['WORK_AUTH_ENDED', 'J1_PROGRAM_ENDED', 'EVERIFY_FINAL_NONCONFIRMATION'] as const;
export type WorkBlockerKind = (typeof WORK_BLOCKER_KINDS)[number];

/** Needs attention: the person may work; something is late or about to end. */
export const WORK_WARNING_KINDS = [
  'WORK_AUTH_ENDING',
  'J1_PROGRAM_ENDING',
  'EVERIFY_TNC',
  'EVERIFY_RESUBMIT',
  'SECTION2_LATE',
  'EVERIFY_LATE',
  'BACKGROUND_REQUIRED',
  'DRUG_TEST_REQUIRED',
  // A work-authorization end date with no Section 1 citizenship status: HR
  // checks the paper I-9 (owner, 2026-11-03). Never a block.
  'WORK_AUTH_NEEDS_REVIEW',
] as const;
export type WorkWarningKind = (typeof WORK_WARNING_KINDS)[number];

/** A deadline ahead that isn't late yet: the exceptions queue lists it after the warnings. */
export const WORK_UPCOMING_KINDS = ['SECTION2_DUE', 'EVERIFY_DUE', 'BACKGROUND_DUE', 'DRUG_TEST_DUE'] as const;
export type WorkUpcomingKind = (typeof WORK_UPCOMING_KINDS)[number];

/** How many days ahead an ending authorization or program, or a check going stale, is flagged. */
export const WORK_AUTH_WARNING_DAYS = 30;

/** The reason an "Assign anyway" needs, at least this long (owner, 2026-11-03). */
export const WORK_AUTH_OVERRIDE_MIN_REASON = 10;

const Day = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();

export const WorkBlockerSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum(WORK_BLOCKER_KINDS),
    /** The last day they were cleared (the expiry or program end); null for a nonconfirmation. */
    endsOn: Day.nullable(),
    /** The first day they may not work; null = any day. */
    since: Day.nullable(),
    /** In plain words, naming the person and what to do. */
    message: z.string(),
    /** The compliance tab that fixes it, opened on the person. */
    fixLink: z.string(),
  }))();
export type WorkBlocker = z.infer<typeof WorkBlockerSchema>;

export const WorkWarningSchema = /* @__PURE__ */ (() =>
  z.object({
    kind: z.enum([...WORK_WARNING_KINDS, ...WORK_UPCOMING_KINDS]),
    /** The deadline (or the end date) the warning is about; null when there is none. */
    dueBy: Day.nullable(),
    message: z.string(),
    fixLink: z.string(),
  }))();
export type WorkWarning = z.infer<typeof WorkWarningSchema>;

/** Where a person stands: Cleared · Needs attention · Not cleared. */
export const CLEARED_STANDINGS = ['CLEARED', 'NEEDS_ATTENTION', 'NOT_CLEARED'] as const;
export type ClearedStanding = (typeof CLEARED_STANDINGS)[number];
export const CLEARED_STANDING_LABELS: Readonly<Record<ClearedStanding, string>> = {
  CLEARED: 'Cleared',
  NEEDS_ATTENTION: 'Needs attention',
  NOT_CLEARED: 'Not cleared',
};

/**
 * One cell of the Cleared to work table. `date` reads with the state:
 * done → when; due / late → due by; ends / ending / ended → the end date;
 * in_progress → started on; blocked / issue → when known.
 */
export const CLEARED_CELL_STATES = ['done', 'due', 'late', 'missing', 'not_required', 'ends', 'ending', 'ended', 'in_progress', 'issue', 'blocked'] as const;
export type ClearedCellState = (typeof CLEARED_CELL_STATES)[number];
export const ClearedCellSchema = /* @__PURE__ */ (() =>
  z.object({
    state: z.enum(CLEARED_CELL_STATES),
    date: Day.nullable(),
  }))();
export type ClearedCell = z.infer<typeof ClearedCellSchema>;

export const ClearedShiftSchema = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    startsAt: z.string(),
    endsAt: z.string(),
    timezone: z.string(),
    position: z.string(),
    place: z.string().nullable(),
  }))();
export type ClearedShift = z.infer<typeof ClearedShiftSchema>;

export const ClearedRowSchema = /* @__PURE__ */ (() =>
  z.object({
    associateId: z.string().uuid(),
    associateName: z.string(),
    associateEmail: z.string(),
    associatePhotoUrl: z.string().nullable().optional(),
    workStatus: WorkStatusSchema.nullable(),
    standing: z.enum(CLEARED_STANDINGS),
    i9: ClearedCellSchema,
    everify: ClearedCellSchema,
    workAuth: ClearedCellSchema,
    j1: ClearedCellSchema,
    background: ClearedCellSchema,
    drugTest: ClearedCellSchema,
    blockers: z.array(WorkBlockerSchema),
    warnings: z.array(WorkWarningSchema),
    upcoming: z.array(WorkWarningSchema),
    nextShift: ClearedShiftSchema.nullable(),
    /** Assigned shifts ahead that fall on or after a blocker's first day. */
    scheduledAfterBlock: z.array(ClearedShiftSchema),
  }))();
export type ClearedRow = z.infer<typeof ClearedRowSchema>;

/** The exceptions queue: blockers and shifts booked past them first, then the rest by deadline. */
export const CLEARED_EXCEPTION_SEVERITIES = ['blocker', 'scheduled', 'warning', 'upcoming'] as const;
export type ClearedExceptionSeverity = (typeof CLEARED_EXCEPTION_SEVERITIES)[number];
export const ClearedExceptionSchema = /* @__PURE__ */ (() =>
  z.object({
    associateId: z.string().uuid(),
    associateName: z.string(),
    severity: z.enum(CLEARED_EXCEPTION_SEVERITIES),
    kind: z.string(),
    /** The deadline or the date it turned (YYYY-MM-DD); null when there is none. */
    date: Day.nullable(),
    message: z.string(),
    fixLink: z.string(),
    shift: ClearedShiftSchema.nullable(),
  }))();
export type ClearedException = z.infer<typeof ClearedExceptionSchema>;

export const ClearedOverrideSchema = /* @__PURE__ */ (() =>
  z.object({
    id: z.string().uuid(),
    at: z.string(),
    actorName: z.string().nullable(),
    associateId: z.string().nullable(),
    associateName: z.string().nullable(),
    shiftId: z.string().nullable(),
    blockerKind: z.string().nullable(),
    reason: z.string(),
  }))();
export type ClearedOverride = z.infer<typeof ClearedOverrideSchema>;

export const ClearedListResponseSchema = /* @__PURE__ */ (() =>
  z.object({
    /** The company's today (YYYY-MM-DD): what "cleared" is measured on. */
    asOf: Day,
    rows: z.array(ClearedRowSchema),
    exceptions: z.array(ClearedExceptionSchema),
    overrides: z.array(ClearedOverrideSchema),
    workforce: ComplianceWorkforceSchema,
    workforceCounts: WorkforceCountsSchema,
  }))();
export type ClearedListResponse = z.infer<typeof ClearedListResponseSchema>;

/** The body an "Assign anyway" adds to an assign (POST /scheduling/shifts/:id/assign). */
export const WorkAuthorizationOverrideSchema = /* @__PURE__ */ (() =>
  z.object({
    reason: z.string().trim().min(WORK_AUTH_OVERRIDE_MIN_REASON).max(500),
  }))();
export type WorkAuthorizationOverride = z.infer<typeof WorkAuthorizationOverrideSchema>;

/** What a `not_authorized_to_work` 409 carries in `details`. */
export interface NotAuthorizedToWorkDetails {
  associateId: string;
  blockers: WorkBlocker[];
  /** True when the caller holds manage:compliance and may assign anyway with a reason. */
  canOverride: boolean;
}
