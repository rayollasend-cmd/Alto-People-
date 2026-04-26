/**
 * Per-state labor policy table (Phase 23).
 *
 * Real Rippling-style differentiator: the time/scheduling/payroll engines
 * read this table to enforce state-specific OT thresholds, meal/rest break
 * rules, sick-leave accrual, and minimum wage. Numbers are anchored to
 * **calendar 2024** state law summaries (DOL state-by-state pages, NCSL
 * roundups). Bumping years = editing this one file. NOT a substitute for
 * specialized employment counsel — this is a defensible default that beats
 * zero.
 *
 * Coverage today: the 14 states with the most hospitality / J-1 placement
 * volume per ASN/ISN program data. Everything else falls back to FEDERAL.
 */

export interface StateLaborPolicy {
  /** Two-letter USPS code, uppercase. "FEDERAL" is the fallback. */
  state: string;
  /** Cents/hour. Federal floor is 725 ($7.25); states routinely exceed. */
  minimumWageCents: number;
  /**
   * Hours/day before daily-OT kicks in. CA uniquely has daily OT at 8h
   * (1.5x) and 12h (2x). For most states this is null (no daily OT, just
   * weekly).
   */
  dailyOTHoursThreshold: number | null;
  /** Hours/week before weekly OT kicks in. Federal floor is 40. */
  weeklyOTHoursThreshold: number;
  /**
   * Minimum minutes for a "meal" break to count as legally compliant. CA
   * mandates an unpaid 30-minute meal after 5 hours. Most states defer to
   * federal (which has no minimum).
   */
  mealBreakMinMinutes: number;
  /**
   * Worked-hour threshold above which a meal break is required. NULL means
   * the state doesn't legally require any meal break.
   */
  mealBreakRequiredAfterHours: number | null;
  /**
   * Paid 10-min rest break required per N hours worked. CA: 10 min per 4h.
   */
  restBreakMinMinutes: number;
  restBreakRequiredPerHours: number | null;
  /**
   * Paid sick leave accrual rate (hours of sick leave earned per hour
   * worked). CA: 1 hour per 30 worked = 0.0333. NY: 1 per 30 = same. WA:
   * 1 per 40 = 0.025.
   */
  paidSickLeaveAccrualPerHour: number;
  /** Whether the state has a "predictive scheduling" / fair workweek law. */
  hasPredictiveSchedulingLaw: boolean;
  /** Maximum minutes of split-shift premium that can be earned per shift. CA only. */
  splitShiftPremiumApplies: boolean;
}

const FEDERAL: StateLaborPolicy = {
  state: 'FEDERAL',
  minimumWageCents: 725,
  dailyOTHoursThreshold: null,
  weeklyOTHoursThreshold: 40,
  mealBreakMinMinutes: 0,
  mealBreakRequiredAfterHours: null,
  restBreakMinMinutes: 0,
  restBreakRequiredPerHours: null,
  paidSickLeaveAccrualPerHour: 0,
  hasPredictiveSchedulingLaw: false,
  splitShiftPremiumApplies: false,
};

const TABLE: Record<string, StateLaborPolicy> = {
  CA: {
    state: 'CA',
    minimumWageCents: 1600, // $16.00/hr 2024
    dailyOTHoursThreshold: 8,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 5,
    restBreakMinMinutes: 10,
    restBreakRequiredPerHours: 4,
    paidSickLeaveAccrualPerHour: 1 / 30, // SB 616: min 1hr per 30hrs worked
    hasPredictiveSchedulingLaw: false, // SF + Emeryville have it locally
    splitShiftPremiumApplies: true,
  },
  NY: {
    state: 'NY',
    minimumWageCents: 1500, // NYC/Long Island/Westchester $16; rest $15. Use the floor.
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 6,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: true, // NYC fast food
    splitShiftPremiumApplies: false,
  },
  IL: {
    state: 'IL',
    minimumWageCents: 1400,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 20,
    mealBreakRequiredAfterHours: 7.5,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 1 / 40, // Paid Leave for All Workers Act 2024
    hasPredictiveSchedulingLaw: true, // Chicago Fair Workweek
    splitShiftPremiumApplies: false,
  },
  MA: {
    state: 'MA',
    minimumWageCents: 1500,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 6,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  NJ: {
    state: 'NJ',
    minimumWageCents: 1513,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  PA: {
    state: 'PA',
    minimumWageCents: 725, // No state law above federal
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 5, // Only for minors; we apply more conservatively
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: true, // Philadelphia
    splitShiftPremiumApplies: false,
  },
  WA: {
    state: 'WA',
    minimumWageCents: 1628,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 5,
    restBreakMinMinutes: 10,
    restBreakRequiredPerHours: 4,
    paidSickLeaveAccrualPerHour: 1 / 40,
    hasPredictiveSchedulingLaw: true, // Seattle
    splitShiftPremiumApplies: false,
  },
  CO: {
    state: 'CO',
    minimumWageCents: 1442,
    dailyOTHoursThreshold: 12,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 5,
    restBreakMinMinutes: 10,
    restBreakRequiredPerHours: 4,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  AZ: {
    state: 'AZ',
    minimumWageCents: 1435,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  GA: {
    state: 'GA',
    minimumWageCents: 725,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  NC: {
    state: 'NC',
    minimumWageCents: 725,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  VA: {
    state: 'VA',
    minimumWageCents: 1200,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  FL: {
    state: 'FL',
    minimumWageCents: 1300,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  TX: {
    state: 'TX',
    minimumWageCents: 725,
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 0,
    mealBreakRequiredAfterHours: null,
    restBreakMinMinutes: 0,
    restBreakRequiredPerHours: null,
    paidSickLeaveAccrualPerHour: 0,
    hasPredictiveSchedulingLaw: false,
    splitShiftPremiumApplies: false,
  },
  OR: {
    state: 'OR',
    minimumWageCents: 1470, // Standard rate; metro is higher, non-urban lower
    dailyOTHoursThreshold: null,
    weeklyOTHoursThreshold: 40,
    mealBreakMinMinutes: 30,
    mealBreakRequiredAfterHours: 6,
    restBreakMinMinutes: 10,
    restBreakRequiredPerHours: 4,
    paidSickLeaveAccrualPerHour: 1 / 30,
    hasPredictiveSchedulingLaw: true, // Oregon Fair Work Week (large food/retail)
    splitShiftPremiumApplies: false,
  },
};

export function getLaborPolicy(state: string | null | undefined): StateLaborPolicy {
  if (!state) return FEDERAL;
  const code = state.toUpperCase().trim();
  return TABLE[code] ?? FEDERAL;
}

/** All keyed states (excludes FEDERAL fallback). */
export function listLaborPolicyStates(): string[] {
  return Object.keys(TABLE).sort();
}
