import { COLOR, createDoc, fmt, type Column } from './docKit/index.js';
import { loadCurrentBrand, signatureRow } from './docKit/biz.js';
import {
  localDateKey,
  formatDateInZone,
  formatDateTimeInZone,
  formatTimeInZone,
} from './timezone.js';
import { companyWorkweek } from './timeAnomalies.js';

/**
 * Phase 65 — time entry PDF renderer.
 *
 * The time report as a payroll or client reviewer signs it: letter
 * landscape, the totals up top (entries, hours, approved, waiting,
 * rejected), then a table per associate with their subtotal, and an
 * approval block (prepared by / approved by) at the end.
 *
 * Every timestamp renders in the entry's SITE zone (never the server's —
 * this used to call toLocale* on a UTC box, so the PDF disagreed with the
 * screen by the full zone offset).
 */

export interface TimeReportEntry {
  clockInAt: Date;
  clockOutAt: Date | null;
  /** IANA zone of the entry's work site — punches render on its wall clock. */
  timezone: string;
  associateName: string;
  clientName: string | null;
  jobName: string | null;
  status: string;
  minutes: number;
  rejectionReason: string | null;
}

export interface TimeReportData {
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  filters: {
    clientName: string | null;
    associateName: string | null;
    status: string | null;
  };
  entries: TimeReportEntry[];
}

const STATUS_LABEL: Record<string, string> = { APPROVED: 'Approved', COMPLETED: 'Awaiting approval', ACTIVE: 'On the clock', REJECTED: 'Rejected', PENDING: 'Pending' };
const statusColor = (st: string): string | undefined => (st === 'APPROVED' ? COLOR.good : st === 'REJECTED' ? COLOR.bad : st === 'COMPLETED' || st === 'PENDING' ? COLOR.warn : st === 'ACTIVE' ? COLOR.info : undefined);

export async function renderTimeReportPdf(data: TimeReportData): Promise<Buffer> {
  const brand = await loadCurrentBrand();
  // The first entry's store clock, else the company's.
  const tz = data.entries[0]?.timezone ?? companyWorkweek().timezone;
  const { k } = createDoc({ title: `Time report — ${rangeLabel(data.rangeFrom, data.rangeTo, tz)}`, author: brand.name, layout: 'landscape', margin: 36 });
  const sorted = [...data.entries].sort((a, b) => a.associateName.localeCompare(b.associateName) || a.clockInAt.getTime() - b.clockInAt.getTime());
  const hours = (list: TimeReportEntry[]) => list.reduce((t, e) => t + e.minutes, 0) / 60;
  const by = (st: string) => sorted.filter((e) => e.status === st);

  let y = k.masthead({
    title: 'Time report',
    subtitle: `Generated ${formatDateTimeInZone(data.generatedAt, tz)}`,
    brand,
    meta: [
      { label: 'Dates', value: rangeLabel(data.rangeFrom, data.rangeTo, tz) },
      { label: 'Client', value: data.filters.clientName ?? 'All clients' },
      { label: 'Associate', value: data.filters.associateName ?? 'Everyone' },
      { label: 'Status', value: data.filters.status ? STATUS_LABEL[data.filters.status] ?? data.filters.status : 'All' },
    ],
  });
  y = k.figures(
    [
      { label: 'Entries', value: String(sorted.length), hint: `${new Set(sorted.map((e) => e.associateName)).size} people` },
      { label: 'Approved hours', value: fmt.number(hours(by('APPROVED')), 1), hint: `${by('APPROVED').length} entries`, tone: 'good' },
      { label: 'Awaiting approval', value: fmt.number(hours(by('COMPLETED')), 1), hint: `${by('COMPLETED').length} entries`, tone: by('COMPLETED').length ? 'warn' : undefined },
      { label: 'Rejected', value: String(by('REJECTED').length), hint: 'entries', tone: by('REJECTED').length ? 'bad' : undefined },
      { label: 'Total hours', value: fmt.number(hours(sorted), 1), emphasis: true },
    ],
    y,
  );

  const columns: Column<TimeReportEntry>[] = [
    { key: 'date', header: 'Date', width: 1.3, value: (e) => formatDateInZone(e.clockInAt, e.timezone) },
    { key: 'in', header: 'In', width: 0.9, value: (e) => formatTimeInZone(e.clockInAt, e.timezone) },
    { key: 'out', header: 'Out', width: 0.9, value: (e) => (e.clockOutAt ? formatTimeInZone(e.clockOutAt, e.timezone) : 'Open') },
    { key: 'hrs', header: 'Hours', width: 0.7, align: 'right', value: (e) => fmt.number(e.minutes / 60, 2), strong: true },
    { key: 'client', header: 'Client', width: 1.8, value: (e) => e.clientName ?? '—' },
    { key: 'job', header: 'Job', width: 1.8, value: (e) => e.jobName ?? '—' },
    { key: 'status', header: 'Status', width: 1.4, value: (e) => STATUS_LABEL[e.status] ?? e.status, color: (e) => statusColor(e.status) },
    { key: 'note', header: 'Note', width: 2, value: (e) => e.rejectionReason ?? '' , color: () => COLOR.bad },
  ];

  if (sorted.length === 0) y = k.callout({ title: 'No time entries', body: 'No time was recorded in this range for the filters chosen.' }, y);
  const people = new Map<string, TimeReportEntry[]>();
  for (const e of sorted) people.set(e.associateName, [...(people.get(e.associateName) ?? []), e]);
  for (const [name, rows] of people) {
    y = k.ensure(y, 80);
    k.text(name, k.L, y, { size: 11, weight: 'semibold', width: k.width() * 0.6 });
    k.text(`${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · ${fmt.number(hours(rows), 2)} h`, k.L, y + 1, { size: 8.5, color: COLOR.ink3, width: k.width(), align: 'right' });
    y = k.table({ y: y + 18, rows, columns, rowH: 17, totals: { date: 'Subtotal', hrs: fmt.number(hours(rows), 2) } });
  }

  // Approval: who prepared the report and who approved the hours.
  y = k.ensure(y + 6, 80);
  k.text('Approval', k.L, y, { size: 11, weight: 'semibold' });
  signatureRow(k, y + 6, ['Prepared by', 'Approved by (client or supervisor)', 'Date']);

  return k.finish({ reference: `Time report · ${rangeLabel(data.rangeFrom, data.rangeTo, tz)}`, note: brand.name });
}

/** "Oct 10 – Oct 16, 2026" for an end-exclusive range. */
function rangeLabel(from: Date, toExclusive: Date, tz: string): string {
  const last = new Date(toExclusive.getTime() - 1);
  const a = localDateKey(from, tz);
  const b = localDateKey(last, tz);
  if (a === b) return fmt.date(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return `${new Date(`${a}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${fmt.date(b)}`;
  return fmt.dateRange(a, b);
}
