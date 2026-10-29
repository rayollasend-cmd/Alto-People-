import type { Transport } from './fileDelivery.js';
import { orgDateKey } from './timeAnomalies.js';
import { csvCell as sharedCsvCell } from '@alto-people/shared';

/**
 * 401(k) recordkeeper files.
 *
 * Each recordkeeper takes the same facts in its own shape. An adapter
 * turns rows into a file and reads the deferral changes a recordkeeper
 * sends back (people change their rate on the recordkeeper's site; payroll
 * must follow by the next pay date).
 *
 *   GUIDELINE     wide CSV, one row per person per pay date, delivered by
 *                 HTTPS (Guideline's payroll file endpoint).
 *   VESTWELL      wide CSV in Vestwell's column names, HTTPS.
 *   EMPOWER_SFTP  pipe-delimited, one row per person per money source
 *                 (the source-coded layout Empower and ADP Retirement
 *                 accept by SFTP), with a header and trailer record.
 *   GENERIC_SFTP  wide CSV with plain column names, for any other
 *                 recordkeeper's SFTP drop.
 *
 * Column names and money-source codes are each recordkeeper's published
 * layout as best we have it. CONFIRM WITH Guideline / Vestwell / Empower
 * payroll integration specifications (and the plan's own source-code map,
 * which recordkeepers set per plan) before a live file is sent.
 */

export type RecordkeeperId = 'GUIDELINE' | 'VESTWELL' | 'EMPOWER_SFTP' | 'GENERIC_SFTP';

export interface ContributionRow {
  ssn: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  dob: string | null;
  hireDate: string | null;
  termDate: string | null;
  payDate: string;
  grossPay: number;
  planComp: number;
  hours: number | null;
  preTax: number;
  roth: number;
  catchUpPreTax: number;
  catchUpRoth: number;
  employerMatch: number;
  safeHarbor: number;
  loans: Array<{ loanNumber: string; amount: number }>;
}

export interface CensusRow {
  ssn: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  dob: string | null;
  hireDate: string | null;
  termDate: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ytdComp: number;
  ytdHours: number;
  electionStatus: string;
  preTaxPercent: number;
  rothPercent: number;
}

export interface DeferralChange {
  ssn: string | null;
  employeeId: string | null;
  preTaxPercent: number;
  rothPercent: number;
  effectiveDate: string | null;
  optOut: boolean;
}

export interface RecordkeeperAdapter {
  id: RecordkeeperId;
  label: string;
  /** How files go by default. */
  transport: Transport;
  extension: 'csv' | 'txt';
  contributionFile(planNumber: string | null, payDate: string, rows: ContributionRow[]): string;
  censusFile(planNumber: string | null, asOf: string, rows: CensusRow[]): string;
  parseDeferralChanges(content: string): DeferralChange[];
}

const m = (n: number) => n.toFixed(2);
// One escaper for every export (@alto-people/shared): quoting, formula guard, numbers kept numeric.
const cell = (v: string | number | null | undefined) => sharedCsvCell(v);
const csv = (rows: Array<Array<string | number | null | undefined>>) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const mdy = (d: string | null) => (d ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : '');

/** Read a CSV (quoted fields, CRLF or LF). */
export function parseCsv(content: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) out.push(row);
  return out;
}

/** Deferral changes from a CSV with a header row; column names matched loosely. */
function parseChangesCsv(content: string, names: { ssn: string[]; id: string[]; pre: string[]; roth: string[]; date: string[]; optOut: string[] }): DeferralChange[] {
  const rows = parseCsv(content);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = (alts: string[]) => header.findIndex((h) => alts.includes(h));
  const iSsn = col(names.ssn);
  const iId = col(names.id);
  const iPre = col(names.pre);
  const iRoth = col(names.roth);
  const iDate = col(names.date);
  const iOpt = col(names.optOut);
  const pct = (v: string | undefined) => {
    const n = Number(String(v ?? '').replace(/[%\s]/g, ''));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  };
  const date = (v: string | undefined) => {
    const t = (v ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    return us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : null;
  };
  return rows.slice(1).map((r) => {
    const ssn = iSsn >= 0 ? (r[iSsn] ?? '').replace(/\D/g, '') : '';
    const optRaw = iOpt >= 0 ? (r[iOpt] ?? '').trim().toUpperCase() : '';
    return {
      ssn: ssn.length === 9 ? ssn : null,
      employeeId: iId >= 0 ? (r[iId] ?? '').trim() || null : null,
      preTaxPercent: iPre >= 0 ? pct(r[iPre]) : 0,
      rothPercent: iRoth >= 0 ? pct(r[iRoth]) : 0,
      effectiveDate: iDate >= 0 ? date(r[iDate]) : null,
      optOut: ['Y', 'YES', 'TRUE', '1', 'OPTOUT', 'OPT OUT'].includes(optRaw),
    };
  });
}

const CHANGE_COLUMNS = {
  ssn: ['ssn', 'socialsecuritynumber', 'employeessn', 'participantssn'],
  id: ['employeeid', 'employeenumber', 'payrollid', 'eeid'],
  pre: ['pretaxpercent', 'pretax', 'pretaxdeferral', 'deferralpercent', 'traditionalpercent', 'pretaxrate', 'pretaxdeferralpercent'],
  roth: ['rothpercent', 'roth', 'rothdeferral', 'rothrate', 'rothdeferralpercent'],
  date: ['effectivedate', 'effective', 'changedate', 'startdate'],
  optOut: ['optout', 'optedout', 'waived'],
};

const guideline: RecordkeeperAdapter = {
  id: 'GUIDELINE',
  label: 'Guideline',
  transport: 'HTTPS',
  extension: 'csv',
  contributionFile(_planNumber, _payDate, rows) {
    return csv([
      ['SSN', 'First Name', 'Last Name', 'Date of Birth', 'Date of Hire', 'Date of Termination', 'Pay Date', 'Gross Pay', 'Plan Compensation', 'Hours Worked', 'Employee Pre-Tax', 'Employee Roth', 'Catch-Up Pre-Tax', 'Catch-Up Roth', 'Employer Match', 'Safe Harbor', 'Loan Number', 'Loan Repayment'],
      ...rows.flatMap((r) => {
        const loans = r.loans.length ? r.loans : [{ loanNumber: '', amount: 0 }];
        return loans.map((l, i) => [
          r.ssn, r.firstName, r.lastName, mdy(r.dob), mdy(r.hireDate), mdy(r.termDate), mdy(r.payDate),
          i === 0 ? m(r.grossPay) : '0.00', i === 0 ? m(r.planComp) : '0.00', i === 0 ? (r.hours ?? '') : '',
          i === 0 ? m(r.preTax) : '0.00', i === 0 ? m(r.roth) : '0.00', i === 0 ? m(r.catchUpPreTax) : '0.00', i === 0 ? m(r.catchUpRoth) : '0.00',
          i === 0 ? m(r.employerMatch) : '0.00', i === 0 ? m(r.safeHarbor) : '0.00', l.loanNumber, m(l.amount),
        ]);
      }),
    ]);
  },
  censusFile(_planNumber, _asOf, rows) {
    return csv([
      ['SSN', 'First Name', 'Last Name', 'Date of Birth', 'Date of Hire', 'Date of Termination', 'Email', 'Address', 'City', 'State', 'Zip', 'YTD Compensation', 'YTD Hours', 'Status', 'Pre-Tax %', 'Roth %'],
      ...rows.map((r) => [r.ssn, r.firstName, r.lastName, mdy(r.dob), mdy(r.hireDate), mdy(r.termDate), r.email, r.addressLine1, r.city, r.state, r.zip, m(r.ytdComp), r.ytdHours.toFixed(2), r.electionStatus, r.preTaxPercent, r.rothPercent]),
    ]);
  },
  parseDeferralChanges: (c) => parseChangesCsv(c, CHANGE_COLUMNS),
};

const vestwell: RecordkeeperAdapter = {
  id: 'VESTWELL',
  label: 'Vestwell',
  transport: 'HTTPS',
  extension: 'csv',
  contributionFile(planNumber, payDate, rows) {
    return csv([
      ['Plan ID', 'Pay Date', 'Employee SSN', 'Employee ID', 'First Name', 'Last Name', 'Birth Date', 'Hire Date', 'Termination Date', 'Gross Compensation', 'Plan Compensation', 'Hours', 'Pre-Tax Deferral', 'Roth Deferral', 'Pre-Tax Catch-Up', 'Roth Catch-Up', 'Employer Match', 'Safe Harbor', 'Loan 1 ID', 'Loan 1 Payment', 'Loan 2 ID', 'Loan 2 Payment'],
      ...rows.map((r) => [
        planNumber ?? '', payDate, r.ssn, r.employeeId, r.firstName, r.lastName, r.dob ?? '', r.hireDate ?? '', r.termDate ?? '',
        m(r.grossPay), m(r.planComp), r.hours ?? '', m(r.preTax), m(r.roth), m(r.catchUpPreTax), m(r.catchUpRoth), m(r.employerMatch), m(r.safeHarbor),
        r.loans[0]?.loanNumber ?? '', r.loans[0] ? m(r.loans[0].amount) : '', r.loans[1]?.loanNumber ?? '', r.loans[1] ? m(r.loans[1].amount) : '',
      ]),
    ]);
  },
  censusFile(planNumber, asOf, rows) {
    return csv([
      ['Plan ID', 'As Of', 'Employee SSN', 'Employee ID', 'First Name', 'Last Name', 'Birth Date', 'Hire Date', 'Termination Date', 'Email', 'Address 1', 'City', 'State', 'Zip', 'YTD Compensation', 'YTD Hours', 'Eligibility Status', 'Pre-Tax Rate', 'Roth Rate'],
      ...rows.map((r) => [planNumber ?? '', asOf, r.ssn, r.employeeId, r.firstName, r.lastName, r.dob ?? '', r.hireDate ?? '', r.termDate ?? '', r.email, r.addressLine1, r.city, r.state, r.zip, m(r.ytdComp), r.ytdHours.toFixed(2), r.electionStatus, r.preTaxPercent, r.rothPercent]),
    ]);
  },
  parseDeferralChanges: (c) => parseChangesCsv(c, CHANGE_COLUMNS),
};

/**
 * Money-source codes for the source-coded layout. Recordkeepers assign
 * these per plan. CONFIRM WITH the plan's Empower / ADP source mapping.
 */
export const SOURCE_CODES = {
  preTax: 'PRE',
  roth: 'ROTH',
  catchUpPreTax: 'CUPRE',
  catchUpRoth: 'CUROTH',
  employerMatch: 'MATCH',
  safeHarbor: 'SHARB',
  loan: 'LOAN',
} as const;

const pipe = (fields: Array<string | number>) => fields.map((f) => String(f).replace(/\|/g, ' ')).join('|');

const empower: RecordkeeperAdapter = {
  id: 'EMPOWER_SFTP',
  label: 'Empower / ADP Retirement (SFTP)',
  transport: 'SFTP',
  extension: 'txt',
  contributionFile(planNumber, payDate, rows) {
    const lines: string[] = [pipe(['H', planNumber ?? '', payDate.replace(/-/g, ''), orgDateKey(new Date()).replace(/-/g, '')])]; // created today, on the company's calendar like the pay date
    let total = 0;
    let count = 0;
    for (const r of rows) {
      const person = [r.ssn, r.lastName, r.firstName, (r.dob ?? '').replace(/-/g, ''), (r.hireDate ?? '').replace(/-/g, ''), (r.termDate ?? '').replace(/-/g, ''), m(r.planComp), r.hours ?? ''];
      const sources: Array<[string, number, string]> = [
        [SOURCE_CODES.preTax, r.preTax, ''],
        [SOURCE_CODES.roth, r.roth, ''],
        [SOURCE_CODES.catchUpPreTax, r.catchUpPreTax, ''],
        [SOURCE_CODES.catchUpRoth, r.catchUpRoth, ''],
        [SOURCE_CODES.employerMatch, r.employerMatch, ''],
        [SOURCE_CODES.safeHarbor, r.safeHarbor, ''],
        ...r.loans.map((l) => [SOURCE_CODES.loan, l.amount, l.loanNumber] as [string, number, string]),
      ];
      const nonZero = sources.filter(([, amt]) => amt > 0);
      // A person with no money this pay still goes in once, so hours and comp reach the plan.
      for (const [code, amt, loan] of nonZero.length ? nonZero : [[SOURCE_CODES.preTax, 0, ''] as [string, number, string]]) {
        lines.push(pipe(['D', ...person, code, m(amt), loan]));
        total += amt;
        count += 1;
      }
    }
    lines.push(pipe(['T', count, m(Math.round(total * 100) / 100)]));
    return lines.join('\r\n') + '\r\n';
  },
  censusFile(planNumber, asOf, rows) {
    const lines = [pipe(['H', planNumber ?? '', asOf.replace(/-/g, ''), 'CENSUS'])];
    for (const r of rows) {
      lines.push(pipe(['C', r.ssn, r.lastName, r.firstName, (r.dob ?? '').replace(/-/g, ''), (r.hireDate ?? '').replace(/-/g, ''), (r.termDate ?? '').replace(/-/g, ''), r.addressLine1 ?? '', r.city ?? '', r.state ?? '', r.zip ?? '', r.email ?? '', m(r.ytdComp), r.ytdHours.toFixed(2), r.electionStatus, r.preTaxPercent, r.rothPercent]));
    }
    lines.push(pipe(['T', rows.length]));
    return lines.join('\r\n') + '\r\n';
  },
  parseDeferralChanges(content) {
    // Pipe-delimited: SSN|PreTax%|Roth%|EffectiveDate(YYYYMMDD)|OptOut(Y/N). CONFIRM WITH Empower deferral-change file layout.
    if (content.includes(',') && !content.includes('|')) return parseChangesCsv(content, CHANGE_COLUMNS);
    return content
      .split(/\r?\n/)
      .map((l) => l.split('|'))
      .filter((f) => f.length >= 3 && /^\d{9}$/.test((f[0] ?? '').replace(/\D/g, '')))
      .map((f) => {
        const d = (f[3] ?? '').trim();
        return {
          ssn: f[0]!.replace(/\D/g, ''),
          employeeId: null,
          preTaxPercent: Math.max(0, Math.min(100, Number(f[1]) || 0)),
          rothPercent: Math.max(0, Math.min(100, Number(f[2]) || 0)),
          effectiveDate: /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
          optOut: (f[4] ?? '').trim().toUpperCase() === 'Y',
        };
      });
  },
};

const generic: RecordkeeperAdapter = {
  id: 'GENERIC_SFTP',
  label: 'Other recordkeeper (SFTP)',
  transport: 'SFTP',
  extension: 'csv',
  contributionFile(planNumber, payDate, rows) {
    return csv([
      ['plan_number', 'pay_date', 'ssn', 'employee_id', 'first_name', 'last_name', 'birth_date', 'hire_date', 'termination_date', 'gross_pay', 'plan_compensation', 'hours', 'pretax', 'roth', 'catchup_pretax', 'catchup_roth', 'employer_match', 'safe_harbor', 'loan_number', 'loan_repayment'],
      ...rows.flatMap((r) => {
        const loans = r.loans.length ? r.loans : [{ loanNumber: '', amount: 0 }];
        return loans.map((l, i) => [
          planNumber ?? '', payDate, r.ssn, r.employeeId, r.firstName, r.lastName, r.dob ?? '', r.hireDate ?? '', r.termDate ?? '',
          i === 0 ? m(r.grossPay) : '0.00', i === 0 ? m(r.planComp) : '0.00', i === 0 ? (r.hours ?? '') : '',
          i === 0 ? m(r.preTax) : '0.00', i === 0 ? m(r.roth) : '0.00', i === 0 ? m(r.catchUpPreTax) : '0.00', i === 0 ? m(r.catchUpRoth) : '0.00',
          i === 0 ? m(r.employerMatch) : '0.00', i === 0 ? m(r.safeHarbor) : '0.00', l.loanNumber, m(l.amount),
        ]);
      }),
    ]);
  },
  censusFile(planNumber, asOf, rows) {
    return csv([
      ['plan_number', 'as_of', 'ssn', 'employee_id', 'first_name', 'last_name', 'birth_date', 'hire_date', 'termination_date', 'email', 'address', 'city', 'state', 'zip', 'ytd_compensation', 'ytd_hours', 'status', 'pretax_percent', 'roth_percent'],
      ...rows.map((r) => [planNumber ?? '', asOf, r.ssn, r.employeeId, r.firstName, r.lastName, r.dob ?? '', r.hireDate ?? '', r.termDate ?? '', r.email, r.addressLine1, r.city, r.state, r.zip, m(r.ytdComp), r.ytdHours.toFixed(2), r.electionStatus, r.preTaxPercent, r.rothPercent]),
    ]);
  },
  parseDeferralChanges: (c) => parseChangesCsv(c, CHANGE_COLUMNS),
};

export const RECORDKEEPERS: Record<RecordkeeperId, RecordkeeperAdapter> = {
  GUIDELINE: guideline,
  VESTWELL: vestwell,
  EMPOWER_SFTP: empower,
  GENERIC_SFTP: generic,
};

export function adapterFor(id: string): RecordkeeperAdapter {
  const a = RECORDKEEPERS[id as RecordkeeperId];
  if (!a) throw new Error(`Unknown recordkeeper ${id}`);
  return a;
}

/** Totals a file carries, for the send log. */
export function contributionTotals(rows: ContributionRow[]): Record<string, number> {
  const sum = (f: (r: ContributionRow) => number) => Math.round(rows.reduce((s, r) => s + f(r), 0) * 100) / 100;
  return {
    people: rows.length,
    preTax: sum((r) => r.preTax),
    roth: sum((r) => r.roth),
    catchUp: sum((r) => r.catchUpPreTax + r.catchUpRoth),
    employer: sum((r) => r.employerMatch + r.safeHarbor),
    loans: sum((r) => r.loans.reduce((s, l) => s + l.amount, 0)),
  };
}
