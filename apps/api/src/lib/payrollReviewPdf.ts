import PDFDocument from 'pdfkit';
import { FLAG_LABEL, type PayrollReviewReport, type ReviewState } from './payrollReview.js';

/**
 * The pre-payroll review as a PDF an accountant reads, prints or files:
 * landscape letter, a summary up front (totals, cash needed, taxes owed,
 * the comparison with last payroll), the paychecks worth a second look,
 * totals by department and state, then the full register with a totals
 * row. It ends with the sign-off, or signature lines when there is none
 * yet, and the version (fingerprint) the numbers belong to.
 */

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#D1D5DB';
const BAND = '#F3F4F6';
const ALERT = '#B42318';
const OK = '#027A48';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const hours = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });

const KIND_LABEL: Record<string, string> = { REGULAR: 'Regular', OFF_CYCLE: 'Off-cycle', AMENDMENT: 'Amendment', DAILY: 'Daily pay', MANUAL: 'Manual check' };
const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', FINALIZED: 'Finalized', DISBURSED: 'Paid', CANCELLED: 'Voided' };

export function renderPayrollReviewPdf(report: PayrollReviewReport, signoff: ReviewState): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `Payroll review ${report.run.periodStart} to ${report.run.periodEnd}`, Author: report.company } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 36;
    const R = doc.page.width - 36;
    const W = R - L;
    const bottom = () => doc.page.height - 54;
    const ensure = (h: number) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    const rule = (y = doc.y, color = LINE) => doc.moveTo(L, y).lineTo(R, y).strokeColor(color).lineWidth(0.5).stroke();
    const heading = (text: string) => {
      ensure(40);
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).fillColor(INK).text(text, L, doc.y);
      doc.moveDown(0.25);
      rule();
      doc.moveDown(0.35);
    };

    // ---- Letterhead
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text('Pre-payroll review', L, 36);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(report.company, L, doc.y + 2);
    const meta = [
      `Pay period ${date(report.run.periodStart)} – ${date(report.run.periodEnd)}`,
      report.run.clientName ?? 'All clients',
      `${KIND_LABEL[report.run.kind] ?? report.run.kind} run · ${STATUS_LABEL[report.run.status] ?? report.run.status}`,
    ].join('   ·   ');
    doc.fillColor(INK).fontSize(10).text(meta, L, doc.y + 4);
    doc.fillColor(MUTED).fontSize(8).text(`Prepared ${dateTime(report.generatedAt)}${report.run.createdByName ? ` · run created by ${report.run.createdByName}` : ''} · version ${report.fingerprint.slice(0, 12)}`, L, doc.y + 2);

    // Sign-off banner
    doc.moveDown(0.6);
    const bannerY = doc.y;
    const signed = signoff.current;
    const bannerColor = signed ? OK : signoff.stale ? ALERT : MUTED;
    const bannerText = signed
      ? `Signed off by ${signed.signedByName ?? 'a reviewer'} on ${dateTime(signed.signedAt)}${signed.soleReviewer ? ' (the only person who processes payroll)' : ''}.`
      : signoff.stale
        ? `Not signed: the numbers changed after ${signoff.stale.signedByName ?? 'the reviewer'} signed off on ${dateTime(signoff.stale.signedAt)}.`
        : signoff.required
          ? 'Not signed off yet. This run cannot pay out until someone reviews these numbers and signs.'
          : 'Sign-off is optional for this run.';
    doc.rect(L, bannerY, W, 22).fillColor(signed ? '#ECFDF3' : signoff.stale ? '#FEF3F2' : BAND).fill();
    doc.fillColor(bannerColor).font('Helvetica-Bold').fontSize(9).text(bannerText, L + 8, bannerY + 7, { width: W - 16 });
    doc.y = bannerY + 30;

    // ---- Summary tiles
    const t = report.totals;
    const tiles: Array<[string, string, string]> = [
      ['People paid', String(t.people), t.contractors ? `${t.contractors} contractor${t.contractors === 1 ? '' : 's'}` : `${hours(t.hours)} hours`],
      ['Gross pay', money(t.gross), report.previous ? delta(t.gross, report.previous.gross) : 'No earlier run'],
      ['Net pay', money(t.net), report.previous ? delta(t.net, report.previous.net) : 'No earlier run'],
      ['Employer taxes', money(t.employerTaxes), `Employer cost ${money(t.employerCost)}`],
      ['Cash required', money(report.cash.total), 'Leaves the bank for this run'],
    ];
    const tileW = (W - 4 * 8) / 5;
    const tileY = doc.y;
    tiles.forEach(([label, value, hint], i) => {
      const x = L + i * (tileW + 8);
      doc.roundedRect(x, tileY, tileW, 52, 4).strokeColor(LINE).lineWidth(0.75).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x + 8, tileY + 7, { width: tileW - 16, characterSpacing: 0.6 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(value, x + 8, tileY + 18, { width: tileW - 16 });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(hint, x + 8, tileY + 37, { width: tileW - 16 });
    });
    doc.y = tileY + 60;

    // ---- Cash and taxes, side by side
    const colW = (W - 16) / 2;
    const top = doc.y + 6;
    const twoCol = (x: number, title: string, lines: Array<{ label: string; amount: number }>, totalLabel: string, total: number) => {
      let y = top;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(title, x, y);
      y += 15;
      doc.moveTo(x, y).lineTo(x + colW, y).strokeColor(LINE).lineWidth(0.5).stroke();
      y += 4;
      for (const l of lines) {
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(l.label, x, y, { width: colW - 90 });
        doc.text(money(l.amount), x + colW - 90, y, { width: 90, align: 'right' });
        y += 13;
      }
      doc.moveTo(x, y).lineTo(x + colW, y).strokeColor(INK).lineWidth(0.5).stroke();
      y += 4;
      doc.font('Helvetica-Bold').fontSize(9).text(totalLabel, x, y, { width: colW - 90 });
      doc.text(money(total), x + colW - 90, y, { width: 90, align: 'right' });
      return y + 14;
    };
    const yCash = twoCol(L, 'Cash required', report.cash.lines, 'Total cash required', report.cash.total);
    const taxLines = [
      ...report.taxes.employee.map((x) => ({ label: `${x.label} (withheld)`, amount: x.amount })),
      ...report.taxes.employer.map((x) => ({ label: x.label, amount: x.amount })),
    ];
    const yTax = twoCol(L + colW + 16, 'Taxes owed for this run', taxLines, 'Total taxes', report.taxes.total);
    doc.y = Math.max(yCash, yTax);

    // ---- Comparison with last payroll
    if (report.previous) {
      heading(`Compared with the last payroll (${date(report.previous.periodStart)} – ${date(report.previous.periodEnd)})`);
      const rows: Array<[string, string, string, string]> = [
        ['People paid', String(report.previous.people), String(t.people), signed0(t.people - report.previous.people)],
        ['Gross pay', money(report.previous.gross), money(t.gross), delta(t.gross, report.previous.gross)],
        ['Net pay', money(report.previous.net), money(t.net), delta(t.net, report.previous.net)],
        ['Employer taxes', money(report.previous.employerTaxes), money(t.employerTaxes), delta(t.employerTaxes, report.previous.employerTaxes)],
      ];
      const cx = [L, L + 200, L + 340, L + 480];
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
      ['', 'Last payroll', 'This payroll', 'Change'].forEach((h, i) => doc.text(h, cx[i], doc.y, { width: 130, align: i ? 'right' : 'left', lineBreak: false }));
      doc.moveDown(0.9);
      for (const r of rows) {
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor(INK);
        r.forEach((v, i) => doc.text(v, cx[i], y, { width: 130, align: i ? 'right' : 'left', lineBreak: false }));
        doc.y = y + 13;
      }
    }

    // ---- Paychecks worth a second look
    const flagged = report.rows.filter((r) => r.flags.length > 0);
    heading(flagged.length ? `Paychecks to look at (${flagged.length})` : 'Paychecks to look at');
    if (!flagged.length) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Nothing unusual: no first paychecks, no sharp swings since last payroll, and every W-2 check withholds tax.', L, doc.y);
    } else {
      const fx = { name: L, why: L + 170, last: L + 470, now: L + 560, chg: L + 640 };
      const head = () => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
        const y = doc.y;
        doc.text('Person', fx.name, y, { lineBreak: false });
        doc.text('Why', fx.why, y, { lineBreak: false });
        doc.text('Last net', fx.last, y, { width: 80, align: 'right', lineBreak: false });
        doc.text('This net', fx.now, y, { width: 70, align: 'right', lineBreak: false });
        doc.text('Change', fx.chg, y, { width: R - fx.chg, align: 'right', lineBreak: false });
        doc.y = y + 12;
      };
      head();
      for (const r of flagged) {
        if (doc.y + 13 > bottom()) {
          doc.addPage();
          head();
        }
        const y = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(INK);
        doc.text(r.name, fx.name, y, { width: 165, lineBreak: false, ellipsis: true });
        doc.fillColor(r.flags.includes('ZERO_NET') || r.flags.includes('NO_FICA') ? ALERT : INK).text(r.flags.map((f) => FLAG_LABEL[f]).join(', '), fx.why, y, { width: 295, lineBreak: false, ellipsis: true });
        doc.fillColor(INK);
        doc.text(r.prior ? money(r.prior.net) : '—', fx.last, y, { width: 80, align: 'right', lineBreak: false });
        doc.text(money(r.net), fx.now, y, { width: 70, align: 'right', lineBreak: false });
        doc.text(r.netChange == null ? '—' : signedMoney(r.netChange), fx.chg, y, { width: R - fx.chg, align: 'right', lineBreak: false });
        doc.y = y + 13;
      }
    }

    // ---- Totals by department and by state
    const groups = (title: string, rows: PayrollReviewReport['byDepartment']) => {
      heading(title);
      const gx = [L, L + 260, L + 340, L + 470, L + 600];
      const head = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
        ['', 'People', 'Gross', 'Net', 'Employer taxes'].forEach((h, i) => doc.text(h, gx[i], y, { width: i ? 110 : 250, align: i ? 'right' : 'left', lineBreak: false }));
        doc.y = y + 12;
      };
      head();
      for (const g of rows) {
        if (doc.y + 13 > bottom()) {
          doc.addPage();
          head();
        }
        const y = doc.y;
        doc.font('Helvetica').fontSize(9).fillColor(INK);
        [g.name, String(g.people), money(g.gross), money(g.net), money(g.employerTaxes)].forEach((v, i) =>
          doc.text(v, gx[i], y, { width: i ? 110 : 250, align: i ? 'right' : 'left', lineBreak: false, ellipsis: true }),
        );
        doc.y = y + 13;
      }
    };
    groups('By department', report.byDepartment);
    groups('By work state', report.byState);

    // ---- The register
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('Payroll register', L, 36);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('Gross + reimbursements − taxes − deductions − other = net, on every row.', L, doc.y + 2);
    doc.moveDown(0.6);
    const cols: Array<{ h: string; w: number; v: (r: PayrollReviewReport['rows'][number]) => string; left?: boolean }> = [
      { h: 'Person', w: 112, v: (r) => r.name, left: true },
      { h: 'St', w: 20, v: (r) => r.state ?? '', left: true },
      { h: 'Hours', w: 38, v: (r) => hours(r.hours) },
      { h: 'Gross', w: 52, v: (r) => money(r.gross) },
      { h: 'Pre-tax', w: 44, v: (r) => money(r.preTax) },
      { h: 'Federal', w: 44, v: (r) => money(r.federal) },
      { h: 'Soc. Sec.', w: 44, v: (r) => money(r.socialSecurity) },
      { h: 'Medicare', w: 42, v: (r) => money(r.medicare) },
      { h: 'State', w: 42, v: (r) => money(r.stateTax) },
      { h: 'Local', w: 36, v: (r) => money(r.localTax) },
      { h: 'Post-tax', w: 44, v: (r) => money(r.postTax) },
      { h: 'Other', w: 40, v: (r) => money(r.other) },
      { h: 'Reimb.', w: 40, v: (r) => money(r.reimbursements) },
      { h: 'Net', w: 52, v: (r) => money(r.net) },
      { h: 'Employer tax', w: 70, v: (r) => money(r.employerTaxes) },
    ];
    const scale = W / cols.reduce((s, c) => s + c.w, 0);
    for (const c of cols) c.w = c.w * scale;
    const regHead = () => {
      const y = doc.y;
      doc.rect(L, y - 2, W, 14).fillColor(BAND).fill();
      let x = L;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
      for (const c of cols) {
        doc.text(c.h, x + 2, y + 1, { width: c.w - 4, align: c.left ? 'left' : 'right', lineBreak: false });
        x += c.w;
      }
      doc.y = y + 15;
    };
    regHead();
    const byName = [...report.rows].sort((a, b) => a.name.localeCompare(b.name));
    byName.forEach((r, idx) => {
      if (doc.y + 12 > bottom()) {
        doc.addPage();
        doc.y = 36;
        regHead();
      }
      const y = doc.y;
      if (idx % 2 === 1) doc.rect(L, y - 2, W, 12).fillColor('#FAFAFA').fill();
      let x = L;
      doc.font('Helvetica').fontSize(7).fillColor(INK);
      for (const c of cols) {
        doc.text(c.v(r), x + 2, y, { width: c.w - 4, align: c.left ? 'left' : 'right', lineBreak: false, ellipsis: true });
        x += c.w;
      }
      doc.y = y + 12;
    });
    ensure(18);
    rule(doc.y, INK);
    doc.y += 3;
    const totalRow = {
      name: `Total · ${t.people} people`,
      state: '',
      hours: t.hours,
      gross: t.gross,
      preTax: t.preTax,
      federal: report.taxes.employee.find((x) => x.key === 'federal')?.amount ?? 0,
      socialSecurity: report.taxes.employee.find((x) => x.key === 'socialSecurity')?.amount ?? 0,
      medicare: report.taxes.employee.find((x) => x.key === 'medicare')?.amount ?? 0,
      stateTax: report.taxes.employee.find((x) => x.key === 'state')?.amount ?? 0,
      localTax: report.taxes.employee.find((x) => x.key === 'local')?.amount ?? 0,
      postTax: t.postTax,
      other: t.other,
      reimbursements: t.reimbursements,
      net: t.net,
      employerTaxes: t.employerTaxes,
    } as unknown as PayrollReviewReport['rows'][number];
    let x = L;
    const yT = doc.y;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(INK);
    for (const c of cols) {
      doc.text(c.v(totalRow), x + 2, yT, { width: c.w - 4, align: c.left ? 'left' : 'right', lineBreak: false });
      x += c.w;
    }
    doc.y = yT + 16;

    // ---- Sign-off
    ensure(110);
    heading('Sign-off');
    if (signed) {
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(`Reviewed and signed off by ${signed.signedByName ?? 'a reviewer'} on ${dateTime(signed.signedAt)}.`, L, doc.y);
      if (signed.note) doc.fillColor(MUTED).text(`Note: ${signed.note}`, L, doc.y + 2, { width: W });
      if (signed.soleReviewer) doc.fillColor(MUTED).text('Signed by the run’s creator: no one else processes payroll for this company.', L, doc.y + 2);
    } else {
      doc.font('Helvetica').fontSize(9).fillColor(INK).text('I reviewed the numbers in this report and approve this payroll for payment.', L, doc.y);
      doc.moveDown(2);
      const y = doc.y;
      doc.text('Reviewed by: ______________________________', L, y, { lineBreak: false });
      doc.text('Signature: ______________________________', L + 260, y, { lineBreak: false });
      doc.text('Date: ________________', L + 520, y, { lineBreak: false });
      doc.y = y + 18;
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`This report is version ${report.fingerprint}. A sign-off holds only for this version: any change to a paycheck needs a new review.`, L, doc.y + 6, { width: W });

    // ---- Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - 30;
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(`${report.company} · Pre-payroll review · ${report.run.periodStart} to ${report.run.periodEnd}`, L, y, { lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, R - 120, y, { width: 120, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

function signedMoney(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
}

function signed0(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}

function delta(now: number, before: number): string {
  const d = now - before;
  if (before === 0) return d === 0 ? 'No change' : `${signedMoney(d)} vs last payroll`;
  const pct = Math.round((d / Math.abs(before)) * 1000) / 10;
  return `${signedMoney(d)} (${pct > 0 ? '+' : ''}${pct}%) vs last payroll`;
}
