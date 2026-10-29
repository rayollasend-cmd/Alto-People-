/**
 * THE METRIC DICTIONARY (deep-audit fix wave, 2026-10-29).
 *
 * One name and one definition per measure, read by every screen that shows
 * it. The audit found the same word carrying different numbers by screen —
 * "gross margin" 20.8% / 30% / 28%, "days to collect" 23 / 7, "working now"
 * 44 / 36, "hours this week" 552 / 537 / 385 — because each screen computed
 * its own figure on its own basis under the same label.
 *
 * The rule:
 *   - A label here names exactly one measure. A screen that shows a
 *     different basis uses that basis's own entry (and its own label), never
 *     the same words: "Margin after wages" is not "Gross margin", "Average
 *     days to pay" is not "Days to collect", "Placed" is not "Working".
 *   - `computedBy` is the API function that owns the number. A new screen
 *     reads that function (or the route that serves it); it never re-derives
 *     the figure.
 *   - `definition` is the sentence a card's hint, a tooltip or a board-pack
 *     appendix prints. Change it here and every surface changes with it.
 *
 * Pure data and small pure helpers only (no zod, no I/O): the web's main
 * chunk may import it.
 */

export type MetricUnit = 'percent' | 'dollars' | 'days' | 'hours' | 'people' | 'shifts';

/**
 * Where a number comes from, printed as a small badge beside it:
 *   estimate    priced at the standard rates (env defaults) — "est."
 *   contract    priced at each client's contract bill rate
 *   statements  finalized client statements (invoice-grade)
 *   books       the company general ledger
 *   live        counted from the live records (people, shifts, punches)
 *   scheduled   a plan: shifts on the schedule, before anyone works them
 */
export type MetricBasis = 'estimate' | 'contract' | 'statements' | 'books' | 'live' | 'scheduled';

export interface MetricDefinition {
  id: string;
  /** The one name every screen uses for this measure. */
  label: string;
  /** One sentence: what is counted, over what, on what basis. */
  definition: string;
  unit: MetricUnit;
  basis: MetricBasis;
  /** The API function (file → function) that computes it. */
  computedBy: string;
  /** Measures people confuse with this one: different numbers, different names. */
  notSameAs?: readonly string[];
}

/* ------------------------------------------------------------- constants */

/** Days sales outstanding reads the trailing 90 days' billing. */
export const DAYS_TO_COLLECT_WINDOW_DAYS = 90;
// Overtime risk's line (36) and the weekly overtime line (40) live with the
// attendance contract: OVERTIME_RISK_HOURS / isOvertimeRisk and
// ATTENDANCE_OVERTIME_THRESHOLD_HOURS in ./attendanceInsights.ts.
/** The workforce page's turnover card reads the trailing 90 days. */
export const TURNOVER_TRAILING_DAYS = 90;

/* -------------------------------------------------------------- measures */

export const METRICS = {
  /* ------------------------------------------------------------- money */
  revenue: {
    id: 'revenue',
    label: 'Revenue',
    definition:
      'Approved and completed paid hours priced at the standard bill rate, overtime at the pay multipliers — an estimate; finalized client statements are the invoice-grade figure.',
    unit: 'dollars',
    basis: 'estimate',
    computedBy: 'apps/api/src/lib/execFinance.ts → laborBetween().billed',
    notSameAs: ['billedAtContractRates', 'billedStatements'],
  },
  billedAtContractRates: {
    id: 'billedAtContractRates',
    label: 'Billed at contract rates',
    definition:
      "Approved hours priced at each client's contract bill rate, each person's week rounded the way the client's timesheet system bills it — what will be invoiced before the statement is final.",
    unit: 'dollars',
    basis: 'contract',
    computedBy: 'apps/api/src/lib/financeCockpit.ts → marginTrend().weeks[].revenue',
    notSameAs: ['revenue', 'billedStatements'],
  },
  billedStatements: {
    id: 'billedStatements',
    label: 'Billed on statements',
    definition: 'The totals of finalized client statements whose period ends in the range.',
    unit: 'dollars',
    basis: 'statements',
    computedBy: 'apps/api/src/lib/clientMetrics.ts → clientMoneyMetrics().billedInRange',
    notSameAs: ['revenue', 'billedAtContractRates'],
  },
  grossMargin: {
    id: 'grossMargin',
    label: 'Gross margin',
    definition: 'Revenue less pay, employer burden and overhead, at the standard rates.',
    unit: 'dollars',
    basis: 'estimate',
    computedBy: 'apps/api/src/lib/execFinance.ts → laborBetween().margin',
    notSameAs: ['marginAfterWages', 'scheduledMarginAfterWages', 'statementMargin'],
  },
  grossMarginPct: {
    id: 'grossMarginPct',
    label: 'Gross margin %',
    definition: 'Revenue less pay, employer burden and overhead, as a share of revenue, at the standard rates.',
    unit: 'percent',
    basis: 'estimate',
    computedBy: 'apps/api/src/lib/execFinance.ts → laborBetween() (margin ÷ billed)',
    notSameAs: ['marginAfterWages', 'scheduledMarginAfterWages', 'statementMargin'],
  },
  marginAfterWages: {
    id: 'marginAfterWages',
    label: 'Margin after wages',
    definition:
      'Billed at contract rates less the wages payroll pays for the same approved hours — before employer burden and overhead, so it reads higher than gross margin.',
    unit: 'percent',
    basis: 'contract',
    computedBy: 'apps/api/src/lib/financeCockpit.ts → marginTrend().weeks[].marginPct',
    notSameAs: ['grossMarginPct', 'scheduledMarginAfterWages'],
  },
  scheduledMarginAfterWages: {
    id: 'scheduledMarginAfterWages',
    label: 'Scheduled margin after wages',
    definition:
      "Scheduled shift hours at the contract bill rate less their scheduled pay — a plan, before anyone works it, with no employer burden or overhead.",
    unit: 'dollars',
    basis: 'scheduled',
    computedBy: 'apps/api/src/routes/scheduling.ts → GET /scheduling/labor-costs (scheduledRevenue − scheduledCost)',
    notSameAs: ['grossMargin', 'marginAfterWages'],
  },
  statementMargin: {
    id: 'statementMargin',
    label: 'Margin on statements',
    definition: 'Hours billed on finalized statements against the wages and employer taxes paid for those same hours.',
    unit: 'percent',
    basis: 'statements',
    computedBy: 'apps/api/src/lib/clientMetrics.ts → marginByClient()',
    notSameAs: ['grossMarginPct', 'marginAfterWages'],
  },
  daysToCollect: {
    id: 'daysToCollect',
    label: 'Days to collect',
    definition:
      "Days sales outstanding: what clients owe on finalized statements, divided by the last 90 days' average daily billing.",
    unit: 'days',
    basis: 'statements',
    computedBy: 'apps/api/src/lib/execFinance.ts → dsoAsOf()',
    notSameAs: ['averageDaysToPay'],
  },
  averageDaysToPay: {
    id: 'averageDaysToPay',
    label: 'Average days to pay',
    definition: 'For the statements clients paid in the window, the average number of days from finalized to paid.',
    unit: 'days',
    basis: 'statements',
    computedBy: 'apps/api/src/routes/books/receivables.ts → GET /books/receivables/dso',
    notSameAs: ['daysToCollect'],
  },

  /* ------------------------------------------------------------ people */
  working: {
    id: 'working',
    label: 'Working',
    definition:
      "Placed at a site, and worked there in the company's active window (14 days unless changed) or has a shift ahead — the one definition of active.",
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/lib/activeDefinition.ts → activeHeadcount() / activeAssociateIds()',
    notSameAs: ['placed', 'onTheBooks', 'onTheFloor'],
  },
  onTheBooks: {
    id: 'onTheBooks',
    label: 'On the books',
    definition: 'Hired and not separated: working, no recent shifts, not placed and paused together.',
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/lib/peopleStatus.ts → workStatusCounts().onTheBooks',
    notSameAs: ['working', 'placed'],
  },
  placed: {
    id: 'placed',
    label: 'Placed',
    definition:
      'Employed and placed at a site — an open assignment, or an approved application with no open assignment anywhere — whether or not they have worked lately.',
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/lib/activeDefinition.ts → placements()',
    notSameAs: ['working', 'onTheBooks'],
  },
  onTheFloor: {
    id: 'onTheFloor',
    label: 'On the floor now',
    definition: 'People with an open punch right now.',
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/routes/analytics.ts → GET /analytics/dashboard associatesClockedIn',
    notSameAs: ['working'],
  },
  turnover: {
    id: 'turnover',
    label: 'Turnover',
    definition: 'Separations in the selected period over the average number on the books across it, annualized.',
    unit: 'percent',
    basis: 'live',
    computedBy: 'apps/api/src/lib/peopleStatus.ts → turnoverBetween(period)',
    notSameAs: ['turnover90d'],
  },
  turnover90d: {
    id: 'turnover90d',
    label: 'Turnover, last 90 days',
    definition: 'Separations in the trailing 90 days over the average number on the books across them, annualized.',
    unit: 'percent',
    basis: 'live',
    computedBy: 'apps/api/src/lib/peopleStatus.ts → turnoverBetween(now − 90 days, now)',
    notSameAs: ['turnover'],
  },

  /* ----------------------------------------------------- shifts, hours */
  openShifts: {
    id: 'openShifts',
    label: 'Open shifts',
    definition: 'Published shifts with no one assigned that have not ended yet; assigned, draft and cancelled shifts are not counted.',
    unit: 'shifts',
    basis: 'live',
    computedBy: "apps/api/src/routes/analytics.ts → GET /analytics/dashboard openShiftsNext30d (status 'OPEN')",
  },
  fillRate: {
    id: 'fillRate',
    label: 'Fill rate',
    definition: 'Published shifts starting in the period that have someone assigned, as a share of all published shifts.',
    unit: 'percent',
    basis: 'live',
    computedBy: 'apps/api/src/lib/execFinance.ts → fillCounts()',
  },
  paidHours: {
    id: 'paidHours',
    label: 'Paid hours',
    definition:
      'Approved and completed punches that are closed, every break out, each person’s week split by the labor-rules engine exactly as pay splits it.',
    unit: 'hours',
    basis: 'live',
    computedBy: 'apps/api/src/lib/paidHours.ts → loadPaidHours() / paidHoursByWeek()',
    notSameAs: ['scheduledHours'],
  },
  hoursThisWeek: {
    id: 'hoursThisWeek',
    label: 'Hours this week',
    definition: 'Paid hours clocked in since the company week began (Saturday, company time zone), through now.',
    unit: 'hours',
    basis: 'live',
    computedBy: 'apps/api/src/routes/analytics.ts → GET /analytics/dashboard week.paidHours (lib/paidHours paidHoursByWeek)',
    notSameAs: ['scheduledHours'],
  },
  scheduledHours: {
    id: 'scheduledHours',
    label: 'Scheduled hours',
    definition:
      'Paid hours on the non-cancelled shifts starting in the window — each shift start to end, less the one-hour unpaid meal on shifts over six hours.',
    unit: 'hours',
    basis: 'scheduled',
    computedBy: 'packages/shared/src/schedule.ts → paidMinutesForRange() per shift; GET /analytics/dashboard week.scheduledHours',
    notSameAs: ['paidHours', 'hoursThisWeek'],
  },
  overtimeShare: {
    id: 'overtimeShare',
    label: 'Overtime',
    definition: 'Overtime and double-time hours as a share of paid hours, split the way payroll splits them.',
    unit: 'percent',
    basis: 'live',
    computedBy: 'apps/api/src/lib/execFinance.ts → laborBetween() (otHours ÷ hours)',
  },
  overtimeRisk: {
    id: 'overtimeRisk',
    label: 'Overtime risk',
    definition:
      'People whose hours worked this company week plus their shifts still ahead reach 36 — the four hours before the 40-hour line, while a schedule change can still keep them under it.',
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/lib/timeExceptions.ts → timeExceptions().overtimeRisk; the line is OVERTIME_RISK_HOURS / isOvertimeRisk() (packages/shared attendanceInsights)',
    notSameAs: ['projectedOvertime'],
  },
  projectedOvertime: {
    id: 'projectedOvertime',
    label: 'Heading into overtime',
    definition:
      'People on the floor whose hours this week, with the rest of their schedule, already include overtime as pay would split it.',
    unit: 'people',
    basis: 'live',
    computedBy: 'apps/api/src/routes/scheduling.ts → GET /scheduling/floor-now projectedOtHeads',
    notSameAs: ['overtimeRisk'],
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricId = keyof typeof METRICS;

/** The dictionary entry for an id. */
export function metric(id: MetricId): MetricDefinition {
  return METRICS[id];
}

/* ------------------------------------------------------------- the math */

/** Margin as a share of what was billed, in percent; null when nothing was billed. */
export function marginPctOf(billed: number, cost: number): number | null {
  if (!(billed > 0)) return null;
  return ((billed - cost) / billed) * 100;
}

/** Days to collect (DSO): open receivables over the window's average daily billing. Null when nothing was billed. */
export function daysToCollectOf(openReceivables: number, billedInWindow: number, windowDays = DAYS_TO_COLLECT_WINDOW_DAYS): number | null {
  if (!(billedInWindow > 0) || !(windowDays > 0)) return null;
  return openReceivables / (billedInWindow / windowDays);
}
