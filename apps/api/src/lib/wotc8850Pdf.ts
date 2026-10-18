import PDFDocument from 'pdfkit';

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

const INK = '#1a2233';
const MUTED = '#5b6472';
const HAIR = '#b9c0cc';
const L = 48;
const R = 564;

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

function line(doc: PDFKit.PDFDocument, y: number) {
  doc.moveTo(L, y).lineTo(R, y).strokeColor(HAIR).lineWidth(0.6).stroke();
}

function field(doc: PDFKit.PDFDocument, x: number, y: number, w: number, label: string, value: string) {
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label, x, y, { width: w });
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(value || '—', x, y + 10, { width: w });
}

export async function render8850Pdf(d: F8850Data): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: L, info: { CreationDate: new Date(d.generatedAt), Title: 'Form 8850' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text('Form 8850', L, 44);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Pre-Screening Notice and Certification Request for the Work Opportunity Credit', L, 63);
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Department of the Treasury — Internal Revenue Service. Prepared by the employer’s HR system; file with the state workforce agency within 28 days of the start date.', L, 76, { width: R - L });
    line(doc, 98);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Job applicant', L, 108);
    const a = d.applicant;
    field(doc, L, 124, 250, 'Your name', a.name);
    field(doc, L + 260, 124, 120, 'Social security number', a.ssnLast4 ? `XXX-XX-${a.ssnLast4}` : '');
    field(doc, L + 390, 124, 120, 'Date of birth', a.dob ?? '');
    field(doc, L, 152, 250, 'Street address', a.addressLine1 ?? '');
    field(doc, L + 260, 152, 250, 'City, state and ZIP', [a.city, a.state, a.zip].filter(Boolean).join(', '));
    field(doc, L, 180, 250, 'Telephone', a.phone ?? '');
    line(doc, 206);

    let y = 214;
    if (d.declined) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('The applicant chose not to answer the screening questions.', L, y);
      y += 24;
    } else {
      for (const ln of LINES) {
        const checked = ln.keys.length > 0 && ln.keys.some((k) => d.answers[k] === 'yes') && (ln.n !== '3' || (d.answers.veteran === 'yes' && d.answers.snap === 'yes'));
        doc.rect(L, y + 1, 9, 9).strokeColor(INK).lineWidth(0.8).stroke();
        if (checked) doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('X', L + 1.5, y + 1);
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(ln.n, L + 16, y + 1);
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(ln.text, L + 28, y + 1, { width: R - L - 28 });
        y += Math.max(24, doc.heightOfString(ln.text, { width: R - L - 28 }) + 10);
      }
    }
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Under penalties of perjury, I declare that I gave the above information to the employer on or before the day I was offered a job, and it is, to the best of my knowledge, true, correct, and complete.', L, y, { width: R - L });
    y += 26;
    field(doc, L, y, 300, 'Job applicant’s signature (typed)', d.signedName ?? '');
    field(doc, L + 320, y, 190, 'Date signed', d.signedAt ? d.signedAt.slice(0, 10) : '');

    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('For employer’s use only', L, 48);
    line(doc, 68);
    const e = d.employer;
    field(doc, L, 78, 300, 'Employer’s name', e.name);
    field(doc, L + 320, 78, 190, 'Employer identification number (EIN)', e.ein ? `${e.ein.slice(0, 2)}-${e.ein.slice(2)}` : '');
    field(doc, L, 106, 300, 'Street address', e.addressLine1 ?? '');
    field(doc, L + 320, 106, 190, 'Telephone', e.phone ?? '');
    field(doc, L, 134, 300, 'City, state and ZIP', [e.city, e.state, e.zip].filter(Boolean).join(', '));
    line(doc, 162);
    field(doc, L, 172, 120, 'Gave information', d.signedAt ? d.signedAt.slice(0, 10) : '');
    field(doc, L + 130, 172, 120, 'Offered job', d.offerDate ?? '');
    field(doc, L + 260, 172, 120, 'Was hired', d.hireDate ?? '');
    field(doc, L + 390, 172, 120, 'Started job', d.startDate ?? '');
    field(doc, L, 200, 250, 'Position', d.position ?? '');
    field(doc, L + 260, 200, 250, 'Starting wage', d.startingWage !== null ? `$${d.startingWage.toFixed(2)} per hour` : '');
    field(doc, L, 228, R - L, 'Target groups indicated (ETA Form 9061)', d.targetGroups.join(', '));
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text('Under penalties of perjury, I declare that the applicant provided the information on this form on or before the day a job was offered to the applicant and that the information I have furnished is, to the best of my knowledge, true, correct, and complete.', L, 266, { width: R - L });
    doc.end();
  });
}
