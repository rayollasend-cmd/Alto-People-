import PDFDocument from 'pdfkit';

/**
 * Plain letter PDF — the filed artifact for template renders (offer
 * letters today; other letter kinds can reuse it).
 *
 * Deliberately simpler than the e-sign renderer: no signature block, no
 * hash panel — this is the letter as ISSUED, not as signed. Body is plain
 * text only (same posture as esign.ts: never interpreted as markdown or
 * HTML, so template content can't inject formatting or code).
 */
export async function renderLetterPdf(input: {
  title: string;
  body: string;
  issuedAt: Date;
  issuedTo: string | null;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 60,
      info: {
        Title: input.title,
        Author: 'Alto People',
        CreationDate: input.issuedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text(input.title, { align: 'left' });
    doc.moveDown(0.4);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#666')
      .text(
        `Issued via Alto People · ${input.issuedAt.toISOString().slice(0, 10)}` +
          (input.issuedTo ? ` · For: ${input.issuedTo}` : ''),
      );
    doc.fillColor('#000');
    doc.moveDown(1.2);

    doc.font('Helvetica').fontSize(11);
    for (const paragraph of input.body.split(/\n\s*\n/)) {
      doc.text(paragraph.trim(), { align: 'left' });
      doc.moveDown(0.6);
    }

    doc.end();
  });
}
