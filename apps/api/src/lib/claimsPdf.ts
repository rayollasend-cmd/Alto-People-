import PDFDocument from 'pdfkit';

/**
 * A structured form PDF — the leave notices (WH-381/WH-382 content), the
 * unemployment response packet and the First Report of Injury. Sections of
 * label/value rows and plain paragraphs; nothing is interpreted as markup,
 * so a value typed into a field can't inject formatting.
 */

export interface FormSection {
  heading: string;
  rows?: Array<[string, string | null | undefined]>;
  paragraphs?: string[];
  /** Plain list items, each on its own line with a dash. */
  bullets?: string[];
}

export async function renderFormPdf(input: {
  title: string;
  subtitle?: string;
  sections: FormSection[];
  footer?: string;
  issuedAt?: Date;
}): Promise<Buffer> {
  const issuedAt = input.issuedAt ?? new Date();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 56,
      info: { Title: input.title, Author: 'Alto People', CreationDate: issuedAt },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(input.title);
    if (input.subtitle) {
      doc.moveDown(0.2).font('Helvetica').fontSize(10).fillColor('#444').text(input.subtitle);
    }
    doc.moveDown(0.2).font('Helvetica').fontSize(8).fillColor('#777').text(`Prepared in Alto People · ${issuedAt.toISOString().slice(0, 10)}`);
    doc.fillColor('#000');

    for (const section of input.sections) {
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(11).text(section.heading);
      doc.moveTo(doc.x, doc.y + 2).lineTo(doc.page.width - doc.page.margins.right, doc.y + 2).strokeColor('#ccc').stroke();
      doc.moveDown(0.5);
      for (const [label, value] of section.rows ?? []) {
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor('#555').text(label, doc.page.margins.left, y, { width: 170 });
        const labelBottom = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor('#000').text(value && value.trim() ? value : '—', doc.page.margins.left + 180, y, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 180,
        });
        doc.y = Math.max(doc.y, labelBottom) + 3;
        doc.x = doc.page.margins.left;
      }
      for (const p of section.paragraphs ?? []) {
        doc.font('Helvetica').fontSize(10).fillColor('#000').text(p, { align: 'left' });
        doc.moveDown(0.5);
      }
      for (const b of section.bullets ?? []) {
        doc.font('Helvetica').fontSize(10).fillColor('#000').text(`– ${b}`, { indent: 6 });
        doc.moveDown(0.2);
      }
    }
    if (input.footer) {
      doc.moveDown(1.2).font('Helvetica').fontSize(8).fillColor('#666').text(input.footer);
    }
    doc.end();
  });
}

export const fmtDay = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10) : '');
