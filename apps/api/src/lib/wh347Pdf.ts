import { createDoc, fmt } from './docKit/index.js';
import { checkbox, formBox } from './taxFormKit.js';
import { createHash } from 'node:crypto';
import type { CertifiedWeek } from './certifiedPayroll.js';

/**
 * WH-347, the DOL's payroll form for federally financed construction
 * (OMB 1235-0008), as a landscape PDF: the payroll grid on the first
 * page(s) and the Statement of Compliance after it. Column order and
 * wording follow the form, set in the house typeface in black ink; CONFIRM
 * WITH DOL WH-347 (current OMB revision) before relying on the layout for
 * an agency that checks it visually.
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
  const { k } = createDoc({ title: `WH-347 Payroll ${input.payrollNumber}`, author: input.employer.legalName, layout: 'landscape', margin: 28 });
  const doc = k.doc;
  const L = k.L;
  const width = k.width();
  const R = L + width;
  const { week } = input;
  const ink = '#000000';
  const grey = '#4D4D4D';

  const header = (): number => {
    let y = 28;
    k.text('U.S. Department of Labor', L, y, { size: 7, color: grey });
    k.text('Wage and Hour Division', L, y + 9, { size: 7, color: grey });
    k.text('PAYROLL', L + width / 2 - 100, y, { size: 15, weight: 'bold', color: ink, width: 200, align: 'center' });
    k.text('(For Contractor\u2019s Optional Use; See Instructions, Form WH-347 Instr.)', L + width / 2 - 170, y + 17, { size: 6.5, color: grey, width: 340, align: 'center' });
    k.text('OMB No. 1235-0008', R - 160, y, { size: 6.5, color: grey, width: 160, align: 'right' });
    k.text('Form WH-347', R - 160, y + 9, { size: 7, weight: 'semibold', color: ink, width: 160, align: 'right' });
    y += 30;
    const emp = [input.employer.legalName, input.employer.addressLine1, [[input.employer.city, input.employer.state].filter(Boolean).join(', '), input.employer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const loc = [input.project.name, input.project.addressLine1, [input.project.city, input.project.state].filter(Boolean).join(', ')].filter(Boolean).join(' \u2014 ');
    formBox(k, L, y, width * 0.5, 24, 'Name of contractor or subcontractor and address', emp, { valueSize: 8.5 });
    formBox(k, L + width * 0.5, y, width * 0.14, 24, 'Payroll no.', `${input.payrollNumber}${input.isFinal ? ' (final)' : ''}`, { valueSize: 8.5 });
    formBox(k, L + width * 0.64, y, width * 0.16, 24, 'For week ending', fmt.date(week.weekEnding), { valueSize: 8.5 });
    formBox(k, L + width * 0.8, y, width * 0.2, 24, 'Project or contract no.', input.project.contractNumber ?? '\u2014', { valueSize: 8.5 });
    y += 24;
    formBox(k, L, y, width, 22, 'Project and location', loc, { valueSize: 8.5 });
    return y + 28;
  };

  // Column plan (points): name/id, class, O/S, 7 days, total, rate, gross (project/all), FICA, withholding, other, total ded, net.
  const cols = [
    { key: 'name', label: '(1) Name and individual identifying number', w: 118 },
    { key: 'class', label: '(3) Work classification', w: 92 },
    { key: 'os', label: 'OT or ST', w: 22 },
    ...week.days.map((d) => ({ key: d, label: `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}|${d.slice(5).replace('-', '/')}`, w: 30 })),
    { key: 'total', label: '(5) Total hours', w: 34 },
    { key: 'rate', label: '(6) Rate of pay', w: 38 },
    { key: 'gross', label: '(7) Gross earned|this project / all work', w: 74 },
    { key: 'fica', label: '(8) Deductions|FICA', w: 38 },
    { key: 'wh', label: 'Withholding', w: 42 },
    { key: 'other', label: 'Other', w: 36 },
    { key: 'ded', label: 'Total deductions', w: 44 },
    { key: 'net', label: '(9) Net wages paid for week', w: 0 },
  ];
  // Net wages gets a fair width, then every column scales to the page.
  cols[cols.length - 1]!.w = 52;
  const planned = cols.reduce((a, c) => a + c.w, 0);
  for (const c of cols) c.w = (c.w * width) / planned;
  const xs: number[] = [];
  cols.reduce((x, c) => {
    xs.push(x);
    return x + c.w;
  }, L);

  let y = header();
  const HEAD_H = 34;
  const drawHead = () => {
    doc.save().rect(L, y, width, HEAD_H).lineWidth(0.6).strokeColor(ink).stroke().restore();
    cols.forEach((c, i) => {
      const [a, b] = c.label.split('|');
      const h = k.para(a!, xs[i]! + 2, y + 3, c.w - 4, { size: 5.6, weight: 'semibold', color: ink });
      if (b) k.para(b, xs[i]! + 2, y + 3 + h, c.w - 4, { size: 5.6, color: grey });
      if (i > 0) doc.save().moveTo(xs[i]!, y).lineTo(xs[i]!, y + HEAD_H).lineWidth(0.4).strokeColor(ink).stroke().restore();
    });
    y += HEAD_H;
  };
  drawHead();
    for (const r of week.rows) {
    if (y + 26 > k.bottom()) {
      doc.addPage();
      y = header();
      drawHead();
    }
    const rowTop = y;
    k.text(r.name, xs[0]! + 3, rowTop + 3, { size: 7.5, weight: 'semibold', color: ink, width: cols[0]!.w - 6 });
    if (r.idLast4) k.text(`xxx-xx-${r.idLast4}`, xs[0]! + 3, rowTop + 13, { size: 6.5, color: grey, width: cols[0]!.w - 6 });
    k.text(r.classification, xs[1]! + 3, rowTop + 3, { size: 7, color: ink, width: cols[1]!.w - 6 });
    if (r.isApprentice) k.text(`Apprentice${r.apprenticeLevelPercent ? ` ${r.apprenticeLevelPercent}%` : ''}${r.apprenticeRegistration ? ` #${r.apprenticeRegistration}` : ''}`, xs[1]! + 3, rowTop + 13, { size: 6, color: grey, width: cols[1]!.w - 6 });
    // Two lines per worker: OT above ST, as on the form.
    for (const [line, label, arr, total, rate] of [
      [0, 'OT', r.overtime, r.totalOvertime, r.overtimeRate],
      [1, 'ST', r.straight, r.totalStraight, r.rate],
    ] as const) {
      const ly = rowTop + 3 + line * 11;
      k.text(label, xs[2]! + 3, ly, { size: 6.5, color: grey, width: cols[2]!.w - 4 });
      arr.forEach((h, i) => k.text(hrs(h), xs[3 + i]! + 2, ly, { size: 7, color: ink, width: cols[3 + i]!.w - 4, align: 'right' }));
      k.text(hrs(total), xs[10]! + 2, ly, { size: 7, color: ink, width: cols[10]!.w - 4, align: 'right' });
      k.text(money(rate), xs[11]! + 2, ly, { size: 7, color: ink, width: cols[11]!.w - 4, align: 'right' });
    }
    k.text(money(r.grossThisProject), xs[12]! + 2, rowTop + 3, { size: 7, weight: 'semibold', color: ink, width: cols[12]!.w - 4, align: 'right' });
    k.text(money(r.grossAllWork), xs[12]! + 2, rowTop + 14, { size: 7, color: grey, width: cols[12]!.w - 4, align: 'right' });
    k.text(money(r.deductions?.fica), xs[13]! + 2, rowTop + 3, { size: 7, color: ink, width: cols[13]!.w - 4, align: 'right' });
    k.text(money(r.deductions?.withholding), xs[14]! + 2, rowTop + 3, { size: 7, color: ink, width: cols[14]!.w - 4, align: 'right' });
    k.text(money(r.deductions?.other), xs[15]! + 2, rowTop + 3, { size: 7, color: ink, width: cols[15]!.w - 4, align: 'right' });
    k.text(money(r.deductions?.total), xs[16]! + 2, rowTop + 3, { size: 7, color: ink, width: cols[16]!.w - 4, align: 'right' });
    k.text(r.net === null ? 'not yet paid' : money(r.net), xs[17]! + 2, rowTop + 3, { size: 7, weight: 'semibold', color: ink, width: cols[17]!.w - 4, align: 'right' });
    y = rowTop + 26;
    doc.save().rect(L, rowTop, width, 26).lineWidth(0.4).strokeColor(ink).stroke().restore();
    cols.forEach((_, i) => i > 0 && doc.save().moveTo(xs[i]!, rowTop).lineTo(xs[i]!, y).lineWidth(0.3).strokeColor('#8C8C8C').stroke().restore());
  }
  if (week.rows.length === 0) {
    k.text('No covered work was performed on this project this week.', L + 4, y + 6, { size: 8, color: ink });
    y += 20;
  }
  k.text(`Total hours ${week.totals.hours.toFixed(2)}  \u00b7  Gross earned on this project $${week.totals.grossThisProject.toFixed(2)}  \u00b7  ${week.totals.workers} worker${week.totals.workers === 1 ? '' : 's'}`, L, y + 6, { size: 7.5, weight: 'semibold', color: ink });

  // Statement of Compliance.
  doc.addPage();
  const s = input.statement;
  const start = week.days[0]!;
  let sy = k.top;
  k.text('Statement of Compliance', L, sy, { size: 14, weight: 'bold', color: ink });
  k.text(`Form WH-347 \u00b7 Payroll no. ${input.payrollNumber} \u00b7 week ending ${fmt.date(week.weekEnding)}`, L, sy + 3, { size: 7.5, color: grey, width, align: 'right' });
  sy += 24;
  const para = (t: string, size = 8.6) => {
    sy += k.para(t, L, sy, width, { size, color: ink }) + 7;
  };
  para(`Date: ${s.signedAt ? fmt.date(s.signedAt) : '__________'}`);
  para(`I, ${s.signatureName ?? '____________________'}, ${s.signerTitle ?? '____________________'}, do hereby state:`);
  para(`(1) That I pay or supervise the payment of the persons employed by ${input.employer.legalName} on the ${input.project.name}; that during the payroll period commencing on ${fmt.date(start)} and ending on ${fmt.date(week.weekEnding)}, all persons employed on said project have been paid the full weekly wages earned, that no rebates have been or will be made either directly or indirectly to or on behalf of said ${input.employer.legalName} from the full weekly wages earned by any person and that no deductions have been made either directly or indirectly from the full wages earned by any person, other than permissible deductions as defined in Regulations, Part 3 (29 CFR Subtitle A), issued by the Secretary of Labor under the Copeland Act, as amended (48 Stat. 948, 63 Stat. 108, 72 Stat. 967; 76 Stat. 357; 40 U.S.C. \u00a7 3145).`);
  para('(2) That any payrolls otherwise under this contract required to be submitted for the above period are correct and complete; that the wage rates for laborers or mechanics contained therein are not less than the applicable wage rates contained in any wage determination incorporated into the contract; that the classifications set forth therein for each laborer or mechanic conform with the work he or she performed.');
  para('(3) That any apprentices employed in the above period are duly registered in a bona fide apprenticeship program registered with a State apprenticeship agency recognized by the Office of Apprenticeship, U.S. Department of Labor, or if no such recognized agency exists in a State, are registered with the Office of Apprenticeship.');
  para('(4) That:');
  const check = (on: boolean, t: string) => {
    checkbox(k, L + 4, sy + 1, '', on, 7);
    sy += k.para(t, L + 20, sy, width - 20, { size: 8.6, color: ink }) + 6;
  };
  check(s.fringeStatement === 'PLANS' || s.fringeStatement === 'MIXED', '(a) WHERE FRINGE BENEFITS ARE PAID TO APPROVED PLANS, FUNDS, OR PROGRAMS \u2014 in addition to the basic hourly wage rates paid to each laborer or mechanic listed in the above referenced payroll, payments of fringe benefits as listed in the contract have been or will be made to appropriate programs for the benefit of such employees, except as noted in section 4(c) below.');
  check(s.fringeStatement === 'CASH' || s.fringeStatement === 'MIXED', '(b) WHERE FRINGE BENEFITS ARE PAID IN CASH \u2014 each laborer or mechanic listed in the above referenced payroll has been paid, as indicated on the payroll, an amount not less than the sum of the applicable basic hourly wage rate plus the amount of the required fringe benefits as listed in the contract, except as noted in section 4(c) below.');
  para(`(c) EXCEPTIONS: ${s.exceptionsText?.trim() || 'None.'}`);
  sy += 10;
  formBox(k, L, sy, width * 0.5, 30, 'Name and title', [s.signatureName, s.signerTitle].filter(Boolean).join(', '), { valueSize: 9.5 });
  formBox(k, L + width * 0.5, sy, width * 0.5, 30, 'Signature', s.signedAt ? `Signed electronically by typing their name \u00b7 ${fmt.dateTime(s.signedAt)}` : '', { valueSize: 8.5 });
  sy += 40;
  k.para('THE WILLFUL FALSIFICATION OF ANY OF THE ABOVE STATEMENTS MAY SUBJECT THE CONTRACTOR OR SUBCONTRACTOR TO CIVIL OR CRIMINAL PROSECUTION. SEE SECTION 1001 OF TITLE 18 AND SECTION 3729 OF TITLE 31 OF THE UNITED STATES CODE.', L, sy, width, { size: 7.5, weight: 'semibold', color: ink });
  return k.finish({ reference: `WH-347 \u00b7 ${input.project.name} \u00b7 payroll ${input.payrollNumber}`, note: input.employer.legalName });
}
