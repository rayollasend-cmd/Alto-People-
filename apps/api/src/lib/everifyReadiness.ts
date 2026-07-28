/**
 * Can this associate's E-Verify case actually be opened, and by when?
 *
 * Pure functions over plain values — no Prisma — so the rules are unit
 * testable and the route stays a thin query layer.
 *
 * The point of computing this server-side is the queue. A verifier looking at
 * forty names needs to see *why* someone isn't actionable without opening
 * them; "missing SSN" and "Section 2 not done" are different people's
 * problems. Before this, finding that out meant visiting five screens per
 * associate, which is the 20-minutes-per-case complaint this module exists to
 * answer.
 */

/** Everything that can stop a case being created, in the order HR fixes them. */
export type EVerifyBlocker =
  | 'NO_I9'
  | 'SECTION1_INCOMPLETE'
  | 'SECTION2_INCOMPLETE'
  | 'NO_CITIZENSHIP'
  | 'NO_SSN'
  | 'NO_DOB'
  | 'NO_HIRE_DATE';

export const EVERIFY_BLOCKER_LABEL: Record<EVerifyBlocker, string> = {
  NO_I9: 'No I-9 started',
  SECTION1_INCOMPLETE: 'I-9 Section 1 unsigned',
  SECTION2_INCOMPLETE: 'I-9 Section 2 not verified',
  NO_CITIZENSHIP: 'Citizenship status missing',
  NO_SSN: 'No readable SSN on file',
  NO_DOB: 'Date of birth missing',
  NO_HIRE_DATE: 'Hire date not set',
};

export interface EVerifyReadinessInput {
  hasI9: boolean;
  section1CompletedAt: Date | null;
  section2CompletedAt: Date | null;
  citizenshipStatus: string | null;
  /** True only when the SSN is present AND decrypts under the current key. */
  hasReadableSsn: boolean;
  dob: Date | null;
  hireDate: Date | null;
}

export interface EVerifyReadiness {
  blockers: EVerifyBlocker[];
  ready: boolean;
  /** 3 business days after the hire date; null when no hire date is set. */
  dueBy: Date | null;
}

/**
 * Federal rule: an E-Verify case must be created no later than the third
 * business day after the employee's first day of work for pay.
 */
export const EVERIFY_DUE_BUSINESS_DAYS = 3;

/**
 * Add whole business days, skipping Saturday and Sunday. Mirrors the helper
 * the I-9 Section 2 deadline already uses on the web side so the two dates
 * never disagree by a day. Federal holidays are not modelled — E-Verify's own
 * guidance is phrased in business days without a holiday calendar, and
 * inventing one here would make our date stricter than the government's.
 */
export function addBusinessDays(start: Date, days: number): Date {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

export function evaluateEVerifyReadiness(
  input: EVerifyReadinessInput,
): EVerifyReadiness {
  const blockers: EVerifyBlocker[] = [];

  if (!input.hasI9) {
    // No I-9 row means Sections 1 and 2 are trivially incomplete too;
    // listing all three would just be noise on the queue.
    blockers.push('NO_I9');
  } else {
    if (!input.section1CompletedAt) blockers.push('SECTION1_INCOMPLETE');
    if (!input.section2CompletedAt) blockers.push('SECTION2_INCOMPLETE');
    if (!input.citizenshipStatus) blockers.push('NO_CITIZENSHIP');
  }

  if (!input.hasReadableSsn) blockers.push('NO_SSN');
  if (!input.dob) blockers.push('NO_DOB');
  if (!input.hireDate) blockers.push('NO_HIRE_DATE');

  return {
    blockers,
    ready: blockers.length === 0,
    dueBy: input.hireDate
      ? addBusinessDays(input.hireDate, EVERIFY_DUE_BUSINESS_DAYS)
      : null,
  };
}

/**
 * Overdue = past the deadline with no case opened. A case that was opened
 * late is not flagged: the deadline is about *creating* the case, and once
 * it exists the queue's job is done. Without the `caseOpenedAt` check every
 * historical hire would sit in the queue permanently red.
 */
export function isEVerifyOverdue(
  dueBy: Date | null,
  caseOpenedAt: Date | null,
  now: Date,
): boolean {
  if (!dueBy || caseOpenedAt) return false;
  return now.getTime() > dueBy.getTime();
}
