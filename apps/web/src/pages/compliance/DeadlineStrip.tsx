import { X } from '@/components/ui/icons';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, StackedBarChart } from '@/components/ui/charts';
import { Button } from '@/components/ui';
import { fmtDayShort, parseYmd, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * The next two weeks of federal deadlines, as a strip (HR walk 22): one bar
 * per day — overdue in red, today amber, the rest in the first series —
 * with everything already late folded into the first column. It answers
 * "am I about to miss a federal deadline" without scanning the list, and a
 * bar (or its chip below) narrows the list to that day. Browser-only: it is
 * drawn from the rows the tab already loaded.
 */

export const OVERDUE = 'overdue';
const DAYS = 14;

function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd)!;
  return ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Which column a due date falls in: 'overdue', a day in the window, or null past it. */
export function deadlineBucket(due: string | null | undefined, today: string = ymdLocal()): string | null {
  if (!due) return null;
  const d = due.slice(0, 10);
  if (d < today) return OVERDUE;
  return d <= addDays(today, DAYS - 1) ? d : null;
}

/** Does a due date sit in the chosen column? */
export function matchesDeadlineDay(due: string | null | undefined, day: string, today: string = ymdLocal()): boolean {
  return deadlineBucket(due, today) === day;
}

export function deadlineDayLabel(day: string, today: string = ymdLocal()): string {
  if (day === OVERDUE) return 'Overdue';
  if (day === today) return 'Today';
  return fmtDayShort(parseYmd(day), { anchored: true });
}

interface StripRow extends Record<string, unknown> {
  key: string;
  day: string;
  overdue: number;
  today: number;
  upcoming: number;
  total: number;
}

export function DeadlineStrip({
  title,
  what,
  dueDates,
  selectedDay,
  onSelectDay,
  today = ymdLocal(),
}: {
  title: string;
  /** The deadline in words, for the summary ("Section 2 deadlines"). */
  what: string;
  /** One due date (YYYY-MM-DD) per open deadline. */
  dueDates: Array<string | null | undefined>;
  selectedDay: string | null;
  onSelectDay: (day: string | null) => void;
  today?: string;
}) {
  const counts = new Map<string, number>();
  for (const due of dueDates) {
    const b = deadlineBucket(due, today);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const keys = [OVERDUE, ...Array.from({ length: DAYS }, (_, i) => addDays(today, i))];
  const rows: StripRow[] = keys.map((k) => {
    const n = counts.get(k) ?? 0;
    return {
      key: k,
      day: deadlineDayLabel(k, today),
      overdue: k === OVERDUE ? n : 0,
      today: k === today ? n : 0,
      upcoming: k !== OVERDUE && k !== today ? n : 0,
      total: n,
    };
  });
  const overdue = counts.get(OVERDUE) ?? 0;
  const dueToday = counts.get(today) ?? 0;
  const thisWeek = keys.slice(2, 8).reduce((s, k) => s + (counts.get(k) ?? 0), 0);
  const summary =
    [
      overdue > 0 ? `${overdue} overdue` : null,
      dueToday > 0 ? `${dueToday} due today` : null,
      thisWeek > 0 ? `${thisWeek} due this week` : null,
    ]
      .filter(Boolean)
      .join(', ') || `No ${what.toLowerCase()} due this week`;
  const byLabel = new Map(rows.map((r) => [r.day, r.key]));

  return (
    <div className="mb-4 space-y-2">
      <ChartFrame
        title={title}
        description={`${what} by day, the next two weeks. Pick a day to see who.`}
        summary={`${summary}.`}
        columns={[
          { key: 'day', label: 'Due' },
          { key: 'total', label: 'Deadlines', numeric: true },
        ]}
        rows={rows}
        csvName="deadlines"
        height={170}
        interactive
      >
        <StackedBarChart
          data={rows}
          x="day"
          series={[
            { key: 'overdue', name: 'Overdue', color: PALETTE.bad },
            { key: 'today', name: 'Today', color: PALETTE.warn },
            { key: 'upcoming', name: 'Coming up' },
          ]}
          format={(v) => String(Math.round(v))}
          highlight={selectedDay ? deadlineDayLabel(selectedDay, today) : undefined}
          onBarClick={(row) => {
            const k = byLabel.get(String(row.day));
            if (k) onSelectDay(k === selectedDay ? null : k);
          }}
          height={150}
        />
      </ChartFrame>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${title}: pick a day`}>
        {rows
          .filter((r) => r.total > 0)
          .map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={selectedDay === r.key}
              onClick={() => onSelectDay(selectedDay === r.key ? null : r.key)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs tabular-nums transition-colors coarse:min-h-9',
                r.key === OVERDUE ? 'border-alert/40 text-alert' : r.key === today ? 'border-warning/40 text-warning' : 'border-line text-ink-muted',
                selectedDay === r.key && 'bg-navy-secondary/60 ring-1 ring-gold/40',
              )}
            >
              {r.day} · {r.total}
            </button>
          ))}
        {selectedDay && (
          <Button size="sm" variant="ghost" onClick={() => onSelectDay(null)} aria-label="Clear the day filter">
            {selectedDay === OVERDUE ? 'Overdue' : `Due ${deadlineDayLabel(selectedDay, today)}`}
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
