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

import type { BenefitsPlanKind, Prisma, PrismaClient } from '@prisma/client';
import {
  pickHourlyRate,
  round2,
  splitWeeklyOvertime,
  sumApprovedHours,
} from './payroll.js';

/**
 * Gap 1 — IRS pre-tax classification. Traditional retirement (401k/403b)
 * is FIT-deferred but FICA-includable, so it must NOT reduce the FICA /
 * Medicare wage base. Section 125 cafeteria-plan items (health/dental/
 * vision/HSA/FSA) reduce all three. Imputed-income items (life/disability
 * over the §79 threshold) are out of scope here — assume cafeteria-plan
 * for now and revisit if HR ever offers >$50k group-term life.
 */
function classifyPreTax(kind: BenefitsPlanKind): 'FIT_ONLY' | 'ALL_THREE' {
  switch (kind) {
    case 'RETIREMENT_401K':
    case 'RETIREMENT_403B':
      return 'FIT_ONLY';
    default:
      return 'ALL_THREE';
  }
}
import {
  computePaycheckTaxes,
  zeroTaxBreakdown,
  type PaycheckTaxBreakdown,
  type PayFrequency,
} from './payrollTax.js';
import { computeGarnishmentDeductions } from './garnishments.js';
import { computeYtdMedicareWages, computeYtdWages } from './payrollYtd.js';

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
const SUPPLEMENTAL_FLAT_RATE = 0.22;

const PERIODS_PER_YEAR: Record<PayFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
};

export interface ProjectedEarning {
  kind: 'REGULAR' | 'OVERTIME' | 'DOUBLE_TIME' | AddOnKind;
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
 * day-of-week mask (bit N = UTC day N, Sunday=0). A null window means
 * the whole day; an end minute at or before the start minute wraps past
 * midnight.
 */
function windowOverlapHours(
  start: Date,
  end: Date,
  rule: { startMinute: number | null; endMinute: number | null; dowMask: number | null },
): number {
  const DAY_MS = 86_400_000;
  const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  let totalMs = 0;
  const firstDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  for (let dayStart = firstDay; dayStart < end.getTime(); dayStart += DAY_MS) {
    const dow = new Date(dayStart).getUTCDay();
    if (rule.dowMask !== null && !((rule.dowMask >> dow) & 1)) continue;
    const s = rule.startMinute ?? 0;
    const e = rule.endMinute ?? 1440;
    if (rule.startMinute !== null && rule.endMinute !== null && e <= s) {
      // Wraps midnight: [s..24:00) tonight + [00:00..e) tomorrow morning.
      totalMs += overlap(start.getTime(), end.getTime(), dayStart + s * 60_000, dayStart + DAY_MS);
      totalMs += overlap(start.getTime(), end.getTime(), dayStart, dayStart + e * 60_000);
    } else {
      totalMs += overlap(start.getTime(), end.getTime(), dayStart + s * 60_000, dayStart + e * 60_000);
    }
  }
  return totalMs / 3_600_000;
}

export interface ProjectedGarnishment {
  garnishmentId: string;
  amount: number;
  reachedCap: boolean;
}

export interface ProjectedItem {
  associateId: string;
  associateName: string;
  hoursWorked: number;
  hourlyRate: number;
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
  netPay: number;
  /** Employer-side accruals (informational; not deducted from net). */
  employerFica: number;
  employerMedicare: number;
  employerFuta: number;
  employerSuta: number;
  /** Pre-paycheck YTD snapshots used for FICA cap + Medicare surcharge. */
  ytdWages: number;
  ytdMedicareWages: number;
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
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          employmentType: true,
          payrollSchedule: { select: { frequency: true } },
          localTaxRule: { select: { rate: true, isActive: true, name: true } },
          w4Submission: {
            select: {
              filingStatus: true,
              extraWithholding: true,
              deductions: true,
              otherIncome: true,
              dependentsAmount: true,
            },
          },
        },
      },
    },
  });

  const byAssociate = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byAssociate.get(e.associateId) ?? [];
    arr.push(e);
    byAssociate.set(e.associateId, arr);
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
      effectiveFrom: { lte: periodEndExclusive },
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

  // Associates in the universe with no time entries still need their W-4 /
  // schedule / state metadata.
  const ASSOCIATE_META_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    state: true,
    employmentType: true,
    payrollSchedule: { select: { frequency: true } },
    localTaxRule: { select: { rate: true, isActive: true, name: true } },
    w4Submission: {
      select: {
        filingStatus: true,
        extraWithholding: true,
        deductions: true,
        otherIncome: true,
        dependentsAmount: true,
      },
    },
  } as const;
  type AssociateMeta = Prisma.AssociateGetPayload<{ select: typeof ASSOCIATE_META_SELECT }>;
  const metaById = new Map<string, AssociateMeta>();
  for (const [id, group] of byAssociate) metaById.set(id, group[0].associate);
  const missingIds = [...universe].filter((id) => !metaById.has(id));
  if (missingIds.length > 0) {
    const extra = await tx.associate.findMany({
      where: { id: { in: missingIds }, deletedAt: null },
      select: ASSOCIATE_META_SELECT,
    });
    for (const a of extra) metaById.set(a.id, a);
  }

  // Tier-2 — the client's actual SUTA experience rate (state agency
  // notice) beats the new-employer default. Client-scoped runs only;
  // cross-client runs keep the per-state defaults.
  let sutaOverride: { rate: number; wageBase: number | null } | null = null;
  if (clientId) {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { sutaRateOverride: true, sutaWageBaseOverride: true },
    });
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

    const payFrequency: PayFrequency =
      meta.payrollSchedule?.frequency ?? 'BIWEEKLY';

    // Hourly earnings — skipped for salaried associates (exempt).
    let hourlyRate = 0;
    let otSplit = { regularHours: 0, overtimeHours: 0 };
    let regularPay = 0;
    let overtimePay = 0;
    if (annualSalary === undefined && hoursWorked > 0) {
      const overrideRate = input.hourlyRateOverride?.get(associateId);
      if (overrideRate !== undefined) {
        hourlyRate = overrideRate;
      } else {
        const shifts = await tx.shift.findMany({
          where: {
            assignedAssociateId: associateId,
            startsAt: { gte: periodStart, lt: periodEndExclusive },
          },
          select: { hourlyRate: true },
        });
        hourlyRate = pickHourlyRate(shifts, defaultRate);
      }
      otSplit = splitWeeklyOvertime(group);
      regularPay = round2(otSplit.regularHours * hourlyRate);
      overtimePay = round2(otSplit.overtimeHours * hourlyRate * 1.5);
    }

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
        const rules = await tx.premiumPayRule.findMany({
          where: { isActive: true, clientId: { in: entryClientIds } },
        });
        for (const rule of rules) {
          const ruleEntries = group.filter(
            (e) => e.clientId === rule.clientId && e.status === 'APPROVED' && e.clockOutAt,
          );
          if (ruleEntries.length === 0) continue;
          let qualifyingHours = 0;
          if (rule.kind === 'OVERTIME_DAILY') {
            const threshold = rule.thresholdHours ? Number(rule.thresholdHours) : 8;
            for (const e of ruleEntries) {
              const h = (e.clockOutAt!.getTime() - e.clockInAt.getTime()) / 3_600_000;
              qualifyingHours += Math.max(0, h - threshold);
            }
          } else if (
            rule.kind === 'NIGHT_DIFFERENTIAL' ||
            rule.kind === 'WEEKEND_DIFFERENTIAL' ||
            rule.kind === 'SHIFT_DIFFERENTIAL'
          ) {
            for (const e of ruleEntries) {
              qualifyingHours += windowOverlapHours(e.clockInAt, e.clockOutAt!, {
                startMinute: rule.startMinute,
                endMinute: rule.endMinute,
                dowMask: rule.dowMask,
              });
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
        ? round2(annualSalary / PERIODS_PER_YEAR[payFrequency])
        : 0;

    let supplementalGross = 0;
    let regularAddOnGross = 0;
    for (const a of myAddOns) {
      if (SUPPLEMENTAL_KINDS.has(a.kind)) supplementalGross += a.amount;
      else regularAddOnGross += a.amount;
    }
    supplementalGross = round2(supplementalGross);
    regularAddOnGross = round2(regularAddOnGross);

    const grossPay = round2(
      regularPay +
        overtimePay +
        premiumPay +
        salaryPay +
        tipsGross +
        supplementalGross +
        regularAddOnGross,
    );

    // Gap 8 — live YTD aggregation. Excludes CANCELLED (voided) runs and
    // non-DISBURSED items; AMENDMENT items contribute signed deltas so
    // corrections naturally land in the result.
    const ytdWages = await computeYtdWages(tx, associateId, yearStart, periodStart);
    const ytdMedicareWages = await computeYtdMedicareWages(tx, associateId, yearStart, periodStart);

    const w4 = meta.w4Submission;
    const associateState =
      input.stateOverride !== undefined
        ? input.stateOverride
        : meta.state ?? null;
    const employmentType = meta.employmentType;

    let preTaxDeductions = 0;
    let preTaxRetirement = 0;
    if (employmentType === 'W2_EMPLOYEE') {
      const enrollments = await tx.benefitsEnrollment.findMany({
        where: {
          associateId,
          effectiveDate: { lte: periodEndExclusive },
          OR: [
            { terminationDate: null },
            { terminationDate: { gte: periodStart } },
          ],
        },
        select: {
          electedAmountCentsPerPeriod: true,
          plan: { select: { kind: true } },
        },
      });
      let totalCents = 0;
      let retirementCents = 0;
      for (const e of enrollments) {
        totalCents += e.electedAmountCentsPerPeriod;
        if (classifyPreTax(e.plan.kind) === 'FIT_ONLY') {
          retirementCents += e.electedAmountCentsPerPeriod;
        }
      }
      preTaxDeductions = round2(totalCents / 100);
      preTaxRetirement = round2(retirementCents / 100);
    }
    // FIT base subtracts ALL pre-tax (Section 125 + retirement).
    // FICA / Medicare base subtracts ONLY the Section 125 slice — retirement
    // contributions are FIT-deferred but FICA-includable per IRS rules.
    const fitGross = round2(Math.max(0, grossPay - preTaxDeductions));
    const ficaMedicareGross = round2(
      Math.max(0, grossPay - (preTaxDeductions - preTaxRetirement)),
    );

    let breakdown: PaycheckTaxBreakdown;
    if (employmentType === 'W2_EMPLOYEE') {
      const w4Fields = {
        filingStatus: w4?.filingStatus ?? null,
        payFrequency,
        state: associateState,
        ytdWages,
        ytdMedicareWages,
        extraWithholding: w4?.extraWithholding ? Number(w4.extraWithholding) : 0,
        deductions: w4?.deductions ? Number(w4.deductions) : 0,
        otherIncome: w4?.otherIncome ? Number(w4.otherIncome) : 0,
        dependentsAmount: w4?.dependentsAmount ? Number(w4.dependentsAmount) : 0,
        sutaOverride,
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
        const fit = round2(
          regularPass.federalIncomeTax + SUPPLEMENTAL_FLAT_RATE * supplementalGross,
        );
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
    }

    // Tier-2 — city/county withholding on gross (Philadelphia-style flat
    // wage tax). W-2 employees only; zero without an assigned rule.
    const localIncomeTax =
      employmentType === 'W2_EMPLOYEE' &&
      meta.localTaxRule?.isActive &&
      grossPay > 0
        ? round2(grossPay * Number(meta.localTaxRule.rate))
        : 0;
    if (localIncomeTax > 0) {
      breakdown = {
        ...breakdown,
        totalEmployeeTax: round2(breakdown.totalEmployeeTax + localIncomeTax),
        netPay: round2(breakdown.netPay - localIncomeTax),
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
              localIncomeTax
          )
        : 0;

    const activeGarns =
      employmentType === 'W2_EMPLOYEE' && disposableEarnings > 0
        ? await tx.garnishment.findMany({
            where: {
              associateId,
              status: 'ACTIVE',
              deletedAt: null,
              startDate: { lte: periodEndExclusive },
              OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
            },
            orderBy: { priority: 'asc' },
          })
        : [];

    const garnResult = computeGarnishmentDeductions({
      disposableEarnings,
      rules: activeGarns.map((g) => ({
        id: g.id,
        kind: g.kind,
        amountPerRun: g.amountPerRun !== null ? Number(g.amountPerRun) : null,
        percentOfDisp: g.percentOfDisp !== null ? Number(g.percentOfDisp) : null,
        totalCap: g.totalCap !== null ? Number(g.totalCap) : null,
        amountWithheld: Number(g.amountWithheld),
        priority: g.priority,
      })),
    });

    const postTaxDeductions = garnResult.total;

    // Gap 10 — fold settled-but-unpaid reimbursements into this item.
    // Read-only here (preview safe); persistence is run-creation's job.
    // Accountable-plan rule: amount is added AFTER taxes and never
    // touches grossPay / taxableGross / any wage base.
    const settledReimbursements = await tx.reimbursement.findMany({
      where: {
        associateId,
        status: 'SETTLED',
        payrollItemId: null,
      },
      select: { id: true, totalAmount: true },
      orderBy: { settledAt: 'asc' },
    });
    const reimbursementsTotal = round2(
      settledReimbursements.reduce((sum, r) => sum + Number(r.totalAmount), 0)
    );
    const reimbursementIds = settledReimbursements.map((r) => r.id);

    const finalNetPay = round2(
      breakdown.netPay - postTaxDeductions + reimbursementsTotal
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
        rate: round2(hourlyRate * 1.5),
        amount: overtimePay,
        isTaxable: true,
      });
    }
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

    const associateName = `${meta.firstName} ${meta.lastName}`.trim();

    items.push({
      associateId,
      associateName,
      hoursWorked,
      hourlyRate,
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
      netPay: finalNetPay,
      employerFica: breakdown.employer.fica,
      employerMedicare: breakdown.employer.medicare,
      employerFuta: breakdown.employer.futa,
      employerSuta: breakdown.employer.suta,
      ytdWages,
      ytdMedicareWages,
    });

    totalGross += grossPay;
    totalEmployeeTax += breakdown.totalEmployeeTax;
    totalNet += finalNetPay;
    totalEmployerTax +=
      breakdown.employer.fica +
      breakdown.employer.medicare +
      breakdown.employer.futa +
      breakdown.employer.suta;
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
