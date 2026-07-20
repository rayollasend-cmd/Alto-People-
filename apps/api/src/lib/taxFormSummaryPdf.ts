import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

/**
 * Labeled-amounts summary sheet for aggregate tax forms (941, 940, W-3
 * transmittal totals). These aren't facsimiles of the official IRS layouts
 * — they're the review-and-transcribe sheet finance takes to the official
 * form or e-file portal, with every line labeled in plain English.
 */

export interface TaxFormSummaryData {
  title: string; // "Form 941 — Q2 2026" / "Form 940 — 2026" / "W-3 transmittal — 2026"
  employer: { name: string; ein: string };
  status: string;
  lines: Array<{ label: string; value: string; bold?: boolean }>;
  footnote?: string;
  generatedAt: string;
}

export function renderTaxFormSummaryPdf(
  data: TaxFormSummaryData,
): Promise<{ pdf: Buffer; hash: string }> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      resolve({ pdf, hash: createHash('sha256').update(pdf).digest('hex') });
    });
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text(data.title);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`${data.employer.name} — EIN ${data.employer.ein.slice(0, 2)}-${data.employer.ein.slice(2)}`)
      .fillColor('#666666')
      .fontSize(8)
      .text(`Status ${data.status} · generated ${data.generatedAt}`)
      .fillColor('#000000')
      .moveDown(1.2);

    for (const line of data.lines) {
      const y = doc.y;
      doc
        .font(line.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(line.bold ? 11 : 10)
        .text(line.label, 56, y, { width: 330 });
      doc.text(line.value, 400, y, { width: 156, align: 'right' });
      doc.moveDown(line.bold ? 0.7 : 0.45);
      if (doc.y > 700) doc.addPage();
    }

    if (data.footnote) {
      doc
        .moveDown(1)
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#666666')
        .text(data.footnote, 56, doc.y, { width: 500 })
        .fillColor('#000000');
    }
    doc.end();
  });
}
