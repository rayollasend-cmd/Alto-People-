/**
 * The executive portal's contract (2026-10-27): the shapes the /executive
 * API answers and the chairman's pages read. Types, plus the two key lists —
 * nothing here has a side effect.
 *
 * One page-wide frame: a PERIOD (the last complete week, or the month,
 * quarter or year to date) read against a COMPARISON (the plan, the prior
 * period of the same length, or the same span last year). Every figure says
 * what it is (`basis`), how it is defined (`definition`) and where it opens
 * (`href`), so a board number can always be traced.
 */

export type ExecPeriodKey = 'week' | 'month' | 'quarter' | 'year';
export type ExecCompareKey = 'plan' | 'prior' | 'year';

export const EXEC_PERIOD_KEYS: readonly ExecPeriodKey[] = ['week', 'month', 'quarter', 'year'];
export const EXEC_COMPARE_KEYS: readonly ExecCompareKey[] = ['plan', 'prior', 'year'];

export interface ExecPeriod {
  key: ExecPeriodKey;
  /** "Week of Oct 17", "October to date", "Q4 to date", "2026 to date". */
  label: string;
  /** First and last day, inclusive (YYYY-MM-DD, company calendar). */
  start: string;
  end: string;
  /** True for the last complete week; false for a span still running. */
  complete: boolean;
  /** Share of the calendar period that has elapsed, 0–100 (100 when complete). */
  elapsedPct: number;
  /** When the figures were computed (ISO instant). */
  asOf: string;
}

export interface ExecComparison {
  key: ExecCompareKey;
  /** "vs plan", "vs the week of Oct 10", "vs the same span of 2025". */
  label: string;
  start: string | null;
  end: string | null;
  /** False when there is nothing to compare against (no plan set, no history). */
  available: boolean;
  /** Why it is unavailable, in a sentence ("No plan is set for Q4."). */
  reason: string | null;
}

export type ExecUnit = 'money' | 'pct' | 'count' | 'days';
/** good = on or ahead of plan/threshold, watch = within 5% short, bad = off it, none = nothing to judge by. */
export type ExecStatus = 'good' | 'watch' | 'bad' | 'none';
/** estimate = at standard rates; books = the ledger; statements = finalized client statements; live = right now. */
export type ExecBasis = 'estimate' | 'books' | 'statements' | 'live';

export type ExecKpiId =
  | 'revenue'
  | 'grossMargin'
  | 'marginPct'
  | 'laborCostPct'
  | 'workforce'
  | 'fillRate'
  | 'turnover'
  | 'dso'
  | 'cash'
  | 'overtimePct'
  | 'hires';

export interface ExecTrendPoint {
  /** The week's first day (YYYY-MM-DD). */
  start: string;
  value: number | null;
}

export interface ExecKpi {
  id: ExecKpiId;
  label: string;
  unit: ExecUnit;
  /** Unrounded; the page rounds for display (money → $22.6K on the scorecard). */
  value: number | null;
  /** One short line under the value: "$4.7K margin", "of 44 on the books". */
  sub: string | null;
  /** The comparison's value for the same measure, when there is one. */
  compare: number | null;
  /** value − compare, in the KPI's unit (percentage points for pct). */
  delta: number | null;
  /** Relative change (0.042 = +4.2%); null when compare is 0 or missing. */
  deltaPct: number | null;
  betterWhen: 'up' | 'down';
  /** The plan for this period — prorated by elapsed days for cumulative measures. */
  target: number | null;
  /** "Q4 plan $1.2M, prorated to Oct 27". */
  targetLabel: string | null;
  status: ExecStatus;
  /** "On plan", "Watch", "Off plan", "No plan set", "Healthy"… */
  statusLabel: string;
  /** Up to 13 weekly points, oldest first, for the sparkline. */
  trend: ExecTrendPoint[];
  basis: ExecBasis;
  /** One sentence: how it is counted. */
  definition: string;
  /** The drill-down. */
  href: string;
}

export interface ExecChange {
  id: string;
  tone: 'good' | 'bad' | 'neutral';
  /** One sentence with its number: "Gross margin rose to 20.8%, up 1.1 points on the prior week." */
  text: string;
  href: string | null;
}

export interface ExecPlanState {
  /** "2026-Q4". */
  quarter: string;
  /** Whether any target is set for the quarter. */
  set: boolean;
}

/** GET /executive/overview?period=&compare= — the chairman's first screen in one request. */
export interface ExecOverview {
  period: ExecPeriod;
  comparison: ExecComparison;
  /** In order: revenue, marginPct, workforce, fillRate, turnover, overtimePct, dso, cash. (Labor cost % is 100 − margin %, so it is the drill-down's, not a second tile.) */
  scorecard: ExecKpi[];
  /** 3–5, most significant first. */
  changes: ExecChange[];
  plan: ExecPlanState;
  /** Footnotes the page prints once (rates, workweek, sources). */
  notes: string[];
}

/* ---------------------------------------------------------------- financials */

export type ExecWaterfallKey = 'billed' | 'basePay' | 'overtimePremium' | 'burden' | 'overhead' | 'margin';

export interface ExecWaterfallStep {
  key: ExecWaterfallKey;
  label: string;
  /** Positive for billed and margin; the costs as positive amounts taken away. */
  amount: number;
}

export interface ExecFinanceWeek {
  start: string;
  billed: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  hours: number;
  otHours: number;
}

export interface ExecAgingBuckets {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
}

/** GET /executive/financials?period=&compare= */
export interface ExecFinancials {
  period: ExecPeriod;
  comparison: ExecComparison;
  /** revenue, grossMargin, marginPct, overtimePct, cash, dso. */
  kpis: ExecKpi[];
  /** Billed → base pay → overtime premium → employer burden → overhead → margin, for the period. */
  waterfall: ExecWaterfallStep[];
  /** The last 13 complete weeks, oldest first. */
  weeks: ExecFinanceWeek[];
  cash: {
    today: number | null;
    accounts: number;
    minimum: number | null;
    /** The 13-week forecast, one balance per week, from the cash forecast. */
    forecast: Array<{ weekStart: string; balance: number }>;
    lowPoint: { weekStart: string; balance: number; belowMinimum: boolean } | null;
  } | null;
  receivables: {
    total: number;
    buckets: ExecAgingBuckets;
    /** Largest and oldest open statements first, at most 8. */
    open: Array<{ statementId: string; clientName: string; number: string; amount: number; dueOn: string; ageDays: number }>;
    dsoByMonth: Array<{ month: string; days: number | null }>;
  };
  payrollRuns: Array<{ runId: string; periodStart: string; periodEnd: string; people: number; gross: number; employerTaxes: number; cost: number }>;
  profit: { month: string; mtdNetIncome: number; ytd: { actual: number; budget: number; variance: number } | null; budgetName: string | null } | null;
  rates: { billRate: number; payRate: number; burdenPct: number; overheadPerHour: number };
}

/* ------------------------------------------------------------------- clients */

export interface ExecClientRow {
  clientId: string;
  name: string;
  /** The period's est. billed and margin. */
  billed: number;
  margin: number;
  marginPct: number | null;
  /** Share of the period's est. billed, 0–100. */
  sharePct: number;
  /** Active associates placed with the client (the one definition of active). */
  headcount: number;
  hours: number;
  /** Assigned ÷ published shifts in the period, 0–100. */
  fillPct: number | null;
  /** Latest NPS, −100…100, when a survey came back. */
  nps: number | null;
  /** The client-health score 0–100 the clients list shows, and its word. */
  health: number | null;
  healthLabel: string | null;
  /** Weekly est. billed, the last 8 complete weeks, oldest first. */
  trend: number[];
  href: string;
}

export interface ExecPipelineStage {
  stage: string;
  label: string;
  count: number;
  /** Sum of the prospects' expected weekly billing. */
  weeklyValue: number;
  /** 0–1: how often a deal at this stage closes (stated in the page's footnote). */
  probability: number;
  /** weeklyValue × 52 × probability. */
  weightedAnnual: number;
}

/** GET /executive/clients?period=&compare= */
export interface ExecClients {
  period: ExecPeriod;
  comparison: ExecComparison;
  clients: ExecClientRow[];
  concentration: {
    /** The largest client's share, 0–100. */
    topSharePct: number;
    topClientName: string | null;
    /** The share past which one client is a concentration risk. */
    thresholdPct: number;
    /** Herfindahl–Hirschman index of the shares (0–10,000). */
    hhi: number;
  };
  pipeline: {
    stages: ExecPipelineStage[];
    weightedAnnual: number;
    prospects: Array<{ id: string; name: string; stage: string; stageLabel: string; weeklyValue: number | null; daysInStage: number }>;
  };
  /** Each store's period economics, best margin first. */
  league: Array<{ locationId: string; name: string; clientName: string; billed: number; margin: number; marginPct: number | null; hours: number; otHours: number }>;
}

/* -------------------------------------------------------------------- people */

/** The same counts the People directory and Analytics show (lib/peopleStatus). */
export interface ExecWorkforceCounts {
  active: number;
  onTheBooks: number;
  onboarding: number;
  deactivated: number;
  placedNotActive: number;
  notPlaced: number;
}

export interface ExecPeopleWeek {
  start: string;
  /** Active associates as of the week's last day. */
  active: number;
  hires: number;
  separations: number;
  /** Paid hours (approved/completed time, breaks out, rounded as pay rounds) — the one definition. */
  hours: number;
  otHours: number;
  /** Overtime share of paid hours, 0–100. */
  otPct: number | null;
  /** Unexcused attendance events (late, call-out, no-call no-show). */
  unexcused: number;
}

/** GET /executive/people?period=&compare= */
export interface ExecPeople {
  period: ExecPeriod;
  comparison: ExecComparison;
  /** workforce, hires, turnover, overtimePct. */
  kpis: ExecKpi[];
  counts: ExecWorkforceCounts;
  /** The last 13 complete weeks, oldest first. */
  weeks: ExecPeopleWeek[];
  turnover: { annualizedPct: number | null; targetPct: number | null; separations90d: number; estCost90d: number };
  /** Unexcused events per site per week (the last 8 weeks), for the heatmap. */
  attendance: {
    sites: Array<{ id: string; name: string }>;
    weeks: string[];
    cells: Array<{ siteId: string; week: string; events: number; perHundredShifts: number | null }>;
  };
  tenure: Array<{ band: string; count: number }>;
  /** Hires whose start date has arrived, newest first. */
  newHires: Array<{ id: string; name: string; photoUrl: string | null; hireDate: string }>;
  /** Most paid hours with a clean attendance record, the last 4 weeks. */
  topWorkers: Array<{ id: string; name: string; photoUrl: string | null; hours: number }>;
  anniversaries: Array<{ id: string; name: string; years: number; date: string }>;
}

/* --------------------------------------------------------------------- risks */

export type ExecRiskCategory = 'client' | 'compliance' | 'people' | 'cash' | 'operations';
export type ExecRiskSeverity = 'high' | 'medium' | 'low';

export interface ExecRisk {
  id: string;
  category: ExecRiskCategory;
  severity: ExecRiskSeverity;
  /** "One client is 76% of revenue". */
  title: string;
  /** What it means and what would retire it, in a sentence or two. */
  detail: string;
  /** The role that owns it: "Clients", "HR", "Finance", "Operations". */
  owner: string;
  trend: 'rising' | 'steady' | 'easing' | 'new';
  /** The number behind it, as text: "76% of est. billed". */
  metric: string | null;
  href: string;
}

/** GET /executive/risks */
export interface ExecRisks {
  asOf: string;
  /** Highest severity first. */
  risks: ExecRisk[];
}
