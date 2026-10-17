import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

/**
 * Form 1095-C — Employer-Provided Health Insurance Offer and Coverage.
 *
 * One page per full-time employee for the year: Part I (employee and
 * applicable large employer), Part II (the offer, the lowest-cost premium
 * and the safe-harbor code, month by month, with an "all 12 months"
 * column when they agree). Part III is left off — the employer here is
 * not self-insured. The layout follows the IRS form's order so the person
 * reading it beside the official copy finds every box where they expect
 * it. Deterministic bytes: the creation date is pinned to the form's own
 * timestamp so a re-render hashes the same.
 */

export interface F1095cMonth {
  month: number;
  offerOfCoverage: string | null;
  lowestPremiumCents: number | null;
  safeHarbor: string | null;
  isFullTime: boolean;
}

export interface F1095cPdfData {
  taxYear: number;
  corrected?: boolean;
  employee: { firstName: string; lastName: string; ssn: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null };
  employer: { name: string; ein: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; contactPhone: string | null };
  /** Exactly 12 entries, January first; null = no record for the month. */
  months: Array<F1095cMonth | null>;
  planStartMonth?: number | null;
  meta: { formId: string; generatedAt: string };
}

const INK = '#1a2233';
const MUTED = '#5b6472';
const HAIR = '#b9c0cc';
const L = 36;
const R = 576;
const W = R - L;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function hash1095cPdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** "CODE_1A" → "1A"; anything else as given. */
export function acaCode(v: string | null | undefined): string {
  if (!v) return '';
  return v.replace(/^CODE_/, '');
}

function maskSsn(ssn: string | null): string {
  if (!ssn) return '';
  const d = ssn.replace(/\D/g, '');
  return d.length === 9 ? `XXX-XX-${d.slice(5)}` : ssn;
}

function einFmt(ein: string | null): string {
  if (!ein) return '';
  const d = ein.replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : ein;
}

function box(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, n: string, label: string, value: string, opts: { bold?: boolean } = {}) {
  doc.rect(x, y, w, h).strokeColor(HAIR).lineWidth(0.6).stroke();
  doc.font('Helvetica').fontSize(6).fillColor(MUTED).text(`${n} ${label}`, x + 3, y + 2, { width: w - 6, lineBreak: false });
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(INK).text(value, x + 3, y + 11, { width: w - 6, lineBreak: false });
}

export async function render1095cPdf(data: F1095cPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: L, info: { CreationDate: new Date(data.meta.generatedAt) } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(`Form 1095-C`, L, 40, { continued: true });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`   Employer-Provided Health Insurance Offer and Coverage`, { continued: false });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(String(data.taxYear), R - 60, 38, { width: 60, align: 'right' });
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Department of the Treasury — Internal Revenue Service · OMB No. 1545-2251', L, 58);
    if (data.corrected) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('CORRECTED', R - 90, 58, { width: 90, align: 'right' });
    }
    doc.moveTo(L, 70).lineTo(R, 70).strokeColor(INK).lineWidth(1).stroke();

    // Part I
    let y = 78;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Part I', L, y, { continued: true }).font('Helvetica').text('   Employee', { continued: true }).text('Applicable Large Employer Member (Employer)', L + W / 2, y);
    y += 14;
    const half = W / 2;
    const e = data.employee;
    const r = data.employer;
    box(doc, L, y, half, 26, '1', 'Name of employee (first, middle, last)', `${e.firstName} ${e.lastName}`, { bold: true });
    box(doc, L + half, y, half, 26, '7', 'Name of employer', r.name, { bold: true });
    y += 26;
    box(doc, L, y, half, 26, '2', 'Social security number (SSN)', maskSsn(e.ssn));
    box(doc, L + half, y, half, 26, '8', 'Employer identification number (EIN)', einFmt(r.ein));
    y += 26;
    box(doc, L, y, half, 26, '3', 'Street address (including apartment no.)', e.addressLine1 ?? '');
    box(doc, L + half, y, half, 26, '9', 'Street address (including room or suite no.)', r.addressLine1 ?? '');
    y += 26;
    box(doc, L, y, half / 2, 26, '4', 'City or town', e.city ?? '');
    box(doc, L + half / 2, y, half / 4, 26, '5', 'State', e.state ?? '');
    box(doc, L + (half * 3) / 4, y, half / 4, 26, '6', 'ZIP', e.zip ?? '');
    box(doc, L + half, y, half / 2, 26, '11', 'City or town', r.city ?? '');
    box(doc, L + half + half / 2, y, half / 4, 26, '12', 'State', r.state ?? '');
    box(doc, L + half + (half * 3) / 4, y, half / 4, 26, '13', 'ZIP', r.zip ?? '');
    y += 26;
    box(doc, L + half, y, half, 26, '10', 'Contact telephone number', r.contactPhone ?? '');
    y += 36;

    // Part II
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Part II', L, y, { continued: true }).font('Helvetica').text('   Employee Offer of Coverage', { continued: true });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Employee's Age on January 1: —     Plan Start Month: ${data.planStartMonth ? String(data.planStartMonth).padStart(2, '0') : '00'}`, L + 200, y);
    y += 16;

    const labelW = 150;
    const colW = (W - labelW) / 13;
    const rowH = 22;
    const heads = ['All 12 Months', ...MONTHS];
    doc.rect(L, y, W, rowH).fillColor('#eef1f5').fill();
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK);
    heads.forEach((h, i) => doc.text(h, L + labelW + i * colW, y + 7, { width: colW, align: 'center', lineBreak: false }));
    doc.rect(L, y, W, rowH).strokeColor(HAIR).lineWidth(0.6).stroke();
    y += rowH;

    const months = data.months;
    const allSame = <T,>(pick: (m: F1095cMonth | null) => T): T | null => {
      const vals = months.map(pick);
      return vals.every((v) => v === vals[0]) ? vals[0] : null;
    };
    const rows: Array<{ n: string; label: string; cells: string[]; all: string }> = [];
    const offerAll = allSame((m) => acaCode(m?.offerOfCoverage));
    rows.push({
      n: '14',
      label: 'Offer of Coverage (enter required code)',
      cells: months.map((m) => (offerAll !== null ? '' : acaCode(m?.offerOfCoverage))),
      all: offerAll !== null && offerAll !== '' ? offerAll : '',
    });
    const premiumAll = allSame((m) => m?.lowestPremiumCents ?? null);
    const money = (c: number | null) => (c === null ? '' : `$${(c / 100).toFixed(2)}`);
    rows.push({
      n: '15',
      label: 'Employee Required Contribution (see instructions)',
      cells: months.map((m) => (premiumAll !== null ? '' : money(m?.lowestPremiumCents ?? null))),
      all: premiumAll !== null ? money(premiumAll) : '',
    });
    const shAll = allSame((m) => m?.safeHarbor ?? '');
    rows.push({
      n: '16',
      label: 'Section 4980H Safe Harbor and Other Relief (enter code, if applicable)',
      cells: months.map((m) => (shAll !== null ? '' : (m?.safeHarbor ?? ''))),
      all: shAll !== null && shAll !== '' ? shAll : '',
    });
    for (const row of rows) {
      doc.rect(L, y, W, rowH + 6).strokeColor(HAIR).lineWidth(0.6).stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(`${row.n} ${row.label}`, L + 3, y + 4, { width: labelW - 6 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
      doc.text(row.all, L + labelW, y + 9, { width: colW, align: 'center', lineBreak: false });
      row.cells.forEach((c, i) => doc.text(c, L + labelW + (i + 1) * colW, y + 9, { width: colW, align: 'center', lineBreak: false }));
      for (let i = 0; i <= 13; i++) {
        doc.moveTo(L + labelW + i * colW, y).lineTo(L + labelW + i * colW, y + rowH + 6).strokeColor(HAIR).lineWidth(0.4).stroke();
      }
      y += rowH + 6;
    }
    y += 10;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
      'Full-time months: ' +
        (months.every((m) => m?.isFullTime) ? 'all 12' : months.map((m, i) => (m?.isFullTime ? MONTHS[i] : null)).filter(Boolean).join(', ') || 'none recorded') +
        '.',
      L,
      y,
    );
    y += 22;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Part III', L, y, { continued: true }).font('Helvetica').text('   Covered Individuals — not applicable (the employer does not sponsor self-insured coverage).');
    y += 30;

    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(
      'Instructions for Recipient: this form reports the health coverage your employer offered you. You do not attach it to your tax return; keep it with your records. ' +
        'Codes in line 14 describe the offer (1A–1H), line 15 the lowest monthly premium for self-only coverage, and line 16 any relief the employer claims. ' +
        'Questions go to the employer contact in Part I.',
      L,
      y,
      { width: W, align: 'justify' },
    );
    doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(`Form 1095-C (${data.taxYear}) · Alto form id ${data.meta.formId.slice(0, 8).toUpperCase()} · generated ${data.meta.generatedAt.slice(0, 10)}`, L, 740, { width: W });

    doc.end();
  });
}
