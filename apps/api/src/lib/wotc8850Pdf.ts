import { createDoc, fmt } from './docKit/index.js';
import { BLACK, GREY, checkbox, formBox } from './taxFormKit.js';

/**
 * IRS Form 8850 (Pre-Screening Notice and Certification Request for the
 * Work Opportunity Credit), laid out in the form's order — page 1 the job
 * applicant's statements and signature, page 2 the employer's section —
 * so whoever files it on the state portal finds each answer where the
 * official form asks for it. Deterministic bytes (creation date pinned).
 */

export interface F8850Data {
  applicant: { name: string; ssnLast4: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; dob: string | null; phone: string | null };
  answers: Record<string, 'yes' | 'no' | 'unsure' | undefined>;
  declined: boolean;
  signedName: string | null;
  signedAt: string | null;
  employer: { name: string; ein: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null };
  offerDate: string | null;
  hireDate: string | null;
  startDate: string | null;
  startingWage: number | null;
  position: string | null;
  targetGroups: string[];
  generatedAt: string;
}

/** Form 8850 lines 1–7 mapped to the screening's questions. */
const LINES: Array<{ n: string; text: string; keys: string[] }> = [
  { n: '1', text: 'Check here if you received a conditional certification from the state workforce agency or a participating local agency.', keys: [] },
  { n: '2', text: 'Check here if any of the following statements apply to you (SNAP recipient 18–39; vocational rehabilitation referral; ex-felon; SSI; summer youth; designated community resident).', keys: ['snap', 'vocRehab', 'felony', 'ssi'] },
  { n: '3', text: 'Check here if you are a veteran and a member of a family that received SNAP for at least 3 months during the past 15 months.', keys: ['veteran', 'snap'] },
  { n: '4', text: 'Check here if you are a veteran entitled to compensation for a service-connected disability and discharged in the past year, or unemployed 6 months or more in the past year.', keys: ['vetDisability', 'vetDischargedLastYear', 'vetUnemployed6m'] },
  { n: '5', text: 'Check here if you are a veteran unemployed for at least 4 weeks (but less than 6 months), or at least 6 months, in the past year.', keys: ['vetUnemployed4w', 'vetUnemployed6m'] },
  { n: '6', text: 'Check here if you are a member of a family that received TANF for any 9 months during the past 18 months, or long-term family assistance.', keys: ['tanf9', 'tanf18'] },
  { n: '7', text: 'Check here if you are unemployed for a period of at least 27 consecutive weeks and received unemployment compensation during some or all of the period.', keys: ['longTermUnemployed'] },
];

export async function render8850Pdf(d: F8850Data): Promise<Buffer> {
  const { k } = createDoc({ title: `Form 8850 · ${d.applicant.name}`, author: d.employer.name, margin: 40, creationDate: new Date(d.generatedAt) });
  const L = 40;
  const W = 532;
  const ink = BLACK;
  const date = (v: string | null) => (v ? fmt.date(v.slice(0, 10)) : '');
  const title = (y: number, page: 1 | 2): number => {
    k.text('Form', L, y + 6, { size: 7, color: ink });
    k.text('8850', L + 20, y, { size: 18, weight: 'bold', color: ink });
    k.text('Pre-Screening Notice and Certification Request for the Work Opportunity Credit', L + 72, y + 2, { size: 9.5, weight: 'semibold', color: ink, width: W - 180 });
    k.text('Department of the Treasury · Internal Revenue Service', L + 72, y + 15, { size: 6.5, color: GREY });
    k.text('OMB No. 1545-1500', L + W - 110, y + 2, { size: 6.5, color: GREY, width: 110, align: 'right' });
    k.text(`Page ${page}`, L + W - 110, y + 12, { size: 6.5, color: GREY, width: 110, align: 'right' });
    k.hr(y + 30, L, W, ink, 1.2);
    return y + 40;
  };

  let y = title(40, 1);
  k.text('Job applicant: Fill in the lines below and check any boxes that apply. Complete only this side.', L, y, { size: 8, weight: 'semibold', color: ink, width: W });
  y += 14;
  const a = d.applicant;
  formBox(k, L, y, W * 0.5, 26, 'Your name', a.name);
  formBox(k, L + W * 0.5, y, W * 0.25, 26, 'Social security number', a.ssnLast4 ? `XXX-XX-${a.ssnLast4}` : '');
  formBox(k, L + W * 0.75, y, W * 0.25, 26, 'Date of birth (if under age 40)', date(a.dob));
  y += 26;
  formBox(k, L, y, W * 0.5, 26, 'Street address where you live', a.addressLine1 ?? '');
  formBox(k, L + W * 0.5, y, W * 0.5, 26, 'City or town, state, and ZIP code', [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' '));
  y += 26;
  formBox(k, L, y, W * 0.5, 26, 'Telephone number', a.phone ?? '');
  y += 36;

  if (d.declined) {
    y = k.callout({ tone: 'neutral', body: 'The applicant chose not to answer the screening questions.' }, y);
  } else {
    for (const ln of LINES) {
      const checked = ln.keys.length > 0 && ln.keys.some((key) => d.answers[key] === 'yes') && (ln.n !== '3' || (d.answers.veteran === 'yes' && d.answers.snap === 'yes'));
      const h = k.para(ln.text, 0, 0, W - 32, { size: 8 }, false);
      checkbox(k, L, y + 1, '', checked, 8);
      k.text(ln.n, L + 15, y + 0.5, { size: 8, weight: 'bold', color: ink });
      k.para(ln.text, L + 28, y, W - 32, { size: 8, color: ink });
      y += Math.max(18, h + 8);
    }
  }
  y += 6;
  y += k.para('Under penalties of perjury, I declare that I gave the above information to the employer on or before the day I was offered a job, and it is, to the best of my knowledge, true, correct, and complete.', L, y, W, { size: 7.5, color: ink }) + 8;
  formBox(k, L, y, W * 0.66, 30, "Job applicant's signature", d.signedName ? `${d.signedName} (signed electronically)` : '');
  formBox(k, L + W * 0.66, y, W * 0.34, 30, 'Date', date(d.signedAt));

  k.doc.addPage();
  y = title(40, 2);
  k.text("For Employer's Use Only", L, y, { size: 10, weight: 'bold', color: ink });
  y += 16;
  const e = d.employer;
  formBox(k, L, y, W * 0.6, 26, "Employer's name", e.name);
  formBox(k, L + W * 0.6, y, W * 0.4, 26, 'Employer identification number (EIN)', e.ein ? fmt.ein(e.ein) : '');
  y += 26;
  formBox(k, L, y, W * 0.6, 26, 'Street address', e.addressLine1 ?? '');
  formBox(k, L + W * 0.6, y, W * 0.4, 26, 'Telephone number', e.phone ?? '');
  y += 26;
  formBox(k, L, y, W, 26, 'City or town, state, and ZIP code', [[e.city, e.state].filter(Boolean).join(', '), e.zip].filter(Boolean).join(' '));
  y += 36;
  const dates: Array<[string, string]> = [['Gave information', date(d.signedAt)], ['Was offered job', date(d.offerDate)], ['Was hired', date(d.hireDate)], ['Started job', date(d.startDate)]];
  dates.forEach(([label, v], i) => formBox(k, L + (W / 4) * i, y, W / 4, 26, label, v));
  y += 26;
  formBox(k, L, y, W * 0.5, 26, 'Position', d.position ?? '');
  formBox(k, L + W * 0.5, y, W * 0.5, 26, 'Starting wage', d.startingWage !== null ? `${fmt.money(d.startingWage)} per hour` : '');
  y += 26;
  formBox(k, L, y, W, 26, 'Target groups indicated (ETA Form 9061)', d.targetGroups.join(', '));
  y += 36;
  k.para('Under penalties of perjury, I declare that the applicant provided the information on this form on or before the day a job was offered to the applicant and that the information I have furnished is, to the best of my knowledge, true, correct, and complete. Based on the information the job applicant furnished on page 1, I believe the individual is a member of a targeted group. I hereby request a certification that the individual is a member of a targeted group.', L, y, W, { size: 7.5, color: ink });
  y += 52;
  formBox(k, L, y, W * 0.5, 30, "Employer's signature", '');
  formBox(k, L + W * 0.5, y, W * 0.3, 30, 'Title', '');
  formBox(k, L + W * 0.8, y, W * 0.2, 30, 'Date', '');
  y += 44;
  k.callout({ tone: 'info', title: 'Filing', body: 'File this form with your state workforce agency within 28 calendar days of the date the employee started work, with ETA Form 9061 (or 9062 for a conditional certification).' }, y, L, W);
  return k.finish({ reference: `Form 8850 · ${d.applicant.name}`, note: d.employer.name });
}
