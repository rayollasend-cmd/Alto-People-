import PDFDocument from 'pdfkit';
import { COMPANY_INFO } from './emailTemplates.js';

/**
 * Letterheaded report renderer — the house style for every generated
 * document artifact (audit packets, attestations, registers).
 *
 * What "house style" means concretely:
 *   - full corporate letterhead on page 1, compact letterhead on every
 *     continuation page;
 *   - a footer on EVERY page: confidentiality banner, reference id,
 *     corporate contact line, and "Page N of M" (stamped at the end via
 *     pdfkit's bufferPages, so M is real);
 *   - tables with a navy header row that repeats after page breaks,
 *     zebra striping, and per-cell wrapping;
 *   - headings, paragraphs, key/value blocks, warning callouts, and
 *     signature blocks that all share one type scale.
 *
 * Uses pdfkit's built-in Helvetica so no font files ship in the repo
 * (same choice as the paystub renderer).
 */

const NAVY = '#0F2A44';
const GOLD = '#C9A24C';
const INK = '#1A1A1A';
const MUTED = '#6B6B6B';
const RULE = '#E5E7EB';
const ZEBRA = '#F7F6F2';
const WARN_BG = '#FBF6E9';
const WARN_EDGE = '#C9A24C';

const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 72; // reserves room for the stamped footer

export interface ReportMeta {
  /** Document title, e.g. "Worker Roster". */
  title: string;
  /** One-line context under the title, e.g. the audit name. */
  subtitle?: string;
  /** Right-hand meta column on the letterhead. */
  facts?: Array<{ label: string; value: string }>;
  /** Reference id printed in the footer of every page. */
  reference: string;
  /** Footer confidentiality line; defaults to the standard banner. */
  confidentialityNote?: string;
}

export interface TableColumn {
  label: string;
  /** Fixed width in pt; columns without one share the remaining width. */
  width?: number;
  align?: 'left' | 'right';
}

export class ReportPdf {
  private doc: InstanceType<typeof PDFDocument>;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;
  private meta: ReportMeta;

  constructor(meta: ReportMeta) {
    this.meta = meta;
    this.doc = new PDFDocument({
      size: 'LETTER',
      bufferPages: true,
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
      info: { Title: meta.title, Author: COMPANY_INFO.legalName },
    });
    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => this.chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
    });
    // Continuation pages get the compact letterhead automatically, so
    // free-flowing text (long policies) stays on-brand without callers
    // managing page breaks.
    this.doc.on('pageAdded', () => this.compactHeader());
    this.fullHeader();
  }

  private get innerWidth(): number {
    return this.doc.page.width - MARGIN_X * 2;
  }
  private get breakY(): number {
    return this.doc.page.height - MARGIN_BOTTOM - 8;
  }

  private goldRule(weight = 1.2): void {
    const d = this.doc;
    d.moveTo(MARGIN_X, d.y).lineTo(d.page.width - MARGIN_X, d.y).lineWidth(weight).strokeColor(GOLD).stroke();
  }

  private fullHeader(): void {
    const d = this.doc;
    d.font('Helvetica-Bold').fontSize(19).fillColor(NAVY).text(COMPANY_INFO.name, { lineGap: 0 });
    d.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(COMPANY_INFO.tagline);
    d.font('Helvetica')
      .fontSize(8)
      .text(`${COMPANY_INFO.address}  ·  ${COMPANY_INFO.phone}  ·  ${COMPANY_INFO.email}  ·  ${COMPANY_INFO.hours}`);
    d.moveDown(0.6);
    this.goldRule();
    d.moveDown(1.1);

    const factsWidth = 200;
    const titleWidth = this.innerWidth - (this.meta.facts?.length ? factsWidth + 16 : 0);
    const topY = d.y;
    d.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(this.meta.title, MARGIN_X, topY, { width: titleWidth });
    if (this.meta.subtitle) {
      d.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(this.meta.subtitle, { width: titleWidth, lineGap: 1.5 });
    }
    const leftBottom = d.y;
    if (this.meta.facts?.length) {
      let fy = topY + 1;
      const fx = d.page.width - MARGIN_X - factsWidth;
      for (const f of this.meta.facts) {
        d.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(f.label.toUpperCase(), fx, fy, { width: factsWidth, lineBreak: false });
        fy += 9;
        d.font('Helvetica').fontSize(9).fillColor(INK).text(f.value, fx, fy, { width: factsWidth });
        fy = Math.max(fy + 11, d.y + 2);
      }
      d.y = Math.max(leftBottom, fy);
    } else {
      d.y = leftBottom;
    }
    d.x = MARGIN_X;
    d.moveDown(0.6);
    d.moveTo(MARGIN_X, d.y).lineTo(d.page.width - MARGIN_X, d.y).lineWidth(0.5).strokeColor(RULE).stroke();
    d.moveDown(1);
  }

  private compactHeader(): void {
    const d = this.doc;
    const y = 30;
    d.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text(COMPANY_INFO.name, MARGIN_X, y, { lineBreak: false });
    d.font('Helvetica').fontSize(8).fillColor(MUTED).text(
      `${this.meta.title} (continued)`,
      MARGIN_X,
      y + 1,
      { width: this.innerWidth, align: 'right' },
    );
    d.y = y + 14;
    this.goldRule(0.8);
    d.x = MARGIN_X;
    d.y += 14;
  }

  heading(text: string): void {
    const d = this.doc;
    if (d.y > this.breakY - 40) d.addPage();
    d.moveDown(0.4);
    d.font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(text, MARGIN_X, d.y, { width: this.innerWidth });
    d.moveDown(0.35);
  }

  para(text: string, opts?: { muted?: boolean; size?: number }): void {
    const d = this.doc;
    d.font('Helvetica')
      .fontSize(opts?.size ?? 10)
      .fillColor(opts?.muted ? MUTED : INK)
      .text(text, MARGIN_X, d.y, { width: this.innerWidth, lineGap: 2.5 });
    d.moveDown(0.55);
  }

  /** Label/value rows in two columns — worker record sheets, cover facts. */
  kv(rows: Array<{ label: string; value: string }>): void {
    const d = this.doc;
    const labelW = 170;
    for (const r of rows) {
      if (d.y > this.breakY - 14) d.addPage();
      const y = d.y;
      d.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(r.label.toUpperCase(), MARGIN_X, y + 0.5, { width: labelW, lineBreak: false });
      d.font('Helvetica').fontSize(10).fillColor(INK).text(r.value || '—', MARGIN_X + labelW, y, { width: this.innerWidth - labelW, lineGap: 1.5 });
      d.y = Math.max(y + 14, d.y + 3);
    }
    d.x = MARGIN_X;
    d.moveDown(0.4);
  }

  /** Warning/notice box with a gold edge. */
  callout(text: string): void {
    const d = this.doc;
    const padding = 10;
    const w = this.innerWidth;
    d.font('Helvetica').fontSize(9);
    const h = d.heightOfString(text, { width: w - padding * 2, lineGap: 2 }) + padding * 2;
    if (d.y + h > this.breakY) d.addPage();
    const y = d.y;
    d.rect(MARGIN_X, y, w, h).fillColor(WARN_BG).fill();
    d.rect(MARGIN_X, y, 3, h).fillColor(WARN_EDGE).fill();
    d.fillColor(INK).font('Helvetica').fontSize(9).text(text, MARGIN_X + padding + 2, y + padding, { width: w - padding * 2 - 2, lineGap: 2 });
    d.y = y + h;
    d.x = MARGIN_X;
    d.moveDown(0.7);
  }

  /**
   * Styled table: navy header row (repeated after every page break),
   * zebra striping, wrapped cells. Widths: fixed where given, remaining
   * space split evenly among the rest.
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

    const headerRow = () => {
      const hh = 18;
      d.rect(MARGIN_X, d.y, total, hh).fillColor(NAVY).fill();
      columns.forEach((c, i) => {
        d.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(c.label.toUpperCase(), xs[i] + PAD, d.y + 5.5, {
          width: widths[i] - PAD * 2,
          align: c.align ?? 'left',
          lineBreak: false,
        });
      });
      d.y += hh;
      d.x = MARGIN_X;
    };

    if (d.y > this.breakY - 60) d.addPage();
    headerRow();

    rows.forEach((row, ri) => {
      const cells = row.map((v) => (v === null || v === undefined ? '' : String(v)));
      d.font('Helvetica').fontSize(8.5);
      const rh =
        Math.max(
          12,
          ...cells.map((c, i) => d.heightOfString(c || ' ', { width: widths[i] - PAD * 2, lineGap: 1 })),
        ) + 7;
      if (d.y + rh > this.breakY) {
        d.addPage();
        headerRow();
      }
      if (ri % 2 === 1) {
        d.rect(MARGIN_X, d.y, total, rh).fillColor(ZEBRA).fill();
      }
      const y = d.y;
      cells.forEach((c, i) => {
        d.font('Helvetica').fontSize(8.5).fillColor(INK).text(c, xs[i] + PAD, y + 3.5, {
          width: widths[i] - PAD * 2,
          align: columns[i].align ?? 'left',
          lineGap: 1,
        });
      });
      d.y = y + rh;
      d.x = MARGIN_X;
      d.moveTo(MARGIN_X, d.y).lineTo(MARGIN_X + total, d.y).lineWidth(0.4).strokeColor(RULE).stroke();
    });
    d.moveDown(0.8);
  }

  /** Officer signature block (attestations, statements). */
  signatureBlock(): void {
    const d = this.doc;
    if (d.y > this.breakY - 130) d.addPage();
    d.moveDown(1.6);
    const line = (label: string) => {
      d.moveTo(MARGIN_X, d.y + 14).lineTo(MARGIN_X + 260, d.y + 14).lineWidth(0.7).strokeColor(INK).stroke();
      d.y += 18;
      d.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label, MARGIN_X, d.y);
      d.moveDown(1.4);
    };
    line('Signature');
    line('Name and title (printed)');
    line('Date');
  }

  /** Finish: stamp per-page footers (real page counts), return the PDF. */
  async render(): Promise<Buffer> {
    const d = this.doc;
    const range = d.bufferedPageRange();
    const note =
      this.meta.confidentialityNote ??
      'CONFIDENTIAL — contains personnel records. Handle per the data-handling terms of the applicable MSA.';
    for (let i = range.start; i < range.start + range.count; i++) {
      d.switchToPage(i);
      const y = d.page.height - 52;
      // Suspend the bottom margin so footer text can't trigger a new page.
      const saved = d.page.margins.bottom;
      d.page.margins.bottom = 0;
      d.moveTo(MARGIN_X, y - 6).lineTo(d.page.width - MARGIN_X, y - 6).lineWidth(0.5).strokeColor(RULE).stroke();
      d.font('Helvetica').fontSize(7).fillColor(MUTED).text(`${note}  ·  Ref ${this.meta.reference}`, MARGIN_X, y, {
        width: this.innerWidth - 70,
        lineBreak: false,
      });
      d.font('Helvetica').fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} of ${range.count}`, d.page.width - MARGIN_X - 70, y, {
        width: 70,
        align: 'right',
        lineBreak: false,
      });
      d.font('Helvetica').fontSize(7).fillColor(MUTED).text(
        `${COMPANY_INFO.legalName} · ${COMPANY_INFO.address} · ${COMPANY_INFO.phone} · ${COMPANY_INFO.email}`,
        MARGIN_X,
        y + 9,
        { width: this.innerWidth, lineBreak: false },
      );
      d.page.margins.bottom = saved;
    }
    d.end();
    return this.done;
  }
}
