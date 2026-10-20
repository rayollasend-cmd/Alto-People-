import { createHash } from 'node:crypto';
import type { BankCsvMapping } from '@alto-people/shared';

/**
 * Bank statement files, read: CSV (any bank's export, columns detected and
 * confirmed by a person) and OFX / QFX (the format Quicken and most banks
 * offer, one STMTTRN per transaction with its own FITID).
 *
 * A parsed transaction's amount is signed from the account's point of view:
 * > 0 money in, < 0 money out. externalId is what de-duplicates a re-import:
 * the bank's FITID for OFX; for CSV, a hash of date + amount + description
 * and how many identical rows came before it in the same file (two equal
 * coffees on one day stay two).
 */

export interface ParsedTxn {
  postedOn: string;
  amount: number;
  description: string;
  payee: string | null;
  reference: string | null;
  externalId: string;
}

export interface ParseResult {
  transactions: ParsedTxn[];
  errors: string[];
  /** OFX: the statement's ledger balance and its date, when present. */
  ledgerBalance?: { amount: number; asOf: string | null } | null;
}

/* ---- CSV ------------------------------------------------------------------ */

/** RFC 4180-ish: quotes, doubled quotes, commas and newlines inside quotes; comma, semicolon or tab separated. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => ({ s, n: firstLine.split(s).length })).sort((a, b) => b.n - a.n)[0]!.s;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** "$1,234.56", "(12.00)", "-12", "12.00 CR" → a number, or null. */
export function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/\s*(dr|debit)$/i.test(s)) {
    neg = true;
    s = s.replace(/\s*(dr|debit)$/i, '');
  } else s = s.replace(/\s*(cr|credit)$/i, '');
  s = s.replace(/[$€£\s,]/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return neg ? -n : n;
}

/** A date cell in the given order (or ISO), as YYYY-MM-DD, or null. */
export function parseDate(raw: string | undefined, order: 'MDY' | 'DMY' | 'YMD' = 'MDY'): string | null {
  if (!raw) return null;
  const s = raw.trim().split(/[ T]/)[0]!;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  const parts = s.split(/[/.-]/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (compact) [y, m, d] = [Number(compact[1]), Number(compact[2]), Number(compact[3])];
  else if (parts.length === 3) {
    const [a, b, c] = parts.map(Number) as [number, number, number];
    if (order === 'YMD' || parts[0]!.length === 4) [y, m, d] = [a, b, c];
    else if (order === 'DMY') [y, m, d] = [c, b, a];
    else [y, m, d] = [c, a, b];
    if (y < 100) y += 2000;
  } else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Guess the columns from the header names (and, failing that, the cells):
 * Chase, Bank of America, Wells Fargo, Amex, Capital One and QuickBooks
 * exports all fit. The person confirms the guess before anything imports.
 */
export function detectCsvMapping(rows: string[][]): BankCsvMapping | null {
  if (rows.length === 0) return null;
  const header = rows[0]!.map(norm);
  // A header row has words and no date in it.
  const looksLikeHeader = rows[0]!.some((c) => /[a-z]/i.test(c)) && !rows[0]!.some((c) => parseDate(c) !== null);
  // Names in order of preference: an exact header first, then one containing it.
  const find = (...names: string[]) => {
    for (const n of names) {
      const exact = header.indexOf(n);
      if (exact >= 0) return exact;
    }
    for (const n of names) {
      const near = header.findIndex((h) => h.includes(n));
      if (near >= 0) return near;
    }
    return -1;
  };
  if (looksLikeHeader) {
    const date = find('postingdate', 'transactiondate', 'posteddate', 'date');
    const desc = find('description', 'payee', 'name', 'memo', 'details', 'merchant');
    const amount = header.findIndex((h) => h === 'amount' || h === 'transactionamount' || h === 'amountusd');
    const debit = find('debit', 'withdrawal', 'moneyout', 'paidout');
    const credit = find('credit', 'deposit', 'moneyin', 'paidin');
    const ref = find('checknumber', 'check', 'reference', 'refno');
    if (date < 0 || desc < 0 || (amount < 0 && debit < 0 && credit < 0)) return null;
    // Amex shows a charge as a positive "Amount"; most card exports with "Type: Sale" do too.
    const cardish = header.some((h) => h === 'type' || h === 'category') && amount >= 0 && rows.slice(1, 30).filter((r) => (parseMoney(r[amount]) ?? 0) > 0).length > rows.slice(1, 30).length * 0.8;
    return {
      dateColumn: date,
      descriptionColumn: desc,
      amountColumn: amount >= 0 ? amount : null,
      debitColumn: amount >= 0 ? null : debit >= 0 ? debit : null,
      creditColumn: amount >= 0 ? null : credit >= 0 ? credit : null,
      referenceColumn: ref >= 0 && ref !== desc ? ref : null,
      flipSign: cardish,
      dateOrder: guessDateOrder(rows.slice(1).map((r) => r[date] ?? '')),
      hasHeader: true,
    };
  }
  // No header: the first date-like column, the first money-like column, and the longest text column.
  const sample = rows.slice(0, 20);
  const cols = rows[0]!.length;
  const score = (i: number, f: (s: string) => boolean) => sample.filter((r) => f(r[i] ?? '')).length;
  let date = -1;
  let amount = -1;
  let desc = -1;
  let longest = 0;
  for (let i = 0; i < cols; i++) {
    if (date < 0 && score(i, (s) => parseDate(s) !== null) >= sample.length * 0.8) date = i;
    else if (amount < 0 && score(i, (s) => parseMoney(s) !== null) >= sample.length * 0.8) amount = i;
    else {
      const len = sample.reduce((n, r) => n + (r[i]?.length ?? 0), 0);
      if (len > longest) [longest, desc] = [len, i];
    }
  }
  if (date < 0 || amount < 0 || desc < 0) return null;
  return { dateColumn: date, descriptionColumn: desc, amountColumn: amount, debitColumn: null, creditColumn: null, referenceColumn: null, flipSign: false, dateOrder: guessDateOrder(sample.map((r) => r[date] ?? '')), hasHeader: false };
}

function guessDateOrder(values: string[]): 'MDY' | 'DMY' | 'YMD' {
  for (const v of values) {
    const p = v.trim().split(/[ T]/)[0]!.split(/[/.-]/);
    if (p.length !== 3) continue;
    if (p[0]!.length === 4) return 'YMD';
    if (Number(p[0]) > 12) return 'DMY';
    if (Number(p[1]) > 12) return 'MDY';
  }
  return 'MDY';
}

export function csvToTransactions(rows: string[][], mapping: BankCsvMapping): ParseResult {
  const out: ParsedTxn[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  body.forEach((r, i) => {
    const line = i + (mapping.hasHeader ? 2 : 1);
    const postedOn = parseDate(r[mapping.dateColumn], mapping.dateOrder);
    const description = (r[mapping.descriptionColumn] ?? '').replace(/\s+/g, ' ').trim();
    let amount: number | null = null;
    if (mapping.amountColumn !== null && mapping.amountColumn !== undefined) amount = parseMoney(r[mapping.amountColumn]);
    else {
      const out_ = mapping.debitColumn !== null ? parseMoney(r[mapping.debitColumn]) : null;
      const in_ = mapping.creditColumn !== null ? parseMoney(r[mapping.creditColumn]) : null;
      if (out_ !== null || in_ !== null) amount = Math.round(((in_ !== null ? Math.abs(in_) : 0) - (out_ !== null ? Math.abs(out_) : 0)) * 100) / 100;
    }
    if (amount !== null && mapping.flipSign) amount = -amount;
    if (!postedOn) {
      // A trailing "Total" row or a blank date is not an error worth a person's time.
      if ((r[mapping.dateColumn] ?? '').trim()) errors.push(`Row ${line}: “${r[mapping.dateColumn]}” isn’t a date.`);
      return;
    }
    if (amount === null || amount === 0) {
      if (amount === null) errors.push(`Row ${line}: no amount.`);
      return;
    }
    const reference = mapping.referenceColumn !== null && mapping.referenceColumn !== undefined ? (r[mapping.referenceColumn] || null) : null;
    const key = `${postedOn}|${amount.toFixed(2)}|${description.toLowerCase()}|${reference ?? ''}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    out.push({ postedOn, amount, description: description.slice(0, 300) || '(no description)', payee: null, reference: reference?.slice(0, 80) ?? null, externalId: `csv:${createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 40)}` });
  });
  return { transactions: out, errors };
}

/* ---- OFX / QFX ------------------------------------------------------------ */

/** The value of an OFX tag (SGML: <TAG>value, no closing tag; or XML: <TAG>value</TAG>). */
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1]!.trim() : null;
}

function ofxDate(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

export function isOfx(text: string): boolean {
  return /<OFX>/i.test(text) || /OFXHEADER/i.test(text.slice(0, 500));
}

export function parseOfx(text: string): ParseResult {
  const out: ParsedTxn[] = [];
  const errors: string[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]!);
  blocks.forEach((b, i) => {
    const postedOn = ofxDate(tag(b, 'DTPOSTED'));
    const amount = parseMoney(tag(b, 'TRNAMT') ?? undefined);
    const fitid = tag(b, 'FITID');
    const name = tag(b, 'NAME');
    const memo = tag(b, 'MEMO');
    if (!postedOn || amount === null) {
      errors.push(`Transaction ${i + 1}: missing date or amount.`);
      return;
    }
    const description = decodeEntities([name, memo].filter(Boolean).join(' — ') || '(no description)').slice(0, 300);
    const check = tag(b, 'CHECKNUM') ?? tag(b, 'REFNUM');
    out.push({
      postedOn,
      amount,
      description,
      payee: name ? decodeEntities(name).slice(0, 160) : null,
      reference: check?.slice(0, 80) ?? null,
      externalId: fitid ? `ofx:${fitid.slice(0, 150)}` : `ofx:${createHash('sha256').update(`${postedOn}|${amount}|${description}|${i}`).digest('hex').slice(0, 40)}`,
    });
  });
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(text);
  const balAmt = ledger ? parseMoney(tag(ledger[1]!, 'BALAMT') ?? undefined) : null;
  return { transactions: out, errors, ledgerBalance: balAmt !== null ? { amount: balAmt, asOf: ofxDate(tag(ledger![1]!, 'DTASOF')) } : null };
}
