import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { COLOR, fmt } from './docKit/index.js';
import { fontName, registerFonts, runsFor, type Weight } from './docKit/fonts.js';
import { amountInWords, protectedAmount } from './amountInWords.js';
import type { PaystubData, PaystubLine } from './paystub.js';

/**
 * Payroll checks on standard 8.5×11 "check on top" voucher stock: the
 * check face (3.5 in), then two tear-off stubs (3.75 in each), the first
 * for the employee and the second for the employer's records.
 *
 * Positions follow check-stock conventions so a #10 double-window envelope
 * shows the payee address and the company's return address, and the MICR
 * line sits in the clear band 3/16–7/16 in above the check's bottom edge
 * with the amount field left blank for the bank to encode.
 *
 * MICR: banks read the bottom line magnetically, which needs a licensed
 * E-13B font and MICR toner. Set MICR_FONT_PATH to the licensed font file
 * (the usual mapping: A = transit ⑆, B = amount, C = on-us ⑈, D = dash).
 * Without it the line prints in a placeholder face that a bank cannot read
 * — CONFIRM: install a licensed E-13B MICR font and print on MICR toner.
 * The only freely downloadable E-13B fonts we found are GPL without a font
 * exception, which we may not embed in documents we distribute.
 */

export interface CheckPrintBank {
  name: string | null;
  address: string | null;
  fractional: string | null;
  routing: string;
  account: string;
}

export interface CheckPrintItem {
  checkNumber: number;
  issuedAt: string;
  amount: number;
  payee: { name: string; line1: string | null; city: string | null; state: string | null; zip: string | null };
  memo: string;
  /** The paystub this check pays, line for line on both stubs. */
  stub: PaystubData;
  /** The check this one replaces (a reissue). */
  replacesCheckNumber?: number | null;
}

export interface CheckPrintInput {
  company: { name: string; lines: string[]; logo?: Buffer | null };
  bank: CheckPrintBank | null;
  signature: { image: Buffer | null; signerName: string | null } | null;
  twoSignatureOver: number | null;
  voidAfterDays: number;
  offset: { x: number; y: number };
  checks: CheckPrintItem[];
}

const PT = 72;
const PAGE_W = 612;
const CHECK_H = 3.5 * PT; // 252
const STUB_H = 3.75 * PT; // 270

/** Where the licensed E-13B font is, if this deployment installed one. */
export function micrFontPath(): string | null {
  const p = process.env.MICR_FONT_PATH;
  return p && existsSync(p) ? p : null;
}

type Doc = PDFKit.PDFDocument;

function drawer(doc: Doc, ox: number, oy: number) {
  const text = (s: string, x: number, y: number, o: { size?: number; weight?: Weight; color?: string; width?: number; align?: 'left' | 'right' | 'center'; display?: boolean; spacing?: number } = {}) => {
    const family = o.display ? 'display' : 'sans';
    const size = o.size ?? 9;
    const weight = o.weight ?? 'regular';
    const measure = (str: string) =>
      runsFor(str, family).reduce((w, r) => {
        doc.font(fontName(family, weight, r.subset)).fontSize(size);
        return w + doc.widthOfString(r.text, { characterSpacing: o.spacing ?? 0 });
      }, 0);
    let str = s;
    if (o.width) {
      while (str.length > 1 && measure(str) > o.width) str = `${str.slice(0, -2).trimEnd()}…`;
    }
    const w = measure(str);
    let cx = x + ox;
    if (o.width && o.align === 'right') cx = x + ox + o.width - w;
    if (o.width && o.align === 'center') cx = x + ox + (o.width - w) / 2;
    doc.fillColor(o.color ?? COLOR.ink);
    for (const r of runsFor(str, family)) {
      doc.font(fontName(family, weight, r.subset)).fontSize(size);
      doc.text(r.text, cx, y + oy, { lineBreak: false, characterSpacing: o.spacing ?? 0 });
      cx += doc.widthOfString(r.text, { characterSpacing: o.spacing ?? 0 });
    }
    return w;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: string = COLOR.ink, width = 0.6, dash?: number) => {
    doc.save().lineWidth(width).strokeColor(color);
    if (dash) doc.dash(dash, { space: dash });
    doc.moveTo(x1 + ox, y1 + oy).lineTo(x2 + ox, y2 + oy).stroke().undash().restore();
  };
  const rect = (x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; radius?: number; width?: number } = {}) => {
    doc.save();
    if (o.radius) doc.roundedRect(x + ox, y + oy, w, h, o.radius);
    else doc.rect(x + ox, y + oy, w, h);
    if (o.fill && o.stroke) doc.lineWidth(o.width ?? 0.6).fillAndStroke(o.fill, o.stroke);
    else if (o.fill) doc.fill(o.fill);
    else doc.lineWidth(o.width ?? 0.6).stroke(o.stroke ?? COLOR.ink);
    doc.restore();
  };
  return { text, line, rect };
}

/** The fine-line security background: a light guilloche across the check face. */
function securityBackground(doc: Doc, ox: number, oy: number): void {
  doc.save();
  doc.rect(ox, oy, PAGE_W, CHECK_H).clip();
  doc.rect(ox, oy, PAGE_W, CHECK_H).fill('#F7F9FC');
  doc.lineWidth(0.25);
  for (let k = 0; k < 26; k++) {
    const phase = k * 0.42;
    const amp = 7 + (k % 5);
    const baseY = 6 + k * 9.6;
    doc.strokeColor(k % 2 ? '#DCE5F2' : '#E6ECF5');
    doc.moveTo(ox, oy + baseY);
    for (let x = 0; x <= PAGE_W; x += 4) {
      doc.lineTo(ox + x, oy + baseY + Math.sin(x / 23 + phase) * amp * Math.cos(x / 97 + phase / 2));
    }
    doc.stroke();
  }
  doc.restore();
}

/** A small padlock: the industry's "security features" icon. */
function padlock(doc: Doc, x: number, y: number): void {
  doc.save().lineWidth(0.9).strokeColor(COLOR.ink2);
  doc.moveTo(x + 2.2, y + 5).lineTo(x + 2.2, y + 3).bezierCurveTo(x + 2.2, y - 0.6, x + 6.8, y - 0.6, x + 6.8, y + 3).lineTo(x + 6.8, y + 5).stroke();
  doc.roundedRect(x, y + 5, 9, 6.5, 1).fill(COLOR.ink2);
  doc.restore();
}

/** E-13B positions, counted from the right: each character cell is 1/8 in, position 1's right edge 5/16 in from the edge. */
function micrX(position: number): number {
  return PAGE_W - 0.3125 * PT - position * 9;
}

function drawMicr(doc: Doc, ox: number, oy: number, bank: CheckPrintBank | null, checkNumber: number, fontPath: string | null): void {
  const baseline = CHECK_H - 0.25 * PT; // inside the 3/16–7/16 in band
  const fields: Array<{ text: string; endPosition: number }> = bank
    ? [
        // Auxiliary on-us (business checks): ⑈check number⑈, left of the transit field.
        { text: `C${String(checkNumber).padStart(6, '0')}C`, endPosition: 45 },
        // Transit: ⑆routing⑆ in positions 33–43.
        { text: `A${bank.routing}A`, endPosition: 33 },
        // On-us: account⑈, ending at position 14. Positions 1–12 (amount) stay blank for the bank.
        { text: `${bank.account}C`, endPosition: 14 },
      ]
    : [];
  if (fontPath) {
    doc.registerFont('micr', fontPath);
    doc.font('micr').fontSize(12).fillColor('#000000');
    for (const f of fields) {
      const chars = [...f.text];
      chars.forEach((ch, i) => {
        const pos = f.endPosition + (chars.length - 1 - i);
        doc.text(ch, micrX(pos) + ox, oy + baseline - 10, { lineBreak: false });
      });
    }
    return;
  }
  // Placeholder: shows where each field goes; NOT bank-readable.
  const shown = (t: string) => t.replace(/A/g, '⑆').replace(/C/g, '⑈');
  doc.font('Courier').fontSize(10).fillColor('#5C6675');
  for (const f of fields) {
    const chars = [...shown(f.text).replace(/[⑆⑈]/g, '|')];
    chars.forEach((ch, i) => {
      const pos = f.endPosition + (chars.length - 1 - i);
      doc.text(ch, micrX(pos) + ox + 2, oy + baseline - 9, { lineBreak: false });
    });
  }
}

function addressLines(p: CheckPrintItem['payee']): string[] {
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.line1, cityLine].filter((x): x is string => !!x);
}

/* ---- The check face ----------------------------------------------------- */

function checkFace(doc: Doc, input: CheckPrintInput, c: CheckPrintItem, ox: number, oy: number, fontPath: string | null): void {
  const d = drawer(doc, ox, oy);
  securityBackground(doc, ox, oy);
  // Drawer (company) and the return address in the upper envelope window.
  let leftX = 36;
  if (input.company.logo) {
    try {
      doc.image(input.company.logo, ox + 36, oy + 20, { fit: [34, 34] });
      leftX = 78;
    } catch {
      leftX = 36;
    }
  }
  d.text(input.company.name, leftX, 22, { size: 11.5, weight: 'semibold', width: 210 });
  input.company.lines.slice(0, 3).forEach((l, i) => d.text(l, leftX, 37 + i * 10, { size: 7.5, color: COLOR.ink2, width: 210 }));
  // Bank block, centred.
  if (input.bank?.name) d.text(input.bank.name, 250, 22, { size: 8.5, weight: 'semibold', width: 150, align: 'center' });
  if (input.bank?.address) d.text(input.bank.address, 250, 33, { size: 7, color: COLOR.ink2, width: 150, align: 'center' });
  if (input.bank?.fractional) d.text(input.bank.fractional, 250, 43, { size: 7, color: COLOR.ink2, width: 150, align: 'center' });
  // Check number, top right.
  d.text('CHECK NO.', 470, 20, { size: 6.5, color: COLOR.ink3, spacing: 0.8, width: 106, align: 'right' });
  d.text(String(c.checkNumber), 470, 29, { size: 15, weight: 'semibold', width: 106, align: 'right' });
  // Date.
  d.text('DATE', 410, 64, { size: 6.5, color: COLOR.ink3, spacing: 0.8 });
  d.text(fmt.date(c.issuedAt), 440, 61, { size: 10, weight: 'medium', width: 136, align: 'right' });
  d.line(440, 74, 576, 74, COLOR.ink3, 0.4);
  // Amount box, with the padlock legend beside it.
  d.rect(456, 86, 120, 24, { fill: '#FFFFFF', stroke: COLOR.ink, width: 0.9, radius: 2 });
  d.text(protectedAmount(c.amount), 456, 92.5, { size: 12, weight: 'semibold', width: 114, align: 'right' });
  padlock(doc, ox + 456, oy + 114);
  d.text('Security features. Details on back.', 468, 116, { size: 5.8, color: COLOR.ink2 });
  // "Pay" line: the legal amount in words, filled with asterisks to the edge.
  d.text('PAY', 36, 93, { size: 6.5, color: COLOR.ink3, spacing: 0.8 });
  const words = amountInWords(c.amount);
  const used = d.text(words, 60, 90, { size: 9.5, weight: 'medium', width: 384 });
  if (used < 380) {
    doc.font(fontName('sans', 'regular', 'latin')).fontSize(9);
    const star = doc.widthOfString('*');
    d.text('*'.repeat(Math.max(0, Math.floor((384 - used - 6) / star))), 60 + used + 4, 90.5, { size: 9, color: COLOR.ink3 });
  }
  d.line(60, 103, 444, 103, COLOR.ink3, 0.4);
  // Payee: positioned for the lower window of a #10 double-window envelope.
  d.text('PAY TO THE', 36, 126, { size: 6.5, color: COLOR.ink3, spacing: 0.8 });
  d.text('ORDER OF', 36, 134, { size: 6.5, color: COLOR.ink3, spacing: 0.8 });
  d.text(c.payee.name, 90, 126, { size: 10.5, weight: 'semibold', width: 250 });
  addressLines(c.payee).forEach((l, i) => d.text(l, 90, 140 + i * 11, { size: 9, color: COLOR.ink, width: 250 }));
  // Memo.
  d.text('MEMO', 36, 192, { size: 6.5, color: COLOR.ink3, spacing: 0.8 });
  d.text(c.memo + (c.replacesCheckNumber ? ` · Replaces check #${c.replacesCheckNumber}` : ''), 66, 189.5, { size: 8.5, width: 250 });
  d.line(66, 200, 320, 200, COLOR.ink3, 0.4);
  // Signature(s): the signature line itself is microprint.
  const twoSigs = input.twoSignatureOver != null && c.amount > input.twoSignatureOver;
  d.text(`VOID AFTER ${input.voidAfterDays} DAYS`, 370, 150, { size: 6.5, weight: 'semibold', color: COLOR.ink2, spacing: 0.8, width: 206, align: 'right' });
  const microprint = (y: number) => {
    doc.font(fontName('sans', 'regular', 'latin')).fontSize(1.6).fillColor(COLOR.ink);
    doc.text('AUTHORIZEDSIGNATURE'.repeat(18), ox + 370, oy + y, { lineBreak: false, width: 206, height: 3 });
  };
  if (twoSigs) {
    microprint(178);
    d.text('AUTHORIZED SIGNATURE', 370, 181.5, { size: 5.5, color: COLOR.ink3, spacing: 0.6 });
    microprint(200);
    d.text('AUTHORIZED SIGNATURE', 370, 203.5, { size: 5.5, color: COLOR.ink3, spacing: 0.6 });
    d.text(`TWO SIGNATURES REQUIRED OVER ${fmt.money(input.twoSignatureOver!)}`, 370, 162, { size: 5.8, weight: 'semibold', color: COLOR.bad, spacing: 0.5, width: 206, align: 'right' });
  } else {
    if (input.signature?.image) {
      try {
        doc.image(input.signature.image, ox + 400, oy + 166, { fit: [150, 32], align: 'center', valign: 'bottom' });
      } catch {
        /* an unreadable image leaves the line blank for a wet signature */
      }
    }
    microprint(200);
    d.text(input.signature?.signerName ? `AUTHORIZED SIGNATURE · ${input.signature.signerName.toUpperCase()}` : 'AUTHORIZED SIGNATURE', 370, 203.5, { size: 5.5, color: COLOR.ink3, spacing: 0.6, width: 206 });
  }
  drawMicr(doc, ox, oy, input.bank, c.checkNumber, fontPath);
}

/* ---- The stubs ---------------------------------------------------------- */

function stub(doc: Doc, c: CheckPrintItem, ox: number, oy: number, copy: 'employee' | 'employer'): void {
  const d = drawer(doc, ox, oy);
  const s = c.stub;
  const name = `${s.associate.firstName} ${s.associate.lastName}`;
  d.text(copy === 'employee' ? 'PAY STATEMENT · KEEP FOR YOUR RECORDS' : 'EMPLOYER RECORD', 36, 18, { size: 6.5, weight: 'semibold', color: COLOR.brand, spacing: 0.9 });
  d.text(s.company.name, 36, 28, { size: 9.5, weight: 'semibold', width: 220 });
  d.text(s.associate.employeeId ? `${name}  ·  ID ${s.associate.employeeId}` : name, 36, 41, { size: 9, width: 240 });
  const facts: Array<[string, string, number, number]> = [
    ['Check no.', String(c.checkNumber), 300, 60],
    ['Pay date', fmt.date(s.period.payDate ?? c.issuedAt), 370, 74],
    ['Pay period', fmt.dateRange(s.period.start, s.period.end), 452, 124],
  ];
  facts.forEach(([k, v, x, w]) => {
    d.text(k.toUpperCase(), x, 26, { size: 5.8, color: COLOR.ink3, spacing: 0.6, width: w });
    d.text(v, x, 35, { size: 7.5, weight: 'medium', width: w });
  });
  d.line(36, 52, 576, 52, COLOR.ink, 0.6);

  // Three blocks side by side: earnings, taxes, deductions — current and year to date.
  const top = 58;
  const rowH = 10.2;
  const maxRows = 11;
  // Columns: a label, then up to two right-aligned figures.
  const block = (title: string, x: number, w: number, heads: [string, string], rows: Array<{ label: string; a: string; b: string }>) => {
    const bw = 50;
    d.text(title.toUpperCase(), x, top, { size: 5.8, weight: 'semibold', color: COLOR.ink3, spacing: 0.6 });
    d.text(heads[0], x + w - bw * 2, top, { size: 5.5, color: COLOR.ink3, width: bw - 2, align: 'right' });
    d.text(heads[1], x + w - bw, top, { size: 5.5, color: COLOR.ink3, width: bw, align: 'right' });
    d.line(x, top + 8, x + w, top + 8, COLOR.rule, 0.5);
    const shown = rows.length > maxRows ? rows.slice(0, maxRows - 1) : rows;
    shown.forEach((r, i) => {
      const y = top + 11 + i * rowH;
      d.text(r.label, x, y, { size: 7, width: w - bw * 2 - 4 });
      d.text(r.a, x + w - bw * 2, y, { size: 7, width: bw - 2, align: 'right' });
      d.text(r.b, x + w - bw, y, { size: 7, color: COLOR.ink2, width: bw, align: 'right' });
    });
    if (rows.length > maxRows) d.text(`+ ${rows.length - shown.length} more on your paystub`, x, top + 11 + shown.length * rowH, { size: 6.5, color: COLOR.ink3 });
  };
  block('Earnings', 36, 166, ['HOURS', 'CURRENT'], s.earnings.map((e) => ({ label: e.rate != null ? `${e.label} @ ${fmt.money(e.rate)}` : e.label, a: e.hours != null ? fmt.hours(e.hours) : '', b: fmt.money(e.amount) })));
  const neg = (ls: PaystubLine[]) => ls.map((l) => ({ label: l.label, a: fmt.money(-Math.abs(l.current)), b: fmt.money(-Math.abs(l.ytd)) }));
  block('Taxes', 214, 176, ['CURRENT', 'YTD'], neg(s.taxes));
  block('Deductions', 400, 176, ['CURRENT', 'YTD'], neg([...s.preTaxDeductions, ...s.postTaxDeductions]));

  // The summary band.
  const by = STUB_H - 58;
  d.rect(36, by, 540, 36, { fill: copy === 'employee' ? COLOR.band : COLOR.wash, radius: 3 });
  const deductions = [...s.preTaxDeductions, ...s.postTaxDeductions].reduce((a, l) => ({ c: a.c + l.current, y: a.y + l.ytd }), { c: 0, y: 0 });
  const tiles: Array<[string, number, number]> = [
    ['Gross pay', s.gross.current, s.gross.ytd],
    ['Taxes', -s.taxesTotal.current, -s.taxesTotal.ytd],
    ['Deductions', -deductions.c, -deductions.y],
    ['Net pay', s.net.current, s.net.ytd],
  ];
  const fg = copy === 'employee' ? '#FFFFFF' : COLOR.ink;
  const sub = copy === 'employee' ? COLOR.bandSub : COLOR.ink3;
  tiles.forEach(([k, cur, ytd], i) => {
    const x = 48 + i * 132;
    d.text(k.toUpperCase(), x, by + 6, { size: 5.8, color: i === 3 && copy === 'employee' ? '#E9C46A' : sub, spacing: 0.6 });
    d.text(fmt.money(cur), x, by + 15, { size: i === 3 ? 11 : 9.5, weight: 'semibold', color: fg, width: 124 });
    d.text(`YTD ${fmt.money(ytd)}`, x, by + 27.5, { size: 5.8, color: sub, width: 124 });
  });
  d.text(s.payDistribution ? `${s.payDistribution.label}${s.payDistribution.detail ? ` · ${s.payDistribution.detail}` : ''}` : `Paper check #${c.checkNumber}`, 36, STUB_H - 16, { size: 6.5, color: COLOR.ink3, width: 400 });
  d.text('NON-NEGOTIABLE', 456, STUB_H - 16, { size: 6.5, weight: 'semibold', color: COLOR.ink3, spacing: 0.8, width: 120, align: 'right' });
}

function perforation(doc: Doc, y: number): void {
  doc.save().lineWidth(0.4).strokeColor('#B9C1CD').dash(2, { space: 2.5 }).moveTo(0, y).lineTo(PAGE_W, y).stroke().undash().restore();
}

/* ---- Documents ------------------------------------------------------------ */

function newDoc(title: string, author: string): { doc: Doc; done: Promise<Buffer> } {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: false, info: { Title: title, Author: author, Creator: 'Alto People' } });
  registerFonts(doc);
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
}

/** One page per check, in check-number order. */
export function renderChecksPdf(input: CheckPrintInput): Promise<Buffer> {
  const { doc, done } = newDoc(`Payroll checks ${input.checks.map((c) => c.checkNumber).join(', ')}`.slice(0, 120), input.company.name);
  const fontPath = micrFontPath();
  const checks = [...input.checks].sort((a, b) => a.checkNumber - b.checkNumber);
  const { x: ox, y: oy } = input.offset;
  for (const c of checks) {
    doc.addPage();
    checkFace(doc, input, c, ox, oy, fontPath);
    perforation(doc, CHECK_H + oy);
    stub(doc, c, ox, CHECK_H + oy, 'employee');
    perforation(doc, CHECK_H + STUB_H + oy);
    stub(doc, c, ox, CHECK_H + STUB_H + oy, 'employer');
  }
  doc.end();
  return done;
}

/**
 * The alignment test: the same frame as a real check with each field
 * outlined and rulers in the margins, printed on plain paper and held
 * against the stock to set the calibration offsets.
 */
export function renderAlignmentPdf(input: Pick<CheckPrintInput, 'company' | 'offset'> & { micrFontInstalled: boolean }): Promise<Buffer> {
  const { doc, done } = newDoc('Check alignment test', input.company.name);
  doc.addPage();
  const { x: ox, y: oy } = input.offset;
  const d = drawer(doc, ox, oy);
  const box = (x: number, y: number, w: number, h: number, label: string) => {
    d.rect(x, y, w, h, { stroke: COLOR.info, width: 0.6 });
    d.text(label, x + 3, y + 2.5, { size: 6, color: COLOR.info });
  };
  box(36, 18, 210, 50, 'Company and return address (upper window)');
  box(250, 18, 150, 36, 'Bank');
  box(470, 18, 106, 30, 'Check no.');
  box(410, 58, 166, 18, 'Date');
  box(456, 86, 120, 24, 'Amount');
  box(36, 86, 412, 20, 'Amount in words');
  box(36, 122, 300, 44, 'Payee (lower window)');
  box(36, 184, 290, 18, 'Memo');
  box(370, 160, 206, 48, 'Signature');
  box(0, CHECK_H - 0.4375 * PT, PAGE_W, 0.25 * PT, 'MICR clear band');
  perforation(doc, CHECK_H + oy);
  perforation(doc, CHECK_H + STUB_H + oy);
  for (let inch = 0; inch <= 8; inch++) {
    d.line(inch * PT, 0, inch * PT, 8, COLOR.ink3, 0.5);
    d.text(String(inch), inch * PT + 2, 9, { size: 6, color: COLOR.ink3 });
  }
  for (let inch = 0; inch <= 10; inch++) {
    d.line(0, inch * PT, 8, inch * PT, COLOR.ink3, 0.5);
    d.text(String(inch), 10, inch * PT - 3, { size: 6, color: COLOR.ink3 });
  }
  const notes = [
    'ALIGNMENT TEST — NOT A CHECK',
    `Print on plain paper at 100% (no "fit to page"), lay it over the check stock and hold both to the light.`,
    `Current offsets: ${input.offset.x >= 0 ? '+' : ''}${input.offset.x} pt across, ${input.offset.y >= 0 ? '+' : ''}${input.offset.y} pt down (72 pt = 1 in). Adjust in Check settings.`,
    input.micrFontInstalled
      ? 'MICR: a licensed E-13B font is installed. Print real checks on MICR toner.'
      : 'MICR: no licensed E-13B font installed. CONFIRM: install one (MICR_FONT_PATH)',
    ...(input.micrFontInstalled ? [] : ['and print on MICR toner before issuing checks to a bank.']),
  ];
  notes.forEach((n, i) => d.text(n, 36, CHECK_H + 40 + i * 16, { size: i === 0 ? 13 : 9, weight: i === 0 ? 'semibold' : 'regular', color: i >= 3 && !input.micrFontInstalled ? COLOR.bad : COLOR.ink, width: 540 }));
  doc.end();
  return done;
}
