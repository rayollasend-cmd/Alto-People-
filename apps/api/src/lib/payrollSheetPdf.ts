import { COLOR, createDoc, fmt } from './docKit/index.js';
import { currentBrand } from './docKit/brand.js';
import { minutesToHours } from './payrollSheet.js';
import type { PayrollSheetPaid } from './payrollSheetPay.js';

/**
 * Payroll-ready time sheet PDF.
 *
 * Formatted like a payroll register a processor would accept: a letterhead,
 * an employer / pay-period metadata block, a bordered table per associate
 * (dates worked + daily duration) with a regular / overtime / total subtotal
 * and an earnings line (rate, gross, taxes, net), a grand-total band, a
 * sign-off line, and "Page X of Y" footers. Landscape, in the house style.
 *
 * Gross is driven by each associate's compensation-record wage; net is the
 * full payroll-engine figure (W-4, pre-tax benefits, garnishments, YTD caps),
 * with Florida resolving to $0 state income tax.
 */

export interface PayrollSheetReportData {
  sheet: PayrollSheetPaid;
  clientName: string | null;
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  /** Entries still pending review in the window — totals are provisional. */
  pendingCount: number;
}

function hrs(min: number): string {
  return fmt.hours(Number(minutesToHours(min)));
}

function rangeLabel(from: Date, toExclusive: Date): string {
  return fmt.dateRange(from, new Date(toExclusive.getTime() - 1));
}

export async function renderPayrollSheetPdf(data: PayrollSheetReportData): Promise<Buffer> {
  const sheet = data.sheet;
  const range = rangeLabel(data.rangeFrom, data.rangeTo);
  const { k } = createDoc({ title: `Payroll time sheet · ${range}`, layout: 'landscape', margin: 36 });
  let y = k.masthead({
    title: 'Payroll time sheet',
    subtitle: data.clientName ?? 'All clients',
    brand: currentBrand(),
    meta: [
      { label: 'Pay period', value: range },
      { label: 'Client', value: data.clientName ?? 'All clients' },
      { label: 'People', value: String(sheet.associates.length) },
      { label: 'Prepared', value: fmt.dateTime(data.generatedAt) },
    ],
  });
  if (data.pendingCount > 0) {
    y = k.callout({ tone: 'warn', title: 'Provisional totals', body: `${data.pendingCount} time ${data.pendingCount === 1 ? 'entry is' : 'entries are'} still waiting for approval in this period. Totals change once they are reviewed.` }, y);
  }
  if (sheet.anyMissingRate) {
    y = k.callout({ tone: 'bad', title: 'Missing pay rates', body: 'Some people have no hourly wage on file, so their gross and net are blank. Add a compensation record before running payroll.' }, y);
  }
  y = k.figures(
    [
      { label: 'Regular hours', value: hrs(sheet.totalRegularMinutes) },
      { label: 'Overtime hours', value: hrs(sheet.totalOvertimeMinutes), tone: sheet.totalOvertimeMinutes > 0 ? 'warn' : undefined },
      { label: 'Gross pay', value: fmt.money(sheet.totalGross) },
      { label: 'Taxes withheld', value: fmt.money(-(sheet.totalFederalIncomeTax + sheet.totalSocialSecurity + sheet.totalMedicare + sheet.totalStateIncomeTax)) },
      { label: 'Net pay', value: fmt.money(sheet.totalNet), emphasis: true },
    ],
    y,
  );

  y = k.section('By person', y, 'Hours, rate and the payroll engine’s figures');
  const money = (n: number, has: boolean) => (has ? fmt.money(n) : '—');
  y = k.table({
    y,
    rows: sheet.associates,
    rowH: 16,
    columns: [
      { key: 'name', header: 'Person', width: 3.2, value: (a) => a.name, strong: true },
      { key: 'reg', header: 'Regular', width: 1.1, align: 'right', value: (a) => hrs(a.regularMinutes) },
      { key: 'ot', header: 'Overtime', width: 1.1, align: 'right', value: (a) => (a.overtimeMinutes ? hrs(a.overtimeMinutes) : '—'), color: (a) => (a.overtimeMinutes ? COLOR.warn : undefined) },
      { key: 'tot', header: 'Total', width: 1.1, align: 'right', value: (a) => hrs(a.totalMinutes) },
      { key: 'rate', header: 'Rate', width: 1.1, align: 'right', value: (a) => (a.pay.hasRate ? fmt.money(a.pay.hourlyRate) : 'No rate'), color: (a) => (a.pay.hasRate ? undefined : COLOR.bad) },
      { key: 'gross', header: 'Gross', width: 1.4, align: 'right', value: (a) => money(a.pay.grossPay, a.pay.hasRate) },
      { key: 'fit', header: 'Federal', width: 1.2, align: 'right', value: (a) => money(a.pay.federalIncomeTax, a.pay.hasRate) },
      { key: 'ss', header: 'Soc. Sec.', width: 1.2, align: 'right', value: (a) => money(a.pay.socialSecurity, a.pay.hasRate) },
      { key: 'med', header: 'Medicare', width: 1.1, align: 'right', value: (a) => money(a.pay.medicare, a.pay.hasRate) },
      { key: 'st', header: 'State', width: 1.1, align: 'right', value: (a) => money(a.pay.stateIncomeTax, a.pay.hasRate) },
      { key: 'net', header: 'Net', width: 1.4, align: 'right', value: (a) => money(a.pay.netPay, a.pay.hasRate), strong: true },
    ],
    totals: {
      name: `Total · ${sheet.associates.length} people`,
      reg: hrs(sheet.totalRegularMinutes),
      ot: hrs(sheet.totalOvertimeMinutes),
      tot: hrs(sheet.totalMinutes),
      gross: fmt.money(sheet.totalGross),
      fit: fmt.money(sheet.totalFederalIncomeTax),
      ss: fmt.money(sheet.totalSocialSecurity),
      med: fmt.money(sheet.totalMedicare),
      st: fmt.money(sheet.totalStateIncomeTax),
      net: fmt.money(sheet.totalNet),
    },
  });

  // Every day worked, person by person.
  type DayRow = { person: string; date: string; minutes: number; first: boolean };
  const days: DayRow[] = sheet.associates.flatMap((a) => a.days.map((d, i) => ({ person: a.name, date: d.date, minutes: d.minutes, first: i === 0 })));
  if (days.length) {
    y = k.section('Days worked', y, 'Net of breaks');
    y = k.table({
      y,
      rows: days,
      rowH: 14,
      zebra: false,
      columns: [
        { key: 'person', header: 'Person', width: 4, value: (d) => (d.first ? d.person : ''), strong: true },
        { key: 'date', header: 'Date', width: 3, value: (d) => `${new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}, ${fmt.date(d.date)}` },
        { key: 'hours', header: 'Hours', width: 1.5, align: 'right', value: (d) => hrs(d.minutes) },
      ],
    });
  }

  y = k.ensure(y + 10, 60);
  k.signatureLine(k.L, y + 30, 220, 'Prepared by');
  k.signatureLine(k.L + 250, y + 30, 220, 'Approved by');
  k.signatureLine(k.L + 500, y + 30, 120, 'Date');
  return k.finish({ reference: `Payroll time sheet · ${range}`, note: data.clientName ?? undefined });
}
