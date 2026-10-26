import { COLOR, createDoc, fmt, type Brand } from './docKit/index.js';
import { fmtDayRange } from './humanDates.js';

/**
 * The check register for a payroll run: every check number ever issued
 * for it, live or void, with the totals that tie to the bank statement and
 * an approval block. Voided checks stay on the sheet, struck through, with
 * the reason, so no number goes missing from the sequence.
 */

export interface CheckRegisterRow {
  checkNumber: number;
  issuedAt: string;
  payeeName: string;
  memo: string | null;
  amount: number;
  voided: boolean;
  voidReason?: string | null;
  stopPayment?: boolean;
  printedAt?: string | null;
  replacesCheckNumber?: number | null;
}

export interface CheckRegisterData {
  company: Brand;
  run: { id: string; periodStart: string; periodEnd: string };
  account?: { bankName: string | null; last4: string } | null;
  rows: CheckRegisterRow[];
  generatedAt: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function renderCheckRegisterPdf(data: CheckRegisterData): Promise<Buffer> {
  const { k } = createDoc({ title: `Check register ${fmtDayRange(data.run.periodStart, data.run.periodEnd, { year: true })}`, author: data.company.name });
  const rows = [...data.rows].sort((a, b) => a.checkNumber - b.checkNumber);
  const live = rows.filter((r) => !r.voided);
  const voids = rows.filter((r) => r.voided);
  const total = live.reduce((s, r) => s + r.amount, 0);
  let y = k.masthead({
    title: 'Check register',
    subtitle: `Pay period ${fmt.dateRange(data.run.periodStart, data.run.periodEnd)}${data.account?.bankName ? `  ·  ${data.account.bankName}` : ''}`,
    brand: data.company,
    meta: [
      { label: 'Checks issued', value: plural(live.length, 'check') },
      { label: 'Voided', value: plural(voids.length, 'check') },
      { label: 'Total outstanding', value: fmt.money(total) },
      { label: 'Drawn on account', value: data.account ? `••••${data.account.last4}` : '—' },
    ],
  });
  y = k.section('Checks', y, rows.length ? `Nos. ${rows[0]!.checkNumber}–${rows[rows.length - 1]!.checkNumber}` : undefined);
  const strike = (r: CheckRegisterRow) => (r.voided ? COLOR.ink3 : undefined);
  y = k.table({
    y,
    rows,
    empty: 'No checks were issued for this run.',
    columns: [
      { key: 'no', header: 'Check no.', width: 1.1, value: (r) => String(r.checkNumber), strong: true, color: strike },
      { key: 'date', header: 'Issued', width: 1.3, value: (r) => fmt.date(r.issuedAt), color: strike },
      { key: 'payee', header: 'Payee', width: 2.6, value: (r) => r.payeeName, color: strike },
      {
        key: 'status',
        header: 'Status',
        width: 2.8,
        value: (r) =>
          r.voided
            ? `${r.stopPayment ? 'Stop payment' : 'Void'}${r.voidReason ? ` · ${r.voidReason}` : ''}`
            : `${r.printedAt ? `Printed ${fmt.date(r.printedAt)}` : 'Not printed'}${r.replacesCheckNumber ? ` · replaces #${r.replacesCheckNumber}` : ''}`,
        color: (r) => (r.voided ? COLOR.bad : COLOR.ink2),
      },
      { key: 'amount', header: 'Amount', width: 1.4, align: 'right', value: (r) => (r.voided ? `(${fmt.money(r.amount)})` : fmt.money(r.amount)), color: strike, strong: true },
    ],
    totals: { payee: plural(live.length, 'live check'), amount: fmt.money(total) },
  });
  // Struck-through voids: a rule through each void row would need row positions; the status column and the bracketed amount carry it instead.
  if (voids.length) {
    y = k.callout({ tone: 'warn', title: `${plural(voids.length, 'voided check')} in this run`, body: 'Voided numbers stay on the register so the sequence is complete. Bracketed amounts are not included in the total. Tell the bank about each void in the positive-pay file.' }, y);
  }
  y = k.ensure(y, 90);
  y += 18;
  k.signatureLine(k.L, y + 30, 220, 'Prepared by');
  k.signatureLine(k.L + 260, y + 30, 220, 'Approved by');
  k.text(`Prepared ${fmt.dateTime(data.generatedAt)}`, k.L, y + 52, { size: 7, color: COLOR.ink3 });
  return k.finish({ reference: `Check register · run ${data.run.id.slice(0, 8)}` });
}
