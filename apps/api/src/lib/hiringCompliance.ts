import type { Prisma } from '@prisma/client';
import type { EeoApplicantReport } from '@alto-people/shared';
import { orgDateKey } from './timeAnomalies.js';

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

/**
 * Keep the I-9 until the later of three years from the hire date and one
 * year from the separation date. Null until the person has a hire date; an
 * employee still working has no end date, so the three-year mark stands
 * until they leave (and then moves if a year after leaving is later).
 */
export function i9RetainUntil(hireDate: Date | null | undefined, separatedAt: Date | null | undefined): Date | null {
  if (!hireDate) return null;
  const threeYears = addYearsUtc(hireDate, 3);
  if (!separatedAt) return threeYears;
  const sep = new Date(`${ymd(separatedAt)}T00:00:00.000Z`);
  const oneYear = addYearsUtc(sep, 1);
  return oneYear.getTime() > threeYears.getTime() ? oneYear : threeYears;
}

/** Reverification is due the day the work authorization expires; null when it never does. */
export function i9ReverifyDueAt(workAuthExpiresAt: Date | null | undefined): Date | null {
  return workAuthExpiresAt ? new Date(workAuthExpiresAt.getTime()) : null;
}

/** Today as a date-only UTC midnight. */
export function todayUtc(now: Date = new Date()): Date {
  return new Date(`${ymd(now)}T00:00:00.000Z`);
}

/** How far ahead a work-authorization expiry counts as reverification due. */
export const REVERIFY_WINDOW_DAYS = 90;

/**
 * The I-9s whose reverification is due: work authorization expired or
 * expiring within REVERIFY_WINDOW_DAYS, for people still working. One
 * predicate for the I-9 list's `?status=reverification` and the Inbox count.
 */
export function i9ReverificationWhere(now: Date = new Date()): Prisma.I9VerificationWhereInput {
  return {
    workAuthExpiresAt: { not: null, lte: new Date(todayUtc(now).getTime() + REVERIFY_WINDOW_DAYS * DAY_MS) },
    associate: { separatedAt: null, deactivatedAt: null },
  };
}

/**
 * The I-9s past retention: the person left, and both the three-years-from-
 * hire and the one-year-from-separation marks are behind us
 * (i9RetainUntil < today). One predicate for the list and the Inbox count.
 */
export function i9RetentionWhere(now: Date = new Date()): Prisma.I9VerificationWhereInput {
  const today = todayUtc(now);
  return {
    associate: {
      hireDate: { not: null, lt: addYearsUtc(today, -3) },
      separatedAt: { not: null, lt: addYearsUtc(today, -1) },
    },
  };
}

/** Days until a date-only deadline, from a date-only today (negative = past). */
export function daysUntil(deadline: Date, today: Date = new Date()): number {
  const t = new Date(`${ymd(today)}T00:00:00.000Z`).getTime();
  return Math.round((deadline.getTime() - t) / DAY_MS);
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
