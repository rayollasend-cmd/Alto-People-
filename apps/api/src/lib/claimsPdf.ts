import { COLOR, SIZE, createDoc, fmt, type Brand } from './docKit/index.js';
import { loadCurrentBrand, pinDocument, richHeight, richText } from './docKit/biz.js';
import { dateColumnKey } from './timezone.js';

/**
 * A structured form: the leave notices (WH-381/WH-382 content), the
 * unemployment response packet and the First Report of Injury. Each is
 * read by an agency examiner or an adjuster, so it reads like a filed
 * form: the company's masthead, the form's title and reference, then
 * numbered sections of labelled fields (ruled, so a blank is visibly
 * blank), plain paragraphs and lists. Nothing is interpreted as markup,
 * so a value typed into a field can't inject formatting.
 */

export interface FormSection {
  heading: string;
  rows?: Array<[string, string | null | undefined]>;
  paragraphs?: string[];
  /** Plain list items, each on its own line. */
  bullets?: string[];
}

export async function renderFormPdf(input: {
  title: string;
  subtitle?: string;
  sections: FormSection[];
  footer?: string;
  issuedAt?: Date;
  brand?: Brand;
  reference?: string;
}): Promise<Buffer> {
  const issuedAt = input.issuedAt ?? new Date();
  const brand = input.brand ?? (await loadCurrentBrand());
  const { k, doc } = createDoc({ title: input.title, author: brand.name });
  pinDocument(doc, issuedAt);
  const L = k.L;
  const Wd = k.width();

  let y = k.masthead({ title: input.title, subtitle: `Prepared ${fmt.date(issuedAt)}`, brand });
  if (input.subtitle) {
    richText(doc, input.subtitle, L, y, { width: Wd, lineGap: 2 }, { size: SIZE.lead, color: COLOR.ink2 });
    y = doc.y + 14;
  }

  const labelW = 190;
  input.sections.forEach((section, si) => {
    y = k.section(`${si + 1}. ${section.heading}`, y);
    for (const [label, value] of section.rows ?? []) {
      const v = value && value.trim() ? value : '—';
      const h = Math.max(18, richHeight(doc, v, Wd - labelW, { size: SIZE.body }, 1.5) + 8);
      y = k.ensure(y, h);
      richText(doc, label, L, y + 3, { width: labelW - 14, lineGap: 1 }, { size: SIZE.small, color: COLOR.ink3 });
      richText(doc, v, L + labelW, y + 2, { width: Wd - labelW, lineGap: 1.5 }, { size: SIZE.body, color: v === '—' ? COLOR.ink3 : COLOR.ink });
      y += h;
      k.hr(y - 2, L, Wd, COLOR.rule, 0.4);
    }
    if ((section.rows ?? []).length) y += 8;
    for (const p of section.paragraphs ?? []) {
      const h = richHeight(doc, p, Wd, { size: SIZE.body + 0.5 }, 3);
      y = k.ensure(y, Math.min(h, 60));
      richText(doc, p, L, y, { width: Wd, lineGap: 3 }, { size: SIZE.body + 0.5 });
      y = doc.y + 8;
    }
    for (const b of section.bullets ?? []) {
      const h = richHeight(doc, b, Wd - 16, { size: SIZE.body + 0.5 }, 2);
      y = k.ensure(y, h + 4);
      k.box(L + 3, y + 5, 4, 4, COLOR.brand, 2);
      richText(doc, b, L + 16, y, { width: Wd - 16, lineGap: 2 }, { size: SIZE.body + 0.5 });
      y = doc.y + 5;
    }
    y += 6;
  });

  if (input.footer) y = k.callout({ body: input.footer }, y + 4);

  return k.finish({ reference: input.reference ?? `${input.title} · ${fmt.date(issuedAt)}`, note: brand.name });
}

/** A claim's @db.Date column (claim, notice, due, leave dates) as the YYYY-MM-DD it names. Not for a moment — use orgDateKey. */
export const fmtDay = (d: Date | null | undefined): string => (d ? dateColumnKey(d) : '');
