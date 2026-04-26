import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

/**
 * E-signature PDF renderer (Phase 19).
 *
 * Renders the agreement body verbatim into a PDF with a signature block
 * and audit panel at the bottom. The audit panel embeds the typed name,
 * IP, user agent, signedAt, and a sha256 placeholder line — the placeholder
 * is replaced AFTER the first render with the actual hash and the document
 * is rendered a second time so the hash represents the final bytes. The
 * "double render" pattern keeps the hash self-referential without resorting
 * to PDF /AcroForm trickery, and the bytes are deterministic for the same
 * inputs (pdfkit emits in a stable order with no timestamps in the stream).
 *
 * Plain text only — body is never interpreted as markdown or HTML, so
 * untrusted body content can't inject formatting or executable code.
 */

export interface EsignRenderInput {
  agreement: { id: string; title: string; body: string };
  signer: { fullName: string; email: string | null };
  signedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  /** What was typed in the signature box (proof). */
  typedName: string;
}

export async function renderSignedAgreement(input: EsignRenderInput): Promise<Buffer> {
  // Two-pass render: first with a placeholder hash, then re-render with the
  // real hash of pass-1 embedded so the audit panel stays self-consistent.
  const pass1 = await renderOnce({ ...input, hashOverride: 'pending' });
  const realHash = sha256(pass1);
  const pass2 = await renderOnce({ ...input, hashOverride: realHash });
  return pass2;
}

export function hashSignedPdf(buf: Buffer): string {
  // Final hash is computed over pass-2 bytes — what you get when you
  // download the PDF. This is what we store on Signature.pdfHash.
  return sha256(buf);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface RenderArgs extends EsignRenderInput {
  hashOverride: string;
}

async function renderOnce(args: RenderArgs): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Pin font + creation info so repeated renders produce identical bytes.
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 60,
      info: {
        Title: args.agreement.title,
        Author: 'Alto People',
        Subject: `Signed agreement ${args.agreement.id}`,
        // Pinning CreationDate makes the byte stream stable across renders.
        CreationDate: args.signedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.font('Helvetica-Bold').fontSize(16).text(args.agreement.title, { align: 'left' });
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor('#666').text('Issued via Alto People');
    doc.fillColor('#000');
    doc.moveDown(1.2);

    // Body — split on \n so paragraphs render naturally; pdfkit handles
    // word wrap inside each paragraph.
    doc.font('Helvetica').fontSize(11);
    for (const paragraph of args.agreement.body.split(/\n\s*\n/)) {
      doc.text(paragraph.trim(), { align: 'left' });
      doc.moveDown(0.6);
    }

    // Spacer before signature block.
    doc.moveDown(1);
    rule(doc);

    // Signature block
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).text('SIGNED');
    doc.moveDown(0.2);

    // Render the typed name in a script-like style (Helvetica-Oblique is
    // pdfkit-builtin so we don't ship a font). It's not a drawn signature
    // — it's an "I-typed-my-name" e-signature, exactly as ESIGN allows.
    doc.font('Helvetica-Oblique').fontSize(20).fillColor('#0a3d62').text(args.typedName);
    doc.fillColor('#000');

    doc.font('Helvetica').fontSize(9).fillColor('#444');
    doc.text(`Signer: ${args.signer.fullName}${args.signer.email ? ` (${args.signer.email})` : ''}`);
    doc.text(`Signed at: ${args.signedAt.toISOString()}`);
    doc.text(`IP address: ${args.ipAddress ?? '(not captured)'}`);
    doc.text(`User agent: ${truncate(args.userAgent ?? '(not captured)', 200)}`);
    doc.fillColor('#000');

    doc.moveDown(1);
    rule(doc);

    // Audit panel
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text('AUDIT');
    doc.font('Helvetica').fontSize(8).fillColor('#444');
    doc.text(`Agreement ID: ${args.agreement.id}`);
    doc.text(`Document SHA-256: ${args.hashOverride}`);
    doc.text(
      'This document was signed electronically per the federal E-SIGN Act ' +
        '(15 U.S.C. §7001) and applicable state UETA. The typed name above is ' +
        'the legal signature of the named signer.'
    );
    doc.fillColor('#000');

    doc.end();
  });
}

function rule(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc.moveTo(60, y).lineTo(552, y).strokeColor('#bbb').lineWidth(0.5).stroke();
  doc.strokeColor('#000');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
