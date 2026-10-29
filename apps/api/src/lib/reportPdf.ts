import PDFDocument from 'pdfkit';
import { COMPANY_INFO } from './emailTemplates.js';
import { COLOR, SIZE } from './docKit/index.js';
import { ensureFonts, richHeight, richText } from './docKit/biz.js';
import { fontName, runsFor, type Family, type Weight } from './docKit/fonts.js';

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
  /** Start on a blank first page for the caller's own cover (no masthead). */
  cover?: boolean;
  /** The running head's right-hand words on later pages; defaults to "<title> (continued)". */
  runningTitle?: string;
}

/** Brand colours for drawn charts: navy and gold carry the data, slate the rest. */
export const CHART = {
  navy: COLOR.band,
  gold: COLOR.brand,
  slate: '#8792A6',
  mist: '#C5CDDA',
  grid: COLOR.rule,
  good: COLOR.good,
  warn: COLOR.warn,
  bad: COLOR.bad,
} as const;

export interface TextAt {
  width?: number;
  size?: number;
  weight?: Weight;
  family?: Family;
  color?: string;
  align?: 'left' | 'right' | 'center';
  caps?: boolean;
}

export interface ChartSeries {
  name: string;
  color: string;
  values: Array<number | null>;
}

/**
 * A round axis for values up to `max`: four or five steps of 1, 2, 2.5 or
 * 5 × a power of ten, whichever reaches `max` lowest (so $24.8k gets
 * 0–25k in 5k steps, not 0–40k). `integer` keeps steps whole (counts).
 */
export function niceScale(max: number, integer = false): { hi: number; step: number; n: number } {
  if (!(max > 0)) return { hi: integer ? 4 : 1, step: integer ? 1 : 0.25, n: 4 };
  let best: { hi: number; step: number; n: number } | null = null;
  for (const n of [4, 5]) {
    const raw = max / n;
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) {
      let step = m * p;
      if (integer) step = Math.max(1, Math.ceil(step));
      if (step * n >= max) {
        if (!best || step * n < best.hi) best = { hi: step * n, step, n };
        break;
      }
    }
  }
  return best!;
}

/** Compact axis money: $0, $500, $25k, $12.5k, $1.5M. */
export function axisMoney(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${Number((a / 1_000_000).toPrecision(3))}M`;
  if (a >= 1_000) return `${sign}$${Number((a / 1_000).toPrecision(3))}k`;
  return `${sign}$${Math.round(a)}`;
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
    if (!meta.cover) this.masthead();
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
    this.one(this.meta.runningTitle ?? `${this.meta.title} (continued)`, MARGIN_X + this.innerWidth * 0.4, y, { width: this.innerWidth * 0.6, size: SIZE.small, color: COLOR.ink3, align: 'right' });
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


  /* ---- Layout and drawing for designed documents (the board pack) ------ */

  /** The left edge and width of the text block. */
  get left(): number {
    return MARGIN_X;
  }
  get contentWidth(): number {
    return this.innerWidth;
  }
  get pageWidth(): number {
    return this.doc.page.width;
  }
  get pageHeight(): number {
    return this.doc.page.height;
  }
  /** Where content must end on this page. */
  get bottom(): number {
    return this.breakY;
  }
  get y(): number {
    return this.doc.y;
  }
  set y(v: number) {
    this.doc.y = v;
    this.doc.x = MARGIN_X;
  }

  /** A fresh page (with the running head). */
  newPage(): void {
    this.doc.addPage();
  }

  /** Break to a new page unless `h` points still fit. */
  ensure(h: number): void {
    if (this.doc.y + h > this.breakY) this.doc.addPage();
  }

  /** The current page's index (0-based) and the count so far. */
  pageIndex(): number {
    const r = this.doc.bufferedPageRange();
    return r.start + r.count - 1;
  }

  /** Draw on an earlier page (a contents list filled in once the pages are known), then come back. */
  onPage(index: number, draw: () => void): void {
    const last = this.pageIndex();
    const keepY = this.doc.y;
    this.doc.switchToPage(index);
    const saved = this.doc.page.margins.bottom;
    this.doc.page.margins.bottom = 0;
    draw();
    this.doc.page.margins.bottom = saved;
    this.doc.switchToPage(last);
    this.doc.y = keepY;
    this.doc.x = MARGIN_X;
  }

  /** Width of one line in the house fonts, every accent kept. */
  measure(text: string, o: TextAt = {}): number {
    const d = this.doc;
    const t = o.caps ? text.toUpperCase() : text;
    const spacing = o.caps ? 0.7 : 0;
    let w = 0;
    for (const r of runsFor(t, o.family ?? 'sans')) {
      d.font(fontName(o.family ?? 'sans', o.weight ?? 'regular', r.subset)).fontSize(o.size ?? SIZE.body);
      w += d.widthOfString(r.text, { characterSpacing: spacing });
    }
    return w;
  }

  /**
   * One line at an exact spot in the house fonts (any script), shortened
   * with an ellipsis by measurement when a width is given. Returns the
   * width drawn. Never moves the flow cursor.
   */
  textAt(text: string, x: number, y: number, o: TextAt = {}): number {
    const d = this.doc;
    const family = o.family ?? 'sans';
    const spacing = o.caps ? 0.7 : 0;
    let t = o.caps ? text.toUpperCase() : text;
    if (o.width !== undefined && this.measure(t, { ...o, caps: false }) > o.width) {
      while (t.length > 1 && this.measure(`${t}…`, { ...o, caps: false }) > o.width) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const w = this.measure(t, { ...o, caps: false });
    let cx = x;
    if (o.width !== undefined && o.align === 'right') cx = x + o.width - w;
    else if (o.width !== undefined && o.align === 'center') cx = x + (o.width - w) / 2;
    const keepX = d.x;
    const keepY = d.y;
    d.fillColor(o.color ?? COLOR.ink);
    for (const r of runsFor(t, family)) {
      d.font(fontName(family, o.weight ?? 'regular', r.subset)).fontSize(o.size ?? SIZE.body);
      d.text(r.text, cx, y, { lineBreak: false, characterSpacing: spacing });
      cx += d.widthOfString(r.text, { characterSpacing: spacing });
    }
    d.x = keepX;
    d.y = keepY;
    return w;
  }

  /** Wrapped text at a spot; returns its height. Never moves the flow cursor. */
  paraAt(text: string, x: number, y: number, width: number, o: { size?: number; weight?: Weight; color?: string; family?: Family; align?: 'left' | 'right' | 'center'; lineGap?: number } = {}): number {
    const d = this.doc;
    const keepY = d.y;
    const lineGap = o.lineGap ?? 2;
    const h = richHeight(d, text, width, { size: o.size ?? SIZE.body, weight: o.weight, family: o.family }, lineGap);
    richText(d, text, x, y, { width, align: o.align, lineGap }, { size: o.size ?? SIZE.body, weight: o.weight, family: o.family, color: o.color ?? COLOR.ink });
    d.y = keepY;
    d.x = MARGIN_X;
    return h;
  }

  /** The height wrapped text would take. */
  heightOf(text: string, width: number, o: { size?: number; weight?: Weight; lineGap?: number } = {}): number {
    return richHeight(this.doc, text, width, { size: o.size ?? SIZE.body, weight: o.weight }, o.lineGap ?? 2);
  }

  box(x: number, y: number, w: number, h: number, fill: string, radius = 0): void {
    const d = this.doc.save();
    (radius > 0 ? d.roundedRect(x, y, w, h, radius) : d.rect(x, y, w, h)).fill(fill);
    this.doc.restore();
  }

  ruleAt(x: number, y: number, w: number, color: string = COLOR.rule, weight = 0.5, dashed = false): void {
    const d = this.doc.save().moveTo(x, y).lineTo(x + w, y).lineWidth(weight).strokeColor(color);
    if (dashed) d.dash(2, { space: 2 });
    d.stroke().undash();
    this.doc.restore();
  }

  /** A filled circle: a status dot or a legend key. */
  dot(cx: number, cy: number, r: number, color: string): void {
    this.doc.save().circle(cx, cy, r).fill(color).restore();
  }

  /** A small trend line in a box; gaps where a point is missing, the last point marked. */
  sparkline(x: number, y: number, w: number, h: number, points: Array<number | null>, color: string = CHART.navy): void {
    const vals = points.filter((p): p is number => p !== null && Number.isFinite(p));
    if (vals.length < 2) return;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const span = max - min || 1;
    const step = points.length > 1 ? w / (points.length - 1) : 0;
    const d = this.doc.save().lineWidth(1.1).strokeColor(color).lineJoin('round');
    let pen = false;
    let lastX = 0;
    let lastY = 0;
    points.forEach((p, i) => {
      if (p === null || !Number.isFinite(p)) {
        pen = false;
        return;
      }
      const px = x + i * step;
      const py = max === min ? y + h / 2 : y + h - ((p - min) / span) * h;
      if (pen) d.lineTo(px, py);
      else d.moveTo(px, py);
      pen = true;
      lastX = px;
      lastY = py;
    });
    d.stroke();
    this.doc.restore();
    this.dot(lastX, lastY, 1.6, color);
  }

  /** A page's title block: a gold kicker, the title in the display face, an optional lede. */
  sectionTitle(kicker: string, title: string, lede?: string): void {
    const d = this.doc;
    let y = d.y;
    this.textAt(kicker, MARGIN_X, y, { size: SIZE.label, weight: 'semibold', color: CHART.gold, caps: true });
    y += 12;
    richText(d, title, MARGIN_X, y, { width: this.innerWidth, lineGap: 0 }, { size: 24, family: 'display', weight: 'semibold', color: COLOR.ink });
    y = d.y + 2;
    if (lede) {
      y += this.paraAt(lede, MARGIN_X, y, this.innerWidth, { size: SIZE.body, color: COLOR.ink2 }) + 2;
    }
    this.ruleAt(MARGIN_X, y + 4, this.innerWidth, COLOR.ink, 0.8);
    this.y = y + 16;
  }

  /** A small heading inside a page, with an optional note on the right. */
  subheading(text: string, note?: string, x: number = MARGIN_X, w: number = this.innerWidth): void {
    const y = this.doc.y;
    this.textAt(text, x, y, { size: SIZE.lead, weight: 'semibold', width: note ? w * 0.6 : w });
    if (note) this.textAt(note, x + w * 0.6, y + 2, { size: SIZE.small, color: COLOR.ink3, width: w * 0.4, align: 'right' });
    this.ruleAt(x, y + 16, w, COLOR.rule, 0.5);
    this.y = y + 24;
  }

  /** Swatches with names, left to right; returns the width used. */
  legend(items: Array<{ label: string; color: string; line?: boolean }>, x: number, y: number): number {
    let cx = x;
    for (const it of items) {
      if (it.line) this.ruleAt(cx, y + 4, 10, it.color, 1.6);
      else this.box(cx, y, 8, 8, it.color, 1.5);
      cx += 12;
      cx += this.textAt(it.label, cx, y, { size: SIZE.label, color: COLOR.ink2 }) + 12;
    }
    return cx - x;
  }

  /**
   * Headline tiles across the width: a label, the figure, a line under it
   * and, when given, the change in its tone's colour.
   */
  tiles(items: Array<{ label: string; value: string; sub?: string | null; change?: { text: string; color: string } | null }>, o: { y?: number; height?: number } = {}): void {
    const gap = 8;
    const n = Math.max(1, items.length);
    const w = (this.innerWidth - gap * (n - 1)) / n;
    const h = o.height ?? 66;
    const y = o.y ?? this.doc.y;
    items.forEach((t, i) => {
      const x = MARGIN_X + i * (w + gap);
      this.box(x, y, w, h, COLOR.wash, 3);
      this.box(x, y, 2.5, h, CHART.navy);
      this.textAt(t.label, x + 10, y + 9, { size: SIZE.label, weight: 'medium', color: COLOR.ink3, caps: true, width: w - 18 });
      this.textAt(t.value, x + 10, y + 21, { size: 18, weight: 'semibold', width: w - 18 });
      let ly = y + 44;
      if (t.change) {
        this.textAt(t.change.text, x + 10, ly, { size: SIZE.small, weight: 'medium', color: t.change.color, width: w - 18 });
        ly += 11;
      }
      if (t.sub) this.textAt(t.sub, x + 10, ly, { size: SIZE.small, color: COLOR.ink3, width: w - 18 });
    });
    this.y = y + h + 14;
  }

  /** Bulleted sentences, each with a coloured dot (its tone). */
  bullets(items: Array<{ text: string; color: string }>, o: { x?: number; width?: number; size?: number } = {}): void {
    const x = o.x ?? MARGIN_X;
    const w = o.width ?? this.innerWidth;
    const size = o.size ?? SIZE.body;
    for (const it of items) {
      const h = this.heightOf(it.text, w - 16, { size, lineGap: 2 });
      this.ensure(h + 6);
      const y = this.doc.y;
      this.dot(x + 3.5, y + size * 0.62, 3, it.color);
      this.paraAt(it.text, x + 14, y, w - 16, { size, lineGap: 2 });
      this.y = y + h + 6;
    }
  }

  /** The y-axis of a chart: gridlines and labels at round steps; returns the value→y mapping. */
  private axis(x: number, y: number, w: number, h: number, lo: number, hi: number, fmt: (v: number) => string, axisW: number, steps = 4): (v: number) => number {
    const toY = (v: number) => y + h - ((v - lo) / (hi - lo || 1)) * h;
    for (let i = 0; i <= steps; i++) {
      const v = lo + ((hi - lo) * i) / steps;
      const gy = toY(v);
      this.ruleAt(x + axisW, gy, w - axisW, i === 0 && lo === 0 ? COLOR.ruleStrong : CHART.grid, i === 0 && lo === 0 ? 0.7 : 0.4);
      this.textAt(fmt(v), x, gy - 3.5, { size: SIZE.micro, color: COLOR.ink3, width: axisW - 6, align: 'right' });
    }
    if (lo < 0) this.ruleAt(x + axisW, toY(0), w - axisW, COLOR.ruleStrong, 0.7);
    return toY;
  }

  /** The axis bounds for some values: round steps up from zero, or down past it. */
  private scaleFor(values: number[], integer = false): { lo: number; hi: number; n: number } {
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const up = niceScale(max, integer);
    if (min >= 0) return { lo: 0, hi: up.hi, n: up.n };
    const down = Math.ceil(-min / up.step);
    return { lo: -down * up.step, hi: up.hi, n: up.n + down };
  }

  /**
   * Columns per category, one per series side by side; `inner` draws a
   * second measure inside the first series' column from its base (billed,
   * with the margin inside it). Values print above the columns when they fit.
   * Returns the y below the category labels.
   */
  columnChart(o: { x?: number; y?: number; w?: number; h: number; categories: string[]; series: ChartSeries[]; inner?: ChartSeries; format: (v: number) => string; axisFormat?: (v: number) => string; labelEvery?: number; valueLabels?: boolean; integer?: boolean }): number {
    const x = o.x ?? MARGIN_X;
    const w = o.w ?? this.innerWidth;
    const y = (o.y ?? this.doc.y) + 10;
    const h = o.h - 10;
    const all = o.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    const { lo, hi, n: steps } = this.scaleFor(all.map((v) => v * 1.04), o.integer);
    const axisW = 40;
    const toY = this.axis(x, y, w, h, lo, hi, o.axisFormat ?? o.format, axisW, steps);
    const n = Math.max(1, o.categories.length);
    const slot = (w - axisW) / n;
    const groupW = slot * 0.72;
    const barW = groupW / Math.max(1, o.series.length);
    const every = o.labelEvery ?? (n > 8 ? 2 : 1);
    o.categories.forEach((cat, i) => {
      const gx = x + axisW + i * slot + (slot - groupW) / 2;
      o.series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === undefined || v === 0) return;
        const bx = gx + si * barW + (o.series.length > 1 ? 0.6 : 0);
        const bw = barW - (o.series.length > 1 ? 1.2 : 0);
        const top = toY(Math.max(v, 0));
        const base = toY(Math.min(v, 0));
        this.box(bx, top, bw, Math.max(0.8, base - top), s.color);
        if (si === 0 && o.inner) {
          const iv = o.inner.values[i];
          if (iv !== null && iv !== undefined && iv > 0) {
            const it = toY(iv);
            this.box(bx, it, bw, Math.max(0.8, toY(0) - it), o.inner.color);
          }
        }
        if (o.valueLabels !== false) {
          const label = o.format(v);
          if (this.measure(label, { size: SIZE.micro }) <= bw + slot * 0.28) {
            this.textAt(label, bx - 10, top - 8.5, { size: SIZE.micro, weight: 'medium', color: COLOR.ink2, width: bw + 20, align: 'center' });
          }
        }
      });
      if (i % every === 0 || i === n - 1) {
        this.textAt(cat, x + axisW + i * slot - 6, y + h + 4, { size: SIZE.micro, color: COLOR.ink3, width: slot + 12, align: 'center' });
      }
    });
    return y + h + 16;
  }

  /**
   * A walk from one total to another: the first and last steps stand from
   * zero, the steps between float down from the running level, joined by
   * thin connectors; each carries its amount. Returns the y below the labels.
   */
  waterfall(o: { x?: number; y?: number; w?: number; h: number; steps: Array<{ label: string; amount: number; kind: 'total' | 'down' }>; format: (v: number) => string; axisFormat?: (v: number) => string; colors?: { first?: string; down?: string; last?: string } }): number {
    const x = o.x ?? MARGIN_X;
    const w = o.w ?? this.innerWidth;
    const y = (o.y ?? this.doc.y) + 12;
    const h = o.h - 12;
    const axisW = 40;
    let level = 0;
    const bars = o.steps.map((s, i) => {
      if (s.kind === 'total') {
        level = s.amount;
        return { from: 0, to: s.amount, i };
      }
      const from = level;
      level -= s.amount;
      return { from, to: level, i };
    });
    const vals = bars.flatMap((b) => [b.from, b.to]);
    const { lo, hi, n: steps } = this.scaleFor(vals.map((v) => v * 1.04));
    const toY = this.axis(x, y, w, h, lo, hi, o.axisFormat ?? axisMoney, axisW, steps);
    const n = Math.max(1, o.steps.length);
    const slot = (w - axisW) / n;
    const bw = Math.min(54, slot * 0.6);
    const colors = { first: CHART.navy, down: CHART.slate, last: CHART.gold, ...o.colors };
    bars.forEach((b, i) => {
      const s = o.steps[i]!;
      const bx = x + axisW + i * slot + (slot - bw) / 2;
      const top = toY(Math.max(b.from, b.to));
      const bottom = toY(Math.min(b.from, b.to));
      const color = s.kind === 'total' ? (i === 0 ? colors.first : colors.last) : colors.down;
      this.box(bx, top, bw, Math.max(0.8, bottom - top), color, 1);
      const label = s.kind === 'down' ? `−${o.format(s.amount)}` : o.format(s.amount);
      this.textAt(label, bx - 16, top - 10, { size: SIZE.small, weight: 'semibold', color: COLOR.ink, width: bw + 32, align: 'center' });
      if (i < bars.length - 1) {
        const next = x + axisW + (i + 1) * slot + (slot - bw) / 2;
        this.ruleAt(bx + bw, toY(b.to), next - bx - bw, COLOR.ruleStrong, 0.5, true);
      }
      this.paraAt(s.label, x + axisW + i * slot + 2, y + h + 5, slot - 4, { size: SIZE.label, color: COLOR.ink2, align: 'center', lineGap: 0 });
    });
    return y + h + 28;
  }

  /**
   * Horizontal bars, one per row: the label, the bar on a light track, the
   * value at the end; an optional threshold drawn as a dashed line through
   * every row. Returns the y below the last row.
   */
  barList(o: { x?: number; y?: number; w?: number; rows: Array<{ label: string; value: number; valueLabel: string; color?: string }>; max: number; threshold?: { value: number; label: string }; labelW?: number; barH?: number }): number {
    const x = o.x ?? MARGIN_X;
    const w = o.w ?? this.innerWidth;
    let y = o.y ?? this.doc.y;
    const labelW = o.labelW ?? Math.min(170, w * 0.32);
    const valueW = 54;
    const plotX = x + labelW;
    const plotW = w - labelW - valueW - 6;
    const barH = o.barH ?? 11;
    const rowH = barH + 9;
    const max = o.max || 1;
    const top = y;
    if (o.threshold) y += 12;
    for (const r of o.rows) {
      this.textAt(r.label, x, y + (barH - SIZE.small) / 2, { size: SIZE.small, color: COLOR.ink2, width: labelW - 8 });
      this.box(plotX, y, plotW, barH, COLOR.wash, 1.5);
      const bw = Math.max(0, Math.min(1, r.value / max)) * plotW;
      if (bw > 0) this.box(plotX, y, Math.max(1.5, bw), barH, r.color ?? CHART.navy, 1.5);
      this.textAt(r.valueLabel, plotX + plotW + 6, y + (barH - SIZE.small) / 2, { size: SIZE.small, weight: 'semibold', width: valueW, align: 'right' });
      y += rowH;
    }
    if (o.threshold) {
      const tx = plotX + Math.max(0, Math.min(1, o.threshold.value / max)) * plotW;
      const d = this.doc.save().moveTo(tx, top + 10).lineTo(tx, y - 6).lineWidth(0.8).strokeColor(CHART.bad).dash(2, { space: 2 });
      d.stroke().undash();
      this.doc.restore();
      this.textAt(o.threshold.label, tx - 80, top, { size: SIZE.micro, weight: 'medium', color: CHART.bad, width: 160, align: 'center' });
    }
    return y + 4;
  }

  /** Lines over labelled points, with an optional reference line (a floor or a plan). Returns the y below the labels. */
  lineChart(o: { x?: number; y?: number; w?: number; h: number; labels: string[]; series: ChartSeries[]; format: (v: number) => string; axisFormat?: (v: number) => string; refLine?: { value: number; label: string; color?: string }; labelEvery?: number }): number {
    const x = o.x ?? MARGIN_X;
    const w = o.w ?? this.innerWidth;
    const y = (o.y ?? this.doc.y) + 6;
    const h = o.h - 6;
    const vals = o.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    if (o.refLine) vals.push(o.refLine.value);
    const { lo, hi, n: steps } = this.scaleFor(vals.map((v) => v * 1.04));
    const axisW = 40;
    const toY = this.axis(x, y, w, h, lo, hi, o.axisFormat ?? o.format, axisW, steps);
    const n = Math.max(1, o.labels.length);
    const step = n > 1 ? (w - axisW - 8) / (n - 1) : 0;
    const px = (i: number) => x + axisW + 4 + i * step;
    if (o.refLine) {
      this.ruleAt(x + axisW, toY(o.refLine.value), w - axisW, o.refLine.color ?? CHART.bad, 0.8, true);
      this.textAt(o.refLine.label, x + w - 160, toY(o.refLine.value) - 9, { size: SIZE.micro, weight: 'medium', color: o.refLine.color ?? CHART.bad, width: 160, align: 'right' });
    }
    for (const s of o.series) {
      const d = this.doc.save().lineWidth(1.6).strokeColor(s.color).lineJoin('round');
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        if (pen) d.lineTo(px(i), toY(v));
        else d.moveTo(px(i), toY(v));
        pen = true;
      });
      d.stroke();
      this.doc.restore();
      s.values.forEach((v, i) => {
        if (v !== null) this.dot(px(i), toY(v), 1.7, s.color);
      });
    }
    const every = o.labelEvery ?? (n > 8 ? 2 : 1);
    o.labels.forEach((l, i) => {
      if (i % every === 0 || i === n - 1) this.textAt(l, px(i) - 22, y + h + 4, { size: SIZE.micro, color: COLOR.ink3, width: 44, align: 'center' });
    });
    return y + h + 16;
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
      const who = this.meta.company?.name ?? COMPANY_INFO.legalName;
      this.one(this.company.contactLine ? `${who}  ·  ${this.company.contactLine}` : who, MARGIN_X, y + 10, { width: this.innerWidth, size: SIZE.micro, color: COLOR.ink3 });
      d.page.margins.bottom = saved;
    }
    d.end();
    return this.done;
  }
}
