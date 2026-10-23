import { useMemo } from 'react';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE } from '@/components/ui/charts';
import { cn } from '@/lib/cn';
import type { HourlyCoverage } from './weekGridFit';

/**
 * Coverage by hour under the week grid (role walk, ops 12): one row per
 * day, 24 cells of scheduled headcount against the site's floor target.
 * A short hour is the alert tone, a covered hour the muted one; the old
 * footer only knew each day's peak, so a day that peaked at target and
 * ran empty from 2p read as covered. Clicking a short hour posts that
 * many open shifts for the day (the parent's onCoverageGap).
 */

export interface CoverageHeatStripDay {
  dayKey: string;
  dayStart: Date;
  label: string;
  /** The row's label ("Sat 17"); the table keeps the full `label`. */
  shortLabel?: string;
  coverage: HourlyCoverage;
}

function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** The hours a day is short, with the deepest shortfall — what one click should post. */
export function worstGap(coverage: HourlyCoverage, target: number): { hours: number; gap: number } {
  let hours = 0;
  let gap = 0;
  for (let h = 0; h < 24; h++) {
    const short = target - coverage.scheduled[h];
    if (short > 0) {
      hours += 1;
      if (short > gap) gap = short;
    }
  }
  return { hours, gap };
}

export function CoverageHeatStrip({
  days,
  target,
  onCoverageGap,
}: {
  days: CoverageHeatStripDay[];
  target: number;
  onCoverageGap?: (dayStart: Date, gap: number) => void;
}) {
  const rows = useMemo(
    () =>
      days.flatMap((d) =>
        d.coverage.scheduled.map((n, h) => ({
          day: d.label,
          hour: hourLabel(h),
          scheduled: n,
          open: d.coverage.open[h],
          target,
          short: Math.max(0, target - n),
        })),
      ),
    [days, target],
  );
  const shortDays = days.filter((d) => worstGap(d.coverage, target).hours > 0).length;
  const summary =
    shortDays === 0
      ? `Every hour this week meets the floor target of ${target}.`
      : `${shortDays} of ${days.length} days run under the floor target of ${target} for at least one hour.`;
  return (
    <ChartFrame
      title="Coverage by hour"
      summary={summary}
      columns={[
        { key: 'day', label: 'Day' },
        { key: 'hour', label: 'Hour' },
        { key: 'scheduled', label: 'Scheduled', numeric: true },
        { key: 'open', label: 'Open', numeric: true },
        { key: 'target', label: 'Target', numeric: true },
        { key: 'short', label: 'Short', numeric: true },
      ]}
      rows={rows}
      csvName="coverage-by-hour"
      height={days.length * 28 + 40}
      interactive
    >
      <div className="overflow-x-auto" data-testid="coverage-heat-strip">
        <div className="min-w-[36rem]">
          <div className="grid" style={{ gridTemplateColumns: '3.5rem repeat(24, minmax(0, 1fr))' }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="pb-1 text-center text-2xs text-silver/60">
                {h % 3 === 0 ? hourLabel(h) : ''}
              </div>
            ))}
            {days.map((d) => (
              <DayCells key={d.dayKey} day={d} target={target} onCoverageGap={onCoverageGap} />
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-silver/80">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm" style={{ background: PALETTE.bad }} aria-hidden="true" />
          Under target
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm" style={{ background: PALETTE.muted }} aria-hidden="true" />
          At or over
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-3 rounded-sm bg-navy-secondary/40" aria-hidden="true" />
          Nobody scheduled
        </span>
      </div>
    </ChartFrame>
  );
}

function DayCells({
  day,
  target,
  onCoverageGap,
}: {
  day: CoverageHeatStripDay;
  target: number;
  onCoverageGap?: (dayStart: Date, gap: number) => void;
}) {
  return (
    <>
      <div className="flex items-center whitespace-nowrap pr-2 text-2xs text-silver/70" title={day.label}>
        {day.shortLabel ?? day.label}
      </div>
      {day.coverage.scheduled.map((n, h) => {
        const open = day.coverage.open[h];
        const short = Math.max(0, target - n);
        const text = `${day.label} ${hourLabel(h)}: ${n} scheduled${open > 0 ? ` (${open} open)` : ''} vs ${target}${short > 0 ? ` — ${short} short, click to post ${short} open shift${short === 1 ? '' : 's'}` : ''}`;
        const clickable = short > 0 && !!onCoverageGap;
        return (
          <button
            key={h}
            type="button"
            onClick={clickable ? () => onCoverageGap!(day.dayStart, short) : undefined}
            disabled={!clickable}
            data-short={short > 0 ? 'true' : 'false'}
            // A pointer shortcut: the day's "N short" button in the totals row
            // (and the chart's Table view) carry the same action and numbers
            // for keyboards and screen readers, at a full-size target.
            tabIndex={-1}
            aria-hidden="true"
            className={cn(
              'relative m-px h-5 rounded-sm bg-navy-secondary/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-gold coarse:h-6',
              clickable ? 'cursor-pointer hover:brightness-125' : 'cursor-default',
            )}
            title={text}
          >
            {n > 0 && (
              <span
                className="absolute inset-0 rounded-sm"
                style={{ background: short > 0 ? PALETTE.bad : PALETTE.muted, opacity: short > 0 ? 0.85 : 0.6 }}
                aria-hidden="true"
              />
            )}
            {n === 0 && short > 0 && (
              <span className="absolute inset-x-0.5 bottom-0 h-0.5 rounded-full" style={{ background: PALETTE.bad }} aria-hidden="true" />
            )}
          </button>
        );
      })}
    </>
  );
}
