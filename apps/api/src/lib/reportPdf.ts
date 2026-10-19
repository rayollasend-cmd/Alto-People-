import PDFDocument from 'pdfkit';
import { COMPANY_INFO } from './emailTemplates.js';
import { COLOR, SIZE } from './docKit/index.js';
import { ensureFonts, richHeight, richText } from './docKit/biz.js';
import { fontName } from './docKit/fonts.js';

/**
 * Letterheaded report renderer for the evidence documents an auditor,
 * an inspector or a board receives: audit packets, attestations,
 * registers, the board pack, the compliance scorecard.
 *
 * Drawn in the house style (lib/docKit): the navy masthead with the gold
 * rule on page 1 and a compact running head on every continuation page;
 * Geist for text and Cormorant Garamond for the title; tables with a
 * tinted header row that repeats after every page break, zebra rows and
 * wrapped cells that keep every accent in a name; tinted callouts; a
 * signature block; and a footer on every page with the confidentiality
 * line, the reference and "Page x of y".
 */

const MARGIN_X = 54;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 72; // room for the stamped footer
const BAND = 104;

export interface ReportMeta {
  /** Document title, e.g. "Worker Roster". */
  title: string;
  /** One-line context under the title, e.g. the audit name. */
  subtitle?: string;
  /** Facts on the masthead (up to four), e.g. period, prepared for. */
  facts?: Array<{ label: string; value: string }>;
  /** Reference id printed in the footer of every page. */
  reference: string;
  /** Footer confidentiality line; defaults to the standard banner. */
  confidentialityNote?: string;
  /** Override the letterhead's company (a tenant's own name). */
  company?: { name: string; contactLine?: string };
}

export interface TableColumn {
  label: string;
  /** Fixed width in pt; columns without one share the remaining width. */
  width?: number;
  align?: 'left' | 'right';
}

const sans = (w: 'regular' | 'medium' | 'semibold' = 'regular') => fontName('sans', w, 'latin');

export class ReportPdf {
  private doc: InstanceType<typeof PDFDocument>;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;
  private meta: ReportMeta;
  private company: { name: string; contactLine: string };

  constructor(meta: ReportMeta) {
    this.meta = meta;
    this.company = {
      name: meta.company?.name ?? COMPANY_INFO.name,
      contactLine: meta.company?.contactLine ?? `${COMPANY_INFO.address}  ·  ${COMPANY_INFO.phone}  ·  ${COMPANY_INFO.email}`,
    };
    this.doc = new PDFDocument({
      size: 'LETTER',
      bufferPages: true,
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
      info: { Title: meta.title, Author: meta.company?.name ?? COMPANY_INFO.legalName, Creator: 'Alto People' },
    });
    ensureFonts(this.doc);
    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => this.chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
    });
    // Continuation pages get the running head automatically, so long
    // free-flowing text stays on-brand without callers managing breaks.
    this.doc.on('pageAdded', () => this.runningHead());
    this.masthead();
  }

  private get innerWidth(): number {
    return this.doc.page.width - MARGIN_X * 2;
  }
  private get breakY(): number {
    return this.doc.page.height - MARGIN_BOTTOM - 8;
  }

  /** One line at an exact spot, shortened by measurement (pdfkit wraps even with lineBreak:false once a width is set). */
  private one(text: string, x: number, y: number, o: { width: number; weight?: 'regular' | 'medium' | 'semibold'; size: number; color: string; align?: 'left' | 'right'; caps?: boolean }): void {
    const d = this.doc;
    const spacing = o.caps ? 0.7 : 0;
    let t = o.caps ? text.toUpperCase() : text;
    d.font(sans(o.weight)).fontSize(o.size);
    const w = (str: string) => d.widthOfString(str, { characterSpacing: spacing });
    if (w(t) > o.width) {
      while (t.length > 1 && w(`${t}…`) > o.width) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const tx = o.align === 'right' ? x + o.width - w(t) : x;
    const keepY = d.y;
    d.fillColor(o.color).text(t, tx, y, { lineBreak: false, characterSpacing: spacing });
    d.y = keepY;
  }

  private line(y: number, color: string = COLOR.rule, weight = 0.5, x = MARGIN_X, w = this.innerWidth): void {
    this.doc.save().moveTo(x, y).lineTo(x + w, y).lineWidth(weight).strokeColor(color).stroke().restore();
  }

  private masthead(): void {
    const d = this.doc;
    const pw = d.page.width;
    d.save().rect(0, 0, pw, BAND).fill(COLOR.band).restore();
    d.save().rect(0, BAND, pw, 3).fill(COLOR.brand).restore();
    richText(d, this.company.name, MARGIN_X, 24, { width: this.innerWidth * 0.5 }, { size: SIZE.title + 1, weight: 'semibold', color: COLOR.white });
    this.one(this.company.contactLine, MARGIN_X, 44, { width: this.innerWidth, size: SIZE.micro + 0.5, color: COLOR.bandSub });
    richText(d, this.meta.title, MARGIN_X, 62, { width: this.innerWidth * 0.8, lineGap: 0 }, { size: 22, family: 'display', weight: 'semibold', color: COLOR.white });
    d.y = BAND + 18;
    if (this.meta.subtitle) {
      richText(d, this.meta.subtitle, MARGIN_X, d.y, { width: this.innerWidth, lineGap: 2 }, { size: SIZE.lead, color: COLOR.ink2 });
      d.y += 6;
    }
    if (this.meta.facts?.length) {
      const facts = this.meta.facts.slice(0, 4);
      const cw = this.innerWidth / facts.length;
      const fy = d.y + 6;
      facts.forEach((f, i) => {
        const x = MARGIN_X + i * cw;
        this.one(f.label, x, fy, { width: cw - 12, weight: 'medium', size: SIZE.label, color: COLOR.ink3, caps: true });
        richText(d, f.value || '—', x, fy + 12, { width: cw - 12, lineGap: 1 }, { size: SIZE.body, weight: 'medium' });
      });
      d.y = fy + 40;
      this.line(d.y, COLOR.rule);
      d.y += 16;
    } else {
      d.y += 8;
    }
    d.x = MARGIN_X;
  }

  private runningHead(): void {
    const d = this.doc;
    const y = 28;
    this.one(this.company.name, MARGIN_X, y, { width: this.innerWidth * 0.4, weight: 'semibold', size: SIZE.small, color: COLOR.ink });
    this.one(`${this.meta.title} (continued)`, MARGIN_X + this.innerWidth * 0.4, y, { width: this.innerWidth * 0.6, size: SIZE.small, color: COLOR.ink3, align: 'right' });
    this.line(y + 15, COLOR.brand, 0.8);
    d.x = MARGIN_X;
    d.y = y + 30;
  }

  heading(text: string): void {
    const d = this.doc;
    if (d.y > this.breakY - 60) d.addPage();
    d.y += 8;
    richText(d, text, MARGIN_X, d.y, { width: this.innerWidth }, { size: SIZE.title, weight: 'semibold' });
    const ly = d.y + 4;
    this.line(ly, COLOR.ink, 0.8);
    d.x = MARGIN_X;
    d.y = ly + 10;
  }

  para(text: string, opts?: { muted?: boolean; size?: number }): void {
    const d = this.doc;
    const size = opts?.size ?? SIZE.body + 0.5;
    if (d.y + richHeight(d, text, this.innerWidth, { size }, 3) > this.breakY) d.addPage();
    richText(d, text, MARGIN_X, d.y, { width: this.innerWidth, lineGap: 3 }, { size, color: opts?.muted ? COLOR.ink3 : COLOR.ink });
    d.x = MARGIN_X;
    d.y += 8;
  }

  /** Label/value rows — worker record sheets, cover facts. */
  kv(rows: Array<{ label: string; value: string }>): void {
    const d = this.doc;
    const labelW = 170;
    for (const r of rows) {
      const vh = richHeight(d, r.value || '—', this.innerWidth - labelW, { size: SIZE.body }, 1.5);
      if (d.y + Math.max(16, vh) > this.breakY) d.addPage();
      const y = d.y;
      this.one(r.label, MARGIN_X, y + 1.5, { width: labelW - 10, weight: 'medium', size: SIZE.label, color: COLOR.ink3, caps: true });
      richText(d, r.value || '—', MARGIN_X + labelW, y, { width: this.innerWidth - labelW, lineGap: 1.5 }, { size: SIZE.body });
      d.y = Math.max(y + 16, d.y + 4);
      this.line(d.y - 2, COLOR.rule, 0.3);
      d.y += 3;
    }
    d.x = MARGIN_X;
    d.y += 6;
  }

  /** A notice: tinted, with an accent edge. */
  callout(text: string): void {
    const d = this.doc;
    const padding = 11;
    const w = this.innerWidth;
    const h = richHeight(d, text, w - padding * 2 - 4, { size: SIZE.small + 0.5 }, 2) + padding * 2;
    if (d.y + h > this.breakY) d.addPage();
    const y = d.y;
    d.save().roundedRect(MARGIN_X, y, w, h, 4).fill(COLOR.warnWash).restore();
    d.save().rect(MARGIN_X, y, 3, h).fill(COLOR.brand).restore();
    richText(d, text, MARGIN_X + padding + 4, y + padding, { width: w - padding * 2 - 4, lineGap: 2 }, { size: SIZE.small + 0.5, color: COLOR.ink2 });
    d.y = y + h + 12;
    d.x = MARGIN_X;
  }

  /**
   * A table: tinted header row (repeated after every page break), zebra
   * rows, wrapped cells. Widths: fixed where given, the rest shared.
   */
  table(columns: TableColumn[], rows: Array<Array<string | number | null | undefined>>): void {
    const d = this.doc;
    const total = this.innerWidth;
    const fixed = columns.reduce((s, c) => s + (c.width ?? 0), 0);
    const flexCount = columns.filter((c) => !c.width).length;
    const flexW = flexCount > 0 ? Math.max(40, (total - fixed) / flexCount) : 0;
    const widths = columns.map((c) => c.width ?? flexW);
    const xs: number[] = [];
    let acc = MARGIN_X;
    for (const w of widths) {
      xs.push(acc);
      acc += w;
    }
    const PAD = 5;
    const size = SIZE.small;

    const headerRow = () => {
      const hh = 19;
      const hy = d.y;
      d.save().rect(MARGIN_X, hy, total, hh).fill(COLOR.wash).restore();
      columns.forEach((c, i) => {
        this.one(c.label, xs[i] + PAD, hy + 6, { width: widths[i] - PAD * 2, weight: 'medium', size: SIZE.label, color: COLOR.ink3, caps: true, align: c.align ?? 'left' });
      });
      d.y = hy + hh;
      this.line(d.y, COLOR.ruleStrong, 0.6);
      d.x = MARGIN_X;
    };

    if (d.y > this.breakY - 60) d.addPage();
    headerRow();
    if (rows.length === 0) {
      this.one('No rows.', MARGIN_X + PAD, d.y + 5, { width: total, size, color: COLOR.ink3 });
      d.y += 20;
    }

    rows.forEach((row, ri) => {
      const cells = row.map((v) => (v === null || v === undefined ? '' : String(v)));
      const rh = Math.max(12, ...cells.map((c, i) => richHeight(d, c || ' ', widths[i] - PAD * 2, { size }, 1))) + 8;
      if (d.y + rh > this.breakY) {
        d.addPage();
        headerRow();
      }
      if (ri % 2 === 1) d.save().rect(MARGIN_X, d.y, total, rh).fill('#FAFBFC').restore();
      const y = d.y;
      cells.forEach((c, i) => {
        if (!c) return;
        richText(d, c, xs[i] + PAD, y + 4, { width: widths[i] - PAD * 2, align: columns[i].align ?? 'left', lineGap: 1 }, { size });
      });
      d.y = y + rh;
      d.x = MARGIN_X;
      this.line(d.y, COLOR.rule, 0.4);
    });
    d.y += 12;
  }

  /** Officer signature block (attestations, statements). */
  signatureBlock(): void {
    const d = this.doc;
    if (d.y > this.breakY - 90) d.addPage();
    d.y += 34;
    const gap = 18;
    const labels = ['Signature', 'Name and title (printed)', 'Date'];
    const w = (this.innerWidth - gap * 2) / 3;
    const ly = d.y;
    labels.forEach((l, i) => {
      const x = MARGIN_X + i * (w + gap);
      this.line(ly, COLOR.ink, 0.7, x, w);
      this.one(l, x, ly + 5, { width: w, weight: 'medium', size: SIZE.label, color: COLOR.ink3, caps: true });
    });
    d.y = ly + 30;
    d.x = MARGIN_X;
  }

  /** Finish: stamp per-page footers (real page counts), return the PDF. */
  async render(): Promise<Buffer> {
    const d = this.doc;
    const range = d.bufferedPageRange();
    const note = this.meta.confidentialityNote ?? 'Confidential: contains personnel records. Handle per the data-handling terms of the applicable agreement.';
    for (let i = range.start; i < range.start + range.count; i++) {
      d.switchToPage(i);
      const y = d.page.height - 50;
      // Suspend the bottom margin so footer text can't trigger a new page.
      const saved = d.page.margins.bottom;
      d.page.margins.bottom = 0;
      this.line(y - 7, COLOR.rule, 0.5);
      this.one(`${note}  ·  Ref ${this.meta.reference}`, MARGIN_X, y, { width: this.innerWidth - 80, size: SIZE.micro, color: COLOR.ink3 });
      this.one(`Page ${i - range.start + 1} of ${range.count}`, d.page.width - MARGIN_X - 70, y, { width: 70, weight: 'medium', size: SIZE.micro, color: COLOR.ink3, align: 'right' });
      this.one(`${this.meta.company?.name ?? COMPANY_INFO.legalName}  ·  ${this.company.contactLine}`, MARGIN_X, y + 10, { width: this.innerWidth, size: SIZE.micro, color: COLOR.ink3 });
      d.page.margins.bottom = saved;
    }
    d.end();
    return this.done;
  }
}
