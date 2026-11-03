import type { Prisma } from '@prisma/client';
import type { EeoApplicantReport, WorkforceGroup } from '@alto-people/shared';
import { orgDateKey } from './timeAnomalies.js';
import { dateColumnKey } from './timezone.js';
import { isBusinessDay } from './payrollTaxCalendar.js';

/**
 * Hiring compliance (2026-10-21 system audit, Tier 1 #14): the pure parts
 * of three rules that had no home —
 *
 *   I-9 retention and reverification   8 CFR 274a.2(b)(2): keep the I-9 for
 *                                      three years after the hire date or one
 *                                      year after employment ends, whichever
 *                                      is later; reverify (Supplement B) by
 *                                      the day the work authorization expires.
 *   FCRA adverse action                15 U.S.C. §1681b(b)(3): before acting
 *                                      on a consumer report, give the person
 *                                      the report and the CFPB "Summary of
 *                                      Your Rights", wait a reasonable time,
 *                                      then send the adverse action notice.
 *   Applicant EEO self-identification  Voluntary, kept apart from the
 *                                      application, published only in
 *                                      aggregate with small buckets hidden.
 *
 * Routes in routes/compliance.ts, routes/candidatePortal.ts and
 * routes/onboarding.ts call these; nothing here touches the database.
 */

const DAY_MS = 86_400_000;

/** The company's calendar day of an instant (now, a separation, a response deadline). */
const ymd = (d: Date) => orgDateKey(d);

/** The same calendar day `years` on, in UTC (date-only columns are UTC midnight). */
function addYearsUtc(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/* ----- I-9 ---------------------------------------------------------------- */

/** A day as UTC midnight: a 'YYYY-MM-DD', or a @db.Date value as it is. */
function asDay(d: Date | string): Date {
  return typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
}

/**
 * The day employment ended, for retention (owner, 2026-11-03): the
 * completed separation's last day worked (a date column); else the day the
 * person was separated (an instant, read as the company's day). Null while
 * they still work here.
 */
export function i9TerminationDay(lastDayWorked: Date | null | undefined, separatedAt: Date | null | undefined): string | null {
  if (lastDayWorked) return dateColumnKey(lastDayWorked);
  if (separatedAt) return ymd(separatedAt);
  return null;
}

/**
 * Keep the I-9 until the later of three years from the hire date and one
 * year from the day employment ended. Null until the person has a hire
 * date; an employee still working has no end date, so the three-year mark
 * stands until they leave (and then moves if a year after leaving is later).
 * `ended` is a day ('YYYY-MM-DD', i9TerminationDay) or an instant (read as
 * the company's day).
 */
export function i9RetainUntil(hireDate: Date | string | null | undefined, ended: Date | string | null | undefined): Date | null {
  if (!hireDate) return null;
  const threeYears = addYearsUtc(asDay(hireDate), 3);
  if (!ended) return threeYears;
  const end = typeof ended === 'string' ? asDay(ended) : new Date(`${ymd(ended)}T00:00:00.000Z`);
  const oneYear = addYearsUtc(end, 1);
  return oneYear.getTime() > threeYears.getTime() ? oneYear : threeYears;
}

/** Past retention: the person left and the retain-until day is behind us. One rule for the list's rows and the Inbox count. */
export function i9PastRetention(retainUntil: Date | null, ended: string | null, now: Date = new Date()): boolean {
  return !!retainUntil && !!ended && retainUntil.getTime() < todayUtc(now).getTime();
}

/**
 * The one Section 1 status that ever re-verifies (owner, 2026-11-03; 8 CFR
 * 274a.2(b)(1)(vii)): an alien authorized to work until a date. Citizens,
 * noncitizen nationals and permanent residents never do — a green card's
 * expiry is not a re-verification trigger, and asking for a new one is
 * over-documentation.
 */
export const REVERIFYING_CITIZENSHIP = 'ALIEN_AUTHORIZED_TO_WORK' as const;

/** Reverification is due the day the work authorization expires; null when it never does, or the person never re-verifies. */
export function i9ReverifyDueAt(workAuthExpiresAt: Date | null | undefined, citizenshipStatus: string | null | undefined): Date | null {
  if (citizenshipStatus !== REVERIFYING_CITIZENSHIP || !workAuthExpiresAt) return null;
  return new Date(workAuthExpiresAt.getTime());
}

/** Today as a date-only UTC midnight. */
export function todayUtc(now: Date = new Date()): Date {
  return new Date(`${ymd(now)}T00:00:00.000Z`);
}

/** How far ahead a work-authorization expiry counts as reverification due. */
export const REVERIFY_WINDOW_DAYS = 90;

/** The groups that re-verify: still employed (Current or Paused). Starting soon hasn't started; Former has left. */
export const REVERIFYING_GROUPS: readonly WorkforceGroup[] = ['current', 'paused'];

/**
 * Is this I-9's reverification due — the row's flag on the I-9 list? The
 * same rule as i9ReverificationWhere: an alien authorized to work, the
 * authorization expired or ending within REVERIFY_WINDOW_DAYS, and the
 * person still employed (`group` current or paused).
 */
export function i9ReverificationDue(
  i9: { citizenshipStatus: string | null | undefined; workAuthExpiresAt: Date | null | undefined },
  group: WorkforceGroup | null,
  now: Date = new Date(),
): boolean {
  const due = i9ReverifyDueAt(i9.workAuthExpiresAt, i9.citizenshipStatus);
  if (!due || !group || !REVERIFYING_GROUPS.includes(group)) return false;
  return due.getTime() <= todayUtc(now).getTime() + REVERIFY_WINDOW_DAYS * DAY_MS;
}

/**
 * The I-9s whose reverification is due: an alien authorized to work whose
 * authorization expired or expires within REVERIFY_WINDOW_DAYS, and who has
 * not left. One predicate for the I-9 list's `?status=reverification` and
 * the Inbox count; pass the group's ids (lib/complianceWorkforce idsOf) to
 * narrow it to Current (the Inbox) or Current + Paused (the rule).
 */
export function i9ReverificationWhere(now: Date = new Date(), opts: { associateIds?: string[] } = {}): Prisma.I9VerificationWhereInput {
  return {
    citizenshipStatus: REVERIFYING_CITIZENSHIP,
    workAuthExpiresAt: { not: null, lte: new Date(todayUtc(now).getTime() + REVERIFY_WINDOW_DAYS * DAY_MS) },
    associate: { separatedAt: null, erasedAt: null, deletedAt: null },
    ...(opts.associateIds ? { associateId: { in: opts.associateIds } } : {}),
  };
}

/**
 * The I-9s that may be past retention — the database's half of the rule:
 * the person left, hired (the newest employment's start, else
 * Associate.hireDate — lib/hireDate) three years ago or more, and their
 * employment ended (the latest completed separation's last day worked,
 * else separatedAt) a year ago or more. A day of slack on each mark keeps
 * the leap-day edge inside; callers keep a row only when
 * i9PastRetention(i9RetainUntil(...)) says so, so the list and the Inbox
 * count the same people.
 */
export function i9RetentionWhere(now: Date = new Date()): Prisma.I9VerificationWhereInput {
  const today = todayUtc(now);
  const hiredBefore = new Date(addYearsUtc(today, -3).getTime() + DAY_MS);
  const endedBefore = new Date(addYearsUtc(today, -1).getTime() + DAY_MS);
  return {
    associate: {
      AND: [
        { separatedAt: { not: null } },
        {
          OR: [
            { employments: { some: {}, none: { hireDate: { gte: hiredBefore } } } },
            { employments: { none: {} }, hireDate: { not: null, lt: hiredBefore } },
          ],
        },
        {
          OR: [
            { separations: { some: { status: 'COMPLETE' }, none: { status: 'COMPLETE', lastDayWorked: { gte: endedBefore } } } },
            { separations: { none: { status: 'COMPLETE' } }, separatedAt: { lt: endedBefore } },
          ],
        },
      ],
    },
  };
}

/** Days until a date-only deadline, from a date-only today (negative = past). */
export function daysUntil(deadline: Date, today: Date = new Date()): number {
  const t = new Date(`${ymd(today)}T00:00:00.000Z`).getTime();
  return Math.round((deadline.getTime() - t) / DAY_MS);
}

/* ----- I-9 Section 2 and E-Verify deadlines -------------------------------- */

/**
 * `days` business days after a day (UTC dates): weekends and federal
 * holidays skipped (lib/payrollTaxCalendar), so a deadline never lands on a
 * day the government is closed.
 */
export function addFederalBusinessDays(start: Date | string, days: number): Date {
  const s = asDay(start);
  const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d)) added += 1;
  }
  return d;
}

/** Section 2 and the E-Verify case are both due by the 3rd business day after the first day of employment. */
export const FIRST_DAY_DEADLINE_BUSINESS_DAYS = 3;

/** Section 2 due: the 3rd business day after the first day of employment (the one hire date, lib/hireDate). */
export function section2DueBy(firstDay: Date | string | null | undefined): Date | null {
  return firstDay ? addFederalBusinessDays(firstDay, FIRST_DAY_DEADLINE_BUSINESS_DAYS) : null;
}

/**
 * The E-Verify case's due day (owner, 2026-11-03): the deadline the
 * connected provider stored when the case was made for this employment
 * (eVerifyDueBy), else the 3rd business day after the first day of
 * employment. A stored day before this employment's first day belongs to an
 * earlier one, and is ignored.
 */
export function eVerifyDueBy(firstDay: Date | string | null | undefined, stored: Date | null | undefined): Date | null {
  if (stored && (!firstDay || stored.getTime() >= asDay(firstDay).getTime())) return stored;
  return section2DueBy(firstDay);
}

/**
 * Overdue: no case at all for this employment, and the due day is behind
 * the company's today. A case on file — opened, numbered or with an outcome
 * — is never overdue (an Authorized case with no opened date read Overdue).
 */
export function eVerifyOverdue(dueBy: Date | null, hasCase: boolean, now: Date = new Date()): boolean {
  return !hasCase && !!dueBy && dueBy.getTime() < todayUtc(now).getTime();
}

/**
 * A case still open in E-Verify: waiting for a result, a mismatch, or
 * referred, and not closed. For someone who has left, it must be closed
 * there with "employee no longer employed".
 */
export function eVerifyCaseOpen(i9: {
  eVerifyStatus: string | null;
  eVerifyClosedAt: Date | null;
  eVerifyReferredAt?: Date | null;
}): boolean {
  if (i9.eVerifyClosedAt) return false;
  return i9.eVerifyStatus === 'PENDING' || i9.eVerifyStatus === 'TENTATIVE_NONCONFIRMATION' || !!i9.eVerifyReferredAt;
}

/**
 * A rehire's case that belongs to an earlier employment (owner,
 * 2026-11-03): the person has a spell that ended before this one began, and
 * the case was opened on or before that spell's last day. This employment
 * needs a case of its own. A first hire's case opened a few days before
 * their start is theirs (no earlier spell), and so is one opened between
 * the spells.
 */
export function caseFromEarlierEmployment(
  caseOpenedAt: Date | string | null | undefined,
  currentHire: string | null | undefined,
  spells: ReadonlyArray<{ hireDate: Date; endDate: Date | null }>,
): boolean {
  if (!caseOpenedAt || !currentHire) return false;
  let prevEnd: string | null = null;
  for (const s of spells) {
    if (!s.endDate) continue;
    const end = dateColumnKey(s.endDate);
    if (end < currentHire && (!prevEnd || end > prevEnd)) prevEnd = end;
  }
  // An instant is read as the company's day; a 'YYYY-MM-DD' is already one.
  const opened = typeof caseOpenedAt === 'string' ? caseOpenedAt.slice(0, 10) : ymd(caseOpenedAt);
  return !!prevEnd && opened <= prevEnd;
}

/* ----- I-9 Supplement B: rehire ------------------------------------------- */

/** A rehire may reuse the original I-9 within this many years of its completion (8 CFR 274a.2(c)(1)(i)). */
export const REHIRE_REUSE_YEARS = 3;

/** The last day a rehire may reuse an I-9 completed (Section 2) on `originalSection2On`. */
export function rehireReuseEnds(originalSection2On: string): string {
  return dateColumnKey(addYearsUtc(asDay(originalSection2On), REHIRE_REUSE_YEARS));
}

/**
 * Does a REHIRE Supplement B belong to the employment that began on
 * `currentHire`? Its rehire date is on or after that first day, or it was
 * recorded within the employment's first three business days (a rehire
 * date typed as the offer's day). A late entry for an older rehire never
 * covers a newer employment.
 */
export function rehireCoversEmployment(r: { rehiredOn: string; reviewedOn: string }, currentHire: string | null | undefined): boolean {
  if (!currentHire) return false;
  if (r.rehiredOn >= currentHire) return true;
  const third = section2DueBy(currentHire);
  return r.reviewedOn >= currentHire && !!third && r.reviewedOn <= dateColumnKey(third);
}

/**
 * A rehire exempt from a new E-Verify case (owner, 2026-11-03): the earlier
 * I-9 was reused through a REHIRE Supplement B for this employment, and the
 * case on file — from the earlier employment — ended Employment Authorized.
 * No case, a nonconfirmation, or a case closed without authorization means
 * this employment still needs a case of its own.
 */
export function earlierI9Reused(
  earlierCaseStatus: string | null | undefined,
  rehires: ReadonlyArray<{ rehiredOn: string; reviewedOn: string }>,
  currentHire: string | null | undefined,
): boolean {
  return earlierCaseStatus === 'EMPLOYMENT_AUTHORIZED' && rehires.some((r) => rehireCoversEmployment(r, currentHire));
}

/* ----- I-9 needs review --------------------------------------------------- */

/**
 * Needs review (owner, 2026-11-03): an older I-9 with a work-authorization
 * end date but no Section 1 citizenship status. Nobody can tell whether the
 * date is a re-verification deadline (an alien authorized to work) or a
 * green card's expiry (never one), so HR checks the paper Section 1. For
 * people still employed (Current or Paused); a warning, never a block.
 */
export function i9NeedsReview(
  i9: { citizenshipStatus: string | null | undefined; workAuthExpiresAt: Date | null | undefined },
  group: WorkforceGroup | null,
): boolean {
  return !i9.citizenshipStatus && !!i9.workAuthExpiresAt && !!group && REVERIFYING_GROUPS.includes(group);
}

/** The I-9s that need review — the I-9 list's `?status=needs_review` and the Inbox count; narrow to a group with its ids. */
export function i9NeedsReviewWhere(opts: { associateIds?: string[] } = {}): Prisma.I9VerificationWhereInput {
  return {
    citizenshipStatus: null,
    workAuthExpiresAt: { not: null },
    associate: { separatedAt: null, erasedAt: null, deletedAt: null },
    ...(opts.associateIds ? { associateId: { in: opts.associateIds } } : {}),
  };
}

/* ----- FCRA --------------------------------------------------------------- */

/**
 * The CFPB "A Summary of Your Rights Under the Fair Credit Reporting Act",
 * condensed faithfully to the points that bear on an employment report.
 * The full form (12 CFR part 1022, Appendix K) is at the CFPB address below.
 */
export const FCRA_SUMMARY_OF_RIGHTS: readonly string[] = [
  'The federal Fair Credit Reporting Act (FCRA) promotes the accuracy, fairness, and privacy of information in the files of consumer reporting agencies. There are many types of consumer reporting agencies, including those that sell information about check writing histories, medical records, and rental history records.',
  'You must be told if information in your file has been used against you. Anyone who uses a consumer report to deny your application for credit, insurance, or employment — or to take another adverse action against you — must tell you, and must give you the name, address, and phone number of the agency that provided the information.',
  'You have the right to know what is in your file. You may request and obtain all the information about you in the files of a consumer reporting agency (your "file disclosure"). You are entitled to a free file disclosure if a person has taken adverse action against you because of information in your report.',
  'You have the right to ask for a credit score. In some cases a fee may apply.',
  'You have the right to dispute incomplete or inaccurate information. If you identify information in your file that is incomplete or inaccurate and report it to the consumer reporting agency, the agency must investigate unless your dispute is frivolous.',
  'Consumer reporting agencies must correct or delete inaccurate, incomplete, or unverifiable information, usually within 30 days. They may not report outdated negative information — in most cases, negative information more than seven years old, or bankruptcies more than ten years old.',
  'Access to your file is limited. A consumer reporting agency may provide information about you only to people with a valid need — usually to consider an application with a creditor, insurer, employer, landlord, or other business.',
  'You must give your consent for reports to be provided to employers. A consumer reporting agency may not give out information about you to your employer, or a potential employer, without your written consent.',
  'You may limit "prescreened" offers of credit and insurance you get based on information in your credit report, by calling 1-888-5-OPTOUT (1-888-567-8688).',
  'You may seek damages from violators. If a consumer reporting agency, or in some cases a user of consumer reports or a furnisher of information to a consumer reporting agency, violates the FCRA, you may be able to sue in state or federal court.',
  'Identity theft victims and active duty military personnel have additional rights.',
  'States may enforce the FCRA, and many states have their own consumer reporting laws. In some cases you may have more rights under state law. For more information, contact your state or local consumer protection agency or your state Attorney General.',
  'For more information, including the complete text of this summary, visit www.consumerfinance.gov/learnmore or write to: Consumer Financial Protection Bureau, 1700 G Street N.W., Washington, DC 20552.',
];

export interface AdverseNoticeInput {
  personName: string;
  orgName: string;
  /** The screening company that produced the report, when known. */
  providerName: string | null;
  /** The attached report's file name, so the letter names what is enclosed. */
  reportFileName: string;
  /** Pre-adverse: respond by this day. */
  waitUntil?: Date;
  /** The person to write to with questions or a dispute. */
  contactEmail: string | null;
}

export interface Notice {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(subject: string, paragraphs: string[], heading: string): Notice {
  const rights = FCRA_SUMMARY_OF_RIGHTS;
  const text = [
    ...paragraphs,
    '',
    heading,
    '',
    ...rights.map((r, i) => `${i + 1}. ${r}`),
  ].join('\n\n');
  const html = [
    ...paragraphs.map((p) => `<p>${esc(p)}</p>`),
    `<h2 style="font-size:16px;margin-top:24px">${esc(heading)}</h2>`,
    `<ol>${rights.map((r) => `<li style="margin-bottom:8px">${esc(r)}</li>`).join('')}</ol>`,
  ].join('\n');
  return { subject, text, html };
}

/**
 * The pre-adverse action notice: the report is enclosed, the summary of
 * rights follows, and the person has until `waitUntil` to respond or
 * dispute before any decision is made.
 */
export function preAdverseNotice(input: AdverseNoticeInput): Notice {
  const by = input.waitUntil ? ymd(input.waitUntil) : null;
  const paragraphs = [
    `Dear ${input.personName},`,
    `${input.orgName} is considering a decision about your employment that may be based, in whole or in part, on information in a consumer report${input.providerName ? ` prepared by ${input.providerName}` : ''}. No decision has been made yet.`,
    `A copy of the report is enclosed (${input.reportFileName}), together with "A Summary of Your Rights Under the Fair Credit Reporting Act", which is reproduced below.`,
    by
      ? `If you believe the report is inaccurate or incomplete, please tell us by ${by}. You may also dispute the information directly with the company that prepared the report. We will not take a final decision before that day.`
      : 'If you believe the report is inaccurate or incomplete, please tell us as soon as possible. You may also dispute the information directly with the company that prepared the report.',
    `The company that prepared the report did not make the decision and cannot explain why it may be taken.${input.contactEmail ? ` Questions and disputes: ${input.contactEmail}.` : ''}`,
  ];
  return render(`Pre-adverse action notice from ${input.orgName}`, paragraphs, 'A Summary of Your Rights Under the Fair Credit Reporting Act');
}

/** The final adverse action notice, after the waiting period. */
export function finalAdverseNotice(input: AdverseNoticeInput): Notice {
  const paragraphs = [
    `Dear ${input.personName},`,
    `${input.orgName} has decided not to proceed with your employment. The decision was based, in whole or in part, on information in a consumer report${input.providerName ? ` prepared by ${input.providerName}` : ''}.`,
    'The company that prepared the report did not make this decision and cannot explain why it was made.',
    `You have the right to obtain a free copy of the report from the company that prepared it within 60 days of this notice, and to dispute with that company the accuracy or completeness of any information in it. A copy of the report we used is enclosed (${input.reportFileName}), and "A Summary of Your Rights Under the Fair Credit Reporting Act" follows.`,
    input.contactEmail ? `Questions: ${input.contactEmail}.` : '',
  ].filter(Boolean);
  return render(`Adverse action notice from ${input.orgName}`, paragraphs, 'A Summary of Your Rights Under the Fair Credit Reporting Act');
}

export type AdverseStage = 'FINAL_DUE' | 'DECIDE' | 'WAITING' | 'DONE';

/** Where a check stands in the adverse-action flow, or null when it is not in it. */
export function adverseStageOf(
  c: { status: string; result: string | null; adjudication: string | null; adverseWaitUntil: Date | null; adverseSentAt: Date | null },
  now: Date = new Date(),
): AdverseStage | null {
  if (c.adjudication === 'ADVERSE') return 'DONE';
  if (c.adjudication === 'PRE_ADVERSE') {
    return c.adverseWaitUntil && c.adverseWaitUntil.getTime() <= now.getTime() ? 'FINAL_DUE' : 'WAITING';
  }
  if (c.adjudication === 'ENGAGED') return null;
  if (c.status === 'NEEDS_REVIEW' || c.result === 'consider') return 'DECIDE';
  return null;
}

/* ----- EEO ---------------------------------------------------------------- */

/** Minimum bucket size the aggregate report will publish. */
export const EEO_MIN_BUCKET = 5;

export const suppressSmall = (n: number): number | '<5' => (n > 0 && n < EEO_MIN_BUCKET ? '<5' : n);

export interface EeoRow {
  declined: boolean;
  gender: string | null;
  ethnicity: string | null;
  veteranStatus: string | null;
  disabilityStatus: string | null;
}

/** The aggregate report: counts per answer, never a row, small buckets hidden. */
export function buildEeoReport(rows: EeoRow[], applicants: number, from: string, to: string): EeoApplicantReport {
  const tally = (pick: (r: EeoRow) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (r.declined) continue;
      const v = pick(r) ?? 'NO_ANSWER';
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => [k, suppressSmall(n)]));
  };
  const declined = rows.filter((r) => r.declined).length;
  return {
    from,
    to,
    applicants,
    responses: suppressSmall(rows.length - declined),
    declined: suppressSmall(declined),
    gender: tally((r) => r.gender),
    ethnicity: tally((r) => r.ethnicity),
    veteranStatus: tally((r) => r.veteranStatus),
    disabilityStatus: tally((r) => r.disabilityStatus),
  };
}

export interface EeoAnswers {
  declined?: boolean;
  gender?: string | null;
  ethnicity?: string | null;
  veteranStatus?: string | null;
  disabilityStatus?: string | null;
}

/**
 * Save one person's answers (an applicant by candidate id, a new hire by
 * associate id). A whole-form decline keeps no answers at all. The caller
 * passes its Prisma client; this module never reads the database itself.
 */
export async function saveEeoSelfId(
  db: { eeoSelfIdentification: Prisma.EeoSelfIdentificationDelegate },
  who: { candidateId: string } | { associateId: string },
  a: EeoAnswers,
): Promise<void> {
  const declined = a.declined === true;
  const data = {
    declined,
    gender: declined ? null : (a.gender ?? null),
    ethnicity: declined ? null : (a.ethnicity ?? null),
    veteranStatus: declined ? null : (a.veteranStatus ?? null),
    disabilityStatus: declined ? null : (a.disabilityStatus ?? null),
    submittedAt: new Date(),
  };
  await db.eeoSelfIdentification.upsert({
    where: 'candidateId' in who ? { candidateId: who.candidateId } : { associateId: who.associateId },
    create: { ...who, ...data },
    update: data,
  });
}
