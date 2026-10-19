import { createHash } from 'node:crypto';
import { COLOR, SIZE, createDoc, fmt, type Brand } from './docKit/index.js';
import { certificateBlock, pinDocument, richHeight, richText } from './docKit/biz.js';

/**
 * E-signature PDF renderer.
 *
 * The agreement as signed: the company's masthead, the agreement body
 * verbatim, the signature (the typed name, set in the display face on a
 * signature line), and a signature certificate — the audit trail an
 * attorney or an auditor asks for: signer, email, typed signature,
 * signed-at (UTC and Eastern), IP address, user agent, agreement id, the
 * document's SHA-256, and the legal basis.
 *
 * The hash is self-referential by a two-pass render: pass 1 carries a
 * placeholder, pass 2 embeds pass 1's hash. Bytes are deterministic for
 * the same inputs (the creation date is pinned to signedAt and nothing
 * else in the stream depends on the clock).
 *
 * Plain text only — the body is never interpreted as markdown or HTML, so
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
  /** The issuing company's name and logo; defaults to the platform name. */
  brand?: Brand;
}

export async function renderSignedAgreement(input: EsignRenderInput): Promise<Buffer> {
  // Two-pass render: first with a placeholder hash, then re-render with the
  // real hash of pass-1 embedded so the certificate stays self-consistent.
  const pass1 = await renderOnce({ ...input, hashOverride: 'pending' });
  const realHash = sha256(pass1);
  return renderOnce({ ...input, hashOverride: realHash });
}

export function hashSignedPdf(buf: Uint8Array): string {
  // Final hash is computed over pass-2 bytes — what you get when you
  // download the PDF. This is what we store on Signature.pdfHash.
  return sha256(buf);
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface RenderArgs extends EsignRenderInput {
  hashOverride: string;
}

/** The rows of the signature certificate, in order (exported for tests). */
export function certificateRows(args: Omit<RenderArgs, 'brand'>): Array<{ label: string; value: string }> {
  const eastern = args.signedAt.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  return [
    { label: 'Signer', value: args.signer.fullName },
    { label: 'Email', value: args.signer.email ?? '(none on file)' },
    { label: 'Typed signature', value: args.typedName },
    { label: 'Signed at', value: `${args.signedAt.toISOString()} (${eastern})` },
    { label: 'IP address', value: args.ipAddress ?? '(not captured)' },
    { label: 'User agent', value: truncate(args.userAgent ?? '(not captured)', 200) },
    { label: 'Agreement ID', value: args.agreement.id },
    { label: 'Document SHA-256', value: args.hashOverride },
  ];
}

async function renderOnce(args: RenderArgs): Promise<Buffer> {
  const brand = args.brand ?? { name: 'Alto People' };
  const { k, doc } = createDoc({ title: args.agreement.title, author: brand.name, subject: `Signed agreement ${args.agreement.id}` });
  // Pinning CreationDate makes the byte stream stable across renders.
  pinDocument(doc, args.signedAt);
  const L = k.L;
  const Wd = k.width();

  let y = k.masthead({
    title: 'Signed agreement',
    subtitle: `Signed electronically ${fmt.date(args.signedAt)}`,
    brand,
    meta: [
      { label: 'Signer', value: args.signer.fullName },
      { label: 'Signed', value: fmt.date(args.signedAt) },
      { label: 'Status', value: 'Signed' },
    ],
  });

  richText(doc, args.agreement.title, L, y, { width: Wd }, { size: SIZE.heading, family: 'display', weight: 'semibold' });
  y = doc.y + 14;

  // The body, verbatim, paragraph by paragraph.
  const size = SIZE.body + 1.5;
  for (const raw of args.agreement.body.split(/\n\s*\n/)) {
    const p = raw.trim();
    if (!p) continue;
    const h = richHeight(doc, p, Wd, { size }, 4);
    if (y + Math.min(h, 60) > k.bottom()) {
      doc.addPage();
      y = k.top;
    }
    richText(doc, p, L, y, { width: Wd, lineGap: 4 }, { size });
    y = doc.y + 12;
  }

  // The signature: the typed name on a signature line.
  y = k.ensure(y + 10, 96);
  k.text('Signature', L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
  richText(doc, args.typedName, L, y + 14, { width: Wd * 0.6 }, { size: 26, family: 'display', weight: 'semibold', color: '#0A3D62' });
  k.signatureLine(L, y + 58, Wd * 0.6, `Electronically signed by ${args.signer.fullName}`);
  k.text(fmt.dateTime(args.signedAt), L + Wd * 0.65, y + 46, { size: SIZE.small, color: COLOR.ink2, width: Wd * 0.35, align: 'right' });
  y += 86;

  // The certificate.
  certificateBlock(
    k,
    {
      title: 'Signature certificate',
      rows: certificateRows(args),
      seal: 'Signed electronically under the federal E-SIGN Act (15 U.S.C. §7001) and the applicable state UETA. The typed name above is the legal signature of the named signer. Any change to this document changes its SHA-256.',
    },
    y,
  );

  return k.finish({ reference: `Agreement ${args.agreement.id}`, note: brand.name });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
