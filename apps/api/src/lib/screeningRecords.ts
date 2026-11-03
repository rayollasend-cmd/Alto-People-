import type { DocumentKind } from '@prisma/client';
import {
  COMPLIANCE_WORKFORCES,
  DEFAULT_COMPLIANCE_WORKFORCE,
  workforceOfStatus,
  type ComplianceWorkforce,
  type DrugTestReason,
  type ScreeningRosterGroup,
  type WorkStatus,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { getBlobStore } from './blobStore.js';
import { getBrandingSync } from './branding.js';
import { send, type SendAttachment } from './notifications.js';
import { notifyAssociate } from './notify.js';
import { peopleStandings } from './peopleStatus.js';

/**
 * Background checks and drug tests as records about PEOPLE (2026-11-03).
 *
 * The two ledgers listed every check ever made and counted them: a person
 * re-screened three times was three "Passed", every report the person ever
 * had was counted on each of their checks, and the bulk rosters sorted people
 * with their own "any approved application = active" rule. These are the
 * shared rules the background routes (routes/compliance.ts), the drug-test
 * routes (routes/drugTests.ts) and their Inbox counts use instead.
 */

/** The most rows a screening list carries; past it the list says so (`truncated`). */
export const SCREENING_LIST_CAP = 5000;

/** FCRA: the wait between the pre-adverse notice and the final notice. */
export const ADVERSE_DEFAULT_WAIT_DAYS = 7;
export const ADVERSE_MIN_WAIT_DAYS = 5;

/** The Walmart SOW's recency window for a valid drug-test result. */
export const DRUG_RESULT_WINDOW_DAYS = 60;

const DAY_MS = 86_400_000;

interface Dated {
  id: string;
  associateId: string;
  initiatedAt: Date;
}

/** Newest first: by when it was ordered, then id so ties read the same every time. */
export const newestFirst = (a: Dated, b: Dated): number =>
  b.initiatedAt.getTime() - a.initiatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Each person's newest check (or test). */
export function latestByPerson<T extends Dated>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of [...rows].sort(newestFirst)) if (!out.has(r.associateId)) out.set(r.associateId, r);
  return out;
}

export interface ReportWindow {
  /** Null for the person's first check: a report filed before any check was recorded is the first one's. */
  from: Date | null;
  /** The start of the person's next check; null for their newest. */
  to: Date | null;
}

/**
 * Which filed reports belong to which check. Reports are filed against the
 * PERSON (a document of the kind), never a check, so a report belongs to the
 * check that was current when it was filed: from that check's start to the
 * start of the person's next one. A person with one check keeps every report.
 */
export function reportWindows(rows: readonly Dated[]): Map<string, ReportWindow> {
  const byPerson = new Map<string, Dated[]>();
  for (const r of rows) byPerson.set(r.associateId, [...(byPerson.get(r.associateId) ?? []), r]);
  const out = new Map<string, ReportWindow>();
  for (const list of byPerson.values()) {
    const asc = [...list].sort((a, b) => -newestFirst(a, b));
    asc.forEach((r, i) => out.set(r.id, { from: i === 0 ? null : r.initiatedAt, to: asc[i + 1]?.initiatedAt ?? null }));
  }
  return out;
}

export const inReportWindow = (filedAt: Date, w: ReportWindow): boolean =>
  (!w.from || filedAt.getTime() >= w.from.getTime()) && (!w.to || filedAt.getTime() < w.to.getTime());

/** Reports per check, from every check of the people concerned and their filed reports. */
export function reportCounts(rows: readonly Dated[], reports: readonly { associateId: string; createdAt: Date }[]): Map<string, number> {
  const windows = reportWindows(rows);
  const byPerson = new Map<string, Dated[]>();
  for (const r of rows) byPerson.set(r.associateId, [...(byPerson.get(r.associateId) ?? []), r]);
  const out = new Map<string, number>(rows.map((r) => [r.id, 0]));
  for (const doc of reports) {
    const hit = (byPerson.get(doc.associateId) ?? []).find((r) => inReportWindow(doc.createdAt, windows.get(r.id)!));
    if (hit) out.set(hit.id, (out.get(hit.id) ?? 0) + 1);
  }
  return out;
}

/** The window of one check, read from the database (the detail drawer and the notices). */
export async function reportWindowOf(model: 'background' | 'drug', check: Dated): Promise<ReportWindow> {
  const where = { associateId: check.associateId };
  const select = { id: true, associateId: true, initiatedAt: true } as const;
  const siblings = model === 'background' ? await prisma.backgroundCheck.findMany({ where, select }) : await prisma.drugTest.findMany({ where, select });
  return reportWindows(siblings).get(check.id) ?? { from: null, to: null };
}

/**
 * Screening companies that are consumer reporting agencies. A report from
 * one — a background check, or a drug test ordered through one — is a
 * consumer report, so deciding against someone on it takes the FCRA steps.
 * A lab ordered directly (eScreen, Quest) is not one.
 */
const CRA_NAMES = /checkr|sterling|hireright|first\s*advantage|goodhire|accurate|cisive|asurint|certn|orange\s*tree|universal\s*background|backgroundchecks/i;

export function isConsumerReportingAgency(provider: string | null | undefined): boolean {
  return !!provider && CRA_NAMES.test(provider);
}

/** A background check still running: a new order for the person would be a duplicate. */
export function backgroundInFlight(c: { status: string; adjudication: string | null }): boolean {
  return c.status === 'INITIATED' || c.status === 'IN_PROGRESS' || c.status === 'NEEDS_REVIEW' || c.adjudication === 'PRE_ADVERSE';
}

/** Reasons that follow a failed test by design; a failed newest test does not block them. */
const AFTER_A_FAILURE: readonly DrugTestReason[] = ['RETURN_TO_DUTY', 'FOLLOW_UP'];

/**
 * Whether a new drug-test order for this person would be wasted or wrong: a
 * test still out, a result awaiting the Medical Review Officer (NEEDS_REVIEW)
 * or in the adverse-action steps — and, for a routine order, a failed newest
 * test (that person needs a decision, not another cup).
 */
export function drugOrderBlocked(
  tests: readonly (Dated & { status: string; adjudication: string | null })[],
  reason: DrugTestReason | null | undefined,
): boolean {
  if (tests.some((t) => t.status === 'INITIATED' || t.status === 'IN_PROGRESS' || t.status === 'NEEDS_REVIEW' || t.adjudication === 'PRE_ADVERSE')) return true;
  const newest = [...tests].sort(newestFirst)[0];
  return newest?.status === 'FAILED' && !(reason && AFTER_A_FAILURE.includes(reason));
}

/**
 * Where a person's 60-day drug-test clock runs from: the day their newest
 * passed test finished (the collection's result, not the day someone filed
 * the PDF — an old result uploaded late used to reset the clock). A person
 * with no passed test on record but a result filed (from before the ledger)
 * runs from that filing.
 */
export function drugClockFrom(
  tests: readonly (Dated & { status: string; completedAt: Date | null })[],
  newestResultFiledAt: Date | null,
): Date | null {
  let best: Date | null = null;
  for (const t of tests) {
    if (t.status !== 'PASSED') continue;
    const at = t.completedAt ?? t.initiatedAt;
    if (!best || at > best) best = at;
  }
  return best ?? newestResultFiledAt;
}

export const drugResultDue = (clockFrom: Date | null, now: Date = new Date()): boolean =>
  !clockFrom || clockFrom.getTime() < now.getTime() - DRUG_RESULT_WINDOW_DAYS * DAY_MS;

/** The day a result stops counting: 60 days after its clock started. */
export const drugResultExpiresAt = (clockFrom: Date): Date => new Date(clockFrom.getTime() + DRUG_RESULT_WINDOW_DAYS * DAY_MS);

/**
 * Each person's 60-day clock (drugClockFrom) for a whole population, in two
 * reads — so the compliance scorecard's "drug test within 60 days" signal and
 * its expiring list read the date the Drug tests tab shows (2026-11-03), not
 * the day a PDF was uploaded. People never tested are absent.
 */
export async function drugClocksFor(associateIds: readonly string[]): Promise<Map<string, Date>> {
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return new Map();
  const [passed, filed] = await Promise.all([
    prisma.drugTest.findMany({
      where: { associateId: { in: ids }, status: 'PASSED' },
      select: { id: true, associateId: true, initiatedAt: true, status: true, completedAt: true },
    }),
    prisma.documentRecord.groupBy({
      by: ['associateId'],
      where: { associateId: { in: ids }, kind: 'DRUG_TEST_RESULT', deletedAt: null },
      _max: { createdAt: true },
    }),
  ]);
  const testsOf = new Map<string, typeof passed>();
  for (const t of passed) testsOf.set(t.associateId, [...(testsOf.get(t.associateId) ?? []), t]);
  const filedOf = new Map(filed.map((f) => [f.associateId, f._max.createdAt ?? null]));
  const out = new Map<string, Date>();
  for (const id of ids) {
    const clock = drugClockFrom(testsOf.get(id) ?? [], filedOf.get(id) ?? null);
    if (clock) out.set(id, clock);
  }
  return out;
}

/** When the person's newest pass finished; null when none ever passed. */
export function lastPassedAt(rows: readonly (Dated & { status: string; completedAt: Date | null })[]): Date | null {
  let best: Date | null = null;
  for (const r of rows) {
    if (r.status !== 'PASSED') continue;
    const at = r.completedAt ?? r.initiatedAt;
    if (!best || at > best) best = at;
  }
  return best;
}

/**
 * Where a few people stand (lib/peopleStatus), for a count over a handful
 * of rows (the Inbox) without reading the whole company the way a list does
 * (lib/complianceWorkforce readWorkforce).
 */
export async function statusesOf(tenantId: string, associateIds: readonly string[], now: Date = new Date()): Promise<Map<string, WorkStatus>> {
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return new Map();
  const s = await peopleStandings({ tenantId, associateIds: ids }, now);
  return new Map([...s.people.values()].map((p) => [p.id, p.status]));
}

/** Of these people, the ones in any of these groups (`all` takes everyone still on file). */
export async function inWorkforces(
  tenantId: string,
  associateIds: readonly string[],
  groups: readonly ComplianceWorkforce[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const statuses = await statusesOf(tenantId, associateIds, now);
  return new Set([...statuses].filter(([, s]) => groups.includes('all') || groups.includes(workforceOfStatus(s))).map(([id]) => id));
}

/** Of these people, the ones in the current workforce (hired and still here). */
export const currentOf = (tenantId: string, associateIds: readonly string[], now: Date = new Date()): Promise<Set<string>> =>
  inWorkforces(tenantId, associateIds, ['current'], now);

/**
 * `?workforce=` on the one list that takes SEVERAL groups — the adverse-action
 * worklist, whose Inbox row is about Current and Starting soon together
 * (adverse action is mostly about applicants; lead, 2026-11-03): a group or
 * a comma list (`current,starting`). Unknown words are dropped, `all`
 * swallows the rest, and nothing left is the default (current). Every other
 * list reads one group (lib/complianceWorkforce workforceFromQuery).
 */
export function workforcesFromQuery(query: Record<string, unknown>): ComplianceWorkforce[] {
  const raw = query.workforce;
  const words = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === 'string' ? v.split(',') : [])).map((w) => w.trim());
  const groups = COMPLIANCE_WORKFORCES.filter((w) => words.includes(w));
  if (groups.includes('all')) return ['all'];
  return groups.length > 0 ? groups : [DEFAULT_COMPLIANCE_WORKFORCE];
}

/** A bulk-order roster's group for a status: never the people who left. */
export function rosterGroupOf(s: WorkStatus | null): ScreeningRosterGroup | null {
  if (!s) return null;
  const g = workforceOfStatus(s);
  return g === 'former' ? null : g;
}

/** The three words older clients read on a roster row. */
export const legacyRosterStatus = (g: ScreeningRosterGroup): 'ACTIVE' | 'PENDING' | 'INACTIVE' =>
  g === 'current' ? 'ACTIVE' : g === 'starting' ? 'PENDING' : 'INACTIVE';

/* ----- FCRA notices ------------------------------------------------------- */

/** The newest report filed for this check (inside its window), as an attachment — the notice must carry a copy. */
export async function reportAttachmentFor(kind: DocumentKind, associateId: string, window: ReportWindow): Promise<SendAttachment | null> {
  const doc = await prisma.documentRecord.findFirst({
    where: {
      associateId,
      kind,
      deletedAt: null,
      s3Key: { not: null },
      ...(window.from || window.to ? { createdAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lt: window.to } : {}) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { s3Key: true, filename: true, mimeType: true },
  });
  if (!doc?.s3Key) return null;
  const bytes = await getBlobStore().get(doc.s3Key);
  if (!bytes) return null;
  return { filename: doc.filename || 'report.pdf', content: bytes, contentType: doc.mimeType || 'application/pdf' };
}

/** Deliver a notice: the bell and email for a person with a login, the email on file otherwise — with the report attached. */
export async function deliverAdverseNotice(
  associate: { id: string; email: string },
  notice: { subject: string; text: string; html: string },
  attachment: SendAttachment,
  bellBody: string,
): Promise<void> {
  const user = await prisma.user.findFirst({ where: { associateId: associate.id, status: 'ACTIVE' }, select: { id: true } });
  if (user) {
    await notifyAssociate(associate.id, {
      subject: notice.subject,
      body: bellBody,
      html: notice.html,
      text: notice.text,
      category: 'compliance',
      attachments: [attachment],
    });
    return;
  }
  await send({
    channel: 'EMAIL',
    recipient: { userId: null, phone: null, email: associate.email },
    subject: notice.subject,
    body: notice.text,
    html: notice.html,
    attachments: [attachment],
    category: 'compliance',
  });
}

/** What the notice letters need about the check and the company. */
export const adverseNoticeInput = (c: { provider: string; associate: { firstName: string; lastName: string } }, reportFileName: string, waitUntil?: Date) => ({
  personName: `${c.associate.firstName} ${c.associate.lastName}`,
  orgName: getBrandingSync().orgName,
  providerName: c.provider && !['none', 'stub', 'alto-stub', 'manual'].includes(c.provider) ? c.provider : null,
  reportFileName,
  waitUntil,
  contactEmail: env.RESEND_FROM ? (env.RESEND_FROM.match(/<([^>]+)>/)?.[1] ?? env.RESEND_FROM) : null,
});
