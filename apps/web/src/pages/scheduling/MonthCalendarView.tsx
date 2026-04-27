import { useMemo } from 'react';
import type { Shift } from '@alto-people/shared';
import { cn } from '@/lib/cn';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  monthAnchor: Date; // first of month at 00:00 local
  onDayClick: (d: Date) => void;
}

interface DayBucket {
  total: number;
  open: number;
  assigned: number;
  draft: number;
}

/**
 * Phase 53 — month view. 6 rows × 7 cols of day cells (the "calendar
 * grid" you'd recognize from any wall calendar). Each cell shows the
 * day number, a dot color for fill state, and the shift count. Click
 * a cell to drill into the day view.
 *
 * No drag-drop here — the cells are too small for the chips to be
 * useful targets. Use the week/day view for editing.
 */
export function MonthCalendarView({ shifts, monthAnchor, onDayClick }: Props) {
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
      const b = map.get(t) ?? { total: 0, open: 0, assigned: 0, draft: 0 };
      b.total += 1;
      if (s.status === 'OPEN') b.open += 1;
      else if (s.status === 'ASSIGNED' || s.status === 'COMPLETED') b.assigned += 1;
      else if (s.status === 'DRAFT') b.draft += 1;
      map.set(t, b);
    }
    return map;
  }, [shifts]);

  const today = startOfDay(new Date());

  return (
    <div className="rounded-md border border-navy-secondary bg-navy/40">
      <div className="grid grid-cols-7 border-b border-navy-secondary">
        {DAY_LABELS.map((d) => (
          <div
            key={d}
            className="px-2 py-2 text-[10px] uppercase tracking-wider text-silver border-r border-navy-secondary last:border-r-0"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const inMonth = d.getMonth() === monthAnchor.getMonth();
          const isToday = sameDay(d, today);
          const b = buckets.get(d.getTime());
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onDayClick(d)}
              className={cn(
                'min-h-[100px] p-2 text-left border-r border-b border-navy-secondary last:border-r-0',
                'hover:bg-gold/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                !inMonth && 'opacity-40',
                isToday && 'bg-gold/[0.08]'
              )}
            >
              <div className="flex items-center justify-between">
                <div
                  className={cn(
                    'text-sm tabular-nums',
                    isToday ? 'text-gold font-semibold' : 'text-white'
                  )}
                >
                  {d.getDate()}
                </div>
                {b && b.total > 0 && (
                  <div className="text-[10px] tabular-nums text-silver/70">
                    {b.total}
                  </div>
                )}
              </div>
              {b && b.total > 0 && (
                <div className="mt-2 space-y-0.5">
                  {b.open > 0 && (
                    <BucketLine
                      label="OPEN"
                      count={b.open}
                      tone="warning"
                    />
                  )}
                  {b.assigned > 0 && (
                    <BucketLine
                      label="ASN"
                      count={b.assigned}
                      tone="success"
                    />
                  )}
                  {b.draft > 0 && (
                    <BucketLine
                      label="DRF"
                      count={b.draft}
                      tone="default"
                    />
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BucketLine({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'warning' | 'success' | 'default';
}) {
  const dotCx =
    tone === 'warning'
      ? 'bg-warning'
      : tone === 'success'
        ? 'bg-success'
        : 'bg-silver/50';
  const textCx =
    tone === 'warning'
      ? 'text-warning'
      : tone === 'success'
        ? 'text-success'
        : 'text-silver';
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className={cn('h-1.5 w-1.5 rounded-full', dotCx)} />
      <span className={cn('uppercase tracking-wider', textCx)}>
        {label}
      </span>
      <span className="ml-auto tabular-nums text-silver/70">{count}</span>
    </div>
  );
}
