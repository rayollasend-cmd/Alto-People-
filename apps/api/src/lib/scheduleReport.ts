import { COLOR, SIZE, createDoc, fmt, type Column } from './docKit/index.js';
import { loadCurrentBrand } from './docKit/biz.js';
import {
  DEFAULT_TIMEZONE,
  localDateKey,
  formatDateInZone,
  formatDateTimeInZone,
  formatTimeInZone,
} from './timezone.js';

/**
 * Phase 54.4 — schedule PDF renderer.
 *
 * The schedule as a manager prints it for the back office wall: letter
 * landscape, the range and its totals up top (shifts, hours, staffed,
 * open), then one table per day in time order. Open shifts read in the
 * warning colour so a gap is visible from across the room. Output is a
 * Buffer so the route can hash / log it before streaming.
 *
 * Every shift time is rendered in its work-site timezone (`shift.timezone`)
 * — the server runs in UTC, so the old bare toLocale* calls printed every
 * shift 4–5h off for an Eastern store.
 */

export interface ScheduleReportShift {
  startsAt: Date;
  endsAt: Date;
  position: string;
  clientName: string | null;
  location: string | null;
  /** IANA timezone of the work site; the row's date/time render in it. */
  timezone: string;
  assignedAssociateName: string | null;
  status: string;
  hourlyRate: number | null;
  scheduledMinutes: number;
}

export interface ScheduleReportData {
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  /** Report-level timezone for the header's "Generated …" stamp. Per-shift
   *  rows use their own work-site timezone. */
  timezone: string;
  filters: {
    clientName: string | null; // null = all
  };
  shifts: ScheduleReportShift[];
  /** False for store-bound viewers — the client bill rate isn't theirs to
   *  see, so the Rate column goes rather than printing blanks. */
  showRate?: boolean;
}

const STATUS_LABEL: Record<string, string> = { OPEN: 'Open', ASSIGNED: 'Staffed', COMPLETED: 'Completed', DRAFT: 'Draft', CANCELLED: 'Cancelled' };
const statusColor = (st: string): string | undefined =>
  st === 'OPEN' ? COLOR.warn : st === 'ASSIGNED' || st === 'COMPLETED' ? COLOR.good : st === 'CANCELLED' ? COLOR.bad : st === 'DRAFT' ? COLOR.ink3 : undefined;

export async function renderSchedulePdf(data: ScheduleReportData): Promise<Buffer> {
  const brand = await loadCurrentBrand();
  const { k } = createDoc({ title: `Schedule — ${rangeLabel(data.rangeFrom, data.rangeTo, data.timezone)}`, author: brand.name, layout: 'landscape', margin: 36 });
  const shifts = [...data.shifts].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const live = shifts.filter((s) => s.status !== 'CANCELLED');
  const hours = live.reduce((t, s) => t + s.scheduledMinutes, 0) / 60;
  const open = live.filter((s) => s.status === 'OPEN').length;
  const staffed = live.length - open - live.filter((s) => s.status === 'DRAFT').length;

  let y = k.masthead({
    title: 'Schedule',
    subtitle: `Generated ${formatDateTimeInZone(data.generatedAt, data.timezone)}`,
    brand,
    meta: [
      { label: 'Dates', value: rangeLabel(data.rangeFrom, data.rangeTo, data.timezone) },
      { label: 'Client', value: data.filters.clientName ?? 'All clients' },
      { label: 'Shifts', value: String(live.length) },
      { label: 'Scheduled hours', value: fmt.number(hours, 1) },
    ],
  });
  y = k.figures(
    [
      { label: 'Shifts', value: String(live.length), hint: `${shifts.length - live.length} cancelled` },
      { label: 'Staffed', value: String(staffed), hint: live.length ? `${Math.round((staffed / live.length) * 100)}% of shifts` : 'no shifts', tone: open === 0 && live.length > 0 ? 'good' : undefined },
      { label: 'Open', value: String(open), hint: open ? 'still to fill' : 'nothing open', tone: open ? 'warn' : 'good' },
      { label: 'Hours', value: fmt.number(hours, 1), hint: 'scheduled, all shifts', emphasis: true },
    ],
    y,
  );

  const columns: Column<ScheduleReportShift>[] = [
    { key: 'time', header: 'Time', width: 1.7, value: (s) => `${formatTimeInZone(s.startsAt, s.timezone)} – ${formatTimeInZone(s.endsAt, s.timezone)}` },
    { key: 'hours', header: 'Hours', width: 0.7, align: 'right', value: (s) => fmt.number(s.scheduledMinutes / 60, 1) },
    { key: 'position', header: 'Position', width: 1.8, value: (s) => s.position },
    { key: 'client', header: 'Client', width: 1.7, value: (s) => s.clientName ?? '—' },
    { key: 'loc', header: 'Location', width: 1.7, value: (s) => s.location ?? '—' },
    { key: 'assoc', header: 'Associate', width: 2.2, value: (s) => s.assignedAssociateName ?? 'Open', color: (s) => (s.assignedAssociateName ? undefined : COLOR.warn), strong: false },
    { key: 'status', header: 'Status', width: 1.1, value: (s) => STATUS_LABEL[s.status] ?? s.status, color: (s) => statusColor(s.status) },
    ...(data.showRate === false ? [] : [{ key: 'rate', header: 'Rate', width: 0.9, align: 'right' as const, value: (s: ScheduleReportShift) => (s.hourlyRate != null ? fmt.money(s.hourlyRate) : '—') }]),
  ];

  if (shifts.length === 0) {
    y = k.callout({ title: 'No shifts', body: 'No shifts are scheduled in this range for the filters chosen.' }, y);
  }
  // One table per day, in each shift's own work-site time zone.
  const days = new Map<string, ScheduleReportShift[]>();
  for (const s of shifts) {
    const key = formatDateInZone(s.startsAt, s.timezone);
    const list = days.get(key) ?? [];
    list.push(s);
    days.set(key, list);
  }
  for (const [day, rows] of days) {
    y = k.ensure(y, 80);
    const dayOpen = rows.filter((r) => r.status === 'OPEN').length;
    const dayHours = rows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + r.scheduledMinutes, 0) / 60;
    k.text(day, k.L, y, { size: SIZE.lead, weight: 'semibold' });
    k.text(`${rows.length} shift${rows.length === 1 ? '' : 's'} · ${fmt.number(dayHours, 1)} h${dayOpen ? ` · ${dayOpen} open` : ''}`, k.L, y + 2, { size: SIZE.small, color: dayOpen ? COLOR.warn : COLOR.ink3, width: k.width(), align: 'right' });
    y = k.table({ y: y + 18, rows, columns, rowH: 17 });
  }

  return k.finish({ reference: `Schedule · ${rangeLabel(data.rangeFrom, data.rangeTo, data.timezone)}${data.filters.clientName ? ` · ${data.filters.clientName}` : ''}`, note: brand.name });
}

/** "Oct 10 – Oct 16, 2026" for an end-exclusive range. */
function rangeLabel(from: Date, toExclusive: Date, tz = DEFAULT_TIMEZONE): string {
  const last = new Date(toExclusive.getTime() - 1);
  const a = localDateKey(from, tz);
  const b = localDateKey(last, tz);
  if (a === b) return fmt.date(a);
  if (a.slice(0, 4) === b.slice(0, 4)) return `${new Date(`${a}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${fmt.date(b)}`;
  return fmt.dateRange(a, b);
}
