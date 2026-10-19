import { FLAG_LABEL, type PayrollReviewReport, type ReviewRow, type ReviewState } from './payrollReview.js';
import { COLOR, SIZE, createDoc, fmt, type Column } from './docKit/index.js';

/**
 * The pre-payroll review as a PDF an accountant reads, prints or files:
 * landscape letter in the house style. A summary up front (the sign-off,
 * totals against last payroll, cash needed, taxes owed), the paychecks
 * worth a second look, totals by department and state, then the full
 * register with a totals row. It ends with the sign-off, or signature
 * lines when there is none yet, and the version (fingerprint) the numbers
 * belong to.
 */

const KIND_LABEL: Record<string, string> = { REGULAR: 'Regular', OFF_CYCLE: 'Off-cycle', AMENDMENT: 'Amendment', DAILY: 'Daily pay', MANUAL: 'Manual check' };
const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', FINALIZED: 'Finalized', DISBURSED: 'Paid', CANCELLED: 'Voided' };

function delta(now: number, before: number): string {
  const d = now - before;
  if (Math.abs(d) < 0.005) return 'Same as last payroll';
  const pct = before !== 0 ? ` (${fmt.percent(Math.abs(d / before))})` : '';
  return `${fmt.money(d, { signed: true })}${pct} vs last payroll`;
}

export async function renderPayrollReviewPdf(report: PayrollReviewReport, signoff: ReviewState): Promise<Buffer> {
  const r = report.run;
  const t = report.totals;
  const { k } = createDoc({ title: `Payroll review ${r.periodStart} to ${r.periodEnd}`, author: report.company, layout: 'landscape', margin: 36 });
  let y = k.masthead({
    title: 'Pre-payroll review',
    subtitle: `${r.clientName ?? 'All clients'} · ${KIND_LABEL[r.kind] ?? r.kind} run · ${STATUS_LABEL[r.status] ?? r.status}`,
    brand: { name: report.company, lines: [`Prepared ${fmt.dateTime(report.generatedAt)}${r.createdByName ? ` · run created by ${r.createdByName}` : ''} · version ${report.fingerprint.slice(0, 12)}`] },
    meta: [
      { label: 'Pay period', value: fmt.dateRange(r.periodStart, r.periodEnd) },
      { label: 'People paid', value: `${t.people}${t.contractors ? ` (${t.contractors} contractors)` : ''}` },
      { label: 'Hours', value: fmt.hours(t.hours) },
      { label: 'Run', value: r.id.slice(0, 8).toUpperCase() },
    ],
  });

  const signed = signoff.current;
  y = k.callout(
    signed
      ? { tone: 'good', title: `Signed off by ${signed.signedByName ?? 'a reviewer'}`, body: `${fmt.dateTime(signed.signedAt)}${signed.soleReviewer ? ' · the only person who processes payroll' : ''}${signed.note ? ` · “${signed.note}”` : ''}` }
      : signoff.stale
        ? { tone: 'bad', title: 'Not signed: the numbers changed after the sign-off', body: `${signoff.stale.signedByName ?? 'The reviewer'} signed off ${fmt.dateTime(signoff.stale.signedAt)}. A paycheck changed since, so the run can’t pay until someone reviews it again.` }
        : signoff.required
          ? { tone: 'warn', title: 'Not signed off yet', body: 'This run can’t pay out until someone reviews these numbers and signs.' }
          : { tone: 'neutral', body: 'Sign-off is optional for this run.' },
    y,
  );

  y = k.figures(
    [
      { label: 'Gross pay', value: fmt.money(t.gross), hint: report.previous ? delta(t.gross, report.previous.gross) : 'No earlier payroll' },
      { label: 'Net pay', value: fmt.money(t.net), hint: report.previous ? delta(t.net, report.previous.net) : 'No earlier payroll' },
      { label: 'Employer taxes', value: fmt.money(t.employerTaxes), hint: `Employer cost ${fmt.money(t.employerCost)}` },
      { label: 'Taxes owed', value: fmt.money(report.taxes.total), hint: 'Withheld plus employer' },
      { label: 'Cash required', value: fmt.money(report.cash.total), hint: 'Leaves the bank for this run', emphasis: true },
    ],
    y,
  );

  // Cash and taxes side by side.
  const half = (k.width() - 24) / 2;
  const top = y;
  let yl = k.section('Cash required', top, undefined, { x: k.L, w: half });
  yl = k.table({ y: yl, x: k.L, w: half, rows: report.cash.lines, rowH: 15, columns: [{ key: 'l', header: 'For', width: 6, value: (l) => l.label }, { key: 'a', header: 'Amount', width: 3, align: 'right', value: (l) => fmt.money(l.amount) }], totals: { l: 'Total cash required', a: fmt.money(report.cash.total) } });
  const taxRows = [...report.taxes.employee.map((x) => ({ label: `${x.label} (withheld)`, amount: x.amount })), ...report.taxes.employer.map((x) => ({ label: x.label, amount: x.amount }))];
  let yr = k.section('Taxes owed for this run', top, undefined, { x: k.L + half + 24, w: half });
  yr = k.table({ y: yr, x: k.L + half + 24, w: half, rows: taxRows, rowH: 15, columns: [{ key: 'l', header: 'Tax', width: 6, value: (l) => l.label }, { key: 'a', header: 'Amount', width: 3, align: 'right', value: (l) => fmt.money(l.amount) }], totals: { l: 'Total taxes', a: fmt.money(report.taxes.total) } });
  y = Math.max(yl, yr);

  if (report.previous) {
    const p = report.previous;
    y = k.section(`Compared with the last payroll (${fmt.dateRange(p.periodStart, p.periodEnd)})`, y);
    y = k.table({
      y,
      rowH: 15,
      rows: [
        { l: 'People paid', a: String(p.people), b: String(t.people), c: `${t.people - p.people > 0 ? '+' : ''}${t.people - p.people}` },
        { l: 'Gross pay', a: fmt.money(p.gross), b: fmt.money(t.gross), c: fmt.money(t.gross - p.gross, { signed: true }) },
        { l: 'Net pay', a: fmt.money(p.net), b: fmt.money(t.net), c: fmt.money(t.net - p.net, { signed: true }) },
        { l: 'Employer taxes', a: fmt.money(p.employerTaxes), b: fmt.money(t.employerTaxes), c: fmt.money(t.employerTaxes - p.employerTaxes, { signed: true }) },
      ],
      columns: [
        { key: 'l', header: '', width: 4, value: (x) => x.l },
        { key: 'a', header: 'Last payroll', width: 2, align: 'right', value: (x) => x.a },
        { key: 'b', header: 'This payroll', width: 2, align: 'right', value: (x) => x.b, strong: true },
        { key: 'c', header: 'Change', width: 2, align: 'right', value: (x) => x.c },
      ],
    });
  }

  const flagged = report.rows.filter((x) => x.flags.length > 0);
  y = k.section(flagged.length ? `Paychecks to look at (${flagged.length})` : 'Paychecks to look at', y, 'First paychecks, sharp swings and checks that withhold nothing');
  y = k.table({
    y,
    rows: flagged,
    rowH: 15,
    empty: 'Nothing unusual: no first paychecks, no sharp swings since last payroll, and every W-2 check withholds tax.',
    columns: [
      { key: 'n', header: 'Person', width: 3, value: (x) => x.name, strong: true },
      { key: 'w', header: 'Why', width: 5, value: (x) => x.flags.map((f) => FLAG_LABEL[f]).join(', '), color: (x) => (x.flags.includes('ZERO_NET') || x.flags.includes('NO_FICA') ? COLOR.bad : undefined) },
      { key: 'l', header: 'Last net', width: 1.6, align: 'right', value: (x) => (x.prior ? fmt.money(x.prior.net) : '—') },
      { key: 't', header: 'This net', width: 1.6, align: 'right', value: (x) => fmt.money(x.net), strong: true },
      { key: 'c', header: 'Change', width: 1.6, align: 'right', value: (x) => (x.netChange == null ? '—' : fmt.money(x.netChange, { signed: true })), color: (x) => (x.netChange != null && x.netChange < 0 ? COLOR.bad : undefined) },
    ],
  });

  // Totals by department and by state, side by side.
  const group = (title: string, rows: PayrollReviewReport['byDepartment'], x: number, yy: number) => {
    yy = k.section(title, yy, undefined, { x, w: half });
    return k.table({
      y: yy,
      x,
      w: half,
      rows,
      rowH: 15,
      columns: [
        { key: 'n', header: '', width: 3.4, value: (g) => g.name },
        { key: 'p', header: 'People', width: 1.2, align: 'right', value: (g) => String(g.people) },
        { key: 'g', header: 'Gross', width: 2, align: 'right', value: (g) => fmt.money(g.gross) },
        { key: 't', header: 'Net', width: 2, align: 'right', value: (g) => fmt.money(g.net) },
      ],
    });
  };
  y = k.ensure(y, 120);
  const gtop = y;
  group('By department', report.byDepartment, k.L, gtop);
  group('By work state', report.byState, k.L + half + 24, gtop);

  // The register.
  k.doc.addPage();
  y = k.top;
  k.text('Payroll register', k.L, y, { size: SIZE.heading, family: 'display', weight: 'semibold' });
  k.text('Gross + reimbursements − taxes − deductions − other = net, on every row.', k.L, y + 4, { size: SIZE.small, color: COLOR.ink3, width: k.width(), align: 'right' });
  y += 28;
  const byName = [...report.rows].sort((a, b) => a.name.localeCompare(b.name));
  const sumKey = (f: (x: ReviewRow) => number) => fmt.money(report.rows.reduce((s, x) => s + f(x), 0));
  const cols: Column<ReviewRow>[] = [
    { key: 'name', header: 'Person', width: 3.2, value: (x) => x.name, strong: true },
    { key: 'st', header: 'State', width: 0.8, value: (x) => x.state ?? '' },
    { key: 'hrs', header: 'Hours', width: 1, align: 'right', value: (x) => fmt.hours(x.hours) },
    { key: 'gross', header: 'Gross', width: 1.4, align: 'right', value: (x) => fmt.money(x.gross) },
    { key: 'pre', header: 'Pre-tax', width: 1.2, align: 'right', value: (x) => fmt.money(x.preTax) },
    { key: 'fed', header: 'Federal', width: 1.2, align: 'right', value: (x) => fmt.money(x.federal) },
    { key: 'ss', header: 'Soc. Sec.', width: 1.2, align: 'right', value: (x) => fmt.money(x.socialSecurity) },
    { key: 'med', header: 'Medicare', width: 1.1, align: 'right', value: (x) => fmt.money(x.medicare) },
    { key: 'sit', header: 'State', width: 1.1, align: 'right', value: (x) => fmt.money(x.stateTax) },
    { key: 'loc', header: 'Local', width: 1, align: 'right', value: (x) => fmt.money(x.localTax) },
    { key: 'pgm', header: 'Disab./leave', width: 1.1, align: 'right', value: (x) => fmt.money(x.stateProgram ?? 0) },
    { key: 'post', header: 'Post-tax', width: 1.2, align: 'right', value: (x) => fmt.money(x.postTax) },
    { key: 'oth', header: 'Other', width: 1.1, align: 'right', value: (x) => fmt.money(x.other) },
    { key: 'rei', header: 'Reimb.', width: 1.1, align: 'right', value: (x) => fmt.money(x.reimbursements) },
    { key: 'net', header: 'Net', width: 1.4, align: 'right', value: (x) => fmt.money(x.net), strong: true },
    { key: 'er', header: 'Employer tax', width: 1.4, align: 'right', value: (x) => fmt.money(x.employerTaxes) },
  ];
  y = k.table({
    y,
    rows: byName,
    rowH: 14,
    size: 7.2,
    columns: cols,
    totals: {
      name: `Total · ${t.people} people`,
      hrs: fmt.hours(t.hours),
      gross: fmt.money(t.gross),
      pre: fmt.money(t.preTax),
      fed: sumKey((x) => x.federal),
      ss: sumKey((x) => x.socialSecurity),
      med: sumKey((x) => x.medicare),
      sit: sumKey((x) => x.stateTax),
      loc: sumKey((x) => x.localTax),
      pgm: sumKey((x) => x.stateProgram ?? 0),
      post: fmt.money(t.postTax),
      oth: fmt.money(t.other),
      rei: fmt.money(t.reimbursements),
      net: fmt.money(t.net),
      er: fmt.money(t.employerTaxes),
    },
  });

  // Sign-off.
  y = k.ensure(y, 120);
  y = k.section('Sign-off', y);
  if (signed) {
    y += k.para(`Reviewed and signed off by ${signed.signedByName ?? 'a reviewer'} on ${fmt.dateTime(signed.signedAt)}.${signed.note ? ` Note: ${signed.note}` : ''}${signed.soleReviewer ? ' Signed by the run’s creator: no one else processes payroll for this company.' : ''}`, k.L, y, k.width(), { size: SIZE.body }) + 8;
  } else {
    y += k.para('I reviewed the numbers in this report and approve this payroll for payment.', k.L, y, k.width(), { size: SIZE.body }) + 34;
    k.signatureLine(k.L, y, 240, 'Reviewed by');
    k.signatureLine(k.L + 270, y, 240, 'Signature');
    k.signatureLine(k.L + 540, y, 150, 'Date');
    y += 30;
  }
  k.para(`This report is version ${report.fingerprint}. A sign-off holds only for this version: any change to a paycheck needs a new review.`, k.L, y, k.width(), { size: SIZE.small, color: COLOR.ink3 });
  return k.finish({ reference: `Pre-payroll review · ${r.periodStart} to ${r.periodEnd}`, note: report.company });
}
