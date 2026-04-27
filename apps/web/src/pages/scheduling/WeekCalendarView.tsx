import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import type { Shift, ShiftStatus } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

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

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

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

interface Props {
  shifts: Shift[];
  weekStart: Date; // a Monday at 00:00 local
  canManage: boolean;
  onShiftClick: (s: Shift) => void;
  onCellCreate: (dayStart: Date) => void;
}

/**
 * Phase 48 — Sling-style week view. Seven day columns, each a stacked
 * list of shift cards sorted by start time. Click a card to open the
 * edit/assign sheet; click "+" in a day header to create a new shift
 * pre-populated with that date.
 *
 * No true hour-grid. Most polished scheduling apps (Sling, Deputy,
 * Homebase) default to this list-per-day layout because shifts vary
 * wildly in length and a vertical time axis wastes vertical space when
 * most days have 1–4 shifts.
 */
export function WeekCalendarView({
  shifts,
  weekStart,
  canManage,
  onShiftClick,
  onCellCreate,
}: Props) {
  const days = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i));
  }, [weekStart]);

  // Bucket shifts by local-day start. We do NOT trust the server's iso
  // date partition (a 9pm shift in Eastern time could land on a different
  // UTC day) — use the local Date object.
  const byDay = useMemo(() => {
    const map = new Map<number, Shift[]>();
    for (const s of shifts) {
      const day = startOfDay(new Date(s.startsAt)).getTime();
      const list = map.get(day) ?? [];
      list.push(s);
      map.set(day, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    }
    return map;
  }, [shifts]);

  const today = startOfDay(new Date());

  return (
    <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
      {days.map((d, i) => {
        const dayShifts = byDay.get(d.getTime()) ?? [];
        const isToday = sameDay(d, today);
        return (
          <div
            key={d.toISOString()}
            className={cn(
              'rounded-md border bg-navy-secondary/20 min-h-[200px] flex flex-col',
              isToday ? 'border-gold/60' : 'border-navy-secondary'
            )}
          >
            <div
              className={cn(
                'px-2 py-2 border-b flex items-center justify-between',
                isToday ? 'border-gold/40' : 'border-navy-secondary'
              )}
            >
              <div>
                <div className={cn(
                  'text-[10px] uppercase tracking-wider',
                  isToday ? 'text-gold' : 'text-silver'
                )}>
                  {DAY_LABELS[i]}
                </div>
                <div className={cn(
                  'text-sm tabular-nums',
                  isToday ? 'text-white font-medium' : 'text-silver'
                )}>
                  {d.toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </div>
              {canManage && (
                <button
                  type="button"
                  onClick={() => onCellCreate(d)}
                  className="p-1 rounded text-silver hover:text-gold hover:bg-gold/10 transition-colors"
                  aria-label={`Add shift on ${d.toLocaleDateString()}`}
                  title="Add shift"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 p-1.5 space-y-1.5 overflow-hidden">
              {dayShifts.length === 0 && (
                <div className="text-[11px] text-silver/40 text-center py-4">
                  no shifts
                </div>
              )}
              {dayShifts.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onShiftClick(s)}
                  className={cn(
                    'w-full text-left p-1.5 rounded border bg-navy/60 hover:bg-navy-secondary/50',
                    'border-navy-secondary hover:border-silver/40 transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright'
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="text-[11px] text-silver tabular-nums">
                      {fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}
                    </div>
                    <Badge variant={STATUS_VARIANT[s.status] ?? 'default'} className="text-[9px] px-1 py-0">
                      {s.status === 'ASSIGNED' ? '✓' : s.status === 'OPEN' ? '○' : s.status[0]}
                    </Badge>
                  </div>
                  <div className="text-xs text-white font-medium truncate mt-0.5">
                    {s.position}
                  </div>
                  {s.clientName && (
                    <div className="text-[10px] text-silver/70 truncate">
                      {s.clientName}
                    </div>
                  )}
                  {s.assignedAssociateName ? (
                    <div className="text-[11px] text-success truncate mt-0.5">
                      {s.assignedAssociateName}
                    </div>
                  ) : (
                    <div className="text-[11px] text-silver/50 italic mt-0.5">unassigned</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ===== Week navigation helpers (exported for the parent page) ============ */

/** Get the Monday at 00:00 local for the week containing `d`. */
export function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  // JS getDay: Sun=0, Mon=1, ... Sat=6. We want Monday-anchored.
  const dayOfWeek = (x.getDay() + 6) % 7; // Mon=0 ... Sun=6
  return addDays(x, -dayOfWeek);
}

export function endOfWeekMonday(weekStart: Date): Date {
  const e = addDays(weekStart, 7);
  return e;
}

export function shiftWeek(weekStart: Date, weeks: number): Date {
  return addDays(weekStart, weeks * 7);
}
