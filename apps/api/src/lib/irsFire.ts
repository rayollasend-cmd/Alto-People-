// Gap 11 — IRS FIRE e-file generator (IRS Pub 1220, Tax Year 2024).
//
// Builds the fixed-width text file the IRS FIRE (Filing Information
// Returns Electronically) system accepts as the electronic equivalent
// of paper 1099-NEC Copy A. Each record is exactly 750 characters wide;
// lines are joined with CRLF and the file is ASCII (no BOM, no UTF-8).
// Note: 750 chars — not the 512 EFW2 uses. Don't conflate the formats.
//
//   T  Transmitter   — one per file, first record
//   A  Payer         — opens a payer-EIN block
//   B  Payee         — one per 1099-NEC, immediately after its A
//   C  End-of-Payer  — closes the A block, sums B totals
//   F  End-of-File   — one per file, last record, total payee count
//
// Combined Federal/State Filing (the K record) is out of scope for now;
// states that don't participate in CF/SF require separate state filings,
// which we surface in the per-state UI instead of trying to bundle here.
//
// =============================================================================
// !!  IRS FIRE test-system validation required before any production submission  !!
//
// Field positions below are written to the Pub 1220 (Tax Year 2024)
// spec but have not been validated against the IRS FIRE Test System
// (https://fire.test.irs.gov). The IRS rejects the entire file on any
// positional mismatch.
//
//   $ npx tsx apps/api/scripts/sample-efw2.ts
//
// generates a sample IRS-FIRE file alongside the EFW2/EFW2C samples.
// Take the output to fire.test.irs.gov, run a test transmission, and
// reconcile every error before filing for real.
// =============================================================================

import type { Form1099NecBoxes } from './f1099NecAggregator.js';

const RECORD_LEN = 750;

export interface IrsFireTransmitter {
  /**
   * 5-character Transmitter Control Code assigned by the IRS when you
   * register for FIRE. Without this you can't transmit; the field is
   * mandatory and validated against IRS records.
   */
  tcc: string;
  /** 9 digits, no dashes — the transmitter's EIN. */
  ein: string;
  name: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** Tax year of the returns in this file. */
  taxYear: number;
}

export interface IrsFirePayer {
  /** 9 digits, no dashes. */
  ein: string;
  name: string;
  /** 4-line stacked address per Pub 1220 §B record layout. */
  addressLine1: string;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
}

export interface IrsFirePayee {
  /**
   * 9-digit TIN — SSN for individuals (CONTRACTOR_1099_INDIVIDUAL),
   * EIN for businesses (CONTRACTOR_1099_BUSINESS). Caller passes
   * digits-only (no dashes); the format flag is computed below.
   */
  tin: string;
  /** "1" = SSN, "2" = EIN. Drives Type-of-TIN field on B record. */
  tinTypeCode: '1' | '2';
  /** Full legal name of recipient. */
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
  /**
   * Per-recipient unique account number. Plain text, ≤ 20 chars.
   * Required when filing > 250 returns; recommended always so the IRS
   * can disambiguate recipients with similar names.
   */
  accountNumber: string;
  boxes: Form1099NecBoxes;
}

export interface IrsFireFile {
  transmitter: IrsFireTransmitter;
  payer: IrsFirePayer;
  payees: IrsFirePayee[];
}

/**
 * Builds the full IRS FIRE file as a single string (CRLF-joined records,
 * no trailing newline). Caller writes it to disk or streams it as the
 * download body — encoding must be ASCII / Windows-1252.
 */
export function buildIrsFireFile(input: IrsFireFile): string {
  const records: string[] = [];

  records.push(buildT(input.transmitter));
  records.push(buildA(input.payer, input.transmitter.taxYear));

  // Per-payer totals for the C record.
  const totals = newPayerTotals();
  let payeeSequence = 1;
  for (const payee of input.payees) {
    records.push(buildB(payee, payeeSequence, input.transmitter.taxYear));
    totals.payeeCount += 1;
    totals.box1 += payee.boxes.box1NonemployeeCompensation;
    totals.box4 += payee.boxes.box4FitWithheld;
    payeeSequence += 1;
  }

  records.push(buildC(totals, payeeSequence));
  records.push(buildF({ payeeCount: totals.payeeCount }, payeeSequence + 1));

  return records.join('\r\n');
}

// ---- Record builders -----------------------------------------------------

function buildT(t: IrsFireTransmitter): string {
  // T TRANSMITTER RECORD — Pub 1220 §B record layout T.
  const fields: Field[] = [
    fixed('T', 1, 1),
    digits(String(t.taxYear), 2, 5),
    blank(6, 6), // Prior Year Data Indicator: blank = current year
    digits(t.ein, 7, 15),
    text(t.tcc, 16, 20),
    blank(21, 27), // Reserved
    blank(28, 28), // Test File Indicator (T = test, blank = production)
    blank(29, 29), // Foreign Entity Indicator
    text(t.name, 30, 69),
    text(t.name, 70, 109), // Transmitter Name (Continuation)
    text('', 110, 149), // Company Name
    text('', 150, 189), // Company Name (Continuation)
    text('', 190, 229), // Company Mailing Address
    text('', 230, 269), // Company City
    text('', 270, 271), // Company State
    text('', 272, 280), // Company ZIP
    blank(281, 295), // Reserved
    digits('00000000', 296, 303), // Total Number of Payees (filled in F record; blank-pad here)
    text(t.contactName, 304, 343),
    text(stripPhone(t.contactPhone), 344, 358),
    text(t.contactEmail, 359, 408),
    blank(409, 499),
    blank(500, 507), // Vendor Indicator + Software fields
    blank(508, 517),
    blank(518, 748),
    blank(749, 750), // Reserved trailer
  ];
  return assemble(fields);
}

function buildA(p: IrsFirePayer, taxYear: number): string {
  // A PAYER RECORD — opens a payer-EIN block. The Type of Return field
  // ("NE") is the official IRS code for 1099-NEC; an Amount Codes field
  // bitmap tells the IRS which Box payments to expect (1 + 4 here:
  // Nonemployee compensation + Federal income tax withheld).
  const fields: Field[] = [
    fixed('A', 1, 1),
    digits(String(taxYear), 2, 5),
    blank(6, 6),
    blank(7, 11), // Combined Federal/State Filer (K-record-driven; blank = no)
    blank(12, 16), // Reserved
    digits(p.ein, 17, 25),
    text(p.name, 26, 65),
    blank(66, 66), // Last Filing Indicator: blank = not last
    fixed('NE', 67, 68), // Type of Return: NE = 1099-NEC
    text('14', 69, 84), // Amount Codes: '1' (Box 1 NEC) + '4' (Box 4 FIT)
    blank(85, 85), // Reserved
    blank(86, 86), // Foreign Entity Indicator
    text(p.name, 87, 126), // Payer Name (Cont)
    text('', 127, 166), // Transfer Agent Name
    text(p.addressLine1, 167, 206),
    text(p.city, 207, 246),
    text(p.state, 247, 248),
    digits(p.zip5, 249, 253),
    text(p.zip4 ?? '', 254, 257),
    text(stripPhone(''), 258, 272), // Payer Phone (optional, blank ok)
    blank(273, 499),
    digits('00000000', 500, 507), // Reserved-record-sequence; F record carries the real one
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

function buildB(p: IrsFirePayee, sequence: number, taxYear: number): string {
  // B PAYEE RECORD — one per 1099-NEC. The amount fields live at fixed
  // positions per the Type of Return; for NE the IRS uses "Payment
  // Amount 1" (Box 1) and "Payment Amount 4" (Box 4). We zero the
  // others. Money fields are 12 chars zero-padded in cents (NOT 11
  // like EFW2). Negative payments are encoded by flipping the rightmost
  // digit's sign-overpunch byte — out of scope here; IRS rejects
  // negatives on a 1099-NEC anyway.
  const fields: Field[] = [
    fixed('B', 1, 1),
    digits(String(taxYear), 2, 5),
    blank(6, 6), // Corrected Return Indicator (G/C/blank)
    text('', 7, 10), // Name Control (auto-derived from name; IRS recomputes)
    text(p.tinTypeCode, 11, 11),
    digits(p.tin, 12, 20),
    text(p.accountNumber, 21, 40),
    blank(41, 44), // Office Code
    blank(45, 54), // Reserved + Payee Reserved
    money(p.boxes.box1NonemployeeCompensation, 55, 66), // Payment Amount 1
    money(0, 67, 78),  // Payment Amount 2
    money(0, 79, 90),  // Payment Amount 3
    money(p.boxes.box4FitWithheld, 91, 102), // Payment Amount 4
    money(0, 103, 114), // Payment Amount 5
    money(0, 115, 126), // Payment Amount 6
    money(0, 127, 138), // Payment Amount 7
    money(0, 139, 150), // Payment Amount 8
    money(0, 151, 162), // Payment Amount 9
    money(0, 163, 174), // Payment Amount A (10)
    money(0, 175, 186), // Payment Amount B (11)
    money(0, 187, 198), // Payment Amount C (12)
    money(0, 199, 210), // Payment Amount D (13)
    money(0, 211, 222), // Payment Amount E (14)
    blank(223, 246), // Reserved
    text('', 247, 247), // Foreign Country Indicator
    text(p.name, 248, 287), // Payee Name Line 1
    text('', 288, 327), // Payee Name Line 2
    text(p.addressLine1, 328, 367),
    text(p.city, 368, 407),
    text(p.state, 408, 409),
    digits(p.zip5, 410, 414),
    text(p.zip4 ?? '', 415, 418),
    blank(419, 543), // Reserved
    blank(544, 547), // Second TIN Notice (blank = none)
    blank(548, 555),
    fixed('2', 556, 556), // Direct Sales (Box 2): 0/1; we always send 0 = false
    blank(557, 662),
    blank(663, 664),
    digits(String(sequence).padStart(8, '0'), 665, 672), // Record Sequence Number
    blank(673, 707),
    text('NE', 708, 709), // Type of Return — re-stated for some validators
    text('14', 710, 725), // Amount Codes — re-stated
    blank(726, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

interface PayerTotals {
  payeeCount: number;
  box1: number;
  box4: number;
}

function newPayerTotals(): PayerTotals {
  return { payeeCount: 0, box1: 0, box4: 0 };
}

function buildC(totals: PayerTotals, sequence: number): string {
  // C END-OF-PAYER RECORD — closes the A block. Sums every B record's
  // payment amounts. Counts must match what the IRS parses on its end;
  // mismatch rejects the file.
  const fields: Field[] = [
    fixed('C', 1, 1),
    digits(String(totals.payeeCount).padStart(8, '0'), 2, 9),
    blank(10, 15),
    money(totals.box1, 16, 33), // Control Total 1: 18-digit dollars+cents (Pub 1220 widens to 18 in C/F totals)
    money(0, 34, 51),  // Control Total 2
    money(0, 52, 69),  // Control Total 3
    money(totals.box4, 70, 87), // Control Total 4
    money(0, 88, 105),  // Control Total 5
    money(0, 106, 123),
    money(0, 124, 141),
    money(0, 142, 159),
    money(0, 160, 177),
    money(0, 178, 195),
    money(0, 196, 213),
    money(0, 214, 231),
    money(0, 232, 249),
    blank(250, 499),
    digits(String(sequence).padStart(8, '0'), 500, 507),
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

function buildF(input: { payeeCount: number }, sequence: number): string {
  // F END-OF-FILE RECORD — final record. Carries the grand total of B
  // records across every A block in the file (we have one A block).
  const fields: Field[] = [
    fixed('F', 1, 1),
    digits(String(input.payeeCount).padStart(8, '0'), 2, 9),
    blank(10, 21), // Zero-padded reserved
    blank(22, 499),
    digits(String(sequence).padStart(8, '0'), 500, 507),
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

// ---- Field primitives ----------------------------------------------------

interface Field {
  start: number;
  end: number;
  value: string;
}

function fixed(value: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (value.length !== len) {
    throw new Error(`fixed value "${value}" length ${value.length} ≠ field width ${len} (${start}-${end})`);
  }
  return { start, end, value };
}

function text(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  const cleaned = ascii(raw);
  return { start, end, value: cleaned.slice(0, len).padEnd(len, ' ') };
}

function digits(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`digits value "${raw}" has non-numeric characters (${start}-${end})`);
  }
  return { start, end, value: raw.slice(0, len).padStart(len, '0') };
}

function blank(start: number, end: number): Field {
  const len = end - start + 1;
  return { start, end, value: ' '.repeat(len) };
}

/**
 * Money in CENTS, zero-padded. IRS Pub 1220 disallows negative amounts
 * on 1099-NEC; we floor at 0.
 */
function money(amount: number, start: number, end: number): Field {
  const len = end - start + 1;
  const cents = Math.max(0, Math.round(amount * 100));
  const str = String(cents);
  if (str.length > len) {
    throw new Error(`money ${amount} (${cents}¢) exceeds field width ${len} (${start}-${end})`);
  }
  return { start, end, value: str.padStart(len, '0') };
}

function ascii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripPhone(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/**
 * Sorts fields by start position, asserts no gaps and no overlaps, and
 * concatenates into the final 750-char record. Catches positional bugs
 * at build time rather than at IRS-rejection time.
 */
function assemble(fields: Field[]): string {
  const sorted = [...fields].sort((a, b) => a.start - b.start);
  let cursor = 1;
  const parts: string[] = [];
  for (const f of sorted) {
    if (f.start !== cursor) {
      throw new Error(
        `IRS FIRE record gap or overlap: field ${f.start}-${f.end} expected to start at ${cursor}`,
      );
    }
    parts.push(f.value);
    cursor = f.end + 1;
  }
  if (cursor !== RECORD_LEN + 1) {
    throw new Error(
      `IRS FIRE record length ${cursor - 1} ≠ ${RECORD_LEN}; missing trailing field?`,
    );
  }
  const line = parts.join('');
  if (line.length !== RECORD_LEN) {
    throw new Error(`IRS FIRE record assembled to ${line.length} chars, expected ${RECORD_LEN}`);
  }
  return line;
}
