/**
 * One-tap reasons for routine decisions (ease-of-use sweep, 2026-10-22).
 * A typed reason belongs where the law needs the words; everywhere else
 * the common cases are a tap, and the field stays editable for the rest.
 * Shared so the same decision reads the same on every desk that makes it.
 */

/** Approving time off that takes the balance negative (most people have no balance at all). */
export const NEGATIVE_BALANCE_PRESETS = ['Unpaid day', 'Advance on accrual', 'Agreed with Ops', 'Covered by a swap'] as const;

/** Rejecting a candidate. */
export const CANDIDATE_REJECT_PRESETS = ['Position filled', 'Not a fit for the role', 'Did not pass the interview', 'No response', 'Failed background check'] as const;

/** A candidate who withdrew. */
export const CANDIDATE_WITHDRAW_PRESETS = ['Accepted another offer', 'No longer available', 'Declined the offer', 'Moved away'] as const;
