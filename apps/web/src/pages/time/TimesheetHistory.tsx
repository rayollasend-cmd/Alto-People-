import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, ChevronDown, Download, ExternalLink, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import type { TimesheetHistoryPeriod, TimesheetHistoryResponse, TimesheetHistoryWeek } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime, fmtDateTz, fmtMoney, fmtTimeTz, fmtWeekdayTz } from '@/lib/format';
import { downloadTimesheetHistoryCsv, getTimesheetHistory, markFieldglassEntered, setTimesheetNote } from '@/lib/timeApi';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { CopyValue } from './FieldglassDesk';

/**
 * An associate's whole timesheet, across pay periods — the page behind
 * "what did we bill for Rosa since she started?":
 *
 *   who           name, photo, client and position; the Fieldglass Worker
 *                 ID and (finance only) Security ID; first clock-in
 *   the totals    this year, all time, weeks worked, and where every week
 *                 stands in Fieldglass — with the money, for finance
 *   the rhythm    a bar per week, colored by its Fieldglass standing
 *   the periods   each pay period (and payday), its weeks as Sat→Fri day
 *                 grids; a week opens to its times, breaks, the buyer's
 *                 comment, finance's note, and what to do next
 */

const PT = 'America/Los_Angeles';
const noon = (ymd: string) => `${ymd}T12:00:00Z`;
const md = (ymd: string) => fmtDateTz(noon(ymd), 'UTC');
const mdy = (ymd: string) => `${md(ymd)}, ${ymd.slice(0, 4)}`;
const wd = (ymd: string) => fmtWeekdayTz(noon(ymd), 'UTC');
function range(a: string, b: string): string {
  return a.slice(0, 4) === b.slice(0, 4) ? `${md(a)} – ${md(b)}, ${b.slice(0, 4)}` : `${mdy(a)} – ${mdy(b)}`;
}
/** "2026-09-21" → "09/21/2026", as Fieldglass writes dates. */
const usDate = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
const hrs = (n: number) => n.toFixed(2);
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Tone = 'approved' | 'awaiting' | 'rejected' | 'toEnter' | 'overdue' | 'notRegistered' | 'inProgress' | 'none';

/** Where a week stands in Fieldglass: a label, a chip, a bar color. */
export function weekStanding(w: TimesheetHistoryWeek): { label: string; tone: Tone; variant: 'success' | 'info' | 'destructive' | 'pending' | 'accent' | 'default' } {
  const f = w.fieldglass;
  if (!f) return { label: 'No client', tone: 'none', variant: 'default' };
  if (!f.registered) return { label: 'Not in Fieldglass', tone: 'notRegistered', variant: 'destructive' };
  switch (f.status) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'approved', variant: 'success' };
    case 'INVOICED':
      return { label: 'Invoiced', tone: 'approved', variant: 'success' };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'rejected', variant: 'destructive' };
    case 'SUBMITTED':
      return { label: f.resubmittedAt ? 'Resubmitted' : 'Submitted', tone: 'awaiting', variant: 'info' };
    case 'DRAFT':
      return { label: 'Draft in Fieldglass', tone: 'awaiting', variant: 'default' };
    default:
      break;
  }
  if (f.enteredAt) return { label: 'Entered', tone: 'awaiting', variant: 'accent' };
  if (w.inProgress) return { label: 'Week in progress', tone: 'inProgress', variant: 'default' };
  if (w.overdue) return { label: 'Past due', tone: 'overdue', variant: 'pending' };
  return { label: 'To enter', tone: 'toEnter', variant: 'default' };
}

const BAR: Record<Tone, string> = {
  approved: 'bg-success',
  awaiting: 'bg-steel',
  rejected: 'bg-alert',
  toEnter: 'bg-gold',
  overdue: 'bg-warning',
  notRegistered: 'bg-alert/50',
  inProgress: 'bg-silver/40',
  none: 'bg-silver/60',
};

const LEGEND: Array<[Tone, string]> = [
  ['approved', 'Approved'],
  ['awaiting', 'With the buyer'],
  ['rejected', 'Rejected'],
  ['overdue', 'Past due'],
  ['toEnter', 'To enter'],
  ['notRegistered', 'Not in Fieldglass'],
];

const weekKey = (w: TimesheetHistoryWeek) => `${w.weekStart}|${w.clientId ?? ''}`;

/** Needs a look: rejected, past due, not in Fieldglass, hours that differ, or not approved yet. */
function needsAttention(w: TimesheetHistoryWeek): boolean {
  const f = w.fieldglass;
  if (w.pendingHours > 0) return true;
  if (!f) return false;
  if (!f.registered && w.total > 0) return true;
  if (f.status === 'REJECTED' || w.overdue) return true;
  return f.hours !== null && Math.abs(f.hours - w.total) >= 0.01;
}

export function TimesheetHistory() {
  const { associateId = '' } = useParams();
  const q = useQuery({
    queryKey: ['timesheets', 'history', associateId],
    queryFn: () => getTimesheetHistory(associateId),
    enabled: !!associateId,
  });
  const h = q.data;
  const [year, setYear] = useState<number | 'all'>('all');
  const [show, setShow] = useState<'all' | 'attention'>('all');
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const periods = useMemo(() => {
    if (!h) return [];
    return h.periods
      .map((p) => ({
        ...p,
        weeks: p.weeks.filter(
          (w) => (year === 'all' || w.weekEnd.startsWith(String(year))) && (show === 'all' || needsAttention(w)),
        ),
      }))
      .filter((p) => p.weeks.length > 0);
  }, [h, year, show]);
  const attentionCount = useMemo(() => h?.periods.flatMap((p) => p.weeks).filter(needsAttention).length ?? 0, [h]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadTimesheetHistoryCsv(associateId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!h) {
    return (
      <div className="space-y-4">
        <PageHeader title="Timesheet history" breadcrumbs={[{ label: 'Fieldglass timesheets', to: '/time-attendance/timesheets' }, { label: 'History' }]} />
        <EmptyState
          title="Couldn’t load this timesheet"
          description={q.error instanceof ApiError ? q.error.message : 'They may not work at a client you can see.'}
        />
      </div>
    );
  }

  const a = h.associate;
  const allWeeks = h.periods.flatMap((p) => p.weeks);
  return (
    <div className="space-y-5">
      <PageHeader
        title={a.name}
        subtitle="Timesheet history — every week worked, by the pay period that paid it, and where it stands in Fieldglass."
        breadcrumbs={[{ label: 'Fieldglass timesheets', to: '/time-attendance/timesheets' }, { label: a.name }]}
        primaryAction={
          <Button variant="secondary" size="sm" onClick={() => void exportCsv()} loading={exporting} disabled={allWeeks.length === 0}>
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        }
      />

      <Identity h={h} />
      <Totals h={h} />

      {allWeeks.length === 0 ? (
        <EmptyState title="No hours yet" description="Once their time is approved, each week shows up here, in its pay period." />
      ) : (
        <>
          <WeekBars
            weeks={allWeeks.filter((w) => year === 'all' || w.weekEnd.startsWith(String(year)))}
            onPick={(w) => {
              setShow('all');
              setOpenWeek(weekKey(w));
              window.setTimeout(() => document.getElementById(`week-${weekKey(w)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
            }}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl<number | 'all'>
              ariaLabel="Year"
              value={year}
              onChange={setYear}
              options={[{ value: 'all', label: 'All time' }, ...h.years.map((y) => ({ value: y, label: String(y) }))]}
            />
            <SegmentedControl
              ariaLabel="Which weeks"
              value={show}
              onChange={setShow}
              options={[
                { value: 'all', label: 'All weeks' },
                { value: 'attention', label: `Needs a look${attentionCount ? ` (${attentionCount})` : ''}` },
              ]}
            />
          </div>

          {periods.length === 0 ? (
            <EmptyState
              title={show === 'attention' ? 'Nothing needs a look' : 'No weeks in this year'}
              description={show === 'attention' ? 'Every week is approved, entered or on its way.' : 'Pick another year.'}
            />
          ) : (
            <div className="space-y-4">
              {periods.map((p) => (
                <PeriodCard
                  key={p.periodStart}
                  period={p}
                  history={h}
                  openWeek={openWeek}
                  onToggle={(k) => setOpenWeek((cur) => (cur === k ? null : k))}
                />
              ))}
            </div>
          )}
          {h.truncated && (
            <p className="text-center text-xs text-silver/70">Showing weeks from {h.from ? mdy(h.from) : 'the last three years'} on — older time is in the payroll archive.</p>
          )}
        </>
      )}
    </div>
  );
}

function Identity({ h }: { h: TimesheetHistoryResponse }) {
  const a = h.associate;
  return (
    <Card className="p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar src={a.photoUrl} name={a.name} size="xl" ringed />
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-white">{a.worker}</div>
            <div className="truncate text-sm text-silver">
              {[a.clientName, a.position].filter(Boolean).join(' · ') || 'No client yet'}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {a.registeredAt ? (
                <Badge variant="success" size="sm">
                  In Fieldglass since {fmtDate(a.registeredAt)}
                </Badge>
              ) : (
                <Badge variant="destructive" size="sm">
                  Not registered in Fieldglass
                </Badge>
              )}
              {h.schedule && (
                <Badge variant="default" size="sm">
                  <CalendarRange className="h-3 w-3" aria-hidden="true" />
                  Paid {h.schedule.frequency.toLowerCase()}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <div className="grid gap-x-8 md:grid-cols-2">
          <div className="divide-y divide-navy-secondary/50">
            <CopyValue label="Worker ID" value={a.workerId} mono />
            {a.securityId !== null && <CopyValue label="Security ID" value={a.securityId} mono />}
            <CopyValue label="Worker" value={a.worker} />
          </div>
          <div className="divide-y divide-navy-secondary/50">
            <CopyValue label="First clock-in" value={a.firstClockIn ? `${usDate(a.firstClockIn.date)} ${a.firstClockIn.time}` : null} />
            <CopyValue label="Last worked" value={a.lastWorked ? usDate(a.lastWorked) : null} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-navy-secondary bg-navy/60 px-3 py-2.5">
      <div className="text-2xs font-semibold uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums text-white', tone)}>{value}</div>
      {hint && <div className="text-xs text-silver/80">{hint}</div>}
    </div>
  );
}

function Totals({ h }: { h: TimesheetHistoryResponse }) {
  const t = h.totals;
  const fg = t.fieldglass;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label={`${t.year} hours`} value={hrs(t.yearHours)} />
        <Tile label="All-time hours" value={hrs(t.hours)} hint={h.associate.firstClockIn ? `since ${mdy(h.associate.firstClockIn.date)}` : undefined} />
        <Tile label="Weeks worked" value={t.weeks} hint={`${hrs(t.avgWeekHours)}h a week on average`} />
        <Tile
          label="Not approved yet"
          value={hrs(t.pendingHours)}
          tone={t.pendingHours > 0 ? 'text-warning' : 'text-silver'}
          hint={t.pendingHours > 0 ? 'worked, awaiting a supervisor' : 'nothing waiting'}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Weeks in Fieldglass">
        <span className="mr-1 text-silver/70">In Fieldglass:</span>
        <Badge variant="success" size="sm">{fg.approved} approved</Badge>
        {fg.awaiting > 0 && <Badge variant="info" size="sm">{fg.awaiting} with the buyer</Badge>}
        {fg.rejected > 0 && <Badge variant="destructive" size="sm">{fg.rejected} rejected</Badge>}
        {fg.overdue > 0 && <Badge variant="pending" size="sm">{fg.overdue} past due</Badge>}
        {fg.toEnter - fg.overdue > 0 && <Badge variant="default" size="sm">{fg.toEnter - fg.overdue} to enter</Badge>}
        {fg.notRegistered > 0 && <Badge variant="destructive" size="sm">{fg.notRegistered} not in Fieldglass</Badge>}
        {fg.variances > 0 && <Badge variant="pending" size="sm">{fg.variances} hours differ</Badge>}
      </div>
      {t.money && (
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-navy-secondary bg-navy-secondary/60 text-center">
          <Money label="Approved" value={t.money.approved} tone="text-success" />
          <Money label="With the buyer" value={t.money.awaiting} tone="text-white" />
          <Money label="At risk" value={t.money.atRisk} tone={t.money.atRisk > 0 ? 'text-alert' : 'text-silver'} />
        </div>
      )}
    </div>
  );
}

function Money({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-navy px-2 py-2">
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{fmtMoney(value)}</div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
    </div>
  );
}

/** A bar per week, oldest to newest, colored by where it stands. */
function WeekBars({ weeks, onPick }: { weeks: TimesheetHistoryWeek[]; onPick: (w: TimesheetHistoryWeek) => void }) {
  const byWeek = useMemo(() => {
    // One bar per week — a week split across clients stacks its parts.
    const m = new Map<string, TimesheetHistoryWeek[]>();
    for (const w of weeks) m.set(w.weekStart, [...(m.get(w.weekStart) ?? []), w]);
    return [...m.entries()].sort(([x], [y]) => x.localeCompare(y));
  }, [weeks]);
  if (byWeek.length === 0) return null;
  // Headroom over the tallest week, and never so short the 40h line leaves the chart.
  const max = Math.max(44, ...byWeek.map(([, ws]) => ws.reduce((s, w) => s + w.total + w.pendingHours, 0) * 1.08));
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Hours by week</h2>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-silver">
          {LEGEND.map(([tone, label]) => (
            <span key={tone} className="inline-flex items-center gap-1">
              <span className={cn('h-2 w-2 rounded-sm', BAR[tone])} aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="relative overflow-x-auto">
        {/* The 40-hour week, for scale. */}
        <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-silver/25" style={{ bottom: `${(40 / max) * 100}%` }} aria-hidden="true">
          <span className="absolute -top-4 right-0 text-2xs text-silver/50">40h</span>
        </div>
        <div className="flex h-32 min-w-full items-end gap-1" style={{ width: byWeek.length > 60 ? `${byWeek.length * 10}px` : undefined }}>
          {byWeek.map(([ws, parts]) => {
            const total = parts.reduce((s, w) => s + w.total, 0);
            const pending = parts.reduce((s, w) => s + w.pendingHours, 0);
            const label = `Week ending ${usDate(parts[0]!.weekEnd)} · ${hrs(total)}h${pending > 0 ? ` (+${hrs(pending)}h not approved)` : ''} · ${parts.map((w) => weekStanding(w).label).join(', ')}`;
            return (
              <button
                key={ws}
                type="button"
                onClick={() => onPick(parts[0]!)}
                title={label}
                aria-label={label}
                className="group flex h-full min-w-[6px] max-w-[64px] flex-1 flex-col justify-end rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              >
                {pending > 0 && (
                  <span className="w-full rounded-t-sm border border-dashed border-warning/60" style={{ height: `${(pending / max) * 100}%` }} />
                )}
                {parts.map((w) => (
                  <span
                    key={weekKey(w)}
                    className={cn('w-full transition-opacity group-hover:opacity-80', BAR[weekStanding(w).tone], pending > 0 ? '' : 'first:rounded-t-sm')}
                    style={{ height: `${(w.total / max) * 100}%`, minHeight: w.total > 0 ? 2 : 0 }}
                  />
                ))}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-1 flex justify-between text-2xs tabular-nums text-silver/60">
        <span>{md(byWeek[0]![1][0]!.weekEnd)}</span>
        <span>{mdy(byWeek[byWeek.length - 1]![1][0]!.weekEnd)}</span>
      </div>
    </Card>
  );
}

function PeriodCard({
  period,
  history,
  openWeek,
  onToggle,
}: {
  period: TimesheetHistoryPeriod;
  history: TimesheetHistoryResponse;
  openWeek: string | null;
  onToggle: (key: string) => void;
}) {
  const money = history.totals.money !== null;
  const paid = period.payDate ? period.payDate <= todayYmd() : false;
  const dayNames = period.weeks[0]!.days.map((d) => d.weekday);
  const cols = 10 + (money ? 1 : 0);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-navy-secondary bg-navy-secondary/30 px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {history.schedule ? 'Pay period' : 'Week'} · {range(period.periodStart, period.periodEnd)}
          </h2>
          {period.payDate && (
            <div className="text-xs text-silver">
              {paid ? 'Paid' : 'Pays'} {wd(period.payDate)}, {mdy(period.payDate)}
            </div>
          )}
        </div>
        <div className="flex items-baseline gap-4 text-sm tabular-nums">
          <span className="text-white">
            <span className="font-semibold">{hrs(period.total)}</span>
            <span className="text-silver"> h</span>
          </span>
          {period.pendingHours > 0 && <span className="text-xs text-warning">+{hrs(period.pendingHours)}h not approved</span>}
          {money && period.amount !== null && <span className="font-semibold text-white">{fmtMoney(period.amount)}</span>}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] table-fixed text-sm">
          <colgroup>
            <col className="w-[13rem]" />
            {dayNames.map((d) => (
              <col key={d} />
            ))}
            <col className="w-[7.5rem]" />
            <col className="w-[12rem]" />
            {money && <col className="w-[7rem]" />}
          </colgroup>
          <thead>
            <tr className="text-2xs uppercase tracking-wider text-silver/70">
              <th className="px-3 py-2 text-left font-semibold">Week ending</th>
              {dayNames.map((d) => (
                <th key={d} className="px-1 py-2 text-center font-semibold">
                  {d}
                </th>
              ))}
              <th className="px-2 py-2 text-right font-semibold">Total</th>
              <th className="px-3 py-2 text-left font-semibold">Fieldglass</th>
              {money && <th className="px-3 py-2 text-right font-semibold">Amount</th>}
            </tr>
          </thead>
          <tbody>
            {period.weeks.map((w) => {
              const k = weekKey(w);
              const open = openWeek === k;
              const s = weekStanding(w);
              return (
                <Fragment key={k}>
                  <tr
                    id={`week-${k}`}
                    className={cn('cursor-pointer border-t border-navy-secondary/60 hover:bg-navy-secondary/20', open && 'bg-navy-secondary/25')}
                    onClick={() => onToggle(k)}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={`Week ending ${usDate(w.weekEnd)}${w.clientName ? ` at ${w.clientName}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggle(k);
                        }}
                        className="flex items-center gap-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                      >
                        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-silver transition-transform', open && 'rotate-180')} aria-hidden="true" />
                        <span>
                          <span className="font-medium tabular-nums text-white">{w.weekEnding}</span>
                          <span className="block max-w-[11rem] truncate text-xs2 text-silver/70" title={w.site}>
                            {w.site}
                          </span>
                        </span>
                      </button>
                    </td>
                    {w.days.map((d) => (
                      <td key={d.date} className="px-1 py-2 text-center tabular-nums">
                        {d.netHours > 0 ? (
                          <span className="text-white" title={`${d.weekday} ${d.monthDay}: ${d.timeIn ?? '—'} – ${d.timeOut ?? '—'}`}>
                            {hrs(d.netHours)}
                            {d.overnight && <span className="ml-0.5 text-sky" aria-label="overnight">☾</span>}
                          </span>
                        ) : (
                          <span className="text-silver/30">·</span>
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-right font-semibold tabular-nums text-white">
                      {hrs(w.total)}
                      {w.pendingHours > 0 && <div className="whitespace-nowrap text-xs2 font-normal text-warning">+{hrs(w.pendingHours)} pending</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-0.5">
                        <span className="flex items-center gap-1">
                          <Badge variant={s.variant} size="sm">
                            {s.label}
                          </Badge>
                          {w.fieldglass?.note && <MessageSquare className="h-3.5 w-3.5 text-silver/70" aria-label="Has a note" />}
                        </span>
                        {w.fieldglass?.timesheetId && (
                          <span className="font-mono text-xs2 text-silver/70">
                            {w.fieldglass.timesheetId}
                            {w.fieldglass.revision ? ` · rev ${w.fieldglass.revision}` : ''}
                          </span>
                        )}
                        {w.fieldglass?.hours != null && Math.abs(w.fieldglass.hours - w.total) >= 0.01 && (
                          <span className="text-xs2 tabular-nums text-warning">Fieldglass {hrs(w.fieldglass.hours)}h</span>
                        )}
                      </div>
                    </td>
                    {money && <td className="px-3 py-2 text-right tabular-nums text-silver">{w.amount !== null ? fmtMoney(w.amount) : '—'}</td>}
                  </tr>
                  {open && (
                    <tr className="bg-navy-secondary/15">
                      <td colSpan={cols} className="px-3 pb-4 pt-1">
                        <WeekDetail week={w} associateId={history.associate.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** One week, opened: each day's times and breaks, the Fieldglass trail,
 *  the buyer's comment, finance's note, and the next thing to do. */
function WeekDetail({ week: w, associateId }: { week: TimesheetHistoryWeek; associateId: string }) {
  const qc = useQueryClient();
  const f = w.fieldglass;
  const [note, setNote] = useState(f?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);
  const worked = w.days.filter((d) => d.netHours > 0 || d.timeIn);
  const refresh = () => qc.invalidateQueries({ queryKey: ['timesheets', 'history', associateId] });

  const saveNote = async () => {
    if (!w.clientId) return;
    setSaving(true);
    try {
      await setTimesheetNote({ weekStart: `${w.weekStart}T12:00:00.000Z`, associateId, clientId: w.clientId, note });
      toast.success(note.trim() ? 'Note saved.' : 'Note cleared.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the note.');
    } finally {
      setSaving(false);
    }
  };
  const mark = async (entered: boolean) => {
    if (!w.clientId) return;
    setMarking(true);
    try {
      await markFieldglassEntered({ weekStart: `${w.weekStart}T12:00:00.000Z`, associateId, clientId: w.clientId, entered });
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update it.');
    } finally {
      setMarking(false);
    }
  };

  const rejected = f?.status === 'REJECTED';
  const canEnter = !!f?.registered && !f.status && !f.enteredAt && !w.inProgress && w.total > 0;
  return (
    <div className="grid gap-4 pt-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-silver/70">Time in / time out</h3>
        {worked.length === 0 ? (
          <p className="text-sm text-silver">No approved days — {hrs(w.pendingHours)}h still awaiting approval.</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/50 rounded-md border border-navy-secondary">
            {worked.map((d) => (
              <li key={d.date} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                <span className="w-20 shrink-0 font-medium text-white">
                  {d.weekday} {d.monthDay}
                </span>
                <span className="tabular-nums text-silver">
                  {d.timeIn ?? '—'} → {d.timeOut ?? '—'}
                  {d.overnight && <span className="ml-1 text-xs2 text-sky">☾ overnight</span>}
                </span>
                {(d.shifts ?? []).filter(Boolean).length > 0 && (
                  <span className="text-xs2 text-silver/70">{(d.shifts ?? []).filter(Boolean).join(' / ')}</span>
                )}
                <span className="ml-auto font-semibold tabular-nums text-white">{hrs(d.netHours)}h</span>
                {d.breaks.length > 0 && <span className="basis-full pl-[5.75rem] text-xs2 text-silver/70">Break {d.breaks.join(' · ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-3">
        {f && (
          <div>
            <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-silver/70">In Fieldglass</h3>
            {rejected && (
              <div className="mb-2 flex gap-2 rounded-md border border-alert/40 bg-alert/10 p-2.5 text-xs text-alert">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  The buyer rejected it{f.comment ? <>: <span className="font-medium">“{f.comment}”</span></> : '.'} Fix it in Fieldglass and resubmit.
                </span>
              </div>
            )}
            {!rejected && f.comment && <p className="mb-2 text-xs text-silver">Buyer’s comment: “{f.comment}”</p>}
            {w.overdue && (
              <p className="mb-2 flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Was due {fmtWeekdayTz(w.dueAt, PT)} {fmtDateTz(w.dueAt, PT)}, {fmtTimeTz(w.dueAt, PT)} PT — not entered.
              </p>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-silver/70">Timesheet</dt>
              <dd className="font-mono text-white">
                {f.timesheetId ?? '—'}
                {f.revision ? <span className="text-silver"> · rev {f.revision}</span> : null}
              </dd>
              <dt className="text-silver/70">Hours</dt>
              <dd className="tabular-nums text-white">
                Alto {hrs(w.total)}
                {f.hours !== null && <span className={cn(Math.abs(f.hours - w.total) >= 0.01 ? 'text-warning' : 'text-silver')}> · Fieldglass {hrs(f.hours)}</span>}
              </dd>
              <dt className="text-silver/70">Entered</dt>
              <dd className="text-white">
                {f.enteredAt ? `${fmtDateTime(f.enteredAt)}${f.enteredBy ? ` by ${f.enteredBy}` : ''}` : '—'}
                {f.enteredHours !== null && Math.abs(f.enteredHours - w.total) >= 0.01 && (
                  <span className="block text-xs2 text-warning">Entered at {hrs(f.enteredHours)}h — hours changed since</span>
                )}
              </dd>
              {f.resubmittedAt && (
                <>
                  <dt className="text-silver/70">Resubmitted</dt>
                  <dd className="text-white">{fmtDateTime(f.resubmittedAt)}</dd>
                </>
              )}
              {f.syncedAt && (
                <>
                  <dt className="text-silver/70">Checked</dt>
                  <dd className="text-silver">Fieldglass list of {fmtDateTime(f.syncedAt)}</dd>
                </>
              )}
            </dl>
            <div className="mt-2 flex flex-wrap gap-2">
              {rejected && (
                <Button size="sm" onClick={() => void mark(true)} loading={marking}>
                  Mark resubmitted
                </Button>
              )}
              {canEnter && (
                <Button size="sm" onClick={() => void mark(true)} loading={marking}>
                  Mark entered
                </Button>
              )}
              <Button asChild variant="ghost" size="sm">
                <Link to={`/time-attendance/timesheets?week=${w.weekStart}${w.clientId ? `&client=${w.clientId}` : ''}`}>
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open the week
                </Link>
              </Button>
            </div>
          </div>
        )}
        {w.clientId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveNote();
            }}
          >
            <label htmlFor={`note-${weekKey(w)}`} className="mb-1 block text-2xs font-semibold uppercase tracking-wider text-silver/70">
              Note
            </label>
            <Textarea
              id={`note-${weekKey(w)}`}
              value={note}
              maxLength={500}
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What happened with this week — for whoever looks next"
            />
            <div className="mt-1 flex justify-end">
              <Button type="submit" size="sm" variant="secondary" loading={saving} disabled={saving || note.trim() === (f?.note ?? '')}>
                Save note
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
