import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Shift, ShiftStatus } from '@alto-people/shared';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { cn } from '@/lib/cn';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Up to this many chips render directly in the cell; the rest go behind "+N more". */
const VISIBLE_CHIPS_PER_CELL = 3;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function shiftMinutes(s: Shift): number {
  return Math.max(
    0,
    Math.round(
      (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 60_000
    )
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function initialsOf(name: string | null): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

interface Props {
  shifts: Shift[];
  monthAnchor: Date; // first of month at 00:00 local
  canManage: boolean;
  onDayClick: (d: Date) => void;
  onShiftClick: (s: Shift) => void;
  onCellCreate: (dayStart: Date) => void;
}

interface DayBucket {
  shifts: Shift[];
  totalMinutes: number;
  open: number;
  draft: number;
}

/**
 * Phase 55 — Fortune 500 month view.
 *
 * 6×7 calendar grid where each day cell shows up to 3 status-coded
 * shift chips (time + assignee initials), with "+N more" overflow that
 * opens a day-detail popover listing every shift for that day. Hover
 * any chip for a full tooltip; click to open the edit/assign dialog.
 * Click the empty area below the chips to create a new shift on that day.
 *
 * Today is gold-highlighted, weekends are subtly tinted, out-of-month
 * days are dimmed but still clickable. Per-day total hours sit in the
 * top-right of each cell.
 *
 * Drag-drop intentionally not implemented here — cells are too small to
 * be useful targets. Use week or day view to reschedule.
 */
export function MonthCalendarView({
  shifts,
  monthAnchor,
  canManage,
  onDayClick,
  onShiftClick,
  onCellCreate,
}: Props) {
  // Snap to the Monday on or before the 1st of the month.
  const gridStart = useMemo(() => {
    const x = startOfDay(monthAnchor);
    const dow = (x.getDay() + 6) % 7; // Mon=0..Sun=6
    return addDays(x, -dow);
  }, [monthAnchor]);

  // 6 weeks × 7 days = 42 cells, enough to cover any month layout.
  const days = useMemo(
    () => Array.from({ length: 42 }).map((_, i) => addDays(gridStart, i)),
    [gridStart]
  );

  const buckets = useMemo(() => {
    const map = new Map<number, DayBucket>();
    for (const s of shifts) {
      const t = startOfDay(new Date(s.startsAt)).getTime();
      const b = map.get(t) ?? { shifts: [], totalMinutes: 0, open: 0, draft: 0 };
      b.shifts.push(s);
      b.totalMinutes += shiftMinutes(s);
      if (s.status === 'OPEN') b.open += 1;
      else if (s.status === 'DRAFT') b.draft += 1;
      map.set(t, b);
    }
    // Sort each day's shifts by start time so chip order is stable.
    for (const b of map.values()) {
      b.shifts.sort(
        (a, c) => new Date(a.startsAt).getTime() - new Date(c.startsAt).getTime()
      );
    }
    return map;
  }, [shifts]);

  const today = startOfDay(new Date());

  const [overflowDay, setOverflowDay] = useState<Date | null>(null);
  const overflowShifts = useMemo(() => {
    if (!overflowDay) return [];
    return buckets.get(overflowDay.getTime())?.shifts ?? [];
  }, [overflowDay, buckets]);

  // Roll-up across the visible month (NOT the visible 6 weeks — only
  // shifts whose date falls in the anchor month).
  const monthSummary = useMemo(() => {
    let totalShifts = 0;
    let openShifts = 0;
    let draftShifts = 0;
    let totalMinutes = 0;
    for (const s of shifts) {
      const d = new Date(s.startsAt);
      if (d.getMonth() !== monthAnchor.getMonth()) continue;
      if (d.getFullYear() !== monthAnchor.getFullYear()) continue;
      totalShifts += 1;
      totalMinutes += shiftMinutes(s);
      if (s.status === 'OPEN') openShifts += 1;
      else if (s.status === 'DRAFT') draftShifts += 1;
    }
    return { totalShifts, openShifts, draftShifts, totalMinutes };
  }, [shifts, monthAnchor]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="rounded-md border border-navy-secondary bg-navy/40 overflow-hidden">
        <MonthSummary summary={monthSummary} />
        <div className="grid grid-cols-7 border-b border-navy-secondary">
          {DAY_LABELS.map((d, i) => (
            <div
              key={d}
              className={cn(
                'px-2 py-2 text-[10px] uppercase tracking-wider text-silver border-r border-navy-secondary last:border-r-0',
                (i === 5 || i === 6) && 'text-silver/60'
              )}
            >
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, idx) => {
            const inMonth = d.getMonth() === monthAnchor.getMonth();
            const isToday = sameDay(d, today);
            const dow = (d.getDay() + 6) % 7;
            const isWeekend = dow >= 5;
            const b = buckets.get(d.getTime());
            const isLastRow = idx >= 35;
            return (
              <DayCell
                key={d.toISOString()}
                date={d}
                bucket={b}
                inMonth={inMonth}
                isToday={isToday}
                isWeekend={isWeekend}
                isLastRow={isLastRow}
                canManage={canManage}
                onDayClick={onDayClick}
                onShiftClick={onShiftClick}
                onCellCreate={onCellCreate}
                onOverflowOpen={() => setOverflowDay(d)}
              />
            );
          })}
        </div>
      </div>

      <DayDetailDialog
        day={overflowDay}
        shifts={overflowShifts}
        canManage={canManage}
        onClose={() => setOverflowDay(null)}
        onShiftClick={(s) => {
          setOverflowDay(null);
          onShiftClick(s);
        }}
        onCreate={(d) => {
          setOverflowDay(null);
          onCellCreate(d);
        }}
        onOpenDayView={(d) => {
          setOverflowDay(null);
          onDayClick(d);
        }}
      />
    </TooltipProvider>
  );
}

/* ===== Sub-components ===================================================== */

function MonthSummary({
  summary,
}: {
  summary: { totalShifts: number; openShifts: number; draftShifts: number; totalMinutes: number };
}) {
  if (summary.totalShifts === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 border-b border-navy-secondary bg-navy-secondary/20 text-[11px]">
      <SummaryStat label="shifts" value={String(summary.totalShifts)} />
      <SummaryStat label="hours" value={(summary.totalMinutes / 60).toFixed(0)} />
      <SummaryStat
        label="open"
        value={String(summary.openShifts)}
        tone={summary.openShifts > 0 ? 'warning' : undefined}
      />
      <SummaryStat
        label="draft"
        value={String(summary.draftShifts)}
        tone={summary.draftShifts > 0 ? 'silver' : undefined}
      />
      {/* Status legend right-aligned */}
      <div className="ml-auto inline-flex gap-3 text-silver/70">
        <LegendDot tone="success" label="Assigned" />
        <LegendDot tone="warning" label="Open" />
        <LegendDot tone="silver" label="Draft" />
        <LegendDot tone="alert" label="Cancelled" />
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warning' | 'silver';
}) {
  const valueCx =
    tone === 'warning' ? 'text-warning' : tone === 'silver' ? 'text-silver' : 'text-white';
  return (
    <div className="inline-flex items-baseline gap-1">
      <span className={cn('font-semibold tabular-nums', valueCx)}>{value}</span>
      <span className="text-[10px] uppercase tracking-wider text-silver/60">
        {label}
      </span>
    </div>
  );
}

function LegendDot({
  tone,
  label,
}: {
  tone: 'success' | 'warning' | 'silver' | 'alert';
  label: string;
}) {
  const dotCx =
    tone === 'success'
      ? 'bg-success'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'alert'
          ? 'bg-alert'
          : 'bg-silver/60';
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('h-1.5 w-1.5 rounded-full', dotCx)} />
      <span className="text-[10px]">{label}</span>
    </span>
  );
}

function DayCell({
  date,
  bucket,
  inMonth,
  isToday,
  isWeekend,
  isLastRow,
  canManage,
  onDayClick,
  onShiftClick,
  onCellCreate,
  onOverflowOpen,
}: {
  date: Date;
  bucket: DayBucket | undefined;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  isLastRow: boolean;
  canManage: boolean;
  onDayClick: (d: Date) => void;
  onShiftClick: (s: Shift) => void;
  onCellCreate: (d: Date) => void;
  onOverflowOpen: () => void;
}) {
  const dayShifts = bucket?.shifts ?? [];
  const visible = dayShifts.slice(0, VISIBLE_CHIPS_PER_CELL);
  const overflow = Math.max(0, dayShifts.length - visible.length);
  const hours = bucket ? bucket.totalMinutes / 60 : 0;

  return (
    <div
      className={cn(
        'group relative min-h-[120px] p-1.5 border-r border-navy-secondary',
        !isLastRow && 'border-b',
        'last:border-r-0',
        !inMonth && 'opacity-50',
        isWeekend && inMonth && 'bg-navy-secondary/15',
        isToday && 'bg-gold/[0.08] ring-1 ring-gold/30 ring-inset'
      )}
    >
      {/* Header row: day-number button (drills into day view) + per-day hours */}
      <div className="flex items-center justify-between mb-1">
        <button
          type="button"
          onClick={() => onDayClick(date)}
          className={cn(
            'text-sm tabular-nums leading-none rounded px-1 py-0.5 transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            isToday
              ? 'text-gold font-semibold hover:bg-gold/10'
              : 'text-white hover:text-gold hover:bg-gold/5'
          )}
          title={`Open ${date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`}
        >
          {date.getDate()}
        </button>
        <div className="flex items-center gap-1.5">
          {hours > 0 && (
            <span className="text-[10px] text-silver/70 tabular-nums">
              {hours.toFixed(hours < 10 ? 1 : 0)}h
            </span>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => onCellCreate(date)}
              className="text-silver/30 hover:text-gold transition-colors opacity-60 group-hover:opacity-100 no-print"
              aria-label={`Add shift on ${date.toLocaleDateString()}`}
              title="Add shift"
            >
              <Plus className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Chip stack */}
      <div className="space-y-0.5">
        {visible.map((s) => (
          <MonthShiftChip key={s.id} shift={s} onClick={() => onShiftClick(s)} />
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          onClick={onOverflowOpen}
          className="mt-0.5 text-[10px] text-silver hover:text-gold underline underline-offset-2 ml-1"
        >
          +{overflow} more
        </button>
      )}
      {/* Empty-cell create affordance — only when there's room */}
      {dayShifts.length === 0 && canManage && (
        <button
          type="button"
          onClick={() => onCellCreate(date)}
          className="absolute inset-x-1.5 bottom-1.5 top-7 text-silver/30 hover:text-gold flex items-center justify-center text-[10px] opacity-60 group-hover:opacity-100 transition-opacity no-print"
          aria-label="Add shift"
        >
          <Plus className="h-3 w-3 mr-1" />
          add shift
        </button>
      )}
    </div>
  );
}

function MonthShiftChip({
  shift,
  onClick,
}: {
  shift: Shift;
  onClick: () => void;
}) {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const initials = initialsOf(shift.assignedAssociateName);
  const tone = STATUS_CHIP_TONE[shift.status] ?? STATUS_CHIP_TONE.DRAFT;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          data-status={shift.status}
          className={cn(
            'w-full text-left rounded px-1.5 py-0.5 flex items-center gap-1 truncate',
            'border-l-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold-bright',
            tone.bg,
            tone.border,
            tone.hover
          )}
        >
          <span className={cn('text-[10px] tabular-nums shrink-0', tone.time)}>
            {compactTime(start)}
          </span>
          <span className={cn('text-[10px] truncate flex-1', tone.text)}>
            {shift.position}
          </span>
          <span className={cn('text-[9px] font-semibold tabular-nums shrink-0', tone.initials)}>
            {initials}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="space-y-0.5">
          <div className="font-medium text-white">{shift.position}</div>
          <div className="text-silver">
            {fmtTime(start)} – {fmtTime(end)} ·{' '}
            <span className="tabular-nums">
              {(shift.scheduledMinutes / 60).toFixed(2)}h
            </span>
          </div>
          {shift.clientName && (
            <div className="text-silver/80">{shift.clientName}</div>
          )}
          {shift.location && (
            <div className="text-silver/60">{shift.location}</div>
          )}
          <div className="pt-0.5 flex items-center gap-2">
            <span
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full',
                statusDotCx(shift.status)
              )}
            />
            <span className="text-[10px] uppercase tracking-wider text-silver/70">
              {shift.status}
            </span>
            {shift.assignedAssociateName && (
              <span className="text-silver/80">
                · {shift.assignedAssociateName}
              </span>
            )}
          </div>
          {shift.notes && (
            <div className="pt-1 italic text-silver/70 text-[10px] border-t border-silver/10 mt-1">
              {shift.notes}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function DayDetailDialog({
  day,
  shifts,
  canManage,
  onClose,
  onShiftClick,
  onCreate,
  onOpenDayView,
}: {
  day: Date | null;
  shifts: Shift[];
  canManage: boolean;
  onClose: () => void;
  onShiftClick: (s: Shift) => void;
  onCreate: (d: Date) => void;
  onOpenDayView: (d: Date) => void;
}) {
  return (
    <Dialog open={day !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {day &&
              day.toLocaleDateString([], {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
          </DialogTitle>
        </DialogHeader>
        <ul className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {shifts.map((s) => {
            const start = new Date(s.startsAt);
            const end = new Date(s.endsAt);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onShiftClick(s)}
                  data-status={s.status}
                  className="w-full text-left p-2 rounded-md border border-navy-secondary bg-navy-secondary/30 hover:bg-navy-secondary/50 hover:border-silver/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium text-white">
                      {s.position}
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                        statusBadgeCx(s.status)
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          statusDotCx(s.status)
                        )}
                      />
                      {s.status}
                    </span>
                  </div>
                  <div className="text-xs text-silver mt-0.5 tabular-nums">
                    {fmtTime(start)} – {fmtTime(end)}
                    {s.clientName && (
                      <span className="ml-2">· {s.clientName}</span>
                    )}
                  </div>
                  <div className="text-xs text-silver/80 mt-0.5">
                    {s.assignedAssociateName ?? (
                      <span className="italic text-silver/50">unassigned</span>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2 pt-2">
          {canManage && day && (
            <button
              type="button"
              onClick={() => onCreate(day)}
              className="flex-1 h-9 px-3 rounded-md border border-navy-secondary text-sm text-silver hover:text-gold hover:border-gold/40 transition-colors inline-flex items-center justify-center gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              Add shift on this day
            </button>
          )}
          {day && (
            <button
              type="button"
              onClick={() => onOpenDayView(day)}
              className="flex-1 h-9 px-3 rounded-md bg-gold text-navy text-sm font-medium hover:bg-gold-bright transition-colors"
            >
              Open day view
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-2 text-silver hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ===== Status palette ===================================================== */

const STATUS_CHIP_TONE: Record<
  ShiftStatus,
  {
    bg: string;
    border: string;
    text: string;
    time: string;
    initials: string;
    hover: string;
  }
> = {
  ASSIGNED: {
    bg: 'bg-success/15',
    border: 'border-success',
    text: 'text-white',
    time: 'text-success',
    initials: 'text-success',
    hover: 'hover:bg-success/25',
  },
  COMPLETED: {
    bg: 'bg-success/10',
    border: 'border-success/70',
    text: 'text-silver',
    time: 'text-success/80',
    initials: 'text-success/80',
    hover: 'hover:bg-success/20',
  },
  OPEN: {
    bg: 'bg-warning/15',
    border: 'border-warning',
    text: 'text-white',
    time: 'text-warning',
    initials: 'text-warning',
    hover: 'hover:bg-warning/25',
  },
  DRAFT: {
    bg: 'bg-silver/10',
    border: 'border-silver/60',
    text: 'text-silver',
    time: 'text-silver',
    initials: 'text-silver',
    hover: 'hover:bg-silver/20',
  },
  CANCELLED: {
    bg: 'bg-alert/10',
    border: 'border-alert/60',
    text: 'text-silver/60 line-through',
    time: 'text-alert/70',
    initials: 'text-alert/70',
    hover: 'hover:bg-alert/15',
  },
};

function statusDotCx(s: ShiftStatus): string {
  switch (s) {
    case 'ASSIGNED':
    case 'COMPLETED':
      return 'bg-success';
    case 'OPEN':
      return 'bg-warning';
    case 'DRAFT':
      return 'bg-silver/60';
    case 'CANCELLED':
      return 'bg-alert';
  }
}

function statusBadgeCx(s: ShiftStatus): string {
  switch (s) {
    case 'ASSIGNED':
    case 'COMPLETED':
      return 'bg-success/15 text-success';
    case 'OPEN':
      return 'bg-warning/15 text-warning';
    case 'DRAFT':
      return 'bg-silver/15 text-silver';
    case 'CANCELLED':
      return 'bg-alert/15 text-alert';
  }
}

/** Compact time format ("9a", "9:30a", "5p", "5:30p") so chips fit narrow cells. */
function compactTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const period = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}
