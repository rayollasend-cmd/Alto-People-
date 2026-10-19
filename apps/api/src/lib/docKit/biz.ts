import { currentBrand } from './brand.js';
import { createHash } from 'node:crypto';
import { fontName, registerFonts, runsFor, type Family, type Weight } from './fonts.js';
import { COLOR, SIZE, fmt, type Brand, type Kit } from './index.js';

/**
 * docKit for business documents: the parts the core kit doesn't carry.
 *
 *  - Fonts on any PDFDocument: `ensureFonts`, and `aliasStandardFonts`
 *    which re-points Helvetica/Times at the house typefaces so an older
 *    renderer that names Helvetica draws in Geist without a rewrite.
 *  - `richText`: wrapped text that switches font subset mid-line, so a
 *    paragraph naming "Şükrü Yıldız" or "Nguyễn Thị Hằng" keeps every
 *    accent and still wraps.
 *  - The grid-and-primitives API the store/season/portal reports were
 *    built on (C, T, M, W, pdfHelpers …), now drawn in the house fonts and
 *    palette. It replaces lib/pdfDesign.ts.
 *  - Vector charts (bar, line, sparkline, donut) in the one data colour.
 *  - A cover page, a table of contents filled in after the content is
 *    laid out, and signature / certificate blocks.
 */

/* ---- Fonts on any document -------------------------------------------- */

const registered = new WeakSet<object>();
export function ensureFonts(doc: PDFKit.PDFDocument): void {
  if (registered.has(doc)) return;
  registerFonts(doc);
  registered.add(doc);
}

/** pdfkit caches the standard fonts it has opened; an alias must evict them. */
function evict(doc: PDFKit.PDFDocument, name: string): void {
  const families = (doc as unknown as { _fontFamilies?: Record<string, unknown> })._fontFamilies;
  if (families && name in families) delete families[name];
}

/**
 * Re-point the standard PDF fonts at the house typefaces: Helvetica →
 * Geist (regular / semibold), Times → Cormorant Garamond. Glyphs a name
 * needs outside Latin-1 still print (Geist's latin subset is wider than
 * WinAnsi); for full coverage draw names with richText or docKit text().
 */
export function aliasStandardFonts(doc: PDFKit.PDFDocument): void {
  ensureFonts(doc);
  const map: Array<[string, Family, Weight]> = [
    ['Helvetica', 'sans', 'regular'],
    ['Helvetica-Bold', 'sans', 'semibold'],
    ['Helvetica-Oblique', 'sans', 'regular'],
    ['Helvetica-BoldOblique', 'sans', 'semibold'],
    ['Times-Roman', 'display', 'medium'],
    ['Times-Bold', 'display', 'semibold'],
    ['Times-Italic', 'display', 'medium'],
  ];
  for (const [std, family, weight] of map) {
    const reg = (doc as unknown as { _registeredFonts: Record<string, unknown> })._registeredFonts;
    const src = reg[fontName(family, weight, 'latin')];
    if (src) reg[std] = src;
    evict(doc, std);
  }
  doc.font('Helvetica');
}

export interface RichStyle {
  size?: number;
  weight?: Weight;
  family?: Family;
  color?: string;
}

/**
 * Wrapped text in the house fonts that keeps every accent: each run of
 * characters is drawn in the subset that carries it, chained with
 * pdfkit's `continued` so wrapping flows across runs.
 */
export function richText(doc: PDFKit.PDFDocument, s: string, x: number, y: number, opts: { width: number; align?: 'left' | 'right' | 'center' | 'justify'; lineGap?: number }, st: RichStyle = {}): void {
  ensureFonts(doc);
  const family = st.family ?? 'sans';
  const weight = st.weight ?? 'regular';
  const runs = runsFor(s, family);
  doc.fillColor(st.color ?? COLOR.ink);
  runs.forEach((r, i) => {
    doc.font(fontName(family, weight, r.subset)).fontSize(st.size ?? SIZE.body);
    const last = i === runs.length - 1;
    if (i === 0) doc.text(r.text, x, y, { width: opts.width, align: opts.align, lineGap: opts.lineGap ?? 2, continued: !last });
    else doc.text(r.text, { continued: !last });
  });
  if (runs.length === 0) doc.text('', x, y, { width: opts.width });
}

/** The height richText would take (measured in the latin subset; accents add no height). */
export function richHeight(doc: PDFKit.PDFDocument, s: string, width: number, st: RichStyle = {}, lineGap = 2): number {
  ensureFonts(doc);
  doc.font(fontName(st.family ?? 'sans', st.weight ?? 'regular', 'latin')).fontSize(st.size ?? SIZE.body);
  return doc.heightOfString(s.normalize('NFKD').replace(/[̀-ͯ]/g, ''), { width, lineGap });
}

/* ---- The grid-and-primitives API (formerly lib/pdfDesign.ts) ---------- */

/** Colours with jobs: `data` plots, good/warn/bad judge, `brand` marks the masthead. */
export const C = {
  ink: COLOR.ink,
  ink2: COLOR.ink2,
  ink3: COLOR.ink3,
  rule: COLOR.rule,
  wash: COLOR.wash,
  brand: COLOR.brand,
  mastSub: COLOR.bandSub,
  data: COLOR.data,
  dataTint: '#C9D6F2',
  good: COLOR.good,
  warn: COLOR.warn,
  bad: COLOR.bad,
  white: COLOR.white,
} as const;

/** Five sizes. A sixth is a decision someone has to defend. */
export const T = { label: 8, body: 9.5, title: 12, figure: 20, hero: 36 } as const;

export const PAGE_W = 612;
export const PAGE_H = 792;
export const M = 44;
export const W = PAGE_W - M * 2;
export const GUTTER = 12;
export const GAP = 12;
export const PAD = 14;
export const HEAD = PAD + 15 + 8;
export const CONTENT_TOP = 62;
export const CONTENT_BOTTOM = PAGE_H - 58;
/** Layout constant the store reports position baselines with (Helvetica's ascent, kept: text() compensates). */
export const ASCENT = 0.718;
/** Geist sits taller in its box than Helvetica; shift up by the difference so baselines land where the layouts expect. */
const ASCENT_SHIFT = 1.005 - ASCENT;

/** Width of n columns on the 12-column grid. */
export const colW = (n: number) => ((W - GUTTER * 11) / 12) * n + GUTTER * (n - 1);

/**
 * Kept for callers that cleaned strings for the old WinAnsi fonts. The
 * house fonts carry Latin, Latin Extended, Vietnamese and Cyrillic, so the
 * only thing left to strip is control characters.
 */
export function pdfSafe(text: string): string {
  // eslint-disable-next-line no-control-regex -- strips C0 controls (except tab/newline)
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export interface Style {
  size?: number;
  bold?: boolean;
  color?: string;
  caps?: boolean;
}

/**
 * Drawing primitives bound to one document, every string placed at an
 * explicit x and y (pdfkit's own cursor makes blank pages at the bottom of
 * a section), measured before it is drawn, in the house fonts.
 */
export function pdfHelpers(doc: PDFKit.PDFDocument) {
  ensureFonts(doc);
  const spacingOf = (st: Style) => (st.caps ? 0.7 : 0);
  const prep = (s: string, st: Style) => (st.caps ? pdfSafe(s).toUpperCase() : pdfSafe(s));
  const weightOf = (st: Style): Weight => (st.bold ? 'semibold' : 'regular');

  const widthOf = (s: string, st: Style = {}) => {
    let w = 0;
    for (const r of runsFor(prep(s, st), 'sans')) {
      doc.font(fontName('sans', weightOf(st), r.subset)).fontSize(st.size ?? T.body);
      w += doc.widthOfString(r.text, { characterSpacing: spacingOf(st) });
    }
    return w;
  };
  const text = (s: string, x: number, y: number, st: Style = {}) => {
    const size = st.size ?? T.body;
    let cx = x;
    const cy = y - ASCENT_SHIFT * size;
    doc.fillColor(st.color ?? C.ink);
    for (const r of runsFor(prep(s, st), 'sans')) {
      doc.font(fontName('sans', weightOf(st), r.subset)).fontSize(size);
      doc.text(r.text, cx, cy, { lineBreak: false, characterSpacing: spacingOf(st) });
      cx += doc.widthOfString(r.text, { characterSpacing: spacingOf(st) });
    }
  };
  const textRight = (s: string, right: number, y: number, st: Style = {}) => text(s, right - widthOf(s, st), y, st);
  const textCenter = (s: string, cx: number, y: number, st: Style = {}) => text(s, cx - widthOf(s, st) / 2, y, st);
  const paraH = (s: string, w: number, st: Style = {}) => richHeight(doc, prep(s, st), w, { size: st.size ?? T.body, weight: weightOf(st) }, 1.5);
  const para = (s: string, x: number, y: number, w: number, st: Style = {}) =>
    richText(doc, prep(s, st), x, y - ASCENT_SHIFT * (st.size ?? T.body), { width: w, lineGap: 1.5 }, { size: st.size ?? T.body, weight: weightOf(st), color: st.color ?? C.ink });
  const hr = (x: number, y: number, w: number, color: string = C.rule, weight = 0.5) => {
    doc.save().lineWidth(weight).strokeColor(color).moveTo(x, y).lineTo(x + w, y).stroke().restore();
  };
  const rect = (x: number, y: number, w: number, h: number, fill: string) => {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  };
  /** Truncate by MEASUREMENT, so a long name shortens instead of wrapping. */
  const fitLine = (s: string, w: number, st: Style = {}) => {
    const safe = pdfSafe(s);
    if (widthOf(safe, st) <= w) return safe;
    let lo = 0;
    let hi = safe.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (widthOf(`${safe.slice(0, mid)}…`, st) <= w) lo = mid;
      else hi = mid - 1;
    }
    return `${safe.slice(0, lo)}…`;
  };

  return { widthOf, text, textRight, textCenter, para, paraH, hr, rect, fitLine };
}

/* ---- Charts ------------------------------------------------------------ */

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Horizontal bars, one per label, value printed at the bar's end. `tone`
 * paints a bar with a judgement colour; everything else is the data colour.
 */
export function barChart(k: Kit, o: { x?: number; y: number; w?: number; bars: Array<{ label: string; value: number; tone?: 'good' | 'warn' | 'bad' }>; format?: (v: number) => string; max?: number; barH?: number }): number {
  const x = o.x ?? k.L;
  const w = o.w ?? k.width();
  const barH = o.barH ?? 12;
  const rowH = barH + 8;
  const labelW = Math.min(170, w * 0.32);
  const valueW = 70;
  const plotW = w - labelW - valueW - 8;
  const max = o.max ?? niceMax(Math.max(0, ...o.bars.map((b) => b.value)));
  const format = o.format ?? ((v: number) => fmt.number(v, 0));
  let y = k.ensure(o.y, Math.min(o.bars.length, 6) * rowH);
  for (const b of o.bars) {
    y = k.ensure(y, rowH);
    k.text(b.label, x, y + (barH - SIZE.small) / 2 - 0.5, { size: SIZE.small, color: COLOR.ink2, width: labelW - 8 });
    k.box(x + labelW, y, plotW, barH, COLOR.wash, 2);
    const bw = Math.max(0, Math.min(1, b.value / max)) * plotW;
    if (bw > 0) k.box(x + labelW, y, Math.max(bw, 2), barH, b.tone ? COLOR[b.tone] : COLOR.data, 2);
    k.text(format(b.value), x + labelW + plotW + 8, y + (barH - SIZE.small) / 2 - 0.5, { size: SIZE.small, weight: 'medium', width: valueW, align: 'right' });
    y += rowH;
  }
  return y + 6;
}

/** A line chart with light gridlines, y-axis labels and x labels at the ends and middle. */
export function lineChart(k: Kit, o: { x?: number; y: number; w?: number; h?: number; series: Array<{ label: string; points: number[]; dashed?: boolean }>; xLabels?: string[]; format?: (v: number) => string; min?: number }): number {
  const x = o.x ?? k.L;
  const w = o.w ?? k.width();
  const h = o.h ?? 120;
  const doc = k.doc;
  const y0 = k.ensure(o.y, h + 30);
  const all = o.series.flatMap((s) => s.points);
  const max = niceMax(Math.max(0, ...all));
  const min = o.min ?? 0;
  const axisW = 44;
  const pw = w - axisW;
  const format = o.format ?? ((v: number) => fmt.number(v, 0));
  for (let i = 0; i <= 4; i++) {
    const gy = y0 + h - (h * i) / 4;
    k.hr(gy, x + axisW, pw, i === 0 ? COLOR.ruleStrong : COLOR.rule, 0.5);
    k.text(format(min + ((max - min) * i) / 4), x, gy - 4, { size: SIZE.micro, color: COLOR.ink3, width: axisW - 6, align: 'right' });
  }
  const shades = [COLOR.data, COLOR.ink3, COLOR.brand];
  o.series.forEach((s, si) => {
    if (s.points.length === 0) return;
    const step = s.points.length > 1 ? pw / (s.points.length - 1) : 0;
    doc.save().lineWidth(1.6).strokeColor(shades[si % shades.length]);
    if (s.dashed) doc.dash(3, { space: 2 });
    s.points.forEach((p, i) => {
      const px = x + axisW + i * step;
      const py = y0 + h - ((p - min) / (max - min || 1)) * h;
      if (i === 0) doc.moveTo(px, py);
      else doc.lineTo(px, py);
    });
    doc.stroke().undash().restore();
  });
  if (o.xLabels?.length) {
    const n = o.xLabels.length;
    const picks = n <= 3 ? o.xLabels.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
    for (const i of picks) {
      const px = x + axisW + (n > 1 ? (pw * i) / (n - 1) : 0);
      k.text(o.xLabels[i], px - 40, y0 + h + 5, { size: SIZE.micro, color: COLOR.ink3, width: 80, align: 'center' });
    }
  }
  let ly = y0 + h + 18;
  if (o.series.length > 1) {
    let lx = x + axisW;
    o.series.forEach((s, si) => {
      k.box(lx, ly + 3, 10, 2, shades[si % shades.length]);
      k.text(s.label, lx + 14, ly, { size: SIZE.label, color: COLOR.ink2 });
      lx += 24 + k.measure(s.label, { size: SIZE.label });
    });
    ly += 14;
  }
  return ly + 6;
}

/** A small trend line inside a box (KPI tiles, table cells). */
export function sparkline(doc: PDFKit.PDFDocument, o: { x: number; y: number; w: number; h: number; points: number[]; color?: string }): void {
  if (o.points.length < 2) return;
  const max = Math.max(...o.points);
  const min = Math.min(...o.points);
  const span = max - min || 1;
  const step = o.w / (o.points.length - 1);
  doc.save().lineWidth(1.2).strokeColor(o.color ?? COLOR.data);
  o.points.forEach((p, i) => {
    const px = o.x + i * step;
    const py = o.y + o.h - ((p - min) / span) * o.h;
    if (i === 0) doc.moveTo(px, py);
    else doc.lineTo(px, py);
  });
  doc.stroke().restore();
}

/** A donut of shares with a centre label. Segments without a colour step through data shades. */
export function donut(k: Kit, o: { cx: number; cy: number; r: number; thickness?: number; segments: Array<{ value: number; color?: string; label: string }>; center?: string; centerSub?: string }): void {
  const doc = k.doc;
  const total = o.segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const t = o.thickness ?? o.r * 0.32;
  const shades = [COLOR.data, '#7C9BE3', '#C9D6F2', COLOR.ink3, COLOR.rule];
  let a = -Math.PI / 2;
  o.segments.forEach((s, i) => {
    const sweep = (Math.max(0, s.value) / total) * Math.PI * 2;
    if (sweep <= 0) return;
    const a2 = a + sweep;
    const outer = (ang: number) => [o.cx + Math.cos(ang) * o.r, o.cy + Math.sin(ang) * o.r] as const;
    const inner = (ang: number) => [o.cx + Math.cos(ang) * (o.r - t), o.cy + Math.sin(ang) * (o.r - t)] as const;
    const large = sweep > Math.PI ? 1 : 0;
    const [ox1, oy1] = outer(a);
    const [ox2, oy2] = outer(a2 - 0.0001);
    const [ix2, iy2] = inner(a2 - 0.0001);
    const [ix1, iy1] = inner(a);
    doc
      .save()
      .path(`M ${ox1} ${oy1} A ${o.r} ${o.r} 0 ${large} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${o.r - t} ${o.r - t} 0 ${large} 0 ${ix1} ${iy1} Z`)
      .fill(s.color ?? shades[i % shades.length])
      .restore();
    a = a2;
  });
  if (o.center) k.text(o.center, o.cx - o.r, o.cy - 9, { size: SIZE.title, weight: 'semibold', width: o.r * 2, align: 'center' });
  if (o.centerSub) k.text(o.centerSub, o.cx - o.r, o.cy + 6, { size: SIZE.micro, color: COLOR.ink3, width: o.r * 2, align: 'center' });
}

/* ---- Cover, contents, certificates ------------------------------------ */

/**
 * A full-bleed cover: brand band, the document's title in the display
 * face, who it was prepared for, the key facts, and a confidentiality
 * line. Leaves the document on a fresh page for the content.
 */
export function coverPage(k: Kit, o: { brand: Brand; kicker?: string; title: string; subtitle?: string; preparedFor?: string; facts?: Array<{ label: string; value: string }>; note?: string }): void {
  const doc = k.doc;
  const pw = doc.page.width;
  const ph = doc.page.height;
  k.box(0, 0, pw, ph * 0.46, COLOR.band);
  k.box(0, ph * 0.46, pw, 4, COLOR.brand);
  let logo = false;
  if (o.brand.logo) {
    try {
      doc.image(o.brand.logo, k.L, 48, { fit: [150, 44] });
      logo = true;
    } catch {
      logo = false;
    }
  }
  if (!logo) k.text(o.brand.name, k.L, 52, { size: SIZE.title, weight: 'semibold', color: COLOR.white, width: k.width() });
  if (o.kicker) k.text(o.kicker, k.L, ph * 0.46 - 150, { size: SIZE.small, caps: true, color: COLOR.brand, weight: 'medium', width: k.width() });
  richText(doc, o.title, k.L, ph * 0.46 - 130, { width: k.width() * 0.85, lineGap: 0 }, { size: 34, family: 'display', weight: 'semibold', color: COLOR.white });
  if (o.subtitle) k.text(o.subtitle, k.L, ph * 0.46 - 40, { size: SIZE.lead, color: COLOR.bandSub, width: k.width() });
  let y = ph * 0.46 + 44;
  if (o.preparedFor) {
    k.text('Prepared for', k.L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
    k.text(o.preparedFor, k.L, y + 12, { size: SIZE.heading, weight: 'semibold', width: k.width() });
    y += 48;
  }
  if (o.facts?.length) k.facts(o.facts, y, { cols: 3 });
  if (o.note) richText(doc, o.note, k.L, ph - 110, { width: k.width(), lineGap: 2 }, { size: SIZE.small, color: COLOR.ink3 });
  doc.addPage();
}

/** Reserve a page for the contents; fill it with `drawContents` once the content's pages are known. */
export function reserveContents(k: Kit): number {
  const doc = k.doc;
  const idx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
  doc.addPage();
  return idx;
}

/** Draw the table of contents on a reserved page. Page numbers are 1-based, as printed. */
export function drawContents(k: Kit, pageIndex: number, entries: Array<{ title: string; page: number; note?: string }>, title = 'Contents'): void {
  const doc = k.doc;
  doc.switchToPage(pageIndex);
  let y = k.top;
  k.text(title, k.L, y, { size: SIZE.hero, family: 'display', weight: 'semibold' });
  y += 48;
  k.hr(y, k.L, k.width(), COLOR.ink, 0.8);
  y += 14;
  entries.forEach((e, i) => {
    const num = String(i + 1).padStart(2, '0');
    k.text(num, k.L, y, { size: SIZE.small, color: COLOR.brand, weight: 'semibold' });
    k.text(e.title, k.L + 28, y, { size: SIZE.lead, width: k.width() - 90 });
    if (e.note) k.text(e.note, k.L + 28, y + 14, { size: SIZE.small, color: COLOR.ink3, width: k.width() - 90 });
    k.text(String(e.page), k.R() - 50, y, { size: SIZE.lead, weight: 'medium', width: 50, align: 'right' });
    const lead = e.note ? 30 : 20;
    k.hr(y + lead - 4, k.L + 28, k.width() - 28, COLOR.rule, 0.4);
    y += lead + 4;
  });
}

/** The current page's printed number (1-based). */
export function currentPage(k: Kit): number {
  const r = k.doc.bufferedPageRange();
  return r.count;
}

/**
 * A certificate block: a bordered panel of labelled facts with a seal
 * line, for an e-signature audit trail or an attestation.
 */
export function certificateBlock(k: Kit, o: { title: string; rows: Array<{ label: string; value: string; mono?: boolean }>; seal?: string }, y: number): number {
  const labelW = 150;
  const innerW = k.width() - 28;
  const rowHeights = o.rows.map((r) => Math.max(16, richHeight(k.doc, r.value || '—', innerW - labelW, { size: SIZE.small }) + 6));
  const sealH = o.seal ? richHeight(k.doc, o.seal, innerW, { size: SIZE.micro + 0.5 }, 1.5) + 18 : 10;
  const h = 40 + rowHeights.reduce((s, v) => s + v, 0) + sealH;
  y = k.ensure(y, h);
  k.outline(k.L, y, k.width(), h, COLOR.ruleStrong, 6);
  k.box(k.L, y, k.width(), 30, COLOR.wash, 6);
  k.box(k.L, y + 24, k.width(), 6, COLOR.wash);
  k.text(o.title, k.L + 14, y + 10, { size: SIZE.body, weight: 'semibold', width: innerW });
  let cy = y + 40;
  o.rows.forEach((r, i) => {
    k.text(r.label, k.L + 14, cy, { size: SIZE.label, caps: true, color: COLOR.ink3, width: labelW - 10 });
    richText(k.doc, r.value || '—', k.L + 14 + labelW, cy - 1.5, { width: innerW - labelW, lineGap: 1 }, { size: SIZE.small, color: COLOR.ink });
    cy += rowHeights[i];
  });
  if (o.seal) {
    k.hr(cy + 2, k.L + 14, innerW, COLOR.rule);
    richText(k.doc, o.seal, k.L + 14, cy + 9, { width: innerW, lineGap: 1.5 }, { size: SIZE.micro + 0.5, color: COLOR.ink3 });
  }
  return y + h + 14;
}

/** Signature lines in a row: signature, printed name and title, date. */
export function signatureRow(k: Kit, y: number, labels: string[] = ['Signature', 'Name and title', 'Date']): number {
  y = k.ensure(y, 50);
  const gap = 18;
  const w = (k.width() - gap * (labels.length - 1)) / labels.length;
  labels.forEach((l, i) => k.signatureLine(k.L + i * (w + gap), y + 30, w, l));
  return y + 52;
}

/* ---- The current tenant's brand ----------------------------------------- */

/**
 * The tenant's name and logo for a masthead, read inside the request's
 * tenant scope. Never fails a document: without a scope or a row it falls
 * back to the platform name.
 */
/**
 * The signed-in tenant's brand, read from the database (logo included). The
 * branding cache (docKit/brand.ts currentBrand) answers instantly when it is
 * warm; this is for documents built outside a request that warmed it.
 */
export async function loadCurrentBrand(fallback = 'Alto People'): Promise<Brand> {
  const cached = currentBrand();
  if (cached.logo || cached.name !== 'Alto People') return cached;
  try {
    const [{ prisma }, { tenantIdForWrite }, { loadBrand }] = await Promise.all([import('../../db.js'), import('../tenant.js'), import('./index.js')]);
    return await loadBrand(prisma as never, tenantIdForWrite());
  } catch {
    return { name: fallback };
  }
}

/**
 * Pin a document's creation date so the same inputs give the same bytes
 * (e-signed agreements hash their own bytes). pdfkit derives the file ID
 * from the info dictionary when the document is constructed, so the ID is
 * recomputed here the way pdfkit does it.
 */
export function pinDocument(doc: PDFKit.PDFDocument, date: Date): void {
  const info = doc.info as unknown as Record<string, { valueOf(): unknown } | undefined> & { CreationDate: Date };
  info.CreationDate = date;
  let infoStr = `${date.getTime()}\n`;
  for (const key of Object.keys(info)) infoStr += `${key}: ${String(info[key]?.valueOf())}\n`;
  (doc as unknown as { _id: Buffer })._id = createHash('md5').update(infoStr).digest();
}
