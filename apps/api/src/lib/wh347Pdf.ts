import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { CertifiedWeek } from './certifiedPayroll.js';

/**
 * WH-347, the DOL's payroll form for federally financed construction
 * (OMB 1235-0008), as a landscape PDF: the payroll grid on the first
 * page(s) and the Statement of Compliance after it. Column order and
 * wording follow the form; CONFIRM WITH DOL WH-347 (current OMB revision)
 * before relying on the layout for an agency that checks it visually.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const money = (n: number | null | undefined) => (n === null || n === undefined ? '' : n.toFixed(2));
const hrs = (n: number) => (n ? n.toFixed(2).replace(/\.00$/, '') : '');

export interface Wh347Input {
  employer: { legalName: string; addressLine1: string | null; city: string | null; state: string | null; zip: string | null };
  project: { name: string; contractNumber: string | null; addressLine1: string | null; city: string | null; state: string | null };
  payrollNumber: number;
  isFinal: boolean;
  week: CertifiedWeek;
  statement: {
    signatureName: string | null;
    signerTitle: string | null;
    signedAt: Date | null;
    fringeStatement: 'PLANS' | 'CASH' | 'MIXED' | null;
    exceptionsText: string | null;
  };
}

export function hashWh347(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function renderWh347Pdf(input: Wh347Input): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 28, info: { Title: `WH-347 Payroll ${input.payrollNumber}`, Author: input.employer.legalName } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const width = R - L;
    const { week } = input;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('U.S. Department of Labor · Wage and Hour Division — PAYROLL (WH-347)', L, 28, { width });
      doc.font('Helvetica').fontSize(7).fillColor('#444').text('For contractor’s optional use; see instructions, form WH-347 Instr.  OMB No. 1235-0008', L, doc.y, { width });
      doc.fillColor('#000').fontSize(8);
      const y = doc.y + 4;
      const emp = [input.employer.legalName, input.employer.addressLine1, [input.employer.city, input.employer.state, input.employer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      doc.font('Helvetica-Bold').text('Name of contractor or subcontractor: ', L, y, { continued: true }).font('Helvetica').text(emp);
      doc.font('Helvetica-Bold').text(`Payroll no. `, L, doc.y, { continued: true }).font('Helvetica').text(`${input.payrollNumber}${input.isFinal ? ' (final)' : ''}      `, { continued: true });
      doc.font('Helvetica-Bold').text('For week ending ', { continued: true }).font('Helvetica').text(week.weekEnding);
      const loc = [input.project.name, input.project.addressLine1, [input.project.city, input.project.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
      doc.font('Helvetica-Bold').text('Project and location: ', L, doc.y, { continued: true }).font('Helvetica').text(loc, { continued: true });
      doc.font('Helvetica-Bold').text('      Project or contract no. ', { continued: true }).font('Helvetica').text(input.project.contractNumber ?? '—');
      return doc.y + 6;
    };

    // Column plan (points): name/id, class, O/S, 7 days, total, rate, gross (project/all), FICA, withholding, other, total ded, net.
    const cols = [
      { key: 'name', label: '(1) Name and identifying no.', w: 118 },
      { key: 'class', label: '(3) Work classification', w: 92 },
      { key: 'os', label: 'O/S', w: 20 },
      ...week.days.map((d, i) => ({ key: `d${i}`, label: `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}\n${d.slice(5)}`, w: 30 })),
      { key: 'total', label: '(5) Total hours', w: 34 },
      { key: 'rate', label: '(6) Rate of pay', w: 38 },
      { key: 'gross', label: '(7) Gross earned\nproject / all work', w: 74 },
      { key: 'fica', label: 'FICA', w: 38 },
      { key: 'wh', label: 'With-\nholding', w: 40 },
      { key: 'other', label: 'Other', w: 36 },
      { key: 'ded', label: 'Total\ndeductions', w: 42 },
      { key: 'net', label: '(9) Net wages\nfor week', w: 0 },
    ];
    const fixed = cols.reduce((a, c) => a + c.w, 0);
    cols[cols.length - 1]!.w = Math.max(44, width - fixed);
    const xs: number[] = [];
    cols.reduce((x, c) => {
      xs.push(x);
      return x + c.w;
    }, L);

    let y = header();
    const drawHead = () => {
      doc.font('Helvetica-Bold').fontSize(6.5);
      cols.forEach((c, i) => doc.text(c.label, xs[i]! + 2, y, { width: c.w - 4 }));
      y += 22;
      doc.moveTo(L, y).lineTo(R, y).strokeColor('#000').lineWidth(0.6).stroke();
      y += 3;
    };
    drawHead();
    doc.font('Helvetica').fontSize(7);
    for (const r of week.rows) {
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = header();
        drawHead();
        doc.font('Helvetica').fontSize(7);
      }
      const rowTop = y;
      const nameLine = `${r.name}${r.idLast4 ? `  ·  xxx-xx-${r.idLast4}` : ''}`;
      doc.text(nameLine, xs[0]! + 2, rowTop, { width: cols[0]!.w - 4 });
      doc.text(`${r.classification}${r.isApprentice ? `\nApprentice${r.apprenticeLevelPercent ? ` ${r.apprenticeLevelPercent}%` : ''}${r.apprenticeRegistration ? ` #${r.apprenticeRegistration}` : ''}` : ''}`, xs[1]! + 2, rowTop, { width: cols[1]!.w - 4 });
      // Two lines per worker: O (overtime) above S (straight time), as on the form.
      for (const [line, label, arr, total, rate] of [
        [0, 'O', r.overtime, r.totalOvertime, r.overtimeRate],
        [1, 'S', r.straight, r.totalStraight, r.rate],
      ] as const) {
        const ly = rowTop + line * 10;
        doc.text(label, xs[2]! + 2, ly, { width: cols[2]!.w - 4 });
        arr.forEach((h, i) => doc.text(hrs(h), xs[3 + i]! + 2, ly, { width: cols[3 + i]!.w - 4, align: 'right' }));
        doc.text(hrs(total), xs[10]! + 2, ly, { width: cols[10]!.w - 4, align: 'right' });
        doc.text(money(rate), xs[11]! + 2, ly, { width: cols[11]!.w - 4, align: 'right' });
      }
      doc.text(`${money(r.grossThisProject)}\n${money(r.grossAllWork)}`, xs[12]! + 2, rowTop, { width: cols[12]!.w - 4, align: 'right' });
      doc.text(money(r.deductions?.fica), xs[13]! + 2, rowTop, { width: cols[13]!.w - 4, align: 'right' });
      doc.text(money(r.deductions?.withholding), xs[14]! + 2, rowTop, { width: cols[14]!.w - 4, align: 'right' });
      doc.text(money(r.deductions?.other), xs[15]! + 2, rowTop, { width: cols[15]!.w - 4, align: 'right' });
      doc.text(money(r.deductions?.total), xs[16]! + 2, rowTop, { width: cols[16]!.w - 4, align: 'right' });
      doc.text(r.net === null ? 'not yet paid' : money(r.net), xs[17]! + 2, rowTop, { width: cols[17]!.w - 4, align: 'right' });
      y = rowTop + 24;
      doc.moveTo(L, y - 2).lineTo(R, y - 2).strokeColor('#bbb').lineWidth(0.3).stroke();
    }
    if (week.rows.length === 0) {
      doc.text('No covered work was performed on this project this week.', L, y);
      y += 14;
    }
    doc.font('Helvetica-Bold').fontSize(7.5).text(`Total hours ${week.totals.hours.toFixed(2)} · Gross for this project $${week.totals.grossThisProject.toFixed(2)} · ${week.totals.workers} worker${week.totals.workers === 1 ? '' : 's'}`, L, y + 4);

    // Statement of Compliance.
    doc.addPage();
    const s = input.statement;
    const start = (() => {
      const d = new Date(`${week.days[0]}T00:00:00Z`);
      return d.toISOString().slice(0, 10);
    })();
    doc.font('Helvetica-Bold').fontSize(12).text('Statement of Compliance', L, 32);
    doc.font('Helvetica').fontSize(9).moveDown(0.6);
    doc.text(`Date: ${s.signedAt ? s.signedAt.toISOString().slice(0, 10) : '__________'}`);
    doc.moveDown(0.4);
    doc.text(`I, ${s.signatureName ?? '____________________'}, ${s.signerTitle ?? '____________________'}, do hereby state:`);
    doc.moveDown(0.4);
    doc.text(`(1) That I pay or supervise the payment of the persons employed by ${input.employer.legalName} on the ${input.project.name}; that during the payroll period commencing on ${start} and ending on ${week.weekEnding}, all persons employed on said project have been paid the full weekly wages earned, that no rebates have been or will be made either directly or indirectly to or on behalf of said ${input.employer.legalName} from the full weekly wages earned by any person and that no deductions have been made either directly or indirectly from the full wages earned by any person, other than permissible deductions as defined in Regulations, Part 3 (29 CFR Subtitle A), issued by the Secretary of Labor under the Copeland Act, as amended (48 Stat. 948, 63 Stat. 108, 72 Stat. 967; 76 Stat. 357; 40 U.S.C. § 3145).`, { width });
    doc.moveDown(0.4);
    doc.text('(2) That any payrolls otherwise under this contract required to be submitted for the above period are correct and complete; that the wage rates for laborers or mechanics contained therein are not less than the applicable wage rates contained in any wage determination incorporated into the contract; that the classifications set forth therein for each laborer or mechanic conform with the work he or she performed.', { width });
    doc.moveDown(0.4);
    doc.text('(3) That any apprentices employed in the above period are duly registered in a bona fide apprenticeship program registered with a State apprenticeship agency recognized by the Office of Apprenticeship, U.S. Department of Labor, or if no such recognized agency exists in a State, are registered with the Office of Apprenticeship.', { width });
    doc.moveDown(0.4);
    doc.text('(4) That:', { width });
    const box = (on: boolean) => (on ? '[X]' : '[  ]');
    doc.text(`${box(s.fringeStatement === 'PLANS' || s.fringeStatement === 'MIXED')} (a) WHERE FRINGE BENEFITS ARE PAID TO APPROVED PLANS, FUNDS, OR PROGRAMS — in addition to the basic hourly wage rates paid to each laborer or mechanic listed in the above referenced payroll, payments of fringe benefits as listed in the contract have been or will be made to appropriate programs for the benefit of such employees, except as noted in section 4(c) below.`, { width });
    doc.moveDown(0.3);
    doc.text(`${box(s.fringeStatement === 'CASH' || s.fringeStatement === 'MIXED')} (b) WHERE FRINGE BENEFITS ARE PAID IN CASH — each laborer or mechanic listed in the above referenced payroll has been paid, as indicated on the payroll, an amount not less than the sum of the applicable basic hourly wage rate plus the amount of the required fringe benefits as listed in the contract, except as noted in section 4(c) below.`, { width });
    doc.moveDown(0.3);
    doc.text(`(c) EXCEPTIONS: ${s.exceptionsText?.trim() || 'None.'}`, { width });
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').text(`Name and title: ${[s.signatureName, s.signerTitle].filter(Boolean).join(', ') || '____________________'}`);
    doc.font('Helvetica').text(s.signedAt ? `Signed electronically by typing their name, ${s.signedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC` : 'Signature: ____________________');
    doc.moveDown(0.8);
    doc.fontSize(7.5).fillColor('#333').text('THE WILLFUL FALSIFICATION OF ANY OF THE ABOVE STATEMENTS MAY SUBJECT THE CONTRACTOR OR SUBCONTRACTOR TO CIVIL OR CRIMINAL PROSECUTION. SEE SECTION 1001 OF TITLE 18 AND SECTION 3729 OF TITLE 31 OF THE UNITED STATES CODE.', { width });
    doc.end();
  });
}
