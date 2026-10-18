import type { NewHireReport, Prisma, PrismaClient } from '@prisma/client';
import { decryptString } from './crypto.js';
import { employerFor } from './employment.js';
import { workStateOf } from './payNotices.js';

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
  const setting = await db.orgSetting.findFirst({ select: { newHireMultistateState: true } });
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

/** Records ready to file, and the reports that cannot be filed yet with why. */
export async function buildNewHireRecords(
  db: Db,
  reports: Array<NewHireReport>,
): Promise<{ records: NewHireRecord[]; blocked: Array<{ reportId: string; reasons: string[] }> }> {
  const records: NewHireRecord[] = [];
  const blocked: Array<{ reportId: string; reasons: string[] }> = [];
  for (const r of reports) {
    const a = await db.associate.findUnique({
      where: { id: r.associateId },
      select: { firstName: true, lastName: true, addressLine1: true, city: true, state: true, zip: true, dob: true, w4Submission: { select: { ssnEncrypted: true } } },
    });
    if (!a) continue;
    const employer = await employerFor(db, r.associateId, r.hireDate);
    const reasons: string[] = [];
    if (!a.w4Submission?.ssnEncrypted) reasons.push('No SSN on file');
    if (!a.addressLine1 || !a.city || !a.state || !a.zip) reasons.push('Home address incomplete');
    if (!employer.ein) reasons.push('Employer EIN missing');
    if (!employer.addressLine1 || !employer.city || !employer.state || !employer.zip) reasons.push('Employer address incomplete');
    if (reasons.length > 0) {
      blocked.push({ reportId: r.id, reasons });
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
      ssn: decryptString(a.w4Submission!.ssnEncrypted!).replace(/\D/g, ''),
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

/** A state filing service. None ships enabled; tests use a mock. */
export interface NewHireReportingProvider {
  key: string;
  label: string;
  /** States this service files in. */
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

export function providerForState(state: string): NewHireReportingProvider | null {
  for (const p of providers.values()) if (p.states.includes(state)) return p;
  return null;
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
