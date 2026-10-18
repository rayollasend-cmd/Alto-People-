import type { AgencyKind, LiabilityStatus, NoticeStatus, PaymentStatus, ReturnStatus } from '@/lib/payrollTaxesApi';
import { Badge } from '@/components/ui/Badge';
import { fmtDate } from '@/lib/format';

/** Shared bits of the payroll-tax desk: dates, labels, badges. */

export const KIND_SHORT: Record<AgencyKind, string> = {
  FEDERAL_WITHHOLDING: 'Federal 941',
  FEDERAL_UNEMPLOYMENT: 'Federal unemployment',
  STATE_WITHHOLDING: 'State withholding',
  STATE_UNEMPLOYMENT: 'State unemployment',
  LOCAL: 'Local',
};

export const FREQUENCY_LABEL: Record<string, string> = {
  NEXT_DAY: 'Next business day',
  SEMIWEEKLY: 'Semiweekly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  ANNUAL: 'Yearly',
};

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Due Oct 22 · in 4 days", "Due today", "3 days late". */
export function dueText(due: string | null | undefined, today: string = localToday()): string {
  if (!due) return 'No due date';
  const n = daysBetween(today, due);
  const date = fmtDate(due);
  if (n < 0) return `Was due ${date} · ${-n} day${n === -1 ? '' : 's'} late`;
  if (n === 0) return `Due today, ${date}`;
  if (n === 1) return `Due tomorrow, ${date}`;
  return `Due ${date} · in ${n} days`;
}

export function DueBadge({ due, today, done }: { due: string | null | undefined; today?: string; done?: boolean }) {
  if (!due || done) return null;
  const n = daysBetween(today ?? localToday(), due);
  if (n < 0) return <Badge variant="destructive">{`${-n} day${n === -1 ? '' : 's'} late`}</Badge>;
  if (n <= 3) return <Badge variant="pending">{n === 0 ? 'Due today' : n === 1 ? 'Due tomorrow' : `${n} days left`}</Badge>;
  return null;
}

const LIAB_LABEL: Record<LiabilityStatus, string> = { OPEN: 'To pay', SCHEDULED: 'Payment started', PAID: 'Paid', VOID: 'Void' };
const LIAB_TONE: Record<LiabilityStatus, 'pending' | 'info' | 'success' | 'outline'> = { OPEN: 'pending', SCHEDULED: 'info', PAID: 'success', VOID: 'outline' };
export const LiabilityBadge = ({ status }: { status: LiabilityStatus }) => <Badge variant={LIAB_TONE[status]}>{LIAB_LABEL[status]}</Badge>;

const PAY_LABEL: Record<PaymentStatus, string> = { SCHEDULED: 'To pay', SUBMITTED: 'Sent', PAID: 'Paid', FAILED: 'Failed', CANCELLED: 'Cancelled' };
const PAY_TONE: Record<PaymentStatus, 'pending' | 'info' | 'success' | 'destructive' | 'outline'> = { SCHEDULED: 'pending', SUBMITTED: 'info', PAID: 'success', FAILED: 'destructive', CANCELLED: 'outline' };
export const PaymentBadge = ({ status }: { status: PaymentStatus }) => <Badge variant={PAY_TONE[status]}>{PAY_LABEL[status]}</Badge>;

const RET_LABEL: Record<ReturnStatus | 'NOT_STARTED', string> = { NOT_STARTED: 'Not started', DRAFT: 'Draft', SUBMITTED: 'Sent', FILED: 'Filed', ACCEPTED: 'Accepted', REJECTED: 'Rejected', SUPERSEDED: 'Replaced' };
const RET_TONE: Record<ReturnStatus | 'NOT_STARTED', 'default' | 'pending' | 'info' | 'success' | 'destructive' | 'outline'> = {
  NOT_STARTED: 'default',
  DRAFT: 'pending',
  SUBMITTED: 'info',
  FILED: 'success',
  ACCEPTED: 'success',
  REJECTED: 'destructive',
  SUPERSEDED: 'outline',
};
export const ReturnBadge = ({ status }: { status: ReturnStatus | 'NOT_STARTED' }) => <Badge variant={RET_TONE[status]}>{RET_LABEL[status]}</Badge>;

const NOTICE_LABEL: Record<NoticeStatus, string> = { NEW: 'New', IN_REVIEW: 'In review', RESPONDED: 'Responded', RESOLVED: 'Resolved' };
const NOTICE_TONE: Record<NoticeStatus, 'pending' | 'info' | 'success' | 'default'> = { NEW: 'pending', IN_REVIEW: 'info', RESPONDED: 'default', RESOLVED: 'success' };
export const NoticeBadge = ({ status }: { status: NoticeStatus }) => <Badge variant={NOTICE_TONE[status]}>{NOTICE_LABEL[status]}</Badge>;

/** The last eight quarters, newest first ("2026-Q4"…), from today. */
export function recentQuarters(today: string = localToday(), count = 8): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  let year = y;
  let q = Math.floor((m - 1) / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(`${year}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

export function quarterName(label: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!m) return label;
  const months = ['January–March', 'April–June', 'July–September', 'October–December'][Number(m[2]) - 1];
  return `Q${m[2]} ${m[1]} (${months})`;
}

/** What each return figure means, in words. */
export const FIGURE_LABEL: Record<string, string> = {
  line1_employees: 'Line 1 · People paid',
  line2_wages: 'Line 2 · Wages, tips and other pay',
  line3_federalIncomeTax: 'Line 3 · Federal income tax withheld',
  line5a_socialSecurityWages: 'Line 5a · Social Security wages',
  line5a_socialSecurityTax: 'Line 5a · Social Security tax (12.4%)',
  line5c_medicareWages: 'Line 5c · Medicare wages',
  line5c_medicareTax: 'Line 5c · Medicare tax (2.9%)',
  line5d_additionalMedicareTax: 'Line 5d · Additional Medicare tax',
  line6_totalBeforeAdjustments: 'Line 6 · Total before adjustments',
  line7_fractionsOfCents: 'Line 7 · Fractions of cents',
  line12_totalTax: 'Line 12 · Total tax after adjustments',
  line13_deposits: 'Line 13 · Deposits made',
  line14_balanceDue: 'Line 14 · Balance due',
  line15_overpayment: 'Line 15 · Overpayment',
  month1_liability: 'Month 1 liability',
  month2_liability: 'Month 2 liability',
  month3_liability: 'Month 3 liability',
  line3_totalPayments: 'Line 3 · Total payments to employees',
  line5_paymentsOver7000: 'Line 5 · Payments over $7,000',
  line7_taxableFutaWages: 'Line 7 · Taxable FUTA wages',
  line8_futaTax: 'Line 8 · FUTA tax before adjustments',
  employees: 'People on the return',
  stateWages: 'State wages',
  stateTaxWithheld: 'State tax withheld',
  totalWages: 'Total wages',
  excessWages: 'Wages over the wage base',
  taxableWages: 'Taxable wages',
  rate: 'Rate',
  contributionDue: 'Contribution due',
  localWages: 'Local wages',
  localTaxWithheld: 'Local tax withheld',
  deposits: 'Deposits made',
  balanceDue: 'Balance due',
  overpayment: 'Overpayment',
  taxDue: 'Tax for the period',
  posted: 'Posted by payroll',
};

/** Postgres reorders stored keys: show figures and columns in the form's own order. */
const FIGURE_ORDER = Object.keys(FIGURE_LABEL);
export const ROW_COLUMN_ORDER = ['ssnLast4', 'lastName', 'firstName', 'name', 'quarterWages', 'excessWages', 'taxableWages', 'weeksWorked', 'hoursWorked', 'stateWages', 'stateTaxWithheld', 'localWages', 'localTaxWithheld'];
const rankIn = (order: string[], k: string) => (order.indexOf(k) === -1 ? 999 : order.indexOf(k));
export const byFigureOrder = ([a]: [string, unknown], [b]: [string, unknown]) => rankIn(FIGURE_ORDER, a) - rankIn(FIGURE_ORDER, b);
export const byColumnOrder = (a: string, b: string) => rankIn(ROW_COLUMN_ORDER, a) - rankIn(ROW_COLUMN_ORDER, b);

export const isCountFigure = (k: string) => k === 'line1_employees' || k === 'employees';
