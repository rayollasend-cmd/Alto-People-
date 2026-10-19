import { createHash } from 'node:crypto';
import { SIZE, createDoc } from './docKit/index.js';
import { BLACK, GREY, formBox } from './taxFormKit.js';

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

/** Plain-English meaning of the codes this form most often carries (Instructions for Forms 1094-C and 1095-C). */
const CODE_MEANING: Record<string, string> = {
  '1A': 'Qualifying offer: minimum essential coverage providing minimum value, self-only cost at or below the federal poverty line safe harbor, offered to you, your spouse and dependents.',
  '1B': 'Minimum essential coverage providing minimum value offered to you only.',
  '1C': 'Minimum essential coverage providing minimum value offered to you and your dependents (not your spouse).',
  '1D': 'Minimum essential coverage providing minimum value offered to you and your spouse (not dependents).',
  '1E': 'Minimum essential coverage providing minimum value offered to you, your spouse and dependents.',
  '1F': 'Minimum essential coverage NOT providing minimum value offered to you, or you and your spouse or dependents.',
  '1G': 'Offer of coverage to an employee who was not full-time for any month of the year and who enrolled in self-insured coverage.',
  '1H': 'No offer of coverage (or coverage offered that is not minimum essential coverage).',
  '2A': 'You were not employed during the month.',
  '2B': 'You were not a full-time employee for the month.',
  '2C': 'You enrolled in the coverage offered.',
  '2D': 'You were in a section 4980H(b) limited non-assessment period (for example, a waiting period).',
  '2F': 'Affordability safe harbor: Form W-2 wages.',
  '2G': 'Affordability safe harbor: federal poverty line.',
  '2H': 'Affordability safe harbor: rate of pay.',
};

export async function render1095cPdf(data: F1095cPdfData): Promise<Buffer> {
  const { k } = createDoc({ title: `Form 1095-C ${data.taxYear} · ${data.employee.firstName} ${data.employee.lastName}`, author: data.employer.name, margin: 36, creationDate: new Date(data.meta.generatedAt) });
  const L = 36;
  const W = 540;
  let y = 36;

  // Title block, as on the form.
  k.text('Form', L, y + 6, { size: 7, color: BLACK });
  k.text('1095-C', L + 20, y, { size: 18, weight: 'bold', color: BLACK });
  k.text('Employer-Provided Health Insurance Offer and Coverage', L + 100, y + 4, { size: 10, weight: 'semibold', color: BLACK });
  k.text('Department of the Treasury · Internal Revenue Service', L + 100, y + 17, { size: 6.5, color: GREY });
  k.text(String(data.taxYear), L + W - 70, y - 2, { size: 20, weight: 'bold', color: BLACK, width: 70, align: 'right' });
  k.text('OMB No. 1545-2251', L + W - 120, y + 20, { size: 6, color: GREY, width: 120, align: 'right' });
  if (data.corrected) k.text('CORRECTED', L + W - 200, y + 5, { size: 9, weight: 'bold', color: BLACK, width: 120, align: 'right' });
  y += 34;
  k.hr(y, L, W, BLACK, 1.2);
  y += 8;

  // Part I.
  k.text('Part I', L, y, { size: 8.5, weight: 'bold', color: BLACK });
  k.text('Employee', L + 36, y, { size: 8.5, color: BLACK });
  k.text('Applicable Large Employer Member (Employer)', L + W / 2 + 4, y, { size: 8.5, color: BLACK });
  y += 12;
  const half = W / 2;
  const e = data.employee;
  const r = data.employer;
  const o = { valueSize: 9 };
  formBox(k, L, y, half, 26, '1  Name of employee (first name, middle initial, last name)', `${e.firstName} ${e.lastName}`, o);
  formBox(k, L + half, y, half, 26, '7  Name of employer', r.name, o);
  y += 26;
  formBox(k, L, y, half, 26, '2  Social security number (SSN)', maskSsn(e.ssn), o);
  formBox(k, L + half, y, half, 26, '8  Employer identification number (EIN)', einFmt(r.ein), o);
  y += 26;
  formBox(k, L, y, half, 26, '3  Street address (including apartment no.)', e.addressLine1 ?? '', o);
  formBox(k, L + half, y, half, 26, '9  Street address (including room or suite no.)', r.addressLine1 ?? '', o);
  y += 26;
  formBox(k, L, y, half / 2, 26, '4  City or town', e.city ?? '', o);
  formBox(k, L + half / 2, y, half / 4, 26, '5  State or province', e.state ?? '', o);
  formBox(k, L + (half * 3) / 4, y, half / 4, 26, '6  ZIP or postal code', e.zip ?? '', o);
  formBox(k, L + half, y, half / 2, 26, '11  City or town', r.city ?? '', o);
  formBox(k, L + half * 1.5, y, half / 4, 26, '12  State or province', r.state ?? '', o);
  formBox(k, L + half * 1.75, y, half / 4, 26, '13  ZIP or postal code', r.zip ?? '', o);
  y += 26;
  formBox(k, L + half, y, half, 26, '10  Contact telephone number', r.contactPhone ?? '', o);
  y += 36;

  // Part II.
  k.text('Part II', L, y, { size: 8.5, weight: 'bold', color: BLACK });
  k.text('Employee Offer of Coverage', L + 38, y, { size: 8.5, color: BLACK });
  k.text(`Plan Start Month (enter 2-digit number): ${data.planStartMonth ? String(data.planStartMonth).padStart(2, '0') : '00'}`, L + W - 240, y, { size: 7.5, color: BLACK, width: 240, align: 'right' });
  y += 12;
  const labelW = 150;
  const colW = (W - labelW) / 13;
  const heads = ['All 12 Months', ...MONTHS];
  k.doc.save().lineWidth(0.5).strokeColor(BLACK).rect(L, y, W, 18).stroke().restore();
  heads.forEach((h, i) => {
    if (i === 0) {
      k.text('All 12', L + labelW, y + 2.5, { size: 6, weight: 'semibold', color: BLACK, width: colW, align: 'center' });
      k.text('Months', L + labelW, y + 9.5, { size: 6, weight: 'semibold', color: BLACK, width: colW, align: 'center' });
    } else k.text(h, L + labelW + i * colW, y + 6, { size: 6, weight: 'semibold', color: BLACK, width: colW, align: 'center' });
  });
  y += 18;
  const months = data.months;
  const allSame = <T,>(pick: (m: F1095cMonth | null) => T): T | null => {
    const vals = months.map(pick);
    return vals.every((v) => v === vals[0]) ? vals[0] : null;
  };
  const money = (c: number | null) => (c === null ? '' : `$${(c / 100).toFixed(2)}`);
  const offerAll = allSame((m) => acaCode(m?.offerOfCoverage));
  const premiumAll = allSame((m) => m?.lowestPremiumCents ?? null);
  const shAll = allSame((m) => acaCode(m?.safeHarbor ?? ''));
  const rows = [
    { n: '14', label: 'Offer of Coverage (enter required code)', all: offerAll ?? '', cells: months.map((m) => (offerAll !== null ? '' : acaCode(m?.offerOfCoverage))) },
    { n: '15', label: 'Employee Required Contribution (see instructions)', all: premiumAll !== null ? money(premiumAll) : '', cells: months.map((m) => (premiumAll !== null ? '' : money(m?.lowestPremiumCents ?? null))) },
    { n: '16', label: 'Section 4980H Safe Harbor and Other Relief (enter code, if applicable)', all: shAll ?? '', cells: months.map((m) => (shAll !== null ? '' : acaCode(m?.safeHarbor ?? ''))) },
  ];
  for (const row of rows) {
    const rh = 30;
    k.doc.save().lineWidth(0.5).strokeColor(BLACK).rect(L, y, W, rh).stroke().restore();
    k.para(`${row.n}  ${row.label}`, L + 3, y + 3, labelW - 6, { size: 6.2, color: GREY });
    k.text(row.all, L + labelW, y + 11, { size: 8.5, weight: 'semibold', color: BLACK, width: colW, align: 'center' });
    row.cells.forEach((c, i) => k.text(c, L + labelW + (i + 1) * colW, y + 11, { size: 7.5, weight: 'semibold', color: BLACK, width: colW, align: 'center' }));
    for (let i = 0; i <= 13; i++) k.doc.save().lineWidth(0.4).strokeColor(BLACK).moveTo(L + labelW + i * colW, y).lineTo(L + labelW + i * colW, y + rh).stroke().restore();
    y += rh;
  }
  y += 10;
  k.text('Part III', L, y, { size: 8.5, weight: 'bold', color: BLACK });
  k.text('Covered Individuals — not completed: your employer does not sponsor self-insured coverage.', L + 40, y, { size: 8, color: BLACK, width: W - 40 });
  y += 24;

  // What it means, in plain English.
  k.text('What this form tells you', L, y, { size: SIZE.title, weight: 'semibold', color: BLACK });
  y += 18;
  const used = [...new Set(months.flatMap((m) => [acaCode(m?.offerOfCoverage), acaCode(m?.safeHarbor ?? '')]).filter(Boolean))];
  const fullTime = months.every((m) => m?.isFullTime) ? 'all 12 months' : months.map((m, i) => (m?.isFullTime ? MONTHS[i] : null)).filter(Boolean).join(', ') || 'no months on record';
  const lines = [
    'This form reports the health coverage your employer offered you. You do not attach it to your tax return; keep it with your tax records. If you or your family bought coverage through the Marketplace, it helps show whether you can claim the premium tax credit.',
    `Your employer counted you as full-time for ${fullTime}.`,
    ...used.map((c) => `Code ${c}: ${CODE_MEANING[c] ?? 'see the Instructions for Forms 1094-C and 1095-C at www.irs.gov/Form1095C.'}`),
    'Line 15 is the lowest monthly cost you would have paid for self-only coverage. Questions about this form go to the employer contact in line 10.',
  ];
  for (const l of lines) {
    y += k.para(l, L, y, W, { size: 7.8, color: BLACK }) + 5;
  }
  return k.finish({ reference: `Form 1095-C ${data.taxYear} · ${data.meta.formId.slice(0, 8).toUpperCase()}`, note: data.employer.name });
}
