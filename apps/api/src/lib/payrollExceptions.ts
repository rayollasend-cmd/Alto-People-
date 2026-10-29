// Wave 8 — Pre-flight payroll run exception triage.
//
// Walks the same set of associates the aggregator would pick up and flags
// data-quality issues that QBO would surface in its "Run payroll" preview:
//   - W-2 employee with no W-4 on file (BLOCKING; cannot withhold FIT)
//   - No primary payout method (WARNING; disbursement will fail)
//   - Soft-deleted before / during the period (WARNING; usually a typo)
//   - > 20 OT hours (INFO; either real overtime or a missed time edit)
//   - State has no SIT table (BLOCKING; nothing would be withheld)
//   - Retroactive pay owed from a back-dated rate change (INFO)
//
// Pure-ish like the aggregator: reads from the DB but writes nothing.
// Reused by POST /payroll/exceptions and the GET /payroll/upcoming summary
// so we have ONE source of truth for what counts as an exception.

import type { Prisma, PrismaClient } from '@prisma/client';
import { findInChunks } from './chunkedIn.js';
import { isStateTaxSupported, primeStateAcknowledgments, stateAwaitingReview, supportedStates } from './payrollTax.js';
import { mdCountyRate } from './stateWithholding.js';
import { sumApprovedHours } from './payroll.js';
import { loadPayContext } from './laborRules/payContext.js';
import { splitHours } from './laborRules/hours.js';
import { computeRetroPay, summarizeRetro } from './retroPay.js';
import { prevailingWageRunExceptions } from './certifiedPayroll.js';
import { complianceRunExceptions } from './payrollComplianceChecks.js';
import { calculateInHouse, localAwaitingReview, primeLocalAcknowledgments, unresolvedText } from './taxEngine/index.js';
import { fmtDay, fmtDayInZone, fmtDayRange } from './humanDates.js';
import { cutOf } from './payrollSchedule.js';
import { runPunches, utcCutPredecessor, type RunCut, type UtcCutPredecessor } from './payrollRunCut.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface ExceptionsInput {
  periodStart: Date;
  periodEndExclusive: Date;
  clientId: string | null;
  /** A run for one pay schedule: exceptions for its people only, plus who has time but no schedule. */
  payrollScheduleId?: string | null;
  /** The deploy transition of the site-day cut (lib/payrollRunCut); looked up when omitted. */
  prevUtcCut?: UtcCutPredecessor | null;
}

export type ExceptionKind =
  | 'UNASSIGNED_SCHEDULE'
  | 'MISSING_W4'
  | 'MISSING_BANK_ACCOUNT'
  | 'TERMINATED_IN_RUN'
  | 'OT_SPIKE'
  | 'UNSUPPORTED_STATE'
  | 'UNAPPROVED_TIME'
  | 'MISSING_COMP_RECORD'
  | 'RETRO_PAY'
  | 'STATE_W4_INCOMPLETE'
  | 'LOCAL_TAX_REVIEW'
  | 'LOCAL_TAX_UNRESOLVED'
  | 'BELOW_PREVAILING_WAGE'
  | 'APPRENTICE_RATIO'
  | 'WAGE_STATEMENT_INCOMPLETE'
  | 'ROTH_CATCH_UP'
  | 'DEFERRAL_LIMIT'
  | 'LATE_APPROVED_TIME';

export type ExceptionSeverity = 'BLOCKING' | 'WARNING' | 'INFO';

export interface PayrollExceptionRow {
  associateId: string;
  associateName: string;
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

const SEVERITY: Record<ExceptionKind, ExceptionSeverity> = {
  MISSING_W4: 'BLOCKING',
  MISSING_BANK_ACCOUNT: 'WARNING',
  TERMINATED_IN_RUN: 'WARNING',
  OT_SPIKE: 'INFO',
  UNSUPPORTED_STATE: 'BLOCKING',
  UNAPPROVED_TIME: 'WARNING',
  MISSING_COMP_RECORD: 'WARNING',
  RETRO_PAY: 'INFO',
  STATE_W4_INCOMPLETE: 'WARNING',
  LOCAL_TAX_REVIEW: 'BLOCKING',
  LOCAL_TAX_UNRESOLVED: 'BLOCKING',
  BELOW_PREVAILING_WAGE: 'BLOCKING',
  APPRENTICE_RATIO: 'WARNING',
  WAGE_STATEMENT_INCOMPLETE: 'WARNING',
  ROTH_CATCH_UP: 'WARNING',
  DEFERRAL_LIMIT: 'INFO',
  UNASSIGNED_SCHEDULE: 'WARNING',
  LATE_APPROVED_TIME: 'WARNING',
};

export interface ExceptionsResult {
  exceptions: PayrollExceptionRow[];
  counts: { blocking: number; warning: number; info: number };
}

/**
 * Same time-entry seed as the aggregator — we want exceptions on the exact
 * set of associates that would land in the run, no more no less.
 */
export async function computePayrollExceptions(
  tx: Tx,
  input: ExceptionsInput
): Promise<ExceptionsResult> {
  const { periodStart, periodEndExclusive, clientId } = input;
  // The run's own cut (deep audit CODE-1, lib/payrollRunCut): a punch is in
  // the period when its clock-in's day ON THE SITE'S CLOCK is — and, on a
  // schedule's run, one of the person's days on it. Exactly what the run
  // pays, so an evening shift at a period's edge is either paid or warned.
  const period = cutOf(periodStart, periodEndExclusive);
  const { membershipWindows } = await import('./payScheduleMembership.js');
  const cut: RunCut = {
    ...period,
    windows: input.payrollScheduleId ? await membershipWindows(tx, input.payrollScheduleId, period.periodStart, period.periodEnd) : null,
    prevUtc:
      input.prevUtcCut !== undefined
        ? input.prevUtcCut
        : await utcCutPredecessor(tx, { kind: 'REGULAR', payrollScheduleId: input.payrollScheduleId ?? null, clientId, periodStart: period.periodStart }),
  };

  // Unapproved (clocked-out but not yet reviewed) time in the same window.
  // These hours will NOT be paid — historically the #1 cause of a silent
  // short paycheck, because the associate simply wasn't in the run.
  const unapproved = await runPunches(cut, (clockInAt) => tx.timeEntry.findMany({
    where: {
      status: 'COMPLETED',
      clockInAt,
      ...(clientId ? { clientId } : {}),
    },
    include: {
      associate: { select: { id: true, firstName: true, lastName: true } },
      location: { select: { timezone: true } },
    },
  }));

  const entries = await runPunches(cut, (clockInAt) => tx.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockInAt,
      ...(clientId ? { clientId } : {}),
    },
    include: {
      // Same net-of-breaks basis as the aggregator — exception hour totals
      // must match what the run will actually pay.
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      // The work site decides the work-state and local taxes (lib/taxEngine),
      // and (when live) the labor rules the hours split by.
      location: { select: { id: true, state: true, city: true, zip: true, timezone: true } },
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          city: true,
          zip: true,
          localTaxRule: { select: { isActive: true } },
          taxProfile: { select: { residentPsdCode: true, residentMunicipality: true, residentSchoolDistrict: true, residentCountyJan1: true, residentLocalCode: true } },
          taxCertificates: { where: { revokedAt: null }, select: { kind: true, state: true, jurisdictionCode: true } },
          employmentType: true,
          deletedAt: true,
          w4Submission: { select: { id: true } },
          stateW4s: { select: { state: true, county: true } },
          payoutMethods: {
            where: { isPrimary: true },
            select: { id: true, type: true, branchCardId: true, accountNumberEnc: true },
          },
        },
      },
    },
  }));

  // A run for one pay schedule: only its people's time on their days on it
  // (the same cut the aggregator pays — someone who moved mid-period is
  // checked here only for the days this run pays), and a warning for anyone
  // with approved time who is on no schedule at all.
  const scheduleWarnings: PayrollExceptionRow[] = [];
  if (input.payrollScheduleId) {
    const { unscheduledWithTime } = await import('./payScheduleMembership.js');
    const from = period.periodStart;
    for (const u of await unscheduledWithTime(tx, period.periodStart, period.periodEnd, clientId)) {
      scheduleWarnings.push({
        associateId: u.associateId,
        associateName: u.name,
        kind: 'UNASSIGNED_SCHEDULE',
        severity: SEVERITY.UNASSIGNED_SCHEDULE,
        message: 'Has approved time in this period but is on no pay schedule — not paid in this run. Add them to a schedule.',
        detail: {},
      });
    }
    // Approved time from an earlier period whose payday passed with no
    // paystub for it (the period ledger, finance walk 1): this run does
    // not pay it either — an off-cycle run from the ledger does.
    const { lateApprovedTime } = await import('./payrollPeriodLedger.js');
    for (const late of await lateApprovedTime(tx, input.payrollScheduleId, from)) {
      const oldest = late.periods[0]!;
      scheduleWarnings.push({
        associateId: late.associateId,
        associateName: late.name,
        kind: 'LATE_APPROVED_TIME',
        severity: SEVERITY.LATE_APPROVED_TIME,
        message: `${late.hours.toFixed(1)}h approved for ${fmtDayRange(oldest.periodStart, late.periods[late.periods.length - 1]!.periodEnd)} (payday ${fmtDay(oldest.payDate)}) are on no paystub — this run does not pay them. Pay them off-cycle from the payroll home.`,
        detail: { hours: late.hours, periods: late.periods },
      });
    }
  }

  const byAssociate = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byAssociate.get(e.associateId) ?? [];
    arr.push(e);
    byAssociate.set(e.associateId, arr);
  }

  const exceptions: PayrollExceptionRow[] = [...scheduleWarnings];
  // The paycheck's own inputs (live rules, punch rounding): overtime here is the run's overtime.
  const pay = await loadPayContext(tx);
  // Which added states this tenant's payroll admin has reviewed.
  await primeStateAcknowledgments(tx);
  // …and which local jurisdictions.
  await primeLocalAcknowledgments(tx);

  for (const [associateId, group] of byAssociate) {
    const a = group[0].associate;
    const associateName = `${a.firstName} ${a.lastName}`.trim();
    const hoursWorked = sumApprovedHours(group);
    if (hoursWorked === 0) continue;

    // 1. MISSING_W4 — only checked for W-2 employees (1099 don't withhold).
    if (a.employmentType === 'W2_EMPLOYEE' && !a.w4Submission) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'MISSING_W4',
        severity: SEVERITY.MISSING_W4,
        message: 'No W-4 on file. Cannot withhold federal income tax.',
      });
    }

    // 2. MISSING_BANK_ACCOUNT — no primary payout method (any rail).
    const primary = a.payoutMethods[0] ?? null;
    const hasRail =
      !!primary &&
      (primary.branchCardId !== null || primary.accountNumberEnc !== null);
    if (!hasRail) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'MISSING_BANK_ACCOUNT',
        severity: SEVERITY.MISSING_BANK_ACCOUNT,
        message:
          'No payout method on file (no Branch card and no bank account). Disbursement will fail.',
      });
    }

    // 3. TERMINATED_IN_RUN — soft-deleted at or before periodEnd, but still
    //    has hours in the period (likely a missed off-boarding).
    if (a.deletedAt && a.deletedAt < periodEndExclusive) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'TERMINATED_IN_RUN',
        severity: SEVERITY.TERMINATED_IN_RUN,
        message: `Terminated ${fmtDayInZone(a.deletedAt)} but has approved hours in this period.`,
        detail: { terminatedAt: a.deletedAt.toISOString() },
      });
    }

    // 4. OT_SPIKE — > 20 OT hours in this period. 20h was picked because
    //    every state's typical workweek expects ~0–8h OT/week, so 20+ in
    //    a single biweekly period is a real outlier worth a second look.
    //    Split by the labor-rules engine exactly as the run will pay it —
    //    a live jurisdiction's daily overtime and double time count.
    const split = splitHours(pay.rules, group.map(pay.forPay).map((e) => ({ ...e, site: e.location })));
    const otHours = Math.round((split.overtimeHours + split.doubleTimeHours) * 100) / 100;
    if (otHours > 20) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'OT_SPIKE',
        severity: SEVERITY.OT_SPIKE,
        message: `${otHours.toFixed(1)} hours of overtime in this period.`,
        detail: { overtimeHours: split.overtimeHours, ...(split.doubleTimeHours > 0 ? { doubleTimeHours: split.doubleTimeHours } : {}) },
      });
    }

    // 5. UNSUPPORTED_STATE — only for W-2; 1099 has no SIT to compute.
    // BLOCKING: nothing would be withheld, so the run cannot finalize with
    // this person in it until the state is covered (or configured).
    const awaiting = a.employmentType === 'W2_EMPLOYEE' ? stateAwaitingReview(a.state) : null;
    if (awaiting) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'UNSUPPORTED_STATE',
        severity: SEVERITY.UNSUPPORTED_STATE,
        message: `${awaiting.name} withholding (${awaiting.taxYear} tables) hasn’t been reviewed yet. A payroll admin confirms it was reviewed with your tax adviser in Payroll → State tax coverage, and this run can finalize.`,
        detail: { state: awaiting.state, taxYear: awaiting.taxYear, reason: 'awaiting_review' },
      });
    } else if (a.employmentType === 'W2_EMPLOYEE' && !isStateTaxSupported(a.state)) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'UNSUPPORTED_STATE',
        severity: SEVERITY.UNSUPPORTED_STATE,
        message: a.state
          ? `State income tax is not supported for ${a.state} — no state tax would be withheld. Supported: ${supportedStates().join(', ')}. Add a configured rate in Payroll → Settings or move them to a covered state before this run finalizes.`
          : `No work state on file — state income tax cannot be computed. Supported: ${supportedStates().join(', ')}.`,
        detail: { state: a.state ?? null, supported: supportedStates() },
      });
    }
    // 5b. Work states other than home: each must be covered too.
    if (a.employmentType === 'W2_EMPLOYEE') {
      const workStates = new Set(group.map((e) => e.location?.state?.toUpperCase()).filter((st): st is string => !!st && st !== a.state?.toUpperCase()));
      for (const st of workStates) {
        const w = stateAwaitingReview(st);
        if (w) {
          exceptions.push({
            associateId,
            associateName,
            kind: 'UNSUPPORTED_STATE',
            severity: SEVERITY.UNSUPPORTED_STATE,
            message: `Worked in ${w.name}, whose withholding (${w.taxYear} tables) hasn’t been reviewed yet. A payroll admin confirms it in Payroll → State tax coverage.`,
            detail: { state: w.state, taxYear: w.taxYear, reason: 'awaiting_review', workState: true },
          });
        }
      }
    }

    // 5c. LOCAL_TAX_REVIEW / LOCAL_TAX_UNRESOLVED — the local taxes this
    // check owes (lib/taxEngine). A jurisdiction no payroll admin has
    // reviewed with their tax adviser, or a question the address can't
    // answer (a Pennsylvania resident with no PSD code), blocks the run.
    // A local rule set by hand on the person replaces the engine's locals.
    if (a.employmentType === 'W2_EMPLOYEE' && !a.localTaxRule?.isActive) {
      const probe = calculateInHouse({
        wages: Math.max(1, hoursWorked) * 20,
        payFrequency: 'BIWEEKLY',
        residence: {
          state: a.state,
          city: a.city,
          zip: a.zip,
          psdCode: a.taxProfile?.residentPsdCode,
          municipality: a.taxProfile?.residentMunicipality,
          schoolDistrict: a.taxProfile?.residentSchoolDistrict,
          countyJan1: a.taxProfile?.residentCountyJan1,
          localCode: a.taxProfile?.residentLocalCode,
        },
        work: group.map((e) => ({ state: e.location?.state ?? a.state, city: e.location?.city ?? null, zip: e.location?.zip ?? null, hours: sumApprovedHours([e]) })),
        certificates: a.taxCertificates,
        federalFilingStatus: null,
        federalCycleWithholding: 0,
        stateW4s: {},
      });
      for (const code of probe.jurisdictionsUsed) {
        const w = localAwaitingReview(code);
        if (w) {
          exceptions.push({
            associateId,
            associateName,
            kind: 'LOCAL_TAX_REVIEW',
            severity: SEVERITY.LOCAL_TAX_REVIEW,
            message: `${w.name} (${w.taxYear} rates) hasn’t been reviewed yet. A payroll admin confirms it was reviewed with your tax adviser in Pay & finance → Tax jurisdictions.`,
            detail: { jurisdiction: code, taxYear: w.taxYear },
          });
        }
      }
      for (const code of probe.unresolved) {
        exceptions.push({
          associateId,
          associateName,
          kind: 'LOCAL_TAX_UNRESOLVED',
          severity: SEVERITY.LOCAL_TAX_UNRESOLVED,
          message: `${unresolvedText(code)} Set it on their record under Taxes we withhold.`,
          detail: { question: code },
        });
      }
    }

    // 6. STATE_W4_INCOMPLETE — Maryland withholds county tax by the MW507
    // county; without one the most common rate stands in.
    if (a.employmentType === 'W2_EMPLOYEE' && a.state?.toUpperCase() === 'MD') {
      const mw507 = a.stateW4s.find((c) => c.state === 'MD');
      if (!mdCountyRate(mw507?.county).known) {
        exceptions.push({
          associateId,
          associateName,
          kind: 'STATE_W4_INCOMPLETE',
          severity: SEVERITY.STATE_W4_INCOMPLETE,
          message: 'No Maryland county on their MW507 — county tax is withheld at 3.20% until one is recorded.',
          detail: { state: 'MD', field: 'county' },
        });
      }
    }
  }

  // 8. RETRO_PAY — a rate change dated into a period already paid: the
  // delta lands on this run as a Retroactive pay line (lib/retroPay.ts).
  const retro = await computeRetroPay(tx, { associateIds: [...byAssociate.keys()], asOf: periodEndExclusive });
  for (const [associateId, cands] of retro) {
    const a = byAssociate.get(associateId)?.[0]?.associate;
    if (!a) continue;
    const { amount, note } = summarizeRetro(cands);
    exceptions.push({
      associateId,
      associateName: `${a.firstName} ${a.lastName}`.trim(),
      kind: 'RETRO_PAY',
      severity: SEVERITY.RETRO_PAY,
      message: `$${amount.toFixed(2)} of retroactive pay will be added to this check — ${note.replace(/^Retroactive pay — /, '')}.`,
      detail: { amount, pairs: cands.length, effectiveFrom: cands.map((c) => c.effectiveFrom).sort()[0] },
    });
  }

  // 6. UNAPPROVED_TIME — clocked-out but unreviewed hours, per associate.
  // Not in `byAssociate` (that's APPROVED-only, by design): these people
  // may not be in the run AT ALL, which is exactly the problem.
  const unapprovedByAssoc = new Map<
    string,
    { name: string; ms: number }
  >();
  for (const e of unapproved) {
    if (!e.clockOutAt) continue;
    const cur = unapprovedByAssoc.get(e.associateId) ?? {
      name: `${e.associate.firstName} ${e.associate.lastName}`.trim(),
      ms: 0,
    };
    cur.ms += e.clockOutAt.getTime() - e.clockInAt.getTime();
    unapprovedByAssoc.set(e.associateId, cur);
  }
  for (const [associateId, g] of unapprovedByAssoc) {
    const hours = g.ms / 3_600_000;
    if (hours <= 0) continue;
    exceptions.push({
      associateId,
      associateName: g.name,
      kind: 'UNAPPROVED_TIME',
      severity: SEVERITY.UNAPPROVED_TIME,
      message: `${hours.toFixed(1)} unapproved hour${hours === 1 ? '' : 's'} in this period — they will NOT be paid until approved in Time & Attendance.`,
      detail: { unapprovedHours: Math.round(hours * 10) / 10 },
    });
  }

  // 7. MISSING_COMP_RECORD — an associate in the run with no open comp
  // record silently falls back to the wizard's default hourly rate.
  const inRunIds = [...byAssociate.keys()];
  if (inRunIds.length > 0) {
    const comps = await findInChunks(inRunIds, (chunk) =>
      tx.compensationRecord.findMany({
        where: { associateId: { in: chunk }, effectiveTo: null },
        select: { associateId: true },
      }),
    );
    const withComp = new Set(comps.map((c) => c.associateId));
    for (const [associateId, group] of byAssociate) {
      if (withComp.has(associateId)) continue;
      const a = group[0].associate;
      exceptions.push({
        associateId,
        associateName: `${a.firstName} ${a.lastName}`.trim(),
        kind: 'MISSING_COMP_RECORD',
        severity: SEVERITY.MISSING_COMP_RECORD,
        message:
          'No compensation record on file — this run would pay the default hourly rate. Set their rate in People → Compensation.',
      });
    }
  }

  // 8. Prevailing wage — a public-works worker paid under the project's rate
  // (blocking) or apprentices over the ratio (a warning), for the weeks in
  // this period. Only people already in the run.
  for (const p of await prevailingWageRunExceptions(tx, periodStart, periodEndExclusive)) {
    if (!byAssociate.has(p.associateId)) continue;
    exceptions.push({ ...p, severity: SEVERITY[p.kind] });
  }

  // 9. Wage-statement elements the work state requires, the Roth catch-up
  // rule and the annual deferral limits (lib/payrollComplianceChecks).
  const runPeople = [...byAssociate].map(([associateId, group]) => {
    const a = group[0].associate;
    const states = new Map<string, number>();
    for (const e of group) {
      const st = e.location?.state ?? null;
      if (st) states.set(st, (states.get(st) ?? 0) + 1);
    }
    const workState = [...states].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.state ?? null;
    return { associateId, associateName: `${a.firstName} ${a.lastName}`.trim(), workState };
  });
  for (const c of await complianceRunExceptions(tx, runPeople, periodStart, periodEndExclusive)) {
    exceptions.push({ ...c, severity: SEVERITY[c.kind] });
  }

  // Stable sort: blocking → warning → info, then by name.
  const order: Record<ExceptionSeverity, number> = { BLOCKING: 0, WARNING: 1, INFO: 2 };
  exceptions.sort((a, b) => {
    if (a.severity !== b.severity) return order[a.severity] - order[b.severity];
    return a.associateName.localeCompare(b.associateName);
  });

  const counts = {
    blocking: exceptions.filter((e) => e.severity === 'BLOCKING').length,
    warning: exceptions.filter((e) => e.severity === 'WARNING').length,
    info: exceptions.filter((e) => e.severity === 'INFO').length,
  };

  return { exceptions, counts };
}
