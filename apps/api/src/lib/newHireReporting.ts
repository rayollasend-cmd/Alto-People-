import type { NewHireReport, Prisma, PrismaClient } from '@prisma/client';
import { tryDecryptString } from './crypto.js';
import { employerFor } from './employment.js';
import { workStateOf } from './payNotices.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * New-hire reporting to the state directory, per hire and per state.
 *
 * Federal law (42 USC 653a(b)) requires every employer to report each new
 * hire to the state's directory within 20 days of hire, or — when filing
 * electronically — twice monthly, 12 to 16 days apart. States may set a
 * shorter deadline. A multistate employer may instead report every hire to
 * ONE state it employs in, after telling HHS which (42 USC 653a(b)(1)(B));
 * OrgSetting.newHireMultistateState holds that choice.
 *
 * Shorter state deadlines, from the states' new-hire programs as summarized
 * by HHS/OCSE ("State New Hire Reporting Requirements"). The chart could not
 * be fetched while this was written, so each is marked to confirm against
 * the state's program before relying on it; anything not listed is 20 days.
 *
 * File format: most states accept the federal new-hire record by upload,
 * and several publish their own layouts; none could be confirmed, so the
 * report is the CSV every state portal accepts for manual upload, with the
 * elements 653a(b)(1)(A) requires (employee name, address, SSN, hire date;
 * employer name, address, FEIN). A state filing service plugs in through
 * NewHireReportingProvider; without one the payroll admin downloads the
 * file, uploads it to the state portal and marks it submitted.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const FEDERAL_DEADLINE_DAYS = 20;

export const STATE_DEADLINE_DAYS: Record<string, { days: number; confirm: true }> = {
  AL: { days: 7, confirm: true },
  GA: { days: 10, confirm: true },
  IA: { days: 15, confirm: true },
  MA: { days: 14, confirm: true },
  ME: { days: 7, confirm: true },
  MS: { days: 15, confirm: true },
  RI: { days: 14, confirm: true },
  VT: { days: 10, confirm: true },
  WV: { days: 14, confirm: true },
};

export function deadlineDays(state: string): { days: number; confirmWithState: boolean } {
  const s = STATE_DEADLINE_DAYS[state.toUpperCase()];
  return s ? { days: s.days, confirmWithState: true } : { days: FEDERAL_DEADLINE_DAYS, confirmWithState: false };
}

export function dueDateFor(state: string, hireDate: Date): Date {
  const { days } = deadlineDays(state);
  return new Date(Date.UTC(hireDate.getUTCFullYear(), hireDate.getUTCMonth(), hireDate.getUTCDate() + days));
}

/** Where a hire is reported: the multistate state when one is set, else where they work. */
export async function reportingStateFor(db: Db, associateId: string): Promise<string | null> {
  const setting = await db.orgSetting.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { newHireMultistateState: true } });
  if (setting?.newHireMultistateState) return setting.newHireMultistateState.toUpperCase();
  return workStateOf(db, associateId);
}

/** Make sure a hire has its report row. Idempotent on (person, state, hire date). */
export async function ensureNewHireReport(db: Db, associateId: string): Promise<NewHireReport | null> {
  const a = await db.associate.findUnique({ where: { id: associateId }, select: { hireDate: true, tenantId: true, newHireReportedAt: true, employmentType: true } });
  if (!a?.hireDate) return null;
  // 1099 contractors are reported on Form 1099, not to the new-hire directory
  // (a few states ask for independent contractors too — not covered here).
  if (a.employmentType !== 'W2_EMPLOYEE') return null;
  const state = await reportingStateFor(db, associateId);
  if (!state) return null;
  const hireDate = new Date(Date.UTC(a.hireDate.getUTCFullYear(), a.hireDate.getUTCMonth(), a.hireDate.getUTCDate()));
  return db.newHireReport.upsert({
    where: { associateId_state_hireDate: { associateId, state, hireDate } },
    update: {},
    create: {
      associateId,
      ...(a.tenantId ? { tenantId: a.tenantId } : {}),
      state,
      hireDate,
      dueDate: dueDateFor(state, hireDate),
      // Reported before this existed (the old mark-reported button).
      ...(a.newHireReportedAt ? { status: 'SUBMITTED', method: 'MANUAL', submittedAt: a.newHireReportedAt } : {}),
    },
  });
}

/**
 * Rows for recent hires that came in some other way (an import, a manual
 * hire date) — the list never misses a hire. Looks back 90 days.
 */
export async function syncRecentHires(db: Db, tenantId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const hires = await db.associate.findMany({
    where: { tenantId, deletedAt: null, employmentType: 'W2_EMPLOYEE', hireDate: { gte: since }, newHireReports: { none: {} } },
    select: { id: true },
    take: 500,
  });
  for (const h of hires) await ensureNewHireReport(db, h.id);
  return hires.length;
}

export interface NewHireRecord {
  reportId: string;
  employerEin: string;
  employerName: string;
  employerAddress: string;
  employerCity: string;
  employerState: string;
  employerZip: string;
  ssn: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  dob: string;
  hireDate: string;
  stateOfHire: string;
}

export type NewHirePersonGap = 'ssn' | 'address';
export type NewHireEmployerGap = 'ein' | 'address';

/** A report that can't be filed yet: every reason in words, and the same split into the person's gaps and the employer's. */
export interface NewHireBlock {
  reportId: string;
  reasons: string[];
  person: NewHirePersonGap[];
  employer: NewHireEmployerGap[];
  employerId: string;
  employerName: string;
}

/** Records ready to file, and the reports that cannot be filed yet with why. */
export async function buildNewHireRecords(
  db: Db,
  reports: Array<NewHireReport>,
): Promise<{ records: NewHireRecord[]; blocked: NewHireBlock[] }> {
  const records: NewHireRecord[] = [];
  const blocked: NewHireBlock[] = [];
  for (const r of reports) {
    const a = await db.associate.findUnique({
      where: { id: r.associateId },
      select: { firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, dob: true, w4Submission: { select: { ssnEncrypted: true } } },
    });
    if (!a) continue;
    const employer = await employerFor(db, r.associateId, r.hireDate);
    const reasons: string[] = [];
    // The person's gaps and the employer's are told apart: one employer gap blocks every
    // hire it employs, so the page says it once per employer, not on every row (F500 G3).
    const person: NewHirePersonGap[] = [];
    const employerGaps: NewHireEmployerGap[] = [];
    // One unreadable SSN (rows encrypted before the 2026-06-11 key rotation)
    // blocks that one hire with a way forward — it used to throw and take the
    // whole report down with it.
    const ssn = a.w4Submission?.ssnEncrypted ? tryDecryptString(a.w4Submission.ssnEncrypted) : null;
    if (!a.w4Submission?.ssnEncrypted) {
      reasons.push('No SSN on file');
      person.push('ssn');
    } else if (ssn === null) {
      reasons.push("The SSN on file can't be read — collect the W-4 again");
      person.push('ssn');
    }
    if (!a.addressLine1 || !a.city || !a.state || !a.zip) {
      reasons.push('Home address incomplete');
      person.push('address');
    }
    if (!employer.ein) {
      reasons.push('Employer EIN missing');
      employerGaps.push('ein');
    }
    if (!employer.addressLine1 || !employer.city || !employer.state || !employer.zip) {
      reasons.push('Employer address incomplete');
      employerGaps.push('address');
    }
    if (reasons.length > 0) {
      blocked.push({ reportId: r.id, reasons, person, employer: employerGaps, employerId: employer.id, employerName: employer.legalName });
      continue;
    }
    records.push({
      reportId: r.id,
      employerEin: (employer.ein ?? '').replace(/\D/g, ''),
      employerName: employer.legalName,
      employerAddress: employer.addressLine1 ?? '',
      employerCity: employer.city ?? '',
      employerState: employer.state ?? '',
      employerZip: employer.zip ?? '',
      ssn: (ssn ?? '').replace(/\D/g, ''),
      firstName: a.firstName.trim(),
      lastName: a.lastName.trim(),
      address: a.addressLine1 ?? '',
      city: a.city ?? '',
      state: a.state ?? '',
      zip: a.zip ?? '',
      dob: a.dob ? a.dob.toISOString().slice(0, 10) : '',
      hireDate: r.hireDate.toISOString().slice(0, 10),
      stateOfHire: r.state,
    });
  }
  return { records, blocked };
}

const CSV_HEADER = [
  'Employer FEIN', 'Employer Name', 'Employer Address', 'Employer City', 'Employer State', 'Employer Zip',
  'Employee SSN', 'Employee First Name', 'Employee Last Name', 'Employee Address', 'Employee City', 'Employee State', 'Employee Zip',
  'Date of Birth', 'Date of Hire', 'State of Hire',
];

export function newHireCsv(records: NewHireRecord[]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [CSV_HEADER.join(',')];
  for (const r of records) {
    rows.push(
      [r.employerEin, r.employerName, r.employerAddress, r.employerCity, r.employerState, r.employerZip, r.ssn, r.firstName, r.lastName, r.address, r.city, r.state, r.zip, r.dob, r.hireDate, r.stateOfHire]
        .map((v) => esc(String(v)))
        .join(','),
    );
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * A filing provider. ELECTRONIC ones submit to the state themselves
 * (none ships configured; tests register a mock). The one that ships is
 * MANUAL_UPLOAD: the CSV this file produces, which a person uploads at
 * the state portal — registered formally so the product says so instead
 * of implying an electronic filing it never makes.
 */
export interface NewHireReportingProvider {
  key: string;
  label: string;
  /** ELECTRONIC files for the person; MANUAL_UPLOAD produces the file the person files. Absent = ELECTRONIC (the mocks). */
  kind?: 'ELECTRONIC' | 'MANUAL_UPLOAD';
  /** States this service files in ('*' = every state). */
  states: string[];
  submit(state: string, records: NewHireRecord[]): Promise<{ confirmation: string }>;
}

const providers = new Map<string, NewHireReportingProvider>();

export function registerNewHireProvider(p: NewHireReportingProvider): void {
  providers.set(p.key, p);
}

export function unregisterNewHireProvider(key: string): void {
  providers.delete(key);
}

/** The provider that files electronically for a state, if one is connected. The CSV provider never is. */
export function providerForState(state: string): NewHireReportingProvider | null {
  for (const p of providers.values()) if ((p.kind ?? 'ELECTRONIC') === 'ELECTRONIC' && (p.states.includes(state) || p.states.includes('*'))) return p;
  return null;
}

/** The provider that ships: the CSV every state portal accepts, uploaded by hand. */
export const CSV_MANUAL_UPLOAD_PROVIDER: NewHireReportingProvider = {
  key: 'csv-manual-upload',
  label: 'CSV for the state portal',
  kind: 'MANUAL_UPLOAD',
  states: ['*'],
  async submit() {
    throw new Error('The CSV provider does not file: download the file, upload it at the state portal and mark the reports submitted.');
  },
};
registerNewHireProvider(CSV_MANUAL_UPLOAD_PROVIDER);

export interface NewHireFilingStatus {
  /** How this state's reports get filed today. */
  kind: 'ELECTRONIC' | 'MANUAL_UPLOAD';
  provider: { key: string; label: string };
  configured: boolean;
  /** What the person has to do. */
  note: string;
}

/** How new hires are filed for a state: an electronic service when one is connected, else the CSV for manual upload. */
export function filingStatus(state?: string): NewHireFilingStatus {
  const electronic = state ? providerForState(state) : null;
  if (electronic) {
    return { kind: 'ELECTRONIC', provider: { key: electronic.key, label: electronic.label }, configured: true, note: `${electronic.label} files with the state and returns a confirmation.` };
  }
  return {
    kind: 'MANUAL_UPLOAD',
    provider: { key: CSV_MANUAL_UPLOAD_PROVIDER.key, label: CSV_MANUAL_UPLOAD_PROVIDER.label },
    configured: true,
    note: 'Manual upload: download the CSV, upload it at the state new-hire portal, then mark the reports submitted with the confirmation. No electronic filing service is connected.',
  };
}

/** Mark reports filed; the person's record shows the date too. */
export async function markSubmitted(
  db: Db,
  reportIds: string[],
  input: { method: 'MANUAL' | 'PROVIDER'; confirmation: string | null; userId: string },
): Promise<number> {
  const rows = await db.newHireReport.findMany({ where: { id: { in: reportIds }, status: 'DUE' }, select: { id: true, associateId: true } });
  if (rows.length === 0) return 0;
  const now = new Date();
  await db.newHireReport.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'SUBMITTED', method: input.method, confirmation: input.confirmation, submittedAt: now, submittedById: input.userId },
  });
  await db.associate.updateMany({ where: { id: { in: rows.map((r) => r.associateId) }, newHireReportedAt: null }, data: { newHireReportedAt: now } });
  return rows.length;
}
