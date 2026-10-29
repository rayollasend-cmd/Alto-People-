/**
 * NACHA ACH files — written and read.
 *
 * The format is fixed-width: every record is exactly 94 characters, records
 * are grouped in blocks of 10 (a short last block is padded with lines of
 * nines), and every file is
 *
 *   1  File Header
 *   5  Batch Header        ┐ one per batch (one SEC code, one effective date)
 *   6  Entry Detail        │ one per payment
 *   7  Addenda (optional)  │
 *   8  Batch Control       ┘ counts, entry hash, debit and credit totals
 *   9  File Control          the same, for the whole file
 *
 * We originate two kinds of batch: PPD credits to employees' accounts
 * (pay, split deposits, prenotes, micro-deposits) and CCD entries with a
 * business (the employer's funding debit, and later tax and garnishment
 * payments). The reader parses the files a bank sends back: returns (an
 * entry with an addenda type 99 carrying an R-code) and notifications of
 * change (addenda type 98 carrying a C-code and the corrected data).
 *
 * Positions below are 1-based, as the NACHA Operating Rules print them.
 */

export type SecCode = 'PPD' | 'CCD';
export type AccountType = 'CHECKING' | 'SAVINGS';

/** 22/32 credit, 27/37 debit; prenotes 23/33 and 28/38 (zero dollars). */
export function transactionCode(account: AccountType, direction: 'credit' | 'debit', prenote = false): string {
  const base = account === 'SAVINGS' ? 30 : 20;
  const offset = direction === 'credit' ? (prenote ? 3 : 2) : prenote ? 8 : 7;
  return String(base + offset);
}

export const isCreditCode = (code: string): boolean => ['21', '22', '23', '24', '31', '32', '33', '34', '41', '42', '43', '51', '52', '53'].includes(code);
export const isPrenoteCode = (code: string): boolean => ['23', '28', '33', '38'].includes(code);

/** ABA check digit: weights 3,7,1 across the nine digits sum to a multiple of 10. */
export function isValidRouting(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = routing.split('').reduce((s, d, i) => s + Number(d) * w[i]!, 0);
  return sum % 10 === 0;
}

/* ----- fixed-width fields ---------------------------------------------- */

/** Letters, digits and the punctuation NACHA allows; everything upper-case. */
function clean(v: string): string {
  return v
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,&'/()\-*#@\\]/g, ' '); // '\' ends an X12 segment in a DED/TXP addenda
}
function alpha(v: string | null | undefined, len: number): string {
  return clean(v ?? '').slice(0, len).padEnd(len, ' ');
}
function num(v: number | bigint | string, len: number): string {
  const s = String(v).replace(/\D/g, '');
  if (s.length > len) throw new NachaError(`Number ${s} does not fit in ${len} digits.`);
  return s.padStart(len, '0');
}
/** Immediate origin: a 9-digit routing number with its leading space, or 10 digits ('1' + EIN). */
function originField(v: string): string {
  const t = v.trim();
  if (/^\d{9}$/.test(t)) return ' ' + t;
  if (/^[0-9A-Z]{10}$/.test(t)) return t;
  throw new NachaError('Immediate origin is your bank-assigned 10-character ID or a 9-digit routing number.');
}
function yymmdd(d: string): string {
  // d is YYYY-MM-DD
  return d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
}

export class NachaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NachaError';
  }
}

/* ----- writing ------------------------------------------------------------ */

export interface NachaFileHeader {
  /** The ODFI's routing number (9 digits); written with its leading space. */
  immediateDestination: string;
  immediateDestinationName: string;
  /** Usually '1' + the company's EIN, or the ODFI-assigned origin (10). */
  immediateOrigin: string;
  immediateOriginName: string;
  /** A–Z or 0–9: distinguishes files created the same day. */
  fileIdModifier: string;
  /** When the file was made (for the YYMMDD and HHMM fields). */
  createdAt: Date;
  referenceCode?: string;
}

export interface NachaEntry {
  transactionCode: string;
  /** The receiver's 9-digit routing number. */
  routingNumber: string;
  accountNumber: string;
  amountCents: number;
  /** Our reference for the receiver (an employee number, an item id). */
  individualId: string;
  individualName: string;
  /** Optional 80-character payment-related information (addenda type 05). */
  addenda?: string;
}

export interface NachaBatch {
  sec: SecCode;
  companyName: string;
  /** 10 characters: commonly '1' followed by the EIN. */
  companyId: string;
  /** Shown on the receiver's statement: "PAYROLL", "PAYROLL FUND". */
  entryDescription: string;
  /** YYYY-MM-DD the entries settle. */
  effectiveDate: string;
  /** Same-day ACH: the Company Descriptive Date carries "SD" + HHMM (e.g. SD1300). */
  sameDayWindow?: string | null;
  companyDiscretionary?: string;
  /** The ODFI's routing number; its first 8 digits begin every trace number. */
  originatingDfi: string;
  entries: NachaEntry[];
}

export interface BuiltEntry extends NachaEntry {
  traceNumber: string;
  batchNumber: number;
}

export interface BuiltFile {
  content: string;
  lines: string[];
  entries: BuiltEntry[];
  totals: { debitCents: number; creditCents: number; entryCount: number; addendaCount: number; batchCount: number; blockCount: number; entryHash: string };
}

/** Same-day ACH carries at most $1,000,000.00 per entry (NACHA, since 2022). */
export const SAME_DAY_ENTRY_LIMIT_CENTS = 100_000_000;

export function buildNachaFile(header: NachaFileHeader, batches: NachaBatch[], opts: { firstTraceSequence?: number } = {}): BuiltFile {
  if (!/^\d{9}$/.test(header.immediateDestination)) throw new NachaError('Immediate destination must be the 9-digit routing number of your bank.');
  if (!/^[A-Z0-9]$/.test(header.fileIdModifier)) throw new NachaError('File ID modifier must be one letter A–Z or digit 0–9.');
  if (batches.length === 0) throw new NachaError('A file needs at least one batch.');
  const lines: string[] = [];
  const built: BuiltEntry[] = [];
  const hh = String(header.createdAt.getUTCHours()).padStart(2, '0');
  const mi = String(header.createdAt.getUTCMinutes()).padStart(2, '0');
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: the header's YYMMDD is written from this same UTC instant.
  const created = header.createdAt.toISOString().slice(0, 10);

  lines.push(
    '1' +
      '01' +
      ' ' + num(header.immediateDestination, 9) +
      originField(header.immediateOrigin) +
      yymmdd(created) +
      hh + mi +
      header.fileIdModifier +
      '094' +
      '10' +
      '1' +
      alpha(header.immediateDestinationName, 23) +
      alpha(header.immediateOriginName, 23) +
      alpha(header.referenceCode ?? '', 8),
  );

  let trace = opts.firstTraceSequence ?? 1;
  let fileEntryCount = 0;
  let fileAddendaCount = 0;
  let fileHash = 0n;
  let fileDebit = 0;
  let fileCredit = 0;

  batches.forEach((b, bi) => {
    const batchNumber = bi + 1;
    if (b.entries.length === 0) throw new NachaError(`Batch ${batchNumber} has no entries.`);
    if (!/^\d{9}$/.test(b.originatingDfi)) throw new NachaError('Originating DFI must be your bank’s 9-digit routing number.');
    const odfi8 = b.originatingDfi.slice(0, 8);
    let credits = 0;
    let debits = 0;
    let hash = 0n;
    let count = 0;
    const hasCredit = b.entries.some((e) => isCreditCode(e.transactionCode));
    const hasDebit = b.entries.some((e) => !isCreditCode(e.transactionCode));
    const serviceClass = hasCredit && hasDebit ? '200' : hasCredit ? '220' : '225';
    lines.push(
      '5' +
        serviceClass +
        alpha(b.companyName, 16) +
        alpha(b.companyDiscretionary ?? '', 20) +
        alpha(b.companyId, 10) +
        b.sec +
        alpha(b.entryDescription, 10) +
        alpha(b.sameDayWindow ? `SD${b.sameDayWindow}` : '', 6) +
        yymmdd(b.effectiveDate) +
        '   ' +
        '1' +
        num(odfi8, 8) +
        num(batchNumber, 7),
    );
    for (const e of b.entries) {
      if (!isValidRouting(e.routingNumber)) throw new NachaError(`Routing number ${e.routingNumber} fails its check digit.`);
      if (!/^[0-9A-Za-z-]{1,17}$/.test(e.accountNumber)) throw new NachaError('Account numbers are 1–17 letters, digits or hyphens.');
      if (!Number.isInteger(e.amountCents) || e.amountCents < 0) throw new NachaError('Amounts are whole cents, zero or more.');
      if (isPrenoteCode(e.transactionCode) && e.amountCents !== 0) throw new NachaError('A prenote carries no money.');
      if (b.sameDayWindow && e.amountCents > SAME_DAY_ENTRY_LIMIT_CENTS) throw new NachaError('Same-day ACH carries at most $1,000,000.00 per entry.');
      const traceNumber = odfi8 + num(trace, 7);
      trace += 1;
      lines.push(
        '6' +
          e.transactionCode +
          e.routingNumber.slice(0, 8) +
          e.routingNumber.slice(8, 9) +
          alpha(e.accountNumber, 17) +
          num(e.amountCents, 10) +
          alpha(e.individualId, 15) +
          alpha(e.individualName, 22) +
          '  ' +
          (e.addenda ? '1' : '0') +
          traceNumber,
      );
      count += 1;
      if (e.addenda) {
        lines.push('7' + '05' + alpha(e.addenda, 80) + num(1, 4) + traceNumber.slice(-7));
        count += 1;
        fileAddendaCount += 1;
      }
      hash += BigInt(e.routingNumber.slice(0, 8));
      if (isCreditCode(e.transactionCode)) credits += e.amountCents;
      else debits += e.amountCents;
      built.push({ ...e, traceNumber, batchNumber });
      fileEntryCount += 1;
    }
    const hashStr = num((hash % 10_000_000_000n).toString(), 10);
    lines.push(
      '8' +
        serviceClass +
        num(count, 6) +
        hashStr +
        num(debits, 12) +
        num(credits, 12) +
        alpha(b.companyId, 10) +
        ' '.repeat(19) +
        ' '.repeat(6) +
        num(odfi8, 8) +
        num(batchNumber, 7),
    );
    fileHash += hash;
    fileDebit += debits;
    fileCredit += credits;
  });

  const recordCount = lines.length + 1; // + file control
  const blockCount = Math.ceil(recordCount / 10);
  const fileHashStr = num((fileHash % 10_000_000_000n).toString(), 10);
  lines.push(
    '9' +
      num(batches.length, 6) +
      num(blockCount, 6) +
      num(fileEntryCount + fileAddendaCount, 8) +
      fileHashStr +
      num(fileDebit, 12) +
      num(fileCredit, 12) +
      ' '.repeat(39),
  );
  while (lines.length % 10 !== 0) lines.push('9'.repeat(94));
  for (const [i, l] of lines.entries()) {
    if (l.length !== 94) throw new NachaError(`Record ${i + 1} is ${l.length} characters, not 94.`);
  }
  return {
    content: lines.join('\n') + '\n',
    lines,
    entries: built,
    totals: { debitCents: fileDebit, creditCents: fileCredit, entryCount: fileEntryCount, addendaCount: fileAddendaCount, batchCount: batches.length, blockCount, entryHash: fileHashStr },
  };
}

/** Checks a file's structure: lengths, blocking, counts, hashes and totals agree. */
export function validateNachaFile(content: string): { ok: true } | { ok: false; problems: string[] } {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  const problems: string[] = [];
  if (lines.length % 10 !== 0) problems.push('The file is not a whole number of 10-record blocks.');
  lines.forEach((l, i) => l.length !== 94 && problems.push(`Record ${i + 1} is ${l.length} characters.`));
  if (lines[0]?.[0] !== '1') problems.push('The first record is not a file header.');
  let batches = 0;
  let entries = 0;
  let hash = 0n;
  let debit = 0n;
  let credit = 0n;
  let bEntries = 0;
  let bHash = 0n;
  let bDebit = 0n;
  let bCredit = 0n;
  let control: string | null = null;
  for (const l of lines) {
    switch (l[0]) {
      case '5':
        batches += 1;
        bEntries = 0;
        bHash = 0n;
        bDebit = 0n;
        bCredit = 0n;
        break;
      case '6': {
        bEntries += 1;
        entries += 1;
        bHash += BigInt(l.slice(3, 11));
        const amt = BigInt(l.slice(29, 39));
        if (isCreditCode(l.slice(1, 3))) bCredit += amt;
        else bDebit += amt;
        break;
      }
      case '7':
        bEntries += 1;
        entries += 1;
        break;
      case '8': {
        if (Number(l.slice(4, 10)) !== bEntries) problems.push('A batch control count does not match its entries.');
        if (BigInt(l.slice(10, 20)) !== bHash % 10_000_000_000n) problems.push('A batch entry hash does not match.');
        if (BigInt(l.slice(20, 32)) !== bDebit || BigInt(l.slice(32, 44)) !== bCredit) problems.push('A batch total does not match its entries.');
        hash += bHash;
        debit += bDebit;
        credit += bCredit;
        break;
      }
      case '9':
        if (!control && l !== '9'.repeat(94)) control = l;
        break;
    }
  }
  if (!control) problems.push('There is no file control record.');
  else {
    if (Number(control.slice(1, 7)) !== batches) problems.push('The file batch count is wrong.');
    if (Number(control.slice(7, 13)) !== lines.length / 10) problems.push('The file block count is wrong.');
    if (Number(control.slice(13, 21)) !== entries) problems.push('The file entry count is wrong.');
    if (BigInt(control.slice(21, 31)) !== hash % 10_000_000_000n) problems.push('The file entry hash is wrong.');
    if (BigInt(control.slice(31, 43)) !== debit || BigInt(control.slice(43, 55)) !== credit) problems.push('The file totals are wrong.');
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/* ----- reading what comes back ------------------------------------------- */

export interface AchReturn {
  kind: 'RETURN';
  originalTrace: string;
  code: string;
  amountCents: number;
  transactionCode: string;
  individualId: string;
}
export interface AchNotificationOfChange {
  kind: 'NOC';
  originalTrace: string;
  code: string;
  correctedData: string;
  transactionCode: string;
  individualId: string;
}

/**
 * The returns and notifications of change in a file the bank sends back.
 * A return is an entry whose addenda is type 99 (R-code, original trace);
 * a NOC is a zero-dollar entry whose addenda is type 98 (C-code, original
 * trace, corrected data in positions 36–64).
 */
export function parseReturnFile(content: string): Array<AchReturn | AchNotificationOfChange> {
  const lines = content.split(/\r?\n/).filter((l) => l.length >= 94);
  const out: Array<AchReturn | AchNotificationOfChange> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l[0] !== '6') continue;
    const next = lines[i + 1];
    if (!next || next[0] !== '7') continue;
    const type = next.slice(1, 3);
    const transactionCode = l.slice(1, 3);
    const individualId = l.slice(39, 54).trim();
    if (type === '99') {
      out.push({ kind: 'RETURN', code: next.slice(3, 6), originalTrace: next.slice(6, 21), amountCents: Number(l.slice(29, 39)), transactionCode, individualId });
    } else if (type === '98') {
      out.push({ kind: 'NOC', code: next.slice(3, 6), originalTrace: next.slice(6, 21), correctedData: next.slice(35, 64).trim(), transactionCode, individualId });
    }
  }
  return out;
}

/**
 * What a NOC asks us to change, per the NACHA change codes we apply:
 * C01 account number, C02 routing number, C03 both (routing in 1–9, account
 * from 13), C05 transaction code (the account type), C06 account number and
 * transaction code, C07 routing, account and transaction code.
 */
export function interpretNoc(code: string, data: string): { routingNumber?: string; accountNumber?: string; accountType?: AccountType } | null {
  const typeOf = (tc: string): AccountType | undefined => (tc.startsWith('3') ? 'SAVINGS' : tc.startsWith('2') ? 'CHECKING' : undefined);
  switch (code) {
    case 'C01':
      return { accountNumber: data.slice(0, 17).trim() };
    case 'C02':
      return { routingNumber: data.slice(0, 9).trim() };
    case 'C03':
      return { routingNumber: data.slice(0, 9).trim(), accountNumber: data.slice(12, 29).trim() };
    case 'C05':
      return { accountType: typeOf(data.slice(0, 2)) };
    case 'C06':
      return { accountNumber: data.slice(0, 17).trim(), accountType: typeOf(data.slice(20, 22)) };
    case 'C07':
      return { routingNumber: data.slice(0, 9).trim(), accountNumber: data.slice(9, 26).trim(), accountType: typeOf(data.slice(26, 28)) };
    default:
      return null;
  }
}
