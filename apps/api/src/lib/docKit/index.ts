import PDFDocument from 'pdfkit';
import { fontName, registerFonts, runsFor, type Family, type Weight } from './fonts.js';

/**
 * docKit — the house style for every document the platform generates.
 *
 * One palette, one type scale, one grid, the same typefaces as the web
 * app, and the parts every document is built from: the masthead, section
 * headings, label/value blocks, tables that break across pages with their
 * header repeated, callouts, figure tiles, watermarks, and a footer with
 * "Page x of y" and the document's reference.
 *
 * Rules the parts enforce so no document has to remember them:
 *  - Money is right-aligned, tabular, and negative amounts read "−$12.00"
 *    (a true minus), never "-$0.00": a zero is "$0.00".
 *  - Dates read "Oct 9, 2026", never ISO.
 *  - Text never overflows its box: long values shorten with an ellipsis.
 *  - Colour has a job (brand, good, warn, bad, data), never decoration.
 *  - A table never strands its header at the bottom of a page.
 *
 * Usage:
 *   const { doc, k } = createDoc({ title: 'Earnings statement', author: brand.name });
 *   let y = k.masthead({ title: 'Earnings statement', brand, meta: [...] });
 *   y = k.section('Earnings', y);
 *   y = k.table({ y, columns, rows, totals });
 *   k.finish({ reference: 'Paystub · run 1a2b' });
 *   return k.toBuffer();
 */

export const COLOR = {
  ink: '#0B1832',
  ink2: '#3F4A5C',
  ink3: '#6B7588',
  rule: '#DCE1E8',
  ruleStrong: '#AEB6C3',
  wash: '#F4F6F9',
  band: '#0F1F3D',
  bandText: '#FFFFFF',
  bandSub: '#AEB8C9',
  brand: '#B8862B',
  data: '#2F5FD0',
  good: '#1E7B4F',
  goodWash: '#EAF5EF',
  warn: '#9A6400',
  warnWash: '#FDF5E6',
  bad: '#B42318',
  badWash: '#FDEDEC',
  info: '#2F5FD0',
  infoWash: '#EDF2FC',
  white: '#FFFFFF',
} as const;

/** The type scale (points). */
export const SIZE = { micro: 6.5, label: 7.5, small: 8.5, body: 9.5, lead: 11, title: 13, heading: 17, figure: 20, hero: 28 } as const;

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';
const TONE: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: COLOR.ink2, bg: COLOR.wash },
  good: { fg: COLOR.good, bg: COLOR.goodWash },
  warn: { fg: COLOR.warn, bg: COLOR.warnWash },
  bad: { fg: COLOR.bad, bg: COLOR.badWash },
  info: { fg: COLOR.info, bg: COLOR.infoWash },
};

export interface TextStyle {
  size?: number;
  weight?: Weight;
  family?: Family;
  color?: string;
  /** Small caps label style: uppercase with tracking. */
  caps?: boolean;
}

/* ---- Formatting -------------------------------------------------------- */

const MINUS = '−';
export const fmt = {
  money(n: number | null | undefined, opts: { blankZero?: boolean; signed?: boolean } = {}): string {
    if (n == null || !Number.isFinite(n)) return '—';
    const r = Math.round(n * 100) / 100;
    if (r === 0) return opts.blankZero ? '—' : '$0.00';
    const body = `$${Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (r < 0) return `${MINUS}${body}`;
    return opts.signed ? `+${body}` : body;
  },
  number(n: number | null | undefined, decimals = 2): string {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },
  hours(n: number | null | undefined): string {
    return n == null ? '—' : fmt.number(n, 2);
  },
  percent(share: number | null | undefined, decimals = 1): string {
    if (share == null || !Number.isFinite(share)) return '—';
    const v = Math.round(share * 100 * 10 ** decimals) / 10 ** decimals;
    return `${Number.isInteger(v) ? v : v.toFixed(decimals)}%`;
  },
  /** "Oct 9, 2026" from "2026-10-09", an ISO timestamp or a Date. */
  date(v: string | Date | null | undefined): string {
    if (!v) return '—';
    const d = typeof v === 'string' ? new Date(v.length === 10 ? `${v}T12:00:00Z` : v) : v;
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  },
  dateRange(a: string | Date, b: string | Date): string {
    return `${fmt.date(a)} – ${fmt.date(b)}`;
  },
  dateTime(v: string | Date | null | undefined, timeZone = 'America/New_York'): string {
    if (!v) return '—';
    const d = typeof v === 'string' ? new Date(v) : v;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
  },
  /** "•••-••-6789" — the only way a document shows an SSN unless it is a filing copy. */
  ssnMasked(last4: string | null | undefined): string {
    return last4 ? `•••-••-${last4}` : '—';
  },
  ein(v: string | null | undefined): string {
    if (!v) return '—';
    const d = v.replace(/\D/g, '');
    return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : v;
  },
};

/* ---- The document ------------------------------------------------------ */

export interface Brand {
  name: string;
  /** PNG or JPEG bytes (OrgSetting logo). */
  logo?: Buffer | null;
  lines?: string[];
}

export interface DocOptions {
  title: string;
  author?: string;
  subject?: string;
  layout?: 'portrait' | 'landscape';
  /** Margins in points; defaults to 44 all round. */
  margin?: number;
  /**
   * Pin the PDF's creation date (it defaults to now). A document whose hash
   * is stored for immutability (tax forms) passes its own timestamp, so the
   * same inputs always produce the same bytes.
   */
  creationDate?: Date;
}

export interface Column<R> {
  key: string;
  header: string;
  /** Share of the table width (any units; normalised). */
  width: number;
  align?: 'left' | 'right' | 'center';
  value: (row: R) => string;
  /** Bold the cell (e.g. a net figure). */
  strong?: boolean;
  /** Colour a cell from its row (e.g. a negative change). */
  color?: (row: R) => string | undefined;
  /** Wrap instead of shortening: the row grows to fit (legal text, deduction names). */
  wrap?: boolean;
}

export function createDoc(opts: DocOptions) {
  const doc = new PDFDocument({
    size: 'LETTER',
    layout: opts.layout ?? 'portrait',
    margin: opts.margin ?? 44,
    bufferPages: true,
    info: { Title: opts.title, Author: opts.author ?? '', Subject: opts.subject ?? opts.title, Creator: 'Alto People', ...(opts.creationDate ? { CreationDate: opts.creationDate, ModDate: opts.creationDate } : {}) },
  });
  registerFonts(doc);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const k = kit(doc, opts, done);
  return { doc, k };
}

export type Kit = ReturnType<typeof kit>;

function kit(doc: PDFKit.PDFDocument, opts: DocOptions, done: Promise<Buffer>) {
  const M = opts.margin ?? 44;
  const pageW = () => doc.page.width;
  const pageH = () => doc.page.height;
  const L = M;
  const R = () => pageW() - M;
  const width = () => R() - L;
  const top = M;
  /** Content must end above this line: the footer lives below it. */
  const bottom = () => pageH() - M - 14;

  const styleOf = (st: TextStyle) => ({
    family: st.family ?? 'sans',
    weight: st.weight ?? 'regular',
    size: st.size ?? SIZE.body,
    color: st.color ?? COLOR.ink,
    spacing: st.caps ? 0.8 : 0,
  });
  const prep = (s: string, st: TextStyle) => (st.caps ? s.toUpperCase() : s);

  /** Width of an already-prepared string in a resolved style, across subset runs (letter-spacing included). */
  function measureRaw(str: string, sty: ReturnType<typeof styleOf>): number {
    let w = 0;
    for (const run of runsFor(str, sty.family)) {
      doc.font(fontName(sty.family, sty.weight, run.subset)).fontSize(sty.size);
      w += doc.widthOfString(run.text, { characterSpacing: sty.spacing });
    }
    return w;
  }

  /** Width of a string in a style, across subset runs. */
  function measure(s: string, st: TextStyle = {}): number {
    return measureRaw(prep(s, st), styleOf(st));
  }

  function fitRaw(str: string, w: number, sty: ReturnType<typeof styleOf>): string {
    if (measureRaw(str, sty) <= w) return str;
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measureRaw(`${str.slice(0, mid)}…`, sty) <= w) lo = mid;
      else hi = mid - 1;
    }
    return `${str.slice(0, lo).trimEnd()}…`;
  }

  /** Shorten to fit a width, with an ellipsis. */
  function fit(s: string, w: number, st: TextStyle = {}): string {
    return fitRaw(prep(s, st), w, styleOf(st));
  }

  /**
   * One line of text at an exact position. `width` + `align` place it in a
   * box; a value too long for the box shortens instead of wrapping.
   */
  function text(s: string, x: number, y: number, st: TextStyle & { width?: number; align?: 'left' | 'right' | 'center' } = {}): void {
    const sty = styleOf(st);
    let str = prep(s, st);
    if (st.width) str = fitRaw(str, st.width, sty);
    const w = measureRaw(str, sty);
    let cx = x;
    if (st.width && st.align === 'right') cx = x + st.width - w;
    else if (st.width && st.align === 'center') cx = x + (st.width - w) / 2;
    doc.fillColor(sty.color);
    for (const run of runsFor(str, sty.family)) {
      doc.font(fontName(sty.family, sty.weight, run.subset)).fontSize(sty.size);
      doc.text(run.text, cx, y, { lineBreak: false, characterSpacing: sty.spacing });
      cx += doc.widthOfString(run.text, { characterSpacing: sty.spacing });
    }
  }

  /** A wrapped paragraph; returns its height. Drawn in the latin subset (copy, not names). */
  function para(s: string, x: number, y: number, w: number, st: TextStyle = {}, draw = true): number {
    const sty = styleOf(st);
    const clean = runsFor(prep(s, st), sty.family).map((r) => (r.subset === 'latin' ? r.text : r.text.normalize('NFKD').replace(/[̀-ͯ]/g, ''))).join('');
    doc.font(fontName(sty.family, sty.weight, 'latin')).fontSize(sty.size);
    const h = doc.heightOfString(clean, { width: w, lineGap: 2, characterSpacing: sty.spacing });
    if (draw) {
      doc.fillColor(sty.color);
      doc.text(clean, x, y, { width: w, lineGap: 2, characterSpacing: sty.spacing });
    }
    return h;
  }

  function hr(y: number, x = L, w = width(), color: string = COLOR.rule, weight = 0.6): void {
    doc.save().lineWidth(weight).strokeColor(color).moveTo(x, y).lineTo(x + w, y).stroke().restore();
  }
  function box(x: number, y: number, w: number, h: number, fill: string, radius = 0): void {
    doc.save();
    if (radius) doc.roundedRect(x, y, w, h, radius).fill(fill);
    else doc.rect(x, y, w, h).fill(fill);
    doc.restore();
  }
  function outline(x: number, y: number, w: number, h: number, color: string = COLOR.rule, radius = 4): void {
    doc.save().lineWidth(0.75).strokeColor(color).roundedRect(x, y, w, h, radius).stroke().restore();
  }

  /** Start a new page if `h` more points won't fit; returns the y to draw at. */
  function ensure(y: number, h: number, onNewPage?: (y: number) => number): number {
    if (y + h <= bottom()) return y;
    doc.addPage();
    return onNewPage ? onNewPage(top) : top;
  }

  /**
   * The masthead: a navy band with the company (logo or name) and the
   * document's title, then up to four facts on the right. Returns the y
   * below it.
   */
  function masthead(o: { title: string; brand: Brand; subtitle?: string; meta?: Array<{ label: string; value: string }> }): number {
    const bandH = 78;
    box(0, 0, pageW(), bandH, COLOR.band);
    box(0, bandH, pageW(), 3, COLOR.brand);
    let logoDrawn = false;
    if (o.brand.logo) {
      try {
        doc.image(o.brand.logo, L, 18, { fit: [120, 34], valign: 'center' });
        logoDrawn = true;
      } catch {
        logoDrawn = false;
      }
    }
    if (!logoDrawn) text(o.brand.name, L, 20, { size: SIZE.heading, weight: 'semibold', color: COLOR.white, width: width() * 0.5 });
    if (o.brand.lines?.length) {
      const lw = width() * 0.6;
      const joined = o.brand.lines.join('  ·  ');
      const sub = { size: SIZE.small, color: COLOR.bandSub };
      if (o.brand.lines.length === 1 || measure(joined, sub) <= lw) text(joined, L, 52, { ...sub, width: lw });
      else {
        text(o.brand.lines[0], L, 46, { ...sub, width: lw });
        text(o.brand.lines.slice(1).join('  ·  '), L, 58, { ...sub, width: lw });
      }
    }
    text(o.title, L + width() * 0.5, 20, { size: SIZE.heading, family: 'display', weight: 'semibold', color: COLOR.white, width: width() * 0.5, align: 'right' });
    if (o.subtitle) text(o.subtitle, L + width() * 0.4, 44, { size: SIZE.small, color: COLOR.bandSub, width: width() * 0.6, align: 'right' });
    let y = bandH + 18;
    if (o.meta?.length) {
      // Columns sized to what they hold, so a date range isn't cut short.
      const items = o.meta.slice(0, 4);
      const valueStyle = { size: SIZE.lead, weight: 'medium' as const };
      const natural = items.map((m) => Math.max(measure(m.value, valueStyle), measure(m.label, { size: SIZE.label, caps: true })) + 18);
      const total = natural.reduce((a, b) => a + b, 0);
      const scale = total > width() ? width() / total : 1;
      const spare = total < width() ? (width() - total) / items.length : 0;
      let mx = L;
      items.forEach((m, i) => {
        const cw = natural[i] * scale + spare;
        text(m.label, mx, y, { size: SIZE.label, caps: true, color: COLOR.ink3, width: cw - 10 });
        text(m.value, mx, y + 11, { ...valueStyle, width: cw - 10 });
        mx += cw;
      });
      y += 34;
      hr(y);
      y += 14;
    }
    return y;
  }

  /**
   * A letterhead for correspondence (a letter to a court, an agency, an
   * employee): the company on white with a brand rule, the date and a
   * reference on the right. Returns the y below it.
   */
  function letterhead(o: { brand: Brand; date?: string; reference?: string }): number {
    let y = top;
    let logoW = 0;
    if (o.brand.logo) {
      try {
        doc.image(o.brand.logo, L, y - 4, { fit: [110, 32] });
        logoW = 0;
      } catch {
        logoW = -1;
      }
    }
    if (!o.brand.logo || logoW === -1) text(o.brand.name, L, y, { size: SIZE.heading, weight: 'semibold', width: width() * 0.6 });
    let ly = y + 24;
    for (const l of o.brand.lines ?? []) {
      text(l, L, ly, { size: SIZE.small, color: COLOR.ink3, width: width() * 0.6 });
      ly += 11;
    }
    let ry = y + 2;
    if (o.date) {
      text(o.date, L + width() * 0.6, ry, { size: SIZE.body, width: width() * 0.4, align: 'right' });
      ry += 14;
    }
    if (o.reference) text(o.reference, L + width() * 0.6, ry, { size: SIZE.small, color: COLOR.ink3, width: width() * 0.4, align: 'right' });
    y = Math.max(ly, ry + 12) + 6;
    box(L, y, width(), 1.5, COLOR.brand);
    return y + 22;
  }

  /** A section heading with a rule; returns the y for its content. */
  function section(title: string, y: number, hint?: string, o: { x?: number; w?: number } = {}): number {
    const x = o.x ?? L;
    const w = o.w ?? width();
    y = ensure(y, 48);
    const tw = hint ? Math.min(measure(title, { size: SIZE.title, weight: 'semibold' }), w * 0.6) : w;
    text(title, x, y, { size: SIZE.title, weight: 'semibold', width: tw + 1 });
    if (hint) text(hint, x + tw + 12, y + 2.5, { size: SIZE.small, color: COLOR.ink3, width: w - tw - 12, align: 'right' });
    hr(y + 19, x, w, COLOR.ink, 0.8);
    return y + 27;
  }

  /** The height a table will take (for keeping side-by-side blocks on one page). */
  function tableHeight(rows: number, o: { rowH?: number; totals?: boolean } = {}): number {
    const rowH = o.rowH ?? 17;
    return rowH + 3 + rows * rowH + (o.totals ? rowH + 6 : 0) + 10;
  }

  /** Label/value pairs in columns. Returns the y below. */
  function facts(items: Array<{ label: string; value: string; strong?: boolean }>, y: number, o: { x?: number; w?: number; cols?: number } = {}): number {
    const x = o.x ?? L;
    const w = o.w ?? width();
    const cols = o.cols ?? 2;
    const cw = w / cols;
    const rowH = 26;
    items.forEach((it, i) => {
      const cx = x + (i % cols) * cw;
      const cy = y + Math.floor(i / cols) * rowH;
      text(it.label, cx, cy, { size: SIZE.label, caps: true, color: COLOR.ink3, width: cw - 12 });
      text(it.value, cx, cy + 10, { size: SIZE.body, weight: it.strong ? 'semibold' : 'regular', width: cw - 12 });
    });
    return y + Math.ceil(items.length / cols) * rowH + 4;
  }

  /** A tinted note with an optional title. Returns the y below. */
  function callout(o: { tone?: Tone; title?: string; body: string }, y: number, x = L, w = width()): number {
    const t = TONE[o.tone ?? 'neutral'];
    const bodyH = para(o.body, x + 14, 0, w - 28, { size: SIZE.small }, false);
    const h = 12 + (o.title ? 14 : 0) + bodyH + 10;
    y = ensure(y, h);
    box(x, y, w, h, t.bg, 4);
    box(x, y, 3, h, t.fg);
    let cy = y + 10;
    if (o.title) {
      text(o.title, x + 14, cy, { size: SIZE.body, weight: 'semibold', color: t.fg, width: w - 28 });
      cy += 14;
    }
    para(o.body, x + 14, cy, w - 28, { size: SIZE.small, color: COLOR.ink2 });
    return y + h + 12;
  }

  /** Figure tiles in a row: label, big value, a hint. Returns the y below. */
  function figures(items: Array<{ label: string; value: string; hint?: string; tone?: Tone; emphasis?: boolean }>, y: number, o: { x?: number; w?: number } = {}): number {
    const x = o.x ?? L;
    const w = o.w ?? width();
    const gap = 8;
    const tw = (w - gap * (items.length - 1)) / items.length;
    const h = 64;
    y = ensure(y, h + 8);
    items.forEach((it, i) => {
      const tx = x + i * (tw + gap);
      if (it.emphasis) box(tx, y, tw, h, COLOR.band, 4);
      else outline(tx, y, tw, h);
      const fg = it.emphasis ? COLOR.white : it.tone ? TONE[it.tone].fg : COLOR.ink;
      text(it.label, tx + 10, y + 9, { size: SIZE.label, caps: true, color: it.emphasis ? COLOR.bandSub : COLOR.ink3, width: tw - 20 });
      text(it.value, tx + 10, y + 21, { size: SIZE.figure, weight: 'semibold', color: fg, width: tw - 20 });
      if (it.hint) text(it.hint, tx + 10, y + 49, { size: SIZE.label, color: it.emphasis ? COLOR.bandSub : COLOR.ink3, width: tw - 20 });
    });
    return y + h + 14;
  }

  /**
   * A table. Breaks across pages and repeats its header; zebra rows;
   * an optional totals row ruled above. Returns the y below.
   */
  function table<Row>(o: { y: number; columns: Column<Row>[]; rows: Row[]; totals?: Record<string, string>; x?: number; w?: number; rowH?: number; size?: number; zebra?: boolean; empty?: string; onNewPage?: (y: number) => number }): number {
    const x = o.x ?? L;
    const w = o.w ?? width();
    const rowH = o.rowH ?? 17;
    const size = o.size ?? SIZE.small;
    const total = o.columns.reduce((s, c) => s + c.width, 0);
    const cols = o.columns.map((c) => ({ ...c, px: (c.width / total) * w }));
    const pad = 5;
    const header = (y: number) => {
      box(x, y, w, rowH + 1, COLOR.wash);
      let cx = x;
      for (const c of cols) {
        text(c.header, cx + pad, y + (rowH - SIZE.label) / 2 - 0.5, { size: SIZE.label, caps: true, weight: 'medium', color: COLOR.ink3, width: c.px - pad * 2, align: c.align ?? 'left' });
        cx += c.px;
      }
      hr(y + rowH + 1, x, w, COLOR.ruleStrong);
      return y + rowH + 3;
    };
    let y = ensure(o.y, rowH * 3);
    y = header(y);
    if (o.rows.length === 0 && o.empty) {
      text(o.empty, x + pad, y + 4, { size, color: COLOR.ink3, width: w - pad * 2 });
      y += rowH + 4;
    }
    const wrapCols = cols.filter((c) => c.wrap);
    const heightOf = (r: Row) => {
      if (!wrapCols.length) return rowH;
      let h = rowH;
      for (const c of wrapCols) h = Math.max(h, para(c.value(r), 0, 0, c.px - pad * 2, { size, weight: c.strong ? 'semibold' : 'regular' }, false) + (rowH - size) - 1);
      return h;
    };
    o.rows.forEach((r, i) => {
      const h = heightOf(r);
      if (y + h > bottom()) {
        doc.addPage();
        y = o.onNewPage ? o.onNewPage(top) : top;
        y = header(y);
      }
      if (o.zebra !== false && i % 2 === 1) box(x, y, w, h, '#FAFBFC');
      let cx = x;
      for (const c of cols) {
        const st = { size, weight: (c.strong ? 'semibold' : 'regular') as Weight, color: c.color?.(r) ?? COLOR.ink };
        if (c.wrap) para(c.value(r), cx + pad, y + (rowH - size) / 2 + 0.5, c.px - pad * 2, st);
        else text(c.value(r), cx + pad, y + (rowH - size) / 2 - 0.5, { ...st, width: c.px - pad * 2, align: c.align ?? 'left' });
        cx += c.px;
      }
      y += h;
    });
    hr(y, x, w, COLOR.rule);
    if (o.totals) {
      y = ensure(y, rowH + 6);
      hr(y + 1, x, w, COLOR.ink, 0.8);
      let cx = x;
      for (const c of cols) {
        const v = o.totals[c.key];
        if (v) text(v, cx + pad, y + 4 + (rowH - size) / 2, { size, weight: 'semibold', width: c.px - pad * 2, align: c.align ?? 'left' });
        cx += c.px;
      }
      y += rowH + 6;
    }
    return y + 10;
  }

  /** A large diagonal word across the page (VOID, NON-NEGOTIABLE, DRAFT, CORRECTED). */
  function watermark(word: string, color: string = COLOR.bad, opacity = 0.08): void {
    doc.save();
    doc.rotate(-32, { origin: [pageW() / 2, pageH() / 2] });
    doc.fillOpacity(opacity).fillColor(color);
    doc.font(fontName('sans', 'bold', 'latin')).fontSize(Math.min(110, 900 / Math.max(4, word.length)));
    const w = doc.widthOfString(word);
    doc.text(word, pageW() / 2 - w / 2, pageH() / 2 - 50, { lineBreak: false });
    doc.restore();
  }

  /** A signature line with a caption. */
  function signatureLine(x: number, y: number, w: number, caption: string): void {
    hr(y, x, w, COLOR.ink, 0.6);
    text(caption, x, y + 4, { size: SIZE.label, caps: true, color: COLOR.ink3, width: w });
  }

  /** Footer on every page, then close the document. */
  function finish(o: { reference?: string; note?: string; confidential?: boolean; confidentialLabel?: string; pageLabel?: (n: number, of: number) => string; skipPages?: number[]; stamp?: string } = {}): Promise<Buffer> {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      if (o.skipPages?.includes(i - range.start)) continue;
      doc.switchToPage(i);
      const y = pageH() - M + 8;
      hr(y - 6, L, width(), COLOR.rule);
      const left = [o.confidential === false ? null : (o.confidentialLabel ?? 'Confidential'), o.note ?? null, o.reference ?? null].filter(Boolean).join('  ·  ');
      // The footer sits below the bottom margin: draw without pdfkit's auto-page.
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      text(left, L, y, { size: SIZE.micro, color: COLOR.ink3, width: width() - 80 });
      text(o.pageLabel ? o.pageLabel(i - range.start + 1, range.count) : `Page ${i - range.start + 1} of ${range.count}`, R() - 80, y, { size: SIZE.micro, color: COLOR.ink3, width: 80, align: 'right' });
      if (o.stamp) {
        // A faint diagonal stamp (who downloaded it, when): a photo of a page still says so.
        doc.save();
        doc.rotate(-32, { origin: [pageW() / 2, pageH() / 2] });
        doc.fillOpacity(0.07).fillColor(COLOR.ink);
        doc.font(fontName('sans', 'semibold', 'latin')).fontSize(20);
        const diag = Math.hypot(pageW(), pageH()) * 0.78;
        if (doc.widthOfString(o.stamp) > diag) doc.fontSize((20 * diag) / doc.widthOfString(o.stamp));
        const sw = doc.widthOfString(o.stamp);
        doc.text(o.stamp, pageW() / 2 - sw / 2, pageH() / 2 - 10, { lineBreak: false });
        doc.restore();
      }
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
    return done;
  }

  return {
    doc,
    L,
    R,
    width,
    top,
    bottom,
    measure,
    fit,
    text,
    para,
    hr,
    box,
    outline,
    ensure,
    masthead,
    letterhead,
    section,
    tableHeight,
    facts,
    callout,
    figures,
    table,
    watermark,
    signatureLine,
    finish,
  };
}

/** The tenant's name, logo and address lines for a masthead. */
export async function loadBrand(db: { orgSetting: { findFirst: (args: unknown) => Promise<unknown> } }, tenantId: string): Promise<Brand> {
  const row = (await db.orgSetting.findFirst({ where: { tenantId }, select: { orgName: true, logoBytes: true, logoContentType: true } })) as { orgName: string; logoBytes: Uint8Array | null; logoContentType?: string | null } | null;
  const logoOk = row?.logoBytes && (!row.logoContentType || /png|jpe?g/i.test(row.logoContentType));
  return { name: row?.orgName ?? 'Alto People', logo: logoOk ? Buffer.from(row!.logoBytes!) : null };
}
