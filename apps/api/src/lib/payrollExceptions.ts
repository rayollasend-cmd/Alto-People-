// Wave 8 — Pre-flight payroll run exception triage.
//
// Walks the same set of associates the aggregator would pick up and flags
// data-quality issues that QBO would surface in its "Run payroll" preview:
//   - W-2 employee with no W-4 on file (BLOCKING; cannot withhold FIT)
//   - No primary payout method (WARNING; disbursement will fail)
//   - Soft-deleted before / during the period (WARNING; usually a typo)
//   - > 20 OT hours (INFO; either real overtime or a missed time edit)
//   - State has no real SIT table (INFO; the 4% fallback is approximate)
//
// Pure-ish like the aggregator: reads from the DB but writes nothing.
// Reused by POST /payroll/exceptions and the GET /payroll/upcoming summary
// so we have ONE source of truth for what counts as an exception.

import type { Prisma, PrismaClient } from '@prisma/client';
import { isStateTaxSupported } from './payrollTax.js';
import { sumApprovedHours, splitWeeklyOvertime } from './payroll.js';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface ExceptionsInput {
  periodStart: Date;
  periodEndExclusive: Date;
  clientId: string | null;
}

export type ExceptionKind =
  | 'MISSING_W4'
  | 'MISSING_BANK_ACCOUNT'
  | 'TERMINATED_IN_RUN'
  | 'OT_SPIKE'
  | 'UNSUPPORTED_STATE'
  | 'UNAPPROVED_TIME'
  | 'MISSING_COMP_RECORD';

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
  UNSUPPORTED_STATE: 'INFO',
  UNAPPROVED_TIME: 'WARNING',
  MISSING_COMP_RECORD: 'WARNING',
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

  // Unapproved (clocked-out but not yet reviewed) time in the same window.
  // These hours will NOT be paid — historically the #1 cause of a silent
  // short paycheck, because the associate simply wasn't in the run.
  const unapproved = await tx.timeEntry.findMany({
    where: {
      status: 'COMPLETED',
      clockInAt: { gte: periodStart, lt: periodEndExclusive },
      ...(clientId ? { clientId } : {}),
    },
    include: {
      associate: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const entries = await tx.timeEntry.findMany({
    where: {
      status: 'APPROVED',
      clockInAt: { gte: periodStart, lt: periodEndExclusive },
      ...(clientId ? { clientId } : {}),
    },
    include: {
      // Same net-of-breaks basis as the aggregator — exception hour totals
      // must match what the run will actually pay.
      breaks: { select: { startedAt: true, endedAt: true } },
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          employmentType: true,
          deletedAt: true,
          w4Submission: { select: { id: true } },
          payoutMethods: {
            where: { isPrimary: true },
            select: { id: true, type: true, branchCardId: true, accountNumberEnc: true },
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

  const exceptions: PayrollExceptionRow[] = [];

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
        message: `Terminated ${a.deletedAt.toISOString().slice(0, 10)} but has approved hours in this period.`,
        detail: { terminatedAt: a.deletedAt.toISOString() },
      });
    }

    // 4. OT_SPIKE — > 20 OT hours in this period. 20h was picked because
    //    every state's typical workweek expects ~0–8h OT/week, so 20+ in
    //    a single biweekly period is a real outlier worth a second look.
    const ot = splitWeeklyOvertime(group);
    if (ot.overtimeHours > 20) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'OT_SPIKE',
        severity: SEVERITY.OT_SPIKE,
        message: `${ot.overtimeHours.toFixed(1)} hours of overtime in this period.`,
        detail: { overtimeHours: ot.overtimeHours },
      });
    }

    // 5. UNSUPPORTED_STATE — only for W-2; 1099 has no SIT to compute.
    if (a.employmentType === 'W2_EMPLOYEE' && !isStateTaxSupported(a.state)) {
      exceptions.push({
        associateId,
        associateName,
        kind: 'UNSUPPORTED_STATE',
        severity: SEVERITY.UNSUPPORTED_STATE,
        message: a.state
          ? `${a.state} is not in the bracketed/flat-rate tables — using a 4% fallback.`
          : 'No state on file — using a 4% fallback for state withholding.',
        detail: { state: a.state ?? null },
      });
    }
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
    const comps = await tx.compensationRecord.findMany({
      where: { associateId: { in: inRunIds }, effectiveTo: null },
      select: { associateId: true },
    });
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
