import { createHash } from 'node:crypto';
import { SIZE, createDoc, fmt } from './docKit/index.js';

/**
 * Labeled-amounts summary sheet for aggregate tax forms (941, 940, W-3
 * transmittal totals). Not a facsimile of the official IRS layouts: the
 * review-and-transcribe sheet finance takes to the official form or the
 * e-file portal, every line labeled in plain English, in the house style.
 */

export interface TaxFormSummaryData {
  title: string; // "Form 941 — Q2 2026" / "Form 940 — 2026" / "W-3 transmittal — 2026"
  employer: { name: string; ein: string };
  status: string;
  lines: Array<{ label: string; value: string; bold?: boolean }>;
  footnote?: string;
  generatedAt: string;
}

/** Repair text whose em dashes were lost to an encoding slip upstream. */
const clean = (s: string) => s.replace(/�/g, '—');

export async function renderTaxFormSummaryPdf(data: TaxFormSummaryData): Promise<{ pdf: Buffer; hash: string }> {
  const title = clean(data.title);
  const { k } = createDoc({ title, author: data.employer.name });
  const ein = /^\d{9}$/.test(data.employer.ein) ? fmt.ein(data.employer.ein) : clean(data.employer.ein);
  let y = k.masthead({
    title,
    subtitle: 'Transcription sheet · not the official form',
    brand: { name: data.employer.name, lines: [`EIN ${ein}`] },
    meta: [
      { label: 'Status', value: clean(data.status) },
      { label: 'Prepared', value: fmt.dateTime(data.generatedAt) },
    ],
  });
  y = k.section('Figures to enter', y, 'Line by line, as they go on the return');
  y = k.table({
    y,
    rows: data.lines.map((l) => ({ ...l, label: clean(l.label), value: clean(l.value) })),
    rowH: 18,
    size: SIZE.body,
    columns: [
      { key: 'label', header: 'Line', width: 7, value: (l) => l.label },
      { key: 'value', header: 'Amount', width: 3, align: 'right', value: (l) => l.value, strong: true },
    ],
  });
  if (data.footnote) y = k.callout({ tone: 'neutral', body: clean(data.footnote) }, y);
  k.callout({ tone: 'info', title: 'Before you file', body: 'Compare each figure with the official form or portal as you enter it. The return is filed by the person who signs it; this sheet is the working copy for the payroll file.' }, y);
  const pdf = await k.finish({ reference: title });
  return { pdf, hash: createHash('sha256').update(pdf).digest('hex') };
}
