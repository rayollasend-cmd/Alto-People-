import type { Prisma, PrismaClient } from '@prisma/client';
import { findInChunks } from './chunkedIn.js';
import { employerFor } from './employment.js';
import { computeCheckDeductions, loadDeferralContexts, type EnrollmentFacts } from './retirementDeferrals.js';
import { checkWageStatement, ELEMENT_LABEL, factsBeforeRun, wageStatementRuleFor } from './wageStatementRules.js';

/**
 * Pre-run compliance checks for the people in a run (payrollExceptions):
 *
 *   WAGE_STATEMENT_INCOMPLETE  the work state's paystub rule needs data that is
 *                              not on file — the employer's legal address or
 *                              phone, or a paid sick leave balance (warning).
 *   ROTH_CATCH_UP              a higher earner's catch-up stops because the
 *                              plan has no deemed Roth election (warning —
 *                              SECURE 2.0 §603; 26 CFR 1.414(v)-2).
 *   DEFERRAL_LIMIT             an annual limit stops part of an election on
 *                              this check (info).
 *
 * Uses the same deduction logic as the pay calculation, so what the check
 * says is what the run will do.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export interface RunPerson {
  associateId: string;
  associateName: string;
  /** Where the work happened (decides the wage-statement rule). */
  workState: string | null;
}

export interface ComplianceRow {
  associateId: string;
  associateName: string;
  kind: 'WAGE_STATEMENT_INCOMPLETE' | 'ROTH_CATCH_UP' | 'DEFERRAL_LIMIT';
  message: string;
  detail?: Record<string, unknown>;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function complianceRunExceptions(tx: Tx, people: RunPerson[], periodStart: Date, periodEndExclusive: Date): Promise<ComplianceRow[]> {
  const out: ComplianceRow[] = [];
  if (people.length === 0) return out;
  const ids = people.map((p) => p.associateId);

  const [meta, sick, enrollRows] = await Promise.all([
    findInChunks(ids, (chunk) => tx.associate.findMany({ where: { id: { in: chunk } }, select: { id: true, jobProfile: { select: { isExempt: true } } } })),
    findInChunks(ids, (chunk) => tx.timeOffBalance.findMany({ where: { associateId: { in: chunk }, category: 'SICK' }, select: { associateId: true } })),
    findInChunks(ids, (chunk) =>
      tx.benefitsEnrollment.findMany({
        where: { associateId: { in: chunk }, effectiveDate: { lt: periodEndExclusive }, OR: [{ terminationDate: null }, { terminationDate: { gte: periodStart } }] },
        select: { associateId: true, electedAmountCentsPerPeriod: true, rothElection: true, plan: { select: { kind: true, allowsDeemedRoth: true, employerContributionCentsPerPeriod: true } } },
      }),
    ),
  ]);
  const exempt = new Map(meta.map((m) => [m.id, m.jobProfile?.isExempt === true]));
  const hasSick = new Set(sick.map((s) => s.associateId));

  // Wage statements: only people working in a state with a rule.
  for (const p of people) {
    if (!wageStatementRuleFor(p.workState)) continue;
    const employer = await employerFor(tx, p.associateId, periodStart);
    const check = checkWageStatement(
      p.workState,
      factsBeforeRun({ employer, employeeName: p.associateName, hasSickBalance: hasSick.has(p.associateId) }),
      { exempt: exempt.get(p.associateId) ?? false },
    );
    if (check.missing.length > 0) {
      out.push({
        associateId: p.associateId,
        associateName: p.associateName,
        kind: 'WAGE_STATEMENT_INCOMPLETE',
        message: `The ${check.state} paystub would be missing: ${check.missing.map((m) => ELEMENT_LABEL[m].toLowerCase()).join(', ')} (${check.citation}). ${fixHint(check.missing)}`,
        detail: { state: check.state, citation: check.citation, missing: check.missing },
      });
    }
  }

  // Deferrals: the same split the pay calculation makes.
  const byPerson = new Map<string, EnrollmentFacts[]>();
  for (const e of enrollRows) {
    const arr = byPerson.get(e.associateId) ?? [];
    arr.push(e);
    byPerson.set(e.associateId, arr);
  }
  if (byPerson.size > 0) {
    const contexts = await loadDeferralContexts(tx, [...byPerson.keys()], periodStart);
    const year = periodStart.getUTCFullYear();
    const names = new Map(people.map((p) => [p.associateId, p.associateName]));
    for (const [associateId, enrollments] of byPerson) {
      const { deferrals: d } = computeCheckDeductions(enrollments, contexts.get(associateId), year);
      const associateName = names.get(associateId) ?? '';
      if (d.catchUpStoppedNoRoth > 0) {
        out.push({
          associateId,
          associateName,
          kind: 'ROTH_CATCH_UP',
          message: `Catch-up of ${usd(d.catchUpStoppedNoRoth)} stops this check. Last year's Social Security wages were over the limit, so federal law requires the catch-up to be Roth, and the plan does not allow Roth. Turn on Roth for the plan in Benefits, or tell the employee.`,
          detail: { stopped: d.catchUpStoppedNoRoth },
        });
      }
      if (d.limitStopped > 0) {
        out.push({
          associateId,
          associateName,
          kind: 'DEFERRAL_LIMIT',
          message: `${usd(d.limitStopped)} of this person's benefit elections will not be deducted: they reached this year's limit.`,
          detail: { stopped: d.limitStopped },
        });
      }
    }
  }
  return out;
}

function fixHint(missing: string[]): string {
  const hints: string[] = [];
  if (missing.includes('EMPLOYER_ADDRESS') || missing.includes('EMPLOYER_NAME') || missing.includes('EMPLOYER_PHONE')) hints.push('Add it in Settings → Employers.');
  if (missing.includes('SICK_LEAVE_BALANCE')) hints.push('Set up a sick leave policy so the balance prints.');
  return hints.join(' ');
}
