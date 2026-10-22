// Wave 6 — Pure-ish payroll run aggregator.
//
// Reads time entries, shifts, W-4s, pay schedules, prior YTD wages, active
// pre-tax benefit enrollments, and active garnishments — runs all of the
// math (OT split, FIT/SIT/FICA/Medicare, employer-side taxes, garnishment
// CCPA caps) — and returns a projected per-associate list. Does NOT write
// any rows. The DB-writing wrapper (POST /runs) calls this then persists
// the projection. The preview endpoint (POST /runs/preview) calls this
// alone and returns the projection as JSON.
//
// "Pure-ish" because it still touches the DB to read inputs — but it makes
// no writes, so it's safe to call from a read-only endpoint and trivial to
// re-run after fixing inputs.

import type { Prisma, PrismaClient } from '@prisma/client';
import { findInChunks } from './chunkedIn.js';
import { computeRetroPay, summarizeRetro, type RetroCandidate } from './retroPay.js';
import { evaluateLivePay, loadLiveRules } from './laborRules/live.js';
import { localParts } from './laborRules/evaluate.js';
import { loadRoundingPolicies, roundPunches } from './punchRounding.js';
import { unpaidPremiums } from './predictabilityPay.js';
import { tenantIdForWrite } from './tenant.js';
import {
  payableMs,
  round2,
  splitWeeklyOvertime,
  sumApprovedHours,
} from './payroll.js';
import {
  localDateKey,
  zonedDayOfWeek,
  zonedWallTimeToUtcInstant,
} from './timezone.js';

import {
  computePaycheckTaxes,
  federalW4Fields,
  supplementalFederalWithholding,
  zeroTaxBreakdown,
  type PaycheckTaxBreakdown,
  type PayFrequency,
} from './payrollTax.js';
import { computeGarnishmentDeductions } from './garnishments.js';
import { backupAmount, backupRequirement } from './contractors.js';
import { levyExemptPerPeriod, type LevyParameters, type StateRule, type PayFrequency as GarnFrequency } from './garnishmentEngine.js';
import { enrollmentFacts, loadPayrollElections, projectRetirement, type EnrollmentRow, type ProjectedRetirement } from './retirement.js';
import { computeYtdWagesBatch } from './payrollYtd.js';
import { computeCheckDeductions, loadDeferralContexts, type DeferralRecord } from './retirementDeferrals.js';
import { calculateTaxes, inHouseEngine, type TaxEngineProvider, type TaxLine } from './taxEngine/index.js';
import { LOCAL_TAX_STATES, taxableWages, type TaxabilityContext, type TaxableWages } from './deductionTaxability.js';
import { buildDeductionLines, reconcile, type DeductionLine } from './deductionLines.js';
import { groupTermLifeImputed } from './groupTermLife.js';
import type { PlanDeduction } from './retirementDeferrals.js';
import { inWindows, workDayOf } from './payrollSchedule.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AggregatorInput {
  /** Inclusive UTC midnight of the first day of the period. */
  periodStart: Date;
  /** Exclusive — start of the day AFTER periodEnd. */
  periodEndExclusive: Date;
  /** Optional client filter — null means cross-client run. */
  clientId: string | null;
  /** Default hourly rate when no shift in the period has one. */
  defaultRate: number;
  /**
   * Optional per-associate hourly-rate override. When an associate id is
   * present here, this rate is used instead of the shift-derived rate (and
   * the shift lookup is skipped). Lets callers drive gross from a different
   * rate source — e.g. the payroll-ready sheet uses each associate's current
   * compensation-record wage. Real payroll runs omit this and keep using
   * shift rates.
   */
  hourlyRateOverride?: Map<string, number>;
  /**
   * Optional state override for the state-income-tax calc. When set (incl.
   * an explicit value), it replaces each associate's stored state — used by
   * the payroll sheet to apply the selected client's work-site state (e.g.
   * a Florida client → no state income tax) rather than a possibly-unset
   * per-associate state, which would otherwise hit the 4% fallback.
   */
  stateOverride?: string | null;
  /**
   * Tier-2 — manual earning lines attached to the run (bonus, commission,
   * tips, holiday, PTO payout). The run-create/re-aggregate path loads
   * PayrollRunAddOn rows and passes them here; preview has none. An
   * associate present here but with no hours still yields an item — that's
   * the OFF_CYCLE bonus-run flow.
   */
  addOns?: Array<{
    associateId: string;
    kind: AddOnKind;
    amount: number;
    hours: number | null;
  }>;
  /**
   * Tier-2 — the run being (re-)aggregated, when persisting. Lets the
   * tip-pool consumption stay idempotent: pools already stamped with this
   * run id keep contributing on re-aggregation, while pools consumed by a
   * DIFFERENT run never double-pay. Preview passes nothing and sees only
   * unconsumed CLOSED pools.
   */
  runId?: string;
  /**
   * The tenant's tax engine (lib/taxEngine): Alto's own unless a Symmetry or
   * Vertex connection is active. Callers read it once with taxEngineFor();
   * omitted, Alto's engine answers.
   */
  taxEngine?: TaxEngineProvider;
  /**
   * The check's pay date, for the W-4 rules that turn on it (an "Exempt"
   * W-4 lapses after February 15; an IRS lock-in letter's effective date).
   * Omitted, the day after the period ends.
   */
  payDate?: Date;
  /**
   * A run for one pay schedule (lib/payScheduleMembership): only these
   * people, and only their days on the schedule (inclusive YYYY-MM-DD
   * windows). A person who moved schedules mid-period is paid here for the
   * days they were on it. `frequency` is the schedule's pattern in force.
   */
  scheduleFilter?: { windows: Map<string, Array<{ start: string; end: string }>>; frequency: PayFrequency };
}

export type AddOnKind =
  | 'BONUS'
  | 'COMMISSION'
  | 'TIPS'
  | 'HOLIDAY'
  | 'SICK'
  | 'VACATION';

// Pub 15 §7 — supplemental wages withheld at the 22% flat rate when paid
// alongside (but identified separately from) regular wages. Tips and
// leave payouts are regular wages taxed by the percentage method.
const SUPPLEMENTAL_KINDS = new Set<AddOnKind>(['BONUS', 'COMMISSION']);

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
  DAILY: 260,
};

export interface ProjectedEarning {
  /** DAILY_SETTLED: the (negative) line for what daily pay already paid (lib/dailyPay). */
  kind: 'REGULAR' | 'OVERTIME' | 'DOUBLE_TIME' | 'RETRO' | 'PREMIUM' | 'DAILY_SETTLED' | 'IMPUTED_INCOME' | AddOnKind;
  /** Null for flat-amount earnings (salary, bonus, commission…). */
  hours: number | null;
  rate: number | null;
  amount: number;
  isTaxable: true;
  /** Paystub line label (premium-rule name, "Tip pool allocation", …). */
  note?: string;
}

/**
 * Hours of [start, end) overlapping a rule's daily minute window /
 * day-of-week mask (bit N = day N at the SITE, Sunday=0). A null window
 * means the whole day; an end minute at or before the start minute wraps
 * past midnight.
 *
 * Windows are wall-clock at the work site: admins type "22:00–06:00
 * night differential" meaning the site's nights. The old implementation
 * anchored the windows to UTC days, so at an Eastern site the premium
 * band sat 22:00–06:00 UTC = 17:00–01:00 ET — day workers collected the
 * night premium and night workers got half of it. DST is handled by
 * zonedWallTimeToUtcInstant (window edges land on real instants).
 */
function windowOverlapHours(
  start: Date,
  end: Date,
  rule: { startMinute: number | null; endMinute: number | null; dowMask: number | null },
  timeZone: string,
): number {
  const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  let totalMs = 0;
  // Walk local calendar days from the site-local date of `start` until a
  // day whose local midnight is past `end`.
  let [y, m, d] = localDateKey(start, timeZone).split('-').map(Number) as [number, number, number];
  for (let i = 0; i < 40; i++) {
    const dayStart = zonedWallTimeToUtcInstant(y, m, d, 0, timeZone);
    if (dayStart.getTime() >= end.getTime() && i > 0) break;
    const dow = zonedDayOfWeek(dayStart, timeZone);
    const s = rule.startMinute ?? 0;
    const e = rule.endMinute ?? 1440;
    const winStart = (min: number) =>
      zonedWallTimeToUtcInstant(y, m, d, min, timeZone).getTime();
    if (rule.dowMask === null || (rule.dowMask >> dow) & 1) {
      if (rule.startMinute !== null && rule.endMinute !== null && e <= s) {
        // Wraps midnight: [s..24:00) tonight + [00:00..e) tomorrow morning.
        totalMs += overlap(start.getTime(), end.getTime(), winStart(s), winStart(1440));
        totalMs += overlap(start.getTime(), end.getTime(), winStart(0), winStart(e));
      } else {
        totalMs += overlap(start.getTime(), end.getTime(), winStart(s), winStart(e));
      }
    }
    // Next local calendar day.
    const next = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  return totalMs / 3_600_000;
}

export interface ProjectedGarnishment {
  garnishmentId: string;
  amount: number;
  reachedCap: boolean;
  /** The employer's processing fee the state allows (kept, not remitted). */
  adminFee?: number;
  /** Why the order took less than it asked, when it did. */
  note?: string | null;
}

export interface ProjectedItem {
  associateId: string;
  associateName: string;
  hoursWorked: number;
  hourlyRate: number;
  /** DEFAULT = the editable fallback rate because no comp record exists. */
  rateSource: 'OVERRIDE' | 'COMP' | 'DEFAULT' | 'SALARY';
  /** Federal weekly OT split: regular vs overtime hours. */
  regularHours: number;
  overtimeHours: number;
  earnings: ProjectedEarning[];
  grossPay: number;
  preTaxDeductions: number;
  /**
   * Gap 1 — sub-bucket of preTaxDeductions covering 401(k)/403(b) only.
   * This portion reduces the FIT base but NOT the FICA / Medicare /
   * employer-tax base, so the W-2 aggregator can compute Box 1 vs Box 3/5
   * correctly. Section-125 pre-tax = preTaxDeductions - preTaxRetirement.
   */
  preTaxRetirement: number;
  /** Tax breakdown — zero when employmentType is 1099. */
  federalIncomeTax: number;
  fica: number;
  medicare: number;
  stateIncomeTax: number;
  /** Tier-2 — city/county withholding from the associate's LocalTaxRule. */
  localIncomeTax: number;
  taxState: string | null;
  /** Pay frequency from the schedule (or BIWEEKLY fallback). */
  payFrequency: PayFrequency;
  /** Per-CCPA disposable earnings used for garnishment math. */
  disposableEarnings: number;
  garnishments: ProjectedGarnishment[];
  postTaxDeductions: number;
  /**
   * Gap 10 — sum of SETTLED reimbursements queued for this associate. Added
   * to netPay AFTER taxes / deductions; never affects grossPay or any
   * wage base (accountable-plan rule). Persistence stamps these rows
   * with payrollItemId at run-creation time.
   */
  reimbursementsTotal: number;
  /** IDs of Reimbursement rows consumed for this item — empty in preview. */
  reimbursementIds: string[];
  /** Retroactive pay settled on this check (lib/retroPay.ts); persisted by the run. */
  retro: RetroCandidate[];
  /** Predictability-pay rows this check pays (lib/predictabilityPay); stamped by the run. */
  premiumIds: string[];
  retroPay: number;
  netPay: number;
  /** Employer-side accruals (informational; not deducted from net). */
  employerFica: number;
  employerMedicare: number;
  employerFuta: number;
  employerSuta: number;
  /** Pre-paycheck YTD snapshots used for FICA cap + Medicare surcharge. */
  ytdWages: number;
  ytdMedicareWages: number;
  /** 2026 W-2 Box 12 TP: cash tips reported to the employer on this check. */
  qualifiedTips: number;
  /** 2026 W-2 Box 12 TT: the FLSA overtime premium portion on this check. */
  qualifiedOvertime: number;
  /** W-2 Box 14b: the job's Treasury Tipped Occupation Code. */
  tippedOccupationCode: string | null;
  /** Roth deferrals (after tax), inside postTaxDeductions. */
  rothDeferral: number;
  /** The retirement / HSA / FSA split, persisted on the item for YTD limits and the W-2. */
  deferrals: DeferralRecord | null;
  /** 401(k) plan detail for the recordkeeper file (lib/retirement); null without an election. */
  retirement: ProjectedRetirement | null;
  /** State and local taxes by jurisdiction (lib/taxEngine); persisted as PayrollItemTaxLine. */
  taxLines: TaxLine[];
  /** Which engine answered; null when no engine ran (1099, zero gross, a sheet override). */
  taxEngine: 'IN_HOUSE' | 'SYMMETRY_STE' | 'VERTEX_PAYROLL' | null;
  /** Why a licensed engine fell back to Alto's, when it did. */
  taxEngineFallback: string | null;
  /** Local jurisdictions this check owes, for the review gate. */
  taxJurisdictions: string[];
  /** Questions the engine couldn't answer (missing PSD code …), for the exceptions list. */
  taxUnresolved: string[];
  /** The state unemployment is reported to (four-factor test). */
  suiState: string | null;
  /** Wages by work state, allocated by the hours at each site. */
  wagesByState: Record<string, number>;
  /** Employer-paid local payroll taxes (Oregon transit …), not withheld. */
  employerLocalTax: number;
  /** Withheld state program contributions (CA SDI, NJ TDI/FLI, WA PFML …), inside totalEmployeeTax and out of net. */
  stateProgramTax: number;
  /** Employer-paid state program contributions (WA PFML employer share …). */
  employerProgramTax: number;
  /** What changed the W-4 on file for this check (an expired exemption, an IRS lock-in letter). */
  w4Flags: Array<'EXEMPT_EXPIRED' | 'LOCK_IN_LETTER'>;
  /**
   * Every deduction on this check, itemized, with the wage bases each one
   * lowered (lib/deductionLines). Persisted as PayrollItemDeduction; the
   * lump columns above are their sums.
   */
  deductionLines: DeductionLine[];
  /** The wage bases this check was taxed on, by tax and by state (lib/deductionTaxability). */
  taxableWages: TaxableWages | null;
}

export interface ProjectedTotals {
  totalGross: number;
  totalEmployeeTax: number;
  totalNet: number;
  totalEmployerTax: number;
  totalGarnishments: number;
  itemCount: number;
}

export interface AggregatorResult {
  items: ProjectedItem[];
  totals: ProjectedTotals;
  /** Tier-2 — CLOSED tip pools whose allocations were folded into items.
   *  The persisting caller stamps them PAID_OUT + paidPayrollRunId. */
  consumedTipPoolIds: string[];
}

/**
 * Reads inputs + runs the math. No writes. Caller decides whether to
 * persist (POST /runs) or just project (POST /runs/preview).
 */
export async function aggregatePayrollProjection(
  tx: Tx,
  input: AggregatorInput
): Promise<AggregatorResult> {
  const { periodStart, periodEndExclusive, clientId, defaultRate } = input;

  const entries = await tx.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockInAt: { gte: periodStart, lt: periodEndExclusive },
      ...(clientId ? { clientId } : {}),
    },
    include: {
      // Pay is net-of-breaks (matches the review screen and every export) —
      // without this include, payableMs sees no breaks and pays the full
      // clock span. That was a real production bug: 8h punched with a 1h
      // docked meal paid 8h while every report HR reconciled against said 7.
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      // Site zone for premium-rule windows — differentials are wall-clock
      // at the work site, not UTC. State and city resolve the labor rules
      // a LIVE jurisdiction pays by (lib/laborRules/live).
      location: { select: { id: true, state: true, city: true, zip: true, timezone: true } },
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          employmentType: true,
          dob: true,
          payrollSchedule: { select: { frequency: true } },
          jobProfile: { select: { tippedOccupationCode: true, isExempt: true } },
          localTaxRule: { select: { rate: true, isActive: true, name: true } },
          city: true,
          zip: true,
          taxProfile: { select: { residentPsdCode: true, residentMunicipality: true, residentSchoolDistrict: true, residentCountyJan1: true, residentLocalCode: true } },
          taxCertificates: { where: { revokedAt: null }, select: { kind: true, state: true, jurisdictionCode: true } },
          stateW4s: {
            select: { state: true, filingStatus: true, allowances: true, dependents: true, additionalWithholding: true, exempt: true, county: true },
          },
          w4Submission: {
            select: {
              filingStatus: true,
              extraWithholding: true,
              deductions: true,
              otherIncome: true,
              dependentsAmount: true,
              multipleJobs: true,
              exempt: true,
              exemptTaxYear: true,
              nonresidentAlien: true,
              pre2020Allowances: true,
              lockInFilingStatus: true,
              lockInMultipleJobs: true,
              lockInEffectiveDate: true,
            },
          },
        },
      },
    },
  });

  const byAssociate = new Map<string, typeof entries>();
  // A run for one pay schedule pays its people for their days on it.
  const sf = input.scheduleFilter;
  for (const e of entries) {
    if (sf && !inWindows(sf.windows, e.associateId, workDayOf(e.clockInAt, e.location?.timezone))) continue;
    const arr = byAssociate.get(e.associateId) ?? [];
    arr.push(e);
    byAssociate.set(e.associateId, arr);
  }

  // Timekeeping and labor rules. Rounding (lib/punchRounding) changes the
  // punches pay is computed from, never the entry; a jurisdiction a tenant
  // has taken LIVE pays by its signed rules (lib/laborRules/live), with the
  // meal a worker attested they waived honoured and one they said they
  // didn't get paid as the premium.
  const laborTenantId = tenantIdForWrite();
  const [liveRules, rounding] = await Promise.all([loadLiveRules(tx, laborTenantId), loadRoundingPolicies(tx, laborTenantId)]);
  if (rounding.any) {
    for (const [id, list] of byAssociate) {
      byAssociate.set(
        id,
        list.map((e) => {
          const r = roundPunches(rounding.forSite(e.locationId), e.clockInAt, e.clockOutAt);
          return r.rounded ? { ...e, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt } : e;
        }),
      );
    }
  }
  const mealAttestation = new Map<string, string>();
  const premiumsByAssociate = new Map<string, Awaited<ReturnType<typeof unpaidPremiums>>>();
  if (liveRules.any && entries.length > 0) {
    const rows = await tx.breakAttestation.findMany({ where: { timeEntryId: { in: entries.map((e) => e.id) } }, select: { timeEntryId: true, meal: true } });
    for (const r of rows) mealAttestation.set(r.timeEntryId, r.meal);
    for (const p of await unpaidPremiums(tx, laborTenantId, [...byAssociate.keys()], periodStart, periodEndExclusive)) {
      const arr = premiumsByAssociate.get(p.associateId) ?? [];
      arr.push(p);
      premiumsByAssociate.set(p.associateId, arr);
    }
  }

  // Tier-2 — salaried associates get paid whether or not they punched a
  // clock. The open SALARY comp record (amount = annual salary) drives a
  // flat per-period wage; approved hours on a salaried associate are
  // treated as informational (FLSA-exempt assumption — no hourly pay, no
  // OT split). Client-scoped runs include a salaried associate only when
  // their open location assignment belongs to that client.
  const salaryComps = await tx.compensationRecord.findMany({
    where: {
      payType: 'SALARY',
      effectiveTo: null,
      effectiveFrom: { lt: periodEndExclusive },
      associate: {
        deletedAt: null,
        ...(clientId
          ? { assignments: { some: { endedAt: null, location: { clientId } } } }
          : {}),
      },
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { associateId: true, amount: true },
  });
  const annualSalaryByAssociate = new Map<string, number>();
  for (const c of salaryComps) {
    if (!annualSalaryByAssociate.has(c.associateId)) {
      annualSalaryByAssociate.set(c.associateId, Number(c.amount));
    }
  }

  // The associate's individual hourly rate comes from their open HOURLY
  // compensation record (amount = $/hour) — NOT the shift rate. This is
  // the contracted wage payroll should pay; the shift's rate was an MVP
  // stand-in. Associates with no HOURLY comp record fall back to
  // `defaultRate` (the wizard's editable default, 15), and the rate can
  // be corrected by editing their Compensation record.
  const hourlyComps = await tx.compensationRecord.findMany({
    where: {
      payType: 'HOURLY',
      effectiveTo: null,
      effectiveFrom: { lt: periodEndExclusive },
      associate: { deletedAt: null },
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { associateId: true, amount: true },
  });
  const hourlyRateByAssociate = new Map<string, number>();
  for (const c of hourlyComps) {
    if (!hourlyRateByAssociate.has(c.associateId)) {
      hourlyRateByAssociate.set(c.associateId, Number(c.amount));
    }
  }

  const addOnsByAssociate = new Map<string, NonNullable<AggregatorInput['addOns']>>();
  for (const a of input.addOns ?? []) {
    const arr = addOnsByAssociate.get(a.associateId) ?? [];
    arr.push(a);
    addOnsByAssociate.set(a.associateId, arr);
  }

  // Tier-2 — tip pools. Allocations from CLOSED, not-yet-consumed pools
  // whose shift date falls in the period fold into paychecks as TIPS
  // earnings (regular wages, not supplemental). Pools already stamped
  // with THIS run keep contributing so re-aggregation is idempotent.
  const tipAllocations = await tx.tipPoolAllocation.findMany({
    where: {
      tipPool: {
        shiftDate: { gte: periodStart, lt: periodEndExclusive },
        ...(clientId ? { clientId } : {}),
        OR: [
          { status: 'CLOSED', paidPayrollRunId: null },
          ...(input.runId ? [{ paidPayrollRunId: input.runId }] : []),
        ],
      },
    },
    select: { associateId: true, amount: true, tipPoolId: true },
  });
  const tipsByAssociate = new Map<string, number>();
  const consumedTipPoolIds = new Set<string>();
  for (const t of tipAllocations) {
    tipsByAssociate.set(
      t.associateId,
      round2((tipsByAssociate.get(t.associateId) ?? 0) + Number(t.amount)),
    );
    consumedTipPoolIds.add(t.tipPoolId);
  }

  // The associate universe: everyone with approved hours, an active
  // salary, a manual add-on line, or a tip allocation.
  const universe = new Set<string>([
    ...byAssociate.keys(),
    ...annualSalaryByAssociate.keys(),
    ...addOnsByAssociate.keys(),
    ...tipsByAssociate.keys(),
  ]);
  // On a schedule's run, only its people; a salary is paid for the share of the period they were on it.
  const salaryShare = new Map<string, number>();
  if (sf) {
    const periodDays = Math.round((periodEndExclusive.getTime() - periodStart.getTime()) / 86_400_000);
    for (const id of [...universe]) {
      const ws = sf.windows.get(id);
      if (!ws || ws.length === 0) {
        universe.delete(id);
        continue;
      }
      const days = ws.reduce((n, w) => n + Math.round((Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1, 0);
      if (periodDays > 0 && days < periodDays) salaryShare.set(id, days / periodDays);
    }
  }

  // Retroactive pay from back-dated rate changes, for everyone in the
  // universe — settled as one RETRO line per person on a REGULAR run.
  // Preview and persist see the same pairs (persist stamps them).
  const retroByAssociate = await computeRetroPay(tx, {
    associateIds: [...universe],
    asOf: periodEndExclusive,
    runId: input.runId,
  });

  // Associates in the universe with no time entries still need their W-4 /
  // schedule / state metadata.
  const ASSOCIATE_META_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    state: true,
    employmentType: true,
    dob: true,
    payrollSchedule: { select: { frequency: true } },
    jobProfile: { select: { tippedOccupationCode: true, isExempt: true } },
    localTaxRule: { select: { rate: true, isActive: true, name: true } },
    city: true,
    zip: true,
    taxProfile: { select: { residentPsdCode: true, residentMunicipality: true, residentSchoolDistrict: true, residentCountyJan1: true, residentLocalCode: true } },
    taxCertificates: { where: { revokedAt: null }, select: { kind: true, state: true, jurisdictionCode: true } },
    stateW4s: {
      select: { state: true, filingStatus: true, allowances: true, dependents: true, additionalWithholding: true, exempt: true, county: true },
    },
    w4Submission: {
      select: {
        filingStatus: true,
        extraWithholding: true,
        deductions: true,
        otherIncome: true,
        dependentsAmount: true,
        multipleJobs: true,
        exempt: true,
        exemptTaxYear: true,
        nonresidentAlien: true,
        pre2020Allowances: true,
        lockInFilingStatus: true,
        lockInMultipleJobs: true,
        lockInEffectiveDate: true,
      },
    },
  } as const;
  type AssociateMeta = Prisma.AssociateGetPayload<{ select: typeof ASSOCIATE_META_SELECT }>;
  const metaById = new Map<string, AssociateMeta>();
  for (const [id, group] of byAssociate) metaById.set(id, group[0].associate);
  const missingIds = [...universe].filter((id) => !metaById.has(id));
  if (missingIds.length > 0) {
    const extra = await findInChunks(missingIds, (chunk) =>
      tx.associate.findMany({
        where: { id: { in: chunk }, deletedAt: null },
        select: ASSOCIATE_META_SELECT,
      }),
    );
    for (const a of extra) metaById.set(a.id, a);
  }

  // Tier-2 — the client's actual SUTA experience rate (state agency
  // notice) beats the new-employer default. Client-scoped runs only;
  // cross-client runs keep the per-state defaults.
  let sutaOverride: { rate: number; wageBase: number | null } | null = null;
  // Tier-2 — client-scoped runs tax by the WORK-SITE state (where the
  // labor happened), not the associate's home-address state. Overridable
  // by input.stateOverride as before; cross-client runs keep per-
  // associate states.
  let clientWorkState: string | null = null;
  if (clientId) {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { sutaRateOverride: true, sutaWageBaseOverride: true, state: true },
    });
    clientWorkState = client?.state ?? null;
    if (client?.sutaRateOverride) {
      sutaOverride = {
        rate: Number(client.sutaRateOverride),
        wageBase: client.sutaWageBaseOverride
          ? Number(client.sutaWageBaseOverride)
          : null,
      };
    }
  }

  const yearStart = new Date(Date.UTC(periodStart.getUTCFullYear(), 0, 1));

  // PERF: batched pre-loads. The per-associate loop below used to issue up
  // to six queries per associate — ~1,800 sequential round-trips at 300
  // people, on every preview, every /payroll/upcoming render, and inside
  // run-creation's transaction. Everything the loop needs is fetched in
  // five set-based queries here and looked up from Maps.
  const universeIds = [...universe];

  const ytdByAssociate = await computeYtdWagesBatch(
    tx,
    universeIds,
    yearStart,
    periodStart,
  );

  const allEntryClientIds = new Set<string>();
  for (const group of byAssociate.values()) {
    for (const e of group) if (e.clientId) allEntryClientIds.add(e.clientId);
  }
  type PremiumRuleRow = Prisma.PremiumPayRuleGetPayload<Record<string, never>>;
  const premiumRulesByClient = new Map<string, PremiumRuleRow[]>();
  if (allEntryClientIds.size > 0) {
    const allRules = await tx.premiumPayRule.findMany({
      where: { isActive: true, clientId: { in: [...allEntryClientIds] } },
    });
    for (const r of allRules) {
      const arr = premiumRulesByClient.get(r.clientId) ?? [];
      arr.push(r);
      premiumRulesByClient.set(r.clientId, arr);
    }
  }

  const enrollmentsByAssociate = new Map<
    string,
    EnrollmentRow[]
  >();
  if (universeIds.length > 0) {
    const enrollRows = await findInChunks(universeIds, (chunk) => tx.benefitsEnrollment.findMany({
      where: {
        associateId: { in: chunk },
        effectiveDate: { lt: periodEndExclusive },
        OR: [{ terminationDate: null }, { terminationDate: { gte: periodStart } }],
      },
      select: {
        id: true,
        associateId: true,
        electedAmountCentsPerPeriod: true,
        rothElection: true,
        electedPercent: true,
        rothPercent: true,
        lifeCoverageCents: true,
        plan: { select: { kind: true, allowsDeemedRoth: true, employerContributionCentsPerPeriod: true } },
      },
    }));
    for (const e of enrollRows) {
      const arr = enrollmentsByAssociate.get(e.associateId) ?? [];
      arr.push(e);
      enrollmentsByAssociate.set(e.associateId, arr);
    }
  }
  // Year-to-date deferrals and last year's FICA wages, for the annual limits
  // and the SECURE 2.0 Roth catch-up rule (lib/retirementDeferrals).
  const deferralContexts = await loadDeferralContexts(tx, [...enrollmentsByAssociate.keys()], periodStart);
  const deferralYear = periodStart.getUTCFullYear();

  type GarnishmentRow = Prisma.GarnishmentGetPayload<Record<string, never>>;
  const garnsByAssociate = new Map<string, GarnishmentRow[]>();
  if (universeIds.length > 0) {
    const garnRows = await findInChunks(universeIds, (chunk) => tx.garnishment.findMany({
      where: {
        associateId: { in: chunk },
        status: 'ACTIVE',
        deletedAt: null,
        startDate: { lt: periodEndExclusive },
        OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
      },
      orderBy: [{ associateId: 'asc' }, { priority: 'asc' }],
    }));
    for (const g of garnRows) {
      const arr = garnsByAssociate.get(g.associateId) ?? [];
      arr.push(g);
      garnsByAssociate.set(g.associateId, arr);
    }
  }
  // Garnishment state rules (allocation, lower limits, fees) and the IRS
  // Publication 1494 figures a federal levy's exempt amount is built from.
  const garnStateRules: Record<string, StateRule> = {};
  const levyParams = new Map<string, LevyParameters>();
  if (garnsByAssociate.size > 0) {
    const [ruleRows, levyRows] = await Promise.all([
      tx.garnishmentStateRule ? tx.garnishmentStateRule.findMany({ where: { tenantId: tenantIdForWrite() } }) : [],
      tx.levyExemptParameter ? tx.levyExemptParameter.findMany({ where: { tenantId: tenantIdForWrite() } }) : [],
    ]);
    for (const r of ruleRows) {
      garnStateRules[r.state] = {
        allocationMethod: r.allocationMethod === 'FIRST_IN_TIME' ? 'FIRST_IN_TIME' : 'PRO_RATA',
        supportMaxPercent: r.supportMaxPercent != null ? Number(r.supportMaxPercent) : null,
        creditorMaxPercent: r.creditorMaxPercent != null ? Number(r.creditorMaxPercent) : null,
        adminFeeMax: r.adminFeeMax != null ? Number(r.adminFeeMax) : null,
        adminFeeFrequency: (r.adminFeeFrequency as StateRule['adminFeeFrequency']) ?? null,
      };
    }
    for (const l of levyRows) {
      levyParams.set(`${l.taxYear}:${l.filingStatus}`, {
        standardDeduction: Number(l.standardDeduction),
        additionalStandardDeduction: Number(l.additionalStandardDeduction),
        exemptionAmount: Number(l.exemptionAmount),
      });
    }
  }
  // 401(k) rate elections and loan repayments (lib/retirement).
  const retirementElections = await loadPayrollElections(tx, universeIds, periodStart, periodEndExclusive);

  // Contractors subject to backup withholding (IRC §3406): no TIN on file,
  // or the IRS said so (lib/contractors). Only read when the run pays a
  // contractor, so an all-W-2 run issues no extra query.
  const backupIds = new Set<string>();
  const contractorIds = universeIds.filter((id) => metaById.get(id)?.employmentType && metaById.get(id)!.employmentType !== 'W2_EMPLOYEE');
  if (contractorIds.length > 0) {
    const rows = await findInChunks(contractorIds, (chunk) =>
      tx.associate.findMany({
        where: { id: { in: chunk } },
        select: { id: true, tinEncrypted: true, contractorProfile: { select: { backupWithholding: true, backupReason: true, subjectToBackupCertified: true } } },
      }),
    );
    for (const r of rows) {
      if (backupRequirement(r.contractorProfile, !!r.tinEncrypted).required) backupIds.add(r.id);
    }
  }

  const reimbByAssociate = new Map<
    string,
    { id: string; totalAmount: Prisma.Decimal }[]
  >();
  if (universeIds.length > 0) {
    const reimbRows = await findInChunks(universeIds, (chunk) => tx.reimbursement.findMany({
      where: {
        associateId: { in: chunk },
        status: 'SETTLED',
        payrollItemId: null,
      },
      select: { id: true, totalAmount: true, associateId: true },
      orderBy: { settledAt: 'asc' },
    }));
    for (const r of reimbRows) {
      const arr = reimbByAssociate.get(r.associateId) ?? [];
      arr.push({ id: r.id, totalAmount: r.totalAmount });
      reimbByAssociate.set(r.associateId, arr);
    }
  }

  // State program caps (CA SDI has none; NJ TDI/FLI, WA PFML, MA … do): the
  // wages each program already took this calendar year, from prior checks'
  // STATE_PROGRAM tax lines. An employer line (code_ER) carries the same wages.
  const ytdProgramByAssociate = new Map<string, Record<string, number>>();
  // Supplemental wages paid so far this year, for the mandatory 37% tier past $1M.
  const ytdSupplementalByAssociate = new Map<string, number>();
  if (universeIds.length > 0 && tx.payrollItemTaxLine) {
    const priorWhere = {
      associateId: { in: universeIds },
      status: { not: 'VOIDED' as const },
      payrollRun: { status: { notIn: ['CANCELLED' as const, 'DRAFT' as const] }, periodStart: { gte: yearStart, lt: periodStart } },
    };
    const [programRows, suppRows] = await Promise.all([
      tx.payrollItemTaxLine.findMany({
        where: { kind: 'STATE_PROGRAM', payrollItem: priorWhere },
        select: { code: true, wages: true, payrollItemId: true, payrollItem: { select: { associateId: true } } },
      }),
      tx.payrollItemEarning
        ? tx.payrollItemEarning.findMany({
            where: { kind: { in: ['BONUS', 'COMMISSION'] }, payrollItem: priorWhere },
            select: { amount: true, payrollItem: { select: { associateId: true } } },
          })
        : [],
    ]);
    // One figure per check per program: the larger of its employee and employer lines.
    const perItem = new Map<string, { associateId: string; code: string; wages: number }>();
    for (const r of programRows) {
      const code = r.code.replace(/_ER$/, '');
      const k = `${r.payrollItemId}|${code}`;
      const w = Number(r.wages);
      const cur = perItem.get(k);
      if (!cur || w > cur.wages) perItem.set(k, { associateId: r.payrollItem.associateId, code, wages: w });
    }
    for (const v of perItem.values()) {
      const m = ytdProgramByAssociate.get(v.associateId) ?? {};
      m[v.code] = round2((m[v.code] ?? 0) + v.wages);
      ytdProgramByAssociate.set(v.associateId, m);
    }
    for (const r of suppRows) {
      const id = r.payrollItem.associateId;
      ytdSupplementalByAssociate.set(id, round2((ytdSupplementalByAssociate.get(id) ?? 0) + Number(r.amount)));
    }
  }
  // Covered employees on the payroll, for headcount-tiered programs (WA 50+, OR and MA 25+, CO 10+, DE, MN).
  const employerSize = tx.associate.count
    ? await tx.associate.count({ where: { tenantId: tenantIdForWrite(), deletedAt: null, employmentType: 'W2_EMPLOYEE' } })
    : undefined;
  const payDate = input.payDate ?? periodEndExclusive;

  const items: ProjectedItem[] = [];
  let totalGross = 0;
  let totalEmployeeTax = 0;
  let totalNet = 0;
  let totalEmployerTax = 0;
  let totalGarnishments = 0;

  for (const associateId of universe) {
    const meta = metaById.get(associateId);
    if (!meta) continue; // soft-deleted associate with a stray add-on
    const group = byAssociate.get(associateId) ?? [];
    const hoursWorked = group.length > 0 ? sumApprovedHours(group) : 0;
    const annualSalary = annualSalaryByAssociate.get(associateId);
    const myAddOns = addOnsByAssociate.get(associateId) ?? [];
    const tipsGross = tipsByAssociate.get(associateId) ?? 0;
    if (
      hoursWorked === 0 &&
      annualSalary === undefined &&
      myAddOns.length === 0 &&
      tipsGross === 0
    ) {
      continue;
    }

    // A DAILY schedule is paid each day by daily settlements (lib/dailyPay);
    // the run that reaches here is its weekly true-up, withheld as weekly.
    const scheduleFrequency = sf?.frequency ?? meta.payrollSchedule?.frequency ?? 'BIWEEKLY';
    const payFrequency: PayFrequency = scheduleFrequency === 'DAILY' ? 'WEEKLY' : scheduleFrequency;

    // Hourly earnings — skipped for salaried associates (exempt).
    let hourlyRate = 0;
    let otSplit = { regularHours: 0, overtimeHours: 0 };
    // FLSA weekly overtime (hours past 40 in a workweek) — the W-2 Box 12 TT base,
    // whatever a LIVE state pack pays on top (daily OT is state-only, not qualified).
    let flsaOtHours = 0;
    let regularPay = 0;
    let overtimePay = 0;
    // Set only under LIVE labor rules: the engine's multipliers, double time and premiums.
    let overtimeMultiplier = 1.5;
    let doubleTimeHours = 0;
    let doubleMultiplier = 2;
    let doubleTimePay = 0;
    const laborPremiums: ProjectedEarning[] = [];
    // Where the rate came from — surfaced on preview items so a silent
    // $15/hr default fallback (no comp record) is visible BEFORE money
    // moves, instead of requiring a row-by-row compare against People.
    let rateSource: 'OVERRIDE' | 'COMP' | 'DEFAULT' | 'SALARY' =
      annualSalary !== undefined ? 'SALARY' : 'DEFAULT';
    if (annualSalary === undefined && hoursWorked > 0) {
      // Rate resolution: an explicit caller override wins (the payroll
      // sheet passes one), then the associate's individual HOURLY comp
      // record, then the editable default (15). The shift rate is no
      // longer consulted — pay follows the person's contracted wage.
      if (input.hourlyRateOverride?.has(associateId)) rateSource = 'OVERRIDE';
      else if (hourlyRateByAssociate.has(associateId)) rateSource = 'COMP';
      hourlyRate =
        input.hourlyRateOverride?.get(associateId) ??
        hourlyRateByAssociate.get(associateId) ??
        defaultRate;
      const siteRef = (e: (typeof group)[number]) => (e.location ? { id: e.location.id, state: e.location.state, city: e.location.city } : null);
      if (liveRules.any && group.some((e) => liveRules.activationFor(siteRef(e)))) {
        // A LIVE jurisdiction: the engine splits the hours (daily, weekly,
        // seventh-day, double time) and names the premiums, under the rows
        // counsel signed; the person's other entries count as paid today.
        const lp = evaluateLivePay(
          liveRules,
          group
            .filter((e) => e.clockOutAt)
            .map((e) => ({
              id: e.id,
              clockInAt: e.clockInAt,
              clockOutAt: e.clockOutAt!,
              breaks: e.breaks,
              site: e.location ? { id: e.location.id, state: e.location.state, city: e.location.city, timezone: e.location.timezone } : null,
              mealWaived: mealAttestation.get(e.id) === 'WAIVED',
            })),
        );
        otSplit = { regularHours: lp.regularHours, overtimeHours: lp.overtimeHours };
        flsaOtHours = splitWeeklyOvertime(group).overtimeHours;
        overtimeMultiplier = lp.overtimeMultiplier;
        doubleTimeHours = lp.doubleTimeHours;
        doubleMultiplier = lp.doubleMultiplier;
        regularPay = round2(otSplit.regularHours * hourlyRate);
        overtimePay = round2(otSplit.overtimeHours * hourlyRate * overtimeMultiplier);
        doubleTimePay = round2(doubleTimeHours * hourlyRate * doubleMultiplier);
        const mealDays = new Set(lp.penalties.filter((p) => p.kind === 'MEAL').map((p) => p.entryId ?? p.date));
        for (const p of lp.penalties) {
          const amount = round2(p.hours * hourlyRate + (p.cents ?? 0) / 100);
          if (amount <= 0) continue;
          laborPremiums.push({ kind: 'PREMIUM', hours: p.hours || null, rate: p.hours ? hourlyRate : null, amount, isTaxable: true, note: p.label });
        }
        // The worker said they didn't get their meal break: the premium is owed even where the punches look clean.
        for (const e of group) {
          if (mealAttestation.get(e.id) !== 'NO' || mealDays.has(e.id)) continue;
          const site = siteRef(e);
          const rules = site ? liveRules.rulesFor(site, localParts(e.clockInAt, e.location?.timezone ?? 'America/New_York').date) : null;
          const ph = rules?.params.meal?.penaltyHours ?? 0;
          if (!rules || ph <= 0) continue;
          const cite = rules.origin['meal.requiredAfterHours'] ?? rules.layers[rules.layers.length - 1];
          laborPremiums.push({ kind: 'PREMIUM', hours: ph, rate: hourlyRate, amount: round2(ph * hourlyRate), isTaxable: true, note: `Meal premium — no meal break reported (${cite})` });
        }
      } else {
        otSplit = splitWeeklyOvertime(group);
        flsaOtHours = otSplit.overtimeHours;
        regularPay = round2(otSplit.regularHours * hourlyRate);
        overtimePay = round2(otSplit.overtimeHours * hourlyRate * 1.5);
      }
    }
    // Predictability pay owed for late schedule changes in LIVE jurisdictions.
    const myPremiums = premiumsByAssociate.get(associateId) ?? [];
    for (const p of myPremiums) {
      const amount = round2(Number(p.premiumHours) * (hourlyRate || 0) + p.premiumCents / 100);
      if (amount <= 0) continue;
      laborPremiums.push({ kind: 'PREMIUM', hours: Number(p.premiumHours) || null, rate: Number(p.premiumHours) ? hourlyRate : null, amount, isTaxable: true, note: `${p.rule} — shift ${p.change} ${p.workDate.toISOString().slice(0, 10)}` });
    }
    const laborPremiumPay = round2(laborPremiums.reduce((a, l) => a + l.amount, 0));

    // Tier-2 — client premium-pay rules applied to this associate's
    // entries: daily overtime past a threshold, and time-window / day-of-
    // week differentials. Weekly OT stays with the FLSA split above;
    // HOLIDAY / CALL_BACK / ON_CALL rules need a trigger source (holiday
    // calendar, call-out log) and are not auto-applied. Daily-OT premium
    // can stack with weekly OT on the same hours — conservative in the
    // employee's favor.
    const premiumEarnings: ProjectedEarning[] = [];
    let premiumPay = 0;
    if (annualSalary === undefined && group.length > 0) {
      const entryClientIds = [
        ...new Set(group.map((e) => e.clientId).filter((c): c is string => c !== null)),
      ];
      if (entryClientIds.length > 0) {
        const rules = entryClientIds.flatMap(
          (cid) => premiumRulesByClient.get(cid) ?? [],
        );
        for (const rule of rules) {
          const ruleEntries = group.filter(
            (e) => e.clientId === rule.clientId && e.status === 'APPROVED' && e.clockOutAt,
          );
          if (ruleEntries.length === 0) continue;
          let qualifyingHours = 0;
          if (rule.kind === 'OVERTIME_DAILY') {
            const threshold = rule.thresholdHours ? Number(rule.thresholdHours) : 8;
            for (const e of ruleEntries) {
              // Net of breaks — a 9h clock span with a 1h meal is 8h worked
              // and earns no daily OT past an 8h threshold.
              const h = payableMs(e) / 3_600_000;
              qualifyingHours += Math.max(0, h - threshold);
            }
          } else if (
            rule.kind === 'NIGHT_DIFFERENTIAL' ||
            rule.kind === 'WEEKEND_DIFFERENTIAL' ||
            rule.kind === 'SHIFT_DIFFERENTIAL'
          ) {
            for (const e of ruleEntries) {
              qualifyingHours += windowOverlapHours(
                e.clockInAt,
                e.clockOutAt!,
                {
                  startMinute: rule.startMinute,
                  endMinute: rule.endMinute,
                  dowMask: rule.dowMask,
                },
                // Entries without a location snapshot fall back to the
                // schema default zone (current deployment is single-region
                // Eastern) rather than UTC.
                e.location?.timezone ?? 'America/New_York',
              );
            }
          } else {
            continue;
          }
          qualifyingHours = round2(qualifyingHours);
          if (qualifyingHours <= 0) continue;
          const perHour =
            rule.addPerHour !== null
              ? Number(rule.addPerHour)
              : rule.multiplier !== null
                ? round2((Number(rule.multiplier) - 1) * hourlyRate)
                : 0;
          if (perHour <= 0) continue;
          const amount = round2(qualifyingHours * perHour);
          premiumPay = round2(premiumPay + amount);
          premiumEarnings.push({
            kind: rule.kind === 'OVERTIME_DAILY' ? 'DOUBLE_TIME' : 'REGULAR',
            hours: qualifyingHours,
            rate: perHour,
            amount,
            isTaxable: true,
            note: rule.name,
          });
        }
      }
    }

    const salaryPay =
      annualSalary !== undefined
        ? round2((annualSalary / PERIODS_PER_YEAR[payFrequency]) * (salaryShare.get(associateId) ?? 1))
        : 0;

    let supplementalGross = 0;
    let regularAddOnGross = 0;
    for (const a of myAddOns) {
      if (SUPPLEMENTAL_KINDS.has(a.kind)) supplementalGross += a.amount;
      else regularAddOnGross += a.amount;
    }
    supplementalGross = round2(supplementalGross);
    regularAddOnGross = round2(regularAddOnGross);

    const retroCands = retroByAssociate.get(associateId) ?? [];
    const retroPay = retroCands.length > 0 ? summarizeRetro(retroCands).amount : 0;

    const cashGross = round2(
      regularPay +
        overtimePay +
        doubleTimePay +
        laborPremiumPay +
        premiumPay +
        salaryPay +
        tipsGross +
        supplementalGross +
        regularAddOnGross +
        retroPay,
    );
    // Group-term life over $50,000 (IRS Pub 15-B Table I, lib/groupTermLife):
    // non-cash income, taxed on this check and reported in W-2 Box 12 C,
    // never paid out — it raises gross and comes back off net below.
    let imputedIncome = 0;
    if (meta.employmentType === 'W2_EMPLOYEE' && cashGross > 0) {
      for (const e of (enrollmentsByAssociate.get(associateId) ?? []) as Array<EnrollmentRow & { lifeCoverageCents?: number | null }>) {
        if (e.plan.kind !== 'LIFE_INSURANCE' || !e.lifeCoverageCents) continue;
        imputedIncome = round2(
          imputedIncome +
            groupTermLifeImputed({ coverageCents: e.lifeCoverageCents, dob: meta.dob ?? null, taxYear: periodStart.getUTCFullYear(), periodsPerYear: PERIODS_PER_YEAR[payFrequency] }).imputedIncome,
        );
      }
    }
    const grossPay = round2(cashGross + imputedIncome);

    // Gap 8 — live YTD aggregation. Excludes CANCELLED (voided) runs and
    // non-DISBURSED items; AMENDMENT items contribute signed deltas so
    // corrections naturally land in the result. Medicare base is the same
    // number today (see payrollYtd.ts) — both read the one batched map.
    const ytdWages = ytdByAssociate.get(associateId) ?? 0;
    const ytdMedicareWages = ytdWages;

    const w4 = meta.w4Submission;
    const associateState =
      input.stateOverride !== undefined
        ? input.stateOverride
        : clientWorkState ?? meta.state ?? null;
    const employmentType = meta.employmentType;

    let preTaxDeductions = 0;
    let preTaxRetirement = 0;
    let rothDeferral = 0;
    let deferrals: DeferralRecord | null = null;
    let perPlan: PlanDeduction[] = [];
    if (employmentType === 'W2_EMPLOYEE') {
      // One election per deferral: the benefits enrollment (a 401(k) rate is
      // stored on it as a percent and turned into this paycheck's cents).
      const enrollments = (enrollmentsByAssociate.get(associateId) ?? []).flatMap((e) => enrollmentFacts(e, grossPay));
      if (enrollments.length > 0) {
        // Annual limits, catch-up and the Roth catch-up rule (lib/retirementDeferrals).
        const ded = computeCheckDeductions(enrollments, deferralContexts.get(associateId), deferralYear);
        preTaxDeductions = ded.preTax;
        preTaxRetirement = ded.preTaxRetirement;
        rothDeferral = ded.roth;
        deferrals = ded.deferrals;
        perPlan = ded.perPlan ?? [];
      }
    }
    // Where the person worked and lives, for each deduction's state treatment.
    const workStatesHere = [
      ...new Set(
        group
          .map((e) => (e.location?.state ?? clientWorkState ?? meta.state ?? null)?.toUpperCase() ?? null)
          .filter((x): x is string => !!x),
      ),
    ];
    if (workStatesHere.length === 0 && associateState) workStatesHere.push(associateState.toUpperCase());
    const taxCtx: TaxabilityContext = {
      workStates: workStatesHere,
      residentState: (meta.state ?? associateState ?? null)?.toUpperCase() ?? null,
      localApplies: [...workStatesHere, (meta.state ?? '').toUpperCase()].some((st) => LOCAL_TAX_STATES.has(st)),
    };
    // The wage bases, by tax and by state, from the pre-tax lines' treatment.
    const wageBases: TaxableWages | null = employmentType === 'W2_EMPLOYEE'
      ? taxableWages(grossPay, buildDeductionLines({ perPlan, garnishments: [], loans: [], employerRetirement: 0, ctx: taxCtx }), taxCtx)
      : null;
    // FIT base subtracts ALL pre-tax (Section 125 + retirement).
    // FICA / Medicare base subtracts ONLY the Section 125 slice — retirement
    // contributions are FIT-deferred but FICA-includable per IRS rules.
    const fitGross = round2(Math.max(0, grossPay - preTaxDeductions));
    const ficaMedicareGross = round2(
      Math.max(0, grossPay - (preTaxDeductions - preTaxRetirement)),
    );

    let breakdown: PaycheckTaxBreakdown;
    // The W-4 as withholding must read it on the pay date (lib/payrollTax
    // federalW4Fields): Step 2 two-jobs, an exemption past February 15, the
    // nonresident-alien add-on, a 2019-or-earlier W-4, an IRS lock-in letter.
    const fedW4 = federalW4Fields(w4, payDate);
    if (employmentType === 'W2_EMPLOYEE') {
      const w4Fields = {
        filingStatus: fedW4?.filingStatus ?? null,
        payFrequency,
        state: associateState,
        ytdWages,
        ytdMedicareWages,
        extraWithholding: fedW4?.extraWithholding ?? 0,
        deductions: fedW4?.deductions ?? 0,
        otherIncome: fedW4?.otherIncome ?? 0,
        dependentsAmount: fedW4?.dependentsAmount ?? 0,
        multipleJobs: fedW4?.multipleJobs ?? false,
        pre2020Allowances: fedW4?.pre2020Allowances ?? null,
        nonresidentAlien: fedW4?.nonresidentAlien ?? false,
        exempt: fedW4?.exempt ?? false,
        sutaOverride,
        // TAXCOMP — the state's own certificate for the state taxed here.
        stateW4: (() => {
          const c = associateState ? meta.stateW4s?.find((x) => x.state === associateState.toUpperCase()) : undefined;
          return c
            ? { filingStatus: c.filingStatus, allowances: c.allowances, dependents: c.dependents, additionalWithholding: Number(c.additionalWithholding), exempt: c.exempt, county: c.county }
            : null;
        })(),
      };
      // Full-gross pass drives SS / Medicare / SIT / employer taxes.
      const full = computePaycheckTaxes({
        grossPay: fitGross,
        ficaMedicareGross,
        ...w4Fields,
      });
      if (supplementalGross > 0) {
        // Pub 15 §7 — supplemental wages (bonus/commission) identified
        // separately from regular wages withhold FIT at the 22% flat
        // rate; the percentage method applies to the rest. FICA /
        // Medicare / SIT stay on the combined base (from `full`).
        const regularFitGross = round2(
          Math.max(0, grossPay - supplementalGross - preTaxDeductions),
        );
        const regularPass = computePaycheckTaxes({
          grossPay: regularFitGross,
          ficaMedicareGross,
          ...w4Fields,
        });
        // 22%, and 37% on the part that takes the year's supplemental wages past $1,000,000 (Pub 15 §7).
        const supplementalFit = fedW4?.exempt ? 0 : supplementalFederalWithholding(supplementalGross, ytdSupplementalByAssociate.get(associateId) ?? 0, periodStart.getUTCFullYear());
        const fit = round2(regularPass.federalIncomeTax + supplementalFit);
        const totalEmp = round2(
          fit + full.socialSecurity + full.medicare + full.stateIncomeTax,
        );
        breakdown = {
          ...full,
          federalIncomeTax: fit,
          totalEmployeeTax: totalEmp,
          netPay: round2(fitGross - totalEmp),
        };
      } else {
        breakdown = full;
      }
    } else {
      breakdown = zeroTaxBreakdown(grossPay);
      if (backupIds.has(associateId) && grossPay > 0) {
        // Backup withholding: 24% to the IRS, reported in 1099 Box 4.
        const backup = backupAmount(grossPay, true);
        breakdown = { ...breakdown, federalIncomeTax: backup, totalEmployeeTax: backup, netPay: round2(grossPay - backup) };
      }
    }

    // A state that doesn't follow the federal treatment of a deduction (PA
    // taxes 401(k) deferrals, NJ taxes §125 and HSA, CA taxes HSA): its
    // income tax is figured on its own base (lib/deductionTaxability).
    if (employmentType === 'W2_EMPLOYEE' && associateState && wageBases && breakdown.stateIncomeTax >= 0) {
      const stBase = wageBases.stateIncome[associateState.toUpperCase()];
      if (stBase !== undefined && Math.abs(stBase - fitGross) >= 0.01) {
        const stateOnly = computePaycheckTaxes({
          grossPay: stBase,
          ficaMedicareGross,
          filingStatus: w4?.filingStatus ?? null,
          payFrequency,
          state: associateState,
          ytdWages,
          ytdMedicareWages,
          extraWithholding: 0,
          deductions: 0,
          otherIncome: 0,
          dependentsAmount: 0,
          sutaOverride,
          stateW4: (() => {
            const c = meta.stateW4s?.find((x) => x.state === associateState.toUpperCase());
            return c ? { filingStatus: c.filingStatus, allowances: c.allowances, dependents: c.dependents, additionalWithholding: Number(c.additionalWithholding), exempt: c.exempt, county: c.county } : null;
          })(),
        }).stateIncomeTax;
        const delta = round2(stateOnly - breakdown.stateIncomeTax);
        if (delta !== 0) {
          breakdown = { ...breakdown, stateIncomeTax: stateOnly, totalEmployeeTax: round2(breakdown.totalEmployeeTax + delta), netPay: round2(breakdown.netPay - delta) };
        }
      }
    }

    // Tier-2 — city/county withholding on gross (Philadelphia-style flat
    // wage tax). W-2 employees only; zero without an assigned rule. An
    // assigned rule is a manual override: it replaces the engine's locals.
    const manualLocalRule = employmentType === 'W2_EMPLOYEE' && meta.localTaxRule?.isActive && grossPay > 0;
    let localIncomeTax = manualLocalRule ? round2(grossPay * Number(meta.localTaxRule!.rate)) : 0;

    // The tax engine (lib/taxEngine): state by work site and residence with
    // reciprocity and credits, and the local taxes (PA EIT/LST, Ohio cities,
    // NYC, Michigan, Indiana counties, Kentucky OLTs …). The payroll sheet's
    // explicit state override keeps the old single-state answer.
    let taxLines: TaxLine[] = [];
    let taxEngineKey: ProjectedItem['taxEngine'] = null;
    let taxEngineFallback: string | null = null;
    let taxJurisdictions: string[] = [];
    let taxUnresolved: string[] = [];
    let suiState: string | null = associateState;
    let wagesByState: Record<string, number> = associateState ? { [associateState]: fitGross } : {};
    let employerLocalTax = 0;
    let stateProgramTax = 0;
    let employerProgramTax = 0;
    if (employmentType === 'W2_EMPLOYEE' && grossPay > 0 && input.stateOverride === undefined) {
      const work = group.map((e) => ({
        state: e.location?.state ?? clientWorkState ?? meta.state ?? null,
        city: e.location?.city ?? null,
        zip: e.location?.zip ?? null,
        hours: sumApprovedHours([e]),
      }));
      const profile = meta.taxProfile;
      const result = await calculateTaxes(input.taxEngine ?? inHouseEngine, {
        wages: fitGross,
        payFrequency,
        residence: {
          state: meta.state ?? associateState,
          city: meta.city ?? null,
          zip: meta.zip ?? null,
          psdCode: profile?.residentPsdCode ?? null,
          municipality: profile?.residentMunicipality ?? null,
          schoolDistrict: profile?.residentSchoolDistrict ?? null,
          countyJan1: profile?.residentCountyJan1 ?? null,
          localCode: profile?.residentLocalCode ?? null,
        },
        work: work.length > 0 && work.some((w) => w.hours > 0) ? work : [{ state: associateState, city: null, hours: 1 }],
        certificates: meta.taxCertificates ?? [],
        federalFilingStatus: w4?.filingStatus ?? null,
        federalCycleWithholding: breakdown.federalIncomeTax,
        stateW4s: Object.fromEntries(
          (meta.stateW4s ?? []).map((c) => [
            c.state,
            { filingStatus: c.filingStatus, allowances: c.allowances, dependents: c.dependents, additionalWithholding: Number(c.additionalWithholding), exempt: c.exempt, county: c.county },
          ]),
        ),
        // Each state's own base for the deductions it treats differently (lib/deductionTaxability).
        ...(wageBases ? { bases: { stateIncome: wageBases.stateIncome, stateProgram: wageBases.stateProgram, stateUi: wageBases.stateUi, local: wageBases.local } } : {}),
        // State disability, paid leave and employee UI shares (taxEngine/statePrograms).
        includePrograms: true,
        ytdProgramWages: ytdProgramByAssociate.get(associateId) ?? {},
        ...(employerSize !== undefined ? { employerSize } : {}),
      });
      stateProgramTax = result.programTotal ?? 0;
      employerProgramTax = result.employerProgramTotal ?? 0;
      taxEngineKey = result.engine;
      taxEngineFallback = result.fallbackReason;
      suiState = result.sui.state;
      wagesByState = result.wagesByState;
      // One state, the same one the paycheck calculator taxed: keep its
      // answer to the cent (it carries the supplemental split); otherwise
      // the engine's multi-state answer replaces it.
      const stateLines = result.lines.filter((l) => l.kind === 'STATE');
      const singleSame =
        stateLines.length <= 1 &&
        Object.keys(result.wagesByState).length <= 1 &&
        (stateLines[0]?.workState ?? associateState) === associateState;
      let stateTotal = result.stateTotal;
      if (singleSame) {
        stateTotal = breakdown.stateIncomeTax;
        if (stateLines[0]) stateLines[0] = { ...stateLines[0], amount: stateTotal };
      }
      const others = result.lines.filter((l) => l.kind !== 'STATE');
      const localLines = manualLocalRule ? others.filter((l) => l.kind === 'SUI' || l.kind === 'STATE_PROGRAM') : others;
      taxLines = [...stateLines, ...localLines];
      if (manualLocalRule) {
        taxLines.push({ code: 'LOCAL_RULE', kind: 'LOCAL', label: meta.localTaxRule!.name, resident: true, workState: associateState, wages: grossPay, amount: localIncomeTax, employer: false, note: 'Set by hand on the person; it replaces the local taxes the engine would work out.' });
      } else {
        localIncomeTax = result.localTotal;
        employerLocalTax = result.employerLocalTotal;
        taxJurisdictions = result.jurisdictionsUsed;
      }
      taxUnresolved = manualLocalRule ? [] : result.unresolved;
      const stateDelta = round2(stateTotal - breakdown.stateIncomeTax);
      if (stateDelta !== 0) {
        breakdown = {
          ...breakdown,
          stateIncomeTax: stateTotal,
          totalEmployeeTax: round2(breakdown.totalEmployeeTax + stateDelta),
          netPay: round2(breakdown.netPay - stateDelta),
        };
      }
    }
    if (localIncomeTax > 0) {
      breakdown = {
        ...breakdown,
        totalEmployeeTax: round2(breakdown.totalEmployeeTax + localIncomeTax),
        netPay: round2(breakdown.netPay - localIncomeTax),
      };
    }
    // State programs withheld (SDI, TDI/FLI, PFML, employee UI): a tax, out of net.
    if (stateProgramTax > 0) {
      breakdown = {
        ...breakdown,
        totalEmployeeTax: round2(breakdown.totalEmployeeTax + stateProgramTax),
        netPay: round2(breakdown.netPay - stateProgramTax),
      };
    }

    const disposableEarnings =
      employmentType === 'W2_EMPLOYEE'
        ? round2(
            grossPay -
              breakdown.federalIncomeTax -
              breakdown.socialSecurity -
              breakdown.medicare -
              breakdown.stateIncomeTax -
              localIncomeTax -
              // Amounts required by law to be withheld (CCPA): state disability and paid leave too.
              stateProgramTax -
              // Non-cash income is nothing to garnish.
              imputedIncome
          )
        : 0;

    const activeGarns =
      employmentType === 'W2_EMPLOYEE' && disposableEarnings > 0
        ? garnsByAssociate.get(associateId) ?? []
        : [];

    const levyYear = periodStart.getUTCFullYear();
    // Daily pay has no CCPA period figure of its own; the minimum-wage floor is applied per period otherwise.
    const garnFrequency: GarnFrequency | undefined = (payFrequency as string) === 'DAILY' ? undefined : (payFrequency as GarnFrequency);
    const garnResult = computeGarnishmentDeductions({
      disposableEarnings,
      // A federal levy reaches take-home pay: after taxes and the pre-tax deductions in effect.
      takeHomePay: round2(disposableEarnings - preTaxDeductions),
      payFrequency: garnFrequency,
      stateRules: garnStateRules,
      rules: activeGarns.map((g) => {
        const params = g.levyFilingStatus ? levyParams.get(`${g.levyTaxYear ?? levyYear}:${g.levyFilingStatus}`) : undefined;
        return {
          id: g.id,
          kind: g.kind,
          amountPerRun: g.amountPerRun !== null ? Number(g.amountPerRun) : null,
          percentOfDisp: g.percentOfDisp !== null ? Number(g.percentOfDisp) : null,
          totalCap: g.totalCap !== null ? Number(g.totalCap) : null,
          amountWithheld: Number(g.amountWithheld),
          priority: g.priority,
          receivedAt: g.receivedAt ?? g.startDate,
          state: g.state,
          currentSupport: g.currentSupport != null ? Number(g.currentSupport) : null,
          pastDueSupport: g.pastDueSupport != null ? Number(g.pastDueSupport) : null,
          medicalSupport: g.medicalSupport != null ? Number(g.medicalSupport) : null,
          orderFrequency: (g.orderFrequency as GarnFrequency | null) ?? null,
          arrearsOver12Weeks: g.arrearsOver12Weeks,
          supportsSecondFamily: g.supportsSecondFamily,
          adminFee: g.adminFee != null ? Number(g.adminFee) : null,
          levyExemptPerPeriod:
            g.kind === 'TAX_LEVY' && params && garnFrequency
              ? levyExemptPerPeriod(params, g.levyExemptions ?? 0, g.levyAdditionalStandard, garnFrequency)
              : null,
        };
      }),
    });

    // Garnishments (and the fees states allow), then Roth deferrals, then 401(k)
    // loan repayments — after tax; disposable earnings are figured before any.
    const electionHere = employmentType === 'W2_EMPLOYEE' ? retirementElections.get(associateId) : undefined;
    const loanRoom = round2(breakdown.netPay - garnResult.total - garnResult.adminFeeTotal - rothDeferral);
    const retirement = electionHere ? projectRetirement(electionHere, grossPay, deferrals, loanRoom) : null;
    const loanTotal = round2((retirement?.loanRepayments ?? []).reduce((sum, l) => sum + l.amount, 0));
    const postTaxDeductions = round2(garnResult.total + garnResult.adminFeeTotal + rothDeferral + loanTotal);

    // Gap 10 — fold settled-but-unpaid reimbursements into this item.
    // Read-only here (preview safe); persistence is run-creation's job.
    // Accountable-plan rule: amount is added AFTER taxes and never
    // touches grossPay / taxableGross / any wage base.
    const settledReimbursements = reimbByAssociate.get(associateId) ?? [];
    const reimbursementsTotal = round2(
      settledReimbursements.reduce((sum, r) => sum + Number(r.totalAmount), 0)
    );
    const reimbursementIds = settledReimbursements.map((r) => r.id);

    const finalNetPay = round2(
      breakdown.netPay - postTaxDeductions + reimbursementsTotal - imputedIncome
    );

    const earnings: ProjectedEarning[] = [];
    if (otSplit.regularHours > 0) {
      earnings.push({
        kind: 'REGULAR',
        hours: otSplit.regularHours,
        rate: hourlyRate,
        amount: regularPay,
        isTaxable: true,
      });
    }
    if (otSplit.overtimeHours > 0) {
      earnings.push({
        kind: 'OVERTIME',
        hours: otSplit.overtimeHours,
        rate: round2(hourlyRate * overtimeMultiplier),
        amount: overtimePay,
        isTaxable: true,
      });
    }
    if (doubleTimeHours > 0) {
      earnings.push({
        kind: 'DOUBLE_TIME',
        hours: doubleTimeHours,
        rate: round2(hourlyRate * doubleMultiplier),
        amount: doubleTimePay,
        isTaxable: true,
        note: 'Double time',
      });
    }
    earnings.push(...laborPremiums);
    earnings.push(...premiumEarnings);
    if (salaryPay > 0) {
      // Flat per-period salary — REGULAR with no hours/rate (the enum
      // has no SALARY member; hours-null is the salaried signature).
      earnings.push({
        kind: 'REGULAR',
        hours: null,
        rate: null,
        amount: salaryPay,
        isTaxable: true,
      });
    }
    if (tipsGross > 0) {
      earnings.push({
        kind: 'TIPS',
        hours: null,
        rate: null,
        amount: tipsGross,
        isTaxable: true,
        note: 'Tip pool allocation',
      });
    }
    for (const a of myAddOns) {
      earnings.push({
        kind: a.kind,
        hours: a.hours,
        rate: null,
        amount: round2(a.amount),
        isTaxable: true,
      });
    }
    if (retroPay > 0) {
      earnings.push({
        kind: 'RETRO',
        hours: null,
        rate: null,
        amount: retroPay,
        isTaxable: true,
        note: summarizeRetro(retroCands).note,
      });
    }
    if (imputedIncome > 0) {
      earnings.push({
        kind: 'IMPUTED_INCOME',
        hours: null,
        rate: null,
        amount: imputedIncome,
        isTaxable: true,
        note: 'Group-term life insurance over $50,000 — taxable value (IRS Table I), not paid out',
      });
    }

    // 2026 W-2: Box 12 TP (cash tips reported to the employer — tip-pool
    // allocations and tip add-ons on this check) and TT (the FLSA overtime
    // premium: half the regular rate for each hour past 40 in a workweek;
    // exempt jobs have none). Source: IRS 2026 Form W-2 instructions (OBBBA).
    const qualifiedTips = round2(tipsGross + myAddOns.filter((a) => a.kind === 'TIPS').reduce((t, a) => t + a.amount, 0));
    const qualifiedOvertime = meta.jobProfile?.isExempt ? 0 : round2(0.5 * hourlyRate * flsaOtHours);
    const associateName = `${meta.firstName} ${meta.lastName}`.trim();

    // Every deduction, itemized; the lump columns are their sums.
    const garnById = new Map(activeGarns.map((g) => [g.id, g]));
    const deductionLines = employmentType === 'W2_EMPLOYEE'
      ? reconcile(
          buildDeductionLines({
            perPlan,
            garnishments: garnResult.deductions.map((d) => {
              const g = garnById.get(d.garnishmentId);
              return { garnishmentId: d.garnishmentId, amount: d.amount, adminFee: d.adminFee ?? 0, kind: g?.kind ?? 'OTHER', caseNumber: g?.caseNumber ?? null, state: g?.state ?? null, agencyName: g?.agencyName ?? null };
            }),
            loans: (retirement?.loanRepayments ?? []).map((l) => ({ loanNumber: l.loanNumber, amount: l.amount })),
            employerRetirement: retirement ? round2(retirement.employerMatch + retirement.safeHarbor) : 0,
            retirementPlanId: retirement?.planId ?? null,
            ctx: taxCtx,
          }),
          { preTax: preTaxDeductions, postTax: postTaxDeductions },
          taxCtx,
        )
      : [];

    items.push({
      associateId,
      associateName,
      hoursWorked,
      hourlyRate,
      rateSource,
      regularHours: otSplit.regularHours,
      overtimeHours: otSplit.overtimeHours,
      earnings,
      grossPay,
      preTaxDeductions,
      preTaxRetirement,
      federalIncomeTax: breakdown.federalIncomeTax,
      fica: breakdown.socialSecurity,
      medicare: breakdown.medicare,
      stateIncomeTax: breakdown.stateIncomeTax,
      localIncomeTax,
      taxState: associateState,
      payFrequency,
      disposableEarnings,
      garnishments: garnResult.deductions,
      postTaxDeductions,
      reimbursementsTotal,
      reimbursementIds,
      retro: retroCands,
      premiumIds: myPremiums.map((p) => p.id),
      retroPay,
      netPay: finalNetPay,
      employerFica: breakdown.employer.fica,
      employerMedicare: breakdown.employer.medicare,
      employerFuta: breakdown.employer.futa,
      employerSuta: breakdown.employer.suta,
      ytdWages,
      ytdMedicareWages,
      qualifiedTips,
      qualifiedOvertime,
      tippedOccupationCode: meta.jobProfile?.tippedOccupationCode ?? null,
      rothDeferral,
      deferrals,
      retirement,
      taxLines,
      taxEngine: taxEngineKey,
      taxEngineFallback,
      taxJurisdictions,
      taxUnresolved,
      suiState,
      wagesByState,
      employerLocalTax,
      deductionLines,
      taxableWages: wageBases,
      stateProgramTax,
      employerProgramTax,
      w4Flags: fedW4?.flags ?? [],
    });

    totalGross += grossPay;
    totalEmployeeTax += breakdown.totalEmployeeTax;
    totalNet += finalNetPay;
    totalEmployerTax +=
      breakdown.employer.fica +
      breakdown.employer.medicare +
      breakdown.employer.futa +
      breakdown.employer.suta +
      employerLocalTax +
      employerProgramTax;
    totalGarnishments += postTaxDeductions;
  }

  return {
    items,
    totals: {
      totalGross: round2(totalGross),
      totalEmployeeTax: round2(totalEmployeeTax),
      totalNet: round2(totalNet),
      totalEmployerTax: round2(totalEmployerTax),
      totalGarnishments: round2(totalGarnishments),
      itemCount: items.length,
    },
    consumedTipPoolIds: [...consumedTipPoolIds],
  };
}
