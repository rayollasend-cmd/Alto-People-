import { getLaborPolicy } from './stateLaborPolicy.js';

/**
 * Phase 25 — predictive scheduling enforcement.
 *
 * Fair-workweek (a.k.a. predictive scheduling) laws — NYC, Chicago,
 * Seattle, Oregon, Philadelphia, etc. — require employers to give workers
 * 14 days' advance notice of their schedule. Publishing a shift inside
 * that window without paying the worker a "premium" is illegal, but the
 * law universally allows the employer to do it if there's a documented
 * legitimate reason (mutual agreement, immediate need to cover a sick
 * call-out, etc.). This module is the wire-level enforcement: every shift
 * publish in a covered state goes through `evaluateShiftNotice`, and the
 * scheduling routes refuse to publish without `lateNoticeReason` when the
 * window is violated.
 *
 * State coverage is driven by `stateLaborPolicy.hasPredictiveSchedulingLaw`,
 * so adding a new fair-workweek state is one boolean flip — no code edits
 * here. The 14-day window is the floor across every covered jurisdiction
 * we currently track; if a state ever increases it (rare), we'll wire a
 * per-state `predictiveSchedulingNoticeHours` field then.
 */

/** 14 days expressed in hours — the floor across every covered state. */
export const PREDICTIVE_NOTICE_WINDOW_HOURS = 14 * 24;

const HOUR_MS = 60 * 60 * 1000;

export interface NoticeEvaluationInput {
  /**
   * Two-letter USPS state code of the work site (Client.state). Null →
   * federal default → never requires a late-notice reason.
   */
  state: string | null;
  /** When the shift starts (Shift.startsAt). */
  startsAt: Date;
  /**
   * The instant the publish would happen. Tests pin this to a fixed
   * Date; routes pass `new Date()`. We don't read the wall clock here so
   * the function stays pure and deterministic.
   */
  publishAt: Date;
}

export interface NoticeEvaluation {
  /** True iff the work-site state has a predictive-scheduling law. */
  stateRequiresNotice: boolean;
  /** The normalized state code we used (or null). */
  state: string | null;
  /** publishAt → startsAt distance, in hours (negative if startsAt past). */
  hoursToShift: number;
  /** True iff hoursToShift is strictly less than the notice window. */
  withinNoticeWindow: boolean;
  /**
   * True iff the publish would be illegal without a documented reason.
   * Combines state coverage AND the window — convenient for routes.
   */
  requiresReason: boolean;
}

export function evaluateShiftNotice(input: NoticeEvaluationInput): NoticeEvaluation {
  const policy = getLaborPolicy(input.state);
  const stateRequiresNotice = policy.hasPredictiveSchedulingLaw;
  const hoursToShift =
    (input.startsAt.getTime() - input.publishAt.getTime()) / HOUR_MS;
  const withinNoticeWindow = hoursToShift < PREDICTIVE_NOTICE_WINDOW_HOURS;
  return {
    stateRequiresNotice,
    state: input.state ? input.state.toUpperCase().trim() : null,
    hoursToShift,
    withinNoticeWindow,
    requiresReason: stateRequiresNotice && withinNoticeWindow,
  };
}

/**
 * True iff the given before/after status transition counts as "publishing"
 * the shift — i.e. it becomes visible to workers and the predictive-
 * scheduling clock starts. We treat OPEN and ASSIGNED as published states;
 * DRAFT is the HR scratch pad. Re-publishing an already-published shift
 * (OPEN → ASSIGNED) is NOT a publish — the notice was already given.
 */
export function isPublishingTransition(
  before: 'DRAFT' | 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED' | undefined,
  after: 'DRAFT' | 'OPEN' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED'
): boolean {
  const wasDraft = !before || before === 'DRAFT';
  const becomesPublished = after === 'OPEN' || after === 'ASSIGNED';
  return wasDraft && becomesPublished;
}
