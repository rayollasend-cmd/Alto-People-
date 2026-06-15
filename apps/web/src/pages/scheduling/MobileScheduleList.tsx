import { useMemo } from 'react';
import type { AssociateLite, Shift, ShiftStatus } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { colorForPosition } from '@/lib/positionColor';
import { zonedDayKey } from '@/lib/format';

/** Local calendar-date key ("YYYY-MM-DD") of the anchored day. */
function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Phone-first scheduling view.
 *
 * The desktop pivot grids (TimeGridWeekView, DayCalendarView,
 * WeekCalendarView) are all `min-w-[700px]`–`min-w-[1200px]` and force
 * horizontal scrolling on a 390px phone — a scheduler can only see one
 * column at a time. Drag-resize and drag-reassign also collapse on
 * touch.
 *
 * Replacement on `<md`: a vertical, time-sorted list of shifts for the
 * currently-anchored day. Header carries the date and day-stepper.
 * Each row is a tappable card showing time range, position, assignee
 * (or OPEN), and a status pill. Tapping opens the same assign / edit
 * drawer the desktop view uses, via the `onShiftClick` callback.
 *
 * Drag-to-reassign isn't reproduced — on phones HR generally taps an
 * OPEN shift to assign rather than dragging chips between rows. The
 * Cancel and Assign mutations live behind the existing drawer.
 */

const STATUS_VARIANT: Record<
  ShiftStatus,
  'success' | 'pending' | 'destructive' | 'default' | 'accent'
> = {
  OPEN: 'pending',
  ASSIGNED: 'success',
  DRAFT: 'default',
  COMPLETED: 'success',
  CANCELLED: 'destructive',
};

interface Props {
  shifts: Shift[];
  associates: AssociateLite[];
  dayAnchor: Date;
  /** Work-site zone to pick the day's shifts in. null = browser-local. */
  displayTimeZone?: string | null;
  canManage: boolean;
  onShiftClick: (s: Shift) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onCreate: (dayStart: Date) => void;
}

function fmtTime(d: Date, timeZone?: string | null): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

function fmtDateHeader(d: Date): string {
  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function MobileScheduleList({
  shifts,
  associates,
  dayAnchor,
  displayTimeZone = null,
  canManage,
  onShiftClick,
  onPrevDay,
  onNextDay,
  onCreate,
}: Props) {
  const associateById = useMemo(() => {
    const m = new Map<string, AssociateLite>();
    for (const a of associates) m.set(a.id, a);
    return m;
  }, [associates]);

  const todayShifts = useMemo(() => {
    // Pick the shifts on the anchored day IN THE STORE's zone (null →
    // browser-local, unchanged) so a late-night shift shows on its real day.
    const key = ymd(dayAnchor);
    return shifts
      .filter((s) => zonedDayKey(s.startsAt, displayTimeZone) === key)
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );
  }, [shifts, dayAnchor, displayTimeZone]);

  const openCount = todayShifts.filter((s) => s.status === 'OPEN').length;

  return (
    <div className="md:hidden">
      {/* Day stepper / context bar — sticky so it doesn't scroll out of
          reach when the list is long. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-navy/95 backdrop-blur border-b border-navy-secondary flex items-center gap-2">
        <button
          type="button"
          onClick={onPrevDay}
          aria-label="Previous day"
          className="h-11 w-11 -ml-2 grid place-items-center rounded-md text-silver hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-sm font-medium text-white truncate">
            {fmtDateHeader(dayAnchor)}
          </div>
          <div className="text-[11px] text-silver tabular-nums">
            {todayShifts.length} shift{todayShifts.length === 1 ? '' : 's'}
            {openCount > 0 && (
              <>
                {' · '}
                <span className="text-warning">{openCount} OPEN</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onNextDay}
          aria-label="Next day"
          className="h-11 w-11 -mr-2 grid place-items-center rounded-md text-silver hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {canManage && (
        <Button
          variant="secondary"
          size="sm"
          className="w-full mt-3"
          onClick={() => onCreate(dayAnchor)}
        >
          <Plus className="h-4 w-4" />
          Add shift on this day
        </Button>
      )}

      {todayShifts.length === 0 ? (
        <div className="mt-6 p-8 text-center text-sm text-silver rounded-md border border-dashed border-navy-secondary">
          No shifts scheduled for this day.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {todayShifts.map((s) => {
            const start = new Date(s.startsAt);
            const end = new Date(s.endsAt);
            const assignee = s.assignedAssociateId
              ? associateById.get(s.assignedAssociateId)
              : null;
            const assigneeName = assignee
              ? [assignee.firstName, assignee.lastName].filter(Boolean).join(' ')
              : null;
            const color = colorForPosition(s.position);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onShiftClick(s)}
                  className={cn(
                    'w-full text-left rounded-md border bg-navy-secondary/40 hover:bg-navy-secondary/70 transition-colors p-3',
                    'border-navy-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    s.status === 'CANCELLED' && 'opacity-60',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="w-1.5 self-stretch rounded-full shrink-0"
                      style={{ backgroundColor: color.accent }}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-white tabular-nums text-sm">
                          {fmtTime(start, s.timezone)} – {fmtTime(end, s.timezone)}
                        </div>
                        <Badge variant={STATUS_VARIANT[s.status]}>
                          {s.status}
                        </Badge>
                      </div>
                      <div className="text-sm text-white mt-0.5 truncate">
                        {s.position}
                        {s.location && (
                          <span className="text-silver"> · {s.location}</span>
                        )}
                      </div>
                      <div className="text-xs text-silver mt-0.5 truncate">
                        {assigneeName ?? (
                          <span className="text-warning">
                            Open · tap to assign
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
