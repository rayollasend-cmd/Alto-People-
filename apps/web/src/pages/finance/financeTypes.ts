import type { FieldglassQueueRow } from '../fieldglass/FieldglassQueue';

/** GET /finance/overview — the finance cockpit in one round trip. */
export interface FinanceOverview {
  generatedAt: string;
  payday: {
    next: { date: string; schedule: string } | null;
    inFlight: {
      id: string;
      status: 'DRAFT' | 'FINALIZED';
      periodStart: string;
      periodEnd: string;
      totalGross: number;
    } | null;
    lastDisbursed: { periodEnd: string; totalGross: number } | null;
  };
  /** The pay period the next payday pays for, and how ready it is. */
  payCycle?: PayCycle | null;
  close: {
    pendingEntries: number;
    pendingHours: number;
    oldestDay: string | null;
    byClient: Array<{
      clientId: string | null;
      clientName: string;
      entries: number;
      hours: number;
    }>;
  };
  payrollCases: { open: number; assignedToMe: number };
  /** Finance's hold queue: pay-account / W-4 changes awaiting a verification call. */
  financialChanges?: { pending: number; held: number; open: number };
  /** The next weeks of cash movement (GET /finance/cash-forecast has every line). */
  cash?: { from: string; to: string; weeks: CashWeek[]; totals: { inflow: number; outflow: number; net: number }; opening?: CashForecast['opening']; lowest?: CashForecast['lowest']; minimumCash?: number | null } | null;
  settlements: { count: number; total: number };
  receivables: {
    outstandingTotal: number;
    outstandingCount: number;
    oldestDays: number | null;
    avgDaysToPay: number | null;
    draftStatements: number;
    /** Outstanding by days past DUE — the one aging definition Books and the executive view use. */
    aging?: { current: number; days1to30: number; days31to60: number; days61to90: number; over90: number };
    /** Who owes the most, and the oldest statement's days past due. */
    byClient?: Array<{ clientId: string | null; clientName: string; amount: number; oldestDays: number }>;
  };
  /** Last week in Fieldglass — the one due Monday 2:00 PM Pacific. */
  billing?: BillingWeek | null;
  /** Revenue, wages and gross margin, week by week. */
  margin?: MarginTrend | null;
  fieldglassQueue: FieldglassQueueRow[];
  /** The whole queue's size — the dashboard shows its top 12. */
  fieldglassQueueTotal?: number;
  billedVsPaid: {
    weekStart: string;
    billed: number;
    paidGross: number;
    variance: number;
  } | null;
}

export interface CashWeek {
  weekStart: string;
  weekEnd: string;
  inflow: number;
  outflow: number;
  net: number;
  /** Running total of movement since today. */
  cumulative: number;
  /** Opening cash + the running total: where the balance stands at the week's end. */
  balance?: number;
}

export interface CashLine {
  date: string;
  kind: 'PAYROLL' | 'TAX_DEPOSIT' | 'GARNISHMENT' | 'RECEIVABLE' | 'BILL' | 'RETIREMENT' | 'BENEFITS';
  label: string;
  /** Signed: money in positive, money out negative. */
  amount: number;
  confidence: 'scheduled' | 'estimated' | 'overdue';
  linkUrl: string;
  /** Why an estimate is what it is ("0 people on schedule — the last run’s net"). */
  warning?: string | null;
}

export interface CashForecast {
  generatedAt: string;
  from: string;
  to: string;
  /** The Books cash position today; null when the books hold no bank account yet. */
  /** `onFile: false` — bank accounts exist but nothing is posted to them yet, so the balance is not a real $0. */
  opening: { balance: number; accounts: number; asOf: string; onFile?: boolean } | null;
  /** The cash floor from Settings; null when none is set. */
  minimumCash: number | null;
  lowest: { weekStart: string; balance: number; belowMinimum: boolean } | null;
  weeks: CashWeek[];
  lines: CashLine[];
  totals: { inflow: number; outflow: number; net: number };
}

export interface PayCycle {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  schedule: string;
  /** Worked in the period: approved, and still awaiting approval. */
  hours: { approved: number; pending: number };
  /** This period's payroll run, if one was started. */
  run: { id: string; status: 'DRAFT' | 'FINALIZED' | 'DISBURSED'; totalGross: number } | null;
}

export interface BillingWeek {
  weekStart: string;
  weekEnd: string;
  /** MM/DD/YYYY — the Fieldglass End. */
  weekEnding: string;
  dueAt: string;
  /** Workers with billable time that week (at a client). */
  workers: number;
  registered: number;
  entered: number;
  /** Registered and not entered yet — or rejected, to fix and resubmit. */
  toEnter: number;
  rejected: number;
  approved: number;
  submitted: number;
  notRegistered: number;
  variances: number;
  hours: number;
  money: { approved: number; awaiting: number; atRisk: number };
  /** Hours at clients with no bill rate — not priced. */
  unpricedHours: number;
  /** Rejected in earlier weeks and not resubmitted yet. */
  rejectedOpen: { count: number; amount: number };
}

export interface MarginWeek {
  weekStart: string;
  weekEnd: string;
  inProgress: boolean;
  /** Approved hours. */
  hours: number;
  /** Approved hours × the client's bill rate. */
  revenue: number;
  /** What payroll pays for them: pay rate, time and a half past 40. */
  wages: number;
  margin: number;
  /** Margin over revenue; null with no revenue. */
  marginPct: number | null;
  /** Hours at clients with no bill rate — in wages, not in revenue. */
  unpricedHours: number;
}

export interface MarginTrend {
  weeks: MarginWeek[];
  /** Payroll's fallback rate for someone with no hourly pay on file. */
  defaultRate: number;
  /** Associates paid at that fallback in these weeks. */
  defaultRateAssociates: number;
}
