/**
 * The org's unpaid-break rule, in ONE place so web and API totals can
 * never disagree: any shift LONGER than 6 wall-clock hours includes a
 * 1-hour unpaid meal break. A 10 PM–7 AM overnight spans 9 hours but
 * pays (and bills, and counts toward the 40h OT line) as 8.
 *
 * Per-shift LENGTH displays and calendar geometry stay wall-clock —
 * this helper is for aggregations: weekly hours, OT flags, day totals,
 * labor cost/revenue projections, and earnings estimates.
 */

/** Hardest ceiling on a single shift's wall-clock span. No retail shift
 *  runs longer than 16 hours — anything above it is a data error (the
 *  classic corruption: an end time rolled one day too far, turning a
 *  4 PM–11 PM shift into 31 hours and wrecking every weekly total). */
export const MAX_SHIFT_WALL_MIN = 16 * 60;

export const UNPAID_BREAK_MIN = 60;
/** Break applies to shifts strictly longer than this (6h). */
export const UNPAID_BREAK_THRESHOLD_MIN = 6 * 60;

export function paidMinutesForRange(
  startsAt: string | Date,
  endsAt: string | Date,
): number {
  const start = startsAt instanceof Date ? startsAt.getTime() : new Date(startsAt).getTime();
  const end = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
  const raw = Math.max(0, Math.round((end - start) / 60_000));
  return raw > UNPAID_BREAK_THRESHOLD_MIN ? raw - UNPAID_BREAK_MIN : raw;
}
