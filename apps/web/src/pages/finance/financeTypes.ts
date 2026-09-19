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
  settlements: { count: number; total: number };
  receivables: {
    outstandingTotal: number;
    outstandingCount: number;
    oldestDays: number | null;
    avgDaysToPay: number | null;
    draftStatements: number;
    /** Outstanding by age since the statement was finalized. */
    aging?: { current: number; d31: number; d61: number; d91: number };
    /** Who owes the most, and how long the oldest has waited. */
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
