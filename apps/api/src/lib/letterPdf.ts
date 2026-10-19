import { COLOR, SIZE, createDoc, fmt, type Brand } from './docKit/index.js';
import { loadCurrentBrand, pinDocument, richHeight, richText } from './docKit/biz.js';

/**
 * A letter on letterhead: the filed artifact for offer letters,
 * promotion letters, employment-verification letters, B-notices and
 * signed W-9 copies. Laid out as a business letter: the company's
 * letterhead, the date, the recipient, a subject line, the body, and a
 * signature block when the letter carries a signer.
 *
 * The body is plain text, never interpreted as markdown or HTML, so a
 * template's content can't inject formatting. Paragraphs are separated
 * by a blank line; names keep every accent.
 */
export async function renderLetterPdf(input: {
  title: string;
  body: string;
  issuedAt: Date;
  issuedTo: string | null;
  /** The recipient's address lines, when the letter is mailed. */
  toLines?: string[];
  /** Who signs, printed under the closing. */
  signer?: { name: string; title?: string | null } | null;
  brand?: Brand;
  reference?: string;
}): Promise<Buffer> {
  const brand = input.brand ?? (await loadCurrentBrand());
  const { k, doc } = createDoc({ title: input.title, author: brand.name, subject: input.issuedTo ? `${input.title} — ${input.issuedTo}` : input.title });
  pinDocument(doc, input.issuedAt);
  const L = k.L;
  const Wd = k.width();

  // ---- Letterhead -------------------------------------------------------
  let logo = false;
  if (brand.logo) {
    try {
      doc.image(brand.logo, L, 40, { fit: [150, 40] });
      logo = true;
    } catch {
      logo = false;
    }
  }
  if (!logo) k.text(brand.name, L, 44, { size: SIZE.heading, family: 'display', weight: 'semibold', width: Wd * 0.6 });
  if (brand.lines?.length) brand.lines.forEach((l, i) => k.text(l, L + Wd * 0.55, 44 + i * 11, { size: SIZE.small, color: COLOR.ink3, width: Wd * 0.45, align: 'right' }));
  k.box(L, 92, Wd, 1.5, COLOR.brand);

  // ---- Date, recipient, subject -----------------------------------------
  let y = 122;
  k.text(fmt.date(input.issuedAt), L, y, { size: SIZE.body + 0.5, color: COLOR.ink2 });
  y += 30;
  if (input.issuedTo) {
    k.text(input.issuedTo, L, y, { size: SIZE.body + 0.5, weight: 'medium', width: Wd * 0.6 });
    y += 14;
    for (const l of input.toLines ?? []) {
      k.text(l, L, y, { size: SIZE.body + 0.5, color: COLOR.ink2, width: Wd * 0.6 });
      y += 13;
    }
    y += 16;
  }
  richText(doc, input.title, L, y, { width: Wd }, { size: SIZE.lead + 1, weight: 'semibold' });
  y = doc.y + 18;

  // ---- Body -------------------------------------------------------------
  const size = SIZE.body + 1.5;
  for (const raw of input.body.split(/\n\s*\n/)) {
    const p = raw.trim();
    if (!p) continue;
    const h = richHeight(doc, p, Wd, { size }, 4);
    if (y + Math.min(h, 60) > k.bottom()) {
      doc.addPage();
      y = k.top;
    }
    richText(doc, p, L, y, { width: Wd, lineGap: 4 }, { size, color: COLOR.ink });
    y = doc.y + 12;
  }

  // ---- Signature --------------------------------------------------------
  if (input.signer) {
    y = k.ensure(y + 8, 90);
    k.text('Sincerely,', L, y, { size, color: COLOR.ink2 });
    k.signatureLine(L, y + 52, 220, input.signer.title ? `${input.signer.name}, ${input.signer.title}` : input.signer.name);
  }

  return k.finish({ reference: input.reference ?? `${input.title} · issued ${fmt.date(input.issuedAt)}`, note: brand.name });
}
