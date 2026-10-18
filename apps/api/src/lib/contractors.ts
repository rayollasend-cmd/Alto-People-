import type { ContractorProfile, Prisma, PrismaClient } from '@prisma/client';
import { activeConnection, contextFor } from './providers/connections.js';
import { taxBanditsRequest } from './providers/taxFiling.js';

/**
 * Contractors (1099): the W-9, IRS TIN matching, the B-notice program and
 * backup withholding, and how each state wants its 1099s.
 *
 *   backup withholding   24% of reportable payments (IRC §3406) when the
 *                        payee gave no TIN, crossed out W-9 item 2, or the
 *                        IRS said so (a B-notice left unanswered past its
 *                        deadline); reported in 1099 Box 4
 *   TIN matching         the IRS TIN Matching program (Pub 2108A): a bulk
 *                        request file of "type;TIN;name;account" lines and
 *                        a results file adding an indicator 0–8, or a
 *                        provider's interactive check
 *   B-notices            a CP2100/972CG mismatch: the first B-notice goes
 *                        out within 15 business days and backup withholding
 *                        starts by the 30th business day unless a corrected
 *                        W-9 arrives; a second mismatch within three
 *                        calendar years needs SSA or IRS validation
 *                        (Pub 1281), not just a new W-9
 *   state filing         the Combined Federal/State Filing program forwards
 *                        1099s to participating states (Pub 1220); others,
 *                        or states that also want it, are filed directly
 *
 * CONFIRM WITH IRS Pub 1281 / Pub 2108A / Pub 1220 for the current year.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const BACKUP_WITHHOLDING_RATE = 0.24;
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ----- Backup withholding --------------------------------------------------- */

export type BackupReason = 'NO_TIN' | 'NOT_CERTIFIED' | 'B_NOTICE' | 'IRS_NOTIFIED';

/** Whether a payment to this payee is subject to backup withholding today, and why. */
export function backupRequirement(profile: Pick<ContractorProfile, 'backupWithholding' | 'backupReason' | 'subjectToBackupCertified'> | null, hasTin: boolean): { required: boolean; reason: BackupReason | null } {
  if (!hasTin) return { required: true, reason: 'NO_TIN' };
  if (profile?.subjectToBackupCertified) return { required: true, reason: 'IRS_NOTIFIED' };
  if (profile?.backupWithholding) return { required: true, reason: (profile.backupReason as BackupReason | null) ?? 'B_NOTICE' };
  return { required: false, reason: null };
}

export function backupAmount(gross: number, required: boolean): number {
  return required ? round2(gross * BACKUP_WITHHOLDING_RATE) : 0;
}

/* ----- Business days (UTC dates) -------------------------------------------- */

/** Add business days to a date, skipping Saturdays and Sundays (federal holidays are not modelled). */
export function addBusinessDaysUtc(start: Date, days: number): Date {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

/** The two B-notice deadlines from the day the IRS notice arrived. */
export function bNoticeDeadlines(receivedOn: Date): { sendBy: Date; backupBy: Date } {
  return { sendBy: addBusinessDaysUtc(receivedOn, 15), backupBy: addBusinessDaysUtc(receivedOn, 30) };
}

/** A second B-notice is one for a payee who already had one in the three calendar years before. */
export function bNoticeKind(receivedOn: Date, earlier: Array<{ irsNoticeReceivedOn: Date }>): 'FIRST' | 'SECOND' {
  const floor = receivedOn.getUTCFullYear() - 3;
  return earlier.some((e) => e.irsNoticeReceivedOn.getUTCFullYear() >= floor && e.irsNoticeReceivedOn.getTime() < receivedOn.getTime()) ? 'SECOND' : 'FIRST';
}

/**
 * Start backup withholding on every payee whose B-notice deadline passed
 * without a resolution. Idempotent; returns the payees newly started.
 */
export async function applyDueBackupWithholding(db: Db, now = new Date()): Promise<number> {
  const due = await db.bNotice.findMany({
    where: { respondedAt: null, resolution: null, backupBy: { lte: now } },
    select: { id: true, profileId: true },
  });
  let started = 0;
  for (const n of due) {
    const r = await db.contractorProfile.updateMany({
      where: { id: n.profileId, backupWithholding: false },
      data: { backupWithholding: true, backupReason: 'B_NOTICE', backupStartedAt: now, backupStoppedAt: null },
    });
    started += r.count;
    await db.bNotice.update({ where: { id: n.id }, data: { resolution: 'BACKUP_STARTED' } });
  }
  return started;
}

/* ----- TIN matching (Pub 2108A) -------------------------------------------- */

/** Pub 2108A TIN type: 1 = EIN, 2 = SSN, 3 = unknown. */
export function tinTypeCode(t: string | null): 1 | 2 | 3 {
  return t === 'EIN' ? 1 : t === 'SSN' ? 2 : 3;
}

/** What each results indicator means. CONFIRM WITH IRS Pub 2108A. */
export const TIN_MATCH_CODES: Record<number, { status: 'MATCHED' | 'MISMATCH' | 'INVALID'; label: string }> = {
  0: { status: 'MATCHED', label: 'TIN and name match IRS records' },
  1: { status: 'INVALID', label: 'TIN was missing or not nine digits' },
  2: { status: 'INVALID', label: 'TIN is not currently issued' },
  3: { status: 'MISMATCH', label: 'TIN and name combination does not match IRS records' },
  4: { status: 'INVALID', label: 'Invalid request (characters the IRS cannot read)' },
  5: { status: 'INVALID', label: 'Duplicate request in the file' },
  6: { status: 'MATCHED', label: 'Matched an SSN (type was unknown)' },
  7: { status: 'MATCHED', label: 'Matched an EIN (type was unknown)' },
  8: { status: 'MATCHED', label: 'Matched both an SSN and an EIN (type was unknown)' },
};

/** The IRS reads names as 40 characters of letters, digits, spaces, hyphens and ampersands. */
export function tinMatchName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 &-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, 40);
}

export interface TinRequestRow {
  accountNumber: string;
  tinType: 1 | 2 | 3;
  tin: string;
  name: string;
}

/** A bulk request file: one "type;TIN;name;account" line per payee, CRLF-separated ASCII. */
export function buildTinMatchRequestFile(rows: TinRequestRow[]): string {
  return rows
    .map((r) => {
      const tin = r.tin.replace(/[^0-9]/g, '');
      return `${r.tinType};${tin};${tinMatchName(r.name)};${r.accountNumber.slice(0, 20)}`;
    })
    .join('\r\n');
}

/** A results file: each request line with ";indicator" appended. Returns account → indicator. */
export function parseTinMatchResultsFile(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(';');
    if (parts.length < 5) continue;
    const indicator = Number(parts[parts.length - 1]);
    const account = parts[parts.length - 2]!.trim();
    if (account && Number.isInteger(indicator) && indicator >= 0 && indicator <= 8) out.set(account, indicator);
  }
  return out;
}

/* ----- Interactive TIN matching through a provider -------------------------- */

export interface TinMatchProvider {
  name: string;
  /** One payee; resolves to a Pub 2108A indicator. */
  check(input: { tinType: 1 | 2 | 3; tin: string; name: string }): Promise<number>;
}

/**
 * TaxBandits' TIN matching. CONFIRM WITH TaxBandits API docs (TINMatching)
 * — the request/response field names below follow its published reference;
 * verify in the sandbox before production use.
 */
async function taxBanditsTinProvider(): Promise<TinMatchProvider | null> {
  const row = await activeConnection('TAX_FILING' as never);
  if (!row || row.provider !== 'TAXBANDITS') return null;
  const ctx = contextFor(row);
  return {
    name: 'TaxBandits',
    async check({ tinType, tin, name }) {
      const res = await taxBanditsRequest(ctx, 'POST', 'TINMatching/Request', {
        TINMatchingRecords: [{ SequenceId: '1', TINType: tinType === 1 ? 'EIN' : tinType === 2 ? 'SSN' : 'UNKNOWN', TIN: tin.replace(/[^0-9]/g, ''), Name: tinMatchName(name) }],
      });
      const rec = ((res.TINMatchingRecords as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};
      return mapProviderTinStatus(String(rec.TINMatchingStatus ?? rec.Status ?? ''), rec.IRSResponseCode);
    },
  };
}

/** A provider's answer as a Pub 2108A indicator. */
export function mapProviderTinStatus(status: string, irsCode?: unknown): number {
  const code = Number(irsCode);
  if (Number.isInteger(code) && code >= 0 && code <= 8) return code;
  const s = status.toLowerCase();
  if (/(^|\b)(match|matched|valid|success)(\b|$)/.test(s) && !/mis|in(valid)?/.test(s)) return 0;
  if (/not.*issued/.test(s)) return 2;
  if (/mismatch|not match|no match/.test(s)) return 3;
  return 4;
}

let testProvider: TinMatchProvider | null | undefined;
/** Tests inject a provider (or null for none). */
export function setTinMatchProviderForTests(p: TinMatchProvider | null | undefined): void {
  testProvider = p;
}

export async function tinMatchProvider(): Promise<TinMatchProvider | null> {
  if (testProvider !== undefined) return testProvider;
  return taxBanditsTinProvider();
}

/* ----- State 1099 filing ------------------------------------------------------ */

/** States without a broad personal income tax: no state 1099 filing for nonemployee pay. */
export const NO_INCOME_TAX_STATES = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);

/**
 * States that take 1099s through the IRS Combined Federal/State Filing
 * program. CONFIRM WITH IRS Pub 1220 (Part A, the CF/SF participating
 * states table) each year — participation and which forms are accepted
 * change; several also want direct filing when state tax was withheld.
 */
export const CFSF_STATES = new Set([
  'AL', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'GA', 'HI', 'ID', 'IN', 'KS', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NJ', 'NM', 'NC', 'ND', 'OH', 'OK', 'SC', 'WI',
]);

export const ALL_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

export interface StateFilingRow {
  state: string;
  cfsf: boolean;
  directFiling: boolean;
  payerStateId: string | null;
  notes: string | null;
  /** True when no row was saved and these are the defaults. */
  isDefault: boolean;
  noIncomeTax: boolean;
}

/** The default filing route for a state: CF/SF where it participates, directly where it has an income tax but doesn't. */
export function defaultStateFiling(state: string): Omit<StateFilingRow, 'payerStateId' | 'notes'> {
  const noIncomeTax = NO_INCOME_TAX_STATES.has(state);
  const cfsf = !noIncomeTax && CFSF_STATES.has(state);
  return { state, cfsf, directFiling: !noIncomeTax && !cfsf, isDefault: true, noIncomeTax };
}

/* ----- Contractor payments in 1099 totals ------------------------------------ */

export interface ContractorPaymentTotals {
  amount: number;
  backupWithheld: number;
  byBox: Map<number, number>;
  states: Map<string, { income: number; tax: number }>;
  count: number;
}

/** Paid contractor payments for one payee and tax year (pay-date rule: the run's pay date). */
export async function contractorPaymentTotals(db: Db, associateId: string, taxYear: number, form: 'NEC' | 'MISC'): Promise<ContractorPaymentTotals> {
  const rows = await db.contractorPayment.findMany({
    where: {
      associateId,
      form,
      run: { status: 'PAID', payDate: { gte: new Date(Date.UTC(taxYear, 0, 1)), lt: new Date(Date.UTC(taxYear + 1, 0, 1)) } },
    },
    select: { amount: true, backupWithheld: true, miscBox: true, workState: true, stateWithheld: true },
  });
  const out: ContractorPaymentTotals = { amount: 0, backupWithheld: 0, byBox: new Map(), states: new Map(), count: rows.length };
  for (const r of rows) {
    const amt = Number(r.amount);
    out.amount += amt;
    out.backupWithheld += Number(r.backupWithheld);
    const box = r.miscBox ?? 3;
    out.byBox.set(box, (out.byBox.get(box) ?? 0) + amt);
    if (r.workState) {
      const s = out.states.get(r.workState) ?? { income: 0, tax: 0 };
      s.income += amt;
      s.tax += Number(r.stateWithheld);
      out.states.set(r.workState, s);
    }
  }
  out.amount = round2(out.amount);
  out.backupWithheld = round2(out.backupWithheld);
  return out;
}

/** Payees with paid contractor payments of a form in a tax year. */
export async function contractorPaymentPayees(db: Db, taxYear: number, form: 'NEC' | 'MISC'): Promise<string[]> {
  const rows = await db.contractorPayment.findMany({
    where: { form, run: { status: 'PAID', payDate: { gte: new Date(Date.UTC(taxYear, 0, 1)), lt: new Date(Date.UTC(taxYear + 1, 0, 1)) } } },
    select: { associateId: true },
    distinct: ['associateId'],
  });
  return rows.map((r) => r.associateId);
}

/* ----- Inbox ------------------------------------------------------------------ */

/** Open B-notices plus payment runs someone else built that are waiting for a second person. */
export async function contractorsNeedingYou(db: Db, userId: string): Promise<{ count: number; description: string }> {
  const [notices, runs] = await Promise.all([
    db.bNotice.count({ where: { resolution: null } }),
    db.contractorPaymentRun.count({ where: { status: 'DRAFT', createdById: { not: userId }, payments: { some: {} } } }),
  ]);
  const parts: string[] = [];
  if (notices) parts.push(`${notices} B-notice${notices === 1 ? '' : 's'} open`);
  if (runs) parts.push(`${runs} payment run${runs === 1 ? '' : 's'} to approve`);
  return { count: notices + runs, description: parts.length ? `${parts.join(', ')}.` : 'IRS mismatch notices to answer and contractor payment runs waiting for a second approver.' };
}
